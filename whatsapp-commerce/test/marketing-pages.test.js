import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('./helpers.js');
const { createApp } = await import('../src/server.js');

test('trades and salons pages: live, in the sitemap and footer, linking to real examples; no invented numbers or testimonials', async () => {
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [path, example] of [['/trades', '/examples#emergency'], ['/salons', '/examples#salon_booking']]) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, path);
      const html = await r.text();
      assert.match(html, new RegExp(`href="${example}"`), `${path} links to its example`);
      assert.match(html, /"@type":"FAQPage"/);
      assert.doesNotMatch(html, /\d+% (more|of customers|increase)|★★★★★|testimonial|trusted by \d/i, `${path}: no made-up claims`);
    }
    const sm = await (await fetch(base + '/sitemap.xml')).text();
    assert.match(sm, /\/trades</); assert.match(sm, /\/salons</);
    assert.match(await (await fetch(base + '/')).text(), /href="\/trades"/);
    // the example anchors they link to exist
    const ex = await (await fetch(base + '/examples')).text();
    assert.match(ex, /id="emergency"/); assert.match(ex, /id="salon_booking"/);
  } finally { server.close(); }
});
