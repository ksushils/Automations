import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, tenants, say, ids } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { getConversation } from '../src/bot/state.js';
import { parseWhen, calendarLinks } from '../src/bookings.js';
import { rememberFacts, memoryOf } from '../src/continuity.js';

const okFetch = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.t' }] }), { status: 200 });
async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const bookingShop = (extra = {}) => makeTenant({ whatsapp: { phoneNumberId: '1', accessToken: 'x' }, store: { type: 'none' }, business: { name: 'Karat Racing', address: 'Silverstone, NN12 8TN' }, bookings: { enabled: true, services: [{ name: 'Planning call', minutes: 30 }], times: ['10:00', '14:00', '18:00'], days: 21, leadHours: 0, perSlot: 1, autoConfirm: true }, ...extra });

test('typed dates: weekdays, "next", tomorrow, dates, parts of the day and times (UK time)', () => {
  const now = new Date('2026-11-18T09:00:00Z'); // a Wednesday
  const o = { timeZone: 'Europe/London', now };
  assert.deepEqual(parseWhen('next Tuesday afternoon', o), { day: '2026-11-24', part: 'afternoon', time: null });
  assert.deepEqual(parseWhen('tomorrow at 2', o), { day: '2026-11-19', part: null, time: '14:00' });
  assert.deepEqual(parseWhen('can I come on 3rd December at 10am?', o), { day: '2026-12-03', part: null, time: '10:00' });
  assert.equal(parseWhen('friday', o).day, '2026-11-20');
  assert.equal(parseWhen('wednesday', o).day, '2026-11-18', 'today when it is today');
  assert.equal(parseWhen('next wednesday', o).day, '2026-11-25');
  assert.equal(parseWhen('20/11 evening', o).day, '2026-11-20');
  assert.equal(parseWhen('in March', o), null, 'a month alone is not a day');
  assert.equal(parseWhen('what is the price?', o), null);
});

