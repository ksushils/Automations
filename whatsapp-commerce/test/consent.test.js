import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeTenant, tenants } from './helpers.js';
import { createApp } from '../src/server.js';
import { consentHistory, latestConsent } from '../src/consent.js';
import { resolveAudience } from '../src/campaigns.js';
import { getDb } from '../src/db.js';
import { recoverUnprocessed } from '../src/whatsapp/webhook.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('CSV import: opt-ins only with a consent declaration; ledger + export; staff opt-in needs a note', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Consent Shop' });
  const H = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  const csv = 'phone,name,opt_in,consent_date\n07700900801,Amy,yes,2026-10-01\n07700900802,Ben,yes,\n';
  let r = await (await fetch(`${base}/api/tenants/${tenant.id}/contacts/import`, { method: 'POST', headers: H, body: JSON.stringify({ csv }) })).json();
  assert.equal(r.imported, 2);
  assert.equal(r.consented, 0);
  assert.match(r.note, /WITHOUT marketing consent/);
  assert.equal(resolveAudience(tenant.id, {}).length, 0);
  r = await (await fetch(`${base}/api/tenants/${tenant.id}/contacts/import`, { method: 'POST', headers: H, body: JSON.stringify({ csv, consentDeclaration: { confirmed: true, source: 'in-store sign-up sheet', wording: 'Yes, text me offers on WhatsApp' } }) })).json();
  assert.equal(r.consented, 2);
  const c = latestConsent(tenant.id, '447700900801');
  assert.equal(c.source, 'import:in-store sign-up sheet');
  assert.match(c.evidence, /consented 2026-10-01/);
  assert.equal(resolveAudience(tenant.id, {}).length, 2);
  // staff opt-in without saying how → refused
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id) VALUES (?, '447700900803')").run(tenant.id);
  let p = await fetch(`${base}/api/tenants/${tenant.id}/contacts/447700900803`, { method: 'PATCH', headers: H, body: JSON.stringify({ opted_in_marketing: true }) });
  assert.equal(p.status, 400);
  p = await fetch(`${base}/api/tenants/${tenant.id}/contacts/447700900803`, { method: 'PATCH', headers: H, body: JSON.stringify({ opted_in_marketing: true, consentNote: 'paper form 3 Nov' }) });
  assert.equal(p.status, 200);
  assert.equal(consentHistory(tenant.id, '447700900803')[0].actor, 'owner');
  const exp = await (await fetch(`${base}/api/tenants/${tenant.id}/export/consent.csv`, { headers: H })).text();
  assert.match(exp, /^whatsapp,status,source,wording,evidence,actor,created_at/);
  assert.equal(exp.trim().split('\n').length, 4);
}));

test('web checkout opt-in is recorded with IP / user-agent evidence', () => withServer(async (base) => {
  const t = makeTenant({ business: { whatsappNumber: '447700900123' } });
  const r = await fetch(`${base}/s/${t.id}/order`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'TestBrowser/1' }, body: JSON.stringify({ items: [{ productId: 'mug', quantity: 1 }], name: 'Web Ann', phone: '07700900804', fulfilment: 'pickup', paymentMethod: 'cod', optIn: true }) });
  assert.equal(r.status, 200);
  const c = latestConsent(t.id, '447700900804');
  assert.equal(c.source, 'web_checkout');
  assert.match(c.evidence, /ua TestBrowser\/1/);
}));

test('durable inbound: a message stored but not processed (crash) is replayed once, then marked done', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: 'PN', accessToken: 'tok' } });
  const m = { from: '447700900805', id: 'wamid.crash1', timestamp: '1', type: 'text', text: { body: 'hi' } };
  getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, wa_message_id, processed, created_at) VALUES (?, ?, 'in', 'text', ?, ?, 0, datetime('now', '-1 minute'))").run(t.id, m.from, JSON.stringify({ type: 'text', text: 'hi', message: m, profileName: 'Crash' }), m.id);
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body); if (b.to) sent.push(b); return new Response('{"messages":[{"id":"x"}]}'); };
  try {
    assert.equal(await recoverUnprocessed(), 1);
    assert.equal(await recoverUnprocessed(), 0);
  } finally { globalThis.fetch = realFetch; }
  assert.ok(sent.some((b) => b.to === m.from), 'customer finally got a reply');
  assert.equal(getDb().prepare("SELECT processed FROM messages WHERE wa_message_id = 'wamid.crash1'").get().processed, 1);
});

