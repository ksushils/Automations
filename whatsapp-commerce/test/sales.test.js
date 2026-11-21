import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants, say, ids } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { runLeadNudges, leadSpeed, setLeadStatus } from '../src/leads.js';
import { openerConfig } from '../src/routes/webchat.js';
import { tradeSettings } from '../src/trades.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const admin = (base, path, opts = {}) => fetch(`${base}/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}` }, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('speed to lead: the team is nudged at 30 minutes and 4 hours; the customer gets one follow-up after a day', async () => {
  const t = makeTenant();
  const id = Number(getDb().prepare("INSERT INTO chat_leads (tenant_id, wa_id, channel, kind, topic, name, email, phone, created_at) VALUES (?, 'web:x', 'web', 'call', 'Kitchens', 'Sam', 'sam@example.test', '+447700900123', datetime('now', '-35 minutes'))").run(t.id).lastInsertRowid);
  assert.equal(await runLeadNudges(), 1, '30-minute nudge');
  assert.equal(await runLeadNudges(), 0, 'only once');
  getDb().prepare("UPDATE chat_leads SET created_at = datetime('now', '-245 minutes') WHERE id = ?").run(id);
  assert.equal(await runLeadNudges(), 1, '4-hour nudge');
  getDb().prepare("UPDATE chat_leads SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(id);
  assert.equal(await runLeadNudges(), 1, 'customer follow-up');
  assert.equal(await runLeadNudges(), 0);
  // marking it contacted records how fast the team got back
  getDb().prepare("UPDATE chat_leads SET created_at = datetime('now', '-90 minutes') WHERE id = ?").run(id);
  setLeadStatus(t.id, id, 'contacted');
  const s = leadSpeed(t.id);
  assert.ok(s.avgMinutes >= 89 && s.avgMinutes <= 91, String(s.avgMinutes));
  assert.equal(s.waiting, 0);
});

test('no dead ends: after two unsure answers the assistant offers a person, a call back or a ticket', async () => {
  const t = makeTenant({ tickets: { enabled: true } });
  const prevCfg = { ...config };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '' });
  const prev = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "I'm not sure about that – I don't have that information." } }] }));
  try {
    const wa = '447700900444';
    let r = await say(t, wa, 'do you service Aga cookers?');
    assert.ok(!ids(r).includes('human'));
    r = await say(t, wa, 'what about Rayburns then?');
    assert.ok(ids(r).includes('human'), JSON.stringify(r));
    assert.ok(ids(r).includes('ticket'));
  } finally { globalThis.fetch = prev; Object.assign(config, prevCfg); }
});

test('the AI note comes after the useful first answer (still shown)', async () => {
  const t = makeTenant();
  const r = await say(t, '447700900445', 'hi');
  assert.match(r[0].text, /automated assistant/);
  assert.doesNotMatch(r[0].text, /^🤖/, 'not the first thing they read');
});

test('A/B test of the pop-up greeting: variants, a no-greeting group, and results per variant', () => withServer(async (base) => {
  const t = makeTenant();
  assert.equal(openerConfig(tenants.getTenant(t.id)).ab, null, 'off by default');
  const started = new Date(Date.now() - 1000).toISOString();
  tenants.updateTenantSettings(t.id, { webchat: { opener: { text: 'A: hello', textB: 'B: need help choosing?', holdout: 10, abStarted: started } } });
  assert.deepEqual(openerConfig(tenants.getTenant(t.id)).ab, { b: 'B: need help choosing?', holdout: 0.1 });
  const js = await (await fetch(`${base}/chat-widget/${t.id}.js`)).text();
  assert.match(js, /AB==='H'/);
  assert.doesNotThrow(() => new Function(js));
  for (const v of ['A', 'A', 'B', 'H']) await post(`${base}/chat/${t.id}/ab`, { sessionId: 'abSessionABCDEFGH12345', variant: v });
  await post(`${base}/chat/${t.id}/message`, { sessionId: 'abVisitorBBBBBBBBBB111', text: 'hello', ab: 'B' });
  getDb().prepare("INSERT INTO chat_leads (tenant_id, wa_id, channel, kind, topic) VALUES (?, 'web:abVisitorBBBBBBBBBB111', 'web', 'call', 'x')").run(t.id);
  const r = (await admin(base, `/tenants/${t.id}/ab`)).body;
  assert.equal(r.running, true);
  assert.deepEqual([r.variants.A.visits, r.variants.B.visits, r.variants.H.visits], [2, 1, 1]);
  assert.deepEqual([r.variants.B.chats, r.variants.B.leads, r.variants.A.chats], [1, 1, 0]);
}));

test('trade templates turn on a second booking reminder 2 hours before (fewer no-shows)', () => {
  assert.equal(tradeSettings('dental', tenants.getTenant(makeTenant().id).settings).bookings.secondReminderHours, 2);
});
