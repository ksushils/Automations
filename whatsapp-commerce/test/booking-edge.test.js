import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, tenants, say, ids } = await import('./helpers.js');
const { getDb } = await import('../src/db.js');
const { zonedToUtc, freeTimes, capacity, slotLabel, soonestSlots } = await import('../src/bookings.js');

const HOURLY = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];
const salon = (bookings = {}) => {
  const t = makeTenant({ store: { type: 'none' }, bookings: { enabled: true, services: [{ name: 'Colour', minutes: 120 }, { name: 'Cut', minutes: 30 }], times: HOURLY, days: 14, perSlot: 1, leadHours: 0, closedDays: [], ...bookings } });
  return tenants.getTenant(t.id);
};
const book = (t, day, time, service, status = 'requested') => getDb().prepare('INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .run(t.id, `44770090${Math.floor(Math.random() * 9000 + 1000)}`, 'Test', service, day, time, zonedToUtc(day, time, 'Europe/London').toISOString(), status);
const EARLY = new Date('2027-01-01T00:00:00Z'); // "now" well before the test days, so the notice period never hides a time

test('the clock change never moves an appointment: 09:00 is 09:00 local before, on and after the change', () => {
  const at = (d, t) => zonedToUtc(d, t, 'Europe/London').toISOString();
  // spring forward: Sunday 28 March 2027
  assert.equal(at('2027-03-26', '09:00'), '2027-03-26T09:00:00.000Z');
  assert.equal(at('2027-03-28', '09:00'), '2027-03-28T08:00:00.000Z');
  assert.equal(at('2027-03-29', '09:00'), '2027-03-29T08:00:00.000Z');
  // fall back: Sunday 31 October 2027
  assert.equal(at('2027-10-29', '09:00'), '2027-10-29T08:00:00.000Z');
  assert.equal(at('2027-10-31', '09:00'), '2027-10-31T09:00:00.000Z');
  assert.equal(at('2027-11-01', '17:30'), '2027-11-01T17:30:00.000Z');
  // every listed time is still offered on the change days, none twice
  const t = salon();
  assert.deepEqual(freeTimes(t, '2027-03-28', EARLY), HOURLY);
  assert.deepEqual(freeTimes(t, '2027-10-31', EARLY), HOURLY);
  // a booking just before the change still blocks the right local hour after it
  book(t, '2027-03-28', '10:00', 'Colour');
  assert.deepEqual(freeTimes(t, '2027-03-28', EARLY, { service: 'Cut' }), ['09:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
});

test('the notice period counts real hours across the clock change', () => {
  const t = salon({ leadHours: 2 });
  // 06:30 UTC on the spring-forward Sunday is 07:30 BST: 09:00 is only 1.5 hours away, 10:00 is 2.5
  assert.deepEqual(freeTimes(t, '2027-03-28', new Date('2027-03-28T06:30:00Z')).slice(0, 2), ['10:00', '11:00']);
});

test('"Today" and "Tomorrow" follow UK time, not UTC (just after midnight in summer)', () => {
  const now = new Date('2026-06-30T23:30:00Z'); // 00:30 on 1 July in London
  assert.equal(slotLabel({ day: '2026-07-01', time: '10:00' }, 'Europe/London', now), 'Today 10:00');
  assert.equal(slotLabel({ day: '2026-07-02', time: '10:00' }, 'Europe/London', now), 'Tomorrow 10:00');
  assert.match(slotLabel({ day: '2026-07-05', time: '10:00' }, 'Europe/London', now), /^Sun 5 Jul 10:00$/);
});

test('a long booking blocks every time it overlaps; the shorter service still fits around it', () => {
  const t = salon();
  const day = '2027-02-01';
  book(t, day, '10:00', 'Colour'); // 10:00–12:00
  assert.deepEqual(freeTimes(t, day, EARLY, { service: 'Cut' }), ['09:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  assert.deepEqual(freeTimes(t, day, EARLY, { service: 'Colour' }), ['12:00', '13:00', '14:00', '15:00', '16:00'], 'a 9:00 colour would run into the 10:00 one');
  assert.ok(freeTimes(t, day, EARLY).includes('09:00'), 'before a service is chosen, a time shows if the shortest service fits');
  book(t, day, '13:00', 'Cut', 'cancelled');
  assert.ok(freeTimes(t, day, EARLY, { service: 'Colour' }).includes('13:00'), 'cancelled bookings free their time');
});

test('a buffer after each visit (travel, clean-down) keeps the next time clear', () => {
  const t = salon({ times: ['09:30', '10:00', '10:30', '11:00', '11:30'], bufferMinutes: 30 });
  const day = '2027-02-02';
  book(t, day, '10:00', 'Cut'); // 10:00–10:30, then 30 minutes' buffer
  assert.deepEqual(freeTimes(t, day, EARLY, { service: 'Cut' }), ['11:00', '11:30'], '09:30 would leave no buffer before 10:00; 10:30 is inside the buffer');
});

test('staff: capacity is the people working that day who can do the service; days off and holidays count', () => {
  const B = { staff: [{ name: 'Amy', days: [1, 2, 3, 4, 5] }, { name: 'Ben', days: [6], services: ['Cut'] }, { name: 'Cara', days: [1, 2, 3, 4, 5], services: ['Cut'], away: ['2027-02-01'] }] };
  assert.equal(capacity(B, '2027-02-08', 'Colour'), 1, 'Monday: only Amy colours');
  assert.equal(capacity(B, '2027-02-08', 'Cut'), 2, 'Monday: Amy and Cara cut');
  assert.equal(capacity(B, '2027-02-01', 'Cut'), 1, 'Cara is on holiday');
  assert.equal(capacity(B, '2027-02-06', 'Colour'), 0, 'Saturday: nobody colours');
  assert.equal(capacity({ perSlot: 3 }, '2027-02-06'), 3, 'no staff listed: perSlot as before');
  const t = salon(B);
  assert.deepEqual(freeTimes(t, '2027-02-06', EARLY, { service: 'Colour' }), []);
  book(t, '2027-02-08', '10:00', 'Cut');
  assert.ok(freeTimes(t, '2027-02-08', EARLY, { service: 'Cut' }).includes('10:00'), 'a second stylist is free');
  book(t, '2027-02-08', '10:00', 'Cut');
  assert.ok(!freeTimes(t, '2027-02-08', EARLY, { service: 'Cut' }).includes('10:00'), 'both busy');
  assert.equal(soonestSlots(t, { service: 'Colour', now: new Date('2027-02-06T07:00:00Z'), limit: 1 })[0].day, '2027-02-08', 'the next colour is Monday');
});

test('in the chat: after picking a long service, times it would clash with are not offered', async () => {
  const t = salon({ times: ['09:00', '10:00', '11:00'], days: 2 });
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  book(t, tomorrow, '11:00', 'Cut');
  const wa = '447700900951';
  await say(t, wa, { action: 'book' });
  const r = await say(t, wa, { action: 'bsvc:0' }); // Colour, 2 hours
  const offered = ids(r).filter((x) => x.startsWith('bslot:') && x.includes(tomorrow));
  assert.ok(!offered.includes(`bslot:${tomorrow}T10:00`), '10:00–12:00 would clash with the 11:00 cut');
});

test('bookings stored the usual way ("YYYY-MM-DD HH:MM:SS", UTC) are read as UTC whatever the server time zone', () => {
  const t = salon();
  const day = '2027-07-05'; // summer: 10:00 London = 09:00 UTC
  getDb().prepare("INSERT INTO bookings (tenant_id, wa_id, service, day, time, starts_at, status) VALUES (?, 'x', 'Colour', ?, '10:00', '2027-07-05 09:00:00', 'requested')").run(t.id, day);
  assert.deepEqual(freeTimes(t, day, EARLY, { service: 'Cut' }).slice(0, 2), ['09:00', '12:00']);
});

test('named staff: each booking goes to a free person who does the service; a busy person frees no slot for others', async () => {
  const { assignStaff } = await import('../src/bookings.js');
  const t = salon({ staff: [{ name: 'Amy', days: [] }, { name: 'Cara', days: [], services: ['Cut'] }] });
  const day = '2027-02-08';
  assert.equal(assignStaff(t, day, '10:00', 'Colour'), 'Amy', 'only Amy colours');
  getDb().prepare("INSERT INTO bookings (tenant_id, wa_id, service, day, time, starts_at, status, staff) VALUES (?, 'x', 'Colour', ?, '10:00', ?, 'confirmed', 'Amy')").run(t.id, day, zonedToUtc(day, '10:00', 'Europe/London').toISOString());
  assert.equal(assignStaff(t, day, '11:00', 'Cut'), 'Cara', 'Amy is mid-colour at 11:00');
  assert.ok(freeTimes(t, day, EARLY, { service: 'Cut' }).includes('11:00'));
  assert.ok(!freeTimes(t, day, EARLY, { service: 'Colour' }).includes('11:00'), 'nobody else colours');
  assert.equal(assignStaff(t, day, '11:00', 'Colour'), null);
  // with no staff listed, nothing is assigned (as before)
  assert.equal(assignStaff(salon(), day, '10:00', 'Cut'), null);
});

test('in the chat, a confirmed booking records who it is with', async () => {
  const t = salon({ staff: [{ name: 'Amy', days: [] }], times: ['09:00', '10:00', '11:00'], days: 3 });
  const wa = '447700900952';
  await say(t, wa, { action: 'book' });
  let r = await say(t, wa, { action: 'bsvc:1' }); // Cut
  const slot = ids(r).find((x) => x.startsWith('bslot:'));
  r = await say(t, wa, { action: slot });
  if (ids(r).includes('bconfirm')) r = await say(t, wa, { action: 'bconfirm' });
  else { await say(t, wa, 'Jo'); await say(t, wa, { action: 'bconfirm' }); }
  const b = getDb().prepare('SELECT staff, service FROM bookings WHERE tenant_id = ? AND wa_id = ?').get(t.id, wa);
  assert.deepEqual([b.service, b.staff], ['Cut', 'Amy']);
});

test('the customer can choose who: "Anyone" or a name; times shown are that person\'s; the booking records them', async () => {
  const t = salon({ staff: [{ name: 'Amy', days: [] }, { name: 'Priya', days: [], services: ['Cut'] }], times: ['09:00', '10:00', '11:00'], days: 3 });
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  // Priya is booked all tomorrow morning
  for (const tm of ['09:00', '10:00', '11:00']) getDb().prepare("INSERT INTO bookings (tenant_id, wa_id, service, day, time, starts_at, status, staff) VALUES (?, 'x', 'Cut', ?, ?, ?, 'confirmed', 'Priya')").run(t.id, tomorrow, tm, zonedToUtc(tomorrow, tm, 'Europe/London').toISOString());
  const wa = '447700900953';
  await say(t, wa, { action: 'book' });
  let r = await say(t, wa, { action: 'bsvc:1' }); // Cut: Amy and Priya both do it
  assert.match(JSON.stringify(r), /who would you like/i);
  assert.deepEqual(ids(r), ['bstaff:any', 'bstaff:0', 'bstaff:1']);
  r = await say(t, wa, { action: 'bstaff:1' }); // Priya
  assert.ok(!ids(r).some((x) => x.startsWith(`bslot:${tomorrow}`)), "Priya's full day isn't offered");
  const slot = ids(r).find((x) => x.startsWith('bslot:'));
  if (slot) {
    r = await say(t, wa, { action: slot });
    if (!ids(r).includes('bconfirm')) r = await say(t, wa, 'Jo');
    assert.match(JSON.stringify(r), /With: Priya/);
    await say(t, wa, { action: 'bconfirm' });
    assert.equal(getDb().prepare('SELECT staff FROM bookings WHERE tenant_id = ? AND wa_id = ?').get(t.id, wa).staff, 'Priya');
  }
  // a service only one person does: no question
  const wb = '447700900954';
  await say(t, wb, { action: 'book' });
  assert.doesNotMatch(JSON.stringify(await say(t, wb, { action: 'bsvc:0' })), /who would you like/i, 'only Amy colours');
  // the owner can switch the question off
  tenants.updateTenantSettings(t.id, { bookings: { chooseStaff: false } });
  const wc = '447700900955';
  await say(tenants.getTenant(t.id), wc, { action: 'book' });
  assert.doesNotMatch(JSON.stringify(await say(tenants.getTenant(t.id), wc, { action: 'bsvc:1' })), /who would you like/i);
});
