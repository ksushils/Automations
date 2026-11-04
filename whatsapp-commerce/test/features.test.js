import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeTenant, say, ids, tenants } from './helpers.js';
import { matchZone, quote, upcomingSlots, validatePromo } from '../src/bot/pricing.js';
import { listOrders } from '../src/bot/orders.js';
import { productsFromCsv, toCsv } from '../src/csv.js';
import { verifyStripeSignature } from '../src/payments/stripe.js';
import { createApp } from '../src/server.js';
import { getDb } from '../src/db.js';
import { runPaymentReminders } from '../src/jobs.js';
import { analytics } from '../src/analytics.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('delivery zones match UK postcodes precisely', () => {
  const zones = [{ name: 'Central', postcodes: ['SW1', 'EC'], fee: 3 }, { name: 'East', postcodes: ['E1'], fee: 5 }, { name: 'Dubai', postcodes: ['Dubai Marina'], fee: 10 }];
  assert.equal(matchZone(zones, '1 High St, London SW1A 1AA')?.name, 'Central');
  assert.equal(matchZone(zones, 'Flat 2, EC2M 4YE')?.name, 'Central');
  assert.equal(matchZone(zones, '5 Road, E1 6AN')?.name, 'East');
  assert.equal(matchZone(zones, '5 Road, E14 5AB'), null); // E1 must not match E14
  assert.equal(matchZone(zones, '10 Road, SE1 7PB'), null); // EC must not match SE
  assert.equal(matchZone(zones, 'Villa 3, Dubai Marina')?.name, 'Dubai');
});

