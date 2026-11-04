import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants, engine, ids, say } from './helpers.js';
import { parseInbound, toGraphPayload, notify, inServiceWindow } from '../src/whatsapp/cloudApi.js';
import { saveFlow, getContact } from '../src/bot/flows.js';
import { getDb } from '../src/db.js';

const run = async (t, ev) => { const out = []; await engine.handleInbound(tenants.getTenant(t.id), { waId: '447700900601', ...ev }, async (to, m) => out.push({ to, ...m })); return out; };

test('parses every inbound type WhatsApp sends', () => {
  const b = { from: '44', id: 'w', timestamp: '1' };
  assert.equal(parseInbound({ ...b, type: 'reaction', reaction: { emoji: '👍' } }).kind, 'ignore');
  assert.equal(parseInbound({ ...b, type: 'sticker', sticker: {} }).kind, 'ignore');
  assert.deepEqual((({ kind, type, mediaId, voice }) => ({ kind, type, mediaId, voice }))(parseInbound({ ...b, type: 'audio', audio: { id: 'm1', voice: true } })), { kind: 'media', type: 'audio', mediaId: 'm1', voice: true });
  assert.equal(parseInbound({ ...b, type: 'image', image: { id: 'm2', caption: 'proof' } }).caption, 'proof');
  assert.deepEqual(parseInbound({ ...b, type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"email":"a@b.co","flow_token":"x"}' } } }).response, { email: 'a@b.co', flow_token: 'x' });
  assert.equal(parseInbound({ ...b, type: 'button', button: { payload: 'Stop offers', text: 'Stop offers' } }).id, 'Stop offers');
  assert.equal(parseInbound({ ...b, type: 'order', order: { product_items: [] } }).kind, 'native_order');
});

test('reactions/stickers get no reply; voice notes get a polite reply; images mark payment proof', async () => {
  const t = makeTenant();
  assert.equal((await run(t, { kind: 'ignore', type: 'reaction' })).length, 0);
  const v = await run(t, { kind: 'media', type: 'audio', mediaId: 'a1' });
  assert.match(v[0].text, /voice notes/);
  getDb().prepare("INSERT INTO orders (tenant_id, wa_id, store_order_name, payment_method, items) VALUES (?, '447700900601', 'WA-77', 'bank_transfer', '[]')").run(t.id);
  const img = await run(t, { kind: 'media', type: 'image', mediaId: 'i1' });
  assert.match(img[0].text, /payment proof for order \*WA-77\*/);
  assert.match(getDb().prepare("SELECT notes FROM orders WHERE store_order_name = 'WA-77'").get().notes, /payment proof received/);
});

test('template quick-reply payloads: "Stop offers" opts out, "Shop now" browses', async () => {
  const t = makeTenant();
  (await import('../src/consent.js')).recordConsent(t.id, '447700900601', { status: 'granted', source: 'whatsapp_opt_in' });
  let r = await run(t, { kind: 'action', id: 'Stop offers', text: 'Stop offers' });
  assert.match(r[0].text, /won't receive promotional messages/);
  assert.equal(getContact(t.id, '447700900601').opted_in_marketing, 0);
  r = await run(t, { kind: 'action', id: 'Shop now', text: 'Shop now' });
  assert.deepEqual(ids(r), ['cat:tees', 'cat:mugs']);
});

test('native WhatsApp catalogue cart becomes our cart and starts checkout', async () => {
  const t = makeTenant();
  const r = await run(t, { kind: 'native_order', order: { catalog_id: 'c', product_items: [{ product_retailer_id: 'mug', quantity: 2, item_price: 8.5, currency: 'GBP' }, { product_retailer_id: 'unknown', quantity: 1 }] } });
  assert.match(r[0].text, /Added 1 item from your WhatsApp cart/);
  assert.deepEqual(ids(r.slice(1)), ['ful:delivery', 'ful:pickup']);
});

test('WhatsApp Flows form block: sends flow message, saves submitted fields, continues', async () => {
  const t = makeTenant();
  saveFlow(t.id, { name: 'Booking', triggers: { keywords: ['book'], start: 'a' }, steps: [
    { id: 'a', type: 'form', text: 'Book a fitting', flowId: '123456', cta: 'Book now', screen: 'BOOKING', next: 'b' },
    { id: 'b', type: 'message', text: 'Thanks {{name}}, see you on {{attr.date}}!' },
  ] });
  let r = await run(t, { kind: 'text', text: 'book', profileName: 'Sam' });
  assert.equal(r[0].type, 'flow');
  const p = toGraphPayload('44', r[0]);
  assert.equal(p.interactive.type, 'flow');
  assert.equal(p.interactive.action.parameters.flow_id, '123456');
  assert.equal(p.interactive.action.parameters.flow_action_payload.screen, 'BOOKING');
  r = await run(t, { kind: 'form', response: { name: 'Sam Smith', date: '2026-11-20', flow_token: r[0].token } });
  assert.equal(r[0].text, 'Thanks Sam, see you on 2026-11-20!');
  assert.equal(getContact(t.id, '447700900601').attributes.date, '2026-11-20');
});

test('24h window: free text inside, template outside, skip when no template', async () => {
  const t = makeTenant();
  const sent = [];
  const send = async (to, m) => sent.push(m);
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id, last_inbound_at) VALUES (?, 'in', datetime('now', '-2 hours')), (?, 'out', datetime('now', '-2 days'))").run(t.id, t.id);
  assert.ok(inServiceWindow(t.id, 'in'));
  assert.ok(!inServiceWindow(t.id, 'out'));
  assert.equal(await notify(t, 'in', { type: 'text', text: 'hi' }, { name: 'tpl' }, send), 'sent');
  assert.equal(await notify(t, 'out', { type: 'text', text: 'hi' }, { name: 'order_update', params: ['A', 'B'] }, send), 'template');
  assert.equal(await notify(t, 'out', { type: 'text', text: 'hi' }, null, send), 'outside_window');
  assert.deepEqual(sent.map((m) => m.type), ['text', 'template']);
  // inbound message opens the window
  await say(t, 'out', 'hello');
  assert.ok(inServiceWindow(t.id, 'out'));
});
