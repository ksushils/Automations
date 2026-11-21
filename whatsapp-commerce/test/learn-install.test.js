import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, tenants } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { topQuestions, menuSuggestions, dismissSuggestion, improveTradeTemplates, learnedQuestions, labelFor } from '../src/learn.js';
import { questionsFor } from '../src/quality.js';
import { checkInstall } from '../src/install.js';

const ask = (tenantId, waId, text) => getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, ?, 'in', 'text', ?)").run(tenantId, waId, JSON.stringify({ type: 'text', text }));

test('menu suggestions: what customers keep asking that the menu doesn\'t cover', () => {
  const t = makeTenant({ welcomeMenu: { enabled: true, intro: 'Hi', options: [{ label: '🕒 Opening hours', action: 'ask', value: 'What are your opening hours?' }] } });
  ask(t.id, '1', 'Is there parking near you?');
  ask(t.id, '2', 'is there any parking nearby?');
  ask(t.id, '3', 'Where can I park?');
  ask(t.id, '4', 'What are your opening hours?');
  ask(t.id, '5', 'what are your opening hours on Sunday?');
  ask(t.id, '6', 'Do you sell gift cards?'); // only once: not a pattern yet
  const top = topQuestions(t.id);
  assert.ok(top[0].n >= 2);
  const s = menuSuggestions(tenants.getTenant(t.id));
  assert.ok(s.some((x) => /park/i.test(x.question)), 'parking suggested');
  assert.ok(!s.some((x) => /opening hours/i.test(x.question)), 'already on the menu');
  assert.ok(!s.some((x) => /gift/i.test(x.question)), 'asked once only');
  const park = s.find((x) => /park/i.test(x.question));
  assert.match(park.label, /^📍/);
  dismissSuggestion(t.id, park.key);
  assert.ok(!menuSuggestions(tenants.getTenant(t.id)).some((x) => x.key === park.key), 'dismissed for good');
  assert.equal(labelFor('How much is delivery to Leeds?').startsWith('🚚'), true);
});

test('trade templates learn across shops (topics at 2+ shops only, generic wording) and feed the answer check', async () => {
  const a = makeTenant({ trade: 'salon' }), b = makeTenant({ trade: 'salon' }), c = makeTenant({ trade: 'salon' });
  for (const [t, i] of [[a, 1], [b, 2]]) { ask(t.id, `p${i}`, 'Do you do keratin treatments?'); ask(t.id, `q${i}`, 'Do you do kids haircuts?'); ask(t.id, `r${i}`, 'Can I bring my dog to the salon?'); }
  ask(c.id, 'x1', 'Is Jessica working on Tuesday at the Harrow branch?'); // one shop only → never shared
  const prevCfg = { ...config };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '' });
  const prev = globalThis.fetch;
  let sent = '';
  globalThis.fetch = async (url, o) => { sent = JSON.parse(o.body).messages[0].content; return new Response(JSON.stringify({ choices: [{ message: { content: '{"questions":["Do you offer keratin treatments?","Do you cut children\'s hair?","Are dogs allowed in the salon?","Call 07700900123 now"]}' } }] })); };
  try {
    assert.ok(await improveTradeTemplates({ force: true }) >= 1);
  } finally { globalThis.fetch = prev; Object.assign(config, prevCfg); }
  assert.match(sent, /keratin/);
  assert.doesNotMatch(sent, /Jessica/, 'a topic from a single shop is not shared');
  const learned = learnedQuestions('salon');
  assert.ok(learned.includes('Do you offer keratin treatments?'));
  assert.ok(!learned.some((q) => /0770/.test(q)), 'numbers / personal details filtered');
  const d = makeTenant({ trade: 'salon', quality: { tradeQuestions: ['How much is a cut?'] } });
  assert.ok(questionsFor(tenants.getTenant(d.id)).includes('Do you offer keratin treatments?'), 'new shops in the trade are checked on them');
});

test('install check: finds this shop\'s code on the website at once; explains common mistakes', async () => {
  const t = makeTenant();
  const pages = { '/': `<html><body><h1>Shop</h1><script src="https://wa.example/chat-widget/${t.id}.js" async></script></body></html>`, '/other': '<html><script src="https://wa.example/chat-widget/someone-else-1234.js"></script></html>', '/gtm': '<html><script src="https://www.googletagmanager.com/gtm.js?id=GTM-1"></script></html>', '/none': '<html><body>Hi</body></html>' };
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(pages[req.url] || ''); }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const was = config.allowPrivateFetch;
  config.allowPrivateFetch = true;
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    let r = await checkInstall(tenants.getTenant(t.id), `${base}/`);
    assert.equal(r.ok, true);
    assert.ok(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(`widget_seen:${t.id}`), 'the setup guide step is ticked');
    assert.equal((await checkInstall(tenants.getTenant(t.id), `${base}/other`)).reason, 'other_shop');
    assert.equal((await checkInstall(tenants.getTenant(t.id), `${base}/gtm`)).reason, 'gtm');
    r = await checkInstall(tenants.getTenant(t.id), `${base}/none`);
    assert.equal(r.reason, 'not_found');
    assert.match(r.message, /Publish/);
    assert.equal((await checkInstall(tenants.getTenant(makeTenant().id), '')).reason, 'no_website');
  } finally { config.allowPrivateFetch = was; srv.close(); }
});

test('dashboard routes for suggestions and the install check exist', async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const t = makeTenant();
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}` };
    assert.deepEqual(await (await fetch(`${base}/tenants/${t.id}/menu-suggestions`, { headers: h })).json(), { suggestions: [] });
    const r = await (await fetch(`${base}/tenants/${t.id}/install/check`, { method: 'POST', headers: h, body: '{}' })).json();
    assert.equal(r.reason, 'no_website');
  } finally { server.close(); }
});
