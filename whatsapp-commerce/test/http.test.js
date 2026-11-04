import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeTenant, tenants } from './helpers.js';
import { createApp } from '../src/server.js';
import { getDb } from '../src/db.js';
import { getConversation } from '../src/bot/state.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('super admin creates tenant, tenant key works, other keys rejected', () => withServer(async (base) => {
  const h = (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' });
  let r = await fetch(base + '/api/tenants', { method: 'POST', headers: h('super-admin-test-key'), body: JSON.stringify({ name: 'Acme Ltd', plan: 'growth' }) });
  assert.equal(r.status, 201);
  const { tenant, adminKey } = await r.json();
  r = await fetch(`${base}/api/tenants/${tenant.id}`, { headers: h(adminKey) });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/api/tenants`, { headers: h(adminKey) });
  assert.equal(r.status, 401);
  r = await fetch(`${base}/api/tenants/${tenant.id}`, { headers: h('nope') });
  assert.equal(r.status, 401);

  // secrets are stored encrypted and returned redacted
  r = await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: h(adminKey), body: JSON.stringify({ whatsapp: { accessToken: 'EAAG-secret' } }) });
  const body = await r.json();
  assert.equal(body.tenant.settings.whatsapp.accessToken, '••••••');
  const raw = getDb().prepare('SELECT settings FROM tenants WHERE id = ?').get(tenant.id).settings;
  assert.ok(!raw.includes('EAAG-secret'));
  assert.equal(tenants.getTenant(tenant.id).settings.whatsapp.accessToken, 'EAAG-secret');

  // simulator
  r = await fetch(`${base}/api/tenants/${tenant.id}/simulate`, { method: 'POST', headers: h(adminKey), body: JSON.stringify({ text: 'hi', waId: '441' }) });
  assert.equal((await r.json()).replies.length, 1);
}));

test('whatsapp webhook: verify handshake + signed delivery + dedupe', () => withServer(async (base) => {
  const t = makeTenant({ whatsapp: { phoneNumberId: 'PNID1', accessToken: 'tok', appSecret: 'appsecret' } });
  let r = await fetch(`${base}/webhooks/whatsapp/${t.id}?hub.mode=subscribe&hub.verify_token=${t.settings.whatsapp.verifyToken}&hub.challenge=42`);
  assert.equal(await r.text(), '42');
  r = await fetch(`${base}/webhooks/whatsapp/${t.id}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
  assert.equal(r.status, 403);

  const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PNID1' }, contacts: [{ wa_id: '447700900099', profile: { name: 'Sam' } }], messages: [{ from: '447700900099', id: 'wamid.1', timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'v:mug|mug', title: 'Add' } } }] } }] }] });
  r = await fetch(`${base}/webhooks/whatsapp/${t.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body: payload });
  assert.equal(r.status, 401);

  const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(payload).digest('hex');
  const realFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://graph.facebook.com')) { outbound.push(JSON.parse(opts.body)); return new Response('{"messages":[{"id":"x"}]}', { status: 200 }); }
    return realFetch(url, opts);
  };
  try {
    for (let i = 0; i < 2; i++) {
      r = await realFetch(`${base}/webhooks/whatsapp/${t.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body: payload });
      assert.equal(r.status, 200);
    }
    await new Promise((res) => setTimeout(res, 200));
  } finally { globalThis.fetch = realFetch; }
  const sentMsgs = outbound.filter((o) => o.type !== undefined && o.status !== 'read');
  assert.equal(sentMsgs.length, 1, 'duplicate delivery must be ignored');
  assert.equal(sentMsgs[0].interactive.type, 'list'); // quantity picker
  assert.equal(getConversation(t.id, '447700900099').state, 'awaiting_qty');
}));

test('dify tools require tool key + session token and act on that customer only', () => withServer(async (base) => {
  const { tenant, toolKey } = tenants.createTenant({ name: 'Tools Shop', plan: 'pro' });
  tenants.updateTenantSettings(tenant.id, { store: { manual: { products: [{ id: 'mug', title: 'Mug', price: 5 }] } } });
  const { createSessionToken } = await import('../src/session.js');
  const tok = createSessionToken(tenant.id, '4471');
  const post = (p, body, key = toolKey) => fetch(`${base}/tools/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tool-Key': key }, body: JSON.stringify(body) });
  assert.equal((await post('view_cart', { session_token: tok }, 'bad')).status, 401);
  assert.equal((await post('view_cart', { session_token: 'forged.token' })).status, 401);
  let r = await (await post('search_products', { session_token: tok, query: 'mug' })).json();
  assert.equal(r.products[0].product_id, 'mug');
  r = await (await post('add_to_cart', { session_token: tok, product_id: 'mug', quantity: 2 })).json();
  assert.equal(r.subtotal, '£10.00');
  assert.equal(getConversation(tenant.id, '4471').cart[0].quantity, 2);
  r = await (await post('checkout', { session_token: tok, fulfilment: 'pickup', payment_method: 'cod' })).json();
  assert.ok(r.ok, JSON.stringify(r));
}));
