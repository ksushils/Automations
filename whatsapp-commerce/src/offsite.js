import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/*
 * Off-server backups. The daily SQLite snapshot (ops.backup) also goes to S3-compatible storage – Cloudflare R2,
 * Backblaze B2, AWS S3, Wasabi… – so every shop, chat, lead and the assistants' knowledge survive losing the server.
 *
 * Each file is gzipped and encrypted (AES-256-GCM) before it leaves the server; the storage provider never sees the
 * data. The key comes from BACKUP_PASSPHRASE (or, if unset, ENCRYPTION_KEY). Keep that passphrase somewhere safe
 * (a password manager): without it a backup can't be opened. Restore with:  node src/cli/restoreBackup.js <file.enc> <out.db>
 *
 * Settings (env): BACKUP_S3_ENDPOINT (e.g. https://<account>.r2.cloudflarestorage.com), BACKUP_S3_BUCKET,
 * BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY, BACKUP_S3_REGION (default auto), BACKUP_S3_PREFIX (default backups/).
 * Old copies: set a lifecycle rule on the bucket (e.g. delete after 90 days).
 */
const MAGIC = Buffer.from('WCBK1');

export function offsiteConfig(env = process.env) {
  const c = { endpoint: String(env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''), bucket: env.BACKUP_S3_BUCKET || '', accessKey: env.BACKUP_S3_ACCESS_KEY || '', secretKey: env.BACKUP_S3_SECRET_KEY || '', region: env.BACKUP_S3_REGION || 'auto', prefix: (env.BACKUP_S3_PREFIX ?? 'backups/').replace(/^\/+/, '') };
  return c.endpoint && c.bucket && c.accessKey && c.secretKey ? c : null;
}

const passphrase = (env = process.env) => env.BACKUP_PASSPHRASE || env.ENCRYPTION_KEY || '';
const keyFrom = (pass, salt) => crypto.scryptSync(String(pass), salt, 32);

/** gzip + AES-256-GCM. Layout: MAGIC | salt(16) | iv(12) | tag(16) | ciphertext */
export function sealBackup(buf, pass = passphrase()) {
  if (!pass) throw new Error('Set BACKUP_PASSPHRASE (or ENCRYPTION_KEY) to encrypt off-server backups');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(pass, salt), iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(buf)), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}
export function openBackup(sealed, pass = passphrase()) {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a WhatsApp Commerce backup file');
  let o = MAGIC.length;
  const salt = sealed.subarray(o, (o += 16)), iv = sealed.subarray(o, (o += 12)), tag = sealed.subarray(o, (o += 16));
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(pass, salt), iv);
  d.setAuthTag(tag);
  return zlib.gunzipSync(Buffer.concat([d.update(sealed.subarray(o)), d.final()]));
}

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** AWS Signature V4 PUT (path-style), which R2, B2, S3 and Wasabi all accept. */
export function signedPut(cfg, key, body, now = new Date()) {
  const url = new URL(`${cfg.endpoint}/${enc(cfg.bucket)}/${key.split('/').map(enc).join('/')}`);
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const hash = sha(body);
  const headers = { host: url.host, 'x-amz-content-sha256': hash, 'x-amz-date': amzDate, 'content-type': 'application/octet-stream' };
  const names = Object.keys(headers).sort();
  const canonical = ['PUT', url.pathname, '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), hash].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${cfg.secretKey}`, day), cfg.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
  return { url: url.toString(), headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` } };
}

/** Encrypt one local backup file and upload it. Returns { key, bytes } or null when off-server backup isn't set up. */
export async function uploadBackup(file, { cfg = offsiteConfig(), now = new Date() } = {}) {
  if (!cfg) return null;
  const body = sealBackup(fs.readFileSync(file));
  const key = `${cfg.prefix}${path.basename(file)}.enc`;
  const { url, headers } = signedPut(cfg, key, body, now);
  const { host, ...send } = headers; // fetch sets Host itself
  void host;
  const res = await fetch(url, { method: 'PUT', headers: send, body, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Off-server backup upload failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return { key, bytes: body.length };
}
