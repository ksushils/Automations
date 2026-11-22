import crypto from 'node:crypto';
import { getDb, json } from './db.js';
import { createTenant, getTenant, updateTenantSettings, deleteTenant } from './tenants.js';
import { chatCompletion, directConfigured, costMicro } from './ai/direct.js';
import { bumpUsage } from './tenants.js';
import { validateFlow, saveFlow, listFlows } from './bot/flows.js';
import { createSender } from './whatsapp/cloudApi.js';
import { handleInbound } from './bot/engine.js';
import { sampleRun } from './sampleRun.js';
import { TRADES } from './trades.js';

/*
 * Automations from plain English (R3.3): the owner writes what they want ("when someone says prices, send the price
 * list and offer a call back"), and gets a DRAFT – never a live change – that has been:
 *   1. written by the AI into a fixed shape: either a chat flow made only of the allowed steps below, or a change to
 *      one of the allowed follow-up settings below, or an honest "can't do that here" with where to do it instead;
 *   2. checked on the server: anything outside the lists is removed and listed as a problem, the flow must pass the
 *      flow builder's own checks, numbers are kept within limits, clashing trigger words are flagged;
 *   3. tried out: a flow is played through the real engine on a throwaway copy of the business (no WhatsApp, no
 *      email, no AI, deleted after) – one run per first choice – and a settings change shows before → after;
 *   4. switched on only when the owner approves it (owners only; staff can't), and it then appears in Automations
 *      or Settings where it can be edited or switched off like anything else.
 * Not allowed in drafts: webhooks (data leaving), templates (paid/marketing messages outside the chat), forms,
 * product ids, and anything that messages people who haven't written in (that's Campaigns, with consent).
 */
export const ALLOWED_ACTIONS = ['menu', 'browse', 'status', 'cart'];
const STEP_RULES = {
  message: 'send text, optionally up to 3 buttons: {"type":"message","text":"…","buttons":[{"title":"max 20 chars","goto":"step id"}]}',
  question: 'ask and save a typed answer: {"type":"question","text":"…","save":"attribute name","validate":"any|email|number|phone"}',
  list: 'a menu of up to 10 rows: {"type":"list","text":"…","button":"max 20 chars","rows":[{"title":"max 24 chars","description":"optional","goto":"step id"}]}',
  tag: 'tag the customer: {"type":"tag","add":["vip"],"remove":[]}',
  handover: 'pass to the team inbox: {"type":"handover","text":"optional message"}',
  action: `hand back to the assistant: {"type":"action","action":"${ALLOWED_ACTIONS.join('|')}"}`,
  delay: 'wait, then continue (1–1440 minutes, only while the chat is open): {"type":"delay","minutes":30}',
  goto: 'jump: {"type":"goto","step":"step id"}',
  end: 'stop: {"type":"end"}',
};
export const ALLOWED_STEPS = Object.keys(STEP_RULES);

/** Follow-up settings a draft may change: path → limits. */
export const SETTINGS = {
  'notifications.reviewRequest.enabled': { type: 'bool', label: 'Ask for a Google review after an order is delivered or a visit is done' },
  'notifications.reviewRequest.afterHours': { type: 'number', min: 1, max: 336, label: 'Hours after delivery/visit to ask for the review' },
  'notifications.abandonedCartMinutes': { type: 'number', min: 0, max: 2880, label: 'Minutes before an unfinished-basket reminder (0 = off)', shop: true },
  'bookings.reminderHours': { type: 'number', min: 0, max: 72, label: 'Appointment reminder, hours before (0 = off)', bookings: true },
  'bookings.secondReminderHours': { type: 'number', min: 0, max: 24, label: 'Second reminder, hours before (0 = none)', bookings: true },
  'bookings.rebookDays': { type: 'number', min: 0, max: 365, label: '"Book again" message, days after a visit (0 = off)', bookings: true },
  'quotes.followUp': { type: 'bool', label: 'One friendly follow-up 2 days after a quote is sent' },
  'leads.nudges': { type: 'bool', label: 'Remind the team when a lead has waited 30 minutes and 4 hours' },
  'followUps.maxPerDay': { type: 'number', min: 1, max: 5, label: 'Most automatic messages to one customer in 24 hours' },
  'followUps.quietStart': { type: 'number', min: 0, max: 23, label: 'Quiet hours start (hour)' },
  'followUps.quietEnd': { type: 'number', min: 0, max: 23, label: 'Quiet hours end (hour)' },
};
const DEFAULTS = { 'notifications.reviewRequest.enabled': false, 'notifications.reviewRequest.afterHours': 24, 'notifications.abandonedCartMinutes': 120, 'bookings.reminderHours': 24, 'bookings.secondReminderHours': 0, 'bookings.rebookDays': 0, 'quotes.followUp': true, 'leads.nudges': true, 'followUps.maxPerDay': 2, 'followUps.quietStart': 21, 'followUps.quietEnd': 8 };

