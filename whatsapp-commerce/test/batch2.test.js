import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { makeTenant, tenants } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { classify, checkConnection, connectionStatus, runConnectionChecks, connectionBanner } from '../src/waHealth.js';
import { entitlements, staffSeatsLeft } from '../src/entitlements.js';
import { sendEmail, handleResendEvent, verifySvix, suppressed } from '../src/email.js';
import { createStaff } from '../src/staff.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
function fakeFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => { const r = await handler(String(url), opts); return r === undefined ? real(url, opts) : r; };
  return () => { globalThis.fetch = real; };
}
const okJson = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
function emailOn() {
  const saved = { resendApiKey: config.resendApiKey, emailFrom: config.emailFrom, alertWebhookUrl: config.alertWebhookUrl };
  Object.assign(config, { resendApiKey: 're_test', emailFrom: 'A <a@example.test>', alertWebhookUrl: '' });
  return () => Object.assign(config, saved);
}

// ---------------- WhatsApp connection health ----------------
test('connection health: Meta answers are turned into one plain state', () => {
  assert.equal(classify({ status: 'CONNECTED', quality_rating: 'GREEN', name_status: 'APPROVED', display_phone_number: '+44 7700 900111' }).state, 'ok');
  assert.equal(classify({ status: 'DISCONNECTED' }).state, 'disconnected');
  assert.equal(classify({ status: 'FLAGGED' }).state, 'disconnected');
  assert.equal(classify({ status: 'CONNECTED', name_status: 'PENDING_REVIEW' }).state, 'approval_pending');
  assert.equal(classify({ status: 'CONNECTED', name_status: 'DECLINED' }).state, 'name_declined');
  assert.equal(classify({ status: 'CONNECTED', quality_rating: 'RED' }).state, 'quality_low');
  assert.equal(classify(null, new Error('Meta: Error validating access token: Session has expired')).state, 'token_invalid');
  assert.equal(classify(null, new Error('WhatsApp is not connected')).state, 'not_connected');
  assert.equal(classify(null, new Error('fetch failed')).state, 'check_failed');
});

test('connection health: expired token → owner emailed once, banner shown; fixed → "working again"', async () => {
  const restoreCfg = emailOn();
  let meta = { error: { message: 'Error validating access token: Session has expired', code: 190 } }, status = 400;
  const mails = [];
  const restore = fakeFetch((u, o) => {
    if (u.startsWith('https://graph.facebook.com')) return okJson(meta, status);
    if (u.startsWith('https://api.resend.com')) { mails.push(JSON.parse(o.body).subject); return okJson({ id: 'em' + mails.length }); }
  });
  try {
    const t = makeTenant({ whatsapp: { phoneNumberId: 'PN1', accessToken: 'EAAG-old' } });
    getDb().prepare("UPDATE tenants SET owner_email = 'owner@example.test' WHERE id = ?").run(t.id);
    let s = await checkConnection(tenants.getTenant(t.id));
    assert.equal(s.state, 'token_invalid');
    assert.match(connectionBanner(t.id).text, /expired or was removed/);
    await checkConnection(tenants.getTenant(t.id)); // still broken – no second email
    await tick();
    assert.deepEqual(mails, ['Action needed: your WhatsApp connection']);
    meta = { status: 'CONNECTED', quality_rating: 'GREEN', display_phone_number: '+44 7700 900111' }; status = 200;
    s = await checkConnection(tenants.getTenant(t.id));
    assert.equal(s.state, 'ok');
    assert.equal(connectionBanner(t.id), null);
    await tick();
    assert.deepEqual(mails, ['Action needed: your WhatsApp connection', 'Your WhatsApp connection is working again']);
  } finally { restore(); restoreCfg(); }
});

