import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, say, ids, tenants, engine } from './helpers.js';
import { saveFlow, validateFlow, getContact, dueJobs } from '../src/bot/flows.js';
import { createCampaign, resolveAudience, runCampaign, recordStatus, recordReply, campaignStats } from '../src/campaigns.js';
import { buildTemplate } from '../src/templates.js';
import { runScheduled } from '../src/jobs.js';
import { getDb } from '../src/db.js';

const canvasFlow = {
  name: 'Welcome',
  triggers: { keywords: ['hi', 'hello'], match: 'exact', welcome: false, start: 'a' },
  steps: [
    { id: 'z', type: 'end', x: 0, y: 0 }, // array order doesn't matter – graph does
    { id: 'a', type: 'message', text: 'Hi {{name}}! Pick one', buttons: [{ title: 'Shop', goto: 'b' }, { title: 'Join list', goto: 'c' }, { title: 'Human', goto: 'h' }] },
    { id: 'b', type: 'action', action: 'browse' },
    { id: 'c', type: 'question', text: 'Your email?', save: 'email', validate: 'email', next: 'd' },
    { id: 'd', type: 'tag', add: ['newsletter'], next: 'e' },
    { id: 'e', type: 'list', text: 'Favourite?', button: 'Pick', rows: [{ title: 'Tees', goto: 'f' }, { title: 'Mugs', goto: 'g' }] },
    { id: 'f', type: 'products', category: 'tees' },
    { id: 'g', type: 'message', text: 'Thanks {{name}}, saved {{attr.email}} ✅', next: 'z' },
    { id: 'h', type: 'handover', text: 'Getting a human…' },
  ],
};

test('flow validation catches broken links and limits', () => {
  assert.deepEqual(validateFlow(canvasFlow), []);
  const bad = structuredClone(canvasFlow);
  bad.steps[1].buttons.push({ title: 'x' });
  bad.steps[3].next = 'nope';
  const errs = validateFlow(bad);
  assert.ok(errs.some((e) => /max 3 buttons/.test(e)));
  assert.ok(errs.some((e) => /missing step \(nope\)/.test(e)));
});

test('canvas flow: keyword trigger, buttons, question validation, tags, list, attributes', async () => {
  const t = makeTenant();
  saveFlow(t.id, canvasFlow);
  const wa = '447700900501';
  let r = await say(t, wa, 'Hello');
  assert.match(r[0].text, /Hi Jane! Pick one/);
  const [shop, join] = ids(r);
  r = await say(t, wa, { action: join });
  assert.equal(r[0].text, 'Your email?');
  r = await say(t, wa, 'not-an-email');
  assert.match(r[0].text, /valid email/);
  r = await say(t, wa, 'jane@example.com');
  assert.equal(r[0].type, 'list');
  const c = getContact(t.id, wa);
  assert.equal(c.email, 'jane@example.com');
  assert.deepEqual(c.tags, ['newsletter']);
  r = await say(t, wa, { action: ids(r)[1] }); // Mugs
  assert.equal(r[0].text, 'Thanks Jane, saved jane@example.com ✅');
  r = await say(t, wa, 'hi');
  r = await say(t, wa, { action: shop });
  assert.deepEqual(ids(r), ['cat:tees', 'cat:mugs']); // hands over to the shop bot
  r = await say(t, wa, 'hi');
  r = await say(t, wa, { action: ids(r)[0].replace(/:0$/, ':0') });
});

test('flow list row → products node; handover node; contains match; welcome trigger', async () => {
  const t = makeTenant();
  saveFlow(t.id, canvasFlow);
  saveFlow(t.id, { name: 'Hours', triggers: { keywords: ['open'], match: 'contains' }, steps: [{ type: 'message', text: 'Open 9-5' }] });
  saveFlow(t.id, { name: 'First', triggers: { keywords: [], welcome: true }, steps: [{ type: 'message', text: 'Welcome newbie!' }] });
  let r = await say(t, '447700900502', 'what time are you open?');
  assert.equal(r[0].text, 'Open 9-5');
  r = await say(t, '447700900503', 'random first message');
  assert.equal(r[0].text, 'Welcome newbie!');
  r = await say(t, '447700900503', 'random second message');
  assert.notEqual(r[0]?.text, 'Welcome newbie!');
  r = await say(t, '447700900504', 'hi');
  r = await say(t, '447700900504', { action: ids(r)[2] });
  assert.equal(r[0].text, 'Getting a human…');
});

test('delay step schedules a resume that the job runner delivers', async () => {
  const t = makeTenant();
  saveFlow(t.id, { name: 'Drip', triggers: { keywords: ['drip'] }, steps: [{ id: 'a', type: 'message', text: 'Part 1', next: 'b' }, { id: 'b', type: 'delay', minutes: 1, next: 'c' }, { id: 'c', type: 'message', text: 'Part 2' }] });
  const wa = '447700900505';
  const r = await say(t, wa, 'drip');
  assert.deepEqual(r.map((m) => m.text), ['Part 1']);
  getDb().prepare("UPDATE scheduled SET run_at = datetime('now', '-1 minute') WHERE tenant_id = ?").run(t.id);
  const sent = [];
  const realFetch = globalThis.fetch;
  tenants.updateTenantSettings(t.id, { whatsapp: { phoneNumberId: 'P', accessToken: 'tok' } });
  globalThis.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return new Response('{"messages":[{"id":"w1"}]}', { status: 200 }); };
  try { await runScheduled(); } finally { globalThis.fetch = realFetch; }
  assert.ok(sent.some((m) => m.to === wa && m.text?.body === 'Part 2'));
  assert.equal(dueJobs().filter((j) => j.tenant_id === t.id).length, 0);
});

