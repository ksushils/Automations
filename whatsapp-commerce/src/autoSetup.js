import { createHash } from 'node:crypto';
import { getDb } from './db.js';
import { getTenant, updateTenantSettings } from './tenants.js';
import { chatCompletion, directConfigured } from './ai/direct.js';
import { TRADES, TRADE_KEYS, guessTrade } from './trades.js';
import { learnedQuestions } from './learn.js';

/*
 * AI auto-setup: once the assistant has read a new shop's website, the AI writes the parts we used to set up by hand –
 *   • the welcome menu (4–8 options: their real pages, common questions, booking, a person),
 *   • the pop-up greeting and greetings for their main page types (e.g. "/tours" → "Planning a trip?"),
 *   • the lead question that fits the business (travel: where / when / how many; shop: what are you after…).
 * Safety: links can only be pages we actually read from the site (the AI picks by number, it can't invent URLs);
 * labels are short; "Talk to a person" is always last. It never overwrites what the owner changed: each part is
 * only written when it's empty or still exactly what auto-setup wrote last time (unless forced from the dashboard).
 */
const sig = (v) => createHash('sha1').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12);
const clip = (s, n) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const ACTIONS = new Set(['link', 'ask', 'book', 'browse', 'status', 'human']);

function sitePages(tenantId, origin) {
  let host = '';
  try { host = new URL(origin).host.replace(/^www\./, ''); } catch {}
  const rows = getDb().prepare("SELECT name, url FROM knowledge_docs WHERE tenant_id = ? AND status NOT IN ('deleted', 'to_delete') AND url IS NOT NULL ORDER BY id LIMIT 80").all(tenantId);
  const seen = new Set();
  return rows.filter((r) => {
    try { const u = new URL(r.url); if (host && u.host.replace(/^www\./, '') !== host) return false; const k = u.origin + u.pathname.replace(/\/$/, ''); if (seen.has(k) || /\/(policies|cart|account|search|checkout)\b|privacy|cookie|terms|login|wp-|\.(pdf|xml)$/i.test(u.pathname)) return false; seen.add(k); return true; } catch { return false; }
  }).slice(0, 40).map((r) => ({ name: clip(r.name, 80), url: r.url, path: new URL(r.url).pathname || '/' }));
}

