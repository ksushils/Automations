import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants, say, ids } from './helpers.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { TRADES, TRADE_KEYS, tradeSettings, applyTrade, guessTrade, tradeList } from '../src/trades.js';
import { buildPrompt } from '../src/dify/provision.js';
import { questionsFor } from '../src/quality.js';
import { menuOptions } from '../src/bot/engine.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('every trade template is complete and its menu is valid', () => {
  assert.ok(TRADE_KEYS.length >= 8);
  for (const k of TRADE_KEYS) {
    const T = TRADES[k];
    assert.ok(T.label && T.emoji && T.intro && T.greeting.length <= 110 && T.requirement && T.instructions && T.questions.length >= 5, k);
    const p = tradeSettings(k, tenants.getTenant(makeTenant().id).settings);
    const opts = p.welcomeMenu.options;
    assert.ok(opts.length >= 4 && opts.length <= 10, k);
    assert.equal(opts.at(-1).action, 'human', `${k}: "Talk to a person" last`);
    for (const o of opts) assert.ok(o.label.length <= 24, `${k}: ${o.label}`);
    if (p.store?.type === 'none') assert.ok(!opts.some((o) => ['browse', 'status'].includes(o.action)), `${k}: no shop buttons without a shop`);
  }
  assert.equal(tradeList().length, TRADE_KEYS.length);
});

test('dental template: enquiries mode, AI never diagnoses, its questions are checked, bookings ready but off', () => {
  const t = makeTenant();
  const r = applyTrade(t.id, 'dental');
  assert.ok(r.applied.includes('welcome menu'));
  const S = tenants.getTenant(t.id).settings;
  assert.equal(S.trade, 'dental');
  assert.equal(S.store.type, 'none');
  assert.equal(S.bookings.enabled, false);
  assert.ok(S.bookings.services.some((s) => s.name === 'Hygienist'));
  assert.match(buildPrompt(tenants.getTenant(t.id)), /Rules for this kind of business:\n.*Never diagnose/);
  assert.ok(questionsFor(tenants.getTenant(t.id)).includes('How much is a hygienist appointment?'));
  assert.deepEqual(menuOptions(S).map((o) => o.action).slice(0, 2), ['book', 'ask']);
});

test("a template never overwrites the owner's own menu unless asked; an online shop keeps its Shopify connection", () => {
  const t = makeTenant({ welcomeMenu: { enabled: true, intro: 'Mine', options: [{ label: '⭐ My option', action: 'answer', value: 'Hello' }] } });
  let r = applyTrade(t.id, 'salon');
  assert.ok(!r.applied.includes('welcome menu'));
  assert.equal(tenants.getTenant(t.id).settings.welcomeMenu.intro, 'Mine');
  assert.ok(tenants.getTenant(t.id).settings.ai.tradeRules.includes('patch test'), 'the AI rules are still added');
  r = applyTrade(t.id, 'salon', { force: true });
  assert.ok(r.applied.includes('welcome menu'));
  const shop = makeTenant({ store: { type: 'shopify_public', shopify: { domain: 'x.myshopify.com' } } });
  applyTrade(shop.id, 'takeaway');
  const S = tenants.getTenant(shop.id).settings;
  assert.equal(S.store.type, 'shopify_public');
  assert.ok(menuOptions(S).some((o) => o.action === 'browse'));
});

test('"Get a quote" (trades) starts the call-back request straight away', async () => {
  const t = makeTenant();
  applyTrade(t.id, 'trades');
  const wa = '447700900551';
  await say(t, wa, 'hi');
  const r = await say(t, wa, { action: 'wm:0' });
  assert.match(r[0].text, /we'll call you on \+447700900551/);
  assert.deepEqual(ids(r), ['lead:when:Morning', 'lead:when:Afternoon', 'lead:when:Evening']);
});

test('sign-up with a business type (also from ?trade= links): takeaway gets menu categories and time slots', () => withServer(async (base) => {
  const plans = await (await fetch(`${base}/api/plans`)).json();
  assert.ok(plans.trades.some((x) => x.key === 'takeaway'));
  const r = await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ business: 'Napoli Pizza', email: 'hi@napoli.test', plan: 'free', trade: 'takeaway', acceptTerms: true }) });
  assert.equal(r.status, 201);
  const S = tenants.getTenant((await r.json()).tenantId).settings;
  assert.equal(S.trade, 'takeaway');
  assert.deepEqual(S.store.manual.categories.map((c) => c.id), ['starters', 'mains', 'sides', 'desserts', 'drinks']);
  assert.equal(S.ordering.slots.enabled, true);
  assert.match(S.ai.tradeRules, /allergen/);
  const page = await (await fetch(`${base}/signup?trade=dental`)).text();
  assert.match(page, /name="trade"/);
  void getDb;
}));

test('trade guess from the business name', () => {
  assert.equal(guessTrade('Neem Dental Clinic Harrow'), 'dental');
  assert.equal(guessTrade('Smith & Sons Plumbing and Heating'), 'plumber'); // specialist template since batch 7
  assert.equal(guessTrade('Smith & Sons Builders'), 'trades');
  assert.equal(guessTrade('Bella Hair Salon'), 'hair');
  assert.equal(guessTrade('The Salon Room'), 'salon');
  assert.equal(guessTrade('Travel Rise'), 'travel');
  assert.equal(guessTrade('Acme Widgets Ltd'), null);
});