test('promo codes: percent, fixed, free delivery, min spend, expiry, max uses', () => {
  const t = makeTenant({ ordering: { promoCodes: [
    { code: 'TEN', type: 'percent', value: 10 },
    { code: 'FIVER', type: 'fixed', value: 5, minSpend: 20 },
    { code: 'SHIP', type: 'free_delivery' },
    { code: 'OLD', type: 'percent', value: 50, expires: '2020-01-01' },
    { code: 'ONCE', type: 'fixed', value: 1, maxUses: 1 },
  ] } });
  const cart = [{ productId: 'mug', variantId: 'mug', title: 'Mug', price: 10, quantity: 3 }];
  assert.equal(quote(t, cart, { fulfilment: 'delivery', address: 'x', promoCode: 'ten' }).total, 30 - 3 + 3.5);
  assert.equal(quote(t, cart, { fulfilment: 'pickup', promoCode: 'FIVER' }).total, 25);
  assert.equal(quote(t, cart, { fulfilment: 'delivery', address: 'x', promoCode: 'SHIP' }).deliveryFee, 0);
  assert.match(validatePromo(t, 'FIVER', { sub: 10 }).reason, /minimum spend of £20\.00/);
  assert.match(validatePromo(t, 'OLD', { sub: 100 }).reason, /expired/);
  assert.match(validatePromo(t, 'NOPE', { sub: 100 }).reason, /isn't a valid code/);
  getDb().prepare("INSERT INTO orders (tenant_id, wa_id, items, promo_code) VALUES (?, '1', '[]', 'ONCE')").run(t.id);
  assert.match(validatePromo(t, 'ONCE', { sub: 100 }).reason, /fully redeemed/);
});

test('time slots respect lead time and closed days', () => {
  const now = new Date('2026-11-06T13:30:00Z'); // Friday 13:30 London
  const slots = upcomingSlots({ enabled: true, days: 3, times: ['10:00-12:00', '14:00-16:00', '18:00-20:00'], leadHours: 2, closedDays: [6] }, { now, timeZone: 'Europe/London' });
  assert.deepEqual(slots.map((s) => s.id), ['2026-11-06|18:00-20:00', '2026-11-08|10:00-12:00', '2026-11-08|14:00-16:00', '2026-11-08|18:00-20:00']);
  assert.match(slots[0].label, /^Today · 18:00–20:00$/);
});

test('checkout with zones, slot, promo code and note', async () => {
  const t = makeTenant({ ordering: {
    deliveryZones: [{ name: 'Central London', postcodes: ['SW1'], fee: 2, minOrder: 10 }],
    promoCodes: [{ code: 'WELCOME10', type: 'percent', value: 10 }],
    slots: { enabled: true, days: 7, times: ['00:00-23:59'], leadHours: 0, closedDays: [] },
  } });
  const wa = '447700900301';
  await say(t, wa, { action: 'v:tee|tee-l' });
  await say(t, wa, { action: 'q:2' }); // £32
  await say(t, wa, { action: 'checkout' });
  await say(t, wa, { action: 'ful:delivery' });
  let r = await say(t, wa, 'Jane, 9 Long Road, Manchester M1 1AE');
  assert.match(r[0].text, /don't deliver to that area/);
  r = await say(t, wa, 'Jane, 1 High St, London SW1A 1AA');
  assert.equal(r[0].type, 'list'); // slot picker
  const slotId = ids(r)[0];
  r = await say(t, wa, { action: slotId });
  assert.deepEqual(ids(r), ['pay:cod', 'pay:bank_transfer']);
  r = await say(t, wa, { action: 'pay:cod' });
  assert.match(r[0].text, /Have a promo code/);
  r = await say(t, wa, 'welcome10');
  assert.match(r[0].text, /Code \*WELCOME10\* applied/);
  assert.match(r[0].text, /Total: £30\.80/); // 32 - 3.20 + 2
  r = await say(t, wa, 'Please ring the bell twice');
  assert.match(r[0].text, /Note: Please ring the bell twice/);
  r = await say(t, wa, 'BADCODE1'); // single token, not a promo, gets ignored as promo → treated by normal flow
  r = await say(t, wa, { action: 'confirm' });
  assert.match(r[0].text, /Discount \(WELCOME10\)/);
  assert.match(r[0].text, /Receipt: http/);
  const [o] = listOrders(t.id, { waId: wa });
  assert.equal(o.subtotal, 30.8);
  assert.equal(o.discount, 3.2);
  assert.equal(o.delivery_fee, 2);
  assert.equal(o.promo_code, 'WELCOME10');
  assert.ok(o.slot);
  assert.equal(o.notes, 'Please ring the bell twice');
});

test('built-in catalogue stock: limits quantity, decrements, low-stock alert', async () => {
  const t = makeTenant({ store: { manual: { products: [{ id: 'cake', title: 'Cake', price: 20, stock: 3 }] } }, notifications: { staffWaIds: ['447000000999'] } });
  const wa = '447700900302';
  let r = await say(t, wa, { action: 'v:cake|cake' });
  r = await say(t, wa, '5');
  assert.match(r[0].text, /only have 3 more/);
  await say(t, wa, '2');
  await say(t, wa, { action: 'checkout' });
  await say(t, wa, { action: 'ful:pickup' });
  await say(t, wa, { action: 'pay:cod' });
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id, last_inbound_at) VALUES (?, '447000000999', datetime('now'))").run(t.id); // staff messaged us today
  const staffMsgs = [];
  const { engine } = await import('./helpers.js');
  await engine.handleInbound(tenants.getTenant(t.id), { waId: wa, kind: 'action', id: 'confirm' }, async (to, m) => { if (to !== wa) staffMsgs.push(m); });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(tenants.getTenant(t.id).settings.store.manual.products[0].stock, 1);
  assert.match(staffMsgs[0].text, /Low stock: Cake \(1 left\)/);
  r = await say(t, wa, { action: 'v:cake|cake' });
  r = await say(t, wa, '2');
  assert.match(r[0].text, /only have 1 more/);
});

test('storefront deep link opens the product', async () => {
  const t = makeTenant();
  const r = await say(t, '447700900303', "Hi! I'd like to order White Mug [ref:mug]");
  assert.deepEqual(ids(r), ['v:mug|mug', 'browse', 'cart']);
});

test('compare-at price shown on product card', async () => {
  const t = makeTenant({ store: { manual: { products: [{ id: 'x', title: 'Sale Tee', price: 10, compareAtPrice: 15 }] } } });
  const r = await say(t, '447700900304', { action: 'p:x' });
  assert.match(r[0].text, /~£15\.00~ \*£10\.00\*/);
});

test('CSV: import products with options/stock; export escapes formulas', () => {
  const { products, errors } = productsFromCsv('id,title,price,compare_at_price,category,description,image,stock,options\r\ntee,"Tee, organic",15,20,tees,"Soft ""cotton""",,,"S:15:3|M:15:0|L:16"\nmug,Mug,8.5,,mugs,,,4,\n,Bad,abc\n');
  assert.deepEqual(errors, ['line 4: invalid price "abc"']);
  assert.equal(products[0].title, 'Tee, organic');
  assert.equal(products[0].description, 'Soft "cotton"');
  assert.deepEqual(products[0].variants.map((v) => [v.title, v.price, v.stock]), [['S', 15, 3], ['M', 15, 0], ['L', 16, undefined]]);
  assert.equal(products[1].stock, 4);
  assert.equal(toCsv([{ a: '=HYPERLINK("x")', b: 'x,y' }], [{ key: 'a' }, { key: 'b' }]), 'a,b\r\n"\'=HYPERLINK(""x"")","x,y"\r\n');
});

test('stripe signature verification', () => {
  const body = '{"id":"evt_1"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex');
  assert.ok(verifyStripeSignature(body, `t=${t},v1=${sig}`, 'whsec_x'));
  assert.ok(!verifyStripeSignature(body, `t=${t},v1=${sig}`, 'whsec_y'));
  assert.ok(!verifyStripeSignature(body, `t=${t - 10000},v1=${crypto.createHmac('sha256', 'whsec_x').update(`${t - 10000}.${body}`).digest('hex')}`, 'whsec_x'));
});

