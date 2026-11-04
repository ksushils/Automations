import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, tenants, say, ids } from './helpers.js';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { htmlToText, searchKnowledge, addTextDoc, safeFetch, listDocs } from '../src/knowledge.js';
import { getDb } from '../src/db.js';

const listen = (srv) => new Promise((r) => srv.listen(0, () => r(`http://127.0.0.1:${srv.address().port}`)));
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

test('HTML to text keeps content, drops scripts/nav', () => {
  const { title, text } = htmlToText('<html><head><title>Refund policy</title><script>x()</script></head><body><nav>Menu</nav><main><h1>Refunds</h1><p>Returns within <b>30 days</b>.</p><ul><li>Unused</li></ul></main><footer>©</footer></body></html>');
  assert.equal(title, 'Refund policy');
  assert.equal(text, 'Refunds\nReturns within 30 days .\n• Unused');
});

test('built-in knowledge search finds the right paragraph', () => {
  const t = makeTenant();
  addTextDoc(t.id, { name: 'Shipping policy', text: 'We ship worldwide.\nUK delivery is free over £50 and takes 1-2 working days.\nInternational shipping to Ireland and Europe takes 3-5 days.' });
  addTextDoc(t.id, { name: 'Returns', text: 'You can return unused items within 30 days for a full refund. Contact us first.' });
  assert.equal(searchKnowledge(t.id, 'how long do returns take for a refund?')[0].doc, 'Returns');
  assert.match(searchKnowledge(t.id, 'do you ship to Ireland?')[0].text, /Ireland/);
  assert.equal(searchKnowledge(t.id, 'banana smoothie recipe').length, 0);
});

test('website import refuses internal addresses (SSRF protection)', async () => {
  await assert.rejects(safeFetch('http://127.0.0.1:1/', { allowPrivate: false }), /not allowed/);
  await assert.rejects(safeFetch('http://169.254.169.254/latest/meta-data', { allowPrivate: false }), /not allowed/);
  await assert.rejects(safeFetch('file:///etc/passwd', { allowPrivate: false }), /Only http/);
});

