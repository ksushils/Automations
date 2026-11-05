import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenants } from './helpers.js';
import { createApp } from '../src/server.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('shop guide: steps tick as the shop sets up, skip moves "next" on, staff cannot see it', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Guide Shop' });
  const H = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  const get = async () => (await fetch(`${base}/api/tenants/${tenant.id}/onboarding`, { headers: H })).json();
  let g = await get();
  assert.equal(g.total, 9);
  assert.equal(g.done, 0);
  assert.equal(g.next, 'shop');
  assert.deepEqual(g.steps.map((s) => s.key), ['shop', 'products', 'orders', 'assistant', 'test', 'website', 'whatsapp', 'golive', 'plan']);

  // add products by hand → shop + products done
  await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ store: { manual: { products: [{ id: 'a', title: 'Candle', price: 12 }] } } }) });
  g = await get();
  assert.equal(g.steps.find((s) => s.key === 'products').done, true);
  assert.equal(g.next, 'orders', 'built-in catalogue shops must choose payment and delivery');

  // choose payment + delivery
  await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ ordering: { paymentMethods: ['cod'], fulfilment: ['delivery'] }, onboarding: { ordersSet: true } }) });
  g = await get();
  assert.equal(g.next, 'assistant');

  // teach the assistant, then chat in the test bot
  await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ ai: { faq: 'Delivery 2 days' } }) });
  await fetch(`${base}/api/tenants/${tenant.id}/simulate`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'hi', waId: '447000000001' }) });
  g = await get();
  assert.equal(g.steps.find((s) => s.key === 'test').done, true);
  assert.equal(g.next, 'website');

  // skipping is remembered and "next" moves on, but the step is not counted as done
  await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ onboarding: { skipped: { website: true } } }) });
  g = await get();
  assert.equal(g.steps.find((s) => s.key === 'website').skipped, true);
  assert.equal(g.next, 'whatsapp');
  assert.equal(g.done, 5);

  // simulated chats don't count as a real WhatsApp message
  assert.equal(g.steps.find((s) => s.key === 'golive').data.inbound, 0);

  const staff = await (await fetch(`${base}/api/tenants/${tenant.id}/staff`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Sam', role: 'agent' }) })).json();
  if (staff.key) {
    const r = await fetch(`${base}/api/tenants/${tenant.id}/onboarding`, { headers: { Authorization: 'Bearer ' + staff.key } });
    assert.equal(r.status, 403);
  }
}));

test('shop guide: Shopify shops skip the payment step; the chat widget is spotted on their website', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Shopify Shop' });
  const H = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ store: { type: 'shopify_public', shopify: { domain: 'candles.example' } } }) });
  const get = async () => (await fetch(`${base}/api/tenants/${tenant.id}/onboarding`, { headers: H })).json();
  let g = await get();
  assert.equal(g.steps.find((s) => s.key === 'orders').done, true);
  assert.equal(g.steps.find((s) => s.key === 'website').done, false);
  // loading the widget from our own storefront doesn't count…
  await fetch(`${base}/chat-widget/${tenant.id}.js`, { headers: { Referer: 'http://localhost:0/s/' + tenant.id } });
  g = await get();
  assert.equal(g.steps.find((s) => s.key === 'website').done, false);
  // …but from the shop's own website it does
  await fetch(`${base}/chat-widget/${tenant.id}.js`, { headers: { Referer: 'https://candles.example/products/x' } });
  g = await get();
  const w = g.steps.find((s) => s.key === 'website');
  assert.equal(w.done, true);
  assert.equal(w.data.seenOn, 'https://candles.example');
  // a bad Stripe key is refused before anything is called
  const r = await fetch(`${base}/api/tenants/${tenant.id}/payments/stripe-connect`, { method: 'POST', headers: H, body: JSON.stringify({ secretKey: 'pk_live_nope' }) });
  assert.equal(r.status, 400);
}));
