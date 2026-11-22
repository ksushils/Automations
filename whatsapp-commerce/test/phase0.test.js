import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeTenant, tenants } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { sendEmail, runEmailRetries, emailLog, emailStats, purgeEmailLog, retryEmail, emailShop } from '../src/email.js';
import { handlePlatformStripeEvent, enforceGracePeriods, billingHistory, billingInfo, billingBanner } from '../src/platform.js';
import { track, jobHealth, integrityCheck, _resetJobs } from '../src/ops.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

/** Fake Resend (and alert webhook): `plan` is a list of HTTP statuses (or 'throw') returned in order, then 200s. */
function fakeMail(plan = []) {
  const real = globalThis.fetch;
  const calls = [], alerts = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://alerts.test/')) { alerts.push(JSON.parse(opts.body).text); return new Response('ok'); }
    if (!u.startsWith('https://api.resend.com/')) return real(url, opts);
    calls.push({ idem: opts.headers['Idempotency-Key'], ...JSON.parse(opts.body) });
    const next = plan.shift() ?? 200;
    if (next === 'throw') throw new Error('socket hang up');
    return new Response(JSON.stringify(next === 200 ? { id: 'em_' + calls.length } : { message: `provider error ${next}` }), { status: next, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, alerts, restore: () => { globalThis.fetch = real; } };
}
function withEmail(fn) {
  return async () => {
    const saved = { resendApiKey: config.resendApiKey, emailFrom: config.emailFrom, alertWebhookUrl: config.alertWebhookUrl };
    Object.assign(config, { resendApiKey: 're_test', emailFrom: 'Shop <alerts@example.test>', alertWebhookUrl: 'https://alerts.test/hook' });
    try { await fn(); } finally { Object.assign(config, saved); }
  };
}
const row = (id) => getDb().prepare('SELECT * FROM email_log WHERE id = ?').get(id);
const due = (id) => getDb().prepare("UPDATE email_log SET next_try_at = datetime('now', '-1 minute') WHERE id = ?").run(id);

// ---------------- email delivery ----------------
test('email: a delivered email is recorded with the provider id and an idempotency key', withEmail(async () => {
  const m = fakeMail();
  try {
    const t = makeTenant();
    const r = await sendEmail({ to: 'cust@example.test', subject: 'Your quote', text: 'Hello', tenantId: t.id, topic: 'quote' });
    assert.equal(r.ok, true);
    const rec = row(r.logId);
    assert.equal(rec.status, 'sent');
    assert.equal(rec.provider_id, 'em_1');
    assert.equal(rec.tenant_id, t.id);
    assert.equal(rec.topic, 'quote');
    assert.equal(rec.kind, 'transactional');
    assert.equal(m.calls[0].idem, `wc-email-${r.logId}`, 'retries of the same email are de-duplicated by the provider');
  } finally { m.restore(); }
}));

test('email: temporary failures are retried with back-off until delivered', withEmail(async () => {
  const m = fakeMail([503, 'throw', 429]);
  try {
    const r = await sendEmail({ to: 'cust@example.test', subject: 'Booking confirmed', text: 'See you then' });
    assert.equal(r.ok, false);
    assert.equal(r.retrying, true);
    assert.equal(row(r.logId).status, 'retrying');
    assert.equal(await runEmailRetries(), 0, 'not due yet');
    due(r.logId); await runEmailRetries(); // network error → still retrying
    assert.equal(row(r.logId).status, 'retrying');
    due(r.logId); await runEmailRetries(); // 429 → still retrying
    due(r.logId);
    assert.equal(await runEmailRetries(), 1);
    const rec = row(r.logId);
    assert.equal(rec.status, 'sent');
    assert.equal(rec.attempts, 4);
    assert.equal(m.alerts.length, 0, 'no alert for an email that got through');
  } finally { m.restore(); }
}));

test('email: a permanent failure is marked failed, alerts the platform owner, and can be retried by hand', withEmail(async () => {
  const m = fakeMail([422]);
  try {
    const r = await sendEmail({ to: 'cust@example.test', subject: 'Receipt', text: 'Thanks' });
    assert.equal(r.failed, true);
    assert.equal(row(r.logId).status, 'failed');
    assert.match(row(r.logId).error, /422/);
    await tick();
    assert.ok(m.alerts.some((a) => /Email not delivered/.test(a)), 'platform owner alerted');
    const again = await retryEmail(r.logId);
    assert.equal(again.ok, true);
    assert.equal(row(r.logId).status, 'sent');
  } finally { m.restore(); }
}));

test('email: out of retries → failed (never retried forever)', withEmail(async () => {
  const m = fakeMail(Array(10).fill(500));
  try {
    const r = await sendEmail({ to: 'x@example.test', subject: 'S', text: 'T' });
    for (let i = 0; i < 8; i++) { due(r.logId); await runEmailRetries(); }
    assert.equal(row(r.logId).status, 'failed');
    assert.equal(row(r.logId).attempts, 6); // first try + 5 retries
  } finally { m.restore(); }
}));

test('email: when email is not set up the attempt is still recorded (skipped), not silently dropped', async () => {
  const saved = [config.resendApiKey, config.emailFrom];
  config.resendApiKey = ''; config.emailFrom = '';
  try {
    const t = makeTenant();
    getDb().prepare('UPDATE tenants SET owner_email = ? WHERE id = ?').run('owner@example.test', t.id);
    const r = await emailShop(tenants.getTenant(t.id), 'New order', 'Order #1');
    assert.equal(r.skipped, true);
    const rec = row(r.logId);
    assert.equal(rec.status, 'skipped');
    assert.equal(rec.tenant_id, t.id);
    assert.equal(rec.body_text, null, 'no message body stored for mail that was never sent');
    assert.ok(emailStats().skipped >= 1);
    await assert.rejects(() => retryEmail(r.logId), /never stored/);
  } finally { [config.resendApiKey, config.emailFrom] = saved; }
});

test('email: bodies are cleared after 30 days and records removed after 180', withEmail(async () => {
  const m = fakeMail();
  try {
    const a = await sendEmail({ to: 'old@example.test', subject: 'Old', text: 'old body' });
    const b = await sendEmail({ to: 'older@example.test', subject: 'Older', text: 'older body' });
    getDb().prepare("UPDATE email_log SET created_at = datetime('now', '-40 days') WHERE id = ?").run(a.logId);
    getDb().prepare("UPDATE email_log SET created_at = datetime('now', '-200 days') WHERE id = ?").run(b.logId);
    const p = purgeEmailLog();
    assert.ok(p.cleared >= 1 && p.deleted >= 1);
    assert.equal(row(a.logId).body_text, null);
    assert.equal(row(a.logId).subject, 'Old');
    assert.equal(row(b.logId), undefined);
  } finally { m.restore(); }
}));

test('email log: a business sees only its own emails; the platform list needs the super admin key', withEmail(() => withServer(async (base) => {
  const m = fakeMail();
  try {
    const a = tenants.createTenant({ name: 'Mail A' }), b = tenants.createTenant({ name: 'Mail B' });
    await sendEmail({ to: 'a-cust@example.test', subject: 'For A', text: 'x', tenantId: a.tenant.id });
    await sendEmail({ to: 'b-cust@example.test', subject: 'For B', text: 'x', tenantId: b.tenant.id });
    const h = (k) => ({ Authorization: 'Bearer ' + k });
    const mine = await (await fetch(`${base}/api/tenants/${a.tenant.id}/email-log`, { headers: h(a.adminKey) })).json();
    assert.deepEqual(mine.emails.map((e) => e.subject), ['For A']);
    assert.equal(mine.emails[0].body_text, undefined, 'bodies are never returned');
    assert.equal((await fetch(`${base}/api/tenants/${b.tenant.id}/email-log`, { headers: h(a.adminKey) })).status, 401);
    assert.equal((await fetch(`${base}/api/system/email-log`, { headers: h(a.adminKey) })).status, 401);
    const all = await (await fetch(`${base}/api/system/email-log`, { headers: h('super-admin-test-key') })).json();
    assert.ok(all.emails.some((e) => e.subject === 'For B'));
    assert.ok(emailLog({ tenantId: b.tenant.id }).every((e) => e.tenant_id === b.tenant.id));
  } finally { m.restore(); }
})));

// ---------------- Stripe Billing ----------------
function billing(fn) {
  return withEmail(async () => {
    const saved = { platformStripeSecret: config.platformStripeSecret, platformStripeWebhookSecret: config.platformStripeWebhookSecret, stripePrices: config.stripePrices, billingGraceDays: config.billingGraceDays };
    Object.assign(config, { platformStripeSecret: 'sk_test_p0', platformStripeWebhookSecret: 'whsec_p0', stripePrices: { starter: 'price_s', growth: 'price_g', pro: 'price_p' }, billingGraceDays: 7 });
    const m = fakeMail();
    try { await fn(m); } finally { m.restore(); Object.assign(config, saved); }
  });
}
let evn = 0;
function stripeEvent(type, object, { id = `evt_${++evn}_${Date.now()}`, created = Math.floor(Date.now() / 1000), previous } = {}) {
  const raw = JSON.stringify({ id, type, created, data: { object, ...(previous ? { previous_attributes: previous } : {}) } });
  const ts = Math.floor(Date.now() / 1000);
  return { raw, sig: `t=${ts},v1=${crypto.createHmac('sha256', 'whsec_p0').update(`${ts}.${raw}`).digest('hex')}`, id };
}
const deliver = (e) => handlePlatformStripeEvent(e.raw, e.sig);
function subscribedShop() {
  const { tenant } = tenants.createTenant({ name: 'Paying Shop ' + Math.random().toString(36).slice(2, 6), plan: 'starter' });
  getDb().prepare("UPDATE tenants SET owner_email = 'owner@paying.test', stripe_customer_id = ?, subscription_id = ?, subscription_status = 'active' WHERE id = ?").run('cus_' + tenant.id, 'sub_' + tenant.id, tenant.id);
  return tenant.id;
}
const billingMails = (tid) => getDb().prepare("SELECT subject FROM email_log WHERE tenant_id = ? AND topic = 'billing' ORDER BY id").all(tid).map((r) => r.subject);

test('billing: each Stripe event is handled once, even when Stripe sends it again', billing(async () => {
  const tid = subscribedShop();
  const e = stripeEvent('invoice.payment_failed', { customer: 'cus_' + tid, subscription: 'sub_' + tid, amount_due: 2900, currency: 'gbp', attempt_count: 1 });
  assert.equal(deliver(e).status, 200);
  const again = deliver(e);
  assert.equal(again.duplicate, true);
  await tick();
  assert.deepEqual(billingMails(tid), ['We could not take your payment'], 'one email, not two');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM billing_events WHERE id = ?').get(e.id).n, 1);
  assert.equal(deliver({ raw: e.raw, sig: 't=1,v1=bad' }).status, 400, 'bad signature refused');
}));

test('billing: a late, older subscription update does not overwrite newer status', billing(async () => {
  const tid = subscribedShop();
  const now = Math.floor(Date.now() / 1000);
  deliver(stripeEvent('customer.subscription.updated', { id: 'sub_' + tid, customer: 'cus_' + tid, status: 'active', items: { data: [{ price: { id: 'price_g' } }] } }, { created: now }));
  assert.equal(tenants.getTenant(tid).plan, 'growth');
  const late = deliver(stripeEvent('customer.subscription.updated', { id: 'sub_' + tid, customer: 'cus_' + tid, status: 'past_due', items: { data: [{ price: { id: 'price_s' } }] } }, { created: now - 60 }));
  assert.match(late.note, /older update/);
  assert.equal(tenants.getTenant(tid).plan, 'growth');
  assert.equal(billingInfo(tid).subscription_status, 'active');
}));

test('billing: checkout completing after the trialing subscription event keeps the trial status', billing(async () => {
  const { tenant } = tenants.createTenant({ name: 'Trial to paid' });
  const tid = tenant.id;
  deliver(stripeEvent('customer.subscription.created', { id: 'sub_t1', customer: 'cus_t1', status: 'trialing', metadata: { tenant_id: tid }, items: { data: [{ price: { id: 'price_s' } }] } }));
  deliver(stripeEvent('checkout.session.completed', { mode: 'subscription', client_reference_id: tid, customer: 'cus_t1', subscription: 'sub_t1', metadata: { plan: 'starter' } }));
  assert.equal(billingInfo(tid).subscription_status, 'trialing');
  assert.equal(tenants.getTenant(tid).plan, 'starter');
}));

test('billing: failed payment → grace period → paused → paid again → back on, with emails at each step', billing(async () => {
  const tid = subscribedShop();
  deliver(stripeEvent('invoice.payment_failed', { customer: 'cus_' + tid, subscription: 'sub_' + tid, amount_due: 2900, currency: 'gbp' }));
  deliver(stripeEvent('customer.subscription.updated', { id: 'sub_' + tid, customer: 'cus_' + tid, status: 'past_due', items: { data: [{ price: { id: 'price_s' } }] } }));
  assert.equal(tenants.getTenant(tid).active, true, 'still working during the grace period');
  assert.match(billingBanner(tid).text, /keeps working for 7 more days/);
  assert.equal(enforceGracePeriods(), 0);
  getDb().prepare("UPDATE tenants SET payment_failed_at = datetime('now', '-8 days') WHERE id = ?").run(tid);
  assert.equal(enforceGracePeriods(), 1);
  assert.equal(tenants.getTenant(tid).active, false, 'paused after the grace period');
  assert.match(billingBanner(tid).text, /paused/);
  // a later "still past_due" update must not switch it back on
  deliver(stripeEvent('customer.subscription.updated', { id: 'sub_' + tid, customer: 'cus_' + tid, status: 'past_due', items: { data: [{ price: { id: 'price_s' } }] } }, { created: Math.floor(Date.now() / 1000) + 5 }));
  assert.equal(tenants.getTenant(tid).active, false);
  deliver(stripeEvent('invoice.paid', { customer: 'cus_' + tid, subscription: 'sub_' + tid, amount_paid: 2900, currency: 'gbp' }));
  assert.equal(tenants.getTenant(tid).active, true, 'back on once paid');
  assert.equal(billingInfo(tid).payment_failed_at, null);
  await tick();
  assert.deepEqual(billingMails(tid), ['We could not take your payment', 'Your assistant is paused', 'Payment received – thank you']);
  const notes = billingHistory(tid).map((h) => h.note).join(' | ');
  assert.match(notes, /Payment failed \(£29\.00\)/);
  assert.match(notes, /Payment received \(£29\.00\)/);
  assert.match(notes, /grace period/);
}));

test('billing: trial ending soon and cancellation are explained by email; cancellation pauses the assistant', billing(async () => {
  const tid = subscribedShop();
  deliver(stripeEvent('customer.subscription.trial_will_end', { id: 'sub_' + tid, customer: 'cus_' + tid, trial_end: Math.floor(Date.now() / 1000) + 3 * 86400 }));
  deliver(stripeEvent('customer.subscription.updated', { id: 'sub_' + tid, customer: 'cus_' + tid, status: 'active', cancel_at_period_end: true, current_period_end: Math.floor(Date.now() / 1000) + 10 * 86400, items: { data: [{ price: { id: 'price_s' } }] } }, { previous: { cancel_at_period_end: false } }));
  assert.equal(tenants.getTenant(tid).active, true, 'still active until the period ends');
  deliver(stripeEvent('customer.subscription.deleted', { id: 'sub_' + tid, customer: 'cus_' + tid, status: 'canceled', items: { data: [] } }, { created: Math.floor(Date.now() / 1000) + 10 }));
  assert.equal(tenants.getTenant(tid).active, false);
  await tick();
  assert.deepEqual(billingMails(tid), ['Your free trial ends soon', 'Your subscription will end', 'Your subscription has ended']);
}));

test('billing: events for an unknown business are recorded and ignored; malformed bodies are refused', billing(async () => {
  const r = deliver(stripeEvent('invoice.payment_failed', { customer: 'cus_nobody', subscription: 'sub_nobody', amount_due: 100 }));
  assert.equal(r.status, 200);
  assert.match(r.note, /unknown business/);
  const ts = Math.floor(Date.now() / 1000);
  const raw = 'not json';
  assert.equal(handlePlatformStripeEvent(raw, `t=${ts},v1=${crypto.createHmac('sha256', 'whsec_p0').update(`${ts}.${raw}`).digest('hex')}`).status, 400);
}));

test('billing: the owner sees billing history; staff and other businesses cannot', billing(() => withServer(async (base) => {
  const tid = subscribedShop();
  const key = tenants.rotateKeys(tid).adminKey;
  deliver(stripeEvent('invoice.paid', { customer: 'cus_' + tid, subscription: 'sub_' + tid, amount_paid: 7900, currency: 'gbp' }));
  const r = await (await fetch(`${base}/api/tenants/${tid}/billing`, { headers: { Authorization: 'Bearer ' + key } })).json();
  assert.match(r.history[0].note, /Payment received \(£79\.00\)/);
  const other = tenants.createTenant({ name: 'Nosy' });
  assert.equal((await fetch(`${base}/api/tenants/${tid}/billing`, { headers: { Authorization: 'Bearer ' + other.adminKey } })).status, 401);
})));

// ---------------- background jobs and health ----------------
test('jobs: failures are counted, alert after 3 in a row, and clear on the next success', withEmail(async () => {
  _resetJobs();
  const m = fakeMail();
  try {
    let fail = true;
    const job = () => track('test-job', 60000, () => { if (fail) throw new Error('boom'); return 4; });
    for (let i = 0; i < 3; i++) await job();
    let j = jobHealth().find((x) => x.name === 'test-job');
    assert.equal(j.state, 'failing');
    assert.equal(j.failures, 3);
    assert.equal(j.lastError, 'boom');
    await tick();
    assert.ok(m.alerts.some((a) => /test-job.*failed 3 times/.test(a)));
    fail = false;
    assert.equal(await job(), 4);
    j = jobHealth().find((x) => x.name === 'test-job');
    assert.equal(j.state, 'ok');
    assert.equal(j.failures, 0);
    assert.equal(j.lastResult, 4);
    assert.equal(jobHealth(Date.now() + 10 * 60000).find((x) => x.name === 'test-job').state, 'stale', 'not started for 3x its interval');
  } finally { m.restore(); _resetJobs(); }
}));

test('health: /health reports the database and whether background jobs are OK; integrity check passes', () => withServer(async (base) => {
  _resetJobs();
  let h = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(h, { ok: true, jobs: 'ok' });
  await track('broken-job', 60000, () => { throw new Error('nope'); });
  h = await (await fetch(`${base}/health`)).json();
  assert.equal(h.jobs, 'degraded');
  assert.ok(!JSON.stringify(h).includes('nope'), 'no internal details on the public endpoint');
  _resetJobs();
  assert.equal(integrityCheck().ok, true);
  const st = await (await fetch(`${base}/api/system/status`, { headers: { Authorization: 'Bearer super-admin-test-key' } })).json();
  assert.equal(st.integrity.ok, true);
  assert.ok('emails' in st && 'jobs' in st);
}));
