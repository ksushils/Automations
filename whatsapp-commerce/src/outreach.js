import { getDb, json } from './db.js';

/*
 * Guard rails for AUTOMATIC messages to customers (abandoned carts, payment reminders, quote follow-ups, review
 * requests, win-back…). Replies to a customer who just wrote are not affected – only messages we start ourselves.
 *  - one log of every automatic message: sent, skipped (and why) or failed (automation_log, kept 180 days);
 *  - per customer: at most settings.followUps.maxPerDay automatic messages in 24 hours (default 2);
 *  - quiet hours in the business's time zone (default 21:00–08:00): non-urgent messages wait until morning;
 *  - the same follow-up (kind + reference) is never sent twice;
 *  - settings.followUps.enabled = false switches all optional follow-ups off.
 * Appointment reminders are expected by the customer: they skip quiet hours but still count towards the cap log.
 */
export const KINDS = {
  abandoned_cart: { label: 'Abandoned cart reminder', optional: true },
  payment_reminder: { label: 'Payment reminder', optional: true },
  quote_followup: { label: 'Quote follow-up', optional: true },
  review_request: { label: 'Review request', optional: true },
  win_back: { label: 'Win-back message', optional: true, marketing: true },
  lead_followup: { label: 'Lead follow-up email', optional: true },
  booking_reminder: { label: 'Appointment reminder', optional: false, anyHour: true },
  stock_alert: { label: 'Back-in-stock alert', optional: true },
};

function localHour(tz, now) {
  try { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(new Date(now))); } catch { return new Date(now).getUTCHours(); }
}
export function inQuietHours(settings, now = Date.now()) {
  const F = settings?.followUps || {};
  const start = Number.isFinite(Number(F.quietStart)) ? Number(F.quietStart) : 21;
  const end = Number.isFinite(Number(F.quietEnd)) ? Number(F.quietEnd) : 8;
  if (start === end) return false;
  const h = localHour(settings?.business?.timezone, now);
  return start > end ? h >= start || h < end : h >= start && h < end;
}

export function logOutreach(tenantId, waId, kind, { ref = null, status = 'sent', channel = 'whatsapp', detail = null } = {}) {
  getDb().prepare('INSERT INTO automation_log (tenant_id, wa_id, kind, ref, status, channel, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tenantId, waId || null, kind, ref == null ? null : String(ref), status, channel, detail == null ? null : String(detail).slice(0, 300));
}

/**
 * May we send this automatic message now?  → { ok: true } | { ok: false, reason, retry }
 * retry = true means "not now, try again later" (quiet hours) – nothing is logged, so the job picks it up next time.
 */
export function outreachCheck(tenant, waId, kind, { ref = null, now = Date.now() } = {}) {
  const K = KINDS[kind] || { optional: true };
  const F = tenant.settings?.followUps || {};
  const d = getDb();
  if (K.optional && F.enabled === false) return { ok: false, reason: 'Automatic follow-ups are switched off', retry: false };
  if (ref != null && d.prepare("SELECT 1 FROM automation_log WHERE tenant_id = ? AND kind = ? AND ref = ? AND status = 'sent'").get(tenant.id, kind, String(ref))) return { ok: false, reason: 'Already sent', retry: false, duplicate: true };
  if (!K.anyHour && inQuietHours(tenant.settings, now)) return { ok: false, reason: 'Quiet hours', retry: true };
  if (waId) {
    const max = Math.max(1, Number(F.maxPerDay) || 2);
    const n = d.prepare("SELECT COUNT(*) AS n FROM automation_log WHERE tenant_id = ? AND wa_id = ? AND status = 'sent' AND created_at > datetime(?, 'unixepoch', '-1 day')").get(tenant.id, waId, Math.floor(now / 1000)).n;
    if (n >= max && K.optional) return { ok: false, reason: `Daily limit reached (${max} automatic messages in 24 hours)`, retry: false };
  }
  return { ok: true };
}

/**
 * Wrap one automatic send: check → (log skip | send → log sent / failed).
 * Returns 'retry' (try later, nothing done), 'skipped', 'sent' or 'failed'. `send` may return 'outside_window' etc.
 */
export async function guarded(tenant, waId, kind, ref, send, { channel = 'whatsapp', onDecided } = {}) {
  const c = outreachCheck(tenant, waId, kind, { ref });
  if (!c.ok && c.retry) return 'retry';
  if (onDecided) onDecided(); // e.g. mark the record as handled, so it isn't picked up again
  if (!c.ok) { if (!c.duplicate) logOutreach(tenant.id, waId, kind, { ref, status: 'skipped', channel, detail: c.reason }); return 'skipped'; }
  try {
    const r = await send();
    if (r === 'outside_window' || r === 'no_template') { logOutreach(tenant.id, waId, kind, { ref, status: 'skipped', channel, detail: r === 'outside_window' ? 'Outside the 24-hour WhatsApp window and no approved template' : 'No approved template' }); return 'skipped'; }
    logOutreach(tenant.id, waId, kind, { ref, status: 'sent', channel });
    return 'sent';
  } catch (e) {
    logOutreach(tenant.id, waId, kind, { ref, status: 'failed', channel, detail: e.message });
    console.warn(`[${kind}]`, e.message);
    return 'failed';
  }
}

export function automationLog(tenantId, { waId, limit = 100 } = {}) {
  const names = new Map(getDb().prepare('SELECT wa_id, name FROM customers WHERE tenant_id = ?').all(tenantId).map((r) => [r.wa_id, r.name]));
  return getDb().prepare(`SELECT * FROM automation_log WHERE tenant_id = ? ${waId ? 'AND wa_id = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...[tenantId, waId].filter(Boolean), Math.min(500, Number(limit) || 100))
    .map((r) => ({ id: r.id, waId: r.wa_id, customer: names.get(r.wa_id) || null, kind: r.kind, label: KINDS[r.kind]?.label || r.kind, ref: r.ref, status: r.status, channel: r.channel, detail: r.detail, at: r.created_at.replace(' ', 'T') + 'Z' }));
}

export const purgeAutomationLog = () => Number(getDb().prepare("DELETE FROM automation_log WHERE created_at < datetime('now', '-180 days')").run().changes);
