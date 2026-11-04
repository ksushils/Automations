import { getDb, json } from './db.js';
import { createSender } from './whatsapp/cloudApi.js';
import { schedule } from './bot/flows.js';
import { HAS_CONSENT_SQL } from './consent.js';

/**
 * Audience (segment) definition:
 * { optedInOnly: true, tags: ["vip"], excludeTags: [], hasOrdered: true|false|null, lastOrderOlderThanDays, lastSeenWithinDays,
 *   retarget: { campaignId, status: "not_read"|"read"|"not_replied"|"replied"|"failed" }, waIds: [] }
 */
export function resolveAudience(tenantId, a = {}) {
  const d = getDb();
  if (Array.isArray(a.waIds) && a.waIds.length) return [...new Set(a.waIds.map((w) => String(w).replace(/\D/g, '')).filter(Boolean))];
  const where = ['c.tenant_id = ?'];
  const args = [tenantId];
  // Marketing needs recorded consent (ledger), not just a flag. optedInOnly:false is only for utility templates.
  if (a.optedInOnly !== false) where.push(`c.opted_in_marketing = 1 AND ${HAS_CONSENT_SQL}`);
  if (a.hasOrdered === true) where.push("EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = c.tenant_id AND o.wa_id = c.wa_id AND o.status != 'cancelled')");
  if (a.hasOrdered === false) where.push("NOT EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = c.tenant_id AND o.wa_id = c.wa_id AND o.status != 'cancelled')");
  if (Number(a.lastOrderOlderThanDays) > 0) {
    where.push("NOT EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = c.tenant_id AND o.wa_id = c.wa_id AND o.created_at > datetime('now', ?))");
    args.push(`-${Number(a.lastOrderOlderThanDays)} days`);
  }
  if (Number(a.lastSeenWithinDays) > 0) {
    where.push("c.last_seen_at > datetime('now', ?)");
    args.push(`-${Number(a.lastSeenWithinDays)} days`);
  }
  if (a.retarget?.campaignId) {
    const st = a.retarget.status || 'not_read';
    const cond = { not_read: "ms.status NOT IN ('read')", read: "ms.status = 'read'", not_replied: 'ms.replied = 0', replied: 'ms.replied = 1', failed: "ms.status = 'failed'" }[st] || "ms.status != 'read'";
    where.push(`EXISTS (SELECT 1 FROM message_status ms WHERE ms.tenant_id = c.tenant_id AND ms.wa_id = c.wa_id AND ms.campaign_id = ? AND ${cond})`);
    args.push(Number(a.retarget.campaignId));
  }
  let rows = d.prepare(`SELECT c.wa_id, c.tags FROM customers c WHERE ${where.join(' AND ')}`).all(...args);
  const want = (a.tags || []).map((t) => String(t).toLowerCase());
  const exclude = (a.excludeTags || []).map((t) => String(t).toLowerCase());
  rows = rows.filter((r) => {
    const tags = json(r.tags, []);
    return (!want.length || want.some((t) => tags.includes(t))) && !exclude.some((t) => tags.includes(t));
  });
  return rows.map((r) => r.wa_id);
}

const mapCampaign = (r) => r && { ...r, audience: json(r.audience, {}), components: json(r.components, null) };

export function createCampaign(tenantId, { name, template, language = 'en_GB', components, audience = {}, scheduledAt }) {
  const when = scheduledAt ? new Date(scheduledAt) : new Date();
  if (Number.isNaN(when.getTime())) throw new Error('invalid scheduledAt');
  if (when.getTime() > Date.now() + 62 * 864e5) throw new Error('campaigns can be scheduled up to 2 months ahead');
  const iso = when.toISOString().replace('T', ' ').slice(0, 19);
  const info = getDb()
    .prepare('INSERT INTO campaigns (tenant_id, name, template, language, components, audience, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tenantId, String(name || template).slice(0, 100), template, language, components ? JSON.stringify(components) : null, JSON.stringify(audience), iso);
  const id = Number(info.lastInsertRowid);
  schedule(tenantId, 'campaign', { campaignId: id }, Math.max(0, (when.getTime() - Date.now()) / 60000));
  return getCampaign(tenantId, id);
}

export const getCampaign = (tenantId, id) => mapCampaign(getDb().prepare('SELECT * FROM campaigns WHERE tenant_id = ? AND id = ?').get(tenantId, Number(id)));

export function listCampaigns(tenantId) {
  return getDb().prepare('SELECT * FROM campaigns WHERE tenant_id = ? ORDER BY id DESC LIMIT 100').all(tenantId).map((c) => ({ ...mapCampaign(c), stats: campaignStats(tenantId, c.id) }));
}

export function cancelCampaign(tenantId, id) {
  return getDb().prepare("UPDATE campaigns SET status = 'cancelled' WHERE tenant_id = ? AND id = ? AND status = 'scheduled'").run(tenantId, Number(id)).changes > 0;
}

export function campaignStats(tenantId, id) {
  const r = getDb().prepare(`SELECT COUNT(*) AS total,
      SUM(status IN ('sent','delivered','read')) AS sent, SUM(status IN ('delivered','read')) AS delivered, SUM(status = 'read') AS read,
      SUM(status = 'failed') AS failed, SUM(replied) AS replied FROM message_status WHERE tenant_id = ? AND campaign_id = ?`).get(tenantId, Number(id));
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v || 0]));
}