test('Embedded Signup v4: finishing with no phone number is a valid pending state; refresh activates it', () => withServer(async (base) => {
  const { config } = await import('../src/config.js');
  Object.assign(config, { metaAppId: 'a', metaAppSecret: 's', metaConfigId: 'c' });
  const { tenant, adminKey } = tenants.createTenant({ name: 'V4 Shop' });
  const H = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  const realFetch = globalThis.fetch;
  let numbers = [];
  const calls = [];
  globalThis.fetch = async (u, o = {}) => {
    const url = String(u);
    if (!url.startsWith('https://graph.facebook.com')) return realFetch(u, o);
    calls.push(`${o.method || 'GET'} ${new URL(url).pathname}`);
    if (url.includes('oauth/access_token')) return new Response('{"access_token":"tok4"}');
    if (url.includes('/phone_numbers')) return new Response(JSON.stringify({ data: numbers }));
    if (url.includes('/PN4?')) return new Response('{"display_phone_number":"+44 7700 900444"}');
    return new Response('{"success":true}');
  };
  try {
    let r = await (await realFetch(`${base}/api/tenants/${tenant.id}/whatsapp/embedded`, { method: 'POST', headers: H, body: JSON.stringify({ code: 'C', wabaId: 'W4', event: 'FINISH_ONLY_WABA' }) })).json();
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.numberStatus, 'pending');
    assert.equal(tenants.getTenant(tenant.id).settings.whatsapp.wabaId, 'W4');
    numbers = [{ id: 'PN4', code_verification_status: 'VERIFIED' }];
    r = await (await realFetch(`${base}/api/tenants/${tenant.id}/whatsapp/refresh-number`, { method: 'POST', headers: H })).json();
    assert.equal(r.numberStatus, 'active');
    assert.equal(tenants.getTenant(tenant.id).settings.business.whatsappNumber, '447700900444');
    // coexistence: number stays on the Business app → no /register call
    calls.length = 0;
    const { tenant: t2, adminKey: k2 } = tenants.createTenant({ name: 'Coex Shop' });
    r = await (await realFetch(`${base}/api/tenants/${t2.id}/whatsapp/embedded`, { method: 'POST', headers: { ...H, Authorization: 'Bearer ' + k2 }, body: JSON.stringify({ code: 'C', wabaId: 'W5', phoneNumberId: 'PN4', coexistence: true, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' }) })).json();
    assert.equal(r.numberStatus, 'active');
    assert.ok(!calls.some((c) => c.endsWith('/register')));
    // Meta: contacts + history must be synced within 24h of coexistence onboarding
    assert.equal(calls.filter((c) => c === 'POST /v26.0/PN4/smb_app_data').length, 2);
    assert.ok(tenants.getTenant(t2.id).settings.whatsapp.coexSync.history);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config, { metaAppId: '', metaAppSecret: '', metaConfigId: '' });
  }
}));

test('coexistence echo: owner replying from the Business app pauses the bot for that chat', async () => {
  const { processWebhookBody } = await import('../src/whatsapp/webhook.js');
  const { getConversation } = await import('../src/bot/state.js');
  const t = makeTenant({ whatsapp: { phoneNumberId: 'PNX' } });
  await processWebhookBody({ entry: [{ changes: [{ field: 'smb_message_echoes', value: { metadata: { phone_number_id: 'PNX' }, message_echoes: [{ from: '44700', to: '447700900806', id: 'e1', type: 'text', text: { body: 'Hi, it is Sam from the shop' } }] } }] }] }, { tenantOverride: tenants.getTenant(t.id) });
  assert.equal(getConversation(t.id, '447700900806').humanHandover, true);
  assert.equal(JSON.parse(getDb().prepare("SELECT body FROM messages WHERE tenant_id = ? AND wa_id = '447700900806'").get(t.id).body).via, 'business_app');
});

test('Meta cost estimates: free 1,000 service replies, then per-message; campaign preview cost', async () => {
  const { estimateCampaign, monthEstimate } = await import('../src/metaPricing.js');
  const t = makeTenant();
  const ins = getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, ?, 'out', ?, '{}')");
  for (let i = 0; i < 1200; i++) ins.run(t.id, '447700900900', 'text');
  for (let i = 0; i < 10; i++) ins.run(t.id, '447700900900', 'template');
  const m = monthEstimate(t.id);
  assert.equal(m.serviceMessages, 1200);
  assert.equal(m.freeServiceLeft, 0);
  assert.equal(m.serviceGbp, 3.4); // 200 × £0.017
  assert.equal(m.templateGbp, 0.5); // 10 × £0.05
  assert.deepEqual(estimateCampaign(['447700900001', '353870000001']), { recipients: 2, category: 'marketing', estimatedGbp: 0.11 });
});

test('plan limit reached: customer gets one polite reply a day and the chat goes to a human', async () => {
  const { say } = await import('./helpers.js');
  const { getConversation } = await import('../src/bot/state.js');
  const t = makeTenant();
  tenants.updateTenantMeta(t.id, { plan: 'starter' });
  getDb().prepare("INSERT INTO usage (tenant_id, period, inbound) VALUES (?, ?, 5000) ON CONFLICT(tenant_id, period) DO UPDATE SET inbound = 5000").run(t.id, new Date().toISOString().slice(0, 7));
  const sent = [];
  const { engine } = await import('./helpers.js');
  await engine.handleInbound(tenants.getTenant(t.id), { waId: '447700900950', kind: 'text', text: 'hi' }, async (to, m2) => sent.push(m2));
  await engine.handleInbound(tenants.getTenant(t.id), { waId: '447700900950', kind: 'text', text: 'hello?' }, async (to, m2) => sent.push(m2));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /team will reply here shortly/);
  assert.equal(getConversation(t.id, '447700900950').humanHandover, true);
  void say;
});


test('coexistence webhooks: contacts sync, history import, account offboarding, new account IDs captured', async () => {
  const { processWebhookBody } = await import('../src/whatsapp/webhook.js');
  const t = makeTenant({ whatsapp: { phoneNumberId: 'PNH', wabaId: 'WABAH' } });
  const T = tenants.getTenant(t.id);
  await processWebhookBody({ entry: [{ id: 'WABAH', changes: [{ field: 'smb_app_state_sync', value: { metadata: { phone_number_id: 'PNH', waac_id: 'WAAC77' }, state_sync: [{ type: 'contact', action: 'add', contact: { full_name: 'Priya Shah', phone_number: '447700900991' } }] } }] }] }, { tenantOverride: T });
  assert.equal(getDb().prepare("SELECT name FROM customers WHERE tenant_id = ? AND wa_id = '447700900991'").get(t.id).name, 'Priya Shah');
  assert.equal(tenants.getTenant(t.id).settings.whatsapp.accountIds.waac_id, 'WAAC77');
  await processWebhookBody({ entry: [{ id: 'WABAH', changes: [{ field: 'history', value: { metadata: { phone_number_id: 'PNH' }, history: [{ threads: [{ id: '447700900991', messages: [{ from: '447700900991', id: 'h1', timestamp: '1760000000', type: 'text', text: { body: 'Do you have size 8?' } }, { from: '44700', id: 'h2', timestamp: '1760000100', type: 'text', text: { body: 'Yes we do!' } }] }] }] } }] }] }, { tenantOverride: T });
  const hist = getDb().prepare("SELECT direction, body FROM messages WHERE tenant_id = ? AND wa_id = '447700900991' ORDER BY created_at").all(t.id);
  assert.deepEqual(hist.map((h) => [h.direction, JSON.parse(h.body).text]), [['in', 'Do you have size 8?'], ['out', 'Yes we do!']]);
  // account_update arrives without a phone number – routed by WABA id
  await processWebhookBody({ entry: [{ id: 'WABAH', changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED' } }] }] });
  assert.equal(tenants.getTenant(t.id).settings.whatsapp.numberStatus, 'offboarded');
});

test('Dify gate: tenants cannot switch to the shared Dify without a licence/grant; own Dify is fine', () => withServer(async (base) => {
  const { difyAllowed } = await import('../src/ai/gate.js');
  const { config } = await import('../src/config.js');
  const { tenant, adminKey } = tenants.createTenant({ name: 'Gate Shop' });
  const H = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  assert.equal(difyAllowed(tenants.getTenant(tenant.id)), false);
  let r = await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ ai: { provider: 'dify' } }) });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ difyAllowed: true }) });
  assert.equal(tenants.getTenant(tenant.id).settings.difyAllowed, undefined); // owners can't grant themselves
  assert.equal((await fetch(`${base}/api/tenants/${tenant.id}/ai/provision`, { method: 'POST', headers: H })).status, 403);
  // super admin grant
  await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: { ...H, Authorization: 'Bearer super-admin-test-key' }, body: JSON.stringify({ difyAllowed: true }) });
  assert.equal(difyAllowed(tenants.getTenant(tenant.id)), true);
  // a shop using its OWN Dify (different host) is not our multi-tenant use
  const { tenant: t2 } = tenants.createTenant({ name: 'Own Dify' });
  tenants.updateTenantSettings(t2.id, { dify: { apiKey: 'app-own', baseUrl: 'https://dify.ownshop.example/v1' } });
  assert.equal(difyAllowed(tenants.getTenant(t2.id)), true);
  tenants.updateTenantSettings(t2.id, { dify: { baseUrl: config.difyConsoleUrl + '/v1' } });
  assert.equal(difyAllowed(tenants.getTenant(t2.id)), false);
}));

