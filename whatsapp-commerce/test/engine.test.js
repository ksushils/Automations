import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, say, ids, tenants } from './helpers.js';
import { listOrders } from '../src/bot/orders.js';
import { getConversation } from '../src/bot/state.js';

test('greeting shows welcome + main menu', async () => {
  const t = makeTenant();
  const r = await say(t, '447700900001', 'Hi');
  assert.equal(r.length, 1);
  assert.match(r[0].text, /Welcome to Test Shop/);
  assert.deepEqual(ids(r), ['browse', 'cart', 'more']);
});

test('full order: browse → category → variant → qty → delivery → address → COD → confirm', async () => {
  const t = makeTenant();
  const wa = '447700900002';
  let r = await say(t, wa, { action: 'browse' });
  assert.deepEqual(ids(r), ['cat:tees', 'cat:mugs']);
  r = await say(t, wa, { action: 'cat:tees' });
  assert.deepEqual(ids(r), ['p:tee']);
  r = await say(t, wa, { action: 'p:tee' });
  assert.deepEqual(ids(r), ['v:tee|tee-s', 'v:tee|tee-l']);
  r = await say(t, wa, { action: 'v:tee|tee-l' });
  assert.ok(ids(r).includes('q:2'));
  r = await say(t, wa, '2'); // typed quantity
  assert.match(r[0].text, /Added 2 × Classic Tee \(Large\)/);
  assert.match(r[0].text, /£32\.00/);

  r = await say(t, wa, 'checkout');
  assert.deepEqual(ids(r), ['ful:delivery', 'ful:pickup']);
  r = await say(t, wa, { action: 'ful:delivery' });
  assert.match(r[0].text, /delivery address/);
  r = await say(t, wa, 'Jane Doe, 1 High Street, London SW1A 1AA');
  assert.deepEqual(ids(r), ['pay:cod', 'pay:bank_transfer']);
  r = await say(t, wa, { action: 'pay:cod' });
  assert.match(r[0].text, /Total: £35\.50/); // 32 + 3.50 delivery
  assert.deepEqual(ids(r), ['confirm', 'cart', 'cancel']);
  r = await say(t, wa, { action: 'confirm' });
  assert.match(r[0].text, /Order \*WA-\d+\* confirmed/);

  const orders = listOrders(t.id, { waId: wa });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].subtotal, 35.5);
  assert.equal(orders[0].payment_method, 'cod');
  assert.equal(getConversation(t.id, wa).cart.length, 0);
  assert.equal(tenants.getUsage(t.id).orders, 1);

  // Saved address is offered next time
  await say(t, wa, { action: 'p:mug' });
  await say(t, wa, { action: 'v:mug|mug' });
  await say(t, wa, { action: 'q:1' });
  await say(t, wa, 'checkout');
  r = await say(t, wa, { action: 'ful:delivery' });
  assert.deepEqual(ids(r), ['addr:saved', 'addr:new']);

  r = await say(t, wa, 'order status');
  assert.match(r[0].text, /WA-\d+/);
});

test('bank transfer sends bank details; pickup has no delivery fee', async () => {
  const t = makeTenant();
  const wa = '447700900003';
  await say(t, wa, { action: 'v:mug|mug' });
  await say(t, wa, { action: 'q:3' });
  await say(t, wa, { action: 'checkout' });
  await say(t, wa, { action: 'ful:pickup' });
  let r = await say(t, wa, { action: 'pay:bank_transfer' });
  assert.match(r[0].text, /Total: £25\.50/);
  r = await say(t, wa, 'yes');
  assert.match(r[0].text, /Sort 00-00-00/);
});

test('free text without AI falls back to product search', async () => {
  const t = makeTenant();
  const r = await say(t, '447700900004', 'do you have a mug?');
  assert.deepEqual(ids(r), ['p:mug']);
});

test('minimum order is enforced', async () => {
  const t = makeTenant({ ordering: { minOrder: 20 } });
  const wa = '447700900005';
  await say(t, wa, { action: 'v:mug|mug' });
  await say(t, wa, { action: 'q:1' });
  const r = await say(t, wa, 'checkout');
  assert.match(r[0].text, /minimum order is £20\.00/);
});

test('human handover silences bot until "menu"', async () => {
  const t = makeTenant();
  const wa = '447700900006';
  let r = await say(t, wa, 'talk to a human');
  assert.match(r[0].text, /team will reply/);
  r = await say(t, wa, 'hello?');
  assert.equal(r.length, 0);
  r = await say(t, wa, 'menu');
  assert.equal(r.length, 1);
});

test('remove line and opt-in/out', async () => {
  const t = makeTenant();
  const wa = '447700900007';
  await say(t, wa, { action: 'v:mug|mug' });
  await say(t, wa, { action: 'q:1' });
  let r = await say(t, wa, 'remove 1');
  assert.match(r[0].text, /cart is empty/);
  r = await say(t, wa, { action: 'subscribe' });
  assert.deepEqual(ids(r), ['optin:yes', 'optin:no']); // asks with the exact wording first
  r = await say(t, wa, { action: 'optin:yes' });
  assert.match(r[0].text, /subscribed/);
  const { latestConsent } = await import('../src/consent.js');
  assert.equal(latestConsent(t.id, wa).source, 'whatsapp_opt_in');
  assert.match(latestConsent(t.id, wa).wording, /Yes, send me offers and news from Test Shop/);
  r = await say(t, wa, 'stop');
  assert.equal(latestConsent(t.id, wa).status, 'withdrawn');
});