const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const setP = (o, p, v) => { const ks = p.split('.'); let a = o; for (const k of ks.slice(0, -1)) a = a[k] ||= {}; a[ks.at(-1)] = v; return o; };
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isShop = (S) => ['shopify', 'shopify_public', 'woocommerce', 'custom'].includes(S.store?.type) || (S.store?.type === 'manual' && (S.store?.manual?.products || []).length > 0);

// ---------- 1. the AI writes a draft ----------
export function draftPrompt(S, text, existingKeywords = []) {
  return `You turn a UK small business owner's request into an automation for their WhatsApp and website chat assistant. Business: "${S.business?.name}"${TRADES[S.trade] ? ` (${TRADES[S.trade].label})` : ''}. ${isShop(S) ? 'It sells products in the chat.' : 'No online shop in the chat.'} ${S.bookings?.enabled ? 'Customers can book in the chat.' : 'No bookings in the chat.'}${existingKeywords.length ? ` Trigger words already used by other automations: ${existingKeywords.join(', ')}.` : ''}

The owner wrote: """${clip(text, 600)}"""

Reply with JSON only, one of:
A) a chat flow that starts when a customer types a trigger word:
{"type":"flow","summary":"one sentence, plain English","flow":{"name":"max 40 chars","triggers":{"keywords":["1-5 short words or phrases customers would type"],"match":"exact|contains"},"steps":[{"id":"s1",…},…]}}
Allowed steps only (each needs a unique "id"; "next":"step id" sets what follows, otherwise the next step in the list runs):
${Object.entries(STEP_RULES).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
Text may use {{name}}. Keep messages short and friendly, British English. Never invent prices, opening hours or policies – if the owner didn't give them, offer to pass the question to the team (handover) or hand back to the assistant (action "menu"), which answers from the business's own website.
B) a change to built-in follow-ups:
{"type":"settings","summary":"…","settings":[{"path":"one of the paths below","value":…}]}
${Object.entries(SETTINGS).filter(([, v]) => (!v.shop || isShop(S)) && (!v.bookings || S.bookings?.enabled)).map(([k, v]) => `- ${k} (${v.type}${v.type === 'number' ? ` ${v.min}–${v.max}` : ''}): ${v.label}`).join('\n')}
C) if it needs anything else – messaging people who haven't written in (that is Campaigns, and needs their consent), sending data to other systems, payments, changing prices – reply {"type":"cannot","summary":"…","reason":"why, and where in the dashboard to do it instead"}.`;
}

