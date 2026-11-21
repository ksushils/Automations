import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeTenant, tenants, say, ids } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { valueReport, reportText, adReport, runWeeklyDigests } from '../src/insights.js';
import { customerProfile } from '../src/profile.js';
import { encryptPayload, saveSubscription, vapidKeys } from '../src/push.js';
import { quizConfig } from '../src/quiz.js';
import { createQuote, sendQuote, simplePdf, cleanItems, quoteTotal, runQuoteFollowUps } from '../src/quotes.js';
import { tenantReferrals, resolveRef, createPartner, allReferrals } from '../src/referrals.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const admin = (base, path, opts = {}) => fetch(`${base}/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}` }, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
async function withAi(answer, fn) {
  const prevCfg = { ...config };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '' });
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, o) => (String(url).includes('ai.test') ? new Response(JSON.stringify({ choices: [{ message: { content: typeof answer === 'function' ? answer(JSON.parse(o.body)) : answer } }] })) : prev(url, o));
  try { return await fn(); } finally { globalThis.fetch = prev; Object.assign(config, prevCfg); }
}
const msg = (t, wa, text) => getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, ?, 'in', 'text', ?)").run(t, wa, JSON.stringify({ type: 'text', text }));

test('results: leads, bookings, tickets and ratings in the report; "last 7 days"; Monday digest', async () => {
  const t = makeTenant();
  msg(t.id, '447700900001', 'hello');
  getDb().prepare("INSERT INTO chat_leads (tenant_id, wa_id, channel, kind, topic) VALUES (?, '447700900001', 'whatsapp', 'call', 'x')").run(t.id);
  getDb().prepare("INSERT INTO chat_ratings (tenant_id, wa_id, score) VALUES (?, '447700900001', 3)").run(t.id);
  const r = valueReport(t.id, 'week');
  assert.equal(r.month, 'week');
  assert.deepEqual([r.leads.count, r.leads.callbacks, r.ratings.great], [1, 1, 1]);
  assert.match(reportText(r, 'Shop'), /the last 7 days[\s\S]*📇 1 leads/);
  const monday = new Date('2026-11-23T08:00:00Z'); // a Monday
  assert.ok(await runWeeklyDigests(monday) >= 1);
  assert.equal(await runWeeklyDigests(monday), 0, 'once a week');
  assert.equal(await runWeeklyDigests(new Date('2026-11-24T08:00:00Z')), 0, 'Mondays only');
});

test('revenue by advert: Click-to-WhatsApp ads and campaign links, with what they turned into', () => {
  const t = makeTenant();
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id, source) VALUES (?, '447700900010', ?)").run(t.id, JSON.stringify({ source_id: '123', headline: 'Spring sale – 20% off' }));
  msg(t.id, '447700900010', 'I saw your ad');
  getDb().prepare("INSERT INTO orders (tenant_id, wa_id, items, subtotal, status, payment_status) VALUES (?, '447700900010', '[]', 42.5, 'new', 'paid')").run(t.id);
  getDb().prepare("INSERT INTO conversations (tenant_id, wa_id, state_data) VALUES (?, 'web:adwebSessionAAAAAA1234', ?)").run(t.id, JSON.stringify({ utm: { utm_source: 'facebook', utm_campaign: 'xmas' } }));
  msg(t.id, 'web:adwebSessionAAAAAA1234', 'hi');
  getDb().prepare("INSERT INTO chat_leads (tenant_id, wa_id, channel, kind, topic) VALUES (?, 'web:adwebSessionAAAAAA1234', 'web', 'email', 'x')").run(t.id);
  msg(t.id, '447700900011', 'hello'); // no source
  const rows = adReport(t.id, 30);
  const ad = rows.find((r) => r.kind === 'ad');
  assert.deepEqual([ad.label, ad.chats, ad.orders, ad.revenue], ['Spring sale – 20% off', 1, 1, 42.5]);
  const camp = rows.find((r) => r.kind === 'campaign');
  assert.deepEqual([camp.label, camp.leads], ['facebook · xmas', 1]);
  assert.equal(rows.at(-1).kind, 'direct');
});

