import { config } from './config.js';
import { getDb } from './db.js';
import { alert } from './ops.js';

/*
 * Email alerts to shop owners (new orders, paid orders, "customer wants a person", plan limits).
 * Sent through Resend's HTTP API (resend.com). The key and the "from" address are entered in the
 * super admin Setup tab. Without them, nothing is sent and nothing breaks.
 */
export const emailConfigured = () => !!(config.resendApiKey && config.emailFrom);

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(s || '').trim());

/** Who gets a shop's alert emails: the list in Settings, or the sign-up email when that list is empty. */
export function alertEmails(tenant) {
  const list = (tenant.settings?.notifications?.alertEmails || []).map((e) => String(e).trim()).filter(isEmail).slice(0, 5);
  if (list.length) return list;
  const owner = getDb().prepare('SELECT owner_email FROM tenants WHERE id = ?').get(tenant.id)?.owner_email;
  return isEmail(owner) ? [owner] : [];
}

/*
 * Every email is recorded in email_log (who, what, status, error) so nothing is dropped silently:
 *  - sent: the provider accepted it (provider_id kept);
 *  - retrying: a temporary problem (network, rate limit, provider down) – tried again after 1, 5, 30, 120, 360 min;
 *  - failed: a permanent problem (bad address, rejected) or out of retries – the platform owner is alerted;
 *  - skipped: email isn't set up on this server (visible in System health, so it can be fixed).
 * kind: 'transactional' (orders, bookings, quotes, alerts), 'marketing' (needs consent) or 'system' (platform mail).
 * Message bodies are kept 30 days (for retries and checks), the record itself 180 days (purgeEmailLog).
 */
export const EMAIL_RETRY_MINUTES = [1, 5, 30, 120, 360];
const KINDS = ['transactional', 'marketing', 'system'];
const retryable = (status) => !status || status === 408 || status === 429 || status >= 500;

