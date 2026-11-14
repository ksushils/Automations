import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { shopifyStore } from '../src/stores/shopify.js';
import { wooStore } from '../src/stores/woocommerce.js';
import { mapStoreEvent } from '../src/routes/storeWebhooks.js';
import { toGraphPayload } from '../src/whatsapp/cloudApi.js';
import { verifyMetaSignature, encrypt, decrypt } from '../src/crypto.js';
import { createSessionToken, verifySessionToken } from '../src/session.js';
import crypto from 'node:crypto';

const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('shopify: search maps products and draft order returns invoice URL', async () => {
  const calls = [];
  const f = mock.method(globalThis, 'fetch', async (url, opts) => {
    const { query, variables } = JSON.parse(opts.body);
    calls.push({ url, query, variables, token: opts.headers['X-Shopify-Access-Token'] });
    if (query.includes('products(first')) {
      return ok({ data: { products: { nodes: [{ id: 'gid://shopify/Product/1', title: 'Hoodie', handle: 'hoodie', description: '<p>Warm</p>', status: 'ACTIVE', featuredImage: { url: 'https://cdn/x.jpg' }, variants: { nodes: [{ id: 'gid://shopify/ProductVariant/11', title: 'Default Title', price: '39.00', availableForSale: true }] } }] } } });
    }
    if (query.includes('draftOrderCreate')) return ok({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/5', name: '#D5', invoiceUrl: 'https://shop/invoices/abc', totalPriceSet: { shopMoney: { amount: '39.00', currencyCode: 'GBP' } } }, userErrors: [] } } });
    if (query.includes('shop { currencyCode }')) return ok({ data: { shop: { currencyCode: 'GBP' } } });
    throw new Error('unexpected ' + query);
  });
  const s = shopifyStore({ domain: 'https://demo.myshopify.com/', adminToken: 'shpat_x' });
  const [p] = await s.searchProducts('hoodie');
  assert.equal(p.title, 'Hoodie');
  assert.equal(p.description, 'Warm');
  assert.equal(p.variants[0].title, 'Hoodie');
  assert.match(calls[0].url, /^https:\/\/demo\.myshopify\.com\/admin\/api\/.+\/graphql\.json$/);
  assert.equal(calls[0].token, 'shpat_x');
  const o = await s.createOrder({ items: [{ variantId: p.variants[0].id, quantity: 1 }], customer: { name: 'Jane', phone: '447700900000' }, paymentMethod: 'payment_link', fulfilment: 'pickup' });
  assert.equal(o.checkoutUrl, 'https://shop/invoices/abc');
  assert.equal(o.total, 39);
  f.mock.restore();
});

test('woocommerce: creates COD order with variation + phone-checked status', async () => {
  let posted;
  const f = mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = new URL(url);
    assert.ok(opts.headers.Authorization.startsWith('Basic '));
    if (u.pathname.endsWith('/orders') && opts.method === 'POST') { posted = JSON.parse(opts.body); return ok({ id: 77, number: '77', total: '20.00', currency: 'GBP', payment_url: 'https://x/pay' }); }
    if (u.pathname.endsWith('/orders/77')) return ok({ id: 77, number: '77', status: 'processing', billing: { phone: '+44 7700 900000' }, meta_data: [] });
    throw new Error('unexpected ' + url);
  });
  const s = wooStore({ url: 'https://shop.example.com', consumerKey: 'ck', consumerSecret: 'cs' });
  const o = await s.createOrder({ items: [{ productId: '5', variantId: '9', quantity: 2, price: 10 }], customer: { name: 'Jane Doe', phone: '447700900000', address: '1 High St' }, paymentMethod: 'cod', fulfilment: 'delivery', shippingFee: 3 });
  assert.equal(o.orderName, '#77');
  assert.equal(o.checkoutUrl, null);
  assert.equal(posted.payment_method, 'cod');
  assert.deepEqual(posted.line_items, [{ product_id: 5, variation_id: 9, quantity: 2 }]);
  assert.equal(posted.shipping_lines[0].total, '3.00');
  assert.equal((await s.getOrderStatus('77', '447700900000')).status, 'processing');
  assert.deepEqual(await s.getOrderStatus('77', '447999999999'), { name: '#77', verify: true, failed: false }, 'found, but not their phone: ask for proof');
  f.mock.restore();
});

test('store webhook mapping', () => {
  assert.deepEqual(mapStoreEvent({ 'x-shopify-topic': 'orders/updated' }, { id: 1, admin_graphql_api_id: 'gid://shopify/Order/1', fulfillment_status: 'fulfilled', financial_status: 'paid' }).status, 'shipped');
  assert.equal(mapStoreEvent({ 'x-wc-webhook-topic': 'order.updated' }, { id: 5, status: 'completed' }).status, 'completed');
});