test('segments, scheduled campaign, delivery/read tracking and retargeting', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: 'P', accessToken: 'tok' } });
  const d = getDb();
  const add = (wa, name, tags, optin = 1) => d.prepare('INSERT INTO customers (tenant_id, wa_id, name, tags, opted_in_marketing) VALUES (?, ?, ?, ?, ?)').run(t.id, wa, name, JSON.stringify(tags), optin);
  add('441', 'Ann Lee', ['vip']); add('442', 'Bob', ['vip', 'wholesale']); add('443', 'Cy', []); add('444', 'Di', ['vip'], 0);
  d.prepare("INSERT INTO orders (tenant_id, wa_id, items) VALUES (?, '441', '[]')").run(t.id);
  assert.deepEqual(resolveAudience(t.id, { tags: ['vip'] }).sort(), ['441', '442']);
  assert.deepEqual(resolveAudience(t.id, { tags: ['vip'], excludeTags: ['wholesale'] }), ['441']);
  assert.deepEqual(resolveAudience(t.id, { hasOrdered: false }).sort(), ['442', '443']);

  const c = createCampaign(t.id, { name: 'VIP', template: 'weekend_offer', components: [{ type: 'body', parameters: [{ type: 'text', text: '{{name}}' }, { type: 'text', text: '20% off' }] }], audience: { tags: ['vip'] } });
  assert.equal(c.status, 'scheduled');
  const sent = [];
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, opts) => { const b = JSON.parse(opts.body); sent.push(b); return new Response(JSON.stringify({ messages: [{ id: `wamid.${++n}` }] }), { status: 200 }); };
  try { await runCampaign(t, c.id, { delayMs: 0 }); } finally { globalThis.fetch = realFetch; }
  assert.equal(sent.length, 2);
  const ann = sent.find((m) => m.to === '441');
  assert.equal(ann.template.components[0].parameters[0].text, 'Ann'); // personalised
  const midAnn = 'wamid.' + (sent.indexOf(ann) + 1);
  const midBob = 'wamid.' + (sent.findIndex((m) => m.to === '442') + 1);
  recordStatus(t.id, { id: midAnn, status: 'delivered' });
  recordStatus(t.id, { id: midAnn, status: 'read' });
  recordStatus(t.id, { id: midAnn, status: 'delivered' }); // out-of-order: must not downgrade
  recordStatus(t.id, { id: midBob, status: 'delivered' });
  recordReply(t.id, '441');
  assert.deepEqual(campaignStats(t.id, c.id), { total: 2, sent: 2, delivered: 2, read: 1, failed: 0, replied: 1 });
  assert.deepEqual(resolveAudience(t.id, { retarget: { campaignId: c.id, status: 'not_read' } }), ['442']);
  assert.deepEqual(resolveAudience(t.id, { retarget: { campaignId: c.id, status: 'replied' } }), ['441']);
  assert.throws(() => createCampaign(t.id, { template: 'x', scheduledAt: new Date(Date.now() + 90 * 864e5).toISOString() }), /2 months/);
});

test('template builder produces a valid Meta payload', () => {
  const p = buildTemplate({ name: 'weekend_offer', category: 'marketing', body: 'Hi {{1}}, {{2}} this weekend', examples: ['Jane'], buttons: [{ text: 'Shop now' }, { text: 'Visit', url: 'https://x.y/{{1}}' }] });
  assert.equal(p.category, 'MARKETING');
  assert.deepEqual(p.components[0].example.body_text, [['Jane', 'example2']]);
  assert.equal(p.components[1].buttons[1].type, 'URL');
  assert.throws(() => buildTemplate({ name: 'Bad Name', body: 'x' }), /lowercase/);
});

test('click-to-WhatsApp ad referral is stored and can trigger a flow', async () => {
  const t = makeTenant();
  saveFlow(t.id, { name: 'Ad flow', triggers: { keywords: [], adIds: ['120200'] }, steps: [{ type: 'message', text: 'Thanks for clicking our ad! 30% off today.' }] });
  const sent = [];
  await engine.handleInbound(tenants.getTenant(t.id), { waId: '447700900506', kind: 'text', text: 'Hello! Can I get more info on this?', referral: { source_id: '120200', source_type: 'ad', headline: 'Winter sale' } }, async (to, m) => sent.push(m));
  assert.match(sent[0].text, /clicking our ad/);
  assert.equal(JSON.parse(getContact(t.id, '447700900506').source).headline, 'Winter sale');
});