export async function draftAutomation(tenant, text) {
  if (!directConfigured()) throw Object.assign(new Error("Drafting automations needs the AI, which isn't set up on this server yet."), { status: 503 });
  const ask = clip(text, 600);
  if (ask.length < 8) throw Object.assign(new Error('Describe the automation in a sentence or two.'), { status: 400 });
  const kw = listFlows(tenant.id).filter((f) => f.active).flatMap((f) => f.triggers.keywords || []);
  const r = await chatCompletion({ temperature: 0.2, maxTokens: 1400, messages: [{ role: 'user', content: draftPrompt(tenant.settings, ask, kw) }] });
  bumpUsage(tenant.id, 'ai_calls'); bumpUsage(tenant.id, 'ai_cost_micro', costMicro(r.usage));
  const raw = String(r.choices?.[0]?.message?.content || '').replace(/```(json)?/g, '');
  let j = null;
  try { j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch {}
  return checkDraft(j, tenant.settings, { existingKeywords: kw });
}

// ---------- 2. the server checks it ----------
/** Keep only what's allowed; list every problem in plain English. Returns { type, summary, flow?, changes?, reason?, issues, ok }. */
export function checkDraft(j, S = {}, { existingKeywords = [] } = {}) {
  const issues = [];
  if (!j || typeof j !== 'object') return { type: 'cannot', summary: "The AI's answer couldn't be read.", reason: 'Try describing it again, a little more simply.', issues: ['unreadable answer'], ok: false };
  const summary = clip(j.summary, 240);
  if (j.type === 'cannot') return { type: 'cannot', summary, reason: clip(j.reason, 400) || 'This needs something automations here can\'t do.', issues: [], ok: false };
  if (j.type === 'settings') {
    const changes = [];
    for (const c of Array.isArray(j.settings) ? j.settings.slice(0, 8) : []) {
      const rule = SETTINGS[c?.path];
      if (!rule) { issues.push(`"${clip(c?.path, 60)}" isn't a setting automations may change – left out`); continue; }
      if (rule.shop && !isShop(S)) { issues.push(`${rule.label}: only for businesses selling in the chat – left out`); continue; }
      if (rule.bookings && !S.bookings?.enabled) { issues.push(`${rule.label}: bookings are off – left out`); continue; }
      let v = c.value;
      if (rule.type === 'bool') v = v === true || v === 'true' || v === 1;
      else { v = Math.round(Number(v)); if (!Number.isFinite(v)) { issues.push(`${rule.label}: not a number – left out`); continue; } const cl = Math.min(rule.max, Math.max(rule.min, v)); if (cl !== v) issues.push(`${rule.label}: ${v} is outside ${rule.min}–${rule.max}, so ${cl} is used`); v = cl; }
      const before = getP(S, c.path) ?? DEFAULTS[c.path];
      if (before === v) { issues.push(`${rule.label}: already ${fmtVal(rule, v)} – nothing to change`); continue; }
      changes.push({ path: c.path, label: rule.label, before, after: v });
    }
    if (changes.some((c) => c.path === 'notifications.reviewRequest.enabled' && c.after) && !S.notifications?.reviewRequest?.url) issues.push('Add your Google review link (Settings → Google review requests) before switching review requests on – without it none are sent.');
    return { type: 'settings', summary, changes, issues, ok: changes.length > 0 };
  }
  if (j.type !== 'flow' || !j.flow) return { type: 'cannot', summary, reason: "The AI didn't produce an automation for this. Try describing it again.", issues: ['no flow or settings in the answer'], ok: false };
  const f = j.flow;
  const steps = [];
  for (const [i, s] of (Array.isArray(f.steps) ? f.steps : []).slice(0, 20).entries()) {
    if (!s || !ALLOWED_STEPS.includes(s.type)) { issues.push(`step ${i + 1} ("${clip(s?.type, 20)}") isn't allowed in drafts – removed`); continue; }
    const o = { id: clip(s.id, 20).replace(/[^\w-]/g, '') || `s${i + 1}`, type: s.type };
    if (s.next) o.next = clip(s.next, 20);
    if (['message', 'question', 'list', 'handover'].includes(s.type) && s.text) o.text = clip(s.text, 600);
    if (s.type === 'message' && Array.isArray(s.buttons)) o.buttons = s.buttons.slice(0, 3).map((b) => ({ title: clip(b?.title, 20), ...(b?.goto ? { goto: clip(b.goto, 20) } : {}) })).filter((b) => b.title);
    if (s.type === 'question') { o.save = clip(s.save, 30).replace(/[^\w]/g, '_').toLowerCase() || 'answer'; o.validate = ['any', 'email', 'number', 'phone'].includes(s.validate) ? s.validate : 'any'; }
    if (s.type === 'list') { o.button = clip(s.button, 20) || 'Choose'; o.rows = (Array.isArray(s.rows) ? s.rows : []).slice(0, 10).map((r) => ({ title: clip(r?.title, 24), ...(r?.description ? { description: clip(r.description, 72) } : {}), ...(r?.goto ? { goto: clip(r.goto, 20) } : {}) })).filter((r) => r.title); }
    if (s.type === 'tag') { o.add = (s.add || []).map((t) => clip(t, 30).toLowerCase()).filter(Boolean).slice(0, 5); o.remove = (s.remove || []).map((t) => clip(t, 30).toLowerCase()).filter(Boolean).slice(0, 5); }
    if (s.type === 'action') { if (!ALLOWED_ACTIONS.includes(s.action)) { issues.push(`step ${i + 1}: action "${clip(s.action, 20)}" isn't allowed – "menu" used`); o.action = 'menu'; } else o.action = s.action; if (['browse', 'cart', 'status'].includes(o.action) && !isShop(S)) { issues.push(`step ${i + 1}: "${o.action}" needs an online shop – "menu" used`); o.action = 'menu'; } }
    if (s.type === 'delay') { const m = Math.round(Number(s.minutes)); o.minutes = Math.min(1440, Math.max(1, Number.isFinite(m) ? m : 30)); }
    if (s.type === 'goto') o.step = clip(s.step, 20);
    steps.push(o);
  }
  const keywords = [...new Set((f.triggers?.keywords || []).map((k) => clip(k, 40).toLowerCase()).filter((k) => k.length >= 2))].slice(0, 5);
  if (!keywords.length) issues.push('no trigger words – add at least one word customers would type');
  const clash = keywords.filter((k) => existingKeywords.includes(k));
  if (clash.length) issues.push(`another automation already starts on: ${clash.join(', ')}`);
  if (keywords.some((k) => ['hi', 'hello', 'hey', 'menu', 'help', 'stop', 'start'].includes(k))) issues.push('a trigger word like "hi", "menu" or "stop" would take over everyday messages – choose something more specific');
  const flow = { name: clip(f.name, 40) || 'New automation', triggers: { keywords, match: f.triggers?.match === 'contains' ? 'contains' : 'exact' }, steps };
  const errors = validateFlow(flow);
  issues.push(...errors);
  const blocking = !steps.length || !keywords.length || errors.length > 0 || clash.length > 0 || issues.some((x) => /take over everyday/.test(x));
  return { type: 'flow', summary, flow, issues, ok: !blocking };
}
const fmtVal = (rule, v) => (rule.type === 'bool' ? (v ? 'on' : 'off') : String(v));

