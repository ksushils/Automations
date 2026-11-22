import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants, say } from './helpers.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { askCopilot, detectIntent, SUGGESTIONS } from '../src/copilot.js';
import { ownerCommand } from '../src/briefing.js';
import { createStaff } from '../src/staff.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const tomorrow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 864e5));

function seed() {
  const t = makeTenant();
  const d = getDb();
  d.prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, name, phone, topic, call_time, created_at) VALUES (?, '447700900601', 'call', 'Cal Back', '07700900601', 'boiler', 'after 5pm', datetime('now', '-20 minutes'))").run(t.id);
  d.prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, name) VALUES (?, 'web:x', 'email', 'Info Only')").run(t.id);
  d.prepare("INSERT INTO quotes (tenant_id, number, token, name, request, items, total, status) VALUES (?, 1001, ?, 'Quinn', 'Fit a new tap', ?, 85, 'draft')").run(t.id, 'cq-' + t.id, JSON.stringify([{ item: 'Tap fitting', qty: 1, price: 85 }]));
  d.prepare("INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status) VALUES (?, '447700900602', 'Bea', 'Haircut', ?, '10:30', '2030-01-01 10:30:00', 'confirmed')").run(t.id, tomorrow());
  d.prepare("INSERT INTO unanswered (tenant_id, question) VALUES (?, 'Do you do weekend callouts?')").run(t.id);
  d.prepare("INSERT INTO unanswered (tenant_id, question) VALUES (?, 'do you do weekend callouts?')").run(t.id);
  return t;
}

test('copilot: the owner\'s everyday questions are recognised', () => {
  const want = ['today', 'callbacks', 'quotes', 'tomorrow', 'complaints', 'unanswered', 'common', 'priorities'];
  assert.deepEqual(SUGGESTIONS.map(detectIntent), want);
  assert.equal(detectIntent('How many new leads arrived?'), 'leads');
  assert.equal(detectIntent('tell me a joke'), null);
});

test('copilot: answers come from the records – callbacks, quotes, tomorrow, gaps, priorities', () => {
  const t = tenants.getTenant(seed().id);
  const cb = askCopilot(t, 'Which customers need callbacks?');
  assert.match(cb.answer, /1 customer asked to be called back/);
  assert.match(cb.items[0], /Cal Back – 07700900601 – about boiler – best time: after 5pm/);
  assert.ok(!cb.items.some((i) => /Info Only/.test(i)), 'detail requests are not callbacks');
  const q = askCopilot(t, 'What quotes are awaiting my approval?');
  assert.match(q.answer, /1 quote waiting for your approval/);
  assert.match(q.items[0], /Q-1001 for Quinn – Fit a new tap – £85\.00/);
  const tm = askCopilot(t, 'What appointments are booked tomorrow?');
  assert.match(tm.items[0], /10:30 – Bea – Haircut/);
  const un = askCopilot(t, 'What questions could the AI not answer?');
  assert.match(un.items[0], /weekend callouts.*asked 2 times/i);
  const pr = askCopilot(t, 'What should I prioritise today?');
  assert.ok(pr.items.length >= 2);
  assert.match(pr.items[0], /^🔴/);
  const today = askCopilot(t, 'What happened today?');
  assert.match(today.answer, /\d+ new leads?/); // (exact count depends on whether the test runs just after midnight)
  assert.match(today.answer, /need you \(\d+ urgent\)/);
  assert.equal(askCopilot(t, 'Which complaints need attention?').answer, 'No complaints or unhappy customers in the last 7 days. ✅');
  assert.ok([cb, q, tm, un, pr, today].every((r) => r.readOnly === true));
  const unknown = askCopilot(t, 'Book me a holiday');
  assert.equal(unknown.intent, null);
  assert.deepEqual(unknown.items, SUGGESTIONS);
});

test('copilot: on WhatsApp only for the team numbers saved in Settings; customers asking the same are not answered with business data', async () => {
  const t = seed();
  tenants.updateTenantSettings(t.id, { notifications: { staffWaIds: ['447700900699'] } });
  const T = tenants.getTenant(t.id);
  assert.match(ownerCommand(T, '447700900699', 'which customers need callbacks?'), /Cal Back/);
  assert.equal(ownerCommand(T, '447700900111', 'which customers need callbacks?'), null, 'a customer is not a team member');
  assert.equal(ownerCommand(T, '447700900699', 'I need a plumber'), null, 'ordinary messages from the owner still go to the assistant');
  const replies = await say(T, '447700900612', 'Which customers need callbacks?');
  assert.ok(!JSON.stringify(replies).includes('Cal Back'), 'no customer data leaks to customers');
});

test('copilot API: any team member may ask (read-only), audited; another business cannot', () => withServer(async (base) => {
  const t = seed();
  const { adminKey } = tenants.rotateKeys(t.id);
  const staff = createStaff(t.id, { name: 'Helper' });
  const other = tenants.createTenant({ name: 'Other' });
  const ask = (k, tid = t.id) => fetch(`${base}/api/tenants/${tid}/copilot`, { method: 'POST', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Which customers need callbacks?' }) });
  assert.match((await (await ask(staff.key)).json()).answer, /called back/);
  assert.equal((await ask(other.adminKey)).status, 401);
  assert.ok(getDb().prepare("SELECT 1 FROM audit_log WHERE tenant_id = ? AND action = 'copilot.ask'").get(t.id));
  assert.equal((await fetch(`${base}/api/tenants/${t.id}/copilot`, { method: 'POST', headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
}));

test('churn feedback: optional reason saved for the owner only; summary for the platform owner', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Leaving Ltd', plan: 'starter' });
  const staff = createStaff(tenant.id, { name: 'Helper' });
  const post = (k, body) => fetch(`${base}/api/tenants/${tenant.id}/churn-feedback`, { method: 'POST', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(adminKey, { reason: 'too_expensive', detail: 'Cash flow is tight' })).status, 200);
  assert.equal((await post(adminKey, { reason: 'made-up' })).status, 400);
  assert.equal((await post(staff.key, { reason: 'other' })).status, 403);
  const r = await (await fetch(`${base}/api/system/churn`, { headers: { Authorization: 'Bearer super-admin-test-key' } })).json();
  assert.ok(r.reasons.some((x) => x.reason === 'too_expensive'));
  assert.ok(r.recent.some((x) => x.name === 'Leaving Ltd' && x.plan === 'starter'));
  assert.equal((await fetch(`${base}/api/system/churn`, { headers: { Authorization: 'Bearer ' + adminKey } })).status, 401);
}));
