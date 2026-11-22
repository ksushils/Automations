import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, tenants, say } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { getDb } = await import('../src/db.js');
const { checkDraft, createDraft, approveDraft, listDrafts, ALLOWED_STEPS, draftPrompt } = await import('../src/autoDraft.js');
const { listFlows, saveFlow } = await import('../src/bot/flows.js');
const { createApp } = await import('../src/server.js');

/** Run with the AI answering `answer` (JSON), counting every other network call. */
async function withAi(answer, fn) {
  const prev = { fetch: globalThis.fetch, base: config.aiBaseUrl, key: config.aiApiKey, emb: config.embeddingsModel };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '' });
  const calls = { ai: 0, other: 0 };
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('/chat/completions')) { calls.ai++; const ans = typeof answer === 'function' ? answer() : answer; return new Response(JSON.stringify({ choices: [{ message: { content: typeof ans === 'string' ? ans : JSON.stringify(ans) } }], usage: { total_tokens: 50, cost: 0.0004 } })); }
    if (String(url).startsWith('http://127.0.0.1')) return prev.fetch(url, o);
    calls.other++; return new Response('{}');
  };
  try { return await fn(calls); } finally { globalThis.fetch = prev.fetch; Object.assign(config, { aiBaseUrl: prev.base, aiApiKey: prev.key, embeddingsModel: prev.emb }); }
}

const PRICES_FLOW = { type: 'flow', summary: 'When someone types "prices", show the three services and offer a call back.', flow: { name: 'Prices', triggers: { keywords: ['prices', 'price list'], match: 'exact' }, steps: [
  { id: 's1', type: 'message', text: 'Hi {{name}}! Which service are you asking about?', buttons: [{ title: 'Boiler service', goto: 's2' }, { title: 'Repairs', goto: 's3' }, { title: 'New boiler', goto: 's4' }] },
  { id: 's2', type: 'message', text: 'Our team will send you the boiler service price.', next: 's5' },
  { id: 's3', type: 'question', text: 'What needs repairing? Our team will price it.', save: 'repair', next: 's5' },
  { id: 's4', type: 'handover', text: 'Passing you to the team for a new boiler quote.' },
  { id: 's5', type: 'tag', add: ['asked-prices'], next: 's6' },
  { id: 's6', type: 'end' },
] } };

