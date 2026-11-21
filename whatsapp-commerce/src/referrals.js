import crypto from 'node:crypto';
import { getDb, json } from './db.js';
import { config } from './config.js';
import { PLANS } from './tenants.js';

/*
 * Refer-a-business and partners (web agencies, consultants): a referral link, sign-ups credited to whoever sent
 * them, and the commission they've earned – a share of each referred business's monthly plan while it pays.
 *  - Every business has its own code (Billing tab → "Refer a business"). The "Powered by" link in Free plan chats
 *    credits that business too.
 *  - Partners (no shop of their own) get a code from the platform owner.
 * Terms: config.referralPercent (default 20%) of the plan price; paying = an active subscription. Payouts are made
 * by the platform owner (bank transfer) – this module only keeps the numbers.
 */
export const REF = /^[A-Za-z0-9_-]{3,60}$/;
const percent = () => Math.max(0, Math.min(100, Number(config.referralPercent ?? 20)));

export function referralCode(tenantId) {
  const d = getDb();
  const have = d.prepare('SELECT referral_code FROM tenants WHERE id = ?').get(tenantId)?.referral_code;
  if (have) return have;
  let code;
  do code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, 'x').slice(0, 7).toLowerCase(); while (d.prepare('SELECT 1 FROM tenants WHERE referral_code = ?').get(code));
  d.prepare('UPDATE tenants SET referral_code = ? WHERE id = ?').run(code, tenantId);
  return code;
}

/** Who a ref code belongs to: "tenant:<id>" or "partner:<CODE>", or null. */
export function resolveRef(ref) {
  const r = String(ref || '').trim();
  if (!REF.test(r)) return null;
  const d = getDb();
  if (r.startsWith('chat-')) { const id = r.slice(5); return d.prepare('SELECT 1 FROM tenants WHERE id = ?').get(id) ? `tenant:${id}` : null; } // the "Powered by" link
  const t = d.prepare('SELECT id FROM tenants WHERE referral_code = ?').get(r.toLowerCase());
  if (t) return `tenant:${t.id}`;
  if (json(d.prepare('SELECT value FROM kv WHERE key = ?').get(`partner:${r.toUpperCase()}`)?.value, null)) return `partner:${r.toUpperCase()}`;
  return null;
}

/** Credit a new sign-up (never to itself; only once). */
export function creditSignup(newTenantId, ref) {
  const by = resolveRef(ref);
  if (!by || by === `tenant:${newTenantId}`) return null;
  getDb().prepare('UPDATE tenants SET referred_by = COALESCE(referred_by, ?) WHERE id = ?').run(by, newTenantId);
  return by;
}

function summary(by) {
  const rows = getDb().prepare('SELECT id, name, plan, subscription_status, created_at FROM tenants WHERE referred_by = ? ORDER BY created_at DESC').all(by);
  const paying = rows.filter((r) => r.subscription_status === 'active');
  const monthly = Math.round(paying.reduce((s, r) => s + (PLANS[r.plan]?.priceGbp || 0) * percent() / 100, 0) * 100) / 100;
  return { percent: percent(), signups: rows.length, paying: paying.length, monthlyEarnings: monthly, referred: rows.map((r) => ({ name: r.name, plan: PLANS[r.plan]?.label || r.plan, status: r.subscription_status || 'none', since: r.created_at.slice(0, 10) })) };
}
export function tenantReferrals(tenantId) {
  const code = referralCode(tenantId);
  return { code, link: `${config.publicUrl}/?ref=${code}`, ...summary(`tenant:${tenantId}`) };
}

export function createPartner({ name, email, code }) {
  const c = String(code || name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || crypto.randomBytes(4).toString('hex').toUpperCase();
  if (!String(name || '').trim()) throw Object.assign(new Error('Partner name needed'), { status: 400 });
  const d = getDb();
  if (d.prepare('SELECT 1 FROM kv WHERE key = ?').get(`partner:${c}`)) throw Object.assign(new Error('That code is taken'), { status: 400 });
  d.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(`partner:${c}`, JSON.stringify({ name: String(name).slice(0, 80), email: String(email || '').slice(0, 200), at: new Date().toISOString() }));
  return { code: c, link: `${config.publicUrl}/?ref=${c}` };
}
export function allReferrals() {
  const d = getDb();
  const partners = d.prepare("SELECT key, value FROM kv WHERE key LIKE 'partner:%'").all().map((r) => ({ code: r.key.slice(8), ...json(r.value, {}), link: `${config.publicUrl}/?ref=${r.key.slice(8)}`, ...summary(r.key) }));
  const byTenant = d.prepare("SELECT DISTINCT referred_by FROM tenants WHERE referred_by LIKE 'tenant:%'").all().map((r) => { const id = r.referred_by.slice(7); return { referrer: d.prepare('SELECT name FROM tenants WHERE id = ?').get(id)?.name || id, tenantId: id, ...summary(r.referred_by) }; });
  return { percent: percent(), partners, businesses: byTenant };
}
