import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, tenants } from './helpers.js';
import { config } from '../src/config.js';
import { addTextDoc } from '../src/knowledge.js';
import { autoSetup, buildSettings } from '../src/autoSetup.js';

const pages = [
  { name: 'Home', url: 'https://travel.test/', path: '/' },
  { name: 'Tours in India', url: 'https://travel.test/tours/india', path: '/tours/india' },
  { name: 'Visa help', url: 'https://travel.test/visas', path: '/visas' },
];

test('the AI plan is made safe: only real pages, only actions the business has, short labels, a person always last', () => {
  const out = buildSettings({ pages, shop: false, bookings: false, plan: {
    businessType: 'travel', intro: 'Where would you like to go?', greeting: '👋 Hi! Planning a trip? Tell me where you would like to go.',
    options: [
      { label: '🇮🇳 Tours in India', action: 'link', page: 2 },
      { label: '🛂 Visa help', action: 'link', page: 3 },
      { label: '🌍 Made-up page', action: 'link', page: 99 },
      { label: '🛍️ Browse', action: 'browse' },
      { label: '📅 Book', action: 'book' },
      { label: '🛂 Visa help', action: 'ask', question: 'duplicate label' },
      { label: '✈️ Flights included?', action: 'ask', question: 'Do your tours include flights?' },
      { label: '🙋 Human', action: 'human' },
    ],
    pageGreetings: [{ page: 2, text: '🌏 Planning a tour? Tell me which places you have in mind.' }, { page: 1, text: 'home page greeting' }, { page: 42, text: 'nope nope nope' }],
    requirementQuestion: 'Where would you like to go, roughly when, how many are travelling, and any budget in mind?',
  } });
  assert.deepEqual(out.welcomeMenu.options, [
    { label: '🇮🇳 Tours in India', action: 'link', value: 'https://travel.test/tours/india' },
    { label: '🛂 Visa help', action: 'link', value: 'https://travel.test/visas' },
    { label: '✈️ Flights included?', action: 'ask', value: 'Do your tours include flights?' },
    { label: '🙋 Talk to a person', action: 'human' },
  ]);
  assert.deepEqual(out.pageGreetings, [{ match: '/tours', text: '🌏 Planning a tour? Tell me which places you have in mind.' }]);
  assert.equal(out.businessType, 'travel');
  // too little usable → nothing, rather than a poor menu
  assert.equal(buildSettings({ pages, shop: false, bookings: false, plan: { options: [{ label: '🌍 Nope', action: 'link', page: 9 }] } }), null);
});

test('auto-setup writes the menu, greetings and lead question from the website, and never overwrites the owner\'s edits', async () => {
  let plan = {
    businessType: 'travel', intro: 'Where would you like to go?', greeting: '👋 Hi! Planning a trip? Tell me where you would like to go.',
    options: [{ label: '🇮🇳 Tours in India', action: 'link', page: 1 }, { label: '🛂 Visa help', action: 'link', page: 2 }, { label: '✈️ Flights included?', action: 'ask', question: 'Do your tours include flights?' }],
    pageGreetings: [{ page: 1, text: '🌏 Planning a tour? Tell me which places you have in mind.' }],
    requirementQuestion: 'Where would you like to go, roughly when, how many are travelling, and any budget in mind?',
  };
  const seen = [];
  const llm = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(plan) + '\n```' } }], usage: { total_tokens: 9 } })); }); });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const prev = { ...config };
  Object.assign(config, { aiBaseUrl: `http://127.0.0.1:${llm.address().port}/v1`, aiApiKey: 'sk-test', embeddingsModel: '' });
  try {
    const t = makeTenant({ store: { type: 'none' }, business: { name: 'Travel Rise', website: 'https://travel.test' } });
    addTextDoc(t.id, { name: 'Tours in India', url: 'https://travel.test/tours/india', text: 'Golden Triangle tours, Kerala backwaters and Rajasthan palaces, planned by our team in the UK and India with hotels and guides.' });
    addTextDoc(t.id, { name: 'Visa help', url: 'https://travel.test/visas', text: 'India e-visa help: we check your documents, fill in the form and book appointments for tourist and business visas.' });
    addTextDoc(t.id, { name: 'Other site', url: 'https://elsewhere.test/x', text: 'This page belongs to another website entirely and should never be linked from the menu at all.' });
    let r = await autoSetup(t.id);
    assert.deepEqual(r.applied, ['welcome menu', 'pop-up greeting', 'page greetings', 'lead question']);
    assert.match(seen[0].messages[0].content, /1\. Tours in India – \/tours\/india\n2\. Visa help – \/visas/);
    assert.ok(!/elsewhere/.test(seen[0].messages[0].content), 'only pages from their own site');
    let S = tenants.getTenant(t.id).settings;
    assert.equal(S.welcomeMenu.options.at(-1).action, 'human');
    assert.equal(S.welcomeMenu.options[0].value, 'https://travel.test/tours/india');
    assert.equal(S.webchat.opener.text, '👋 Hi! Planning a trip? Tell me where you would like to go.');
    assert.deepEqual(S.webchat.opener.pages, [{ match: '/tours', text: '🌏 Planning a tour? Tell me which places you have in mind.' }]);
    assert.match(S.leads.requirementPrompt, /how many are travelling/);

    // the owner edits the menu; a later automatic run leaves it alone but may refresh the parts still untouched
    tenants.updateTenantSettings(t.id, { welcomeMenu: { options: [{ label: '⭐ My own option', action: 'answer', value: 'Hello' }] } });
    plan = { ...plan, greeting: '👋 Hello! Dreaming of a holiday? Tell me where.', options: [...plan.options, { label: '🏫 School trips', action: 'ask', question: 'Do you organise school trips?' }] };
    r = await autoSetup(t.id);
    S = tenants.getTenant(t.id).settings;
    assert.deepEqual(S.welcomeMenu.options, [{ label: '⭐ My own option', action: 'answer', value: 'Hello' }], 'owner edit kept');
    assert.ok(!r.applied.includes('welcome menu'));
    assert.equal(S.webchat.opener.text, '👋 Hello! Dreaming of a holiday? Tell me where.', 'untouched AI greeting refreshed');
    // "Write it for me" (forced) replaces it
    r = await autoSetup(t.id, { force: true });
    assert.ok(r.applied.includes('welcome menu'));
    assert.equal(tenants.getTenant(t.id).settings.welcomeMenu.options.length, 5);
  } finally { Object.assign(config, prev); llm.close(); }
});

test('auto-setup does nothing harmful without the AI or without pages', async () => {
  const t = makeTenant({ business: { website: 'https://empty.test' } });
  const prev = config.aiApiKey; config.aiApiKey = '';
  try {
    const r = await autoSetup(t.id);
    assert.deepEqual(r.applied, []);
    assert.equal(tenants.getTenant(t.id).settings.welcomeMenu?.options?.length || 0, 0);
  } finally { config.aiApiKey = prev; }
});
