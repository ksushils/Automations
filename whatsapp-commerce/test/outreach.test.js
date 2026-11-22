import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants } from './helpers.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { inQuietHours, outreachCheck, guarded, automationLog, logOutreach } from '../src/outreach.js';
import { runPaymentReminders } from '../src/jobs.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
// 22 Nov 2026 is GMT (UTC+0) in London
const at = (hhmm) => Date.parse(`2026-11-22T${hhmm}:00Z`);

test('quiet hours follow the business time zone and settings (default 21:00–08:00)', () => {
  const S = { business: { timezone: 'Europe/London' } };
  assert.equal(inQuietHours(S, at('22:30')), true);
  assert.equal(inQuietHours(S, at('07:59')), true);
  assert.equal(inQuietHours(S, at('08:00')), false);
  assert.equal(inQuietHours(S, at('14:00')), false);
  assert.equal(inQuietHours({ business: { timezone: 'Asia/Dubai' } }, at('14:00')), false); // 18:00 in Dubai
  assert.equal(inQuietHours({ business: { timezone: 'Asia/Dubai' } }, at('18:00')), true); // 22:00 in Dubai
  assert.equal(inQuietHours({ ...S, followUps: { quietStart: 13, quietEnd: 15 } }, at('14:00')), true);
  assert.equal(inQuietHours({ ...S, followUps: { quietStart: 0, quietEnd: 0 } }, at('03:00')), false, 'start = end switches quiet hours off');
});

test('guard rails: daily cap per customer, no duplicates, switch-off; appointment reminders ignore quiet hours', async () => {
  const t = makeTenant({ followUps: { quietStart: 21, quietEnd: 8 } });
  const T = tenants.getTenant(t.id);
  assert.deepEqual(outreachCheck(T, '447700900501', 'abandoned_cart', { now: at('23:00') }), { ok: false, reason: 'Quiet hours', retry: true });
  assert.equal(outreachCheck(T, '447700900501', 'booking_reminder', { now: at('06:00') }).ok, true);
  tenants.updateTenantSettings(t.id, { followUps: { quietStart: 0, quietEnd: 0 } }); // the cap uses the real clock
  logOutreach(t.id, '447700900501', 'abandoned_cart', { ref: 'c1' });
  logOutreach(t.id, '447700900501', 'payment_reminder', { ref: 'o1' });
  const capped = outreachCheck(tenants.getTenant(t.id), '447700900501', 'review_request', { ref: 'o9', now: Date.now() });
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /Daily limit reached \(2/);
  assert.equal(outreachCheck(T, '447700900599', 'payment_reminder', { ref: 'o1', now: at('12:00') }).duplicate, true, 'a ref names the record (order, quote…), so the same reminder is never sent twice');
  assert.equal(outreachCheck(T, '447700900599', 'review_request', { ref: 'o1', now: at('12:00') }).duplicate, undefined, 'a different kind of message for the same record is allowed');
  assert.equal(outreachCheck(T, '447700900502', 'abandoned_cart', { ref: 'c1', now: at('12:00') }).duplicate, true);
  tenants.updateTenantSettings(t.id, { followUps: { enabled: false } });
  assert.match(outreachCheck(tenants.getTenant(t.id), '447700900503', 'quote_followup', { now: at('12:00') }).reason, /switched off/);
  assert.equal(outreachCheck(tenants.getTenant(t.id), '447700900503', 'booking_reminder', { now: at('12:00') }).ok, true, 'appointment reminders are not optional follow-ups');
});

test('guarded(): sent, skipped and failed are all logged; a retry leaves the record untouched', async () => {
  const t = makeTenant();
  const T = tenants.getTenant(t.id);
  let decided = 0;
  assert.equal(await guarded(T, '447700900511', 'abandoned_cart', 'x1', async () => 'sent', { onDecided: () => decided++ }), 'sent');
  assert.equal(await guarded(T, '447700900511', 'abandoned_cart', 'x1', async () => 'sent', { onDecided: () => decided++ }), 'skipped', 'same follow-up never sent twice');
  assert.equal(await guarded(T, '447700900512', 'payment_reminder', 'x2', async () => { throw new Error('Meta: (#131047) Re-engagement message'); }), 'failed');
  assert.equal(await guarded(T, '447700900513', 'payment_reminder', 'x3', async () => 'outside_window'), 'skipped');
  assert.equal(decided, 2);
  const log = automationLog(t.id);
  assert.deepEqual(log.map((l) => l.status).sort(), ['failed', 'sent', 'skipped']);
  assert.match(log.find((l) => l.status === 'failed').detail, /131047/);
  assert.match(log.find((l) => l.status === 'skipped').detail, /24-hour/);
  const quiet = makeTenant({ followUps: { quietStart: 0, quietEnd: 23 } }); // quiet almost all day
  const T2 = tenants.getTenant(quiet.id);
  const h = new Date().getUTCHours();
  if (h < 23) { // (between 23:00 and 00:00 this tenant isn't quiet)
    let called = false, marked = false;
    assert.equal(await guarded(T2, '447700900514', 'abandoned_cart', 'q1', async () => { called = true; }, { onDecided: () => { marked = true; } }), 'retry');
    assert.equal(called || marked, false, 'nothing sent and the record is left for the next run');
  }
});

test('payment reminders go through the guard rails and appear in the automatic messages log', () => withServer(async (base) => {
  const t = makeTenant({ ordering: { paymentReminderMinutes: 1 } });
  const { adminKey } = tenants.rotateKeys(t.id);
  const d = getDb();
  d.prepare("INSERT INTO customers (tenant_id, wa_id, name, last_inbound_at) VALUES (?, '447700900521', 'Rita', datetime('now'))").run(t.id);
  d.prepare("INSERT INTO orders (tenant_id, wa_id, store_order_name, status, payment_status, payment_method, items, subtotal, created_at) VALUES (?, '447700900521', 'P-1', 'pending', 'unpaid', 'bank_transfer', '[]', 20, datetime('now', '-30 minutes'))").run(t.id);
  // two automatic messages already today → the reminder is held back by the daily cap
  logOutreach(t.id, '447700900521', 'abandoned_cart', { ref: 'a' });
  logOutreach(t.id, '447700900521', 'review_request', { ref: 'b' });
  await runPaymentReminders();
  const r = await (await fetch(`${base}/api/tenants/${t.id}/automation-log`, { headers: { Authorization: 'Bearer ' + adminKey } })).json();
  const pay = r.log.find((l) => l.kind === 'payment_reminder');
  assert.equal(pay.status, 'skipped');
  assert.match(pay.detail, /Daily limit/);
  assert.equal(pay.customer, 'Rita');
  assert.ok(d.prepare("SELECT reminded_at FROM orders WHERE tenant_id = ? AND store_order_name = 'P-1'").get(t.id).reminded_at, 'not retried every 5 minutes');
  assert.equal(r.settings.maxPerDay, 2);
}));
