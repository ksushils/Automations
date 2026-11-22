import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants, say } from './helpers.js';
import { getDb } from '../src/db.js';
import { findPostcode, checkServiceArea, areaPrompt } from '../src/serviceArea.js';
import { TRADES, TRADE_KEYS, tradeList, tradeSettings, applyTrade, guessTrade } from '../src/trades.js';
import { buildPrompt } from '../src/dify/provision.js';
import { listOpportunities } from '../src/opportunities.js';

// ---------------- service area ----------------
test('postcodes are found in what customers write (full or clearly-given outward codes)', () => {
  assert.deepEqual(findPostcode('Leaking tap at 12 High St, SW19 2AB please'), { postcode: 'SW19 2AB', outward: 'SW19' });
  assert.deepEqual(findPostcode('sw192ab'), { postcode: 'SW19 2AB', outward: 'SW19' });
  assert.deepEqual(findPostcode('SE1'), { postcode: 'SE1', outward: 'SE1' });
  assert.deepEqual(findPostcode('I live in CR4 near the station'), { postcode: 'CR4', outward: 'CR4' });
  assert.equal(findPostcode('My M25 junction boiler is broken and making noises'), null, 'a road name is not a postcode');
});

test('service area rules: areas, districts, ranges and towns; unknown when nothing is set', () => {
  const S = { business: { serviceAreas: ['SW', 'SE1', 'CR0-CR4', 'Croydon'] } };
  assert.equal(checkServiceArea(S, 'SW19 2AB').covered, true);
  assert.equal(checkServiceArea(S, 'SE1 7PB').covered, true);
  assert.equal(checkServiceArea(S, 'SE15 3AA').covered, false, 'SE1 does not cover SE15');
  assert.equal(checkServiceArea(S, 'CR3 5XX').covered, true);
  assert.equal(checkServiceArea(S, 'CR7 8AA').covered, false);
  assert.equal(checkServiceArea(S, 'in Croydon town centre').covered, true);
  assert.equal(checkServiceArea(S, 'no idea').covered, null);
  assert.equal(checkServiceArea({ business: {} }, 'SW19 2AB').covered, null);
  assert.equal(checkServiceArea({ business: { serviceAreas: 'sw, se1' } }, 'SE1 1AA').covered, true, 'comma text works too');
  assert.match(areaPrompt(S), /Areas covered: SW, SE1, CR0-CR4, Croydon.*don't refuse/);
  assert.equal(areaPrompt({ business: {} }), '');
});

test('lead flow: an out-of-area postcode gets an honest "the team will check", is saved, and shows in Opportunities', async () => {
  const t = makeTenant({ business: { serviceAreas: ['SW', 'SE1'] } });
  const wa = '447700900701';
  await say(t, wa, 'hi');
  await say(t, wa, { action: 'lead:call:Leak' });
  await say(t, wa, { action: 'lead:when:Morning' });
  const r = await say(t, wa, 'Water pouring from the ceiling, postcode BR1 3AA');
  assert.ok(r.some((m) => /BR1 3AA may be outside the areas we usually cover, but the team will check/.test(m.text || '')), JSON.stringify(r));
  await say(t, wa, { action: 'lead:skip' });
  const lead = getDb().prepare('SELECT area FROM chat_leads WHERE tenant_id = ? ORDER BY id DESC').get(t.id);
  assert.deepEqual(JSON.parse(lead.area), { postcode: 'BR1 3AA', covered: false });
  getDb().prepare("UPDATE chat_leads SET created_at = datetime('now', '-1 hour') WHERE tenant_id = ?").run(t.id);
  assert.match(listOpportunities(tenants.getTenant(t.id)).items.find((o) => o.type === 'callback').reason, /Postcode BR1 3AA – outside your listed areas/);
  // inside the area: no extra message
  const wa2 = '447700900702';
  await say(t, wa2, 'hi');
  await say(t, wa2, { action: 'lead:call:Leak' });
  await say(t, wa2, { action: 'lead:when:Morning' });
  const r2 = await say(t, wa2, 'Dripping tap, SW19 2AB');
  assert.ok(!r2.some((m) => /outside the areas/.test(m.text || '')));
});

test('the AI prompt includes the areas covered (when set)', () => {
  const t = makeTenant({ business: { serviceAreas: ['SW', 'SE1'] }, ai: { tradeRules: 'Trade rule.' } });
  assert.match(buildPrompt(tenants.getTenant(t.id)), /Areas covered: SW, SE1/);
});

// ---------------- trade and beauty variants ----------------
test('specialist templates for the launch verticals, built on their parents', () => {
  for (const k of ['plumber', 'electrician', 'heating', 'handyman', 'property_maintenance', 'hair', 'barber', 'beauty', 'nails']) {
    assert.ok(TRADES[k], k);
    assert.ok(['trades', 'salon'].includes(TRADES[k].parent));
    for (const f of ['label', 'greeting', 'requirement', 'instructions']) assert.ok(TRADES[k][f], `${k}.${f}`);
    assert.ok(TRADES[k].questions.length >= 4);
  }
  assert.ok(TRADE_KEYS.includes('dental') && TRADE_KEYS.includes('trades') && TRADE_KEYS.includes('salon'), 'existing templates kept');
  assert.equal(tradeList().find((x) => x.key === 'barber').parent, 'salon');
  assert.match(TRADES.heating.instructions, /0800 111 999/);
  assert.match(TRADES.heating.instructions, /Only say the business is Gas Safe registered if the information says so/);
  assert.match(TRADES.electrician.instructions, /consumer unit/);
  assert.match(TRADES.beauty.instructions, /therapist will check/);
  for (const k of ['plumber', 'electrician', 'heating', 'handyman', 'property_maintenance']) assert.match(TRADES[k].instructions, /Never give a firm price/);
  assert.equal(guessTrade('Smith Plumbing Ltd'), 'plumber');
  assert.equal(guessTrade('Gas Safe boiler engineer'), 'heating');
  assert.equal(guessTrade('Kings Barber Shop'), 'barber');
  assert.equal(guessTrade('Polished Nails & Pedicure'), 'nails');
  assert.equal(guessTrade('Roofing and building contractor'), 'trades');
  assert.equal(guessTrade('Luxe hair salon'), 'hair');
});

test('applying a specialist template: bookings stay off, services ready to edit, menu actions valid', () => {
  const t = makeTenant({ store: { type: 'none' } });
  const r = applyTrade(t.id, 'barber');
  assert.equal(r.label, 'Barber');
  const S = tenants.getTenant(t.id).settings;
  assert.equal(S.trade, 'barber');
  assert.equal(S.bookings.enabled, false, 'never offer slots the business has not confirmed');
  assert.ok(S.bookings.services.some((s) => s.name === 'Skin fade'));
  const p = tradeSettings('property_maintenance', { store: { type: 'none' } });
  assert.equal(p.tickets.enabled, true);
  const valid = new Set(['ask', 'book', 'callback', 'quote', 'ticket', 'quiz', 'human', 'browse', 'status']);
  for (const k of TRADE_KEYS) for (const o of TRADES[k].menu) assert.ok(valid.has(o.action), `${k}: ${o.action}`);
});
