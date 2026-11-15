import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.REFRESH_PAUSE_MS = '0';
const { makeTenant, tenants } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { getDb } = await import('../src/db.js');
const { importUrl, listDocs } = await import('../src/knowledge.js');
const { refreshWebsite, runWeeklyRefresh, lastRefresh } = await import('../src/refresh.js');

const filler = ' This paragraph is here so the page has enough text to be worth learning from, as a real page would.';
const page = (title, body) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}${filler}</p></main></body></html>`;

test('weekly website re-read: updates changed pages, keeps unchanged, removes pages gone twice, learns new sitemap pages', async () => {
  const site = { delivery: 'Delivery costs £3.50 and takes 2 days.', returnsGone: false };
  let base = '';
  const server = http.createServer((req, res) => {
    const html = (code, body) => { res.writeHead(code, { 'Content-Type': 'text/html' }); res.end(body); };
    if (req.url === '/delivery') return html(200, page('Delivery', site.delivery));
    if (req.url === '/about') return html(200, page('About us', 'We are a family shop in Leeds.'));
    if (req.url === '/returns') return site.returnsGone ? html(404, 'gone') : html(200, page('Returns', 'Returns within 30 days.'));
    if (req.url === '/new-offers') return html(200, page('New offers', 'Spring sale: 20% off all candles.'));
    if (req.url === '/sitemap.xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(`<urlset><url><loc>${base}/delivery</loc></url><url><loc>${base}/about</loc></url><url><loc>${base}/new-offers</loc></url></urlset>`); }
    html(404, 'nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const prev = config.allowPrivateFetch;
  config.allowPrivateFetch = true;
  try {
    const t = makeTenant({ business: { website: base } });
    for (const p of ['/delivery', '/about', '/returns']) await importUrl(t.id, base + p);
    assert.equal(listDocs(t.id).length, 3);

    // the shop changes its delivery price, removes the returns page, adds a new page
    site.delivery = 'Delivery costs £4.95 and takes 2 days.';
    site.returnsGone = true;
    let r = await refreshWebsite(t.id);
    assert.equal(r.ok, true);
    assert.equal(r.updated, 1);
    assert.equal(r.unchanged, 1);
    assert.equal(r.added, 1);
    assert.equal(r.removed, 0, 'gone once: kept (could be a blip)');
    const delivery = getDb().prepare("SELECT text FROM knowledge_docs WHERE tenant_id = ? AND url = ? AND status != 'deleted'").get(t.id, base + '/delivery');
    assert.match(delivery.text, /£4\.95/);
    assert.ok(listDocs(t.id).some((d) => d.name === 'New offers'));

    r = await refreshWebsite(t.id);
    assert.equal(r.removed, 1, 'gone twice: removed');
    assert.equal(r.updated, 0);
    assert.ok(!listDocs(t.id).some((d) => d.name === 'Returns'));
    assert.equal(lastRefresh(t.id).removed, 1);

    // weekly: not due again yet; due after 7 days; switched off = never
    assert.equal(await runWeeklyRefresh({ now: Date.now() }), null);
    const later = await runWeeklyRefresh({ now: Date.now() + 8 * 86400000 });
    assert.equal(later?.ok, true);
    tenants.updateTenantSettings(t.id, { knowledge: { autoRefresh: false } });
    assert.equal(await runWeeklyRefresh({ now: Date.now() + 30 * 86400000 }), null);
  } finally {
    config.allowPrivateFetch = prev;
    server.close();
  }
});
