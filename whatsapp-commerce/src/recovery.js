import crypto from 'node:crypto';
import express from 'express';
import { getDb, json } from './db.js';
import { config } from './config.js';
import { getTenant } from './tenants.js';
import { sendEmail, emailConfigured } from './email.js';
import { audit } from './privacy.js';
import { rateLimit } from './routes/web.js';

/*
 * Lost admin key (R0.13): the owner types the email they signed up with and gets a one-time link.
 *  - The answer is the same whether or not the email is known (nobody can find out who has an account).
 *  - The link works once, for 30 minutes; only a hash of it is stored.
 *  - Opening the link shows a button – the key is only changed when the owner presses it (so email link scanners
 *    that "visit" links can't use it up). Pressing it makes a NEW admin key, shown once; the old key stops working.
 *    The Dify tool key and staff keys are not touched.
 *  - The owner gets a second email saying the key was changed (in case it wasn't them), and it's in the audit log.
 *  - Only the sign-up email (owner_email) can recover – not alert addresses, which may belong to staff.
 * Needs email to be set up on the server (Resend); until then the page says so and the platform operator can reset
 * a key from the super admin dashboard.
 */
const TTL_MS = 30 * 60000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(String(s || '').trim());
const kvSet = (k, v) => getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function requestRecovery(email, { ip = null } = {}) {
  const addr = String(email || '').trim().toLowerCase();
  if (!isEmail(addr)) return { ok: true }; // same answer as always
  const rows = getDb().prepare('SELECT id FROM tenants WHERE lower(owner_email) = ? AND active = 1').all(addr);
  for (const r of rows.slice(0, 5)) {
    const t = getTenant(r.id);
    const token = crypto.randomBytes(24).toString('base64url');
    kvSet(`recover:${sha(token)}`, { tenantId: t.id, exp: Date.now() + TTL_MS });
    const link = `${config.publicUrl}/recover/${token}`;
    // sent in the background: the reply takes the same time whether or not the email is known
    sendEmail({ tenantId: t.id, topic: 'key_recovery', to: addr, subject: `Sign in to ${t.settings.business?.name || t.name}`, text: `Someone (hopefully you) asked to get back into the dashboard for ${t.settings.business?.name || t.name}.\n\nOpen this link within 30 minutes and press the button to get a new admin key:\n${link}\n\nIf it wasn't you, ignore this email – nothing changes unless the button is pressed.` }).catch(() => {});
    audit({ tenantId: t.id, actor: 'owner (email link)', role: 'owner', action: 'key.recovery_requested', ip });
  }
  return { ok: true };
}

function take(token, { consume = false } = {}) {
  const k = `recover:${sha(token)}`;
  const v = json(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value, null);
  if (!v || v.exp < Date.now()) { if (v) getDb().prepare('DELETE FROM kv WHERE key = ?').run(k); return null; }
  if (consume) getDb().prepare('DELETE FROM kv WHERE key = ?').run(k);
  return v;
}

/** Make a new admin key for the business behind this link (once). */
export async function completeRecovery(token, { ip = null } = {}) {
  const v = take(token, { consume: true });
  if (!v) return null;
  const t = getTenant(v.tenantId);
  if (!t) return null;
  const adminKey = 'adm_' + crypto.randomBytes(24).toString('base64url');
  getDb().prepare('UPDATE tenants SET admin_key_hash = ? WHERE id = ?').run(sha(adminKey), t.id);
  audit({ tenantId: t.id, actor: 'owner (email link)', role: 'owner', action: 'key.recovered', ip });
  const owner = getDb().prepare('SELECT owner_email FROM tenants WHERE id = ?').get(t.id)?.owner_email;
  if (isEmail(owner)) sendEmail({ tenantId: t.id, topic: 'key_changed', to: owner, subject: 'Your dashboard key was changed', text: `The admin key for ${t.settings.business?.name || t.name} was just changed using a sign-in link sent to this address. The old key no longer works.\n\nIf this wasn't you, reply to this email straight away.` }).catch(() => {});
  return { tenantId: t.id, name: t.settings.business?.name || t.name, adminKey };
}

export function recoveryRouter() {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 3600000, max: 5 }); // asking for a link
  const useLimiter = rateLimit({ windowMs: 3600000, max: 10 }); // using one
  const page = (title, body) => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f8f7;color:#14201a;margin:0;padding:16px}.c{max-width:460px;margin:40px auto;background:#fff;border:1px solid #dde4e0;border-radius:12px;padding:20px}button,.b{background:#128c4a;color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}code{display:block;word-break:break-all;background:#f0f3f1;padding:10px;border-radius:8px;font-size:15px}.m{color:#56645c}@media (prefers-color-scheme:dark){body{background:#0e1411;color:#e8f0ea}.c{background:#16201a;border-color:#28352d}code{background:#0e1411}.m{color:#9cada3}}</style></head><body><div class="c">${body}</div></body></html>`;
  r.post('/recover', limiter, express.json({ limit: '2kb' }), express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
    await requestRecovery(req.body?.email, { ip: req.ip });
    res.json({ ok: true, emailConfigured: emailConfigured(), message: emailConfigured() ? "If that email belongs to a business here, we've sent a sign-in link to it. It works once, for 30 minutes." : "Email isn't set up on this server yet, so we can't send a link. Please contact support to reset your key." });
  });
  r.get('/recover/:token', (req, res) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    const v = take(req.params.token);
    if (!v) return res.status(410).type('html').send(page('Link expired', '<h2>This link has expired or been used</h2><p class="m">Sign-in links work once, for 30 minutes. Ask for a new one from the sign-in page.</p><p><a class="b" href="/admin/">Go to sign in</a></p>'));
    const t = getTenant(v.tenantId);
    res.type('html').send(page('Get a new key', `<h2>Get a new admin key</h2><p>For <b>${esc(t?.settings.business?.name || t?.name || '')}</b>.</p><p class="m">Pressing the button makes a new key and shows it once. Your old key stops working straight away.</p><form method="post"><button type="submit">Make my new key</button></form>`));
  });
  r.post('/recover/:token', useLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    const out = await completeRecovery(req.params.token, { ip: req.ip });
    if (!out) return res.status(410).type('html').send(page('Link expired', '<h2>This link has expired or been used</h2><p><a class="b" href="/admin/">Go to sign in</a></p>'));
    res.type('html').send(page('Your new key', `<h2>✅ Your new admin key</h2><p>For <b>${esc(out.name)}</b>. Copy it now and keep it somewhere safe (a password manager is ideal) – it won't be shown again.</p><code id="k">${esc(out.adminKey)}</code><p><a class="b" href="/admin/">Sign in</a></p>`));
  });
  return r;
}
