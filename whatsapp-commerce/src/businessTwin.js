import { getDb } from './db.js';
import { getTenant } from './tenants.js';
import { TRADES } from './trades.js';

/*
 * Business Twin: "here is what your assistant learnt about your business, and where it learnt it".
 * Built by fixed rules from the pages and documents the assistant actually holds – no AI writes these facts, so
 * nothing here can be invented. Each fact is:
 *   found     – one clear value, with the page it came from
 *   uncertain – several different values (e.g. two phone numbers): the owner should say which is right
 *   missing   – not on any page: says what the assistant will do instead (it never guesses)
 * Shown on the instant-demo page and in the dashboard (Knowledge tab). Read-only.
 */
const SENT = /(?<=[.!?])\s+|\n+/;
const clip = (s, n = 160) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const DAY = '(mon|tue|wed|thu|fri|sat|sun)[a-z]*';
const HOURS = new RegExp(`\\b${DAY}\\b[^.\\n]{0,60}?\\b\\d{1,2}([:.]\\d{2})?\\s*(am|pm)?\\s*(-|–|to|until)\\s*\\d{1,2}([:.]\\d{2})?\\s*(am|pm)?`, 'i');
const PHONE = /(?:\+44\s?\(?0?\)?\s?|\b0)\d(?:[\s-]?\d){8,9}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?) ?(\d[A-Z]{2})\b/g;
const MONEY = /£\s?\d[\d,]*(?:\.\d{2})?/;

const normPhone = (p) => { const d = p.replace(/\D/g, ''); return d.startsWith('44') ? '0' + d.slice(2).replace(/^0/, '') : d; };
const fmtPhone = (d) => (d.length === 11 ? (/^0[12]0/.test(d) ? `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}` : `${d.slice(0, 5)} ${d.slice(5)}`) : d);

/** Topics found as sentences on the pages. `ifMissing` = what the assistant does when a customer asks. */
const TOPICS = [
  { key: 'hours', label: 'Opening hours', test: (s) => HOURS.test(s), ifMissing: 'It will say it doesn\'t have your opening hours and offer to pass the question to your team. It won\'t make up times.' },
  { key: 'prices', label: 'Prices', test: (s) => MONEY.test(s), many: 8, ifMissing: 'It will tell customers the team will confirm the price. It never gives a price that isn\'t on your pages.' },
  { key: 'delivery', label: 'Delivery or collection', test: (s) => /\b(deliver(y|ies|ed)?|shipping|postage|collect(ion)?|click and collect)\b/i.test(s), ifMissing: 'It will say the team will confirm delivery details.' },
  { key: 'returns', label: 'Returns, refunds or cancellations', test: (s) => /\b(returns?|refunds?|exchanges?|cancell?ation|cancel)\b/i.test(s), ifMissing: 'It will pass questions about returns, refunds or cancellations to your team.' },
  { key: 'booking', label: 'How to book', test: (s) => /\b(book(ing)?s?|appointments?|reservations?|reserve)\b/i.test(s), ifMissing: 'It will take the customer\'s details so your team can arrange a time.' },
  { key: 'area', label: 'Areas you cover', test: (s) => /\b(we (cover|serve)|areas? (we )?(cover|serve)|covering|serving|based in|located in)\b/i.test(s), ifMissing: 'It will take the customer\'s postcode and say the team will check they cover it.' },
];

function docsOf(tenantId) {
  return getDb().prepare("SELECT id, name, url, text FROM knowledge_docs WHERE tenant_id = ? AND status NOT IN ('deleted', 'to_delete') AND text IS NOT NULL ORDER BY id").all(tenantId);
}

export function buildTwin(tenantOrId) {
  const t = typeof tenantOrId === 'string' ? getTenant(tenantOrId) : tenantOrId;
  if (!t) return null;
  const S = t.settings || {};
  const docs = docsOf(t.id);
  const src = (d) => ({ page: d.name, url: d.url || null });
  const facts = [];

  // business details from the settings (the demo/setup took them from the website's title and description)
  const trade = TRADES[S.trade];
  facts.push({ key: 'name', label: 'Business name', status: S.business?.name ? 'found' : 'missing', values: S.business?.name ? [{ value: S.business.name, source: { page: 'Your settings' } }] : [], ifMissing: 'Add your business name in Settings.' });
  facts.push({ key: 'type', label: 'Type of business', status: trade ? 'found' : 'missing', values: trade ? [{ value: `${trade.emoji || ''} ${trade.label}`.trim(), source: { page: 'Chosen from what your pages say – you can change it' } }] : [], ifMissing: 'A general assistant is used. Pick your business type in AI assistant → Templates for better questions and safety rules.' });

  // contact details: several different values = uncertain (the owner should say which one customers should use)
  const collect = (re, norm, fmt) => {
    const seen = new Map();
    for (const d of docs) for (const m of String(d.text).matchAll(re)) {
      const k = norm(m[0]);
      if (!k || seen.has(k)) continue;
      seen.set(k, { value: fmt(k, m), source: src(d) });
    }
    return [...seen.values()];
  };
  const contact = [
    ['phone', 'Phone number', collect(PHONE, (p) => { const d = normPhone(p); return /^0\d{10}$/.test(d) && !/^0(\d)\1{9}$/.test(d) ? d : null; }, (k) => fmtPhone(k)), 'It will offer to take the customer\'s number so your team can call back.'],
    ['email', 'Email address', collect(EMAIL, (e) => (/\.(png|jpe?g|gif|webp|svg)$/i.test(e) || /example\.|sentry|wixpress|@2x/i.test(e) ? null : e.toLowerCase()), (k) => k), 'It will offer to pass messages to your team instead.'],
    ['postcode', 'Address / postcode', collect(POSTCODE, (p) => p.toUpperCase().replace(/\s+/g, '').replace(/^(.+)(\d[A-Z]{2})$/, '$1 $2'), (k) => k), 'It will say the team will confirm where you are.'],
  ];
  for (const [key, label, values, ifMissing] of contact) {
    facts.push({ key, label, status: !values.length ? 'missing' : values.length === 1 ? 'found' : 'uncertain', values: values.slice(0, 6), more: Math.max(0, values.length - 6), ifMissing, ...(values.length > 1 ? { why: `${values.length} different ${label.toLowerCase()}s found – tell us which one customers should use.` } : {}) });
  }

  // topics: the sentences the assistant will answer from, each with its page
  for (const tp of TOPICS) {
    const hits = [], seen = new Set();
    for (const d of docs) for (const s of String(d.text).split(SENT)) {
      if (s.length < 8 || s.length > 600 || !tp.test(s)) continue;
      const c = clip(s), k = c.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); hits.push({ value: c, source: src(d) });
    }
    const max = tp.many || 3;
    facts.push({ key: tp.key, label: tp.label, status: hits.length ? 'found' : 'missing', values: hits.slice(0, max), more: Math.max(0, hits.length - max), ifMissing: tp.ifMissing });
  }

  const count = (st) => facts.filter((f) => f.status === st).length;
  return {
    generatedAt: new Date().toISOString(),
    pages: docs.map((d) => ({ name: d.name, url: d.url || null, words: String(d.text).split(/\s+/).filter(Boolean).length })),
    facts,
    summary: { found: count('found'), uncertain: count('uncertain'), missing: count('missing'), pages: docs.length },
    note: 'Found by reading your pages with fixed rules (no AI guesses). The assistant only answers from these pages; where something is missing it says so and passes the question to your team.',
  };
}