test('customer profile: everything about one customer, plus private notes and tags', () => withServer(async (base) => {
  const t = makeTenant();
  const wa = '447700900020';
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id, name, email) VALUES (?, ?, 'Priya Shah', 'p@example.test')").run(t.id, wa);
  getDb().prepare("INSERT INTO orders (tenant_id, wa_id, items, subtotal, status, payment_status) VALUES (?, ?, '[]', 30, 'new', 'paid')").run(t.id, wa);
  getDb().prepare("INSERT INTO tickets (tenant_id, number, wa_id, subject, description) VALUES (?, 1001, ?, 'Late order', 'x')").run(t.id, wa);
  const p = customerProfile(t.id, wa);
  assert.deepEqual([p.name, p.phone, p.totals.orders, p.totals.spent, p.tickets[0].number], ['Priya Shah', `+${wa}`, 1, 30, 1001]);
  const r = await admin(base, `/tenants/${t.id}/customers/${wa}/profile`, { method: 'PATCH', body: { notes: 'Prefers morning calls', tags: ['VIP', ' VIP ', 'trade'] } });
  assert.deepEqual([r.body.profile.notes, r.body.profile.tags], ['Prefers morning calls', ['VIP', 'trade']]);
}));

test('phone notifications: Web Push payloads decrypt with the browser\'s keys; only real push services accepted', () => {
  // play the browser: make its keys, then decrypt what we send (RFC 8291)
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const body = encryptPayload('{"title":"New lead"}', { p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) });
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const h = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const ikm = h(h(authSecret, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = h(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce); dec.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  assert.equal(plain.subarray(0, -1).toString(), '{"title":"New lead"}');
  assert.equal(plain.at(-1), 2);
  assert.equal(Buffer.from(vapidKeys().publicKey, 'base64url').length, 65);
  const t = makeTenant();
  assert.throws(() => saveSubscription(t.id, { endpoint: 'http://127.0.0.1/x', keys: { p256dh: 'a', auth: 'b' } }), /not a browser push/);
  assert.ok(saveSubscription(t.id, { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) } }));
});

test('product finder quiz: questions with tap answers, then a recommendation from the answers', () => withAi('For a gift under £25 I\'d suggest our White Mug.', async () => {
  const t = makeTenant({ quiz: { enabled: true, questions: [{ q: 'Who is it for?', options: ['Me', 'A gift'] }, { q: 'Budget?', options: ['Under £25', '£25–£50', '£50+', 'No limit'] }] } });
  assert.equal(quizConfig(tenants.getTenant(t.id)?.settings).questions.length, 2);
  const wa = '447700900030';
  let r = await say(t, wa, { action: 'quiz' });
  assert.deepEqual(ids(r), ['qz:0:0', 'qz:0:1']);
  r = await say(t, wa, { action: 'qz:0:1' });
  assert.equal(r[0].type, 'list', '4 answers → a list');
  r = await say(t, wa, { action: 'qz:1:0' });
  assert.match(JSON.stringify(r), /White Mug/);
}));

