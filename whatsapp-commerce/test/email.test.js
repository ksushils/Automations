import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, say } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { updateTenantSettings, getTenant } from '../src/tenants.js';
import { alertEmails, emailShop } from '../src/email.js';

function captureResend() {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sent.push({ auth: opts.headers.Authorization, ...JSON.parse(opts.body) });
      return new Response(JSON.stringify({ id: 'em_' + sent.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return real(url, opts);
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

test('alert emails go to the sign-up email by default, or to the list in Settings', () => {
  const t = makeTenant();
  getDb().prepare('UPDATE tenants SET owner_email = ? WHERE id = ?').run('owner@shop.test', t.id);
  assert.deepEqual(alertEmails(getTenant(t.id)), ['owner@shop.test']);
  updateTenantSettings(t.id, { notifications: { alertEmails: ['a@shop.test', 'not-an-email', 'b@shop.test'] } });
  assert.deepEqual(alertEmails(getTenant(t.id)), ['a@shop.test', 'b@shop.test']);
  updateTenantSettings(t.id, { notifications: { alertEmails: [] } });
  assert.deepEqual(alertEmails(getTenant(t.id)), ['owner@shop.test'], 'an empty list falls back to the sign-up email');
});

test('nothing is sent (and nothing breaks) when email is not set up', async () => {
  const cap = captureResend();
  const saved = [config.resendApiKey, config.emailFrom];
  config.resendApiKey = ''; config.emailFrom = '';
  try {
    const t = makeTenant();
    getDb().prepare('UPDATE tenants SET owner_email = ? WHERE id = ?').run('owner@shop.test', t.id);
    const r = await emailShop(getTenant(t.id), 'x', 'y');
    assert.equal(r.skipped, true);
    assert.equal(cap.sent.length, 0);
  } finally { cap.restore(); [config.resendApiKey, config.emailFrom] = saved; }
});

test('a new order emails the shop owner with the order details', async () => {
  const cap = captureResend();
  const saved = [config.resendApiKey, config.emailFrom];
  config.resendApiKey = 're_test_123'; config.emailFrom = 'Shop Alerts <orders@example.test>';
  try {
    const t = makeTenant();
    getDb().prepare('UPDATE tenants SET owner_email = ? WHERE id = ?').run('owner@shop.test', t.id);
    const wa = '447700900555';
    await say(t, wa, { action: 'p:mug' });
    await say(t, wa, { action: 'v:mug|mug' });
    await say(t, wa, { action: 'q:1' });
    await say(t, wa, 'checkout');
    await say(t, wa, { action: 'ful:pickup' });
    await say(t, wa, { action: 'pay:cod' });
    await say(t, wa, { action: 'confirm' });
    await new Promise((r) => setTimeout(r, 50));
    const order = getDb().prepare('SELECT store_order_name FROM orders WHERE tenant_id = ?').get(t.id);
    assert.ok(order, 'an order was placed');
    assert.equal(cap.sent.length, 1, 'one alert email');
    const e = cap.sent[0];
    assert.equal(e.auth, 'Bearer re_test_123');
    assert.deepEqual(e.to, ['owner@shop.test']);
    assert.equal(e.from, 'Shop Alerts <orders@example.test>');
    assert.match(e.subject, new RegExp(`New order ${order.store_order_name.replace('#', '#?')}`));
    assert.match(e.text, /White Mug/);
    assert.match(e.html, /See the order/);
  } finally { cap.restore(); [config.resendApiKey, config.emailFrom] = saved; }
});
