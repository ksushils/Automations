import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, say, ids, tenants } = await import('./helpers.js');
const { listChatLeads, leadSummary } = await import('../src/leads.js');
const { applyTrade } = await import('../src/trades.js');
const { qualifyFor, parseQualifyText, qualifyText, QUALIFY, MAX_QUESTIONS } = await import('../src/qualify.js');

const plumber = () => { const t = makeTenant({ business: { name: 'Leeds Leak Fix', serviceAreas: 'LS1, LS2, LS6' }, store: { type: 'none' } }); applyTrade(t.id, 'plumber'); return tenants.getTenant(t.id); };
const text = (msgs) => msgs.map((m) => m.text || '').join('\n');

test('a plumber asks the problem, then the postcode, then how urgent – one question at a time, each with Skip', async () => {
  const t = plumber();
  const wa = '447700900801';
  let r = await say(t, wa, { action: 'lead:call:Emergency leak' });
  assert.match(text(r), /we'll call you on \+447700900801/);
  assert.deepEqual(ids(r), ['lead:when:Morning', 'lead:when:Afternoon', 'lead:when:Evening']);
  r = await say(t, wa, { action: 'lead:when:Morning' });
  assert.match(text(r), /who should we ask for/);
  r = await say(t, wa, 'Dave');
  assert.match(text(r), /What's the problem/); assert.match(text(r), /\(1\/3\)/);
  assert.deepEqual(ids(r), ['lead:skip']);
  r = await say(t, wa, 'Water coming through the kitchen ceiling');
  assert.match(text(r), /postcode/); assert.match(text(r), /\(2\/3\)/);
  r = await say(t, wa, 'LS6 2AB');
  assert.match(text(r), /How soon/);
  assert.deepEqual(ids(r), ['lead:ans:0', 'lead:ans:1', 'lead:skip']);
  r = await say(t, wa, { action: 'lead:ans:0' }); // 🚨 Today – urgent
  assert.match(text(r), /email address/, 'then the optional email');
  await say(t, wa, { action: 'lead:skip' });
  const [lead] = listChatLeads(t.id);
  assert.equal(lead.urgent, 1);
  assert.deepEqual(lead.answers.map((a) => [a.label, a.a]), [['Job', 'Water coming through the kitchen ceiling'], ['Postcode', 'LS6 2AB'], ['When', 'Today – urgent']]);
  assert.equal(lead.message, 'Job: Water coming through the kitchen ceiling · Postcode: LS6 2AB · When: Today – urgent');
  assert.deepEqual(JSON.parse(lead.area), { postcode: 'LS6 2AB', covered: true });
  assert.equal(lead.call_time, 'Morning');
});

test('outside the area: told kindly, still saved; a skipped question is left out; a question of their own is answered', async () => {
  const t = plumber();
  const wa = '447700900802';
  await say(t, wa, { action: 'lead:call:quote' });
  await say(t, wa, { action: 'lead:when:Evening' });
  await say(t, wa, 'Sam');
  await say(t, wa, { action: 'lead:skip' }); // the problem
  const r = await say(t, wa, 'M1 1AA');
  assert.match(text(r), /may be outside the areas we usually cover/);
  await say(t, wa, 'This week');
  await say(t, wa, { action: 'lead:skip' }); // no email
  const [lead] = listChatLeads(t.id);
  assert.equal(lead.urgent, 0);
  assert.deepEqual(lead.answers.map((a) => a.key), ['postcode', 'when']);
  assert.equal(JSON.parse(lead.area).covered, false);
  // a question mid-way sets the form aside – the visitor is never stuck
  const wa2 = '447700900803';
  await say(t, wa2, { action: 'lead:call:quote' });
  await say(t, wa2, { action: 'lead:when:Morning' });
  await say(t, wa2, 'Alex');
  await say(t, wa2, 'Do you charge a call-out fee for evenings?');
  assert.equal(listChatLeads(t.id).length, 1, 'no lead saved from a question');
});

test('the team sees URGENT and each answer on its own line', () => {
  const s = leadSummary({}, { kind: 'call', topic: 'Emergency leak', phone: '+447700900801', urgent: true, answers: [{ label: 'Job', a: 'Burst pipe' }, { label: 'Postcode', a: 'LS6 2AB' }, { label: 'When', a: '' }] });
  assert.match(s, /^🚨 URGENT\n📞 Call-back request – Emergency leak/);
  assert.match(s, /Job: Burst pipe\nPostcode: LS6 2AB/);
  assert.doesNotMatch(s, /When:/);
});

test('which questions: trade defaults, the owner\'s own single question is respected, owner lists win, no trade keeps the old question', () => {
  assert.equal(qualifyFor({ trade: 'travel', leads: {} }).length, 4);
  assert.equal(qualifyFor({ trade: 'hair' })[0].key, 'service', 'variants use their parent trade');
  assert.equal(qualifyFor({ trade: 'travel', leads: { requirementPrompt: 'Tell us about your dream trip' } }), null);
  assert.equal(qualifyFor({}), null);
  assert.equal(qualifyFor({ trade: 'travel', leads: { qualifyOff: true } }), null);
  const own = parseQualifyText('What size is the room?\nWhen do you need it? | !ASAP | Next month | Later\n\nYour postcode?');
  assert.deepEqual(own.map((x) => x.q), ['What size is the room?', 'When do you need it?', 'Your postcode?']);
  assert.deepEqual(own[1].options, [{ label: 'ASAP', urgent: true }, { label: 'Next month' }], 'max 2 buttons (Skip is the third)');
  assert.equal(own[2].postcode, true);
  assert.equal(qualifyText(own), 'What size is the room?\nWhen do you need it? | !ASAP | Next month\nYour postcode?');
  assert.deepEqual(qualifyFor({ trade: 'travel', leads: { qualify: own } }).map((x) => x.key), ['q1', 'q2', 'q3']);
  assert.equal(parseQualifyText('a?\nb?\nc?\nd?\ne?').length, MAX_QUESTIONS);
  for (const [k, list] of Object.entries(QUALIFY)) for (const x of list) { assert.ok(x.q.length <= 200, k); assert.ok((x.options || []).length <= 2, k); for (const o of x.options || []) assert.ok(o.label.length <= 20, `${k}: ${o.label}`); }
});

test('the dashboard saves the questions as text lines and reads them back', async () => {
  const t = plumber();
  const { updateTenantSettings, getTenant } = tenants;
  updateTenantSettings(t.id, { leads: { qualify: parseQualifyText('What needs fixing?\nPostcode?') } });
  assert.deepEqual(qualifyFor(getTenant(t.id).settings).map((x) => x.q), ['What needs fixing?', 'Postcode?']);
});
