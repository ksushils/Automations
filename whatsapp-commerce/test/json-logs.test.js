import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { installJsonLogs, uninstallJsonLogs, redact, safePath, jsonLine } from '../src/log.js';
import { createApp } from '../src/server.js';

test('JSON logs are off unless LOG_FORMAT=json', () => {
  delete process.env.LOG_FORMAT;
  assert.equal(installJsonLogs(), false);
});

test('console lines become one JSON object each, with level and [tag]; secrets are masked', () => {
  const lines = [];
  assert.equal(installJsonLogs({ force: true, write: (l) => lines.push(l) }), true);
  try {
    console.log('[backup] saved', 'data/backups/x.db');
    console.warn('Configuration warning', { key: 'value' });
    console.error(new Error('boom'));
    console.log('[ai] key sk-or-v1-abcdefghijklmnopqrstuvwxyz and Bearer abc.def.ghijklmnop token EAAGm0PX4ZCpsBAKZCZCabcdefghijklmnop sk_live_1234567890abcd access_token=supersecretvalue');
  } finally { uninstallJsonLogs(); }
  const o = lines.map((l) => JSON.parse(l));
  assert.equal(o[0].level, 'info'); assert.equal(o[0].tag, 'backup'); assert.equal(o[0].msg, 'saved data/backups/x.db'); assert.ok(o[0].time);
  assert.equal(o[1].level, 'warn'); assert.match(o[1].msg, /key: 'value'/);
  assert.equal(o[2].level, 'error'); assert.match(o[2].msg, /boom/);
  for (const secret of ['abcdefghijklmnopqrstuvwxyz', 'ghijklmnop', 'EAAGm0PX4ZCps', '1234567890abcd', 'supersecretvalue']) assert.ok(!o[3].msg.includes(secret), secret);
  assert.match(o[3].msg, /sk-\*\*\*/);
});

test('paths hide tokens and query strings; redact leaves normal text alone', () => {
  assert.equal(safePath('/try/aB3dE6gH9jK2mN5pQ8sT1v/twin?x=secret'), '/try/:token/twin');
  assert.equal(safePath('/api/tenants/abc123/twin'), '/api/tenants/abc123/twin');
  assert.equal(redact('Order 1042 sent to 07700 900123'), 'Order 1042 sent to 07700 900123');
  assert.equal(JSON.parse(jsonLine('info', ['plain'])).tag, undefined);
});

test('one JSON line per HTTP request (not /health), with a request id', async () => {
  const lines = [];
  installJsonLogs({ force: true, write: (l) => lines.push(l) });
  const server = createApp().listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(base + '/health');
    const r = await fetch(base + '/try/aB3dE6gH9jK2mN5pQ8sT1v/twin?k=secret', { headers: { 'X-Request-Id': 'req-42' } });
    assert.equal(r.headers.get('x-request-id'), 'req-42');
    await new Promise((x) => setTimeout(x, 50));
  } finally { server.close(); uninstallJsonLogs(); }
  const reqs = lines.map((l) => JSON.parse(l)).filter((o) => o.type === 'request');
  assert.equal(reqs.length, 1, JSON.stringify(lines));
  assert.equal(reqs[0].id, 'req-42');
  assert.equal(reqs[0].path, '/try/:token/twin');
  assert.equal(reqs[0].method, 'GET');
  assert.ok(typeof reqs[0].ms === 'number' && reqs[0].status >= 200);
});
