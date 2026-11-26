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
  for (const m of t.matchAll(/(?<![\d.,:])(\d+(?:\.\d+)?)\s?(?:(?:working|business|calendar|clear|full)\s)?(%|percent|pounds?|gbp|minutes?|mins?|hours?|hrs?|h|days?|weeks?|months?|years?|miles?|km)(?![\p{L}\d])/giu)) out.add(`${Number(m[1])} ${m[2].toLowerCase().replace(/s$/, '').replace(/^mins?$/, 'minute').replace(/^(hrs?|h)$/, 'hour').replace(/^percent$/, '%').replace(/^pounds?$|^gbp$/, '£')}`);
  // the first number of a range shares the unit: "2 or 3 hours" → 2 hour and 3 hour
  for (const m of t.matchAll(/(?<![\d.,:])(\d+(?:\.\d+)?)\s*(?:-|–|—|to|or)\s*\d+(?:\.\d+)?\s?(?:(?:working|business|calendar|clear|full)\s)?(minutes?|mins?|hours?|hrs?|h|days?|weeks?)(?![\p{L}\d])/giu)) out.add(`${Number(m[1])} ${m[2].toLowerCase().replace(/s$/, '').replace(/^mins?$/, 'minute').replace(/^(hrs?|h)$/, 'hour')}`);
  // clock times: "9am", "9.30am", "5:30 pm", "12 noon", "17:30", and 24-hour ranges written "0800 – 1830"
  for (const m of t.matchAll(/(?<![\d.:£$€])(\d{1,2})(?:[:.](\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)(?![\p{L}])/giu)) out.add(`${(Number(m[1]) % 12) + (/^p/i.test(m[3]) ? 12 : 0)}:${m[2] || '00'}`);
  if (/\b(noon|midday)\b/i.test(t)) out.add('12:00');
  for (const m of t.matchAll(/(?<![\d.:£$€])([01]?\d|2[0-3])([:.])([0-5]\d)(?!\d|\.\d|\s?(?:am|pm|a\.m|p\.m))/gi)) {
    // "17:30" is always a time; "9.30" only inside a range ("9.30 – 5.30"), so prices like "8.20" aren't read as times
    const before = t.slice(Math.max(0, m.index - 4), m.index), after = t.slice(m.index + m[0].length, m.index + m[0].length + 5);
    if (m[2] === ':' || /[-–—]\s*$|\bto\s+$/i.test(before) || /^\s*(?:[-–—]|to\b)/i.test(after)) out.add(`${Number(m[1])}:${m[3]}`);
  }
  for (const m of t.matchAll(/\b([01]\d|2[0-3])([0-5]\d)\s*(?:-|–|—|to)\s*([01]\d|2[0-3])([0-5]\d)\b/g)) { out.add(`${Number(m[1])}:${m[2]}`); out.add(`${Number(m[3])}:${m[4]}`); }
  // "45 pounds" ≡ "£45"
  for (const f of [...out]) { const p = /^(\d+(?:\.\d+)?) £$/.exec(f); if (p) out.add('£' + Number(p[1])); }
  return out;
}

