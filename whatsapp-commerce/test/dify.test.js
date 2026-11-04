import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, say, ids, tenants } from './helpers.js';
import { parseDifyStream } from '../src/dify/client.js';
import { toWhatsAppFormatting } from '../src/bot/engine.js';

function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

test('parses agent + chat SSE streams', async () => {
  const body = sse([
    { event: 'agent_thought', conversation_id: 'c1' },
    { event: 'agent_message', answer: 'Hello ', conversation_id: 'c1' },
    { event: 'agent_message', answer: 'there', conversation_id: 'c1' },
    { event: 'message_end', conversation_id: 'c1' },
  ]);
  const stream = new Response(body).body;
  const r = await parseDifyStream(stream);
  assert.equal(r.answer, 'Hello there');
  assert.equal(r.conversationId, 'c1');
});

test('markdown → WhatsApp formatting', () => {
  assert.equal(toWhatsAppFormatting('**Big** [shop](https://x.y) ## no'), '*Big* shop: https://x.y ## no');
  assert.equal(toWhatsAppFormatting('### Title'), '*Title*');
});

test('assist mode: sends store context to Dify and attaches tappable products', async () => {
  let captured;
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      captured = { auth: req.headers.authorization, body: JSON.parse(b), url: req.url };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse([{ event: 'message', answer: 'Our **White Mug** is lovely!', conversation_id: 'conv-9' }, { event: 'message_end', conversation_id: 'conv-9' }]));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const t = makeTenant({ dify: { enabled: true, apiKey: 'app-test', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, mode: 'assist' } });
  const r = await say(t, '447700900010', 'what mugs do you sell?');
  server.close();

  assert.equal(captured.url, '/v1/chat-messages');
  assert.equal(captured.auth, 'Bearer app-test');
  assert.equal(captured.body.response_mode, 'streaming');
  assert.match(captured.body.query, /White Mug \| £8\.50/);
  assert.ok(captured.body.inputs.session_token);
  assert.equal(r[0].type, 'list');
  assert.match(r[0].text, /\*White Mug\* is lovely/);
  assert.deepEqual(ids(r), ['p:mug']);
  assert.equal(tenants.getUsage(t.id).ai_calls, 1);
});

test('Dify failure falls back to catalogue search', async () => {
  const t = makeTenant({ dify: { enabled: true, apiKey: 'app-x', baseUrl: 'http://127.0.0.1:1/v1' } });
  const r = await say(t, '447700900011', 'mug please');
  assert.deepEqual(ids(r), ['p:mug']);
});
