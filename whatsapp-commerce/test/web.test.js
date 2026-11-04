import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, say } from './helpers.js';
import { createApp } from '../src/server.js';
import { listOrders } from '../src/bot/orders.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('lite mode: web basket checkout without WhatsApp API, server-side pricing, WhatsApp hand-off link', () => withServer(async (base) => {
  const t = makeTenant({ business: { whatsappNumber: '447700900123' }, ordering: { promoCodes: [{ code: 'TEN', type: 'percent', value: 10 }] } });
  const html = await (await fetch(`${base}/s/${t.id}`)).text();
  assert.match(html, /Add to basket/);
  assert.match(html, /id="cof"/);

  // client tries to cheat on price → ignored, server re-prices
  let r = await post(`${base}/s/${t.id}/quote`, { items: [{ productId: 'tee', variantId: 'tee-l', quantity: 2, price: 0.01 }], fulfilment: 'pickup', promoCode: 'TEN' });
  assert.equal(r.body.subtotal, 32);
  assert.equal(r.body.total, 28.8);

  r = await post(`${base}/s/${t.id}/order`, { items: [{ productId: 'tee', variantId: 'tee-l', quantity: 2 }], name: 'Web Buyer', phone: '07700 900777', fulfilment: 'delivery', address: '1 High St, London SW1A 1AA', paymentMethod: 'cod', promoCode: 'TEN', note: 'Leave at door' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.order, /^WA-\d+$/);
  assert.equal(r.body.total, 32 - 3.2 + 3.5);
  assert.match(r.body.whatsappUrl, /^https:\/\/wa\.me\/447700900123\?text=/);
  const [o] = listOrders(t.id, { waId: '447700900777' });
  assert.equal(o.customer_name, 'Web Buyer');
  assert.equal(o.notes, 'Leave at door');

  // customer taps "Send order on WhatsApp" → bot recognises the order
  const msg = decodeURIComponent(r.body.whatsappUrl.split('text=')[1]);
  const replies = await say(t, '447700900777', msg);
  assert.match(replies[0].text, new RegExp(`got your order \\*${o.store_order_name}\\*`));
  // someone else pasting the same text gets nothing special
  const other = await say(t, '447700900778', msg);
  assert.doesNotMatch(other[0]?.text || '', /got your order/);

  r = await post(`${base}/s/${t.id}/order`, { items: [], name: 'X', phone: '07700900777' });
  assert.equal(r.status, 400);
  r = await post(`${base}/s/${t.id}/order`, { items: [{ productId: 'mug', quantity: 1 }], name: 'X', phone: '12' });
  assert.match(r.body.error, /valid mobile/);
}));

test('website chat widget script', () => withServer(async (base) => {
  const t = makeTenant({ business: { whatsappNumber: '+44 7700 900123' }, widget: { color: '#ff0066', greeting: 'Hello there' } });
  const js = await (await fetch(`${base}/widget/${t.id}.js`)).text();
  assert.match(js, /"number":"447700900123"/);
  assert.match(js, /#ff0066/);
  assert.match(js, /Hello there/);
  const none = await (await fetch(`${base}/widget/nope.js`)).text();
  assert.match(none, /set the public WhatsApp number/);
}));
