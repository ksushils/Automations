import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const { makeTenant, tenants } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { getDb } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');
const { trackMessage, clickStats } = await import('../src/tracking.js');
const { runQualityCheck, lastQuality, questionsFor } = await import('../src/quality.js');
const { addTextDoc } = await import('../src/knowledge.js');

test('tracking: shop links get UTM tags, buttons become counted /go/ links; other sites untouched', async () => {
  const t = makeTenant({ business: { website: 'https://www.bloom.test' } });
  const m = trackMessage(t, '447700913001', { type: 'text', text: 'See https://bloom.test/delivery. Or https://other.test/x' });
  assert.match(m.text, /https:\/\/bloom\.test\/delivery\?utm_source=ai-assistant&utm_medium=whatsapp&utm_campaign=chat\./);
  assert.match(m.text, /https:\/\/other\.test\/x$/);
  const c = trackMessage(t, 'web:abc', { type: 'cta', text: 'Checkout', buttonText: 'Pay', url: 'https://bloom.test/cart/1:2?ref=whatsapp' });
  assert.match(c.url, /\/go\/[A-Za-z0-9_-]+$/);
  const stripe = trackMessage(t, '447700913001', { type: 'cta', text: 'Pay', buttonText: 'Pay', url: 'https://checkout.stripe.com/x' });
  assert.equal(stripe.url, 'https://checkout.stripe.com/x');

  const srv = createApp().listen(0);
  try {
    const path = new URL(c.url).pathname;
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^https:\/\/bloom\.test\/cart\/1:2\?ref=whatsapp&utm_source=ai-assistant&utm_medium=webchat/);
  } finally { srv.close(); }
  const s = clickStats(t.id, '2000-01-01', '2999-01-01');
  assert.deepEqual(s, { linksSent: 1, linksClicked: 1, checkoutsStarted: 1 });
});

test('answer check: replays real questions, grades answers, leaves no trace in chats', async () => {
  const llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const body = JSON.parse(raw);
      const last = String(body.messages.filter((m) => m.role === 'user').at(-1).content);
      let content;
      if (/You check a shop assistant/.test(last)) content = /£3\.50/.test(last.split('Assistant:')[1] || '') ? '{"score": 5, "reason": "correct delivery price"}' : '{"score": 1, "reason": "made up"}';
      else content = /deliver/i.test(last) ? 'Delivery is £3.50 and takes 2 days.' : 'We are open 24/7 on the moon.';
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 3 } }));
    });
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const prev = { ...config };
  Object.assign(config, { aiBaseUrl: `http://127.0.0.1:${llm.address().port}/v1`, aiApiKey: 'sk-test', embeddingsModel: '' });
  try {
    const t = makeTenant({ store: { type: 'none' } });
    addTextDoc(t.id, { name: 'Delivery', text: 'Delivery costs £3.50 and takes 2 working days across the UK.' });
    const ins = getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, ?, 'in', 'text', ?)");
    ins.run(t.id, '447700913100', JSON.stringify({ text: 'How much is delivery to Leeds?' }));
    ins.run(t.id, '447700913101', JSON.stringify({ text: 'how much is delivery to leeds?' }));
    ins.run(t.id, '447700913102', JSON.stringify({ text: 'What are your opening hours?' }));
    ins.run(t.id, '447700913103', JSON.stringify({ text: 'hi' }));
    const qs = questionsFor(tenants.getTenant(t.id), 2);
    assert.deepEqual(qs.map((q) => q.toLowerCase()), ['how much is delivery to leeds?', 'what are your opening hours?']);
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ?').get(t.id).n;
    const r = await runQualityCheck(t.id, { limit: 2 });
    assert.equal(r.good, 1);
    assert.equal(r.wrong, 1);
    assert.equal(r.score, 50);
    assert.equal(r.results.find((x) => x.verdict === 'wrong').question, 'What are your opening hours?');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ?').get(t.id).n, before, 'no qa messages left behind');
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND wa_id LIKE 'qa:%'").get(t.id).n, 0);
    assert.equal(lastQuality(t.id).id, r.id);
  } finally { Object.assign(config, prev); llm.close(); }
});
