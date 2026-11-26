import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, say } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { getDb } = await import('../src/db.js');
const { addTextDoc } = await import('../src/knowledge.js');
const { shortLabel, offersPerson, wantsPerson } = await import('../src/bot/engine.js');
const { guardPrices } = await import('../src/verified.js');
const { getConversation } = await import('../src/bot/state.js');
const rag = await import('../src/ai/rag.js');
const { buildPrompt } = await import('../src/dify/provision.js');

/*
 * Answer-quality fixes found by trying the assistant on real websites (26 Nov 2026, src/cli/trySite.js).
 */

/** The AI answers each question with the next of `answers`; embeddings get a fake vector; anything else fails. */
async function withAi(answers, fn) {
  const prev = { fetch: globalThis.fetch, base: config.aiBaseUrl, key: config.aiApiKey, emb: config.embeddingsModel, auto: config.embeddingsAuto };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '', embeddingsAuto: false });
  const queue = [...answers];
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: queue.shift() ?? 'OK' } }], usage: { total_tokens: 10 } }));
    if (String(url).startsWith('http://127.0.0.1')) return prev.fetch(url, o);
    throw new Error(`unexpected network call: ${url}`);
  };
  try { return await fn(); } finally { globalThis.fetch = prev.fetch; Object.assign(config, { aiBaseUrl: prev.base, aiApiKey: prev.key, embeddingsModel: prev.emb, embeddingsAuto: prev.auto }); }
}

test('button labels are cut at a word within 20 characters, never mid-word', () => {
  assert.equal(shortLabel('Yes, please!'), 'Yes, please!');
  assert.equal(shortLabel('What dishes do you have?'), 'What dishes do you…');
  assert.ok(shortLabel('What dishes do you have?').length <= 20);
  assert.ok(shortLabel('Supercalifragilisticexpialidocious').length <= 20);
});

test('"Would you like someone from the team?" + [HANDOVER]: the customer is asked first, the chat is not handed over', () => withAi([
  "I'm not sure about a 50% student discount on Sundays. Would you like me to get someone from the team to assist you? [HANDOVER]",
  'Our delivery is £3.50.',
], async () => {
  const t = makeTenant({ store: { type: 'none' }, ai: { provider: 'direct' } });
  const out = await say(t, '447700900601', 'Do you offer a student discount of 50% on Sundays?');
  const ask = out.find((m) => m.type === 'buttons');
  assert.ok(ask, 'a yes/no question');
  assert.deepEqual(ask.buttons.map((b) => b.id), ['human', 'menu']);
  assert.doesNotMatch(ask.text, /HANDOVER/);
  assert.equal(getConversation(t.id, '447700900601').humanHandover, false, 'not handed over without a yes');
  // the assistant keeps answering
  addTextDoc(t.id, { name: 'Delivery', text: 'Delivery costs £3.50 anywhere in town, free over £30.' });
  const next = await say(t, '447700900601', 'how much is delivery?');
  assert.ok(next.some((m) => /£3\.50/.test(m.text || '')), 'still answered by the assistant');
  // tapping "Yes, please" hands over
  await say(t, '447700900601', { action: 'human' });
  assert.equal(getConversation(t.id, '447700900601').humanHandover, true);
}));

test('a customer who asks for a person, or complains, is handed over straight away', () => withAi(["Sorry about that – would you like me to get someone from the team? [HANDOVER]"], async () => {
  const t = makeTenant({ store: { type: 'none' }, ai: { provider: 'direct' } });
  await say(t, '447700900602', 'my order arrived damaged, I want a refund');
  assert.equal(getConversation(t.id, '447700900602').humanHandover, true);
  assert.ok(offersPerson('Would you like me to get someone from the team to help?'));
  assert.ok(!offersPerson('Our team replies within a day.'));
  assert.ok(wantsPerson('can I speak to a real person'));
  assert.ok(!wantsPerson('do you deliver on Sundays?'));
}));

test('price guard: an amount the assistant already gave in this chat may be repeated', () => {
  const answer = 'Yes – UK delivery is free on orders over £45.';
  assert.equal(guardPrices(answer, [{ text: 'Free shipping on many items.' }]).blocked.length, 1, 'unknown amount is still blocked');
  const ok = guardPrices(answer, [{ text: 'Free shipping on many items.' }], { productText: 'We offer free UK delivery on orders over £45.' });
  assert.deepEqual(ok.blocked, []);
  assert.equal(ok.answer, answer);
});