// ---------- 3. try it out ----------
const SAFE_SETTINGS = (S) => ({
  business: { name: S.business?.name || 'Your business', currencySymbol: S.business?.currencySymbol || '£', timezone: S.business?.timezone || 'Europe/London', supportHours: S.business?.supportHours || '' },
  store: S.store?.type === 'manual' ? { type: 'manual', manual: S.store.manual || {} } : { type: 'none' },
  welcomeMenu: S.welcomeMenu || {},
  trade: S.trade || null,
  followUps: { quietStart: 0, quietEnd: 0 },
  notifications: { alertEmails: [], staffWaIds: [], webhookUrl: '' },
});
const SAMPLE_ANSWER = { email: 'sam@example.com', number: '2', phone: '07700 900123', any: 'Sample answer' };

/** Play a draft flow through the real engine on a throwaway copy of the business. One run per first choice (max 3). */
export function simulateFlow(tenant, flow) {
  return sampleRun.run({ draft: true }, async () => {
    const { tenant: t } = createTenant({ name: `${tenant.settings.business?.name || 'Business'} (try-out)`, plan: 'pro' });
    try {
      updateTenantSettings(t.id, { demo: { sample: true, tryout: true, expiresAt: new Date(Date.now() + 15 * 60000).toISOString() }, ...SAFE_SETTINGS(tenant.settings) });
      const saved = saveFlow(t.id, { ...flow, active: true });
      const questions = flow.steps.filter((s) => s.type === 'question');
      const runs = [];
      const play = async (waId, ev, sink) => { sink.length = 0; const send = createSender(getTenant(t.id), { sink }); await handleInbound(getTenant(t.id), { profileName: 'Sam', ...ev, waId }, (to, m) => (to === waId ? send(to, m) : Promise.resolve())); return [...sink]; };
      const choicesOf = (msgs) => msgs.flatMap((m) => [...(m.buttons || []), ...(m.sections || []).flatMap((s) => s.rows)]).filter((c) => String(c.id).startsWith('flow:'));
      const shown = (m) => ({ from: 'assistant', text: String(m.text || m.body || '').replace(/\n*🤖 _[^_]*_\s*$/u, '').trim(), choices: [...(m.buttons || []), ...(m.sections || []).flatMap((s) => s.rows)].map((c) => c.title) });
      for (let path = 0; path < 3; path++) {
        const waId = `447700900${String(crypto.randomInt(0, 1000)).padStart(3, '0')}`;
        const sink = [];
        const tr = [{ from: 'customer', text: flow.triggers.keywords[0] }];
        let last = await play(waId, { kind: 'text', text: flow.triggers.keywords[0] }, sink);
        tr.push(...last.map(shown));
        let firstChoices = 0;
        for (let i = 0; i < 8; i++) {
          const ch = choicesOf(last);
          if (i === 0) firstChoices = ch.length;
          if (ch.length) { const c = ch[i === 0 ? Math.min(path, ch.length - 1) : 0]; tr.push({ from: 'customer', text: c.title, tap: true }); last = await play(waId, { kind: 'action', id: c.id, text: c.title }, sink); tr.push(...last.map(shown)); continue; }
          const q = questions.find((s) => last.some((m) => String(m.text || '').includes(String(s.text).replace(/\{\{[^}]+\}\}/g, '').trim().slice(0, 18))));
          if (q) { const a = SAMPLE_ANSWER[q.validate] || SAMPLE_ANSWER.any; tr.push({ from: 'customer', text: a }); last = await play(waId, { kind: 'text', text: a }, sink); tr.push(...last.map(shown)); continue; }
          break;
        }
        const delayStep = flow.steps.find((s) => s.type === 'delay');
        if (delayStep) tr.push({ from: 'note', text: `Then waits ${delayStep.minutes} minutes and carries on (only while the chat is still open).` });
        runs.push(tr);
        if (path + 1 >= Math.max(1, Math.min(3, firstChoices))) break;
      }
      const conv = getDb().prepare('SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND human_handover = 1').get(t.id).n;
      return { runs, handedOver: conv > 0, flowId: saved.id };
    } finally { try { deleteTenant(t.id); } catch (e) { console.warn('[draft try-out] cleanup', e.message); } }
  });
}

