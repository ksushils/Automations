import { createHash } from 'node:crypto';
import { getDb, json } from './db.js';
import { config } from './config.js';
import { emailShop, sendEmail } from './email.js';
import { notify } from './whatsapp/cloudApi.js';
import { sendHook } from './hooks.js';

/*
 * Chat leads: the assistant turns interest into a lead the team can act on.
 *  - Menu topics (welcome-menu links) answer in the chat first – a short summary written from the shop's own
 *    website – then link to the page, then offer "Email me details" / "Call me back" / "Ask a question".
 *  - Email me details: email → (optional) phone → anything particular to discuss → done.
 *    Call me back:     phone (WhatsApp: the number they're chatting from) → anything to discuss → (optional) email → done.
 *  - One question at a time, always with a Skip; the visitor can type a question instead and the AI answers it.
 *  - Each lead is saved (chat_leads), the team is told at once (email + staff WhatsApp), and marketing consent is a
 *    separate, optional tap at the end (UK PECR) – asking for details is not consent to offers.
 */
export const LEAD_STATES = new Set(['lead_email', 'lead_phone', 'lead_when', 'lead_msg', 'lead_name']);
export const CALL_TIMES = ['Morning', 'Afternoon', 'Evening'];
const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(String(s || '').trim());
export const cleanPhone = (s) => { const raw = String(s || '').trim(); const d = raw.replace(/[^\d]/g, ''); return d.length >= 7 && d.length <= 15 && /^[+\d][\d\s().-]*$/.test(raw) ? (raw.startsWith('+') ? '+' : '') + d : null; };
const isWeb = (ctx) => String(ctx.conv.waId).startsWith('web:');
const skipBtn = (id, title = 'Skip') => ({ id, title });

export function leadSettings(S) {
  const L = S.leads || {};
  return {
    enabled: L.enabled !== false,
    brochureUrl: /^https?:\/\/\S+$/i.test(String(L.brochureUrl || '')) ? String(L.brochureUrl) : '',
    requirementPrompt: String(L.requirementPrompt || 'Is there anything in particular you\'d like to discuss? For example what you\'re looking for, dates, or how many people.').slice(0, 300),
    callbackPromise: String(L.callbackPromise || 'Our team will be in touch within one working day.').slice(0, 200),
    privacyUrl: String(L.privacyUrl || S.business?.privacyUrl || '').slice(0, 300),
  };
}

/** The follow-up after a topic: how can we help next? (max 3 buttons for WhatsApp) */
export function leadOffer(ctx, topic, text) {
  const L = leadSettings(ctx.S);
  const t = String(topic || 'general').slice(0, 60);
  return { type: 'buttons', text: text || 'Would you like our team to help with this?', buttons: [
    { id: `lead:email:${t}`, title: L.brochureUrl ? '📩 Send the brochure' : '📩 Email me details' },
    { id: `lead:call:${t}`, title: '📞 Call me back' },
    { id: 'ask', title: '💬 Ask a question' },
  ] };
}

// ---------- topic answers for welcome-menu links ----------
function cacheGet(key) {
  const r = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key);
  const v = json(r?.value, null);
  return v && Date.now() - Date.parse(v.at) < 86400000 ? v.text : null;
}
function cacheSet(key, text) {
  getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify({ text, at: new Date().toISOString() }));
}

