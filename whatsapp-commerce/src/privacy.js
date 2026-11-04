import { getDb, json, encryptSettings } from './db.js';
import crypto from 'node:crypto';
import { needsRotation, encrypt, decrypt } from './crypto.js';
import { listTenants, getTenant } from './tenants.js';

// ---------------- audit log ----------------
export function audit({ tenantId = null, actor, role, action, target = null, detail = null, ip = null, status = null }) {
  getDb().prepare('INSERT INTO audit_log (tenant_id, actor, role, action, target, detail, ip, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tenantId, String(actor || '').slice(0, 80), role || null, String(action).slice(0, 120), target ? String(target).slice(0, 200) : null, detail ? JSON.stringify(detail).slice(0, 2000) : null, ip, status);
}

export const listAudit = (tenantId, { limit = 200 } = {}) =>
  getDb().prepare(`SELECT * FROM audit_log WHERE ${tenantId ? 'tenant_id = ?' : '1 = 1'} ORDER BY id DESC LIMIT ?`).all(...(tenantId ? [tenantId, limit] : [limit])).map((r) => ({ ...r, detail: json(r.detail, null) }));

// ---------------- data subject requests ----------------
/*
 * Suppression / anonymisation hashes are HMACs with a server secret (a plain hash of a phone number can be
 * brute-forced, so it would still be personal data). The secret is generated once, stored encrypted in kv and
 * survives encryption-key rotation (kv values are re-encrypted, the secret itself doesn't change).
 */
function suppressionSecret() {
  const d = getDb();
  const row = d.prepare("SELECT value FROM kv WHERE key = 'suppression_secret'").get();
  if (row) return decrypt(row.value);
  const s = crypto.randomBytes(32).toString('base64url');
  d.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('suppression_secret', ?)").run(encrypt(s));
  return decrypt(d.prepare("SELECT value FROM kv WHERE key = 'suppression_secret'").get().value);
}
export const hashedWa = (tenantId, waId) => 'h:' + crypto.createHmac('sha256', suppressionSecret()).update(`${tenantId}:${waId}`).digest('hex').slice(0, 40);

/** Everything we hold about one person (Article 15 access request). */
export function exportPerson(tenantId, waId) {
  const d = getDb();
  return {
    exportedAt: new Date().toISOString(),
    contact: d.prepare('SELECT * FROM customers WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId) || null,
    consent: d.prepare('SELECT status, source, wording, evidence, actor, created_at FROM consents WHERE tenant_id = ? AND wa_id IN (?, ?) ORDER BY id').all(tenantId, waId, hashedWa(tenantId, waId)),
    conversation: d.prepare('SELECT state, cart, updated_at FROM conversations WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId) || null,
    messages: d.prepare('SELECT direction, type, body, created_at FROM messages WHERE tenant_id = ? AND wa_id = ? ORDER BY id').all(tenantId, waId).map((m) => ({ ...m, body: json(m.body, {}) })),
    orders: d.prepare('SELECT * FROM orders WHERE tenant_id = ? AND wa_id = ? ORDER BY id').all(tenantId, waId).map((o) => ({ ...o, items: json(o.items, []) })),
  };
}

/**
 * Erasure (Article 17). Deletes chats, contact record and pending jobs; anonymises orders (kept for tax records);
 * keeps the consent ledger under a one-way hash so an opt-out is still honoured and provable (PECR).
 */
export function erasePerson(tenantId, waId) {
  const d = getDb();
  const h = hashedWa(tenantId, waId);
  const out = {};
  out.messages = d.prepare('DELETE FROM messages WHERE tenant_id = ? AND wa_id = ?').run(tenantId, waId).changes;
  out.conversation = d.prepare('DELETE FROM conversations WHERE tenant_id = ? AND wa_id = ?').run(tenantId, waId).changes;
  out.messageStatus = d.prepare('DELETE FROM message_status WHERE tenant_id = ? AND wa_id = ?').run(tenantId, waId).changes;
  out.scheduled = d.prepare("DELETE FROM scheduled WHERE tenant_id = ? AND done = 0 AND payload LIKE ?").run(tenantId, `%"waId":"${String(waId).replace(/[%_"]/g, '')}"%`).changes;
  out.orders = d.prepare("UPDATE orders SET wa_id = ?, customer_name = 'erased', address = NULL, notes = NULL, checkout_url = NULL WHERE tenant_id = ? AND wa_id = ?").run(h, tenantId, waId).changes;
  out.consents = d.prepare('UPDATE consents SET wa_id = ? WHERE tenant_id = ? AND wa_id = ?').run(h, tenantId, waId).changes;
  // ensure the erased number stays suppressed for marketing
  d.prepare("INSERT INTO consents (tenant_id, wa_id, status, source, evidence, actor) VALUES (?, ?, 'withdrawn', 'erasure', 'data erased on request', 'owner')").run(tenantId, h);
  out.contact = d.prepare('DELETE FROM customers WHERE tenant_id = ? AND wa_id = ?').run(tenantId, waId).changes;
  return out;
}

/** True if this number was erased / opted out earlier (hashed suppression record). */
export function isSuppressed(tenantId, waId) {
  const r = getDb().prepare('SELECT status FROM consents WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC LIMIT 1').get(tenantId, hashedWa(tenantId, waId));
  return r?.status === 'withdrawn';
}

/**
 * Retention (what the privacy page promises):
 *  - chat messages (incl. imported WhatsApp Business app history): shop setting, default 24 months
 *  - consent ledger: 6 years after the person's last consent event / last contact
 *  - audit log: IP addresses removed after 90 days, entries deleted after 24 months
 */
export function applyRetention() {
  const d = getDb();
  let removed = 0;
  for (const t of listTenants()) {
    const months = Math.max(1, Number(t.settings.privacy?.retentionMonths) || 24);
    removed += d.prepare("DELETE FROM messages WHERE tenant_id = ? AND created_at < datetime('now', ?)").run(t.id, `-${months} months`).changes;
  }
  const consents = d.prepare(`DELETE FROM consents WHERE (tenant_id, wa_id) IN (
      SELECT k.tenant_id, k.wa_id FROM consents k GROUP BY k.tenant_id, k.wa_id
      HAVING MAX(k.created_at) < datetime('now', '-6 years')
         AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.tenant_id = k.tenant_id AND c.wa_id = k.wa_id AND c.last_seen_at > datetime('now', '-6 years')))`).run().changes;
  const auditIps = d.prepare("UPDATE audit_log SET ip = NULL WHERE ip IS NOT NULL AND created_at < datetime('now', '-90 days')").run().changes;
  const audit = d.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-24 months')").run().changes;
  return { messages: removed, consents, auditIps, audit };
}

// ---------------- encryption key rotation ----------------
export function rotateEncryption() {
  const d = getDb();
  let tenants = 0, kvs = 0;
  for (const row of d.prepare('SELECT id, settings FROM tenants').all()) {
    if (!row.settings.includes('enc:') || ![...row.settings.matchAll(/"(enc:[^"]+)"/g)].some((m) => needsRotation(m[1]))) continue;
    const t = getTenant(row.id); // decrypts with whichever key matches
    d.prepare('UPDATE tenants SET settings = ? WHERE id = ?').run(JSON.stringify(encryptSettings(stripEnc(t.settings))), row.id);
    tenants++;
  }
  for (const r of d.prepare("SELECT key, value FROM kv WHERE value LIKE 'enc:%'").all()) {
    if (!needsRotation(r.value)) continue;
    d.prepare('UPDATE kv SET value = ? WHERE key = ?').run(encrypt(decrypt(r.value)), r.key);
    kvs++;
  }
  return { tenants, kv: kvs };
}

// encryptSettings skips values that already look encrypted; decrypted settings are plain, so nothing to strip –
// kept as a hook in case a plaintext value happens to start with "enc:".
const stripEnc = (s) => s;
