import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeTenant, tenants } from './helpers.js';
import { createApp } from '../src/server.js';
import { toWaId, runAbandonedCheckouts } from '../src/routes/storeWebhooks.js';
import { getDb } from '../src/db.js';

test('phone normalisation', () => {
  assert.equal(toWaId('07700 900123'), '447700900123');
  assert.equal(toWaId('+44 7700 900123'), '447700900123');
  assert.equal(toWaId('0044 7700900123'), '447700900123');
  assert.equal(toWaId('123'), null);
});

test('Shopify website order → confirmation + shipping templates; abandoned checkout recovered once', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: 'P', accessToken: 'tok' }, store: { shopify: { webhookSecret: 'shpsec' } }, notifications: { storeTemplates: {
    orderConfirmation: { enabled: true, template: 'order_confirmation' }, shipping: { enabled: true, template: 'shipping_update' }, abandonedCheckout: { enabled: true, template: 'abandoned_cart', afterMinutes: 30, requireMarketingConsent: true } } } });
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/webhooks/store/${t.id}/${t.settings.storeWebhookSecret}`;
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (u, opts) => (String(u).startsWith('https://graph.facebook.com') ? (sent.push(JSON.parse(opts.body)), new Response('{"messages":[{"id":"x"}]}')) : realFetch(u, opts));
  const post = (topic, body, secret = 'shpsec') => {
    const raw = JSON.stringify(body);
    return realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-hmac-sha256': crypto.createHmac('sha256', secret).update(raw).digest('base64') }, body: raw });
  };
  try {
    assert.equal((await post('orders/create', { id: 1 }, 'wrong')).status, 401);
    // abandoned checkouts: one with consent, one without, one later completed
    await post('checkouts/create', { token: 'ck1', phone: '07700900111', abandoned_checkout_url: 'https://shop/ck1', buyer_accepts_marketing: true, shipping_address: { first_name: 'Ann' } });
    await post('checkouts/create', { token: 'ck2', phone: '07700900222', abandoned_checkout_url: 'https://shop/ck2', buyer_accepts_marketing: false });
    await post('checkouts/create', { token: 'ck3', phone: '07700900333', abandoned_checkout_url: 'https://shop/ck3', buyer_accepts_marketing: true });
    const order = { id: 555, name: '#1055', checkout_token: 'ck3', total_price: '42.00', phone: '07700900333', shipping_address: { first_name: 'Cy' }, fulfillment_status: null };
    await post('orders/create', order);
    await post('orders/create', order); // duplicate delivery
    await post('orders/fulfilled', { ...order, fulfillment_status: 'fulfilled', fulfillments: [{ tracking_url: 'https://track/abc' }] });
    await new Promise((r) => setTimeout(r, 50));
    const conf = sent.filter((m) => m.template?.name === 'order_confirmation');
    assert.equal(conf.length, 1);
    assert.equal(conf[0].to, '447700900333');
    assert.deepEqual(conf[0].template.components[0].parameters.map((p) => p.text), ['Cy', '#1055', 'Test Shop', '£42.00']);
    const ship = sent.filter((m) => m.template?.name === 'shipping_update');
    assert.equal(ship[0].template.components[0].parameters[2].text, 'https://track/abc');

    getDb().prepare("UPDATE store_events SET created_at = datetime('now', '-1 hour') WHERE tenant_id = ?").run(t.id);
    await runAbandonedCheckouts();
    await runAbandonedCheckouts();
    const ab = sent.filter((m) => m.template?.name === 'abandoned_cart');
    assert.deepEqual(ab.map((m) => m.to), ['447700900111']); // no consent → skipped; completed → skipped; only once
    assert.equal(ab[0].template.components[0].parameters[2].text, 'https://shop/ck1');
    assert.equal(getDb().prepare("SELECT status FROM store_events WHERE tenant_id = ? AND ref = 'ck2'").get(t.id).status, 'skipped_no_consent');
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