test('connection health: a single failed call to Meta keeps the last good state; three in a row is reported', async () => {
  let fail = false;
  const restore = fakeFetch((u) => { if (u.startsWith('https://graph.facebook.com')) { if (fail) throw new Error('fetch failed'); return okJson({ status: 'CONNECTED' }); } });
  try {
    const t = makeTenant({ whatsapp: { phoneNumberId: 'PN2', accessToken: 'EAAG-x' } });
    assert.equal((await checkConnection(tenants.getTenant(t.id))).state, 'ok');
    fail = true;
    assert.equal((await checkConnection(tenants.getTenant(t.id))).state, 'ok');
    assert.equal((await checkConnection(tenants.getTenant(t.id))).state, 'ok');
    assert.equal((await checkConnection(tenants.getTenant(t.id))).state, 'check_failed');
  } finally { restore(); }
});

test('connection health job: only connected, active, WhatsApp plans, at most once a day each', async () => {
  let calls = 0;
  const restore = fakeFetch((u) => { if (u.startsWith('https://graph.facebook.com')) { if (!u.includes('/debug_token')) calls++; return okJson({ status: 'CONNECTED' }); } }); // the expiry check is a second call per business
  try {
    for (const r of getDb().prepare('SELECT id FROM tenants').all()) getDb().prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`wahealth:${r.id}`, JSON.stringify({ state: 'ok', checkedAt: new Date().toISOString() }));
    const a = makeTenant({ whatsapp: { phoneNumberId: 'PN3', accessToken: 'EAAG-a' } });
    makeTenant(); // not connected
    const { tenant: free } = tenants.createTenant({ name: 'Free one', plan: 'free' });
    tenants.updateTenantSettings(free.id, { whatsapp: { phoneNumberId: 'PN4', accessToken: 'EAAG-f' } });
    assert.equal(await runConnectionChecks(), 1);
    assert.equal(connectionStatus(a.id).state, 'ok');
    assert.equal(await runConnectionChecks(), 0, 'checked today already');
    assert.equal(calls, 1);
  } finally { restore(); }
});

test('token expiry: a warning 7 days ahead (banner + one email per expiry date); permanent tokens never warn', async () => {
  const { expirySoon, tokenExpiry } = await import('../src/waHealth.js');
  const now = Date.parse('2026-11-22T12:00:00Z');
  assert.equal(expirySoon({ expiresAt: null, dataAccessExpiresAt: null }, now), null, 'never expires');
  assert.equal(expirySoon({ expiresAt: '2026-12-20T00:00:00Z' }, now), null, 'weeks away');
  assert.deepEqual(expirySoon({ expiresAt: '2026-12-20T00:00:00Z', dataAccessExpiresAt: '2026-11-25T12:00:00Z' }, now), { ends: '2026-11-25T12:00:00.000Z', days: 3 }, 'the soonest of the two counts');
  assert.equal(expirySoon({ expiresAt: '2026-11-01T00:00:00Z' }, now), null, 'already past: that is token_invalid, not a warning');
  const restoreCfg = emailOn();
  let exp = Math.floor(Date.now() / 1000) + 3 * 86400;
  const mails = [];
  const restore = fakeFetch((u, o) => {
    if (u.includes('/debug_token')) { assert.ok(!u.includes('undefined')); return okJson({ data: { is_valid: true, expires_at: exp, data_access_expires_at: 0 } }); }
    if (u.startsWith('https://graph.facebook.com')) return okJson({ status: 'CONNECTED', quality_rating: 'GREEN' });
    if (u.startsWith('https://api.resend.com')) { mails.push(JSON.parse(o.body).subject); return okJson({ id: 'em' + mails.length }); }
  });
  try {
    const t = makeTenant({ whatsapp: { phoneNumberId: 'PN9', accessToken: 'EAAG-user-token' } });
    getDb().prepare("UPDATE tenants SET owner_email = 'owner@example.test' WHERE id = ?").run(t.id);
    let s = await checkConnection(tenants.getTenant(t.id));
    assert.equal(s.state, 'token_expiring');
    assert.match(s.detail, /in 3 days/);
    assert.equal(connectionBanner(t.id).level, 'warn');
    await checkConnection(tenants.getTenant(t.id));
    await tick();
    assert.deepEqual(mails, ['Your WhatsApp connection needs renewing soon'], 'one email, not one a day');
    exp = 0; // reconnected with a permanent token
    s = await checkConnection(tenants.getTenant(t.id));
    assert.equal(s.state, 'ok'); assert.equal(s.tokenExpiresAt, null);
    assert.equal(connectionBanner(t.id), null);
    assert.equal((await tokenExpiry({ settings: { whatsapp: {} } })), null);
  } finally { restore(); restoreCfg(); }
});