/** Score sources against an answer; find figures the sources don't contain. Pure – tested directly. */
/** "£6.20 or 6.85" / "£10 – 15": the second number is a price too. */
const pricedPairs = (t) => String(t || '').replace(/£\s?(\d[\d,]*(?:\.\d{2})?)(\s*(?:or|to|and|-|–|\/)\s*)(\d[\d,]*(?:\.\d{2})?)\b(?!\s*%)/g, '£$1$2£$3');
/** "I can't see that… shall I check with the team?" and "Could you tell me which…?" are honest, not weakly supported. */
const NOT_A_CLAIM = /\b(can'?t|cannot|couldn'?t|don'?t) (see|find)\b|\bcheck with (the|our) team\b|^\s*(could|can|would) you (please )?(clarify|tell|let me know|specify|share)\b/i;

export function checkAnswer(answer, sources, { productText = '', customerText = '', now = Date.now() } = {}) {
  sources = sources.map((s) => ({ ...s, text: pricedPairs(s.text) }));
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
  // figures the customer typed ("a 50% discount?") aren't the assistant's claims
  const known = new Set([...sources.flatMap((s) => [...figures(s.text)]), ...figures(productText), ...figures(customerText)]);
  const unsupported = [...af].filter((f) => !known.has(f));
  const used = scored.filter((s) => s.support >= 0.2);
  const flags = [];
  if (!sources.length) flags.push('no_source');
  else if (!used.length && !NOT_A_CLAIM.test(String(answer))) flags.push('weak_support');
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

/**
 * Time guard: clock times ("open 9am–5pm") and durations ("takes 30–45 minutes", "about 1 hour") in an AI answer must
 * come from the business's information. Small models fill in "usual" opening hours and appointment lengths when the
 * pages don't give them; a customer acts on those. Any sentence with a time or duration the sources don't contain is
 * removed, and the customer is offered a check with the team instead. `extra` is further known text (the shop facts
 * in the prompt, earlier replies in this chat).
 */
export function guardTimes(answer, sources = [], { extra = '', customerText = '' } = {}) {
  const CHOICES = /\[CHOICES:[^\]]*\]/gi;
  const timeLike = (set) => [...set].filter((f) => /^\d{1,2}:\d{2}$/.test(f) || / (minute|hour|day|week)$/.test(f));
  const said = new Set(timeLike(figures(customerText)));
  const inAnswer = timeLike(figures(String(answer).replace(CHOICES, ' '))).filter((f) => !said.has(f));
  if (!inAnswer.length) return { answer, blocked: [] };
  const known = new Set([...sources.flatMap((s) => [...figures(s.text)]), ...figures(extra)]);
  const blocked = inAnswer.filter((f) => !known.has(f));
  if (!blocked.length) return { answer, blocked: [] };
  const bad = new Set(blocked);
  const kept = String(answer).split(/(?<=[.!?])\s+|\n+/).filter((s) => /^\s*\[CHOICES:/i.test(s) || !timeLike(figures(s.replace(CHOICES, ' '))).some((f) => bad.has(f)));
  const note = "I can't see exact times for that in our information, so I won't guess – the team can confirm them for you.";
  const body = kept.filter((s) => s.trim() && !/^\s*\[CHOICES:/i.test(s));
  const choices = kept.filter((s) => /^\s*\[CHOICES:/i.test(s));
  // the note goes before a closing question ("…the team can confirm them. Shall I ask them?"), not after it
  let q = body.length;
  while (q > 0 && !/\p{L}/u.test(body[q - 1])) q--; // a trailing "😊" on its own
  if (q > 0 && /\?\s*$/.test(body[q - 1])) body.splice(q - 1, 0, note); else body.push(note);
  return { answer: [...body, ...choices].join(' ').replace(/\s+\[CHOICES:/, '\n[CHOICES:').trim(), blocked };
}

/**
 * "EV chargers from £704.50" when the site says "from £704.50+vat": a price that the sources only ever give with
 * "+VAT" / "plus VAT" / "ex VAT" right after it gets " + VAT" back in the answer.
 */
export function keepVat(answer, sources = []) {
  const src = sources.map((s) => s.text).join('\n');
  const added = [];
  const out = String(answer).replace(/£\s?\d[\d,]*(?:\.\d{2})?(?!\d|[.,]\d)/g, (price, at, whole) => {
    const after = whole.slice(at + price.length, at + price.length + 16);
    if (/^\s*\*?\s*(\+\s?vat|plus vat|ex\.? vat|excl\.?(uding)? vat|\(?ex vat)/i.test(after)) return price;
    const num = price.replace(/[£\s,]/g, '');
    const re = new RegExp(String.raw`£\s?${num.replace('.', String.raw`\.`)}(?![\d.])([^\n]{0,4})`, 'gi');
    const uses = [...src.matchAll(re)];
    if (!uses.length || !uses.every((m) => /^\s*(\+\s?vat|plus vat|ex\.? vat)/i.test(m[1] + src.slice(m.index + m[0].length, m.index + m[0].length + 10)))) return price;
    added.push(price);
    return `${price} + VAT`;
  });
  return { answer: added.length ? out : answer, added };
}

/**
 * "We're based in Ipswich, Suffolk" when the site only says "Suffolk, UK": a place name after "based / located in"
 * that appears nowhere in the sources (or the shop facts, or the customer's message) is removed from the answer.
 */
export function guardPlaces(answer, sources = [], { extra = '', customerText = '' } = {}) {
  const known = `${sources.map((s) => s.text).join('\n')}\n${extra}\n${customerText}`.toLowerCase();
  const blocked = [];
  const out = String(answer).replace(/\b(based|located|situated|found)( just)? (in|at|near|outside) ((?:[A-Z][\w'’-]+(?: (?:upon|on|in|under|le|de|the) [A-Z][\w'’-]+)*(?: [A-Z][\w'’-]+)*,? ?)+)/g, (m, verb, just, prep, places) => {
    const parts = places.split(/,\s*/).map((p) => p.trim()).filter(Boolean);
    const keep = parts.filter((p) => {
      const ok = known.includes(p.toLowerCase().replace(/[’]/g, "'")) || known.includes(p.toLowerCase());
      if (!ok) blocked.push(p);
      return ok;
    });
    if (keep.length === parts.length) return m;
    if (!keep.length) return '\u0000';
    return `${verb}${just || ''} ${prep} ${keep.join(', ')}${/,\s*$/.test(places) ? ', ' : / $/.test(places) ? ' ' : ''}`;
  });
  if (!blocked.length) return { answer, blocked };
  if (!out.includes('\u0000')) return { answer: out, blocked };
  // nothing left of the place: drop that sentence and say so
  const CH = /^\s*\[CHOICES:/i;
  const parts = out.split(/(?<=[.!?])\s+|\n+/);
  const body = parts.filter((s) => s.trim() && !CH.test(s) && !s.includes('\u0000'));
  const choices = parts.filter((s) => CH.test(s));
  return { answer: [...body, "I can't see our exact location in our information – the team can confirm it for you.", ...choices].join(' ').replace(/\s+\[CHOICES:/, '\n[CHOICES:').trim(), blocked };
}

export function recordAnswer(tenantId, { waId, question, answer, sources = [], productText = '', model = null, latencyMs = null, blocked = [], timeBlocked = [], placeBlocked = [] }) {
  if (!answer) return null;
  const c = checkAnswer(answer, sources, { productText, customerText: question });
  if (blocked.length) { c.flags.push('price_blocked'); c.confidence = 'low'; }
  if (timeBlocked.length) { c.flags.push('time_blocked'); c.confidence = 'low'; }
  if (placeBlocked.length) { c.flags.push('place_blocked'); c.confidence = 'low'; }
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
