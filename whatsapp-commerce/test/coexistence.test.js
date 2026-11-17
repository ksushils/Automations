import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants, engine } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { processWebhookBody } from '../src/whatsapp/webhook.js';
import { getConversation } from '../src/bot/state.js';
import { resumeAi, runAppReminders, takeoverMinutes, isAiPaused } from '../src/coexistence.js';
import { monthEstimate } from '../src/metaPricing.js';

const DAY = 86400000;
const coexTenant = (extra = {}) => makeTenant({ whatsapp: { phoneNumberId: 'PNC' + Math.random().toString(36).slice(2, 8), accessToken: 'tok', connectedVia: 'coexistence', numberStatus: 'active' }, ...extra });
const echo = (t, to, id, text = 'Hi, it is Sam from the shop') => processWebhookBody({ entry: [{ changes: [{ field: 'smb_message_echoes', value: { metadata: { phone_number_id: t.settings.whatsapp.phoneNumberId }, message_echoes: [{ from: '447700900000', to, id, type: 'text', text: { body: text } }] } }] }] }, { tenantOverride: tenants.getTenant(t.id) });
async function customerSays(t, waId, text) {
  const sent = [];
  await engine.handleInbound(tenants.getTenant(t.id), { waId, kind: 'text', text }, async (to, m) => { sent.push(m); });
  return sent;
}

test('owner replies from the phone: echo stored as source=phone_app and the AI goes quiet in that chat for 30 minutes', async () => {
  const t = coexTenant();
  const before = Date.now();
  await echo(t, '447700900801', 'wamid.E1');
  const row = getDb().prepare("SELECT direction, source, body FROM messages WHERE tenant_id = ? AND wa_id = '447700900801'").get(t.id);
  assert.equal(row.direction, 'out');
  assert.equal(row.source, 'phone_app');
  assert.equal(JSON.parse(row.body).text, 'Hi, it is Sam from the shop');
  const c = getConversation(t.id, '447700900801');
  assert.equal(c.humanHandover, false, 'a timed pause, not a permanent handover');
  const mins = (Date.parse(c.aiPausedUntil) - before) / 60000;
  assert.ok(mins > 29.9 && mins < 30.1, `paused ~30 min, got ${mins}`);
  // the customer writes back: the AI says nothing
  assert.deepEqual(await customerSays(t, '447700900801', 'hi'), []);
  // other chats are not affected
  assert.ok((await customerSays(t, '447700900802', 'hi')).length > 0);
  // the app is alive: activity noted for the 13-day rule
  assert.ok(tenants.getTenant(t.id).settings.whatsapp.lastAppActivityAt);
});

test('the AI answers again once the pause is over, after the owner-set time, or on "Resume AI now"', async () => {
  const t = coexTenant({ coexistence: { takeoverMinutes: 45 } });
  assert.equal(takeoverMinutes(tenants.getTenant(t.id)), 45);
  const before = Date.now();
  await echo(t, '447700900811', 'wamid.E11');
  const c = getConversation(t.id, '447700900811');
  assert.ok(Math.abs((Date.parse(c.aiPausedUntil) - before) / 60000 - 45) < 0.1);
  assert.deepEqual(await customerSays(t, '447700900811', 'hi'), []);
  // timer runs out
  getDb().prepare('UPDATE conversations SET ai_paused_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), c.id);
  assert.equal(isAiPaused(getConversation(t.id, '447700900811')), false);
  assert.ok((await customerSays(t, '447700900811', 'hi')).length > 0, 'AI replies after the pause');
  // paused again, then resumed by hand from the Inbox
  await echo(t, '447700900811', 'wamid.E12');
  assert.equal(isAiPaused(getConversation(t.id, '447700900811')), true);
  resumeAi(t.id, '447700900811');
  assert.equal(getConversation(t.id, '447700900811').aiPausedUntil, null);
  assert.ok((await customerSays(t, '447700900811', 'hi')).length > 0);
});

test('duplicate webhooks are ignored: the same echo twice is stored once and does not extend the pause', async () => {
  const t = coexTenant();
  await echo(t, '447700900821', 'wamid.DUP');
  const first = getConversation(t.id, '447700900821').aiPausedUntil;
  await new Promise((r) => setTimeout(r, 15));
  await echo(t, '447700900821', 'wamid.DUP');
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND wa_id = '447700900821'").get(t.id).n, 1);
  assert.equal(getConversation(t.id, '447700900821').aiPausedUntil, first);
  // a duplicated inbound customer message is answered once
  const msg = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: t.settings.whatsapp.phoneNumberId }, messages: [{ from: '447700900822', id: 'wamid.IN1', timestamp: '1760000000', type: 'text', text: { body: 'hello' } }] } }] }] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    await processWebhookBody(msg, { tenantOverride: tenants.getTenant(t.id) });
    await processWebhookBody(msg, { tenantOverride: tenants.getTenant(t.id) });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND wa_id = '447700900822' AND direction = 'in'").get(t.id).n, 1);
});