// ---------------- entitlements ----------------
test('entitlements: usage and limits come from the plan; staff seats are enforced on the server', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Seats Ltd', plan: 'starter' });
  const e = entitlements(tenants.getTenant(tenant.id));
  assert.equal(e.label, 'Starter');
  assert.equal(e.features.whatsapp, true);
  assert.equal(e.features.campaigns, false);
  assert.equal(e.limits.find((l) => l.key === 'staff').included, 3);
  assert.ok(e.external.some((x) => /Meta/.test(x.label)), 'Meta fees shown separately');
  const h = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/api/tenants/${tenant.id}/staff`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Helper ' + i }) })).status, 201);
  const r = await fetch(`${base}/api/tenants/${tenant.id}/staff`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'One too many' }) });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /3 team member/);
  assert.equal(staffSeatsLeft(tenants.getTenant(tenant.id)), 0);
  const viaApi = await (await fetch(`${base}/api/tenants/${tenant.id}/entitlements`, { headers: h })).json();
  assert.equal(viaApi.limits.find((l) => l.key === 'staff').used, 3);
}));

test('entitlements: a business cannot give itself a better plan or campaigns from the browser', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Sneaky Ltd', plan: 'starter' });
  const h = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: h, body: JSON.stringify({ plan: 'pro', broadcasts: true, ai: { budgetUsd: 1000 } }) });
  await fetch(`${base}/api/tenants/${tenant.id}/meta`, { method: 'PATCH', headers: h, body: JSON.stringify({ plan: 'pro' }) });
  const t = tenants.getTenant(tenant.id);
  assert.equal(t.plan, 'starter');
  assert.notEqual(t.settings.ai?.budgetUsd, 1000, 'AI budget cap not raised by the shop');
  const camp = await fetch(`${base}/api/tenants/${tenant.id}/campaigns`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'x', template: 'y' }) });
  assert.equal(camp.status, 403);
  // Free plan: no "Powered by"-free chat, no WhatsApp; the plan list itself comes from the server
  const src = fs.readFileSync(new URL('../src/tenants.js', import.meta.url), 'utf8');
  assert.match(src, /free: \{[^}]*whatsapp: false[^}]*badge: true/);
}));

// ---------------- Resend webhook ----------------
const SECRET = 'whsec_' + Buffer.from('resend-test-secret-0123456789').toString('base64');
function signed(body, { ts = Math.floor(Date.now() / 1000), id = 'msg_' + Math.random().toString(36).slice(2) } = {}) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  return { raw, headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` } };
}

