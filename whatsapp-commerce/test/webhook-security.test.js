import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const { makeTenant, tenants } = await import('./helpers.js');
const { getDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { createApp } = await import('../src/server.js');

/*
 * P0 acceptance tests for WhatsApp webhook authentication (24 Nov 2026). Real HTTP requests against the app, no
 * WhatsApp credentials: Meta's Graph API is answered locally and every other outside call fails the test.
 * An unverified webhook must never store a message, create a customer/lead/order, or trigger a reply.
 */
const SECRET_A = 'a'.repeat(32), SECRET_B = 'b'.repeat(32), PLATFORM = 'p'.repeat(32);
const sign = (raw, secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const payload = (pnid, from, text, id = `wamid.${crypto.randomBytes(6).toString('hex')}`) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA-X', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pnid }, contacts: [{ wa_id: from, profile: { name: 'Test Person' } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const counts = (tid) => {
  const d = getDb();
  const n = (q) => d.prepare(q).get(tid).n;
  return { messages: n('SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ?'), customers: n('SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?'), leads: n('SELECT COUNT(*) AS n FROM chat_leads WHERE tenant_id = ?'), orders: n('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ?'), bookings: n('SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ?') };
};
const NOTHING = { messages: 0, customers: 0, leads: 0, orders: 0, bookings: 0 };
const settle = () => new Promise((r) => setTimeout(r, 150));

async function harness(fn) {
  const prevFetch = globalThis.fetch;
  const prevCfg = { secret: config.metaAppSecret, token: config.metaWebhookVerifyToken, ai: config.aiApiKey };
  const sent = [];
  const warns = [];
  const prevWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  globalThis.fetch = async (url, o) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return prevFetch(url, o);
    if (u.startsWith('https://graph.facebook.com')) { if (o?.method === 'POST') sent.push(JSON.parse(o.body)); return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' + sent.length }], success: true }), { status: 200 }); }
    throw new Error(`unexpected network call: ${u}`);
  };
  config.aiApiKey = ''; // replies come from the menu engine, not the AI
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}/webhooks/whatsapp`;
  const post = (path, raw, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw });
  try { await fn({ post, base, sent, warns }); } finally {
    server.close(); globalThis.fetch = prevFetch; console.warn = prevWarn;
    Object.assign(config, { metaAppSecret: prevCfg.secret, metaWebhookVerifyToken: prevCfg.token, aiApiKey: prevCfg.ai });
  }
}
const tenantWith = (wa = {}) => tenants.getTenant(makeTenant({ whatsapp: { accessToken: 'EAAG-test', ...wa } }).id);

test('THE VULNERABILITY: a business with no app secret (and no platform secret) refuses unsigned and signed POSTs – nothing stored, nothing sent', () => harness(async ({ post, sent, warns }) => {
  config.metaAppSecret = '';
  const t = tenantWith({ phoneNumberId: 'PN-NOSECRET' });
  const raw = JSON.stringify(payload('PN-NOSECRET', '447700900501', 'I want to order 5 tees, my address is 1 Fake St'));
  assert.equal((await post(`/${t.id}`, raw)).status, 403, 'unsigned');
  assert.equal((await post(`/${t.id}`, raw, { 'X-Hub-Signature-256': sign(raw, 'any-guess-at-a-secret') })).status, 403, 'signed with a guess');
  await settle();
  assert.deepEqual(counts(t.id), NOTHING);
  assert.equal(sent.length, 0);
  assert.ok(warns.some((w) => /rejected POST business=.* reason=no_app_secret/.test(w)));
  assert.ok(!warns.join('\n').includes('Fake St'), 'message content never logged');
}));

test('valid signature with the business\'s own secret: processed once, reply sent; a duplicate delivery is ignored', () => harness(async ({ post, sent }) => {
  const t = tenantWith({ phoneNumberId: 'PN-A', appSecret: SECRET_A });
  const raw = JSON.stringify(payload('PN-A', '447700900502', 'hi', 'wamid.dup-1'));
  const r1 = await post(`/${t.id}`, raw, { 'X-Hub-Signature-256': sign(raw, SECRET_A) });
  assert.equal(r1.status, 200);
  await settle();
  const after1 = counts(t.id);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'in'").get(t.id).n, 1);
  assert.equal(after1.customers, 1);
  const replies = sent.length;
  assert.ok(replies >= 1, 'the assistant replied');
  // Meta retries the same event
  assert.equal((await post(`/${t.id}`, raw, { 'X-Hub-Signature-256': sign(raw, SECRET_A) })).status, 200);
  await settle();
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'in'").get(t.id).n, 1, 'stored once');
  assert.equal(sent.length, replies, 'no second reply');
}));

test('invalid, missing, malformed and wrong-business signatures are refused with nothing stored', () => harness(async ({ post, sent }) => {
  const a = tenantWith({ phoneNumberId: 'PN-A2', appSecret: SECRET_A });
  tenantWith({ phoneNumberId: 'PN-B2', appSecret: SECRET_B });
  const raw = JSON.stringify(payload('PN-A2', '447700900503', 'hi'));
  for (const [h, why] of [[undefined, 'missing'], ['', 'empty'], ['sha256=abc', 'malformed'], ['sha1=' + 'a'.repeat(40), 'wrong algorithm'], [sign(raw, SECRET_B), "another business's secret"], [sign(raw + ' ', SECRET_A), 'signature of a different body'], [sign(raw, SECRET_A).toUpperCase().replace('SHA256=', 'sha256=').slice(0, -1) + '0', 'one character changed']]) {
    const r = await post(`/${a.id}`, raw, h === undefined ? {} : { 'X-Hub-Signature-256': h });
    assert.equal(r.status, 401, why);
  }
  await settle();
  assert.deepEqual(counts(a.id), NOTHING);
  assert.equal(sent.length, 0);
}));

test('raw body: the exact bytes Meta sent are verified (whitespace matters); non-JSON bodies are refused', () => harness(async ({ post }) => {
  const t = tenantWith({ phoneNumberId: 'PN-RAW', appSecret: SECRET_A });
  const obj = payload('PN-RAW', '447700900504', 'hi');
  const pretty = JSON.stringify(obj, null, 2); // Meta's bytes, with spacing
  assert.equal((await post(`/${t.id}`, pretty, { 'X-Hub-Signature-256': sign(pretty, SECRET_A) })).status, 200);
  const compact = JSON.stringify(obj);
  assert.equal((await post(`/${t.id}`, pretty, { 'X-Hub-Signature-256': sign(compact, SECRET_A) })).status, 401, 'a signature of the re-serialised body is not enough');
  const r = await fetch(`http://127.0.0.1:${0}`, { method: 'HEAD' }).catch(() => null); void r;
  const txt = await post(`/${t.id}`, compact, { 'Content-Type': 'text/plain', 'X-Hub-Signature-256': sign(compact, SECRET_A) });
  assert.equal(txt.status, 400, 'no raw JSON body');
}));