/** A short "what we do for X" from the shop's own website (cached for a day). The owner's own text wins. */
export async function topicSummary(ctx, option, { ai } = {}) {
  if (String(option.description || '').trim().length > 30) return String(option.description).trim();
  const label = String(option.label || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const key = `topic:${ctx.tenant.id}:${createHash('sha1').update(`${label}|${option.value || ''}`).digest('hex').slice(0, 16)}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  if (!ai) return null;
  try {
    const text = await ai(label, option.value);
    if (text && text.length > 20) { cacheSet(key, text); return text; }
  } catch (e) { console.warn('[topic]', e.message); }
  return null;
}

// ---------- the capture steps ----------
function ask(ctx, step) {
  const L = leadSettings(ctx.S);
  const lead = ctx.conv.data.lead;
  ctx.conv.state = `lead_${step}`;
  const why = lead.kind === 'email' ? (L.brochureUrl ? 'so we can send you the brochure' : `so our team can send you details${lead.topic && lead.topic !== 'general' ? ` about ${lead.topic}` : ''}`) : 'so our team can call you back';
  const privacy = L.privacyUrl ? `\n_We only use it for this. Privacy: ${L.privacyUrl}_` : '\n_We only use it to reply to you._';
  if (step === 'email') return ctx.reply({ type: 'buttons', text: `${lead.kind === 'email' ? '📩 Great!' : 'And'} What's your email address? (${why})${lead.kind === 'email' ? privacy : ''}`, buttons: [skipBtn(lead.kind === 'email' ? 'lead:cancel' : 'lead:skip', lead.kind === 'email' ? 'Not now' : 'Skip')] });
  if (step === 'phone') {
    return ctx.reply({ type: 'buttons', text: lead.kind === 'call' ? `📞 Sure! What's the best number to call you on?${privacy}` : 'Would you like a call back too? Type your phone number, or tap No thanks.', buttons: [skipBtn(lead.kind === 'call' ? 'lead:cancel' : 'lead:skip', lead.kind === 'call' ? 'Not now' : 'No thanks')] });
  }
  if (step === 'name') return ctx.reply({ type: 'buttons', text: 'And who should we ask for? (your first name)', buttons: [skipBtn('lead:skip')] });
  if (step === 'when') return ctx.reply({ type: 'buttons', text: '🕒 When is best to call you?', buttons: CALL_TIMES.map((t) => ({ id: `lead:when:${t}`, title: t })) });
  if (step === 'msg') return ctx.reply({ type: 'buttons', text: `📝 ${L.requirementPrompt}`, buttons: [skipBtn('lead:skip', 'Nothing else')] });
}

/** Steps still to ask, in order. */
function nextStep(ctx) {
  const lead = ctx.conv.data.lead;
  const done = new Set(lead.done || []);
  const order = lead.kind === 'call' ? ['phone', 'when', 'name', 'msg', 'email'] : ['email', 'phone', 'name', 'msg'];
  return order.find((s) => !done.has(s) && !(s === 'phone' && (lead.phone || !isWeb(ctx) && lead.kind === 'email')) && !(s === 'name' && (lead.name || ctx.customer?.name)) && !(s === 'email' && lead.email));
}

export function startLead(ctx, kind, topic) {
  const lead = { kind: kind === 'call' ? 'call' : 'email', topic: String(topic || 'general').slice(0, 80), done: [], startedAt: new Date().toISOString() };
  if (!isWeb(ctx)) lead.phone = '+' + String(ctx.conv.waId).replace(/\D/g, ''); // on WhatsApp we already have their number
  if (ctx.customer?.email && isEmail(ctx.customer.email)) lead.email = ctx.customer.email;
  const known = cleanPhone(json(ctx.customer?.attributes, {})?.phone); // from the form before the chat
  if (!lead.phone && known) lead.phone = known;
  ctx.conv.data.lead = lead;
  if (lead.kind === 'call' && lead.phone) ctx.reply({ type: 'text', text: `📞 Sure – we'll call you on ${lead.phone}.` });
  return continueLead(ctx);
}

async function continueLead(ctx) {
  const step = nextStep(ctx);
  if (step) return ask(ctx, step);
  return finishLead(ctx);
}

/** A lead action button: lead:email:<topic> | lead:call:<topic> | lead:skip | lead:cancel | lead:optin | lead:nooptin */
export async function leadAction(ctx, arg) {
  const [cmd, topic = ''] = String(arg || '').split(/:(.*)/s);
  if (cmd === 'email' || cmd === 'call') return startLead(ctx, cmd, topic);
  if (cmd === 'optin' || cmd === 'nooptin') return marketingChoice(ctx, cmd === 'optin');
  if (cmd === 'fillform') {
    const row = getDb().prepare('SELECT * FROM chat_leads WHERE id = ? AND tenant_id = ? AND wa_id = ?').get(Number(topic), ctx.tenant.id, ctx.conv.waId);
    if (!row) return ctx.reply({ type: 'text', text: 'No problem – our team has your details.' });
    return ctx.reply({ type: 'fill_form', text: 'Filling in the form on this page…', fields: { name: row.name || '', email: row.email || '', phone: row.phone || '', message: [row.topic && row.topic !== 'general' ? row.topic : '', row.message || ''].filter(Boolean).join(': ') } });
  }
  if (cmd === 'when' && ctx.conv.data.lead) { const l = ctx.conv.data.lead; l.callTime = CALL_TIMES.includes(topic) ? topic : String(topic).slice(0, 40); l.done = [...new Set([...(l.done || []), 'when'])]; return continueLead(ctx); }
  const lead = ctx.conv.data.lead;
  if (!lead) return ctx.reply({ type: 'text', text: 'No problem! Ask me anything, or type *menu* to see the options.' });
  if (cmd === 'cancel') { ctx.conv.state = 'idle'; ctx.conv.data.lead = null; return ctx.reply({ type: 'text', text: 'No problem! Ask me anything, or type *menu* to see the options.' }); }
  if (cmd === 'skip') { lead.done = [...new Set([...(lead.done || []), ctx.conv.state.replace('lead_', '')])]; return continueLead(ctx); }
  return continueLead(ctx);
}

/**
 * Text typed while a lead step is open. Returns false when it isn't an answer (e.g. a question) – then the flow is
 * set aside and the message is handled normally, so a visitor is never stuck in a form.
 */
export async function leadText(ctx, text) {
  const lead = ctx.conv.data.lead;
  const step = String(ctx.conv.state || '').replace('lead_', '');
  if (!lead || !LEAD_STATES.has(ctx.conv.state)) return false;
  const v = String(text || '').trim();
  const looksLikeQuestion = /\?\s*$/.test(v) || (v.split(/\s+/).length >= 6 && step !== 'msg');
  if (step === 'email') {
    if (isEmail(v)) { lead.email = v.toLowerCase(); lead.done.push('email'); return continueLead(ctx); }
    if (looksLikeQuestion) { ctx.conv.state = 'idle'; return false; }
    return ctx.reply({ type: 'buttons', text: "Hmm, that doesn't look like an email address. Could you check it? (e.g. name@example.com)", buttons: [skipBtn(lead.kind === 'email' ? 'lead:cancel' : 'lead:skip', lead.kind === 'email' ? 'Not now' : 'Skip')] });
  }
  if (step === 'phone') {
    const p = cleanPhone(v);
    if (p) { lead.phone = p; lead.done.push('phone'); return continueLead(ctx); }
    if (looksLikeQuestion) { ctx.conv.state = 'idle'; return false; }
    return ctx.reply({ type: 'buttons', text: "Sorry, I couldn't read that number. Please type it with the area or country code (e.g. 07700 900123 or +91 98765 43210).", buttons: [skipBtn(lead.kind === 'call' ? 'lead:cancel' : 'lead:skip', lead.kind === 'call' ? 'Not now' : 'No thanks')] });
  }
  if (step === 'name') {
    if (looksLikeQuestion) { ctx.conv.state = 'idle'; return false; }
    lead.name = v.replace(/^(i'?m|my name is|it'?s|this is)\s+/i, '').slice(0, 60); lead.done.push('name'); return continueLead(ctx);
  }
  if (step === 'when') { if (looksLikeQuestion) { ctx.conv.state = 'idle'; return false; } lead.callTime = v.slice(0, 60); lead.done.push('when'); return continueLead(ctx); }
  if (step === 'msg') { lead.message = v.slice(0, 1000); lead.done.push('msg'); return continueLead(ctx); }
  return false;
}

export function saveChatLead(tenant, conv, lead, customer) {
  const page = conv.data?.page?.url || null;
  // where they came from: the ad (Click-to-WhatsApp) or the campaign tags on the page they landed on
  let source = null;
  try { source = json(customer?.source, null); } catch {}
  if (conv.data?.utm) source = { ...(source || {}), ...conv.data.utm };
  const id = Number(getDb().prepare(`INSERT INTO chat_leads (tenant_id, wa_id, channel, kind, topic, name, email, phone, message, call_time, page, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tenant.id, conv.waId, String(conv.waId).startsWith('web:') ? 'web' : 'whatsapp', lead.kind, lead.topic || null, lead.name || customer?.name || null, lead.email || null, lead.phone || null, lead.message || null, lead.callTime || null, page, source ? JSON.stringify(source) : null).lastInsertRowid);
  if (lead.email) getDb().prepare('UPDATE customers SET email = COALESCE(email, ?) WHERE tenant_id = ? AND wa_id = ?').run(lead.email, tenant.id, conv.waId);
  if (lead.name) getDb().prepare('UPDATE customers SET name = COALESCE(name, ?) WHERE tenant_id = ? AND wa_id = ?').run(lead.name, tenant.id, conv.waId);
  return id;
}

export function leadSummary(tenant, lead, { page } = {}) {
  return [
    `${lead.kind === 'call' ? '📞 Call-back request' : '📩 Details requested'}${lead.topic && lead.topic !== 'general' ? ` – ${lead.topic}` : ''}`,
    lead.name && `Name: ${lead.name}`,
    lead.phone && `Phone: ${lead.phone}`,
    lead.email && `Email: ${lead.email}`,
    lead.callTime && `Best time to call: ${lead.callTime}`,
    lead.message && `Wants to discuss: ${lead.message}`,
    page && `Page: ${page}`,
  ].filter(Boolean).join('\n');
}

async function finishLead(ctx) {
  const lead = ctx.conv.data.lead;
  const L = leadSettings(ctx.S);
  ctx.conv.state = 'idle';
  ctx.conv.data.lead = null;
  if (!lead.email && !lead.phone) return ctx.reply({ type: 'text', text: 'No problem! Ask me anything, or type *menu* to see the options.' });
  const id = saveChatLead(ctx.tenant, ctx.conv, lead, ctx.customer);
  ctx.conv.data.lastLeadId = id;
  const summary = leadSummary(ctx.tenant, lead, { page: ctx.conv.data.page?.url });
  // a two-line summary of the chat for the team (in the background; the lead is saved either way)
  import('./ai/direct.js').then(({ summarizeChat }) => summarizeChat(ctx.tenant, ctx.conv.waId)).then((s) => s && getDb().prepare('UPDATE chat_leads SET summary = ? WHERE id = ?').run(s, id)).catch(() => {});
  // tell the team straight away – speed matters most for a call back
  emailShop(ctx.tenant, `New lead: ${lead.kind === 'call' ? 'call back' : 'details'}${lead.topic && lead.topic !== 'general' ? ` – ${lead.topic}` : ''}`, `${summary}\n\nIt's in the Leads list in your dashboard.`, { button: 'Open your dashboard' }).catch(() => {});
  sendHook(ctx.tenant, 'lead.new', { id, kind: lead.kind, topic: lead.topic, name: lead.name || ctx.customer?.name || '', email: lead.email || '', phone: lead.phone || '', callTime: lead.callTime || '', message: lead.message || '', page: ctx.conv.data.page?.url || '', channel: isWeb(ctx) ? 'website' : 'whatsapp' }).catch(() => {});
  for (const s of ctx.S.notifications?.staffWaIds || []) notify(ctx.tenant, String(s).replace(/\D/g, ''), { type: 'text', text: `🔔 New lead\n${summary}` }, ctx.S.notifications?.templates?.staffAlert ? { name: ctx.S.notifications.templates.staffAlert, params: [summary.replace(/\n/g, ' · ').slice(0, 900)] } : null, ctx.rawSend).catch(() => {});
  // the brochure: link now, and by email when email is set up
  if (lead.email && L.brochureUrl) {
    sendEmail({ to: lead.email, replyTo: (ctx.S.notifications?.alertEmails || [])[0], subject: `Your ${ctx.S.business.name} brochure`, text: `Hi${lead.name ? ` ${lead.name}` : ''},\n\nThanks for your interest. Here's our brochure: ${L.brochureUrl}\n\n${L.callbackPromise}\n\n${ctx.S.business.name}` })
      .then((r) => getDb().prepare('UPDATE chat_leads SET emailed = ? WHERE id = ?').run(r.ok ? 1 : 0, id)).catch(() => {});
  }
  const bits = [lead.email && `we'll email you at ${lead.email}`, lead.phone && lead.kind === 'call' && `we'll call you on ${lead.phone}${lead.callTime ? ` (${lead.callTime.toLowerCase()})` : ''}`].filter(Boolean);
  const thanks = `✅ Thanks${lead.name ? `, ${lead.name}` : ''}! ${bits.length ? bits.join(' and ').replace(/^./, (c) => c.toUpperCase()) + '. ' : ''}${L.callbackPromise}${L.brochureUrl && lead.email ? `\n\n📄 Here's the brochure now: ${L.brochureUrl}` : ''}`;
  // the page has its own enquiry form (e.g. the business's booking or quote form): offer to fill it in – they press send
  if (isWeb(ctx) && ctx.conv.data.page?.form && ctx.S.leads?.fillSiteForm !== false) ctx.conv.data.fillFormLead = id;
  const offerForm = () => ctx.conv.data.fillFormLead && ctx.reply({ type: 'buttons', text: 'This page has its own enquiry form too. Want me to fill it in with these details? You check it and press send.', buttons: [{ id: `lead:fillform:${id}`, title: '📝 Fill it in' }] });
  if (!lead.email) { ctx.reply({ type: 'text', text: thanks }); return offerForm(); }
  // separate, optional marketing consent (never pre-ticked, never bundled with the request)
  offerForm();
  return ctx.reply({ type: 'buttons', text: `${thanks}\n\n${optInQuestion(ctx.S)}`, buttons: [{ id: 'lead:optin', title: '✅ Yes please' }, { id: 'lead:nooptin', title: 'No thanks' }] });
}

export const optInQuestion = (S) => `Would you also like occasional offers and news from ${S.business?.name || 'us'} by email? You can unsubscribe at any time.`;

function marketingChoice(ctx, yes) {
  const id = ctx.conv.data.lastLeadId;
  if (id) getDb().prepare('UPDATE chat_leads SET marketing_opt_in = ?, opt_in_at = ?, opt_in_text = ? WHERE id = ? AND tenant_id = ?').run(yes ? 1 : 0, yes ? new Date().toISOString() : null, yes ? `${optInQuestion(ctx.S)} → Yes please` : null, id, ctx.tenant.id);
  return ctx.reply({ type: 'text', text: yes ? "Lovely, you're on the list. 🙂 Anything else I can help with?" : 'No problem. Anything else I can help with?' });
}

export function listChatLeads(tenantId, { limit = 200 } = {}) {
  return getDb().prepare('SELECT * FROM chat_leads WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tenantId, limit).map((l) => ({ ...l, source: json(l.source, null) }));
}
export function setLeadStatus(tenantId, id, status) {
  if (!['new', 'contacted', 'won', 'lost'].includes(status)) throw Object.assign(new Error('bad status'), { status: 400 });
  getDb().prepare('UPDATE chat_leads SET status = ? WHERE id = ? AND tenant_id = ?').run(status, Number(id), tenantId);
}
void config;
