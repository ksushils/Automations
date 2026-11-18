import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sealBackup, openBackup, signedPut, uploadBackup, offsiteConfig } from '../src/offsite.js';

test('off-server backup: encrypted round trip; wrong passphrase fails; nothing readable in the upload', () => {
  const db = Buffer.from('SQLite format 3\0 customers: Jo jo@example.co.uk 07700900123 '.repeat(50));
  const sealed = sealBackup(db, 'correct horse battery staple');
  assert.ok(!sealed.includes(Buffer.from('jo@example.co.uk')), 'personal data is not readable in the file');
  assert.deepEqual(openBackup(sealed, 'correct horse battery staple'), db);
  assert.throws(() => openBackup(sealed, 'wrong'), /unable to authenticate|bad decrypt/i);
  assert.throws(() => openBackup(Buffer.from('not a backup'), 'x'), /Not a WhatsApp Commerce backup/);
});

test('off-server backup: only when fully configured; AWS SigV4 matches the published example', () => {
  assert.equal(offsiteConfig({}), null);
  assert.equal(offsiteConfig({ BACKUP_S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'b' }), null);
  // signing key derivation from AWS's documentation example (secret wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, 20120215, us-east-1, iam)
  const h = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  const k = h(h(h(h('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215'), 'us-east-1'), 'iam'), 'aws4_request');
  assert.equal(k.toString('hex'), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  const cfg = { endpoint: 'https://acc.r2.cloudflarestorage.com', bucket: 'wc-backups', accessKey: 'AKID', secretKey: 'SECRET', region: 'auto', prefix: 'backups/' };
  const s = signedPut(cfg, 'backups/a b.db.enc', Buffer.from('x'), new Date('2026-11-18T10:00:00Z'));
  assert.equal(s.url, 'https://acc.r2.cloudflarestorage.com/wc-backups/backups/a%20b.db.enc');
  assert.match(s.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20261118\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(s.headers['x-amz-date'], '20261118T100000Z');
});

test('off-server backup: uploads the sealed file with a signed PUT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcbk-'));
  const file = path.join(dir, 'whatsapp-commerce-2026-11-18.db');
  fs.writeFileSync(file, 'SQLite format 3\0 hello');
  const real = globalThis.fetch;
  const puts = [];
  globalThis.fetch = async (url, opts) => { puts.push({ url, opts }); return new Response('', { status: 200 }); };
  const prev = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
  try {
    const cfg = { endpoint: 'https://acc.r2.cloudflarestorage.com', bucket: 'wc', accessKey: 'AK', secretKey: 'SK', region: 'auto', prefix: 'backups/' };
    const r = await uploadBackup(file, { cfg });
    assert.equal(r.key, 'backups/whatsapp-commerce-2026-11-18.db.enc');
    assert.equal(puts[0].opts.method, 'PUT');
    assert.match(puts[0].opts.headers.authorization, /^AWS4-HMAC-SHA256/);
    assert.deepEqual(openBackup(Buffer.from(puts[0].opts.body)).toString(), 'SQLite format 3\0 hello');
    assert.equal(await uploadBackup(file, { cfg: null }), null, 'not set up: nothing sent');
  } finally { globalThis.fetch = real; process.env.ENCRYPTION_KEY = prev; fs.rmSync(dir, { recursive: true, force: true }); }
});