test('stripe checkout link for built-in catalogue + webhook marks paid, receipt page renders', () => withServer(async (base) => {
  const t = makeTenant({ ordering: { paymentMethods: ['payment_link'] }, payments: { stripe: { secretKey: 'sk_test_1', webhookSecret: 'whsec_1' } }, whatsapp: { phoneNumberId: 'P', accessToken: 'tok' } });
  const wa = '447700900305';
  const realFetch = globalThis.fetch;
  let stripeBody;
  const outbound = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url) === 'https://api.stripe.com/v1/checkout/sessions') { stripeBody = new URLSearchParams(opts.body); return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }), { status: 200 }); }
    if (String(url).startsWith('https://graph.facebook.com')) { outbound.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); }
    return realFetch(url, opts);
  };
  try {
    await say(t, wa, { action: 'v:mug|mug' });
    await say(t, wa, { action: 'q:2' });
    await say(t, wa, { action: 'checkout' });
    await say(t, wa, { action: 'ful:pickup' });
    const r = await say(t, wa, { action: 'confirm' });
    assert.equal(r[0].type, 'cta');
    assert.equal(r[0].url, 'https://checkout.stripe.com/c/pay/cs_1');
    assert.equal(stripeBody.get('line_items[0][price_data][unit_amount]'), '1700');
    assert.equal(stripeBody.get('line_items[0][price_data][currency]'), 'gbp');
    const [o] = listOrders(t.id, { waId: wa });

    const page = await (await realFetch(`${base}/r/${o.receipt_token}`)).text();
    assert.match(page, /White Mug × 2/);
    assert.match(page, /Pay £17\.00 now/);

    const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', metadata: { order_id: String(o.id) } } } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_1').update(`${ts}.${ev}`).digest('hex');
    let res = await realFetch(`${base}/webhooks/stripe/${t.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${ts},v1=bad` }, body: ev });
    assert.equal(res.status, 400);
    res = await realFetch(`${base}/webhooks/stripe/${t.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: ev });
    assert.equal(res.status, 200);
    await new Promise((x) => setTimeout(x, 50));
    const [paid] = listOrders(t.id, { waId: wa });
    assert.equal(paid.payment_status, 'paid');
    assert.equal(paid.status, 'confirmed');
    assert.ok(outbound.some((m) => /Payment received/.test(m.text?.body || '')));
  } finally { globalThis.fetch = realFetch; }
}));

test('storefront page lists products with WhatsApp order links', () => withServer(async (base) => {
  const t = makeTenant({ business: { whatsappNumber: '+44 7700 900123', tagline: 'Organic goodies' }, storefront: { mode: 'chat' } });
  const html = await (await fetch(`${base}/s/${t.id}`)).text();
  assert.match(html, /Organic goodies/);
  assert.match(html, /White Mug/);
  assert.match(html, /https:\/\/wa\.me\/447700900123\?text=Hi!%20I&#39;d%20like%20to%20order%20White%20Mug%20%5Bref%3Amug%5D/);
  const cat = await (await fetch(`${base}/s/${t.id}?category=mugs`)).text();
  assert.doesNotMatch(cat, /Classic Tee/);
}));

test('staff role: can see orders, cannot change settings; owner manages team', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Team Shop' });
  const h = (k) => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' });
  let r = await fetch(`${base}/api/tenants/${tenant.id}/staff`, { method: 'POST', headers: h(adminKey), body: JSON.stringify({ name: 'Ali', role: 'staff' }) });
  const { key } = await r.json();
  r = await fetch(`${base}/api/tenants/${tenant.id}`, { headers: h(key) });
  assert.equal((await r.json()).role, 'staff');
  assert.equal((await fetch(`${base}/api/tenants/${tenant.id}/orders`, { headers: h(key) })).status, 200);
  assert.equal((await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: h(key), body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/tenants/${tenant.id}/staff`, { headers: h(key) })).status, 403);
  const csv = await (await fetch(`${base}/api/tenants/${tenant.id}/export/orders.csv`, { headers: h(key) })).text();
  assert.match(csv, /^order,created_at,status/);
}));

