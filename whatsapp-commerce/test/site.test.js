import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { createApp } from '../src/server.js';
import { getDb } from '../src/db.js';
import { calculate, calcInputs } from '../src/site.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('every public page is server-rendered with title, description, canonical and structured data', () => withServer(async (base) => {
  for (const [path, title] of [['/', /WhatsApp and website AI assistant for UK small businesses/], ['/pricing', /Pricing \|/], ['/takeaways', /WhatsApp ordering for UK takeaways/], ['/whatsapp-cost-calculator', /WhatsApp Business API cost calculator \(UK, 2026\)/], ['/demo', /Book a demo/]]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    const h = await r.text();
    assert.match(h, /<html lang="en-GB">/);
    assert.match(h.match(/<title>([^<]*)<\/title>/)[1], title, path);
    assert.match(h, /<meta name="description" content="[^"]{40,}">/, path);
    assert.match(h, new RegExp(`<link rel="canonical" href="http://localhost:0${path === '/' ? '/' : path}">`), path);
    assert.match(h, /<script type="application\/ld\+json">/, path);
    assert.equal((h.match(/<h1>/g) || []).length, 1, `${path} has exactly one h1`);
    assert.match(h, /href="\/legal\/dpa"/, 'footer links the DPA');
    assert.ok(!/Start free trial/.test(h), 'no free-trial button in the nav');
    const ld = JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(ld['@context'], 'https://schema.org');
  }
  assert.match(await (await fetch(base + '/')).text(), /Your customers message at 11pm/);
  const pricing = await (await fetch(base + '/pricing')).text();
  assert.match(pricing, /£249/);
  assert.match(pricing, /first 1,000 a month are free, then about 1\.7p each/);
}));

test('sitemap and robots', () => withServer(async (base) => {
  const sm = await (await fetch(base + '/sitemap.xml')).text();
  for (const p of ['/', '/pricing', '/takeaways', '/whatsapp-cost-calculator', '/legal/dpa']) assert.ok(sm.includes(`<loc>http://localhost:0${p}</loc>`), p);
  const rb = await (await fetch(base + '/robots.txt')).text();
  assert.match(rb, /Disallow: \/admin/);
  assert.match(rb, /Disallow: \/r\//, 'receipts are not indexed');
  assert.match(rb, /Sitemap: http:\/\/localhost:0\/sitemap\.xml/);
  assert.match(await (await fetch(base + '/admin/')).text(), /noindex/);
}));

test('cost calculator: the copy deck example comes out at about £14, and the result is shareable by URL', () => withServer(async (base) => {
  const res = calculate(calcInputs({ c: '200', r: '7', u: '200', m: '80', cc: 'GB' }));
  assert.deepEqual(res.lines.map((l) => l.count), [1400, 200, 80]);
  assert.deepEqual(res.lines.map((l) => +l.cost.toFixed(2)), [6.8, 3.4, 4]);
  assert.equal(res.total, 14.2);
  assert.equal(calculate(calcInputs({ c: '30', r: '5', u: '0', m: '0' })).total, 0, 'small shops pay nothing');
  assert.deepEqual(calcInputs({ c: '-5', r: 'abc', cc: 'XX' }), { customers: 200, replies: 7, updates: 200, marketing: 80, country: 'GB' });
  const h = await (await fetch(base + '/whatsapp-cost-calculator?c=200&r=7&u=200&m=80&cc=GB')).text();
  assert.match(h, /About £14 a month/);
  assert.match(h, /"@type":"FAQPage"/);
}));

test('demo form saves a lead, rejects bad input, ignores bots; super admin can list leads', () => withServer(async (base) => {
  const post = (body) => fetch(base + '/demo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  let r = await post({ name: 'Priya', business: 'Spice Hut', email: 'priya@spicehut.test', phone: '07700 900123', message: 'Friday rush' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Thanks, we've got it/);
  r = await post({ name: 'X', business: 'Y', email: 'nope' });
  assert.equal(r.status, 400);
  await post({ name: 'Bot', business: 'Bot', email: 'bot@bot.test', company_website: 'spam' });
  const rows = getDb().prepare("SELECT name, business, email FROM leads WHERE kind = 'demo'").all().map((x) => ({ ...x }));
  assert.deepEqual(rows, [{ name: 'Priya', business: 'Spice Hut', email: 'priya@spicehut.test' }]);
  const list = await (await fetch(base + '/api/system/leads', { headers: { Authorization: 'Bearer super-admin-test-key' } })).json();
  assert.equal(list.leads[0].business, 'Spice Hut');
  assert.equal((await fetch(base + '/api/system/leads')).status, 401);
}));

test('homepage assistant: created from Setup, then the chat appears on the homepage', () => withServer(async (base) => {
  assert.ok(!/chat-widget/.test(await (await fetch(base + '/')).text()));
  const r = await (await fetch(base + '/api/system/site-assistant', { method: 'POST', headers: { Authorization: 'Bearer super-admin-test-key' } })).json();
  assert.ok(r.tenantId);
  const h = await (await fetch(base + '/')).text();
  assert.match(h, new RegExp(`/chat-widget/${r.tenantId}\\.js`));
  const again = await (await fetch(base + '/api/system/site-assistant', { method: 'POST', headers: { Authorization: 'Bearer super-admin-test-key' } })).json();
  assert.equal(again.tenantId, r.tenantId, 'running it again refreshes the same assistant');
}));

test('comparison pages: honest structure, sourced, in the sitemap and footer', () => withServer(async (base) => {
  for (const [slug, name] of [['wati-alternative', 'Wati'], ['interakt-alternative', 'Interakt'], ['aisensy-alternative', 'AiSensy']]) {
    const r = await fetch(`${base}/${slug}`);
    assert.equal(r.status, 200, slug);
    const h = await r.text();
    assert.match(h, new RegExp(`<title>${name} alternative for UK small businesses`));
    assert.match(h, new RegExp(`Where ${name} is better`), 'concedes real ground first');
    assert.match(h, /checked on 10 November 2026/);
    assert.match(h, /rel="nofollow noopener"/);
    assert.match(h, /is not endorsed by/);
    assert.equal((h.match(/<h1>/g) || []).length, 1);
    assert.match(h, /"@type":"FAQPage"/);
  }
  const sm = await (await fetch(base + '/sitemap.xml')).text();
  assert.ok(sm.includes('/wati-alternative</loc>') && sm.includes('/aisensy-alternative</loc>'));
  assert.match(await (await fetch(base + '/')).text(), /href="\/interakt-alternative"/);
}));
