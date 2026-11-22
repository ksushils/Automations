import { getDb, json } from './db.js';
import { getTenant, listTenants, PLANS } from './tenants.js';
import { numberHealth } from './templates.js';
import { emailShop } from './email.js';
import { alert } from './ops.js';
import { config } from './config.js';

/*
 * WhatsApp connection health. Once a day per business (and on demand) we ask Meta about the connected number and
 * turn the answer into one plain state, so problems are found before customers notice:
 *   ok · not_connected · token_invalid (expired / revoked access) · disconnected (number not connected / flagged /
 *   restricted / banned) · approval_pending (display name in review) · name_declined · quality_low (RED rating) ·
 *   check_failed (Meta unreachable – not treated as a problem until it repeats).
 * A change into a problem state emails the owner and alerts the platform owner; a recovery emails "back to normal".
 * Expiry warning (R0.10): when the number is fine, we also ask Meta when the access token (or its data access) ends –
 * permanent System User tokens never do; tokens from a personal login do. Within 7 days the state becomes
 * token_expiring: a dashboard banner and ONE email per expiry date, so the owner can reconnect before replies stop.
 */
export const EXPIRY_WARN_DAYS = 7;
export const BAD = ['token_invalid', 'disconnected', 'name_declined', 'quality_low'];
const LABEL = {
  ok: 'Connected and working',
  not_connected: 'WhatsApp is not connected yet',
  token_invalid: 'WhatsApp access has expired or was removed – reconnect WhatsApp in Settings',
  disconnected: 'Meta reports your number is not connected (or is restricted)',
  approval_pending: 'Meta is still reviewing your WhatsApp display name – messages work, but the name may show as your number',
  name_declined: 'Meta declined your WhatsApp display name – choose a new one in WhatsApp Manager',
  quality_low: 'Meta rates your message quality as low – sending limits may drop. Send fewer promotional messages',
  check_failed: 'Could not reach Meta to check the connection',
  token_expiring: 'WhatsApp access ends soon – reconnect WhatsApp in Settings before then, or customers stop getting replies',
};

/** Turn Meta's answer (or error) into { state, detail }. Pure – tested directly. */
export function classify(health, error) {
  if (error) {
    const m = String(error.message || error);
    if (/not connected/i.test(m)) return { state: 'not_connected', detail: LABEL.not_connected };
    if (/access token|session has expired|oauth|permission|code 190|\b190\b/i.test(m)) return { state: 'token_invalid', detail: `${LABEL.token_invalid} (${m.slice(0, 160)})` };
    return { state: 'check_failed', detail: `${LABEL.check_failed}: ${m.slice(0, 160)}` };
  }
  const h = health || {};
  const status = String(h.status || '').toUpperCase();
  if (status && !['CONNECTED', 'MIGRATED'].includes(status)) return { state: 'disconnected', detail: `${LABEL.disconnected} (status: ${status})` };
  const name = String(h.name_status || '').toUpperCase();
  if (name === 'DECLINED') return { state: 'name_declined', detail: LABEL.name_declined };
  if (String(h.quality_rating || '').toUpperCase() === 'RED') return { state: 'quality_low', detail: LABEL.quality_low };
  if (['PENDING_REVIEW', 'PENDING'].includes(name)) return { state: 'approval_pending', detail: LABEL.approval_pending };
  return { state: 'ok', detail: `${LABEL.ok}${h.display_phone_number ? ` (${h.display_phone_number}${h.verified_name ? `, ${h.verified_name}` : ''})` : ''}`, quality: h.quality_rating || null, tier: h.messaging_limit_tier || null };
}

/** When the token (or its data access) ends: { expiresAt, dataAccessExpiresAt } as ISO or null (= never). null if unknown. */
export async function tokenExpiry(tenant) {
  const tok = tenant.settings.whatsapp?.accessToken;
  if (!tok) return null;
  const r = await fetch(`https://graph.facebook.com/${config.graphVersion}/debug_token?input_token=${encodeURIComponent(tok)}&access_token=${encodeURIComponent(tok)}`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  const d = j?.data;
  if (!r.ok || !d || typeof d !== 'object' || (d.expires_at === undefined && d.data_access_expires_at === undefined)) return null;
  const iso = (sec) => (Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : null);
  return { expiresAt: iso(d.expires_at), dataAccessExpiresAt: iso(d.data_access_expires_at) };
}
/** Pure: is the soonest end within the warning window? Returns { ends, days } or null. */
export function expirySoon(exp, now = Date.now()) {
  const ends = [exp?.expiresAt, exp?.dataAccessExpiresAt].filter(Boolean).map((x) => Date.parse(x)).filter((x) => x > now).sort((a, b) => a - b)[0];
  if (!ends) return null;
  const days = (ends - now) / 864e5;
  return days <= EXPIRY_WARN_DAYS ? { ends: new Date(ends).toISOString(), days: Math.max(0, Math.ceil(days)) } : null;
}
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });

