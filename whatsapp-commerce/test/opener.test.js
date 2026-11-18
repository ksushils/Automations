import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, tenants } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { getConversation } from '../src/bot/state.js';
import { openerFor, extractChoices, DEFAULT_OPENER } from '../src/bot/engine.js';
import { openerConfig, cleanPage } from '../src/routes/webchat.js';
import { buildPrompt } from '../src/dify/provision.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
function fakeLlm(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      calls.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.endsWith('/embeddings')) return res.end(JSON.stringify({ data: [].concat(body.input).map((t, index) => ({ index, embedding: [1, 0, 0] })) }));
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: handler(body, calls) } }], usage: { total_tokens: 10 } }));
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}/v1` })));
}
const post = (base, id, body) => fetch(`${base}/chat/${id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const SID = () => 'sess' + Math.random().toString(36).slice(2).padEnd(20, 'x');

test('greeting by page: the shop\'s own page greetings first, then built-in ones, then the main greeting', () => {
  assert.equal(openerFor({}, 'https://shop.test/'), DEFAULT_OPENER);
  assert.match(DEFAULT_OPENER, /What brings you here today\? Anything in particular you're looking for\?/);
  assert.match(openerFor({}, 'https://shop.test/products/drift-car'), /Questions about this\?/);
  assert.match(openerFor({}, 'https://shop.test/cart'), /finishing your order/);
  const S = { webchat: { opener: { text: 'Hi there! What can I find for you?', pages: [{ match: '/tours', text: 'Planning a trip?' }] } } };
  assert.equal(openerFor(S, 'https://travel.test/tours/kerala'), 'Planning a trip?');
  assert.equal(openerFor(S, 'https://travel.test/about'), 'Hi there! What can I find for you?');
  assert.equal(openerFor({ webchat: { opener: { pageRules: false } } }, 'https://shop.test/products/x'), DEFAULT_OPENER);
  assert.deepEqual(cleanPage({ url: 'https://shop.test/products/x?utm_source=fb&email=a@b.c', title: 'Drift car\nX' }), { url: 'https://shop.test/products/x', title: 'Drift car X' });
  assert.equal(cleanPage({ url: 'javascript:alert(1)' }), null);
});

test('widget: pop-up greeting config (10s, 15s on phones, welcome-menu chips), session-only memory, valid script; can be switched off', () => withServer(async (base) => {
  const t = makeTenant({ welcomeMenu: { enabled: true, intro: 'Are you looking to:', options: [{ label: '🛍️ Browse the shop', action: 'browse' }, { label: '📦 Track my order', action: 'status' }, { label: '🚚 Delivery', action: 'ask', value: 'Delivery?' }, { label: '🙋 Talk to a person', action: 'human' }] } });
  const js = await (await fetch(`${base}/chat-widget/${t.id}.js`)).text();
  assert.doesNotThrow(() => new Function(js));
  const cfg = JSON.parse(js.match(/var C=(\{.*?\}),d=document/)[1]);
  assert.equal(cfg.opener.text, DEFAULT_OPENER);
  assert.equal(cfg.opener.delay, 10);
  assert.equal(cfg.opener.mobileDelay, 15);
  assert.deepEqual(cfg.opener.chips.map((c) => c.id), ['wm:0', 'wm:1', 'wm:2']);
  assert.ok(cfg.opener.rules.length >= 3);
  // pop-up memory is per browsing session only (no lasting storage for it)
  assert.match(js, /mark\(K\+'-closed','1',1\)/);
  assert.match(js, /got\(K\+'-chatted',1\)/);
  tenants.updateTenantSettings(t.id, { webchat: { opener: { enabled: false } } });
  assert.equal(openerConfig(tenants.getTenant(t.id)), null);
  // shops without a welcome menu get sensible chips for their type
  const b = makeTenant({ store: { type: 'none' }, business: { bookingButton: '📅 Book a call' } });
  assert.deepEqual(openerConfig(tenants.getTenant(b.id)).chips.map((c) => c.label), ['📅 Book a call', '❓ Ask a question', '🙋 Talk to a person']);
}));

test('opening the chat from the pop-up: the page greeting with the menu as quick replies; the page is remembered', () => withServer(async (base) => {
  const t = makeTenant();
  const sid = SID();
  const r = await post(base, t.id, { sessionId: sid, actionId: 'open', page: { url: 'https://shop.test/products/classic-tee?utm_source=x', title: 'Classic Tee' } });
  const m = r.replies.find((x) => x.type === 'buttons' || x.type === 'list');
  assert.match(m.text, /Questions about this\?/);
  assert.ok((m.buttons || m.sections[0].rows).length >= 2, 'quick replies');
  assert.deepEqual(getConversation(t.id, `web:${sid}`).data.page.url, 'https://shop.test/products/classic-tee');
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND wa_id = ? AND direction = 'out'").get(t.id, `web:${sid}`).n >= 1, true, 'the greeting is in the inbox and the AI\'s history');
}));

test('the AI knows the page, asks one question with tappable choices, and a tapped choice is answered as the customer\'s words', async () => {
  const llm = await fakeLlm((body) => {
    const last = body.messages.at(-1).content;
    if (/under £50/i.test(last)) return 'Great – the *Classic Tee* is £15 and a lovely gift. Tap *View products* below to order 👇';
    return "Happy to help! What's your budget?\n[CHOICES: Under £50 | £50–£150 | Over £150]";
  });
  const prev = { ...config };
  Object.assign(config, { aiBaseUrl: llm.url, aiApiKey: 'sk-test', aiModel: 'test-model', embeddingsModel: '' });
  try {
    await withServer(async (base) => {
      const t = makeTenant();
      const sid = SID();
      let r = await post(base, t.id, { sessionId: sid, text: "I'm looking for a gift for my brother", page: { url: 'https://shop.test/collections/gifts', title: 'Gift ideas' } });
      const sys = llm.calls.at(-1).messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      assert.match(sys, /The visitor is on this page of the website: "Gift ideas" \(https:\/\/shop\.test\/collections\/gifts\)/);
      assert.match(sys, /ONE short question per reply/);
      const q = r.replies.find((x) => x.type === 'buttons');
      assert.match(q.text, /What's your budget\?/);
      assert.ok(!/CHOICES/.test(JSON.stringify(r.replies)), 'the marker never reaches the customer');
      assert.deepEqual(q.buttons.map((b) => b.title), ['Under £50', '£50–£150', 'Over £150']);
      r = await post(base, t.id, { sessionId: sid, actionId: q.buttons[0].id });
      const call = llm.calls.at(-1);
      assert.equal(call.messages.at(-1).content, 'Under £50');
      assert.ok(call.messages.some((m) => m.role === 'assistant' && /budget/.test(m.content)), 'the AI remembers its question');
      assert.ok(!call.messages.some((m) => /\[say:/.test(m.content)));
      assert.match(JSON.stringify(r.replies), /Classic Tee/);
    });
  } finally { Object.assign(config, prev); llm.srv.close(); }
});

test('choices marker: parsed, capped at 3, stripped when malformed; the instructions teach discovery', () => {
  assert.deepEqual(extractChoices('Who is it for?\n[CHOICES: Me | A friend | My child | My dog]'), { text: 'Who is it for?', choices: ['Me', 'A friend', 'My child'] });
  assert.deepEqual(extractChoices('Plain answer.'), { text: 'Plain answer.', choices: [] });
  const mid = extractChoices('Hello [CHOICES: a | b] there');
  assert.ok(!/CHOICES/.test(mid.text) && mid.choices.length === 0, 'a marker that is not at the end is just removed');
  const t = makeTenant();
  const p = buildPrompt(tenants.getTenant(t.id));
  assert.match(p, /\[CHOICES: answer one \| answer two \| answer three\]/);
  assert.match(p, /If they already said what they want, answer straight away/);
});
