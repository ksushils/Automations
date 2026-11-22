import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import './helpers.js';
import { config } from '../src/config.js';
import { CASES, runCase } from '../src/evals.js';
import { guardPrices } from '../src/verified.js';
import { emergencyNotice } from '../src/safety.js';

/*
 * The "guard" evaluation cases must pass even when the AI gives a deliberately bad answer: these prove the fixed
 * rules (price guard, booking guard, emergency notices, human handover, AI-down fallback) – not the model.
 * The "model" cases need the real model: run src/cli/runEvals.js where an AI key is configured.
 */
async function fakeAi() {
  const state = { answer: '', down: false, calls: 0 };
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      state.calls++;
      if (state.down) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"upstream timeout"}}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: state.answer } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }));
    });
  });
  await new Promise((r) => srv.listen(0, r));
  return { state, srv, url: `http://127.0.0.1:${srv.address().port}/v1` };
}

test('every guard case passes with a deliberately bad AI answer', async () => {
  const ai = await fakeAi();
  const prev = { ...config };
  Object.assign(config, { aiBaseUrl: ai.url, aiApiKey: 'sk-test', aiModel: 'eval-fake', embeddingsModel: '' });
  try {
    const guards = CASES.filter((c) => c.mode === 'guard');
    assert.ok(guards.length >= 6);
    const failures = [];
    for (const c of guards) {
      Object.assign(ai.state, { answer: c.badAnswer || 'OK', down: !!c.aiDown });
      const r = await runCase(c);
      if (!r.pass) failures.push(`${c.id}: ${r.failedChecks.join(', ') || r.error} – said: ${r.actual}`);
      assert.equal(r.model, 'eval-fake');
      assert.ok(Number.isFinite(r.latencyMs));
    }
    assert.deepEqual(failures, []);
  } finally { ai.srv.close(); Object.assign(config, prev); }
});

test('model cases are described with expectations and fixed-rule checks (run them with the real model via the CLI)', () => {
  const ids = new Set();
  for (const c of CASES) {
    assert.ok(!ids.has(c.id), `unique id ${c.id}`); ids.add(c.id);
    assert.ok(c.category && c.expect && c.checks.length, c.id);
    assert.ok(['guard', 'model'].includes(c.mode));
  }
  const cats = new Set(CASES.map((c) => c.category));
  for (const need of ['Incorrect prices', 'Emergency situations', 'Prompt injection', 'Malicious documents', 'Other customers\' information', 'Unauthorised payment changes', 'Allergens and health', 'Multiple languages', 'AI provider timeouts', 'Requests for a human', 'Customer frustration', 'Missing opening hours', 'Unsupported bookings']) assert.ok(cats.has(need), need);
});

test('price guard: invented amounts removed, listed prices and simple totals kept, the customer\'s own budget allowed', () => {
  const src = [{ text: 'Classic Tee £15. Mug £8.50. Delivery £3.50.' }];
  assert.equal(guardPrices('The tee is £15 and the mug is £8.50.', src).blocked.length, 0);
  assert.equal(guardPrices('Two tees come to £30.', src).blocked.length, 0, 'known price × quantity');
  assert.equal(guardPrices('A tee with delivery is £18.50.', src).blocked.length, 0, 'sum of two known amounts');
  const g = guardPrices('The tee is £15. Our hoodie is £39.99. Anything else?', src);
  assert.deepEqual(g.blocked, ['£39.99']);
  assert.match(g.answer, /The tee is £15\./);
  assert.doesNotMatch(g.answer, /39\.99/);
  assert.match(g.answer, /won't guess/);
  assert.equal(guardPrices('Something under £25 would be the mug.', src, { customerText: 'gift under £25' }).blocked.length, 0);
  const ch = guardPrices("What's your budget?\n[CHOICES: Under £50 | £50–£150 | Over £150]", src);
  assert.equal(ch.blocked.length, 0, 'budget bands offered as choices are questions, not price claims');
  assert.match(ch.answer, /\[CHOICES: Under £50/);
});

test('emergency notices: gas, carbon monoxide and medical emergencies; ordinary messages untouched', () => {
  assert.equal(emergencyNotice('I can smell gas in the hallway').key, 'gas');
  assert.equal(emergencyNotice('our CO alarm keeps beeping').key, 'co');
  assert.equal(emergencyNotice('my husband is having chest pains').key, 'medical');
  assert.equal(emergencyNotice('How much is a gas safety certificate?'), null);
  assert.equal(emergencyNotice('Can I book a boiler service?'), null);
});
