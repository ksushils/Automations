import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeTenant, tenants, engine } from './helpers.js';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { resolveAudience } from '../src/campaigns.js';
import { exportPerson, erasePerson, hashedWa, applyRetention, rotateEncryption } from '../src/privacy.js';
import { processWebhookBody } from '../src/whatsapp/webhook.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('coexistence-synced contacts get no marketing consent; their imported history is in export, erasure and retention', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: 'PNC', wabaId: 'WC' }, privacy: { retentionMonths: 24 } });
  const T = tenants.getTenant(t.id);
  await processWebhookBody({ entry: [{ id: 'WC', changes: [{ field: 'smb_app_state_sync', value: { state_sync: [{ type: 'contact', action: 'add', contact: { full_name: 'Old Customer', phone_number: '447700904001' } }] } }] }] }, { tenantOverride: T });
  await processWebhookBody({ entry: [{ id: 'WC', changes: [{ field: 'history', value: { history: [{ threads: [{ id: '447700904001', messages: [{ from: '447700904001', id: 'hx1', timestamp: String(Math.floor(Date.now() / 1000) - 86400), type: 'text', text: { body: 'recent question' } }, { from: '447700904001', id: 'hx2', timestamp: String(Math.floor(Date.now() / 1000) - 3 * 365 * 86400), type: 'text', text: { body: 'very old message' } }] }] }] } }] }] }, { tenantOverride: T });
  // even if someone flips the flag, no ledger entry = no campaign
  getDb().prepare("UPDATE customers SET opted_in_marketing = 1 WHERE tenant_id = ? AND wa_id = '447700904001'").run(t.id);
  assert.ok(!resolveAudience(t.id, {}).includes('447700904001'));
  assert.equal(exportPerson(t.id, '447700904001').messages.length, 2);
  applyRetention(); // 3-year-old imported message is past the 24-month rule
  assert.deepEqual(exportPerson(t.id, '447700904001').messages.map((m) => m.body.text), ['recent question']);
  erasePerson(t.id, '447700904001');
  assert.equal(exportPerson(t.id, '447700904001').messages.length, 0);
});

test('suppression hashes are keyed (HMAC), not a plain hash, and survive encryption-key rotation', () => {
  const t = makeTenant();
  const h = hashedWa(t.id, '447700904002');
  const plain = 'h:' + crypto.createHash('sha256').update(`${t.id}:447700904002`).digest('hex').slice(0, 40);
  assert.notEqual(h, plain);
  const prev = config.encryptionKey;
  process.env.ENCRYPTION_KEYS_OLD = prev;
  config.encryptionKey = 'rotation-key-for-suppression-test-0123456789';
  try {
    rotateEncryption();
    assert.equal(hashedWa(t.id, '447700904002'), h); // same secret after rotation
  } finally {
    process.env.ENCRYPTION_KEYS_OLD = config.encryptionKey;
    config.encryptionKey = prev;
    rotateEncryption();
    delete process.env.ENCRYPTION_KEYS_OLD;
  }
});

test('retention: consent ledger after 6 years of inactivity; audit IPs after 90 days, entries after 24 months', () => {
  const t = makeTenant();
  const d = getDb();
  d.prepare("INSERT INTO consents (tenant_id, wa_id, status, source, created_at) VALUES (?, 'old', 'granted', 'x', datetime('now', '-7 years')), (?, 'recent', 'granted', 'x', datetime('now', '-1 year'))").run(t.id, t.id);
  d.prepare("INSERT INTO audit_log (tenant_id, actor, action, ip, created_at) VALUES (?, 'owner', 'a', '1.2.3.4', datetime('now', '-100 days')), (?, 'owner', 'b', '1.2.3.4', datetime('now', '-25 months')), (?, 'owner', 'c', '5.6.7.8', datetime('now'))").run(t.id, t.id, t.id);
  applyRetention();
  const left = d.prepare('SELECT wa_id FROM consents WHERE tenant_id = ?').all(t.id).map((r) => r.wa_id);
  assert.ok(!left.includes('old') && left.includes('recent'));
  const audit = d.prepare('SELECT action, ip FROM audit_log WHERE tenant_id = ? ORDER BY action').all(t.id).map((r) => [r.action, r.ip]);
  assert.deepEqual(audit, [['a', null], ['c', '5.6.7.8']]);
});

test('spend cap: shop cannot raise its own cap; top-up via Stripe extends it; 80% warning goes to staff once', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Cap Shop', plan: 'starter' });
  const H = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ ai: { budgetUsd: 100000, tone: 'professional' } }) });
  const s = tenants.getTenant(tenant.id).settings.ai;
  assert.equal(s.budgetUsd, undefined);
  assert.equal(s.tone, 'professional');

  const period = new Date().toISOString().slice(0, 7);
  getDb().prepare("INSERT INTO usage (tenant_id, period, ai_cost_micro) VALUES (?, ?, 5500000) ON CONFLICT(tenant_id, period) DO UPDATE SET ai_cost_micro = 5500000").run(tenant.id, period);
  assert.equal(tenants.withinLimit(tenants.getTenant(tenant.id), 'ai'), false); // $5.50 > $5 cap

  // top-up paid through the platform Stripe webhook (idempotent)
  Object.assign(config, { platformStripeSecret: 'sk_test', platformStripeWebhookSecret: 'whsec_top' });
  try {
    const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_top1', mode: 'payment', payment_status: 'paid', metadata: { tenant_id: tenant.id, kind: 'ai_topup', usd: '10', period } } } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_top').update(`${ts}.${ev}`).digest('hex');
    for (let i = 0; i < 2; i++) await fetch(`${base}/webhooks/platform-stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: ev });
  } finally { Object.assign(config, { platformStripeSecret: '', platformStripeWebhookSecret: '' }); }
  assert.equal(tenants.withinLimit(tenants.getTenant(tenant.id), 'ai'), true); // $5.50 < $5 + $10
  assert.ok(Math.abs(tenants.aiBudgetUsed(tenants.getTenant(tenant.id)) - 5.5 / 15) < 1e-9); // counted once

  // 80% early warning to staff (direct AI configured)
  getDb().prepare('UPDATE usage SET ai_cost_micro = 12500000 WHERE tenant_id = ? AND period = ?').run(tenant.id, period);
  getDb().prepare("INSERT INTO customers (tenant_id, wa_id, last_inbound_at) VALUES (?, '447000000111', datetime('now'))").run(tenant.id);
  tenants.updateTenantSettings(tenant.id, { notifications: { staffWaIds: ['447000000111'] } });
  const prevKey = config.aiApiKey;
  config.aiApiKey = 'sk-x';
  config.aiBaseUrl = 'http://127.0.0.1:1/v1'; // AI call fails → fallback; the warning is what we test
  const toStaff = [];
  try {
    for (let i = 0; i < 2; i++) await engine.handleInbound(tenants.getTenant(tenant.id), { waId: '447700904003', kind: 'text', text: 'what mugs do you have?' }, async (to, m) => { if (to === '447000000111') toStaff.push(m.text); });
  } finally { config.aiApiKey = prevKey; config.aiBaseUrl = 'https://openrouter.ai/api/v1'; }
  assert.equal(toStaff.filter((x) => /80% of this month's AI budget/.test(x)).length, 1);
}));
