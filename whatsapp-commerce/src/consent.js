import { getDb } from './db.js';

/*
 * Consent ledger for marketing messages (UK PECR reg. 22 / UK GDPR).
 * Meta's opt-in rules are not enough on their own: keep proof of who agreed, when, how and to what wording.
 * The customers.opted_in_marketing flag mirrors the latest ledger entry; campaigns require a ledger "granted".
 */
export const defaultWording = (shop) => `Yes, send me offers and news from ${shop} on WhatsApp. I can reply STOP at any time.`;

export function recordConsent(tenantId, waId, { status, source, wording = null, evidence = null, actor = 'customer' }) {
  if (!['granted', 'withdrawn'].includes(status)) throw new Error('status must be granted or withdrawn');
  const d = getDb();
  d.prepare(`INSERT INTO customers (tenant_id, wa_id) VALUES (?, ?) ON CONFLICT(tenant_id, wa_id) DO NOTHING`).run(tenantId, waId);
  d.prepare('INSERT INTO consents (tenant_id, wa_id, status, source, wording, evidence, actor) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tenantId, waId, status, String(source).slice(0, 80), wording ? String(wording).slice(0, 500) : null, evidence ? String(evidence).slice(0, 500) : null, String(actor || '').slice(0, 80));
  d.prepare('UPDATE customers SET opted_in_marketing = ? WHERE tenant_id = ? AND wa_id = ?').run(status === 'granted' ? 1 : 0, tenantId, waId);
}

export const consentHistory = (tenantId, waId) =>
  getDb().prepare('SELECT status, source, wording, evidence, actor, created_at FROM consents WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC').all(tenantId, waId);

export const latestConsent = (tenantId, waId) =>
  getDb().prepare('SELECT status, source, wording, evidence, actor, created_at FROM consents WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC LIMIT 1').get(tenantId, waId) || null;

/** SQL fragment: contact c has a recorded, still-valid marketing consent. */
export const HAS_CONSENT_SQL = `(SELECT status FROM consents k WHERE k.tenant_id = c.tenant_id AND k.wa_id = c.wa_id ORDER BY k.id DESC LIMIT 1) = 'granted'`;
