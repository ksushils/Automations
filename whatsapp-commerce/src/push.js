import crypto from 'node:crypto';
import { getDb, json } from './db.js';
import { config } from './config.js';

/*
 * Phone notifications for the team (Web Push), so the dashboard works like an app: add it to the home screen and
 * get a buzz for a new lead, a customer asking for a person, a new ticket or booking, or an unhappy customer.
 * Standard Web Push (RFC 8291 encryption, RFC 8292 VAPID) with Node's own crypto – no extra packages.
 */
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
// only the browsers' own push services (no internal addresses)
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|notify\.windows\.com|push\.apple\.com)$/i;

/** The server's VAPID key pair (made once, kept in the database). */
export function vapidKeys() {
  const d = getDb();
  const have = json(d.prepare("SELECT value FROM kv WHERE key = 'vapid'").get()?.value, null);
  if (have?.publicKey && have?.privateJwk) return have;
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  const keys = { publicKey: b64u(pub), privateJwk: { kty: 'EC', crv: 'P-256', d: b64u(ecdh.getPrivateKey()), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } };
  d.prepare("INSERT INTO kv (key, value) VALUES ('vapid', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(keys));
  return keys;
}

function vapidHeader(endpoint) {
  const { publicKey, privateJwk } = vapidKeys();
  const aud = new URL(endpoint).origin;
  const enc = (o) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:${config.supportEmail || 'support@example.com'}` })}`;
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Encrypt a payload for one subscription (aes128gcm). Exported for tests. */
export function encryptPayload(payload, { p256dh, auth }, { salt = crypto.randomBytes(16), serverEcdh } = {}) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  const ecdh = serverEcdh || crypto.createECDH('prime256v1');
  if (!serverEcdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

export function saveSubscription(tenantId, sub, who = null) {
  const endpoint = String(sub?.endpoint || '');
  let host = '';
  try { host = new URL(endpoint).host; } catch {}
  if (!/^https:\/\//.test(endpoint) || !PUSH_HOSTS.test(host) || !sub?.keys?.p256dh || !sub?.keys?.auth) throw Object.assign(new Error('That is not a browser push subscription'), { status: 400 });
  getDb().prepare(`INSERT INTO push_subs (tenant_id, endpoint, p256dh, auth, who) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET tenant_id = excluded.tenant_id, p256dh = excluded.p256dh, auth = excluded.auth, who = excluded.who`).run(tenantId, endpoint, String(sub.keys.p256dh), String(sub.keys.auth), who);
  return true;
}
export const removeSubscription = (endpoint) => getDb().prepare('DELETE FROM push_subs WHERE endpoint = ?').run(String(endpoint)).changes > 0;
export const subscriptionCount = (tenantId) => getDb().prepare('SELECT COUNT(*) AS n FROM push_subs WHERE tenant_id = ?').get(tenantId).n;

/** Send a notification to every phone/computer the team turned notifications on for. Never throws. */
export async function pushTeam(tenant, { title, body, url = '/admin/', tag } = {}) {
  const subs = getDb().prepare('SELECT * FROM push_subs WHERE tenant_id = ?').all(tenant.id);
  if (!subs.length) return 0;
  const payload = JSON.stringify({ title: String(title).slice(0, 80), body: String(body || '').slice(0, 200), url, tag: tag || undefined });
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: vapidHeader(s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' }, body: encryptPayload(payload, s), signal: AbortSignal.timeout(10000) });
      if (r.status === 404 || r.status === 410) removeSubscription(s.endpoint); // the phone unsubscribed
      else if (r.ok) sent++;
    } catch (e) { console.warn('[push]', e.message); }
  }));
  return sent;
}
