import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, cloud } = await import('./helpers.js');
const { getDb } = await import('../src/db.js');
const { valueReport, reportText, isUnsure, recordUnanswered, listUnanswered, runReviewRequests, runMonthlyReports, monthKey } = await import('../src/insights.js');

const msg = (t, wa, dir, body, at) => getDb().prepare('INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(t, wa, dir, 'text', JSON.stringify(body), at);

test('value report: chats, bot vs staff replies, after-hours, orders, recovered carts and ROI', () => {
  const t = makeTenant({ business: { timezone: 'Europe/London' } });
  const m = '2026-10';
  // Tue 14 Oct 2026, 11:00 BST (10:00 UTC) – working hours
  msg(t.id, '447700900001', 'in', { type: 'text', text: 'do you deliver?' }, '2026-10-14 10:00:00');
  msg(t.id, '447700900001', 'out', { type: 'text', text: 'Yes!' }, '2026-10-14 10:00:02');
  // Sat 18 Oct 2026 – weekend, website visitor
  msg(t.id, 'web:abc', 'in', { type: 'text', text: 'opening times?' }, '2026-10-18 13:00:00');
  msg(t.id, 'web:abc', 'out', { type: 'text', text: '9–5' }, '2026-10-18 13:00:02');
  // weekday 22:30 UTC – after hours, handed to staff
  msg(t.id, '447700900002', 'in', { type: 'text', text: 'my parcel is broken' }, '2026-10-15 21:30:00');
  msg(t.id, '447700900002', 'out', { type: 'text', text: 'So sorry – sending a new one', staff: 'Owner' }, '2026-10-16 08:00:00');
  // simulator traffic and other months don't count
  msg(t.id, 'sim', 'in', { type: 'text', text: 'test', simulated: true }, '2026-10-14 10:00:00');
  msg(t.id, '447700900003', 'in', { type: 'text', text: 'hello' }, '2026-09-30 10:00:00');
  const ins = getDb().prepare("INSERT INTO orders (tenant_id, wa_id, status, items, subtotal, created_at, recovered, reminded_at, paid_at) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?)");
  ins.run(t.id, '447700900001', 'new', 40, '2026-10-14 10:05:00', 1, null, null);
  ins.run(t.id, '447700900001', 'new', 60, '2026-10-20 10:05:00', 0, '2026-10-20 11:00:00', '2026-10-20 12:00:00');
  ins.run(t.id, '447700900001', 'cancelled', 999, '2026-10-21 10:05:00', 0, null, null);

  const r = valueReport(t.id, m);
  assert.equal(r.chats, 3);
  assert.equal(r.webChats, 1);
  assert.equal(r.whatsappChats, 2);
  assert.equal(r.botReplies, 2);
  assert.equal(r.staffChats, 1);
  assert.equal(r.handledByBot, 2);
  assert.equal(r.afterHoursChats, 2);
  assert.deepEqual(r.orders, { count: 2, value: 100 });
  assert.equal(r.recoveredCarts.count, 1);
  assert.equal(r.paidAfterReminder.value, 60);
  assert.equal(r.recovered, 100);
  assert.equal(r.hoursSaved, 0.05); // 2 replies × 1.5 min
  assert.ok(r.roi > 0);
  assert.equal(r.partial, false);
  const text = reportText(r, 'Test Shop');
  assert.match(text, /3 conversations/);
  assert.match(text, /£100 recovered/);
  assert.match(text, /October 2026/);
});

test('unanswered questions: detects unsure answers, skips greetings and repeats', () => {
  const t = makeTenant();
  assert.equal(isUnsure("I'm not sure if an RTX 3080 will work with a 550W PSU. I can check with the team!"), true);
  assert.equal(isUnsure("I don't have that information right now."), true);
  assert.equal(isUnsure('Yes, we deliver to Abu Dhabi for free.'), false);
  assert.equal(recordUnanswered(t.id, '44711', 'Do you ship to Norway?', "I'm not sure"), true);
  assert.equal(recordUnanswered(t.id, '44711', 'Do you ship to Norway?', "I'm not sure"), false); // same chat, same day
  assert.equal(recordUnanswered(t.id, '44711', 'hi', "I'm not sure"), false);
  assert.equal(listUnanswered(t.id).length, 1);
});

test('review requests: once per delivered order, inside the 24h window, with the review link', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: '123', accessToken: 'tok' }, notifications: { reviewRequest: { enabled: true, url: 'https://g.page/r/test/review', afterHours: 0 } } });
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id, name, last_inbound_at) VALUES (?, ?, 'Jane', datetime('now', '-1 hour'))").run(t.id, '447700900009');
  getDb().prepare("INSERT INTO orders (tenant_id, wa_id, status, items, subtotal, customer_name, updated_at) VALUES (?, ?, 'delivered', '[]', 20, 'Jane Doe', datetime('now', '-5 minutes'))").run(t.id, '447700900009');
  getDb().prepare("INSERT INTO orders (tenant_id, wa_id, status, items, subtotal, updated_at) VALUES (?, ?, 'preparing', '[]', 20, datetime('now', '-5 minutes'))").run(t.id, '447700900009');
  const before = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'out'").get(t.id).n;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200 });
  try {
    assert.equal(await runReviewRequests(), 1);
    assert.equal(await runReviewRequests(), 0); // never twice
  } finally { globalThis.fetch = prev; }
  const out = getDb().prepare("SELECT body FROM messages WHERE tenant_id = ? AND direction = 'out' ORDER BY id DESC").all(t.id);
  assert.equal(out.length, before + 1);
  const sent = JSON.parse(out[0].body);
  assert.equal(sent.type, 'cta');
  assert.equal(sent.url, 'https://g.page/r/test/review');
  assert.match(sent.text, /Hi Jane/);
});

test('monthly report job only runs on the 1st and once per shop', async () => {
  assert.equal(await runMonthlyReports(new Date('2026-11-15T09:00:00Z')), 0);
  assert.equal(monthKey(new Date('2026-11-01T09:00:00Z')), '2026-11');
});