test('catalogue CSV import endpoint adds categories', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'CSV Shop' });
  const r = await fetch(`${base}/api/tenants/${tenant.id}/catalogue/import`, { method: 'POST', headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: 'title,price,category\nRose bouquet,30,flowers\n', replace: true }) });
  const body = await r.json();
  assert.equal(body.imported, 1);
  assert.ok(body.tenant.settings.store.manual.categories.some((c) => c.id === 'flowers' && c.title === 'Flowers'));
}));

test('payment reminder sent once for unpaid bank transfer order', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: 'P', accessToken: 'tok' }, ordering: { paymentReminderMinutes: 30 } });
  getDb().prepare(`INSERT INTO orders (tenant_id, wa_id, store_order_name, payment_method, items, subtotal, created_at) VALUES (?, '447700900306', 'WA-X', 'bank_transfer', '[]', 12, datetime('now', '-2 hours'))`).run(t.id);
  getDb().prepare(`INSERT INTO orders (tenant_id, wa_id, store_order_name, payment_method, items, subtotal, created_at) VALUES (?, '447700900316', 'WA-Y', 'payment_link', '[]', 9, datetime('now', '-2 hours'))`).run(t.id);
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id, last_inbound_at) VALUES (?, '447700900306', datetime('now', '-1 hour'))").run(t.id);
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id, last_inbound_at) VALUES (?, '447700900316', datetime('now', '-3 days'))").run(t.id);
  tenants.updateTenantSettings(t.id, { notifications: { templates: { paymentReminder: 'payment_reminder' } } });
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); };
  try {
    await runPaymentReminders();
    await runPaymentReminders();
  } finally { globalThis.fetch = realFetch; }
  const mine = sent.filter((m) => m.to === '447700900306');
  assert.equal(mine.length, 1);
  assert.match(mine[0].text.body, /WA-X/);
  // outside the 24h window → approved template instead of free text
  const late = sent.filter((m) => m.to === '447700900316');
  assert.equal(late.length, 1);
  assert.equal(late[0].type, 'template');
  assert.equal(late[0].template.name, 'payment_reminder');
  assert.equal(late[0].template.components[0].parameters[1].text, 'WA-Y');
});

test('analytics summarises revenue, top products and promos', async () => {
  const t = makeTenant();
  const wa = '447700900307';
  await say(t, wa, { action: 'v:mug|mug' });
  await say(t, wa, { action: 'q:2' });
  await say(t, wa, { action: 'checkout' });
  await say(t, wa, { action: 'ful:pickup' });
  await say(t, wa, { action: 'pay:cod' });
  await say(t, wa, { action: 'confirm' });
  const a = analytics(t.id, 30);
  assert.equal(a.orders, 1);
  assert.equal(a.revenue, 17);
  assert.equal(a.topProducts[0].title, 'White Mug');
  assert.equal(a.byDay.length, 1);
});