async function deliver(row) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `wc-email-${row.id}` },
      body: JSON.stringify({ from: config.emailFrom, to: row.to_addr.split(', '), subject: row.subject, text: row.body_text || undefined, html: row.body_html || undefined, ...(row.reply_to ? { reply_to: row.reply_to } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: data.message || data.error?.message || `Email provider said ${res.status}` };
    return { ok: true, id: data.id };
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
}

/** Try (again) to deliver one recorded email and update its record. */
export async function attemptEmail(logId) {
  const d = getDb();
  const row = d.prepare('SELECT * FROM email_log WHERE id = ?').get(logId);
  if (!row || row.status === 'sent') return { ok: !!row, id: row?.provider_id, logId };
  if (!emailConfigured()) {
    d.prepare("UPDATE email_log SET status = 'skipped', error = 'Email is not set up on this server', next_try_at = NULL, updated_at = datetime('now') WHERE id = ?").run(logId);
    return { ok: false, skipped: true, error: 'Email is not set up on this server', logId };
  }
  const r = await deliver(row);
  const attempts = row.attempts + 1;
  if (r.ok) {
    d.prepare("UPDATE email_log SET status = 'sent', attempts = ?, provider_id = ?, error = NULL, next_try_at = NULL, updated_at = datetime('now') WHERE id = ?").run(attempts, r.id || null, logId);
    return { ok: true, id: r.id, logId };
  }
  if (retryable(r.status) && attempts <= EMAIL_RETRY_MINUTES.length) {
    d.prepare("UPDATE email_log SET status = 'retrying', attempts = ?, error = ?, next_try_at = datetime('now', ?), updated_at = datetime('now') WHERE id = ?").run(attempts, String(r.error).slice(0, 500), `+${EMAIL_RETRY_MINUTES[attempts - 1]} minutes`, logId);
    return { ok: false, retrying: true, error: r.error, logId };
  }
  d.prepare("UPDATE email_log SET status = 'failed', attempts = ?, error = ?, next_try_at = NULL, updated_at = datetime('now') WHERE id = ?").run(attempts, String(r.error).slice(0, 500), logId);
  alert(`Email not delivered (${row.topic || row.kind}, #${logId}): ${r.error}`, { key: 'email-failed' });
  return { ok: false, failed: true, error: r.error, logId };
}

export async function sendEmail({ to, subject, text, html, replyTo, tenantId = null, topic = null, kind = 'transactional' }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(isEmail);
  const d = getDb();
  const rec = (status, error, bodies = false) => Number(d.prepare('INSERT INTO email_log (tenant_id, kind, topic, to_addr, subject, body_text, body_html, reply_to, status, error, next_try_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
    tenantId, KINDS.includes(kind) ? kind : 'transactional', topic ? String(topic).slice(0, 40) : null, (recipients.join(', ') || String(Array.isArray(to) ? to.join(', ') : to ?? '')).slice(0, 500), String(subject ?? '').slice(0, 200),
    bodies ? (text == null ? null : String(text)) : null, bodies ? (html == null ? null : String(html)) : null, bodies && replyTo && isEmail(replyTo) ? replyTo : null, status, error).lastInsertRowid);
  if (!emailConfigured()) { const logId = rec('skipped', 'Email is not set up on this server'); return { ok: false, skipped: true, error: 'Email is not set up on this server', logId }; }
  if (!recipients.length) { const logId = rec('failed', 'No valid email address'); return { ok: false, error: 'No valid email address', logId }; }
  return attemptEmail(rec('queued', null, true));
}

/** Background job: emails waiting for another try. */
export async function runEmailRetries(limit = 25) {
  const rows = getDb().prepare("SELECT id FROM email_log WHERE status = 'retrying' AND next_try_at <= datetime('now') ORDER BY next_try_at LIMIT ?").all(limit);
  let sent = 0;
  for (const r of rows) if ((await attemptEmail(r.id)).ok) sent++;
  return sent;
}

/** Bodies kept 30 days, records 180 days. */
export function purgeEmailLog() {
  const d = getDb();
  const cleared = Number(d.prepare("UPDATE email_log SET body_text = NULL, body_html = NULL WHERE (body_text IS NOT NULL OR body_html IS NOT NULL) AND status IN ('sent', 'failed', 'skipped') AND created_at < datetime('now', '-30 days')").run().changes);
  const deleted = Number(d.prepare("DELETE FROM email_log WHERE created_at < datetime('now', '-180 days')").run().changes);
  return { cleared, deleted };
}

/** Delivery records (no message bodies). tenantId = one business; omit for the whole platform (super admin). */
export function emailLog({ tenantId, status, limit = 100 } = {}) {
  const where = [], args = [];
  if (tenantId !== undefined) { where.push('tenant_id = ?'); args.push(tenantId); }
  if (status) { where.push('status = ?'); args.push(status); }
  return getDb().prepare(`SELECT id, tenant_id, kind, topic, to_addr, subject, status, attempts, error, next_try_at, created_at, updated_at FROM email_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(500, Number(limit) || 100));
}

/** Last 7 days by status – for System health. */
export function emailStats() {
  const rows = getDb().prepare("SELECT status, COUNT(*) AS n FROM email_log WHERE created_at > datetime('now', '-7 days') GROUP BY status").all();
  return Object.fromEntries(['sent', 'retrying', 'failed', 'skipped', 'queued'].map((s) => [s, Number(rows.find((r) => r.status === s)?.n || 0)]));
}

/** Super admin: put a failed / skipped email back in the queue and try now. */
export async function retryEmail(logId) {
  const d = getDb();
  const row = d.prepare('SELECT status, body_text, body_html FROM email_log WHERE id = ?').get(Number(logId));
  if (!row) throw Object.assign(new Error('Email not found'), { status: 404 });
  if (row.status === 'sent') return { ok: true, already: true };
  if (row.body_text == null && row.body_html == null) throw Object.assign(new Error('This email was never stored (email was not set up when it was due) or is too old to resend'), { status: 400 });
  d.prepare("UPDATE email_log SET status = 'queued', attempts = 0, next_try_at = NULL WHERE id = ?").run(Number(logId));
  return attemptEmail(Number(logId));
}

/** A short, plain alert email to the shop, with a button to the dashboard. `text` may use *bold* like WhatsApp. */
export async function emailShop(tenant, subject, text, { button = 'Open your dashboard', path = '/admin/', topic = 'alert' } = {}) {
  const to = alertEmails(tenant);
  if (!to.length) return { ok: false, skipped: true, error: 'No alert email address for this business' };
  const plain = String(text).replace(/\*/g, '');
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#17201b;max-width:560px">
    <p style="color:#5d6b63;margin:0 0 12px">${escHtml(tenant.settings.business?.name || tenant.name)}</p>
    <div style="white-space:pre-wrap;background:#f5f7f6;border:1px solid #dfe5e1;border-radius:10px;padding:14px">${escHtml(String(text)).replace(/\*([^*\n]+)\*/g, '<b>$1</b>')}</div>
    <p style="margin:18px 0"><a href="${escHtml(config.publicUrl + path)}" style="background:#128c4a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;display:inline-block">${escHtml(button)}</a></p>
    <p style="color:#5d6b63;font-size:12px">You get these emails because this address is set for order alerts. Change it in your dashboard under Settings → Notifications.</p></div>`;
  const r = await sendEmail({ to, subject, text: `${plain}\n\n${button}: ${config.publicUrl}${path}`, html, replyTo: config.supportEmail, tenantId: tenant.id, topic });
  if (!r.ok && !r.skipped) console.warn('[email]', tenant.id, r.error);
  return r;
}
