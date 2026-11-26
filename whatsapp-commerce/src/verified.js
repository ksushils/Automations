import { getDb, json } from './db.js';

/*
 * Verified answers: every AI answer is kept with the passages it was given (the business's own pages and documents),
 * so the owner can see WHICH source supported it, when that source was last checked, and whether anything in the
 * answer can't be found in the sources.
 *
 * Checks are deterministic (no second AI opinion):
 *  - support: how much of each source's wording appears in the answer (shared meaningful words, plus exact figures);
 *  - figures: every price / number with a unit in the answer must appear in a source or the product list –
 *    anything that doesn't is flagged "not found in your information";
 *  - stale: a source last checked more than 90 days ago;
 *  - no source: the AI answered while nothing relevant was found.
 * Records are kept 90 days (purgeAnswers).
 */
const STALE_DAYS = 90;
const STOP = new Set('the a an and or but if of to in on at for with from by is are was were be been it this that these those we you your our us they them i me my can will would could should do does did have has had not no yes so as than then there here what when where which who how why all any some more most very just about into over also only'.split(' '));
const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}£$€.,:\s-]/gu, ' ').split(/\s+/).map((w) => w.replace(/^[.,:-]+|[.,:-]+$/g, '')).filter((w) => w.length > 2 && !STOP.has(w)));

/** Money amounts, times, percentages and number+unit pairs in a text, normalised ("£45.00" → "£45"). */
export function figures(text) {
  const t = String(text || '');
  const out = new Set();
  for (const m of t.matchAll(/([£$€])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)) out.add(m[1] + String(Number(m[2].replace(/,/g, ''))));
  for (const m of t.matchAll(/\b(\d+(?:\.\d+)?)\s?(%|percent|pounds?|gbp|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|miles?|km)\b/gi)) out.add(`${Number(m[1])} ${m[2].toLowerCase().replace(/s$/, '').replace(/^mins?$/, 'minute').replace(/^hrs?$/, 'hour').replace(/^percent$/, '%').replace(/^pounds?$|^gbp$/, '£')}`);
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/gi)) out.add(`${(Number(m[1]) % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0)}:${m[2] || '00'}`);
  for (const m of t.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) out.add(`${Number(m[1])}:${m[2]}`);
  // "45 pounds" ≡ "£45"
  for (const f of [...out]) { const p = /^(\d+(?:\.\d+)?) £$/.exec(f); if (p) out.add('£' + Number(p[1])); }
  return out;
}

/** Score sources against an answer; find figures the sources don't contain. Pure – tested directly. */
export function checkAnswer(answer, sources, { productText = '', now = Date.now() } = {}) {
  const aw = words(answer);
  const af = figures(answer);
  const scored = sources.map((s) => {
    const sw = words(s.text);
    const shared = [...aw].filter((w) => sw.has(w)).length;
    const sf = figures(s.text);
    const figs = [...af].filter((f) => sf.has(f));
    const support = Math.min(1, (aw.size ? shared / Math.min(aw.size, 25) : 0) + figs.length * 0.25);
    const checked = s.docUpdated ? Date.parse(String(s.docUpdated).replace(' ', 'T') + (String(s.docUpdated).includes('Z') ? '' : 'Z')) : NaN;
    return { doc: s.doc, url: s.url || null, docId: s.docId ?? null, chunkId: s.id ?? null, lastChecked: Number.isFinite(checked) ? new Date(checked).toISOString() : null, stale: Number.isFinite(checked) && now - checked > STALE_DAYS * 864e5, support: Math.round(support * 100) / 100, figures: figs, excerpt: String(s.text || '').replace(/\s+/g, ' ').slice(0, 300) };
  }).sort((a, b) => b.support - a.support);
  const known = new Set([...sources.flatMap((s) => [...figures(s.text)]), ...figures(productText)]);
  const unsupported = [...af].filter((f) => !known.has(f));
  const used = scored.filter((s) => s.support >= 0.2);
  const flags = [];
  if (!sources.length) flags.push('no_source');
  else if (!used.length) flags.push('weak_support');
  if (unsupported.length) flags.push('unsupported_figures');
  if (used.some((s) => s.stale)) flags.push('stale_source');
  return { sources: scored, used: used.map((s) => s.doc), unsupported, flags, confidence: flags.includes('unsupported_figures') || flags.includes('no_source') ? 'low' : flags.length ? 'medium' : 'high' };
}