test('platform app secret (Embedded Signup numbers): used when the business has none; the per-business URL only accepts that business\'s own number', () => harness(async ({ post, sent }) => {
  config.metaAppSecret = PLATFORM;
  const a = tenantWith({ phoneNumberId: 'PN-PA' });
  const b = tenantWith({ phoneNumberId: 'PN-PB' });
  const forA = JSON.stringify(payload('PN-PA', '447700900505', 'hi'));
  assert.equal((await post(`/${a.id}`, forA, { 'X-Hub-Signature-256': sign(forA, PLATFORM) })).status, 200);
  await settle();
  assert.equal(counts(a.id).customers, 1);
  // a genuine platform-signed event for B's number replayed into A's URL: acknowledged, but nobody's data changes
  const forB = JSON.stringify(payload('PN-PB', '447700900506', 'hi'));
  const before = sent.length;
  assert.equal((await post(`/${a.id}`, forB, { 'X-Hub-Signature-256': sign(forB, PLATFORM) })).status, 200);
  await settle();
  assert.equal(counts(a.id).customers, 1, 'not added to A');
  assert.deepEqual(counts(b.id), NOTHING, 'and not processed for B either (wrong URL)');
  assert.equal(sent.length, before);
  // the app-level URL routes by number
  const r = await post('', forB, { 'X-Hub-Signature-256': sign(forB, PLATFORM) });
  assert.equal(r.status, 200);
  await settle();
  assert.equal(counts(b.id).customers, 1, 'B via the app-level webhook');
  // app-level without a platform secret: refused
  config.metaAppSecret = '';
  assert.equal((await post('', forB, { 'X-Hub-Signature-256': sign(forB, PLATFORM) })).status, 403);
}));

test('cross-business isolation: an unknown number is skipped; inactive and unknown businesses are refused', () => harness(async ({ post }) => {
  config.metaAppSecret = PLATFORM;
  const t = tenantWith({ phoneNumberId: 'PN-ISO' });
  const raw = JSON.stringify(payload('PN-NOBODY', '447700900507', 'hi'));
  assert.equal((await post('', raw, { 'X-Hub-Signature-256': sign(raw, PLATFORM) })).status, 200);
  await settle();
  assert.deepEqual(counts(t.id), NOTHING);
  getDb().prepare('UPDATE tenants SET active = 0 WHERE id = ?').run(t.id);
  const mine = JSON.stringify(payload('PN-ISO', '447700900508', 'hi'));
  assert.equal((await post(`/${t.id}`, mine, { 'X-Hub-Signature-256': sign(mine, PLATFORM) })).status, 404);
  assert.equal((await post('', mine, { 'X-Hub-Signature-256': sign(mine, PLATFORM) })).status, 200);
  await settle();
  assert.deepEqual(counts(t.id), NOTHING, 'inactive business: nothing processed via the app-level URL either');
  assert.equal((await post('/no-such-business', mine, { 'X-Hub-Signature-256': sign(mine, PLATFORM) })).status, 404);
}));

test('GET is only the verification handshake: needs the configured token, never processes events', () => harness(async ({ base }) => {
  config.metaWebhookVerifyToken = 'platform-verify-token';
  const t = tenantWith({ phoneNumberId: 'PN-GET', appSecret: SECRET_A, verifyToken: 'tenant-verify-token' });
  const g = (path, token) => fetch(`${base}${path}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=12345`);
  assert.equal(await (await g(`/${t.id}`, 'tenant-verify-token')).text(), '12345');
  assert.equal((await g(`/${t.id}`, 'wrong')).status, 403);
  assert.equal(await (await g('', 'platform-verify-token')).text(), '12345');
  const empty = tenantWith({ phoneNumberId: 'PN-GET2', verifyToken: '' });
  assert.equal((await g(`/${empty.id}`, '')).status, 403, 'an empty configured token never matches');
  assert.deepEqual(counts(t.id), NOTHING);
}));