test('the prompt tells the assistant not to deny what the information just doesn\'t mention, and not to hand over while asking', () => {
  const t = makeTenant({ store: { type: 'none' } });
  const p = buildPrompt(t);
  assert.match(p, /never say the shop doesn't have it/);
  assert.match(p, /don't add \[HANDOVER\] to that reply/);
});

test('embeddings: automatic with the OpenRouter key (same data rules as the chat), off when switched off; old pages are back-filled', async () => {
  const prev = { fetch: globalThis.fetch, base: config.aiBaseUrl, key: config.aiApiKey, model: config.embeddingsModel, ekey: config.embeddingsApiKey, auto: config.embeddingsAuto, zr: config.aiZeroRetention };
  try {
    Object.assign(config, { aiBaseUrl: 'https://openrouter.ai/api/v1', aiApiKey: 'sk-or-test', embeddingsModel: '', embeddingsApiKey: '', embeddingsAuto: true, aiZeroRetention: true });
    const c = rag.embeddingsConfig();
    assert.equal(c.model, rag.AUTO_EMBEDDINGS_MODEL);
    assert.equal(c.base, 'https://openrouter.ai/api/v1');
    config.embeddingsAuto = false;
    assert.equal(rag.embeddingsEnabled(), false, 'EMBEDDINGS_AUTO=false: keyword search only');
    config.embeddingsAuto = true;
    Object.assign(config, { aiBaseUrl: 'https://api.other-ai.test/v1' });
    assert.equal(rag.embeddingsEnabled(), false, 'not OpenRouter and no EMBEDDINGS_MODEL: off');
    Object.assign(config, { aiBaseUrl: 'https://openrouter.ai/api/v1' });

    const t = makeTenant({ store: { type: 'none' } });
    config.embeddingsAuto = false;
    addTextDoc(t.id, { name: 'Puddings', text: 'Our puddings: kulfi on a stick, chocolate chai pot, mango and black pepper sorbet.' });
    await new Promise((r) => setTimeout(r, 30));
    const pending = () => getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_chunks c JOIN knowledge_docs k ON k.id = c.doc_id WHERE k.tenant_id = ? AND c.embedding IS NULL').get(t.id).n;
    assert.ok(pending() >= 1, 'learnt while embeddings were off');
    config.embeddingsAuto = true;
    const bodies = [];
    globalThis.fetch = async (url, o) => {
      assert.equal(String(url), 'https://openrouter.ai/api/v1/embeddings');
      const b = JSON.parse(o.body); bodies.push(b);
      return new Response(JSON.stringify({ data: b.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }));
    };
    assert.ok(await rag.backfillEmbeddings() >= 1);
    assert.equal(pending(), 0);
    assert.equal(bodies[0].model, 'openai/text-embedding-3-small');
    assert.equal(bodies[0].provider?.data_collection, 'deny', 'no providers that train on the data');
  } finally {
    globalThis.fetch = prev.fetch;
    Object.assign(config, { aiBaseUrl: prev.base, aiApiKey: prev.key, embeddingsModel: prev.model, embeddingsApiKey: prev.ekey, embeddingsAuto: prev.auto, aiZeroRetention: prev.zr });
  }
});

test('price guard: menu prices printed without a £ sign ("Lamb Samosas 8.20") are known amounts', () => {
  const src = [{ text: 'Lamb Samosas 8.20\nChilli Chicken 10.90\nHouse Black Daal 6.90' }];
  assert.deepEqual(guardPrices('Lamb Samosas are £8.20 and the Chilli Chicken is £10.90.', src).blocked, []);
  assert.deepEqual(guardPrices('Lamb Samosas are £8.20 and the Chilli Chicken is £12.50.', src).blocked, ['£12.5']);
  assert.deepEqual(guardPrices('A table for 4 is £20.', [{ text: 'We have 20 tables and opened in 2010.' }]).blocked, ['£20'], 'plain whole numbers are not prices');
});

test('an answer that already offers to check with the team gets one set of real buttons, not a second "sorry" offer', () => withAi([
  "I'm not sure about the opening times for that branch. Would you like me to check with the team? [CHOICES: Yes, please! | No, thanks | Check later]",
  "I can't see a student discount in our information. Would you like me to check with the team for you? [CHOICES: Yes, please! | No, thanks]",
], async () => {
  const t = makeTenant({ store: { type: 'none' }, ai: { provider: 'direct' } });
  for (const q of ['What time does the Covent Garden branch open?', 'Do you offer a student discount?']) {
    const out = await say(t, '447700900603', q);
    assert.equal(out.length, 1, `one message for "${q}"`);
    assert.deepEqual(out[0].buttons.map((b) => b.id.split(':')[0]), ['human', 'lead', 'menu']);
    assert.doesNotMatch(out[0].text, /CHOICES|couldn't answer that properly/);
  }
  assert.equal(getConversation(t.id, '447700900603').humanHandover, false);
}));

test('welcome-menu labels longer than WhatsApp allows end at a word ("🧖‍♀️ Pampering Treatments" never becomes "Pampering Treatmen")', () => {
  const label = shortLabel('🧖 Pampering Treatments and Spa', 24);
  assert.ok(label.length <= 24);
  assert.match(label, /…$/);
  assert.doesNotMatch(label, /Treatmen…/);
});