/**
 * Price guard: money amounts in an AI answer must come from the business's information (sources, products, its own
 * delivery fee / minimum order…). Totals the AI works out are allowed when they're a known price × a small quantity
 * or the sum of two known amounts. Any other amount is removed with the sentence it's in, and the customer is told
 * the team will confirm the price – the assistant never states a price it can't back up.
 */
export function guardPrices(answer, sources = [], { productText = '', extra = [], customerText = '' } = {}) {
  const money = (set) => [...set].filter((f) => /^[£$€]/.test(f));
  const said = new Set(money(figures(customerText))); // the customer's own budget ("under £25") may be repeated back
  const CHOICES = /\[CHOICES:[^\]]*\]/gi; // tap-to-choose options such as budget bands are questions, not price claims
  const inAnswer = money(figures(String(answer).replace(CHOICES, ' '))).filter((f) => !said.has(f));
  if (!inAnswer.length) return { answer, blocked: [] };
  const knownNums = new Set();
  for (const f of [...sources.flatMap((s) => [...figures(s.text)]), ...figures(productText), ...extra.filter((x) => Number(x) > 0).map((x) => '£' + Number(x))]) if (/^[£$€]/.test(f)) knownNums.add(Number(f.slice(1)));
  // menus and price lists often print amounts without the currency sign ("Lamb Samosas 8.20"): two decimals count
  for (const s of sources) for (const m of String(s.text || '').matchAll(/(?<![\d.,£$€])(\d{1,4}\.\d{2})(?![\d.%])/g)) knownNums.add(Number(m[1]));
  const ok = (n) => {
    const r = (x) => Math.round(x * 100) / 100;
    for (const k of knownNums) {
      if (r(k) === r(n)) return true;
      for (let q = 2; q <= 20; q++) if (r(k * q) === r(n)) return true;
      for (const j of knownNums) if (r(k + j) === r(n)) return true;
    }
    return false;
  };
  const blocked = inAnswer.filter((f) => !ok(Number(f.slice(1))));
  if (!blocked.length) return { answer, blocked: [] };
  const bad = new Set(blocked);
  const kept = String(answer).split(/(?<=[.!?])\s+|\n+/).filter((s) => /^\s*\[CHOICES:/i.test(s) || !money(figures(s.replace(CHOICES, ' '))).some((f) => bad.has(f)));
  const note = "I don't have a confirmed price for that, so I won't guess – the team can confirm it for you.";
  return { answer: [...kept.filter((s) => s.trim()), note].join(' ').trim(), blocked };
}

export function recordAnswer(tenantId, { waId, question, answer, sources = [], productText = '', model = null, latencyMs = null, blocked = [] }) {
  if (!answer) return null;
  const c = checkAnswer(answer, sources, { productText });
  if (blocked.length) { c.flags.push('price_blocked'); c.confidence = 'low'; }
  const id = Number(getDb().prepare('INSERT INTO answer_evidence (tenant_id, wa_id, question, answer, sources, flags, unsupported, confidence, model, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    tenantId, waId || null, String(question || '').slice(0, 1000), String(answer).slice(0, 4000), JSON.stringify(c.sources.slice(0, 6)), JSON.stringify(c.flags), JSON.stringify(c.unsupported), c.confidence, model, latencyMs).lastInsertRowid);
  return { id, ...c };
}

export function listAnswers(tenantId, { flagged = false, limit = 50 } = {}) {
  return getDb().prepare(`SELECT * FROM answer_evidence WHERE tenant_id = ? ${flagged ? "AND flags != '[]'" : ''} ORDER BY id DESC LIMIT ?`).all(tenantId, Math.min(200, Number(limit) || 50))
    .map((r) => ({ id: r.id, waId: r.wa_id, question: r.question, answer: r.answer, sources: json(r.sources, []), flags: json(r.flags, []), unsupported: json(r.unsupported, []), confidence: r.confidence, model: r.model, latencyMs: r.latency_ms, at: r.created_at.replace(' ', 'T') + 'Z' }));
}

export function answerStats(tenantId) {
  const r = getDb().prepare("SELECT COUNT(*) AS n, SUM(flags LIKE '%unsupported_figures%') AS figs, SUM(flags LIKE '%no_source%') AS nos, SUM(flags LIKE '%stale_source%') AS stale FROM answer_evidence WHERE tenant_id = ? AND created_at > datetime('now', '-30 days')").get(tenantId);
  return { answers: Number(r.n || 0), unsupportedFigures: Number(r.figs || 0), noSource: Number(r.nos || 0), staleSource: Number(r.stale || 0) };
}

export const purgeAnswers = () => Number(getDb().prepare("DELETE FROM answer_evidence WHERE created_at < datetime('now', '-90 days')").run().changes);
