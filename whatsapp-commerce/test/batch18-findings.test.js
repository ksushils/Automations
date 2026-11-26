import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, say } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { getDb } = await import('../src/db.js');
const { addTextDoc, htmlToText, decodeCfEmail, importUrl, detectWebsite } = await import('../src/knowledge.js');
const { shortLabel, extractChoices } = await import('../src/bot/engine.js');
const { figures, guardTimes } = await import('../src/verified.js');
const { buildSettings, menuLabel } = await import('../src/autoSetup.js');
const rag = await import('../src/ai/rag.js');
const { buildPrompt } = await import('../src/dify/provision.js');

/*
 * Fixes from the second round of testing on 15 UK small-business websites (26 Nov 2026): invented opening hours and
 * durations, missed phone numbers and hours, Cloudflare-hidden emails, business names, duplicate / not-found pages,
 * menu labels cut mid-word and buttons that make no sense.
 */

/** The AI answers each question with the next of `answers`; other web addresses get `pages[url]`. */
async function withNet({ answers = [], pages = {} }, fn) {
  const prev = { fetch: globalThis.fetch, base: config.aiBaseUrl, key: config.aiApiKey, emb: config.embeddingsModel, auto: config.embeddingsAuto, priv: config.allowPrivateFetch };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '', embeddingsAuto: false, allowPrivateFetch: true });
  const queue = [...answers];
  globalThis.fetch = async (url, o) => {
    const u = String(url);
    if (u.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: queue.shift() ?? 'OK' } }], usage: { total_tokens: 10 } }));
    if (u.startsWith('http://127.0.0.1')) return prev.fetch(url, o);
    if (u in pages) return new Response(pages[u], { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
  };
  try { return await fn(); } finally { globalThis.fetch = prev.fetch; Object.assign(config, { aiBaseUrl: prev.base, aiApiKey: prev.key, embeddingsModel: prev.emb, embeddingsAuto: prev.auto, allowPrivateFetch: prev.priv }); }
}

test('figures: 24-hour ranges, "1:00 pm", "9.30am", noon and duration ranges are read once and correctly', () => {
  assert.deepEqual([...figures('Open 0800 – 1830 weekdays')], ['8:00', '18:30']);
  assert.deepEqual([...figures('Closes at 1:00 pm on Saturday')], ['13:00'], 'no stray "1:00"');
  assert.deepEqual([...figures('Mon–Fri 9.30am - 5.30pm, Sat until 12 noon')].sort(), ['12:00', '17:30', '9:30']);
  assert.deepEqual([...figures('Lamb Samosas 8.20, Onion Bhaji 3.50')], [], 'menu prices are not times');
  assert.deepEqual([...figures('Tours last 2 or 3 hours')].sort(), ['2 hour', '3 hour']);
});