test('chat history import: marked source=history, both directions, and importing the same chunk again adds nothing', async () => {
  const t = coexTenant();
  const chunk = { entry: [{ changes: [{ field: 'history', value: { metadata: { phone_number_id: t.settings.whatsapp.phoneNumberId }, history: [{ threads: [{ id: '447700900831', messages: [
    { from: '447700900831', id: 'wamid.H1', timestamp: '1760000000', type: 'text', text: { body: 'Do you have size 8?' } },
    { from: '447700900000', id: 'wamid.H2', timestamp: '1760000100', type: 'text', text: { body: 'Yes we do!' } },
  ] }] }] } }] }] };
  await processWebhookBody(chunk, { tenantOverride: tenants.getTenant(t.id) });
  await processWebhookBody(chunk, { tenantOverride: tenants.getTenant(t.id) });
  const rows = getDb().prepare("SELECT direction, source, body FROM messages WHERE tenant_id = ? AND wa_id = '447700900831' ORDER BY created_at").all(t.id);
  assert.deepEqual(rows.map((r) => [r.direction, r.source, JSON.parse(r.body).text]), [['in', 'history', 'Do you have size 8?'], ['out', 'history', 'Yes we do!']]);
  // history is never answered and never billed
  assert.equal(getConversation(t.id, '447700900831').aiPausedUntil, null);
});

test('Meta bill estimate: messages sent from the phone app are free and listed separately', async () => {
  const t = coexTenant();
  await echo(t, '447700900841', 'wamid.B1');
  await echo(t, '447700900842', 'wamid.B2');
  getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, '447700900843', 'out', 'text', '{}')").run(t.id);
  const m = monthEstimate(t.id);
  assert.equal(m.serviceMessages, 1, 'only the API message counts');
  assert.equal(m.phoneAppMessages, 2);
});

function capture() {
  const emails = [], wa = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith('https://api.resend.com/')) { emails.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: 'em' }), { status: 200 }); }
    if (String(url).startsWith('https://graph.facebook.com/')) { wa.push(JSON.parse(opts.body || '{}')); return new Response(JSON.stringify({ messages: [{ id: 'wamid.r' + wa.length }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
    return real(url, opts);
  };
  return { emails, wa, restore: () => { globalThis.fetch = real; } };
}

test('13-day rule: reminder by email and WhatsApp on day 10 (again on day 12), once each; normal API numbers never', async () => {
  const saved = [config.resendApiKey, config.emailFrom];
  Object.assign(config, { resendApiKey: 're_test', emailFrom: 'Alerts <a@example.test>' });
  const now = Date.now();
  // only these shops count in this test
  for (const x of tenants.listTenants()) if (x.settings.whatsapp?.connectedVia === 'coexistence') tenants.updateTenantSettings(x.id, { whatsapp: { lastAppActivityAt: new Date(now).toISOString() } });
  const t = coexTenant({ notifications: { staffWaIds: ['447700900999'], templates: { staffAlert: 'staff_alert' } } });
  getDb().prepare('UPDATE tenants SET owner_email = ? WHERE id = ?').run('owner@shop.test', t.id);
  tenants.updateTenantSettings(t.id, { whatsapp: { lastAppActivityAt: new Date(now - 9 * DAY).toISOString() } });
  const api = makeTenant({ whatsapp: { phoneNumberId: 'PNAPI', accessToken: 'tok', connectedVia: 'embedded_signup', numberStatus: 'active', lastAppActivityAt: new Date(now - 30 * DAY).toISOString() } });
  const cap = capture();
  try {
    assert.equal(await runAppReminders(now), 0, 'day 9: nothing yet');
    tenants.updateTenantSettings(t.id, { whatsapp: { lastAppActivityAt: new Date(now - 10 * DAY - 3600000).toISOString() } });
    assert.equal(await runAppReminders(now), 1, 'day 10: reminder');
    assert.equal(cap.emails.length, 1);
    assert.deepEqual(cap.emails[0].to, ['owner@shop.test']);
    assert.match(cap.emails[0].text, /13 days/);
    assert.equal(cap.wa.length, 1, 'WhatsApp to the owner');
    assert.equal(cap.wa[0].to, '447700900999');
    assert.equal(await runAppReminders(now + 3600000), 0, 'not again an hour later');
    assert.equal(await runAppReminders(now + 2 * DAY), 1, 'day 12: last reminder');
    assert.equal(await runAppReminders(now + 2.5 * DAY), 0);
    // the owner uses the app again: the clock restarts
    await echo(tenants.getTenant(t.id), '447700900851', 'wamid.R1');
    assert.equal(await runAppReminders(Date.now() + DAY), 0);
    assert.ok(!cap.emails.some((e) => e.to.includes(api.id)), 'normal Cloud API shop never reminded');
    assert.equal(cap.emails.length, 2);
  } finally { cap.restore(); [config.resendApiKey, config.emailFrom] = saved; }
});

test('normal Cloud API shops are unchanged: no echoes, no pause, the AI answers', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: 'PNNORMAL' } });
  assert.equal(getConversation(t.id, '447700900861').aiPausedUntil, null);
  assert.ok((await customerSays(t, '447700900861', 'hi')).length > 0);
});
