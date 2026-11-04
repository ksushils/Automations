import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tenants } from './helpers.js';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { alert } from '../src/ops.js';

test('security headers, health, super-admin status', async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
    const a = await fetch(`${base}/admin/`);
    assert.equal(a.headers.get('x-frame-options'), 'DENY');
    const s = await (await fetch(`${base}/api/system/status`, { headers: { Authorization: 'Bearer super-admin-test-key' } })).json();
    assert.ok(s.tenants >= 0 && s.ok);
    assert.equal((await fetch(`${base}/api/system/status`)).status, 401);
  } finally { server.close(); }
});

test('alerts are throttled per key', async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  config.alertWebhookUrl = 'https://hooks.example/alert';
  globalThis.fetch = async (u, o) => { sent.push(JSON.parse(o.body)); return new Response('ok'); };
  try {
    await alert('Disk full', { key: 'disk' });
    await alert('Disk full', { key: 'disk' });
    await alert('Other', { key: 'other' });
  } finally { globalThis.fetch = realFetch; config.alertWebhookUrl = ''; }
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Disk full/);
});

test('backup snapshot is a valid database and old ones are pruned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bk-'));
  const { backup } = await import('../src/ops.js');
  const prev = config.databasePath;
  config.databasePath = 'file-db-for-test';
  try {
    tenants.createTenant({ name: 'Backup Shop' });
    for (let i = 0; i < 4; i++) { backup({ dir, keep: 2 }); await new Promise((r) => setTimeout(r, 5)); }
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 2);
    const db = new DatabaseSync(path.join(dir, files[0]));
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n >= 1);
    db.close();
  } finally { config.databasePath = prev; fs.rmSync(dir, { recursive: true, force: true }); }
});
