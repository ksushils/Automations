import { config } from './config.js';
import { getDb } from './db.js';

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

export async function sendEmail({ to, subject, text, html, replyTo }) {
  if (!emailConfigured()) return { ok: false, error: 'Email is not set up on this server' };
  const recipients = (Array.isArray(to) ? to : [to]).filter(isEmail);
  if (!recipients.length) return { ok: false, error: 'No valid email address' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.emailFrom, to: recipients, subject: String(subject).slice(0, 200), text, html, ...(replyTo && isEmail(replyTo) ? { reply_to: replyTo } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || data.error?.message || `Email provider said ${res.status}` };
    return { ok: true, id: data.id };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** A short, plain alert email to the shop, with a button to the dashboard. `text` may use *bold* like WhatsApp. */
export async function emailShop(tenant, subject, text, { button = 'Open your dashboard', path = '/admin/' } = {}) {
  const to = alertEmails(tenant);
  if (!to.length || !emailConfigured()) return { ok: false, skipped: true };
  const plain = String(text).replace(/\*/g, '');
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#17201b;max-width:560px">
    <p style="color:#5d6b63;margin:0 0 12px">${escHtml(tenant.settings.business?.name || tenant.name)}</p>
    <div style="white-space:pre-wrap;background:#f5f7f6;border:1px solid #dfe5e1;border-radius:10px;padding:14px">${escHtml(String(text)).replace(/\*([^*\n]+)\*/g, '<b>$1</b>')}</div>
    <p style="margin:18px 0"><a href="${escHtml(config.publicUrl + path)}" style="background:#128c4a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;display:inline-block">${escHtml(button)}</a></p>
    <p style="color:#5d6b63;font-size:12px">You get these emails because this address is set for order alerts. Change it in your dashboard under Settings → Notifications.</p></div>`;
  const r = await sendEmail({ to, subject, text: `${plain}\n\n${button}: ${config.publicUrl}${path}`, html, replyTo: config.supportEmail });
  if (!r.ok) console.warn('[email]', tenant.id, r.error);
  return r;
}