test('the server keeps only allowed steps and settings, and says what it removed', () => {
  const S = { business: { name: 'X' }, store: { type: 'none' } };
  const d = checkDraft({ type: 'flow', summary: 's', flow: { name: 'Leak', triggers: { keywords: ['leak'] }, steps: [
    { id: 'a', type: 'message', text: 'Sorry to hear that!' },
    { id: 'b', type: 'webhook', url: 'https://evil.example/collect' },
    { id: 'c', type: 'template', name: 'promo' },
    { id: 'd', type: 'action', action: 'checkout' },
    { id: 'e', type: 'delay', minutes: 99999 },
  ] } }, S);
  assert.deepEqual(d.flow.steps.map((s) => s.type), ['message', 'action', 'delay']);
  assert.equal(d.flow.steps[1].action, 'menu');
  assert.equal(d.flow.steps[2].minutes, 1440);
  assert.ok(d.issues.some((x) => /step 2 \("webhook"\) isn't allowed/.test(x)));
  assert.ok(d.issues.some((x) => /template/.test(x)));
  assert.equal(d.ok, true, 'what is left is a valid flow');
  assert.ok(!ALLOWED_STEPS.includes('webhook') && !ALLOWED_STEPS.includes('template'));
  // trigger words that would take over everyday messages, or clash with another automation, block approval
  const hi = checkDraft({ type: 'flow', flow: { name: 'x', triggers: { keywords: ['hi'] }, steps: [{ id: 'a', type: 'end' }] } }, S);
  assert.equal(hi.ok, false);
  const clash = checkDraft({ type: 'flow', flow: { name: 'x', triggers: { keywords: ['offers'] }, steps: [{ id: 'a', type: 'end' }] } }, S, { existingKeywords: ['offers'] });
  assert.equal(clash.ok, false); assert.match(clash.issues.join(' '), /already starts on: offers/);
  // broken links fail the flow builder's own checks
  assert.equal(checkDraft({ type: 'flow', flow: { name: 'x', triggers: { keywords: ['abc'] }, steps: [{ id: 'a', type: 'message', text: 'x', next: 'zz' }] } }, S).ok, false);
  // settings: unknown paths dropped, numbers clamped, shop-only settings refused for an enquiries business
  const st = checkDraft({ type: 'settings', settings: [{ path: 'ordering.paymentLinkUrl', value: 'https://x' }, { path: 'followUps.maxPerDay', value: 20 }, { path: 'notifications.abandonedCartMinutes', value: 30 }, { path: 'quotes.followUp', value: true }] }, S);
  assert.deepEqual(st.changes.map((c) => [c.path, c.after]), [['followUps.maxPerDay', 5]]);
  assert.ok(st.issues.some((x) => /isn't a setting automations may change/.test(x)));
  assert.ok(st.issues.some((x) => /only for businesses selling/.test(x)));
  assert.ok(st.issues.some((x) => /already on/.test(x)), 'quote follow-up is on by default');
  // review requests without a review link: warned
  assert.match(checkDraft({ type: 'settings', settings: [{ path: 'notifications.reviewRequest.enabled', value: true }] }, S).issues.join(' '), /Google review link/);
  // "cannot": shown honestly with where to go instead
  const no = checkDraft({ type: 'cannot', summary: 'Black Friday blast', reason: 'Use Campaigns – only people who opted in.' }, S);
  assert.equal(no.ok, false); assert.match(no.reason, /Campaigns/);
  assert.match(draftPrompt(S, 'x'), /Never invent prices/);
});

test('plain English → checked draft → tried out on a throwaway copy → nothing live until approved', () => withAi(PRICES_FLOW, async (calls) => {
  const t = makeTenant({ business: { name: 'Northgate Heating' }, store: { type: 'none' } });
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM tenants').get().n;
  const d = await createDraft(tenants.getTenant(t.id), 'When someone asks for prices, ask which service and offer to get the team to price it');
  assert.equal(d.status, 'draft'); assert.equal(d.ok, true);
  assert.equal(calls.ai, 1, 'one AI call to draft; the try-out uses none');
  assert.equal(calls.other, 0, 'nothing else leaves the server');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM tenants').get().n, before, 'the try-out copy is deleted');
  assert.equal(d.tryout.runs.length, 3, 'one run per first choice');
  const [r1, r2, r3] = d.tryout.runs.map((run) => run.map((m) => m.text).join('\n'));
  assert.match(r1, /^prices\nHi Sam! Which service/); assert.match(r1, /boiler service price/);
  assert.match(r2, /What needs repairing/); assert.match(r2, /Sample answer/);
  assert.match(r3, /Passing you to the team/);
  assert.equal(d.tryout.handedOver, true);
  assert.equal(listFlows(t.id).length, 0, 'not live yet');
  // the real business is untouched by the try-out
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ?").get(t.id).n, 0);
  const ok = approveDraft(tenants.getTenant(t.id), d.id);
  assert.equal(ok.flow.active, true);
  assert.deepEqual(listFlows(t.id).map((f) => f.name), ['Prices']);
  assert.throws(() => approveDraft(tenants.getTenant(t.id), d.id), /already approved/);
  assert.equal(listDrafts(t.id)[0].status, 'approved');
  // and now it really answers customers
  const replies = await say(tenants.getTenant(t.id), '447700900777', 'price list');
  assert.match(JSON.stringify(replies), /Which service are you asking about/);
}));

test('approval re-checks: a trigger word taken in the meantime blocks it', () => withAi(PRICES_FLOW, async () => {
  const t = makeTenant({ store: { type: 'none' } });
  const d = await createDraft(tenants.getTenant(t.id), 'prices automation please, ask which service');
  saveFlow(t.id, { name: 'Other', triggers: { keywords: ['prices'] }, steps: [{ id: 'a', type: 'end' }] });
  assert.throws(() => approveDraft(tenants.getTenant(t.id), d.id), /already starts on: prices/);
}));

test('a settings draft shows before → after and changes only those settings when approved', () => withAi({ type: 'settings', summary: 'Remind customers the day before and 2 hours before', settings: [{ path: 'bookings.reminderHours', value: 24 }, { path: 'bookings.secondReminderHours', value: 2 }] }, async () => {
  const t = makeTenant({ store: { type: 'none' }, bookings: { enabled: true, times: ['10:00'], services: [{ name: 'Visit', minutes: 60 }], reminderHours: 12 } });
  const d = await createDraft(tenants.getTenant(t.id), 'remind people about appointments the day before and 2 hours before');
  assert.deepEqual(d.changes.map((c) => [c.path, c.before, c.after]), [['bookings.reminderHours', 12, 24], ['bookings.secondReminderHours', 0, 2]]);
  assert.equal(tenants.getTenant(t.id).settings.bookings.reminderHours, 12, 'not changed yet');
  approveDraft(tenants.getTenant(t.id), d.id);
  const B = tenants.getTenant(t.id).settings.bookings;
  assert.deepEqual([B.reminderHours, B.secondReminderHours, B.enabled, B.times], [24, 2, true, ['10:00']]);
}));

test('API: another business cannot draft; no AI = clear message', async () => {
  const t = makeTenant({ store: { type: 'none' } });
  const { tenant: other, adminKey: otherKey } = tenants.createTenant({ name: 'Other' });
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/tenants/${t.id}`;
  const h = (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' });
  try {
    const sup = process.env.SUPER_ADMIN_KEY;
    assert.ok([401, 403].includes((await fetch(`${base}/automation-drafts`, { method: 'POST', headers: h(otherKey), body: JSON.stringify({ text: 'when someone says prices send the list' }) })).status), "another business's key is refused");
    const prevKey = config.aiApiKey; config.aiApiKey = '';
    const r = await fetch(`${base}/automation-drafts`, { method: 'POST', headers: h(sup), body: JSON.stringify({ text: 'when someone says prices send the list' }) });
    config.aiApiKey = prevKey;
    assert.equal(r.status, 503); assert.match((await r.json()).error, /needs the AI/);
    const list = await (await fetch(`${base}/automation-drafts`, { headers: h(sup) })).json();
    assert.ok(Array.isArray(list.drafts));
    void other;
  } finally { server.close(); }
});

test('change an existing automation in plain English: same automation updated (id, on/off kept), diff shown, its own trigger words are not a clash', async () => {
  const t = makeTenant({ store: { type: 'none' } });
  const old = saveFlow(t.id, { name: 'Prices', active: false, triggers: { keywords: ['prices'] }, steps: [{ id: 'a', type: 'message', text: 'Our team will send prices.' }, { id: 'b', type: 'end' }] });
  const updated = { type: 'flow', summary: 'Also asks for the postcode first.', flow: { name: 'Prices', triggers: { keywords: ['prices', 'quote'] }, steps: [{ id: 'a', type: 'question', text: "What's your postcode?", save: 'postcode' }, { id: 'b', type: 'message', text: 'Our team will send prices.' }, { id: 'c', type: 'end' }] } };
  let prompt = '';
  await withAi(() => updated, async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, o) => { if (String(url).includes('/chat/completions')) prompt = JSON.parse(o.body).messages[0].content; return prevFetch(url, o); };
    const d = await createDraft(tenants.getTenant(t.id), 'ask for their postcode before saying the team will send prices', { editOf: old.id });
    globalThis.fetch = prevFetch;
    assert.match(prompt, /CHANGE this existing automation/); assert.match(prompt, /Our team will send prices/);
    assert.equal(d.ok, true, JSON.stringify(d.issues));
    assert.equal(d.editOf, old.id);
    assert.deepEqual(d.diff.keywordsAdded, ['quote']);
    assert.ok(d.diff.added.some((x) => /postcode/.test(x)));
    assert.equal(listFlows(t.id).length, 1);
    approveDraft(tenants.getTenant(t.id), d.id);
    const after = listFlows(t.id);
    assert.equal(after.length, 1, 'changed in place, not added');
    assert.equal(after[0].id, old.id);
    assert.equal(after[0].active, false, 'still switched off, as the owner had it');
    assert.equal(after[0].steps[0].type, 'question');
  });
});