test('instant quotes: AI drafts from the price list, never guesses, team sends, customer accepts; PDF; follow-up', () => withAi('{"items":[{"item":"Oak flooring, fitted (per m²)","qty":20,"price":45},{"item":"Skirting boards","qty":1,"price":null}],"notes":"Skirting price to confirm after survey"}', () => withServer(async (base) => {
  const t = makeTenant({ quotes: { enabled: true } });
  const wa = 'web:quoteSessionABCDEFGH12';
  let r = await say(t, wa, { action: 'quote' });
  assert.match(r[0].text, /Happy to quote/);
  r = await say(t, wa, '20 square metres of oak flooring fitted, with skirting');
  assert.match(r[0].text, /email address/);
  r = await say(t, wa, 'jo@example.test');
  assert.match(r[0].text, /quote request \*Q-1001\* is in.*by email/s);
  let q = (await admin(base, `/tenants/${t.id}/quotes/1001`)).body.quote;
  assert.equal(q.status, 'draft');
  assert.equal(q.total, 900);
  assert.equal(q.items[1].price, null, 'unknown price is "to confirm", not guessed');
  assert.equal((await fetch(`${base}/q/${q.token}`)).status, 404, 'drafts are not visible to the customer');
  const s = (await admin(base, `/tenants/${t.id}/quotes/1001/send`, { method: 'POST' })).body;
  assert.equal(s.quote.status, 'sent');
  assert.equal(s.delivered.chat, true);
  const page = await (await fetch(`${base}/q/${q.token}`)).text();
  assert.match(page, /Quote Q-1001/);
  assert.match(page, /to confirm/);
  const pdf = Buffer.from(await (await fetch(`${base}/q/${q.token}.pdf`)).arrayBuffer());
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
  assert.match(pdf.toString('latin1'), /Total: \xa3900\.00/);
  assert.equal((await (await fetch(`${base}/q/${q.token}/accept`, { method: 'POST' })).json()).ok, true);
  q = (await admin(base, `/tenants/${t.id}/quotes/1001`)).body.quote;
  assert.equal(q.status, 'accepted');
  // follow-up only for sent-but-not-accepted quotes after 2 days
  const t2 = makeTenant({ quotes: { enabled: true } });
  const { quote } = await createQuote(tenants.getTenant(t2.id), { waId: '447700900041', request: 'oak floor' });
  await sendQuote(tenants.getTenant(t2.id), quote.number);
  getDb().prepare("UPDATE quotes SET sent_at = datetime('now', '-3 days') WHERE tenant_id = ?").run(t2.id);
  assert.equal(await runQuoteFollowUps(), 1);
  assert.equal(await runQuoteFollowUps(), 0);
  assert.equal(quoteTotal(cleanItems([{ item: 'a', qty: 2, price: 1.5 }, { item: '', qty: 1, price: 9 }])), 3);
  assert.ok(simplePdf(['hello (world)']).toString('latin1').includes('hello \\(world\\)'));
})));

test('referrals: every business has a link; sign-ups are credited; "Powered by" counts; partners', () => withServer(async (base) => {
  const a = makeTenant();
  const ref = tenantReferrals(a.id);
  assert.match(ref.link, /\?ref=[a-z0-9]{7}$/);
  let r = await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ business: 'Referred Shop', email: 'r@example.test', plan: 'free', acceptTerms: true, ref: ref.code }) });
  const nid = (await r.json()).tenantId;
  assert.equal(getDb().prepare('SELECT referred_by FROM tenants WHERE id = ?').get(nid).referred_by, `tenant:${a.id}`);
  getDb().prepare("UPDATE tenants SET plan = 'growth', subscription_status = 'active' WHERE id = ?").run(nid);
  const s = tenantReferrals(a.id);
  assert.deepEqual([s.signups, s.paying, s.monthlyEarnings], [1, 1, Math.round(79 * 0.2 * 100) / 100]);
  assert.equal(resolveRef(`chat-${a.id}`), `tenant:${a.id}`, 'the Powered-by link');
  assert.equal(resolveRef('nope!'), null);
  const p = createPartner({ name: 'Bright Web', email: 'hi@bright.test' });
  assert.equal(p.code, 'BRIGHTWEB');
  assert.equal(resolveRef('brightweb'), 'partner:BRIGHTWEB');
  assert.ok(allReferrals().partners.some((x) => x.code === 'BRIGHTWEB'));
  assert.throws(() => createPartner({ name: 'Bright Web' }), /taken/);
}));
