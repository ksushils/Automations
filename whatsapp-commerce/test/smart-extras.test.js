import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants, say } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { applyTrade, guessTrade, TRADES } from '../src/trades.js';
import { searchGuides, askGuides, GUIDES } from '../src/platformHelp.js';
import { retrieve } from '../src/ai/rag.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const admin = (base, path, opts = {}) => fetch(`${base}/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}` }, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
/** Fake AI: answers by looking at the request. */
async function withAi(answer, fn) {
  const prevCfg = { ...config };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '', aiAudioModel: 'test/audio' });
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, o) => (String(url).includes('ai.test') ? new Response(JSON.stringify({ choices: [{ message: { content: answer(JSON.parse(o.body)) } }] })) : prev(url, o));
  try { return await fn(); } finally { globalThis.fetch = prev; Object.assign(config, prevCfg); }
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

test('"Teach the bot": a team answer becomes knowledge (and a help-centre draft if asked)', () => withServer(async (base) => {
  const t = makeTenant();
  getDb().prepare("INSERT INTO unanswered (tenant_id, wa_id, question, answer, reason) VALUES (?, '1', 'Do you do gift wrapping?', '', 'unsure')").run(t.id);
  const r = await admin(base, `/tenants/${t.id}/teach`, { method: 'POST', body: { question: 'Do you do gift wrapping?', answer: 'Yes – gift wrapping is £3 and includes a card.', article: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.article.status, 'draft');
  assert.equal(r.body.article.source, 'team');
  assert.equal(getDb().prepare('SELECT status FROM unanswered WHERE tenant_id = ?').get(t.id).status, 'answered');
  const hits = await retrieve(t.id, 'gift wrapping', { k: 2 });
  assert.match(hits[0].text, /£3/);
}));

test('an unhappy customer is flagged in the Inbox; a returning visitor is welcomed back by name', () => withServer(async (base) => {
  const t = makeTenant();
  const wa = '447700900333';
  await say(t, wa, 'hi');
  await say(t, wa, 'this is useless, nobody answers');
  const conv = (await admin(base, `/tenants/${t.id}/conversations`)).body.conversations.find((c) => c.wa_id === wa);
  assert.ok(conv.unhappy_at, 'flagged');
  // returning website visitor with a name (from the form before the chat)
  const web = 'web:returningSessionABCD12';
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id, name) VALUES (?, ?, 'Priya Shah')").run(t.id, web);
  getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, ?, 'in', 'text', '{\"text\":\"balayage prices?\"}', datetime('now', '-3 days'))").run(t.id, web);
  const r = await say(t, web, { action: 'open' });
  assert.match(r[0].text, /Welcome back, Priya!/);
  const again = await say(t, web, { action: 'open' });
  assert.doesNotMatch(again[0].text, /Welcome back/, 'only once');
}));

test('website chat: voice messages are transcribed and answered; photos are described (AI stubbed)', () => withAi((b) => {
  const c = b.messages[0].content;
  if (Array.isArray(c) && c.some((p) => p.type === 'input_audio')) return 'What time do you open on Saturday?';
  if (Array.isArray(c) && c.some((p) => p.type === 'image_url')) return '{"product": false, "query": "", "description": "a leaking pipe under a sink"}';
  return 'We open at 9am on Saturdays.';
}, () => withServer(async (base) => {
  const t = makeTenant({ store: { type: 'none' } });
  const js = await (await fetch(`${base}/chat-widget/${t.id}.js`)).text();
  assert.match(js, /"voice":true/);
  assert.match(js, /wc-mic/);
  assert.doesNotThrow(() => new Function(js));
  const sid = 'voiceSessionABCDEFGH123';
  let r = await (await fetch(`${base}/chat/${t.id}/voice?sessionId=${sid}`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(2000, 1) })).json();
  assert.equal(r.transcript, 'What time do you open on Saturday?');
  assert.ok(r.replies.length);
  assert.ok(getDb().prepare("SELECT 1 FROM messages WHERE tenant_id = ? AND body LIKE '%\"voice\":true%'").get(t.id));
  assert.equal((await fetch(`${base}/chat/${t.id}/voice?sessionId=${sid}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 400);
  r = await (await fetch(`${base}/chat/${t.id}/upload?sessionId=${sid}&name=sink.png`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG })).json();
  assert.match(r.replies[0].text, /I can see a leaking pipe under a sink/);
  assert.match(getDb().prepare("SELECT body FROM messages WHERE tenant_id = ? AND type = 'file'").get(t.id).body, /leaking pipe/);
})));

test('new trade templates: garage, estate agent, gym, nursery/tutor, hotel, IT support (with tickets), venue', () => {
  for (const k of ['garage', 'property', 'fitness', 'education', 'hospitality', 'it_support', 'venue']) assert.ok(TRADES[k], k);
  const t = makeTenant();
  const r = applyTrade(t.id, 'it_support');
  assert.ok(r.applied.includes('support tickets'));
  const S = tenants.getTenant(t.id).settings;
  assert.equal(S.tickets.enabled, true);
  assert.match(S.ai.tradeRules, /Never ask for passwords/);
  assert.equal(guessTrade('Smith Motors MOT Centre'), 'garage');
  assert.equal(guessTrade('Harrow Lettings & Estate Agents'), 'property');
  assert.equal(guessTrade('Little Acorns Nursery'), 'education');
  assert.equal(guessTrade('The Old Mill Wedding Venue'), 'venue');
  assert.equal(guessTrade('NetFix IT Support'), 'it_support');
});

test('our own help: guides are public, searchable, and the dashboard Help answers from them', () => withServer(async (base) => {
  assert.ok(GUIDES.length >= 12);
  assert.equal(searchGuides('how do I connect whatsapp')[0].slug, 'connect-whatsapp');
  assert.equal(searchGuides("chat isn't showing on my website")[0].slug, 'chat-not-showing');
  assert.match(await (await fetch(`${base}/guides`)).text(), /Getting started in 10 minutes/);
  assert.match(await (await fetch(`${base}/guides/support-tickets`)).text(), /Turn on tickets/);
  const r = await admin(base, '/platform-help/ask', { method: 'POST', body: { question: 'how do I add the chat to my website?' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.links.some((l) => /add-chat-to-website/.test(l.url)));
  await withAi(() => 'Go to Settings → Website AI chat and copy the one-line code.', async () => {
    const a = await askGuides('how do I add the chat?');
    assert.match(a.answer, /Settings → Website AI chat/);
  });
}));
