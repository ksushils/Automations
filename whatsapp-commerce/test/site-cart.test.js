import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { getConversation } from '../src/bot/state.js';
import { cartId } from '../src/siteCart.js';

test('add to the shop\'s real basket: on its own Shopify site the chat hands the item to the site cart; elsewhere it keeps its own basket', async () => {
  // a pretend Shopify store (public storefront JSON only)
  const shop = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/products.json')) return res.end(JSON.stringify({ products: [{ id: 1, handle: 'yd-2-kit', title: 'Yokomo YD-2 Kit', body_html: '<p>RWD drift chassis</p>', product_type: 'Kit', tags: 'drift', vendor: 'Yokomo', images: [], variants: [{ id: 4455667788, title: 'Default Title', price: '329.99', available: true }] }] }));
    res.end('{}');
  });
  await new Promise((r) => shop.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${shop.address().port}`;
  const prev = { ...config };
  Object.assign(config, { allowPrivateFetch: true, aiApiKey: '' });
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const t = makeTenant({ store: { type: 'shopify_public', shopify: { domain: origin.replace('http://', ''), origin } } });
    const post = (sid, body) => fetch(`${base}/chat/${t.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, ...body }) }).then((r) => r.json());
    const onSite = { url: `${origin}/products/yd-2-kit`, title: 'Yokomo YD-2 Kit' };
    const sid = 'sess' + 'a'.repeat(20);
    let r = await post(sid, { actionId: 'p:yd-2-kit', page: onSite });
    const btn = r.replies.find((m) => m.type === 'buttons');
    assert.equal(btn.buttons[0].title, '➕ Add to basket');
    r = await post(sid, { actionId: btn.buttons[0].id, page: onSite });
    assert.match(r.replies[0].text, /How many/);
    r = await post(sid, { actionId: 'q:2', page: onSite });
    const sc = r.replies.find((m) => m.type === 'site_cart');
    assert.ok(sc, 'the widget is told to add it to the site basket');
    assert.deepEqual(sc.items, [{ id: '4455667788', quantity: 2 }]);
    assert.equal(sc.platform, 'shopify');
    assert.equal(sc.cartUrl, `${origin}/cart`);
    assert.equal(sc.checkoutUrl, `${origin}/checkout`);
    assert.deepEqual(getConversation(t.id, `web:${sid}`).cart, [], 'no second basket in the chat');

    // the widget reports back: noted in the chat for the inbox and counted
    const ev = await fetch(`${base}/chat/${t.id}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, type: 'site_cart', ok: true, title: sc.title, quantity: 2, itemCount: 2 }) });
    assert.equal(ev.status, 200);
    const note = getDb().prepare("SELECT body FROM messages WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC LIMIT 1").get(t.id, `web:${sid}`);
    assert.match(JSON.parse(note.body).text, /\[site basket: added 2 × Yokomo YD-2 Kit – 2 item\(s\) in basket\]/);
    assert.equal(getDb().prepare('SELECT site_cart_adds AS n FROM usage WHERE tenant_id = ?').get(t.id).n, 1);

    // the same chat on another website (not the shop's own): the chat's own basket, as before
    const sid2 = 'sess' + 'b'.repeat(20);
    const elsewhere = { url: 'https://blog.example.com/review', title: 'Review' };
    await post(sid2, { actionId: 'p:yd-2-kit', page: elsewhere });
    await post(sid2, { actionId: 'v:yd-2-kit|4455667788', page: elsewhere });
    r = await post(sid2, { actionId: 'q:1', page: elsewhere });
    assert.match(r.replies[0].text, /Added 1 × Yokomo YD-2 Kit to your cart/);
    assert.equal(getConversation(t.id, `web:${sid2}`).cart.length, 1);
  } finally { Object.assign(config, prev); server.close(); shop.close(); }
});

test('site basket: ids the site cart understands; the widget knows Shopify and WooCommerce', async () => {
  assert.equal(cartId('gid://shopify/ProductVariant/123456'), '123456');
  assert.equal(cartId('789'), '789');
  assert.equal(cartId('abc'), null);
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const t = makeTenant();
    const js = await (await fetch(`http://127.0.0.1:${server.address().port}/chat-widget/${t.id}.js`)).text();
    assert.doesNotThrow(() => new Function(js));
    assert.match(js, /\/cart\/add\.js/);
    assert.match(js, /'Chat assistant':'yes'/, 'Shopify orders show they came via the chat');
    assert.match(js, /wc-ajax=add_to_cart/);
    assert.match(js, /wc_fragment_refresh/);
  } finally { server.close(); }
});