// ---------- 4. drafts are kept until approved ----------
const KEY = (tenantId, id) => `autodraft:${tenantId}:${id}`;
export function saveDraft(tenantId, rec) {
  const id = rec.id || crypto.randomBytes(6).toString('hex');
  const v = { ...rec, id, createdAt: rec.createdAt || new Date().toISOString() };
  getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY(tenantId, id), JSON.stringify(v));
  return v;
}
export const getDraft = (tenantId, id) => json(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(KEY(tenantId, String(id).replace(/[^a-f0-9]/g, '')))?.value, null);
export const listDrafts = (tenantId) => getDb().prepare('SELECT value FROM kv WHERE key LIKE ? ORDER BY rowid DESC LIMIT 20').all(`autodraft:${tenantId}:%`).map((r) => json(r.value, null)).filter(Boolean);
export const discardDraft = (tenantId, id) => getDb().prepare('DELETE FROM kv WHERE key = ?').run(KEY(tenantId, String(id).replace(/[^a-f0-9]/g, '')));

/** Create a draft from the owner's words: AI → checks → try-out. */
export async function createDraft(tenant, text) {
  const d = await draftAutomation(tenant, text);
  let tryout = null;
  if (d.type === 'flow' && d.flow.steps.length && !validateFlow(d.flow).length && d.flow.triggers.keywords.length) tryout = await simulateFlow(tenant, d.flow);
  return saveDraft(tenant.id, { text: clip(text, 600), ...d, tryout, status: 'draft' });
}

/** The owner approves: the flow goes live in Automations, or the settings change is made. Checks run again first. */
export function approveDraft(tenant, id, { by = 'owner' } = {}) {
  const rec = getDraft(tenant.id, id);
  if (!rec || rec.status !== 'draft') throw Object.assign(new Error('Draft not found (or already approved).'), { status: 404 });
  const kw = listFlows(tenant.id).filter((f) => f.active).flatMap((f) => f.triggers.keywords || []);
  if (rec.type === 'flow') {
    const again = checkDraft({ type: 'flow', summary: rec.summary, flow: rec.flow }, tenant.settings, { existingKeywords: kw });
    if (!again.ok) throw Object.assign(new Error(again.issues[0] || 'This draft no longer passes the checks.'), { status: 400, issues: again.issues });
    const flow = saveFlow(tenant.id, { ...again.flow, active: true });
    saveDraft(tenant.id, { ...rec, status: 'approved', approvedAt: new Date().toISOString(), approvedBy: by, flowId: flow.id });
    return { type: 'flow', flow };
  }
  if (rec.type === 'settings') {
    const again = checkDraft({ type: 'settings', summary: rec.summary, settings: rec.changes.map((c) => ({ path: c.path, value: c.after })) }, tenant.settings);
    if (!again.ok) throw Object.assign(new Error(again.issues[0] || 'Nothing left to change.'), { status: 400, issues: again.issues });
    const patch = {};
    for (const c of again.changes) setP(patch, c.path, c.after);
    updateTenantSettings(tenant.id, patch);
    saveDraft(tenant.id, { ...rec, status: 'approved', approvedAt: new Date().toISOString(), approvedBy: by, changes: again.changes });
    return { type: 'settings', changes: again.changes };
  }
  throw Object.assign(new Error('There is nothing to approve in this draft.'), { status: 400 });
}