test('whatsapp payload limits are enforced', () => {
  const p = toGraphPayload('44', { type: 'list', text: 'x', sections: [{ title: 'a', rows: Array.from({ length: 15 }, (_, i) => ({ id: 'r' + i, title: 'A very long product title that exceeds' })) }] });
  assert.equal(p.interactive.action.sections[0].rows.length, 10);
  assert.ok(p.interactive.action.sections[0].rows[0].title.length <= 24);
  const b = toGraphPayload('44', { type: 'buttons', text: 'x', buttons: [1, 2, 3, 4].map((i) => ({ id: 'b' + i, title: 'Button title too long ' + i })) });
  assert.equal(b.interactive.action.buttons.length, 3);
});

test('crypto: signatures, encryption, session tokens', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.ok(verifyMetaSignature(body, sig, 's3cret'));
  assert.ok(!verifyMetaSignature(body, sig, 'other'));
  assert.equal(decrypt(encrypt('hello')), 'hello');
  const tok = createSessionToken('t1', '4477');
  assert.deepEqual(verifySessionToken(tok), { tenantId: 't1', waId: '4477' });
  assert.equal(verifySessionToken(tok.slice(0, -2) + 'xx'), null);
});

test('Shopify order status: phone match, or email/postcode proof; website chat must verify; shown in chat', async () => {
  const { shopifyPublicStore } = await import('../src/stores/shopifyPublic.js');
  const { say, makeTenant } = await import('./helpers.js');
  const ORDER = { name: '#1001', email: 'nik@example.com', phone: null, customer: { defaultPhoneNumber: null, defaultEmailAddress: { emailAddress: 'nik@example.com' } }, shippingAddress: { zip: 'N8 9DJ', phone: '+44 7700 900111' }, billingAddress: { zip: 'N8 9DJ', phone: null }, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED', cancelledAt: null, fulfillments: [{ displayStatus: 'DELIVERED', deliveredAt: '2026-09-02T12:37:50Z', estimatedDeliveryAt: '2026-09-02T15:00:00Z', trackingInfo: [{ number: 'QB768126034GB', url: 'https://www.royalmail.com/track?n=QB768126034GB', company: 'Royal Mail' }] }] };
  const f = mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/meta.json')) return ok({ name: 'RC', myshopify_domain: 'rc-test.myshopify.com' });
    if (u.startsWith('https://rc-test.myshopify.com/admin/api/')) {
      assert.equal(opts.headers['X-Shopify-Access-Token'], 'shpat_test');
      const q = JSON.parse(opts.body).variables?.q;
      return ok({ data: { orders: { nodes: q === 'name:#1001' ? [ORDER] : [] } } });
    }
    throw new Error('unexpected ' + u);
  });
  try {
    const s = shopifyPublicStore({ domain: 'rcshop.example', adminToken: 'shpat_test' });
    assert.equal((await s.getOrderStatus('1001', '447700900111')).status, 'delivered', 'phone on the order matches');
    assert.deepEqual(await s.getOrderStatus('1001', null), { name: '#1001', verify: true, failed: false }, 'website chat: ask for proof');
    assert.equal((await s.getOrderStatus('1001', null, ' NIK@example.com ')).tracking[0].number, 'QB768126034GB');
    assert.equal((await s.getOrderStatus('1001', null, 'n89dj')).payment, 'paid', 'postcode, any spacing/case');
    assert.equal((await s.getOrderStatus('1001', null, 'wrong@x.com')).failed, true);
    assert.equal(await s.getOrderStatus('9999', null), null);
    assert.equal(await shopifyPublicStore({ domain: 'rcshop.example' }).getOrderStatus('1001', null), null, 'no key: no lookup');

    // in the chat: website visitor asks, is asked for proof, then sees status + tracking
    const t = makeTenant({ store: { type: 'shopify_public', shopify: { domain: 'rcshop.example', adminToken: 'shpat_test', myshopifyDomain: 'rc-test.myshopify.com' } } });
    let r = await say(t, 'web:abc123', 'check order number - #1001-F1');
    assert.match(r[0].text, /found order \*#1001\*.*email address\* or \*postcode/s);
    r = await say(t, 'web:abc123', 'someone@else.com');
    assert.match(r[0].text, /doesn't match/);
    r = await say(t, 'web:abc123', 'N8 9DJ');
    assert.match(r[0].text, /Order \*#1001\*\nStatus: delivered\nDelivered: Wednesday,? 2 September/);
    assert.match(r[0].text, /Royal Mail QB768126034GB/);
  } finally { f.mock.restore(); }
});