test('marketing templates always get an opt-out; promo "utility" templates are flagged; campaigns refuse templates without opt-out', () => withServer(async (base) => {
  const { buildTemplate, templateWarnings, cacheTemplates, TEMPLATE_LIBRARY, hasOptOut } = await import('../src/templates.js');
  const p = buildTemplate({ name: 'flash_sale', category: 'MARKETING', body: '20% off today, {{1}}!', examples: ['Jo'] });
  assert.equal(p.components.at(-1).buttons.at(-1).text, 'Stop offers');
  assert.equal(buildTemplate({ name: 'x', category: 'MARKETING', body: 'Sale on! Reply STOP to opt out' }).components.some((c) => c.type === 'BUTTONS'), false);
  assert.match(templateWarnings({ category: 'UTILITY', body: 'Your order shipped – use code SAVE10 for 10% off next time' })[0], /recategorise it as MARKETING/);
  assert.equal(templateWarnings({ category: 'UTILITY', body: 'Your order {{1}} has shipped' }).length, 0);
  for (const t of TEMPLATE_LIBRARY.filter((x) => x.category === 'MARKETING')) assert.ok(hasOptOut(buildTemplate(t).components), t.name);
  const { tenant, adminKey } = tenants.createTenant({ name: 'Tpl Shop', plan: 'pro' });
  cacheTemplates(tenant.id, [{ name: 'old_promo', category: 'MARKETING', components: [{ type: 'BODY', text: 'Big sale!' }] }, { name: 'order_update', category: 'UTILITY', components: [{ type: 'BODY', text: 'Order update' }] }]);
  const H = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  let r = await fetch(`${base}/api/tenants/${tenant.id}/campaigns`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'old_promo' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no opt-out/);
  r = await fetch(`${base}/api/tenants/${tenant.id}/campaigns/preview`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'order_update', audience: { optedInOnly: false } }) });
  assert.equal((await r.json()).cost.category, 'utility');
}));

