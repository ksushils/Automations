import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const { tenants } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { getDb } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');
const { cleanupDemos, isDemo } = await import('../src/instantDemo.js');

const filler = ' We are a friendly local business and this paragraph gives the page enough text to learn from.';
const page = (t, b) => `<html><head><title>${t}</title><meta name="description" content="Fresh flowers delivered in Leeds"></head><body><main><h1>${t}</h1><p>${b}${filler}</p></main></body></html>`;

test('instant demo: website → demo shop → chat → keep it on sign-up; expired demos deleted', async () => {
  const site = http.createServer((req, res) => {
    const send = (code, body, type = 'text/html') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    if (req.url === '/') return send(200, page('Bloom Florist', 'Hand-tied bouquets from £25.'));
    if (req.url === '/delivery') return send(200, page('Delivery', 'Same-day delivery in Leeds for £4.95 if you order before 1pm.'));
    if (req.url === '/about') return send(200, page('About us', 'Family florist since 1998.'));
    send(404, 'nope');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}`;
  // fake AI: questions for the chips, then answers
  const llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const body = JSON.parse(raw);
      const last = JSON.stringify(body.messages.at(-1).content);
      const content = /JSON array/.test(last) ? '["Do you deliver today?","How much is delivery?","Where are you based?"]' : 'Yes – same-day delivery in Leeds is £4.95 if you order before 1pm.';
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 5 } }));
    });
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const prev = { ...config };
  Object.assign(config, { allowPrivateFetch: true, aiBaseUrl: `http://127.0.0.1:${llm.address().port}/v1`, aiApiKey: 'sk-test', embeddingsModel: '', signupEnabled: true });
  const app = createApp();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const home = await (await fetch(base + '/')).text();
    assert.match(home, /action="\/try"/);

    const r = await fetch(base + '/try', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ website: origin }) });
    assert.equal(r.status, 202);
    const { token } = await r.json();
    let st;
    for (let i = 0; i < 100; i++) { st = await (await fetch(`${base}/try/${token}/status`)).json(); if (st.status !== 'reading') break; await new Promise((x) => setTimeout(x, 100)); }
    assert.equal(st.status, 'ready', JSON.stringify(st));
    assert.equal(st.name, 'Bloom Florist');
    assert.ok(st.pages >= 3);
    assert.deepEqual(st.suggestions, ['Do you deliver today?', 'How much is delivery?', 'Where are you based?']);
    const pageHtml = await (await fetch(`${base}/try/${token}`)).text();
    assert.match(pageHtml, /Meet the Bloom Florist assistant/);
    assert.match(pageHtml, /noindex/);
    assert.match(pageHtml, /What your assistant learnt/);
    const scripts = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((js) => /twinlist/.test(js));
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Function(scripts[0]), 'the demo page script parses');
    // Business Twin: what it learnt, each fact with the page it came from; missing facts are named, not invented
    const twin = await (await fetch(`${base}/try/${token}/twin`)).json();
    assert.ok(twin.summary.pages >= 3);
    const dl = twin.facts.find((f) => f.key === 'delivery');
    assert.equal(dl.status, 'found');
    assert.ok(dl.values.some((v) => /£4\.95/.test(v.value) && /\/delivery$/.test(v.source.url)));
    assert.equal(twin.facts.find((f) => f.key === 'hours').status, 'missing');

    // the demo shop is hidden from the super admin client list
    const t = tenants.getTenant(st.tenantId);
    assert.ok(isDemo(t));

    const chat = await (await fetch(`${base}/chat/${st.tenantId}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'demosession1234567890', text: 'how much is delivery?' }) })).json();
    assert.match(chat.replies.map((m) => m.text).join(' '), /£4\.95/);
    assert.match(chat.replies[0].text, /I'm Bloom Florist assistant/); // not the bare domain

    // keep it: sign-up with the demo token claims the same shop
    const s = await (await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ business: 'Bloom Florist Ltd', email: 'owner@example.com', acceptTerms: true, plan: 'growth', demo: token }) })).json();
    assert.equal(s.tenantId, st.tenantId);
    assert.equal(s.fromDemo, true);
    const kept = tenants.getTenant(st.tenantId);
    assert.equal(isDemo(kept), false);
    assert.equal(kept.plan, 'growth');
    assert.ok(tenants.authenticateAdminKey(kept.id, s.adminKey));
    assert.ok(getDb().prepare("SELECT COUNT(*) AS n FROM knowledge_docs WHERE tenant_id = ?").get(kept.id).n >= 3);
    assert.equal((await fetch(`${base}/try/${token}/twin`)).status, 404, 'a claimed demo is no longer public');
    const ownerTwin = await (await fetch(`${base}/api/tenants/${kept.id}/twin`, { headers: { Authorization: 'Bearer ' + s.adminKey } })).json();
    assert.equal(ownerTwin.summary.pages, twin.summary.pages, 'what was learnt in the demo is kept after sign-up');

    // an unclaimed, expired demo is deleted with its knowledge
    const r2 = await (await fetch(base + '/try', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ website: origin }) })).json();
    for (let i = 0; i < 100; i++) { st = await (await fetch(`${base}/try/${r2.token}/status`)).json(); if (st.status !== 'reading') break; await new Promise((x) => setTimeout(x, 100)); }
    assert.equal(cleanupDemos(Date.now() + 49 * 3600000), 1);
    assert.equal(tenants.getTenant(st.tenantId), undefined);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_docs WHERE tenant_id = ?').get(st.tenantId).n, 0);
    assert.equal((await (await fetch(`${base}/try/${r2.token}/status`)).json()).status, 'gone');
    assert.ok(tenants.getTenant(kept.id), 'kept shop untouched');
  } finally { Object.assign(config, prev); srv.close(); site.close(); llm.close(); }
});

test('a live shop cannot be deleted by an automated clean-up; demos can; the super admin can force it', async () => {
  const { tenant: live } = tenants.createTenant({ name: 'Live Shop' });
  assert.throws(() => tenants.deleteTenant(live.id), /live shop/);
  assert.ok(tenants.getTenant(live.id));
  const { tenant: demo } = tenants.createTenant({ name: 'Demo Shop' });
  tenants.updateTenantSettings(demo.id, { demo: { source: 'demo-engine' } });
  tenants.deleteTenant(demo.id);
  assert.equal(tenants.getTenant(demo.id), undefined);
  tenants.deleteTenant(live.id, { force: true });
  assert.equal(tenants.getTenant(live.id), undefined);
});
