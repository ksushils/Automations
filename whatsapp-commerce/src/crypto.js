import crypto from 'node:crypto';
import { config } from './config.js';

const key = () => crypto.createHash('sha256').update(config.encryptionKey || 'dev-only-insecure-key').digest();

/** Encrypt a string with AES-256-GCM. Output: base64(iv|tag|ciphertext) prefixed with "enc:". */
export function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return plain ?? null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'enc:' + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return value;
  const buf = Buffer.from(value.slice(4), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

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