test('booking: soonest times first, a typed day finds its times, a full day offers the nearest ones', async () => {
  const t = bookingShop();
  const prev = globalThis.fetch; globalThis.fetch = async () => okFetch();
  try {
    const wa = '447700920001';
    await say(t, wa, 'hi');
    let r = await say(t, wa, { action: 'book' });
    assert.ok(ids(r)[0].startsWith('bslot:'));
    assert.match(r[0].text, /Or type a day, e\.g\. _Friday afternoon_/);
    // they type a day instead
    const fri = parseWhen('friday', { timeZone: 'Europe/London' }).day;
    r = await say(t, wa, 'friday afternoon please');
    assert.deepEqual(ids(r), [`bslot:${fri}T14:00`, 'bdays']);
    r = await say(t, wa, { action: `bslot:${fri}T14:00` });
    assert.ok(ids(r).includes('bconfirm'));
    r = await say(t, wa, { action: 'bconfirm' });
    assert.match(r[0].text, /You're booked/);
    assert.match(r[0].text, /type \*my booking\*/i);
    const cal = r.find((m) => m.type === 'cta');
    assert.match(cal.url, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Planning%20call/);
    assert.match(cal.text, /\/b\/.+\.ics/);
    // Friday afternoon is now full → the nearest free times instead
    r = await say(t, '447700920002', 'book friday afternoon');
    assert.match(r[0].text, /is full\. The nearest free times/);
    assert.ok(!ids(r).includes(`bslot:${fri}T14:00`));
  } finally { globalThis.fetch = prev; }
});

test('my booking: change the time (the old one is cancelled) or cancel; .ics download is signed', () => withServer(async (base) => {
  const t = bookingShop();
  const prev = globalThis.fetch; const real = prev; globalThis.fetch = async (u, o) => (String(u).startsWith('http://127.0.0.1') ? real(u, o) : okFetch());
  try {
    const wa = '447700920011';
    await say(t, wa, 'hi');
    let r = await say(t, wa, { action: 'book' });
    await say(t, wa, { action: ids(r)[0] });
    await say(t, wa, { action: 'bconfirm' });
    const first = getDb().prepare('SELECT * FROM bookings WHERE tenant_id = ? AND wa_id = ?').get(t.id, wa);
    r = await say(t, wa, 'my booking');
    assert.deepEqual(ids(r), [`bresch:${first.id}`, `bcxl:${first.id}`, `bcal:${first.id}`]);
    r = await say(t, wa, { action: `bresch:${first.id}` });
    const other = ids(r).find((x) => x.startsWith('bslot:') && x !== `bslot:${first.day}T${first.time}`);
    await say(t, wa, { action: other });
    r = await say(t, wa, { action: 'bconfirm' });
    assert.match(r[0].text, /You're booked/);
    const all = getDb().prepare('SELECT status FROM bookings WHERE tenant_id = ? AND wa_id = ? ORDER BY id').all(t.id, wa).map((b) => b.status);
    assert.deepEqual(all, ['cancelled', 'confirmed']);
    const b = getDb().prepare("SELECT * FROM bookings WHERE tenant_id = ? AND wa_id = ? AND status = 'confirmed'").get(t.id, wa);
    const { ics } = calendarLinks(tenants.getTenant(t.id), b);
    const res = await real(ics.replace(config.publicUrl, base));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /BEGIN:VCALENDAR[\s\S]*DTSTART:\d{8}T\d{6}Z[\s\S]*SUMMARY:Planning call – Karat Racing/);
    assert.equal((await real(ics.replace(config.publicUrl, base).replace(/\/[^/]+\.ics$/, '/forged.ics'))).status, 404);
  } finally { globalThis.fetch = prev; }
}));

test('quick re-order: "Same as last time?" rebuilt at today\'s prices, then straight to checkout', async () => {
  const t = makeTenant();
  const wa = '447700920021';
  await say(t, wa, 'hi');
  getDb().prepare("INSERT INTO orders (tenant_id, wa_id, status, items, subtotal, currency) VALUES (?, ?, 'delivered', ?, 31, 'GBP')").run(t.id, wa, JSON.stringify([{ productId: 'tee', variantId: 'tee-l', title: 'Classic Tee (Large)', price: 15, quantity: 2 }, { productId: 'gone', title: 'Old Mug', price: 1, quantity: 1 }]));
  let r = await say(t, wa, 'hi');
  const offer = r.find((m) => /Same as last time/.test(m.text || ''));
  assert.match(offer.text, /2× Classic Tee \(Large\), 1× Old Mug – £31\.00 last time/);
  assert.ok(ids([offer])[0].startsWith('reorder:'));
  r = await say(t, wa, { action: ids([offer])[0] });
  assert.match(r[0].text, /Old Mug isn't available today/);
  const conv = getConversation(t.id, wa);
  assert.deepEqual(conv.cart.map((i) => [i.title, i.quantity, i.price]), [['Classic Tee (Large)', 2, 16]], "today's price for the large tee");
  assert.ok(r.length >= 2, 'checkout started');
  // web visitors and first-timers don't get it
  r = await say(t, '447700920022', 'hi');
  assert.ok(!r.some((m) => /Same as last time/.test(m.text || '')));
});

test('continue on WhatsApp: the website chat (basket, page, what they said) comes across with a one-use code', () => withServer(async (base) => {
  const t = makeTenant({ business: { whatsappNumber: '447700900500' } });
  const sid = 'sess' + Math.random().toString(36).slice(2).padEnd(20, 'x');
  const post = (p, body) => fetch(`${base}/chat/${t.id}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  await post('message', { sessionId: sid, text: 'do you have the classic tee in large?', page: { url: 'https://shop.test/products/classic-tee', title: 'Classic Tee' } });
  const wc = getConversation(t.id, `web:${sid}`);
  getDb().prepare('UPDATE conversations SET cart = ? WHERE id = ?').run(JSON.stringify([{ productId: 'tee', variantId: 'tee-l', title: 'Classic Tee (Large)', price: 16, quantity: 1 }]), wc.id);
  const h = await post('handoff', { sessionId: sid });
  assert.match(h.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(h.url, `https://wa.me/447700900500?text=${encodeURIComponent(`Hi! I'd like to continue my chat from your website (ref ${h.code})`)}`);
  const wa = '447700920031';
  let r = await say(t, wa, `Hi! I'd like to continue my chat from your website (ref ${h.code})`);
  assert.match(r[0].text, /brought over your chat from our website \(you were looking at \*Classic Tee\*\) and your basket \(1 item\)/);
  const c = getConversation(t.id, wa);
  assert.equal(c.cart.length, 1);
  assert.match(c.data.priorChat, /classic tee in large/);
  r = await say(t, '447700920032', `Hi! I'd like to continue my chat from your website (ref ${h.code})`);
  assert.ok(!/brought over/.test(r[0].text || ''), 'the code works once');
  // no WhatsApp number: no handoff
  const n = makeTenant();
  assert.equal((await fetch(`${base}/chat/${n.id}/handoff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) })).status, 404);
}));

test('customer memory: durable facts reach the AI next time; sensitive things are never kept; "forget me" clears it', async () => {
  const t = makeTenant();
  const wa = '447700920041';
  await say(t, wa, 'hi');
  rememberFacts(t.id, wa, ['Drives a Yokomo YD-2', 'Prefers collection', 'Is a practising Hindu', 'Has diabetes']);
  assert.deepEqual(memoryOf(t.id, wa), ['Drives a Yokomo YD-2', 'Prefers collection']);
  const calls = [];
  const llm = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { calls.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'Sure!' } }], usage: { total_tokens: 3 } })); }); });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const prev = { ...config };
  Object.assign(config, { aiBaseUrl: `http://127.0.0.1:${llm.address().port}/v1`, aiApiKey: 'sk-test', embeddingsModel: '' });
  try {
    await say(t, wa, 'any upgrades for my car?');
    const sys = calls[0].messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(sys, /What we remember about this customer.*Drives a Yokomo YD-2; Prefers collection/);
    const r = await say(t, wa, 'forget me');
    assert.match(r[0].text, /forgotten what I'd remembered/);
    assert.deepEqual(memoryOf(t.id, wa), []);
  } finally { Object.assign(config, prev); llm.close(); }
});
