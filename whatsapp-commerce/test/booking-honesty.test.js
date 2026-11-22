import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, say, ids, tenants } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { extractChoices, FAKE_BOOKING } = await import('../src/bot/engine.js');
const { buildPrompt } = await import('../src/dify/provision.js');
const { listChatLeads } = await import('../src/leads.js');
const { applyTrade } = await import('../src/trades.js');
const { claimDemo } = await import('../src/instantDemo.js');
const { getDb } = await import('../src/db.js');

/** Run messages with the AI answering `aiAnswer` (no real AI call). */
async function withAi(aiAnswer, fn) {
  const prevCfg = { ...config };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '' });
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/chat/completions') ? new Response(JSON.stringify({ choices: [{ message: { content: typeof aiAnswer === 'function' ? aiAnswer() : aiAnswer } }], usage: { total_tokens: 9 } })) : new Response('{}'));
  try { return await fn(); } finally { globalThis.fetch = prev; Object.assign(config, prevCfg); }
}
const salon = () => { const t = makeTenant({ business: { name: 'Visage Hair' } }); applyTrade(t.id, 'salon'); return tenants.getTenant(t.id); };

test('the AI may not pretend to book: a made-up "confirmed" becomes a real request with name and phone', () => withAi('Your appointment for a dry cut on Wednesday at 10 AM is confirmed! 😊', async () => {
  const t = salon();
  const web = 'web:honestySessionABCDEFG1';
  const r = await say(t, web, 'yes please, wednesday 10am for a dry cut');
  const all = JSON.stringify(r);
  assert.doesNotMatch(all, /is confirmed/);
  assert.match(all, /can't confirm appointments in this chat/);
  assert.match(all, /best number to call you/i, 'asks for their phone');
  // they finish the request: the team gets name, phone and time
  await say(t, web, '07700 900123');
  await say(t, web, { action: 'lead:when:Morning' });
  await say(t, web, 'Dry cut'); // the salon's questions, one at a time: which service…
  await say(t, web, 'Wednesday 10am'); // …and which day or time
  await say(t, web, { action: 'lead:skip' }); // email is optional
  const [lead] = listChatLeads(t.id);
  assert.deepEqual([lead.kind, lead.topic, lead.name, lead.call_time, lead.message], ['call', 'Appointment request', 'Jane Doe', 'Morning', 'Service: Dry cut · When: Wednesday 10am']);
  assert.deepEqual(lead.answers.map((a) => a.a), ['Dry cut', 'Wednesday 10am']);
  assert.match(lead.phone, /7700900123/);
}));

test('"can I book a cut?" with bookings off: details for the team, not an AI guess', async () => {
  const t = salon();
  const r = await say(t, '447700900661', 'can I book a haircut for saturday?');
  assert.match(JSON.stringify(r), /pass your request to the team/);
  assert.deepEqual(ids(r), ['lead:when:Morning', 'lead:when:Afternoon', 'lead:when:Evening'], 'WhatsApp already has their number, so straight to the time');
  // a price question that mentions booking is still answered normally
  assert.doesNotMatch(JSON.stringify(await say(t, '447700900662', 'how much is it to book a cut?')), /pass your request/);
});

test('with bookings on, a faked booking shows the real calendar instead', () => withAi("Great, you're booked for Friday at 2pm!", async () => {
  const t = salon();
  tenants.updateTenantSettings(t.id, { bookings: { enabled: true } });
  const r = await say(tenants.getTenant(t.id), '447700900663', 'friday 2pm is good thanks');
  assert.doesNotMatch(JSON.stringify(r), /you're booked/);
  assert.match(JSON.stringify(r), /real time/);
}));

test('buttons the AI writes as text ("[ Yes ] [ No ]") become real buttons; the prompt says it cannot book', () => {
  assert.deepEqual(extractChoices('Which day suits you?\n[ Monday ] [ Wednesday ] [ Friday ]'), { text: 'Which day suits you?', choices: ['Monday', 'Wednesday', 'Friday'] });
  assert.deepEqual(extractChoices('Pick one\n[CHOICES: A | B]').choices, ['A', 'B']);
  for (const s of ['Your appointment for a dry cut is set for Wednesday at 10 AM!', "You're all booked in", 'I have reserved a table for you', 'Would you like to confirm this appointment?']) assert.match(s, FAKE_BOOKING, s);
  for (const s of ['To book, tap Book now below.', 'Appointments are confirmed by our team by phone.', 'Booking is easy online.']) assert.doesNotMatch(s, FAKE_BOOKING, s);
  const p = buildPrompt(salon());
  assert.match(p, /You cannot make, change or cancel bookings/);
  assert.match(p, /Call me back \| Email me details/);
});

test('a salon greeting does not say "Browse our products"', async () => {
  const t = salon();
  const r = await say(t, '447700900664', 'hi');
  assert.doesNotMatch(JSON.stringify(r), /Browse our products/);
});

test('a kept demo has its sample booking times switched off', () => {
  const t = salon();
  tenants.updateTenantSettings(t.id, { bookings: { enabled: true, times: ['10:00'] }, demo: { token: 'tokHonesty1', bookings: true, expiresAt: new Date(Date.now() + 3600000).toISOString() } });
  getDb().prepare("INSERT INTO kv (key, value) VALUES ('idemo:tokHonesty1234567890', ?)").run(t.id);
  tenants.updateTenantSettings(t.id, { demo: { token: 'tokHonesty1234567890' } });
  assert.ok(claimDemo('tokHonesty1234567890', { name: 'Visage Hair', email: 'owner@visage.test' }));
  assert.equal(tenants.getTenant(t.id).settings.bookings.enabled, false);
});

test('website booking: name and phone are taken apart, and a phone number is required', () => withAi('Sure!', async () => {
  const { getDb: db } = await import('../src/db.js');
  const t = salon();
  tenants.updateTenantSettings(t.id, { bookings: { enabled: true } });
  const T = tenants.getTenant(t.id);
  const web = 'web:bookingPhoneSessionABCD1';
  let r = await say(T, web, { action: 'bstart' });
  r = await say(T, web, { action: ids(r)[0] });
  const slot = ids(r).find((x) => /^bslot:/.test(x));
  r = await say(T, web, { action: slot });
  assert.match(JSON.stringify(r), /name and a phone number/);
  r = await say(T, web, 'Sam');
  assert.match(JSON.stringify(r), /phone number, please/);
  r = await say(T, web, 'Sam 07700 900123');
  assert.match(r[0].text, /Name: Sam\n• Phone: 07700900123/);
  await say(T, web, { action: 'bconfirm' });
  const b = db().prepare('SELECT name, notes FROM bookings WHERE tenant_id = ? ORDER BY id DESC LIMIT 1').get(t.id);
  assert.deepEqual({ ...b }, { name: 'Sam', notes: 'Phone: 07700900123' });
}));
