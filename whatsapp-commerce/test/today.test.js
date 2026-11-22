import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, tenants } = await import('./helpers.js');
const { getDb } = await import('../src/db.js');
const { todayList } = await import('../src/today.js');
const { zonedToUtc } = await import('../src/bookings.js');

const keys = (t) => todayList(tenants.getTenant(t.id)).items.map((i) => i.key);

test('Today: all clear for a quiet business', () => {
  const t = makeTenant({ store: { type: 'none' } });
  const r = todayList(tenants.getTenant(t.id));
  assert.equal(r.allClear, true, 'only for-information rows');
  assert.deepEqual(r.items.map((i) => i.key), ['account_email'], 'just the reminder to add an account email');
});

test('Today: urgent first, then things to do, then for-information – each linking to its page', () => {
  const t = makeTenant({ store: { type: 'none' }, bookings: { enabled: true, times: ['10:00'] }, tickets: { enabled: true } });
  const d = getDb();
  d.prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, name, status, urgent) VALUES (?, 'a', 'call', 'Dave', 'new', 1)").run(t.id);
  d.prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, name, status, urgent) VALUES (?, 'b', 'call', 'Ann', 'new', 0)").run(t.id);
  d.prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, name, status, urgent) VALUES (?, 'c', 'call', 'Old', 'contacted', 1)").run(t.id);
  d.prepare("INSERT INTO conversations (tenant_id, wa_id, human_handover) VALUES (?, '447700900111', 1)").run(t.id);
  d.prepare("INSERT INTO conversations (tenant_id, wa_id, human_handover) VALUES (?, 'qa:check', 1)").run(t.id);
  const future = new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  d.prepare("INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status) VALUES (?, 'x', 'Jo', 'Visit', ?, '10:00', ?, 'requested')").run(t.id, future, zonedToUtc(future, '10:00', 'Europe/London').toISOString());
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  d.prepare("INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status) VALUES (?, 'y', 'Kim', 'Visit', ?, '23:59', ?, 'confirmed')").run(t.id, today, zonedToUtc(today, '23:59', 'Europe/London').toISOString());
  d.prepare("INSERT INTO quotes (tenant_id, number, token, request, status, items) VALUES (?, 1001, 'tok-today-1', 'tap', 'draft', '[]')").run(t.id);
  d.prepare("INSERT INTO tickets (tenant_id, number, wa_id, subject, description, status) VALUES (?, 1, 'z', 'Leak', 'Kitchen', 'open')").run(t.id);
  d.prepare("INSERT INTO unanswered (tenant_id, question) VALUES (?, 'Do you do Sundays?')").run(t.id);
  const r = todayList(tenants.getTenant(t.id));
  assert.deepEqual(r.items.map((i) => i.key), ['handover', 'urgent_leads', 'leads', 'bookings_to_confirm', 'quotes', 'tickets', 'appointments_today', 'gaps', 'account_email']);
  assert.equal(r.allClear, false);
  assert.match(r.items[0].title, /^1 chat is waiting/, 'the automatic answer check (qa:) is not a customer');
  assert.match(r.items[1].detail, /Dave/);
  assert.match(r.items.find((i) => i.key === 'appointments_today').detail, /23:59 Visit – Kim/);
  assert.deepEqual([...new Set(r.items.map((i) => i.tab))], ['inbox', 'leads', 'bookings', 'quotes', 'tickets', 'knowledge', 'billing']);
});

test('Today fits the business: no booking or order rows when those are off; a shop sees orders', () => {
  const plumber = makeTenant({ store: { type: 'none' } });
  getDb().prepare("INSERT INTO bookings (tenant_id, wa_id, day, time, starts_at, status) VALUES (?, 'x', '2099-01-01', '10:00', '2099-01-01T10:00:00Z', 'requested')").run(plumber.id);
  assert.ok(!keys(plumber).includes('bookings_to_confirm'), 'bookings switched off: not shown');
  const shop = makeTenant(); // manual catalogue with products
  getDb().prepare("INSERT INTO orders (tenant_id, wa_id, items, subtotal, status) VALUES (?, 'o', '[]', 10, 'new')").run(shop.id);
  assert.ok(keys(shop).includes('orders'));
});