const key = (tid) => `wahealth:${tid}`;
export const connectionStatus = (tenantId) => json(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key(tenantId))?.value, null);

export async function checkConnection(tenant) {
  const W = tenant.settings.whatsapp || {};
  let r;
  if (!W.phoneNumberId || !W.accessToken) r = { state: 'not_connected', detail: LABEL.not_connected };
  else {
    try { r = classify(await numberHealth(tenant)); } catch (e) { r = classify(null, e); }
    if (r.state === 'ok') {
      const exp = await tokenExpiry(tenant).catch(() => null);
      if (exp) r.tokenExpiresAt = exp.expiresAt || exp.dataAccessExpiresAt || null; // null = never
      const soon = expirySoon(exp);
      if (soon) r = { ...r, state: 'token_expiring', detail: `WhatsApp access ends on ${day(soon.ends)} (in ${soon.days} day${soon.days === 1 ? '' : 's'}) – reconnect WhatsApp in Settings before then, or customers stop getting replies.`, expiresOn: soon.ends };
    }
  }
  const prev = connectionStatus(tenant.id);
  // one failed call to Meta isn't a problem; keep the previous state but count it
  if (r.state === 'check_failed' && prev && prev.state !== 'check_failed') {
    const fails = (prev.checkFails || 0) + 1;
    const keep = { ...prev, checkFails: fails, lastCheckError: r.detail, checkedAt: new Date().toISOString() };
    if (fails < 3) { save(tenant.id, keep); return keep; }
  }
  const now = new Date().toISOString();
  const next = { ...r, checkedAt: now, since: prev?.state === r.state ? prev.since : now, checkFails: 0, warnedFor: prev?.warnedFor || null };
  if (r.state === 'token_expiring' && prev?.warnedFor !== r.expiresOn) {
    next.warnedFor = r.expiresOn; // one email per expiry date
    emailShop(tenant, 'Your WhatsApp connection needs renewing soon', `${r.detail}\n\nReconnecting takes a minute: Settings → WhatsApp → Connect again. Your website chat isn't affected.`, { button: 'Open Settings', topic: 'whatsapp_health' }).catch(() => {});
    alert(`WhatsApp token for ${tenant.name} (${tenant.id}) ends ${r.expiresOn}`, { key: `wahealth:${tenant.id}:expiring:${r.expiresOn}` });
  }
  save(tenant.id, next);
  const wasBad = prev && BAD.includes(prev.state);
  const isBad = BAD.includes(r.state);
  if (isBad && (!prev || prev.state !== r.state)) {
    emailShop(tenant, 'Action needed: your WhatsApp connection', `${r.detail}\n\nUntil this is fixed, customers may not get replies on WhatsApp. Your website chat keeps working.`, { button: 'Open Settings', topic: 'whatsapp_health' }).catch(() => {});
    alert(`WhatsApp problem for ${tenant.name} (${tenant.id}): ${r.state}`, { key: `wahealth:${tenant.id}:${r.state}` });
  } else if (wasBad && r.state === 'ok') {
    emailShop(tenant, 'Your WhatsApp connection is working again', r.detail, { topic: 'whatsapp_health' }).catch(() => {});
  }
  return next;
}
function save(tid, v) {
  getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key(tid), JSON.stringify(v));
}

/** Background job: each connected, active business checked at most once a day (a few per run, so Meta isn't flooded). */
export async function runConnectionChecks({ perRun = 20, now = Date.now() } = {}) {
  let n = 0;
  for (const t of listTenants()) {
    if (n >= perRun) break;
    const full = getTenant(t.id);
    if (!full?.active || PLANS[full.plan]?.whatsapp === false) continue;
    const W = full.settings.whatsapp || {};
    if (!W.phoneNumberId || !W.accessToken) continue;
    const last = connectionStatus(full.id);
    if (last?.checkedAt && now - Date.parse(last.checkedAt) < 23 * 3600000) continue;
    await checkConnection(full);
    n++;
  }
  return n;
}

/** Dashboard banner when the connection has a problem (shown when there's no billing banner). */
export function connectionBanner(tenantId) {
  const s = connectionStatus(tenantId);
  if (!s) return null;
  if (BAD.includes(s.state)) return { level: 'warn', text: `WhatsApp: ${s.detail}` };
  if (s.state === 'approval_pending') return { level: 'info', text: `WhatsApp: ${s.detail}` };
  if (s.state === 'token_expiring') return { level: 'warn', text: `WhatsApp: ${s.detail}` };
  return null;
}
