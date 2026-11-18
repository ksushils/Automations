import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, tenants, say, ids } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { runStockAlerts } from '../src/extras.js';
import { runBookingJobs, zonedToUtc } from '../src/bookings.js';
import { cleanPage, openerConfig } from '../src/routes/webchat.js';
import { pageNote } from '../src/bot/engine.js';

const withCatalogue = (extra = {}) => makeTenant({
  store: { type: 'manual', manual: { categories: [{ id: 'hats', title: 'Hats' }], products: [
    { id: 'cap', title: 'Racing Cap', price: 12, category: 'hats', stock: 0 },
    { id: 'tee', title: 'Classic Tee', price: 15, category: 'hats', variants: [{ id: 'tee-s', title: 'Small', price: 15 }, { id: 'tee-l', title: 'Large', price: 16, stock: 0 }] },
  ] } },
  ...extra,
});
function capture() {
  const wa = [], mail = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith('https://graph.facebook.com/')) { wa.push(JSON.parse(opts.body || '{}')); return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' + wa.length }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
    if (String(url).startsWith('https://api.resend.com/')) { mail.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: 'em' }), { status: 200 }); }
    return real(url, opts);
  };
  return { wa, mail, restore: () => { globalThis.fetch = real; } };
}

test("back in stock: 'Tell me when it's back' on WhatsApp and by email on the website; told once when it returns", async () => {
  const t = withCatalogue({ whatsapp: { phoneNumberId: 'PNS', accessToken: 'tok' } });
  const prev = [config.resendApiKey, config.emailFrom];
  Object.assign(config, { resendApiKey: 're_test', emailFrom: 'Shop <s@example.test>' });
  const cap = capture();
  try {
    const wa = '447700930001';
    let r = await say(t, wa, { action: 'p:cap' });
    assert.ok(ids(r).includes('notifyme:cap'));
    r = await say(t, wa, { action: 'notifyme:cap' });
    assert.match(r[0].text, /I'll message you here as soon as \*Racing Cap\* is back/);
    await say(t, wa, { action: 'notifyme:cap' }); // a second tap doesn't double up
    // a website visitor gives an email
    const web = 'web:' + 'v'.repeat(24);
    r = await say(t, web, { action: 'notifyme:cap' });
    assert.match(r[0].text, /What's your email address\?/);
    r = await say(t, web, 'nope');
    assert.match(r[0].text, /doesn't look like an email/);
    r = await say(t, web, 'Fan@Example.com');
    assert.match(r[0].text, /I'll email fan@example\.com/);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM stock_alerts WHERE tenant_id = ?').get(t.id).n, 2);
    assert.equal(await runStockAlerts(), 0, 'still out of stock: nothing sent');
    // back in stock
    const S = tenants.getTenant(t.id).settings;
    S.store.manual.products[0].stock = 5;
    tenants.updateTenantSettings(t.id, { store: { manual: { products: S.store.manual.products } } });
    assert.equal(await runStockAlerts(), 2);
    assert.ok(cap.wa.some((m) => m.to === wa && /back in stock/.test(JSON.stringify(m))));
    assert.ok(cap.mail.some((m) => m.to.includes('fan@example.com') && /Racing Cap is back in stock/.test(m.subject)));
    assert.equal(await runStockAlerts(), 0, 'told once');
  } finally { cap.restore(); [config.resendApiKey, config.emailFrom] = prev; }
});

test('order changes in the chat: cancel (with a confirm step) or a new address while it is not being prepared; the team is told', async () => {
  const t = withCatalogue({ notifications: { staffWaIds: [] } });
  const wa = '447700930011';
  await say(t, wa, 'hi');
  const ins = getDb().prepare("INSERT INTO orders (tenant_id, wa_id, store_order_name, status, payment_status, fulfilment, items, subtotal, address) VALUES (?, ?, ?, ?, 'paid', 'delivery', '[]', 20, '1 Old Road, Leeds LS1 1AA')");
  const id = Number(ins.run(t.id, wa, 'WC-101', 'new').lastInsertRowid);
  let r = await say(t, wa, 'order status');
  assert.deepEqual(ids(r), [`ocxl:${id}`, `oaddr:${id}`]);
  r = await say(t, wa, { action: `oaddr:${id}` });
  assert.match(r[0].text, /new delivery address/);
  r = await say(t, wa, '22 New Street, Leeds LS2 7EW');
  assert.match(r[0].text, /will go to:\n22 New Street/);
  assert.equal(getDb().prepare('SELECT address FROM orders WHERE id = ?').get(id).address, '22 New Street, Leeds LS2 7EW');
  r = await say(t, wa, { action: `ocxl:${id}` });
  assert.match(r[0].text, /can't be undone/);
  r = await say(t, wa, { action: `ocxlyes:${id}` });
  assert.match(r[0].text, /cancelled\. As you've already paid, our team will refund you/);
  assert.equal(getDb().prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'cancelled');
  // once it's being prepared: no changes from the chat
  const id2 = Number(ins.run(t.id, wa, 'WC-102', 'preparing').lastInsertRowid);
  r = await say(t, wa, { action: `ocxl:${id2}` });
  assert.match(r[0].text, /already being prepared/);
  // and nobody can touch someone else's order
  r = await say(t, '447700930099', { action: `oaddr:${id2}` });
  assert.match(r[0].text, /couldn't find that order/);
});

test('a fed-up customer is offered a person straight away (once per half hour)', async () => {
  const t = withCatalogue();
  const wa = '447700930021';
  await say(t, wa, 'hi');
  let r = await say(t, wa, 'this is useless, I asked three times');
  assert.match(r[0].text, /sorry this has been frustrating/i);
  assert.deepEqual(ids(r), ['human', 'ask']);
  r = await say(t, wa, 'still useless');
  assert.ok(!/frustrating/.test(r[0]?.text || ''), 'not offered again straight away');
});

test('second booking reminder close to the time, as well as the usual one', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: 'PNB', accessToken: 'tok' }, store: { type: 'none' }, business: { name: 'Karat Racing', address: 'Silverstone' }, bookings: { enabled: true, services: [{ name: 'Test day', minutes: 60 }], times: ['10:00'], reminderHours: 24, secondReminderHours: 2 } });
  const soon = new Date(Date.now() + 90 * 60000);
  const day = soon.toISOString().slice(0, 10);
  const time = soon.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London', hourCycle: 'h23' });
  const startsAt = zonedToUtc(day, time, 'Europe/London').toISOString().replace('T', ' ').slice(0, 19);
  const id = Number(getDb().prepare("INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status, deposit) VALUES (?, '447700930031', 'Sam', 'Test day', ?, ?, ?, 'confirmed', 0)").run(t.id, day, time, startsAt).lastInsertRowid);
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id, name, last_inbound_at) VALUES (?, '447700930031', 'Sam', datetime('now')) ON CONFLICT(tenant_id, wa_id) DO UPDATE SET last_inbound_at = datetime('now')").run(t.id);
  const cap = capture();
  try {
    await runBookingJobs();
    const b = getDb().prepare('SELECT reminded_at, reminded2_at FROM bookings WHERE id = ?').get(id);
    assert.ok(b.reminded2_at, 'second reminder sent');
    assert.ok(cap.wa.some((m) => /See you soon, Sam/.test(JSON.stringify(m)) && /Silverstone/.test(JSON.stringify(m))));
    const n = cap.wa.length;
    await runBookingJobs();
    assert.equal(cap.wa.length, n, 'not repeated');
  } finally { cap.restore(); }
});

