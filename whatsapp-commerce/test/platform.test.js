import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeTenant, tenants } from './helpers.js';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const json = (r) => r.json();

test('self-serve sign-up creates a trialing shop; validation; legal pages', () => withServer(async (base) => {
  let r = await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ business: 'Bloom Florist', email: 'owner@bloom.co.uk', plan: 'growth', acceptTerms: true }) });
  assert.equal(r.status, 201);
  const b = await r.json();
  assert.match(b.adminKey, /^adm_/);
  const row = getDb().prepare('SELECT plan, owner_email, subscription_status, trial_ends_at FROM tenants WHERE id = ?').get(b.tenantId);
  assert.equal(row.plan, 'growth');
  assert.equal(row.owner_email, 'owner@bloom.co.uk');
  assert.equal(row.subscription_status, 'trialing');
  assert.ok(Date.parse(row.trial_ends_at + 'Z') > Date.now() + 13 * 864e5);
  r = await fetch(`${base}/api/tenants/${b.tenantId}`, { headers: { Authorization: 'Bearer ' + b.adminKey } });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ business: 'X Y', email: 'bad', acceptTerms: true }) });
  assert.equal(r.status, 400);
  assert.match(await (await fetch(`${base}/legal/dpa`)).text(), /Article 28 UK GDPR/);
  assert.match(await (await fetch(`${base}/signup`)).text(), /Start free trial/);
}));

test('platform Stripe billing: checkout session + webhooks sync plan and suspend on cancel', () => withServer(async (base) => {
  Object.assign(config, { platformStripeSecret: 'sk_test_platform', platformStripeWebhookSecret: 'whsec_plat', stripePrices: { starter: 'price_s', growth: 'price_g', pro: 'price_p' } });
  const { tenant, adminKey } = tenants.createTenant({ name: 'Billing Shop' });
  const realFetch = globalThis.fetch;
  let stripeReq;
  globalThis.fetch = async (u, o) => (String(u).startsWith('https://api.stripe.com') ? ((stripeReq = { u: String(u), body: new URLSearchParams(o.body) }), new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/sub_1' }))) : realFetch(u, o));
  try {
    const r = await (await realFetch(`${base}/api/tenants/${tenant.id}/billing/checkout`, { method: 'POST', headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' }, body: '{"plan":"pro"}' })).json();
    assert.equal(r.url, 'https://checkout.stripe.com/c/pay/sub_1');
    assert.equal(stripeReq.body.get('mode'), 'subscription');
    assert.equal(stripeReq.body.get('line_items[0][price]'), 'price_p');
    assert.equal(stripeReq.body.get('client_reference_id'), tenant.id);
  } finally { globalThis.fetch = realFetch; }

  const send = (ev) => {
    const raw = JSON.stringify(ev);
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_plat').update(`${ts}.${raw}`).digest('hex');
    return fetch(`${base}/webhooks/platform-stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: raw });
  };
  assert.equal((await send({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: tenant.id, customer: 'cus_1', subscription: 'sub_1', metadata: { plan: 'pro' } } } })).status, 200);
  assert.equal(tenants.getTenant(tenant.id).plan, 'pro');
  await send({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_g' } }] } } } });
  assert.equal(tenants.getTenant(tenant.id).plan, 'growth');
  await send({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', items: { data: [] } } } });
  assert.equal(tenants.getTenant(tenant.id).active, false);
  const bad = await fetch(`${base}/webhooks/platform-stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
  assert.equal(bad.status, 400);
  Object.assign(config, { platformStripeSecret: '', platformStripeWebhookSecret: '' });
}));

test('Meta Embedded Signup exchanges code, subscribes WABA, registers number; app-level webhook routes by number', () => withServer(async (base) => {
  Object.assign(config, { metaAppId: 'app1', metaAppSecret: 'appsecret1', metaConfigId: 'cfg1', metaWebhookVerifyToken: 'vt1' });
  const t = makeTenant();
  const { adminKey } = { adminKey: tenants.rotateKeys(t.id).adminKey };
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u, o = {}) => {
    const url = String(u);
    if (!url.startsWith('https://graph.facebook.com')) return realFetch(u, o);
    calls.push(`${o.method || 'GET'} ${new URL(url).pathname}`);
    if (url.includes('oauth/access_token')) return new Response(JSON.stringify({ access_token: 'EAAB-business-token' }));
    if (url.includes('/PN9?')) return new Response(JSON.stringify({ display_phone_number: '+44 7700 900999', verified_name: 'Test Shop' }));
    return new Response(JSON.stringify({ success: true, messages: [{ id: 'm1' }] }));
  };
  try {
    const r = await (await realFetch(`${base}/api/tenants/${t.id}/whatsapp/embedded`, { method: 'POST', headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'CODE', phoneNumberId: 'PN9', wabaId: 'WABA9' }) })).json();
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.displayPhoneNumber, '+44 7700 900999');
    assert.ok(calls.some((c) => c.endsWith('/WABA9/subscribed_apps')));
    assert.ok(calls.some((c) => c.endsWith('/PN9/register')));
    const s = tenants.getTenant(t.id).settings;
    assert.equal(s.whatsapp.accessToken, 'EAAB-business-token');
    assert.equal(s.business.whatsappNumber, '447700900999');

    // app-level webhook
    let v = await realFetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt1&hub.challenge=77`);
    assert.equal(await v.text(), '77');
    const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN9' }, contacts: [{ wa_id: '447700900888', profile: { name: 'Zed' } }], messages: [{ from: '447700900888', id: 'wamid.app1', timestamp: '1', type: 'text', text: { body: 'hi' } }] } }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret1').update(payload).digest('hex');
    v = await realFetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body: payload });
    assert.equal(v.status, 200);
    await new Promise((x) => setTimeout(x, 100));
    assert.ok(calls.some((c) => c.endsWith('/PN9/messages')), 'bot replied through the connected number');
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config, { metaAppId: '', metaAppSecret: '', metaConfigId: '', metaWebhookVerifyToken: '' });
  }
}));
