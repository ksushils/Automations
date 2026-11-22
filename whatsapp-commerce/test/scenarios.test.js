import { test } from 'node:test';
import assert from 'node:assert/strict';
const { tenants } = await import('./helpers.js');
const { getDb } = await import('../src/db.js');
const { SCENARIOS, runScenario, scenarioResult, scenarioList } = await import('../src/scenarios.js');
const { createApp } = await import('../src/server.js');
const { inSampleRun } = await import('../src/sampleRun.js');
const { sendEmail } = await import('../src/email.js');
const { config } = await import('../src/config.js');

const tenantCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM tenants').get().n;
const all = (r) => r.transcript.map((m) => m.text).join('\n');

test('every scenario plays through the real engine, leaves nothing behind and sends nothing', async () => {
  const before = tenantCount();
  const outBefore = getDb().prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const prev = globalThis.fetch;
  let outbound = 0;
  const key = config.aiApiKey;
  config.aiApiKey = 'sk-test-on'; // even with the AI switched on, a sample run never calls it
  globalThis.fetch = async (...a) => { outbound++; return prev(...a); };
  try {
    for (const sc of SCENARIOS) {
      const r = await runScenario(sc.key);
      assert.equal(r.sample, true);
      assert.ok(r.transcript.filter((m) => m.from === 'assistant').length >= 1, sc.key);
      assert.ok(r.team.length >= 1, `${sc.key}: the team view shows what arrived`);
      assert.doesNotMatch(all(r), /https?:\/\/\S+\/(b|q)\//, 'no dead links into the deleted sample business');
    }
  } finally { globalThis.fetch = prev; config.aiApiKey = key; }
  assert.equal(outbound, 0, 'no network calls at all');
  assert.equal(tenantCount(), before, 'each sample business is deleted after its run');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM messages').get().n, outBefore, 'its messages are deleted too');
  assert.equal(inSampleRun(), false);
});

test('the scenarios show what they promise', async () => {
  const em = await runScenario('emergency');
  assert.match(all(em), /\(1\/3\)/);
  assert.match(em.team[0].text, /🚨 URGENT[\s\S]*Postcode: LS6 2AB/);
  assert.match(em.team[0].text, /in your area/);
  assert.match(em.transcript.find((m) => /call you on/.test(m.text)).text, /\+447700900\d{3}/, "Ofcom's drama numbers only");
  const area = await runScenario('service_area');
  assert.match(all(area), /may be outside the areas we usually cover/);
  assert.match(area.team[0].text, /outside the areas you cover/);
  const pq = await runScenario('photo_quote');
  assert.match(pq.team[0].text, /1 photo attached/);
  assert.match(pq.team[0].title, /Draft quote/);
  const bk = await runScenario('booking');
  assert.match(bk.team[0].title, /waiting for the team to confirm/);
  const hu = await runScenario('human');
  assert.equal(hu.team[0].kind, 'handover');
  assert.doesNotMatch(all(hu), /cart/i, 'no shop, no mention of a cart');
  const fu = await runScenario('follow_up');
  assert.ok(fu.transcript.some((m) => m.from === 'time'));
  assert.match(all(fu), /Just checking you got your quote/);
  assert.match(fu.team[0].text, /One follow-up sent/);
  const salon = await runScenario('salon_booking');
  assert.equal(salon.business, 'Willow Hair Studio');
  assert.match(salon.team[0].text, /Full colour · .* · with Amy/, 'only Amy does colour');
  const shop = await runScenario('shop_order');
  assert.match(all(shop), /Browse products/, 'the shop menu has Browse');
  assert.match(all(shop), /Order \*WA-\d+\* confirmed/);
  assert.match(all(shop), /received/, 'order status answered from the order');
  assert.match(shop.team.find((t) => t.kind === 'order').text, /2 × Merino walking socks \(Size 9–11\)[\s\S]*pay on delivery/);
});

test('nothing can be emailed during a sample run', async () => {
  const { sampleRun } = await import('../src/sampleRun.js');
  const r = await sampleRun.run({}, () => sendEmail({ to: 'sam@example.com', subject: 'x', text: 'y' }));
  assert.equal(r.skipped, true);
  assert.match(r.error, /Sample run/);
});

test('/examples page and JSON: labelled sample, cached', async () => {
  const server = createApp().listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(base + '/examples');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Sample business · sample data/);
    for (const s of scenarioList()) assert.match(html, new RegExp(`id="${s.key}"`));
    assert.match(html, /What the team gets/);
    assert.doesNotMatch(html, /<script>[^<]*sam@/);
    const j = await (await fetch(base + '/examples/booking.json')).json();
    assert.equal(j.sample, true);
    assert.equal((await fetch(base + '/examples/nope.json')).status, 404);
    const again = await scenarioResult('booking');
    assert.equal(again.ranAt, j.ranAt, 'served from the cache');
    assert.match(await (await fetch(base + '/sitemap.xml')).text(), /\/examples</);
  } finally { server.close(); }
  void tenants;
});
