import { getDb, json } from './db.js';
import { listTenants, getTenant } from './tenants.js';
import { chatCompletion, directConfigured } from './ai/direct.js';
import { menuOptions } from './bot/engine.js';

/*
 * Self-improving templates. Every week:
 *  1. Per shop – the questions its own customers ask most that its welcome menu doesn't cover become suggestions
 *     ("Customers often ask about parking – add it to your menu?"), one tap to add.
 *  2. Per trade – what customers of all shops in that trade ask (only topics seen at 2+ shops, rewritten as generic
 *     questions with no names or personal details) is added to that trade's questions: the weekly answer check uses
 *     them, and AI auto-setup writes new shops' menus with them in mind. So every new dentist starts smarter.
 */
const kvGet = (k) => json(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value, null);
const kvSet = (k, v) => getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
const STOP = new Set('the and for you your are was can could would what when where which who how does did this that with from have has about any there please thanks thank hello hi need want like just get our not'.split(' '));
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9£\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const stem = (w) => w.replace(/(ings?|ed|es|s)$/, '').slice(0, 4);
const GENERIC = new Set(['much', 'cost', 'pric', 'know', 'tell', 'some', 'many', 'your', 'make', 'help', 'okay', 'also', 'them', 'they', 'will']);
const keyStems = (t) => [...new Set(words(t).map(stem))].filter((x) => x.length >= 3 && !GENERIC.has(x));

/** A shop's real customer questions (last N days), most asked first, grouped by their main words. */
export function topQuestions(tenantId, { days = 30, n = 10 } = {}) {
  const rows = getDb().prepare(`SELECT json_extract(body, '$.text') AS q FROM messages WHERE tenant_id = ? AND direction = 'in' AND type = 'text'
    AND wa_id NOT LIKE 'qa:%' AND COALESCE(json_extract(body, '$.simulated'), 0) = 0 AND created_at > datetime('now', ?) LIMIT 5000`).all(tenantId, `-${days} days`);
  const groups = []; // greedy: a question joins the first group it shares a main word with
  for (const { q } of rows) {
    const t = String(q || '').trim();
    if (t.length < 10 || t.length > 200 || /^\[/.test(t) || !(/\?/.test(t) || /^(do|does|can|could|is|are|what|when|where|how|which|who|will|have|any)\b/i.test(t))) continue;
    const ks = keyStems(t);
    if (!ks.length) continue;
    let g = groups.find((x) => ks.some((k) => x.stems.has(k)));
    if (!g) { g = { key: ks.slice().sort().slice(0, 3).join(' '), stems: new Set(ks), n: 0, example: t }; groups.push(g); }
    g.n++;
    if (t.length < g.example.length) g.example = t;
  }
  return groups.map(({ stems, ...g }) => g).sort((a, b) => b.n - a.n).slice(0, n);
}

/** Does the menu already cover this question? (shares its main words with an option's label or question) */
function covered(S, q) {
  const qw = new Set(keyStems(q));
  return menuOptions(S).some((o) => { const ow = new Set(keyStems(`${o.label} ${o.value || ''}`)); return [...qw].filter((w) => ow.has(w)).length >= Math.min(2, qw.size); });
}

const EMOJI = [[/deliver|shipping|postage/, '🚚'], [/price|cost|much|fee|£/, '💷'], [/open|hour|close|time/, '🕒'], [/park|where|locat|address|find/, '📍'], [/book|appoint|slot|availab/, '📅'], [/return|refund|exchange/, '↩️'], [/vegan|gluten|allerg|halal/, '🌱'], [/pay|card|cash|finance|instal/, '💳'], [/voucher|gift/, '🎁']];
export function labelFor(q) {
  const w = words(q).filter((x) => !['much', 'cost', 'price'].includes(x));
  const e = (EMOJI.find(([re]) => re.test(q.toLowerCase())) || [null, '❓'])[1];
  const text = w.slice(0, 3).join(' ');
  return `${e} ${text.charAt(0).toUpperCase()}${text.slice(1)}`.slice(0, 24).trim();
}

/** Suggestions for the shop's welcome menu: its customers' top questions it doesn't cover yet (needs 2+ askers). */
export function menuSuggestions(tenant, { n = 3 } = {}) {
  const S = tenant.settings;
  const dismissed = new Set(kvGet(`menu_suggest_skip:${tenant.id}`) || []);
  return topQuestions(tenant.id, { n: 20 }).filter((g) => g.n >= 2 && !dismissed.has(g.key) && !covered(S, g.example)).slice(0, n)
    .map((g) => ({ key: g.key, asked: g.n, question: g.example.replace(/\s+/g, ' ').slice(0, 200), label: labelFor(g.example) }));
}
export function dismissSuggestion(tenantId, key) {
  const k = `menu_suggest_skip:${tenantId}`;
  kvSet(k, [...new Set([...(kvGet(k) || []), String(key).slice(0, 60)])].slice(-100));
}

/** Questions learnt for a trade across shops (generic wording). */
export const learnedQuestions = (trade) => kvGet(`trade_learned:${trade}`)?.questions || [];

/** Weekly: for each trade with 2+ shops, the AI turns their customers' common questions into generic ones. */
export async function improveTradeTemplates({ force = false } = {}) {
  if (!directConfigured()) return 0;
  const byTrade = new Map();
  for (const t of listTenants()) {
    const full = getTenant(t.id);
    const trade = full?.settings?.trade;
    if (!trade || !full.active) continue;
    if (!byTrade.has(trade)) byTrade.set(trade, []);
    byTrade.get(trade).push(full.id);
  }
  let done = 0;
  for (const [trade, ids] of byTrade) {
    if (ids.length < 2) continue;
    const prev = kvGet(`trade_learned:${trade}`);
    if (!force && prev && Date.now() - Date.parse(prev.at) < 6.5 * 86400000) continue;
    // topics seen at 2+ shops only (so nothing particular to one business leaks into others' templates)
    const seen = new Map();
    for (const id of ids) for (const g of topQuestions(id, { days: 60, n: 25 })) { const s = seen.get(g.key) || { shops: new Set(), n: 0, example: g.example }; s.shops.add(id); s.n += g.n; seen.set(g.key, s); }
    const common = [...seen.values()].filter((s) => s.shops.size >= 2).sort((a, b) => b.n - a.n).slice(0, 20).map((s) => s.example);
    if (common.length < 3) continue;
    try {
      const r = await chatCompletion({ temperature: 0, maxTokens: 500, messages: [{ role: 'user', content: `Customers of several UK ${trade} businesses asked these questions in their chats:\n${common.map((q) => `- ${q}`).join('\n')}\n\nRewrite the 8 most useful as short, generic customer questions (no business names, places, people, numbers or personal details). JSON only: {"questions": ["..."]}` }] });
      const raw = String(r.choices?.[0]?.message?.content || '');
      const qs = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).questions.filter((q) => typeof q === 'string' && q.length >= 8 && q.length <= 120 && !/@|\d{5,}|https?:/.test(q)).slice(0, 8);
      if (qs.length) { kvSet(`trade_learned:${trade}`, { questions: qs, shops: ids.length, at: new Date().toISOString() }); done++; }
    } catch (e) { console.warn('[learn]', trade, e.message); }
  }
  return done;
}