test('time guard: invented opening hours and durations are removed; real ones are kept', () => {
  const src = [{ text: 'Opening hours: Mon–Fri 0800 – 1830. Tours last 2 or 3 hours.' }];
  const real = guardTimes('We are open 8am to 6:30pm on weekdays.', src);
  assert.deepEqual(real.blocked, []);
  const fake = guardTimes('We are open Mon–Sat 9am–5pm and Sun 10am–4pm. Call us on 01234 567890!\n[CHOICES: Call me back | Email me]', src);
  assert.deepEqual(fake.blocked.sort(), ['10:00', '16:00', '17:00', '9:00']);
  assert.doesNotMatch(fake.answer, /9am|5pm/);
  assert.match(fake.answer, /01234 567890/, 'the rest of the answer stays');
  assert.match(fake.answer, /can't see exact times/);
  assert.match(fake.answer, /\n\[CHOICES: Call me back \| Email me\]$/, 'buttons stay last');
  assert.deepEqual(guardTimes('Tours take 2 to 4 hours.', src).blocked, ['4 hour']);
  assert.deepEqual(guardTimes('A haircut takes 30–45 minutes.', [{ text: 'Haircut £15' }]).blocked.sort(), ['30 minute', '45 minute']);
  assert.deepEqual(guardTimes('Sure, 2 hours works.', [], { customerText: 'can I book for 2 hours?' }).blocked, [], "the customer's own words may be repeated");
  assert.deepEqual(guardTimes('We open at 9am.', [], { extra: 'Shop facts: open 9am–5pm' }).blocked, [], 'the shop facts count');
});

test('the assistant never sends invented opening hours (end to end)', () => withNet({ answers: ["We're open Monday to Saturday, 9am to 5pm, and Sunday 10am to 4pm."] }, async () => {
  const t = makeTenant({ store: { type: 'none' }, ai: { provider: 'direct' } });
  addTextDoc(t.id, { name: 'Flowers', text: 'Order by 2pm for same-day delivery (1pm on Saturdays). Bouquets from £35.' });
  const out = await say(t, '447700900801', 'What are your opening hours?');
  const all = out.map((m) => m.text || '').join(' ');
  assert.doesNotMatch(all, /9am|5pm|10am|4pm/);
  assert.match(all, /can't see exact times/);
  const ev = getDb().prepare('SELECT flags FROM answer_evidence WHERE tenant_id = ? ORDER BY id DESC').get(t.id);
  assert.match(ev.flags, /time_blocked/);
}));

test('hours and contact questions always get the lines with the phone, email and opening times', () => {
  const t = makeTenant({ store: { type: 'none' } });
  addTextDoc(t.id, { name: 'Boiler servicing in Stourbridge', text: `${'We service and repair all makes of boiler across Stourbridge and the West Midlands. '.repeat(30)}\nCall 07961 169 681 for a free quote.` });
  addTextDoc(t.id, { name: '2 weeks free offer', text: `${'Join today and get two weeks free at our friendly gym with classes for all. '.repeat(20)}\nStaffed hours: Mon–Fri 6am–10pm, weekends 9am–12pm.` });
  const p = rag.contactPassage(t.id);
  assert.match(p.text, /07961 169 681/);
  assert.match(p.text, /Mon–Fri 6am–10pm/);
  assert.doesNotMatch(p.text, /two weeks free at our friendly/);
  return rag.retrieve(t.id, 'What are your opening hours?', { k: 4 }).then((hits) => {
    assert.ok(hits.some((h) => /Mon–Fri 6am–10pm/.test(h.text)));
  });
});

test('pages: Cloudflare-hidden emails are revealed, and the footer note no longer claims to hold opening hours', () => {
  // "hello@flossy.co.uk" XOR 0x42
  const hex = '42' + [...'hello@flossy.co.uk'].map((c) => (c.charCodeAt(0) ^ 0x42).toString(16).padStart(2, '0')).join('');
  assert.equal(decodeCfEmail(hex), 'hello@flossy.co.uk');
  const { text } = htmlToText(`<body><p>Email us: <a href="/cdn-cgi/l/email-protection#${hex}"><span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span></a></p><footer><p>Call 01234 567890</p></footer></body>`);
  assert.match(text, /hello@flossy\.co\.uk/);
  assert.doesNotMatch(text, /email.protected/);
  assert.match(text, /From the website footer:\n01234 567890|From the website footer:\nCall 01234 567890/);
  assert.doesNotMatch(text, /opening hours and contact/);
});

test('business names: an apostrophe in og:site_name and a double-encoded title', () => withNet({ pages: {
  'http://noah.test/': '<html><head><meta property="og:site_name" content="Noah\'s Barber"><title>Home</title></head><body>Cuts</body></html>',
  'http://parkes.test/': '<html><head><title>Heating &amp;amp; Plumbing Stourbridge | M.A. Parkes</title></head><body>Boilers</body></html>',
} }, async () => {
  assert.equal((await detectWebsite('http://noah.test')).name, "Noah's Barber");
  assert.equal((await detectWebsite('http://parkes.test')).name, 'Heating & Plumbing Stourbridge');
}));

test('pages: a "page not found" page and a copy of a page already read are not learned', () => {
  const home = `<html><head><title>Heather Bank B&amp;B</title></head><body><p>${'Rooms with views over the dales, breakfast included. '.repeat(10)}</p></body></html>`;
  return withNet({ pages: {
    'http://bnb.test/': home,
    'http://bnb.test/rooms': home,
    'http://bnb.test/old': '<html><head><title>Page not found – Heather Bank</title></head><body><p>Sorry, the page you are looking for does not exist. Try the menu above to find your way.</p></body></html>',
  } }, async () => {
    const t = makeTenant({ store: { type: 'none' } });
    await importUrl(t.id, 'http://bnb.test/');
    await assert.rejects(importUrl(t.id, 'http://bnb.test/rooms'), /Same text/);
    await assert.rejects(importUrl(t.id, 'http://bnb.test/old'), /not found/);
    await importUrl(t.id, 'http://bnb.test/'); // re-reading the same page still works
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM knowledge_docs WHERE tenant_id = ? AND status != 'deleted'").get(t.id).n, 1);
  });
});

test('menu labels fit 24 characters without cutting a word, and short button labels cut at a word', () => {
  assert.equal(menuLabel('💇‍♀️ Book an Appointment'), '💇 Book an Appointment');
  assert.equal(menuLabel('🏠 Residential Conveyancing'), '🏠 Residential…');
  assert.equal(menuLabel('🏢 Commercial Conveyancing'), '🏢 Commercial…');
  assert.equal(shortLabel('Booking a consultation'), 'Booking a…');
  const s = buildSettings({ plan: { options: [{ label: '💇‍♀️ Book an Appointment', action: 'ask', question: 'How do I book?' }, { label: '🏠 Residential Conveyancing', action: 'ask', question: 'Do you do conveyancing?' }, { label: '💷 Prices', action: 'ask', question: 'How much?' }] }, pages: [{ name: 'Home', url: 'http://x.test/', path: '/' }], shop: false, bookings: false });
  for (const o of s.welcomeMenu.options) assert.ok(o.label.length <= 24, o.label);
  assert.ok(s.welcomeMenu.options.every((o) => !/\p{L}…$/u.test(o.label) || /\s\S+…$/u.test(o.label)));
});

test('buttons that make no sense are dropped; real ones stay', () => {
  assert.deepEqual(extractChoices('Our hours vary.\n[CHOICES: Yes | Monday | Saturday]').choices, []);
  assert.deepEqual(extractChoices('Get in touch.\n[CHOICES: Type | Range | Yes]').choices, []);
  assert.deepEqual(extractChoices('What do you mean?\n[CHOICES: Booking | Service | Other]').choices, []);
  assert.deepEqual(extractChoices('Shall I?\n[CHOICES: Yes, please | No, thanks]').choices, ['Yes, please', 'No, thanks']);
  assert.deepEqual(extractChoices('Which day?\n[CHOICES: Monday | Tuesday | Saturday]').choices, ['Monday', 'Tuesday', 'Saturday']);
  assert.deepEqual(extractChoices('Want a call?\n[CHOICES: Yes please | Call me back]').choices, ['Yes please', 'Call me back']);
});

test('the prompt rules: no made-up hours or durations, ranges per item, unclear follow-ups get a question', () => {
  const p = buildPrompt(makeTenant({ store: { type: 'none' } }));
  assert.match(p, /Never fill in "usual" hours or durations/);
  assert.match(p, /Never merge them into one overall range/);
  assert.match(p, /ask what they mean in one short question/);
});
