import crypto from 'node:crypto';
import { config } from './config.js';

/*
 * Secrets at rest: AES-256-GCM. Ciphertexts carry a key id ("enc:v2:<kid>:<data>") so the key can be rotated:
 *   1. set ENCRYPTION_KEY=<new>, ENCRYPTION_KEYS_OLD=<previous>[,<older>]
 *   2. restart, then POST /api/system/rotate-encryption (or `npm run rotate-keys`) to re-encrypt everything
 *   3. remove the old key from ENCRYPTION_KEYS_OLD.
 * Legacy "enc:<data>" values (no key id) are still readable with any configured key.
 */
const derive = (k) => crypto.createHash('sha256').update(k).digest();
const kidOf = (k) => crypto.createHash('sha256').update('kid:' + k).digest('hex').slice(0, 8);

function keys() {
  const current = config.encryptionKey || 'dev-only-insecure-key';
  const old = String(process.env.ENCRYPTION_KEYS_OLD || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [current, ...old].map((k) => ({ kid: kidOf(k), key: derive(k) }));
}

export const currentKeyId = () => keys()[0].kid;

export function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return plain ?? null;
  const { kid, key } = keys()[0];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `enc:v2:${kid}:` + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function tryKey(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return value;
  const ks = keys();
  if (value.startsWith('enc:v2:')) {
    const [, , kid, b64] = value.split(':');
    const k = ks.find((x) => x.kid === kid);
    if (!k) throw new Error(`No encryption key for key id ${kid} – add the old key to ENCRYPTION_KEYS_OLD`);
    return tryKey(k.key, b64);
  }
  const b64 = value.slice(4);
  for (const k of ks) { try { return tryKey(k.key, b64); } catch { /* try next key */ } }
  throw new Error('Could not decrypt a stored secret with any configured key');
}

/** True if a stored value is not encrypted with the current key (needs re-encryption). */
export const needsRotation = (value) => typeof value === 'string' && value.startsWith('enc:') && !value.startsWith(`enc:v2:${currentKeyId()}:`);

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? ''));
  const B = Buffer.from(String(b ?? ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** Verify Meta's X-Hub-Signature-256 header against the raw body. */
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret) return true; // signature check disabled for this tenant
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(expected, header);
}
