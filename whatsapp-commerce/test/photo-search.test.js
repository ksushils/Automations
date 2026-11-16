import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, ids, tenants, engine } = await import('./helpers.js');
const { config } = await import('../src/config.js');

async function photo(t, waId, aiAnswer) {
  const prevCfg = { ...config };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '' });
  const prev = globalThis.fetch;
  let aiBody = null;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes('graph.facebook.com')) return new Response(JSON.stringify({ url: 'https://media.test/p.jpg', mime_type: 'image/jpeg' }));
    if (url === 'https://media.test/p.jpg') return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.includes('/chat/completions')) { aiBody = JSON.parse(opts.body); return new Response(JSON.stringify({ choices: [{ message: { content: aiAnswer } }], usage: { total_tokens: 9 } })); }
    return new Response(JSON.stringify({ messages: [{ id: 'w' }] }));
  };
  try {
    const sent = [];
    await engine.handleInbound(tenants.getTenant(t.id), { waId, kind: 'media', type: 'image', mediaId: 'IMG1', mime: 'image/jpeg', caption: 'do you have this?', text: 'do you have this?', profileName: 'Al' }, async (to, m) => sent.push(m));
    return { sent, aiBody };
  } finally { globalThis.fetch = prev; Object.assign(config, prevCfg); }
}

test('photo search: a product photo is answered with matching products', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: '1', accessToken: 'x' } });
  const { sent, aiBody } = await photo(t, '447700912001', '{"product": true, "query": "white mug", "description": "a white ceramic mug"}');
  assert.equal(aiBody.messages[0].content[1].type, 'image_url');
  assert.match(aiBody.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  const list = sent.find((m) => m.type === 'list');
  assert.ok(list, JSON.stringify(sent));
  assert.match(list.text, /white ceramic mug/);
  assert.deepEqual(ids([list]), ['p:mug']);
});

test('photo search: not a product (e.g. a receipt) → the usual "team will check" reply', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: '1', accessToken: 'x' } });
  const { sent } = await photo(t, '447700912002', '{"product": false, "query": "", "description": "a payment receipt"}');
  assert.match(sent.map((m) => m.text).join(' '), /team will check/);
});