test('the page: product and basket details are read (structured data only), given to the AI, and drive the pop-up', async () => {
  const p = cleanPage({ url: 'https://shop.test/products/classic-tee?variant=123', title: 'Classic Tee', product: { name: 'Classic Tee', price: '15.00', currency: 'GBP', availability: 'InStock', handle: 'tee', variant: '123' }, cart: { items: ['1 × Racing Cap'], total: 12 } });
  assert.equal(p.url, 'https://shop.test/products/classic-tee');
  assert.equal(p.product.handle, 'tee');
  const note = pageNote({ waId: 'web:x', data: { page: p } });
  assert.match(note, /The product on the page: Classic Tee, GBP 15\.00 \(in stock\)\. When they say "this" or "it", they mean this product\./);
  assert.match(note, /Their basket on the website: 1 × Racing Cap \(total 12\.00\)/);
  const t = makeTenant({ store: { type: 'shopify_public', shopify: { domain: 'www.rcshop.test' } }, ordering: { freeDeliveryOver: 50 } });
  const cfg = openerConfig(tenants.getTenant(t.id));
  assert.deepEqual(cfg.site, { platform: 'shopify', hosts: ['rcshop.test'] });
  assert.equal(cfg.freeDelivery, 50);
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const js = await (await fetch(`http://127.0.0.1:${server.address().port}/chat-widget/${t.id}.js`)).text();
    assert.doesNotThrow(() => new Function(js));
    assert.match(js, /🛒 Add this to basket/);
    assert.match(js, /away from free delivery/);
    assert.match(js, /application\/ld\+json/);
    // what the widget sends about the page (pg and its helpers) never includes anything typed into the page's forms
    const sent = ['function prod(', 'function secs2(', 'function theForm(', 'function pg('].map((n) => js.slice(js.indexOf(n), js.indexOf('\n', js.indexOf(n)))).join('\n');
    assert.ok(!/\.value\b|FormData/.test(sent), 'never sends the page\'s form field values');
  } finally { server.close(); }
});

test('the AI sees every option and its stock for the product on the visitor\'s page, and which one is selected', async () => {
  const t = withCatalogue();
  const calls = [];
  const llm = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { calls.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'Small is in stock; Large is sold out.' } }], usage: { total_tokens: 3 } })); }); });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const prev = { ...config };
  Object.assign(config, { aiBaseUrl: `http://127.0.0.1:${llm.address().port}/v1`, aiApiKey: 'sk-test', embeddingsModel: '' });
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const sid = 'sess' + 'p'.repeat(20);
    await fetch(`http://127.0.0.1:${server.address().port}/chat/${t.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, text: 'is this available in large?', page: { url: 'https://shop.test/products/tee?variant=tee-l', title: 'Classic Tee', product: { name: 'Classic Tee', handle: 'tee', variant: '' } } }) });
    const sys = calls.at(-1).messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(sys, /The product on the visitor's page, from the catalogue: Classic Tee\. Options: Small £15\.00; Large £16\.00 \(out of stock\)/);
    assert.match(sys, /chatting with the customer on the website chat/, 'the AI knows it is on the website, not WhatsApp');
  } finally { Object.assign(config, prev); llm.close(); server.close(); }
});