test('NEW SHOP JOURNEY: sign up with website → catalogue + knowledge base + AI chatbot with RAG → customer chat', async () => {
  // ---- fake Shopify storefront (like rcshopper.com) ----
  const products = [
    { id: 1, handle: 'yokomo-yd-2', title: 'Yokomo YD-2 Drift Kit', body_html: '<p>RWD drift chassis</p>', vendor: 'Yokomo', product_type: 'Kits', tags: 'drift,rwd', images: [{ src: 'https://cdn/yd2.jpg' }], variants: [{ id: 111, title: 'Default Title', price: '329.00', compare_at_price: '349.00', available: true }] },
    { id: 2, handle: 'drift-tyres', title: 'Drift Tyres Hard (4)', body_html: 'Hard compound', vendor: 'MST', product_type: 'Tyres', tags: 'tyres', images: [], variants: [{ id: 221, title: '26mm', price: '12.99', available: true }, { id: 222, title: '24mm', price: '12.99', available: false }] },
  ];
  const shop = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const j = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const h = (s) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<html><head><title>${s[0]}</title></head><body><main><h1>${s[0]}</h1><p>${s[1]}</p></main></body></html>`); };
    if (u.pathname === '/meta.json') return j({ name: 'RC Shopper', domain: req.headers.host, myshopify_domain: 'x.myshopify.com', currency: 'GBP', city: 'Harrow', country: 'GB', description: 'UK RC drift specialist.' });
    if (u.pathname === '/products.json') return j({ products: u.searchParams.get('page') === '1' ? products : [] });
    if (u.pathname === '/collections.json') return j({ collections: [{ handle: 'drift-kits', title: 'Drift Kits', products_count: 1 }, { handle: 'tyres', title: 'Tyres', products_count: 1 }] });
    if (u.pathname === '/collections/drift-kits/products.json') return j({ products: [products[0]] });
    if (u.pathname === '/policies/refund-policy') return h(['Refund policy', 'Unused items can be returned within 30 days of delivery for a full refund. Parts must be in original packaging.']);
    if (u.pathname === '/policies/shipping-policy') return h(['Shipping policy', 'Free UK delivery on orders over £50. Royal Mail Tracked 24 for most orders. We also ship to Ireland and Europe.']);
    res.writeHead(404); res.end('nope');
  });
  const shopUrl = await listen(shop);

  // ---- fake Dify (console + knowledge API + chat) ----
  const S = { apps: {}, configs: {}, datasets: {}, docs: {}, keys: 0 };
  const dify = http.createServer(async (req, res) => {
    const raw = await body(req);
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const send = (code, d) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (p.startsWith('/console/api')) {
      if (req.headers.authorization !== 'Bearer ADMIN') return send(401, {});
      const c = p.slice(12);
      let m;
      if (c === '/workspaces/current/default-model') return send(200, { data: u.searchParams.get('model_type') === 'llm' ? { model: 'gpt-4o-mini', provider: { provider: 'langgenius/openai/openai' } } : { model: 'text-embedding-3-small', provider: { provider: 'langgenius/openai/openai' } } });
      if (c === '/apps' && req.method === 'POST') { const id = 'app' + (Object.keys(S.apps).length + 1); S.apps[id] = JSON.parse(raw); return send(201, { id }); }
      if ((m = c.match(/^\/apps\/(\w+)$/))) return S.apps[m[1]] ? send(200, { id: m[1] }) : send(404, {});
      if ((m = c.match(/^\/apps\/(\w+)\/model-config$/))) { S.configs[m[1]] = JSON.parse(raw); return send(200, { result: 'success' }); }
      if ((m = c.match(/^\/apps\/(\w+)\/api-keys$/))) return req.method === 'POST' ? send(201, { token: `app-key-${m[1]}-${++S.keys}` }) : send(200, { data: [{ token: 'app-k...xyz' }] });
      if (c === '/datasets/api-keys') return send(200, { token: 'dataset-KEY' });
      return send(404, { message: c });
    }
    if (p === '/v1/chat-messages') {
      // Simulated RAG: answer from the documents of the dataset attached to the app that owns this key
      const appId = req.headers.authorization.split('-')[2];
      const dsId = S.configs[appId]?.dataset_configs?.datasets?.datasets?.[0]?.dataset?.id;
      const { query } = JSON.parse(raw);
      const q = query.split('Customer:').pop().toLowerCase();
      const doc = Object.values(S.docs).find((d) => d.ds === dsId && q.split(/\W+/).some((w) => w.length > 4 && d.text.toLowerCase().includes(w)));
      const words = q.split(/\W+/).filter((w) => w.length > 4);
      const answer = doc ? `From our policy: ${doc.text.split('\n').find((l) => !l.startsWith('Source:') && words.some((w) => l.toLowerCase().includes(w))) || doc.text.slice(0, 80)}` : 'Happy to help!';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(`data: ${JSON.stringify({ event: 'message', answer, conversation_id: 'c1' })}\n\ndata: ${JSON.stringify({ event: 'message_end', conversation_id: 'c1' })}\n\n`);
    }
    if (req.headers.authorization !== 'Bearer dataset-KEY') return send(401, {});
    let m;
    if (p === '/v1/datasets' && req.method === 'POST') { const id = 'ds' + (Object.keys(S.datasets).length + 1); S.datasets[id] = JSON.parse(raw); return send(200, { id }); }
    if ((m = p.match(/^\/v1\/datasets\/(\w+)$/))) return S.datasets[m[1]] ? send(200, { id: m[1] }) : send(404, {});
    if ((m = p.match(/^\/v1\/datasets\/(\w+)\/document\/create-by-text$/))) { const b = JSON.parse(raw); const id = 'doc' + (Object.keys(S.docs).length + 1); S.docs[id] = { ds: m[1], name: b.name, text: b.text, technique: b.indexing_technique }; return send(200, { document: { id, indexing_status: 'waiting' }, batch: 'b1' }); }
    if ((m = p.match(/^\/v1\/datasets\/(\w+)\/document\/create-by-file$/))) { const id = 'doc' + (Object.keys(S.docs).length + 1); S.docs[id] = { ds: m[1], name: 'file', text: raw.toString('utf8'), file: true }; return send(200, { document: { id } }); }
    if ((m = p.match(/^\/v1\/datasets\/(\w+)\/documents$/))) return send(200, { data: Object.entries(S.docs).filter(([, d]) => d.ds === m[1]).map(([id]) => ({ id, indexing_status: 'completed' })) });
    if ((m = p.match(/^\/v1\/datasets\/(\w+)\/documents\/(\w+)$/)) && req.method === 'DELETE') { delete S.docs[m[2]]; return send(200, {}); }
    send(404, { message: p });
  });
  const difyUrl = await listen(dify);

  const prev = { ...config };
  Object.assign(config, { difyConsoleUrl: difyUrl, difyAdminApiKey: 'ADMIN', difyWorkspaceId: 'ws', allowPrivateFetch: true, difyLicensed: true }); // operator holds a Dify licence
  const app = createApp().listen(0);
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    // 1) New customer signs up with their website
    const r = await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ business: 'RC Shopper', email: 'support@rcshopper.example', website: shopUrl, plan: 'growth', acceptTerms: true }) });
    assert.equal(r.status, 201);
    const { tenantId } = await r.json();
    // onboarding + AI setup run in the background
    for (let i = 0; i < 50 && !tenants.getTenant(tenantId).settings.dify?.datasetAttached; i++) await new Promise((x) => setTimeout(x, 100));
    const t = tenants.getTenant(tenantId);

    // 2) shop detected & catalogue connected without any token
    assert.equal(t.settings.store.type, 'shopify_public');
    assert.equal(t.settings.business.currency, 'GBP');
    assert.match(t.settings.ai.about, /UK RC drift specialist\. Based in Harrow, GB\./);
    // 3) policies imported into the knowledge base and synced to Dify (embedding model → high quality)
    const docs = listDocs(tenantId);
    assert.deepEqual(docs.map((d) => d.name).sort(), ['Refund policy', 'Shipping policy']);
    assert.ok(docs.every((d) => d.status === 'ready'), JSON.stringify(docs.map((d) => d.status)));
    assert.equal(Object.keys(S.docs).length, 2);
    assert.ok(Object.values(S.docs).every((d) => d.technique === 'high_quality'));
    // 4) chatbot created with the knowledge base attached; a real (unmasked) key stored
    const appId = t.settings.dify.appId;
    assert.equal(S.configs[appId].dataset_configs.datasets.datasets[0].dataset.id, t.settings.dify.datasetId);
    assert.match(S.configs[appId].pre_prompt, /knowledge base \(policies, FAQs, guides\)/);
    assert.match(t.settings.dify.apiKey, /^app-key-/);
    assert.ok(!t.settings.dify.apiKey.includes('...'));

    // 5) customer asks a policy question → RAG answer; asks for products → live catalogue list
    let replies = await say(t, '447700901001', 'Can I return parts if unused?');
    assert.match(replies[0].text, /returned within 30 days/);
    replies = await say(t, '447700901001', 'yokomo drift kit');
    assert.ok(ids(replies).includes('p:yokomo-yd-2'));
    // 6) checkout → Shopify cart permalink
    await say(t, '447700901001', { action: 'v:yokomo-yd-2|111' });
    await say(t, '447700901001', { action: 'q:1' });
    replies = await say(t, '447700901001', { action: 'checkout' });
    assert.match(replies[0].text, /choose delivery and pay securely on our website/);
    replies = await say(t, '447700901001', { action: 'confirm' });
    assert.equal(replies[0].type, 'cta');
    assert.equal(replies[0].url.split('?')[0], `${shopUrl}/cart/111:1`);

    // 7) owner adds an FAQ and removes a page → synced to Dify
    const adminKey = tenants.rotateKeys(tenantId).adminKey;
    const H = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
    await fetch(`${base}/api/tenants/${tenantId}/knowledge/text`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Opening hours', text: 'Our Harrow shop is open Tuesday to Saturday, 10am to 6pm.' }) });
    const refund = listDocs(tenantId).find((d) => d.name === 'Refund policy');
    await fetch(`${base}/api/tenants/${tenantId}/knowledge/${refund.id}`, { method: 'DELETE', headers: H });
    const s = await (await fetch(`${base}/api/tenants/${tenantId}/knowledge/sync`, { method: 'POST', headers: H })).json();
    assert.ok(s.ok, JSON.stringify(s));
    assert.deepEqual(Object.values(S.docs).map((d) => d.name).sort(), ['Opening hours', 'Shipping policy']);
  } finally {
    Object.assign(config, prev);
    app.close(); shop.close(); dify.close();
  }
});