/** Executes a scheduled campaign (called by the job runner). */
export async function runCampaign(tenant, campaignId, { delayMs = 60 } = {}) {
  const c = getCampaign(tenant.id, campaignId);
  if (!c || c.status !== 'scheduled') return null;
  getDb().prepare("UPDATE campaigns SET status = 'sending' WHERE id = ?").run(c.id);
  const recipients = resolveAudience(tenant.id, c.audience);
  const send = createSender(tenant);
  let sent = 0, failed = 0;
  const nameOf = getDb().prepare('SELECT name FROM customers WHERE tenant_id = ? AND wa_id = ?');
  for (const to of recipients) {
    try {
      // per-recipient personalisation: {{name}} in variables → contact's first name
      const first = (nameOf.get(tenant.id, to)?.name || '').split(' ')[0] || 'there';
      const components = c.components ? JSON.parse(JSON.stringify(c.components).replace(/\{\{name\}\}/g, first.replace(/["\\]/g, ''))) : undefined;
      const res = await send(to, { type: 'template', name: c.template, language: c.language, components });
      const mid = res?.messages?.[0]?.id;
      if (mid) getDb().prepare("INSERT OR REPLACE INTO message_status (tenant_id, wa_message_id, wa_id, campaign_id, status) VALUES (?, ?, ?, ?, 'sent')").run(tenant.id, mid, to, c.id);
      sent++;
    } catch (e) {
      failed++;
      getDb().prepare("INSERT OR REPLACE INTO message_status (tenant_id, wa_message_id, wa_id, campaign_id, status, error) VALUES (?, ?, ?, ?, 'failed', ?)").run(tenant.id, `failed-${c.id}-${to}`, to, c.id, String(e.message).slice(0, 300));
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  getDb().prepare("UPDATE campaigns SET status = 'sent', sent = ?, failed = ? WHERE id = ?").run(sent, failed, c.id);
  return { recipients: recipients.length, sent, failed };
}

const RANK = { sent: 1, delivered: 2, read: 3 };

/** Webhook "statuses" → delivery/read tracking. */
export function recordStatus(tenantId, s) {
  const row = getDb().prepare('SELECT status FROM message_status WHERE tenant_id = ? AND wa_message_id = ?').get(tenantId, s.id);
  if (!row) return;
  if (s.status === 'failed') {
    getDb().prepare("UPDATE message_status SET status = 'failed', error = ?, updated_at = datetime('now') WHERE tenant_id = ? AND wa_message_id = ?").run(JSON.stringify(s.errors || []).slice(0, 300), tenantId, s.id);
  } else if ((RANK[s.status] || 0) > (RANK[row.status] || 0)) {
    getDb().prepare("UPDATE message_status SET status = ?, updated_at = datetime('now') WHERE tenant_id = ? AND wa_message_id = ?").run(s.status, tenantId, s.id);
  }
}

/** Inbound message from a contact → mark their latest campaign message (last 3 days) as replied. */
export function recordReply(tenantId, waId, { isButton } = {}) {
  getDb().prepare(`UPDATE message_status SET replied = 1, clicked = clicked + ?, status = CASE WHEN status = 'failed' THEN status ELSE 'read' END
     WHERE rowid = (SELECT rowid FROM message_status WHERE tenant_id = ? AND wa_id = ? AND campaign_id IS NOT NULL AND updated_at > datetime('now', '-3 days') ORDER BY updated_at DESC LIMIT 1)`).run(isButton ? 1 : 0, tenantId, waId);
}