/** Ask the AI for a plan. Returns null if it can't (no AI, nothing read, bad answer). */
export async function draftSetup(tenant) {
  const S = tenant.settings;
  if (!directConfigured()) return null;
  const pages = sitePages(tenant.id, S.business?.website);
  if (pages.length < 2) return null;
  const type = S.store?.type || 'manual';
  const shop = ['shopify', 'shopify_public', 'woocommerce', 'custom'].includes(type) || (type === 'manual' && (S.store?.manual?.products || []).length > 0);
  const bookings = !!S.bookings?.enabled;
  const r = await chatCompletion({
    temperature: 0.2, maxTokens: 900,
    messages: [{ role: 'user', content: `You set up the website chat for a UK small business. Business: "${S.business?.name}". About: ${clip(S.ai?.about, 400) || '(not given)'}.${TRADES[S.trade] ? ` Trade: ${TRADES[S.trade].label}; its customers usually ask: ${[...TRADES[S.trade].questions.slice(0, 6), ...learnedQuestions(S.trade).slice(0, 4)].join(' / ')}` : ''}${shop ? ' It sells products online.' : ' It takes enquiries and bookings (no online shop in the chat).'}${bookings ? ' Customers can book in the chat.' : ''}

Pages we read from its website (number. title – path):
${pages.map((p, i) => `${i + 1}. ${p.name} – ${p.path}`).join('\n')}

Reply with JSON only:
{
 "businessType": one of "shop", "travel", "restaurant", "experiences", "services", "other",
 "trade": the closest of ${TRADE_KEYS.map((k) => `"${k}" (${TRADES[k].label})`).join(', ')}, or null,
 "intro": the question above the menu, max 60 chars (e.g. "What can we help you with today?"),
 "greeting": the pop-up greeting, max 110 chars, friendly, ends with a question, with one emoji at the start,
 "options": 4 to 8 menu options, the most useful first, each {"label": max 22 chars starting with one fitting emoji, "action": "link" | "ask" | "book" | "browse" | "status", "page": page number for "link", "question": a customer question for "ask"},
 "pageGreetings": up to 3 {"page": page number of a main section page, "text": a greeting for visitors on that kind of page, max 100 chars},
 "requirementQuestion": the one question to ask someone who wants the team to contact them, about what matters for THIS business (travel: where, when, how many travelling, budget; experiences: which experience, date, how many; shop: what they're looking for), max 160 chars
}
Rules: use "link" only for pages in the list, by number. Use "ask" for common questions the pages answer (delivery, returns, prices, opening hours). ${shop ? 'Include "browse" and "status" (track my order).' : 'Do not use "browse" or "status".'} ${bookings ? 'Include "book".' : 'Do not use "book".'} Don't add "Talk to a person" (it is added automatically). British English.` }],
  });
  const raw = String(r.choices?.[0]?.message?.content || '').replace(/```(json)?/g, '');
  let j;
  try { j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return null; }
  return { plan: j, pages, shop, bookings };
}

/** Turn the AI's plan into safe settings (or null). Exported for tests. */
export function buildSettings({ plan, pages, shop, bookings }) {
  const pageAt = (n) => pages[Number(n) - 1] || null;
  const labels = new Set();
  const options = [];
  for (const o of Array.isArray(plan?.options) ? plan.options : []) {
    const action = String(o?.action || '');
    const label = clip(o?.label, 24);
    if (!ACTIONS.has(action) || action === 'human' || label.length < 3 || labels.has(label.toLowerCase())) continue;
    if ((action === 'browse' || action === 'status') && !shop) continue;
    if (action === 'book' && !bookings) continue;
    let value = '';
    if (action === 'link') { const p = pageAt(o.page); if (!p) continue; value = p.url; }
    if (action === 'ask') { value = clip(o.question, 200); if (value.length < 5) continue; }
    labels.add(label.toLowerCase());
    options.push({ label, action, ...(value ? { value } : {}) });
    if (options.length >= 8) break;
  }
  if (options.length < 3) return null;
  options.push({ label: '🙋 Talk to a person', action: 'human' });
  const pageGreetings = (Array.isArray(plan?.pageGreetings) ? plan.pageGreetings : []).map((g) => ({ p: pageAt(g?.page), text: clip(g?.text, 110) }))
    .filter((g) => g.p && g.p.path !== '/' && g.text.length >= 8).slice(0, 3)
    .map((g) => ({ match: g.p.path.replace(/\/$/, '').split('/').filter(Boolean)[0] ? `/${g.p.path.split('/').filter(Boolean)[0]}` : g.p.path, text: g.text }))
    .filter((g, i, all) => all.findIndex((x) => x.match === g.match) === i);
  return {
    businessType: ['shop', 'travel', 'restaurant', 'experiences', 'services', 'other'].includes(plan.businessType) ? plan.businessType : 'other',
    welcomeMenu: { enabled: true, intro: clip(plan.intro, 80) || 'What can we help you with today?', options },
    greeting: clip(plan.greeting, 140) || null,
    pageGreetings,
    requirementQuestion: clip(plan.requirementQuestion, 200) || null,
    trade: TRADES[plan.trade] ? plan.trade : null,
  };
}

/** Run auto-setup for a shop. { force } rewrites parts the owner has since changed. Returns what was applied. */
export async function autoSetup(tenantId, { force = false } = {}) {
  const t = getTenant(tenantId);
  if (!t) return null;
  const S = t.settings;
  const before = S.autoSetup || {};
  const draft = await draftSetup(t).catch((e) => { console.warn('[auto-setup]', e.message); return null; });
  const out = draft && buildSettings(draft);
  if (!out) return { applied: [], reason: draft ? 'the AI answer could not be used' : 'nothing to work from yet (no AI, or fewer than 2 pages read)' };
  // write a part only if it's empty, or untouched since we last wrote it (or forced)
  const mine = (key, current) => force || current == null || current === '' || (Array.isArray(current) && !current.length) || before.sigs?.[key] === sig(current);
  const patch = {}, applied = [], sigs = { ...(before.sigs || {}) };
  if (mine('welcomeMenu', S.welcomeMenu?.options?.length ? S.welcomeMenu : null)) { patch.welcomeMenu = out.welcomeMenu; sigs.welcomeMenu = sig(out.welcomeMenu); applied.push('welcome menu'); }
  const O = S.webchat?.opener || {};
  if (out.greeting && mine('greeting', O.text || null)) { patch.webchat = { opener: { text: out.greeting } }; sigs.greeting = sig(out.greeting); applied.push('pop-up greeting'); }
  if (out.pageGreetings.length && mine('pageGreetings', O.pages?.length ? O.pages : null)) { patch.webchat = { opener: { ...(patch.webchat?.opener || {}), pages: out.pageGreetings } }; sigs.pageGreetings = sig(out.pageGreetings); applied.push('page greetings'); }
  if (out.requirementQuestion && mine('requirementQuestion', S.leads?.requirementPrompt || null)) { patch.leads = { requirementPrompt: out.requirementQuestion }; sigs.requirementQuestion = sig(out.requirementQuestion); applied.push('lead question'); }
  patch.autoSetup = { at: new Date().toISOString(), businessType: out.businessType, applied, sigs };
  updateTenantSettings(tenantId, patch); // lists (menu options, page greetings) are replaced wholesale by the merge
  // no trade chosen yet: add the trade's AI rules and questions (the menu and greetings the AI just wrote are kept)
  const trade = !S.trade && (out.trade || guessTrade(`${S.business?.name} ${S.ai?.about || ''}`));
  if (trade) { updateTenantSettings(tenantId, { trade, ai: { tradeRules: TRADES[trade].instructions }, quality: { tradeQuestions: TRADES[trade].questions } }); }
  return { applied, businessType: out.businessType, trade: trade || S.trade || null, menu: out.welcomeMenu.options.map((o) => o.label) };
}