test('dead-letter: after 3 failed attempts a message is parked and alerted, and can be re-queued', async () => {
  const { recoverUnprocessed } = await import('../src/whatsapp/webhook.js');
  const t = makeTenant();
  getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, wa_message_id, processed, attempts, created_at) VALUES (?, '4477009', 'in', 'text', '{}', 'wamid.poison', 0, 3, datetime('now','-5 minutes'))").run(t.id);
  await recoverUnprocessed();
  assert.equal(getDb().prepare("SELECT processed FROM messages WHERE wa_message_id = 'wamid.poison'").get().processed, -1);
  const { systemStatus } = await import('../src/ops.js');
  assert.ok(systemStatus().deadLetters >= 1);
});

test('AI hard spend cap blocks AI even with replies left', async () => {
  const t = makeTenant();
  tenants.updateTenantMeta(t.id, { plan: 'starter' });
  getDb().prepare("INSERT INTO usage (tenant_id, period, ai_calls, ai_cost_micro) VALUES (?, ?, 10, 6000000) ON CONFLICT(tenant_id, period) DO UPDATE SET ai_cost_micro = 6000000").run(t.id, new Date().toISOString().slice(0, 7));
  assert.equal(tenants.withinLimit(tenants.getTenant(t.id), 'ai'), false); // $6 spent > $5 Starter cap
  const { costMicro } = await import('../src/ai/direct.js');
  assert.equal(costMicro({ cost: 0.0012 }), 1200);
  assert.equal(costMicro({ prompt_tokens: 1000000, completion_tokens: 0 }), 150000);
});
