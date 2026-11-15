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
  assert.match(r[0].text, /Type \*menu\* to go back to the assistant/);
  r = await say(t, wa, 'hello?');
  assert.equal(r.length, 1, 'customer is told their message is with the team, not left in silence');
  assert.match(r[0].text, /your message is with our team/);
  r = await say(t, wa, 'u there');
  assert.equal(r.length, 0, 'acknowledged at most every 10 minutes');
  r = await say(t, wa, 'menu');
  assert.equal(r.length, 1);
});

test('handover: assistant takes the chat back after 15 minutes with no staff reply; stays quiet once staff reply', async () => {
  const { getConversation, saveConversation, setHandover } = await import('../src/bot/state.js');
  const t = makeTenant();
  const wa = '447700900016';
  await say(t, wa, 'talk to a human');
  const c = getConversation(t.id, wa);
  c.data.handoverAt = new Date(Date.now() - 16 * 60000).toISOString();
  saveConversation(c);
  let r = await say(t, wa, 'menu please');
  assert.ok(r.length >= 1);
  assert.equal(getConversation(t.id, wa).humanHandover, false, 'nobody replied, so the assistant is back');

  // a staff member replies: the bot stays silent even after 15 minutes
  const wa2 = '447700900017';
  await say(t, wa2, 'talk to a human');
  setHandover(t.id, wa2, true); // e.g. an Inbox reply
  const c2 = getConversation(t.id, wa2);
  c2.data.handoverAt = new Date(Date.now() - 60 * 60000).toISOString();
  saveConversation(c2);
  r = await say(t, wa2, 'thanks');
  assert.equal(r.length, 0);
  assert.equal(getConversation(t.id, wa2).humanHandover, true);
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

test('bookings shop (store type "none"): booking menu, booking link, no basket, AI told not to sell', async () => {
  const { buildPrompt } = await import('../src/dify/provision.js');
  const t = makeTenant({ store: { type: 'none' }, business: { bookingUrl: 'https://karat.example/experiences' } });
  let r = await say(t, '447700900020', 'menu');
  assert.deepEqual(r[0].buttons.map((b) => b.id), ['book', 'ask', 'human']);
  assert.equal(r[0].buttons[0].title, '📅 How to book');
  r = await say(t, '447700900020', { action: 'book' });
  assert.equal(r[0].type, 'cta');
  assert.equal(r[0].url, 'https://karat.example/experiences');
  r = await say(t, '447700900020', { action: 'browse' });
  assert.equal(r[0].type, 'cta', 'browse goes to booking too');
  const p = buildPrompt(tenants.getTenant(t.id));
  assert.match(p, /never offer a basket, cart or checkout/);
  assert.match(p, /bookings: https:\/\/karat\.example\/experiences/);
  assert.doesNotMatch(p, /Fulfilment options/);
});

test('bookings shop: menu and link button labels can be changed (e.g. a shop with its own checkout)', async () => {
  const t = makeTenant({ store: { type: 'none' }, business: { bookingUrl: 'https://shop.example/products', bookingButton: '🛒 How to buy', bookingLinkText: 'Shop now' } });
  let r = await say(t, '447700900021', 'menu');
  assert.equal(r[0].buttons[0].title, '🛒 How to buy');
  r = await say(t, '447700900021', { action: 'book' });
  assert.equal(r[0].buttonText, 'Shop now');
});