test('resend webhook: signature checked; bounces and spam complaints are recorded and the address is not mailed again', async () => {
  const restoreCfg = emailOn();
  const saved = config.resendWebhookSecret;
  config.resendWebhookSecret = SECRET;
  let n = 0;
  const restore = fakeFetch((u) => { if (u.startsWith('https://api.resend.com')) return okJson({ id: `re_${++n}` }); });
  try {
    const a = await sendEmail({ to: 'bouncy@example.test', subject: 'Hi', text: 'x' });
    const b = await sendEmail({ to: 'grumpy@example.test', subject: 'Hi', text: 'x' });
    const c = await sendEmail({ to: 'happy@example.test', subject: 'Hi', text: 'x' });
    const providerOf = (id) => getDb().prepare('SELECT provider_id FROM email_log WHERE id = ?').get(id).provider_id;
    const bad = signed({ type: 'email.bounced', data: { email_id: providerOf(a.logId) } });
    assert.equal(handleResendEvent(bad.raw, { ...bad.headers, 'svix-signature': 'v1,AAAA' }).status, 400);
    assert.equal(handleResendEvent(bad.raw, signed({}, { ts: 1 }).headers).status, 400, 'old or mismatched timestamp');
    assert.equal(handleResendEvent(bad.raw, bad.headers).status, 200);
    let e = signed({ type: 'email.complained', data: { email_id: providerOf(b.logId) } });
    handleResendEvent(e.raw, e.headers);
    e = signed({ type: 'email.delivered', data: { email_id: providerOf(c.logId) } });
    handleResendEvent(e.raw, e.headers);
    const row = (id) => getDb().prepare('SELECT status, delivered_at FROM email_log WHERE id = ?').get(id);
    assert.equal(row(a.logId).status, 'bounced');
    assert.equal(row(b.logId).status, 'complained');
    assert.ok(row(c.logId).delivered_at);
    assert.ok(suppressed('Bouncy@Example.test'));
    const again = await sendEmail({ to: 'bouncy@example.test', subject: 'Hi again', text: 'x' });
    assert.equal(again.suppressed, true);
    assert.equal(n, 3, 'the suppressed email never reached the provider');
    assert.equal(verifySvix('{}', {}, SECRET), false);
  } finally { restore(); restoreCfg(); config.resendWebhookSecret = saved; }
});

test('resend webhook route answers 400 without a valid signature', () => withServer(async (base) => {
  const r = await fetch(`${base}/webhooks/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"email.bounced"}' });
  assert.equal(r.status, 400);
}));

// ---------------- CSP ----------------
test('dashboard sends a safe enforced CSP plus a full report-only policy; reports are counted', () => withServer(async (base) => {
  const r = await fetch(`${base}/admin/`);
  assert.match(r.headers.get('content-security-policy'), /object-src 'none'.*frame-ancestors 'none'/);
  assert.match(r.headers.get('content-security-policy-report-only'), /default-src 'self'.*report-uri \/csp-report/);
  const home = await fetch(`${base}/`);
  assert.equal(home.headers.get('content-security-policy'), null, 'public site and chat widget pages are not affected');
  const rep = await fetch(`${base}/csp-report`, { method: 'POST', headers: { 'Content-Type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'https://evil.example/x.js?y=1' } }) });
  assert.equal(rep.status, 204);
  const st = await (await fetch(`${base}/api/system/status`, { headers: { Authorization: 'Bearer super-admin-test-key' } })).json();
  assert.ok(st.cspReports.some((c) => c.violation === 'script-src https://evil.example/x.js'));
}));

test('deploy and rollback scripts exist and keep the safety steps', (t) => {
  // the scripts live in the repository, not in the app image (the deploy runs the tests inside the image)
  if (!fs.existsSync(new URL('../scripts/deploy-vps.sh', import.meta.url))) return t.skip('scripts/ is not part of the app image');
  const d = fs.readFileSync(new URL('../scripts/deploy-vps.sh', import.meta.url), 'utf8');
  for (const step of ['VACUUM INTO', 'whatsapp-commerce:previous', 'node --test', '# fail 0', 'reset --keep', '/health']) assert.ok(d.includes(step), step);
  assert.ok(!/traefik/i.test(d.replace(/^#.*$/gm, '')), 'never touches Traefik');
  const r = fs.readFileSync(new URL('../scripts/rollback-vps.sh', import.meta.url), 'utf8');
  assert.ok(r.includes('before-rollback-'), 'keeps the current database before restoring a snapshot');
});
