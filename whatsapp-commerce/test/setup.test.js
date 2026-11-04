import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenants } from './helpers.js';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { loadPlatformSetup } from '../src/platformSetup.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const SUPER = { Authorization: 'Bearer super-admin-test-key', 'Content-Type': 'application/json' };

test('one key signs in: whoami finds the shop for an owner key, super admin for the super key', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Key Shop' });
  let w = await (await fetch(`${base}/api/whoami`, { headers: { Authorization: 'Bearer ' + adminKey } })).json();
  assert.deepEqual(w, { super: false, tenantId: tenant.id });
  w = await (await fetch(`${base}/api/whoami`, { headers: SUPER })).json();
  assert.equal(w.super, true);
  w = await (await fetch(`${base}/api/whoami`, { headers: { Authorization: 'Bearer adm_nope' } })).json();
  assert.deepEqual(w, { super: false, tenantId: null });
}));

test('platform setup: saved in the dashboard, encrypted, secrets masked, applied to config and survives restart', () => withServer(async (base) => {
  loadPlatformSetup();
  let r = await fetch(`${base}/api/system/setup`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(r.status, 401);
  let st = await (await fetch(`${base}/api/system/setup`, { headers: SUPER })).json();
  assert.equal(st.total, 4);
  assert.ok(st.values.metaWebhookVerifyToken, 'a verify token is generated');
  st = await (await fetch(`${base}/api/system/setup`, { method: 'PATCH', headers: SUPER, body: JSON.stringify({ aiApiKey: 'sk-or-v1-abcdefghijklmnop1234', legalCompanyName: 'Karat IT Ltd', supportEmail: 'help@example.com', bogus: 'x' }) })).json();
  assert.equal(st.steps.ai, true);
  assert.equal(st.steps.business, true);
  assert.ok(!JSON.stringify(st).includes('abcdefghijklmnop'), 'secret is masked');
  assert.equal(config.aiApiKey, 'sk-or-v1-abcdefghijklmnop1234');
  assert.equal(process.env.LEGAL_COMPANY_NAME, 'Karat IT Ltd');
  const raw = getDb().prepare("SELECT value FROM kv WHERE key = 'platform_setup'").get().value;
  assert.match(raw, /^enc:v2:/);
  assert.ok(!raw.includes('sk-or'));
  // simulate a restart: config reset, then loaded from the database again
  config.aiApiKey = '';
  loadPlatformSetup();
  assert.equal(config.aiApiKey, 'sk-or-v1-abcdefghijklmnop1234');
  assert.match(await (await fetch(`${base}/legal/terms`)).text(), /Karat IT Ltd/);
  // clearing a value falls back to .env (empty here)
  st = await (await fetch(`${base}/api/system/setup`, { method: 'PATCH', headers: SUPER, body: JSON.stringify({ aiApiKey: '' }) })).json();
  assert.equal(st.steps.ai, false);
  assert.equal(config.aiApiKey, '');
}));

test('Stripe auto-setup creates 3 plans and the webhook, and reuses them the second time', () => withServer(async (base) => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const prices = {};
  let hooks = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com')) return realFetch(url, opts);
    calls.push(`${opts.method} ${u.replace('https://api.stripe.com/v1', '').split('?')[0]}`);
    const q = new URL(u).searchParams;
    const body = new URLSearchParams(opts.body ? String(opts.body) : '');
    const ok = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/prices') && opts.method === 'GET') { const p = prices[q.get('lookup_keys[0]')]; return ok({ data: p ? [p] : [] }); }
    if (u.includes('/prices')) { const p = { id: 'price_' + body.get('lookup_key') }; prices[body.get('lookup_key')] = p; return ok(p); }
    if (u.includes('/webhook_endpoints') && opts.method === 'GET') return ok({ data: hooks });
    if (u.includes('/webhook_endpoints') && opts.method === 'POST') { const h = { id: 'we_1', url: body.get('url'), secret: 'whsec_test123' }; hooks = [h]; return ok(h); }
    return ok({});
  };
  const oldUrl = config.publicUrl;
  config.publicUrl = 'https://wa.example.com';
  try {
    await fetch(`${base}/api/system/setup`, { method: 'PATCH', headers: SUPER, body: JSON.stringify({ platformStripeSecret: 'sk_test_1234567890abcdef' }) });
    let r = await (await fetch(`${base}/api/system/setup/stripe-auto`, { method: 'POST', headers: SUPER })).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.status.steps.payments, true);
    assert.equal(r.status.stripeMode, 'test');
    assert.match(config.stripePrices.growth, /^price_wc_growth_monthly_gbp_79$/);
    assert.equal(config.platformStripeWebhookSecret, 'whsec_test123');
    assert.equal(calls.filter((c) => c === 'POST /prices').length, 3);
    r = await (await fetch(`${base}/api/system/setup/stripe-auto`, { method: 'POST', headers: SUPER })).json();
    assert.equal(calls.filter((c) => c === 'POST /prices').length, 3, 'no duplicate plans');
    assert.equal(calls.filter((c) => c === 'POST /webhook_endpoints').length, 1, 'no duplicate webhook');
    assert.ok(r.done.some((d) => /already/.test(d)));
  } finally { globalThis.fetch = realFetch; config.publicUrl = oldUrl; }
}));
