import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenants } from './helpers.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { listOpportunities, setOpportunityState } from '../src/opportunities.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString().replace('T', ' ').slice(0, 19);
const ahead = (h) => new Date(Date.now() + h * 3600000).toISOString().replace('T', ' ').slice(0, 19);

function seed() {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Radar Plumbing', plan: 'growth' });
  const id = tenant.id, d = getDb();
  d.prepare("INSERT INTO customers (tenant_id, wa_id, name) VALUES (?, '447700900301', 'Pat Plumb')").run(id);
  const lead = Number(d.prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, topic, name, phone, message, created_at) VALUES (?, '447700900301', 'call', 'Leaking boiler', 'Pat Plumb', '07700900301', 'Water under the boiler', ?)").run(id, ago(300)).lastInsertRowid);
  d.prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, topic, name, created_at) VALUES (?, 'web:abc', 'email', 'Prices', 'Fresh Lead', ?)").run(id, ago(2)); // too new
  d.prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, topic, name, status, created_at) VALUES (?, 'web:x', 'call', 'Done', 'Old', 'contacted', ?)").run(id, ago(600)); // already handled
  d.prepare("INSERT INTO quotes (tenant_id, number, token, name, request, items, total, status, created_at) VALUES (?, 1001, ?, 'Quinn', 'Replace kitchen tap', ?, 0, 'draft', ?)").run(id, 'tok-' + id + '-1', JSON.stringify([{ item: 'Tap', qty: 1, price: null }]), ago(90));
  d.prepare("INSERT INTO quotes (tenant_id, number, token, name, phone, request, items, total, status, sent_at) VALUES (?, 1002, ?, 'Sam', '07700900302', 'Bathroom refit', ?, 1200, 'sent', ?)").run(id, 'tok-' + id + '-2', JSON.stringify([{ item: 'Refit', qty: 1, price: 1200 }]), ago(4 * 1440));
  d.prepare("INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status) VALUES (?, '447700900303', 'Bo', 'Boiler service', '2030-01-02', '09:00', ?, 'requested')").run(id, ahead(24));
  d.prepare("INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status) VALUES (?, '447700900304', 'Cy', 'Gas check', '2030-01-03', '11:00', ?, 'cancelled')").run(id, ahead(48));
  d.prepare("INSERT INTO unanswered (tenant_id, question, status) VALUES (?, 'Do you cover Croydon?', 'open')").run(id);
  d.prepare("INSERT INTO conversations (tenant_id, wa_id, human_handover) VALUES (?, '447700900305', 1)").run(id);
  d.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, '447700900305', 'in', 'text', ?, ?)").run(id, JSON.stringify({ text: 'Can someone call me please' }), ago(20));
  return { id, adminKey, lead };
}

test('opportunities: built only from real records, with evidence, next step and grounded values', () => {
  const { id } = seed();
  const { items } = listOpportunities(tenants.getTenant(id));
  const types = items.map((o) => o.type);
  for (const t of ['callback', 'waiting_for_person', 'quote_approval', 'quote_no_reply', 'booking_request', 'free_slot', 'knowledge_gap']) assert.ok(types.includes(t), `has ${t}`);
  assert.ok(!items.some((o) => o.customer?.name === 'Fresh Lead'), 'a lead from 2 minutes ago is not nagged yet');
  assert.ok(!items.some((o) => o.customer?.name === 'Old'), 'contacted leads are not listed');
  const cb = items.find((o) => o.type === 'callback');
  assert.equal(cb.priority, 'high');
  assert.equal(cb.customer.phone, '07700900301');
  assert.match(cb.reason, /Leaking boiler/);
  assert.match(cb.evidence, /Water under the boiler/);
  assert.ok(cb.actions.includes('call'));
  const draft = items.find((o) => o.type === 'quote_approval');
  assert.equal(draft.value, null, 'no value when a price is still "to confirm"');
  assert.match(draft.next, /missing prices/);
  const sent = items.find((o) => o.type === 'quote_no_reply');
  assert.equal(sent.value, 1200);
  assert.equal(sent.valueText, '£1200.00');
  assert.match(sent.valueBasis, /Quote Q-1002 total/);
  assert.equal(items[0].priority, 'high', 'urgent items first');
  assert.ok(items.filter((o) => o.value != null).every((o) => o.valueBasis), 'every value says where it came from');
});

test('opportunities disappear when the record moves on, and can be resolved, snoozed and reopened', () => {
  const { id, lead } = seed();
  const t = () => tenants.getTenant(id);
  const has = (key) => listOpportunities(t()).items.some((o) => o.key === key);
  getDb().prepare("UPDATE chat_leads SET status = 'contacted' WHERE id = ?").run(lead);
  assert.equal(has(`lead:${lead}`), false);
  const gap = listOpportunities(t()).items.find((o) => o.type === 'knowledge_gap');
  setOpportunityState(id, gap.key, 'resolve');
  assert.equal(has(gap.key), false);
  assert.equal(listOpportunities(t(), { includeClosed: true }).items.find((o) => o.key === gap.key).status, 'resolved');
  const slot = listOpportunities(t()).items.find((o) => o.type === 'free_slot');
  setOpportunityState(id, slot.key, 'snooze', { hours: 24 });
  assert.equal(has(slot.key), false);
  assert.equal(listOpportunities(t(), { now: Date.now() + 25 * 3600000 }).items.some((o) => o.key === slot.key), true, 'back after the snooze');
  setOpportunityState(id, gap.key, 'reopen');
  assert.equal(has(gap.key), true);
  assert.throws(() => setOpportunityState(id, 'nonsense', 'resolve'), /Unknown item/);
});

test('opportunities API: own business only; actions are audited', () => withServer(async (base) => {
  const a = seed(), b = seed();
  const h = (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' });
  const r = await (await fetch(`${base}/api/tenants/${a.id}/opportunities`, { headers: h(a.adminKey) })).json();
  assert.ok(r.items.length >= 7);
  assert.match(r.note, /not predictions/);
  assert.equal((await fetch(`${base}/api/tenants/${b.id}/opportunities`, { headers: h(a.adminKey) })).status, 401);
  const key = r.items[0].key;
  const res = await fetch(`${base}/api/tenants/${a.id}/opportunities/${encodeURIComponent(key)}/snooze`, { method: 'POST', headers: h(a.adminKey), body: '{"hours":2}' });
  assert.equal(res.status, 200);
  assert.ok(getDb().prepare("SELECT 1 FROM audit_log WHERE tenant_id = ? AND action = 'opportunity.snooze'").get(a.id), 'audited');
  // b's view is unaffected by a's decision
  const rb = await (await fetch(`${base}/api/tenants/${b.id}/opportunities`, { headers: h(b.adminKey) })).json();
  assert.equal(rb.items.length, r.items.length);
}));
