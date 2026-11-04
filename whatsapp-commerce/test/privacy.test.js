import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, say, tenants } from './helpers.js';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { encrypt, decrypt, needsRotation } from '../src/crypto.js';
import { rotateEncryption, applyRetention, hashedWa } from '../src/privacy.js';
import { recordConsent } from '../src/consent.js';
import { listOrders } from '../src/bot/orders.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('audit log records changes and exports (field names only, never values)', () => withServer(async (base) => {
  const { tenant, adminKey } = tenants.createTenant({ name: 'Audit Shop' });
  const H = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  await fetch(`${base}/api/tenants/${tenant.id}/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ whatsapp: { accessToken: 'EAAG-super-secret' } }) });
  await fetch(`${base}/api/tenants/${tenant.id}/export/orders.csv`, { headers: H });
  const { audit } = await (await fetch(`${base}/api/tenants/${tenant.id}/audit`, { headers: H })).json();
  const actions = audit.map((a) => a.action);
  assert.ok(actions.includes('PATCH /tenants/:id/settings'));
  assert.ok(actions.includes('GET /tenants/:id/export/orders.csv'));
  assert.ok(!JSON.stringify(audit).includes('EAAG-super-secret'));
  assert.deepEqual(audit.find((a) => a.action === 'PATCH /tenants/:id/settings').detail, { fields: ['whatsapp'] });
}));

test('DSAR export + erasure: chats deleted, orders anonymised, opt-out kept and honoured on re-import', () => withServer(async (base) => {
  const t = makeTenant();
  const adminKey = tenants.rotateKeys(t.id).adminKey;
  const H = { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' };
  const wa = '447700903001';
  await say(t, wa, 'hi');
  await say(t, wa, { action: 'v:mug|mug' });
  await say(t, wa, { action: 'q:1' });
  await say(t, wa, { action: 'checkout' });
  await say(t, wa, { action: 'ful:pickup' });
  await say(t, wa, { action: 'pay:cod' });
  await say(t, wa, { action: 'confirm' });
  recordConsent(t.id, wa, { status: 'granted', source: 'whatsapp_opt_in', wording: 'yes' });
  getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, ?, 'in', 'text', '{\"text\":\"my address is 1 High St\"}')").run(t.id, wa);

  const exp = await (await fetch(`${base}/api/tenants/${t.id}/contacts/${wa}/export`, { headers: H })).json();
  assert.equal(exp.orders.length, 1);
  assert.ok(exp.messages.length >= 1);
  assert.equal(exp.consent[0].status, 'granted');

  assert.equal((await fetch(`${base}/api/tenants/${t.id}/contacts/${wa}/erase`, { method: 'POST', headers: H, body: '{}' })).status, 400);
  const r = await (await fetch(`${base}/api/tenants/${t.id}/contacts/${wa}/erase`, { method: 'POST', headers: H, body: JSON.stringify({ confirm: true }) })).json();
  assert.ok(r.ok);
  const d = getDb();
  assert.equal(d.prepare('SELECT COUNT(*) n FROM messages WHERE tenant_id = ? AND wa_id = ?').get(t.id, wa).n, 0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM customers WHERE tenant_id = ? AND wa_id = ?').get(t.id, wa).n, 0);
  const [o] = listOrders(t.id, { waId: hashedWa(t.id, wa) });
  assert.equal(o.customer_name, 'erased'); // order kept for accounting, without personal data
  assert.equal(o.subtotal, 8.5);
  // re-importing the same number with an opt-in must not resubscribe them
  const csv = `phone,name,opt_in\n+${wa},Again,yes\n`;
  const imp = await (await fetch(`${base}/api/tenants/${t.id}/contacts/import`, { method: 'POST', headers: H, body: JSON.stringify({ csv, consentDeclaration: { confirmed: true, source: 'sheet', wording: 'Yes send me offers please' } }) })).json();
  assert.equal(imp.consented, 0);
  assert.match(imp.errors[0], /previously opted out/);
}));

test('retention deletes chat messages older than the shop setting', () => {
  const t = makeTenant({ privacy: { retentionMonths: 6 } });
  const ins = getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, '44', 'in', 'text', '{}', datetime('now', ?))");
  ins.run(t.id, '-8 months'); ins.run(t.id, '-1 month');
  applyRetention();
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM messages WHERE tenant_id = ?').get(t.id).n, 1);
});

test('encryption key rotation: old key still decrypts, re-encrypt moves everything to the new key', () => {
  const t = makeTenant({ whatsapp: { accessToken: 'tok-before-rotation' } });
  const prevKey = config.encryptionKey;
  const rawBefore = getDb().prepare('SELECT settings FROM tenants WHERE id = ?').get(t.id).settings;
  assert.match(rawBefore, /"accessToken":"enc:v2:/);
  process.env.ENCRYPTION_KEYS_OLD = prevKey;
  config.encryptionKey = 'a-brand-new-encryption-key-for-rotation-test';
  try {
    assert.equal(tenants.getTenant(t.id).settings.whatsapp.accessToken, 'tok-before-rotation'); // readable with old key
    const r = rotateEncryption();
    assert.ok(r.tenants >= 1);
    const raw = getDb().prepare('SELECT settings FROM tenants WHERE id = ?').get(t.id).settings;
    const token = raw.match(/"accessToken":"(enc:[^"]+)"/)[1];
    assert.equal(needsRotation(token), false);
    delete process.env.ENCRYPTION_KEYS_OLD; // old key retired
    assert.equal(tenants.getTenant(t.id).settings.whatsapp.accessToken, 'tok-before-rotation');
    assert.equal(decrypt(encrypt('x')), 'x');
  } finally {
    // rotate back so the rest of the suite can read its data (the same procedure you'd use in production)
    process.env.ENCRYPTION_KEYS_OLD = config.encryptionKey;
    config.encryptionKey = prevKey;
    rotateEncryption();
    delete process.env.ENCRYPTION_KEYS_OLD;
  }
});

test('legacy enc: values (before key ids) are still readable', async () => {
  const crypto = await import('node:crypto');
  const key = crypto.createHash('sha256').update(config.encryptionKey).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update('legacy-secret', 'utf8'), c.final()]);
  const legacy = 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  assert.equal(decrypt(legacy), 'legacy-secret');
  assert.equal(needsRotation(legacy), true);
});

test('several super-admin keys can be valid during rotation', () => withServer(async (base) => {
  config.superAdminKeysExtra = ['second-super-admin-key-xyz'];
  try {
    assert.equal((await fetch(`${base}/api/tenants`, { headers: { Authorization: 'Bearer second-super-admin-key-xyz' } })).status, 200);
    assert.equal((await fetch(`${base}/api/tenants`, { headers: { Authorization: 'Bearer super-admin-test-key' } })).status, 200);
  } finally { config.superAdminKeysExtra = []; }
}));
