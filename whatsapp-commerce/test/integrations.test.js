import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, tenants, say } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { sendHook, hookRow, SHEETS_SCRIPT } from '../src/hooks.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
/** A stand-in for Zapier / Google Sheets: records what it receives. */
async function withReceiver(fn, status = 200) {
  const got = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push({ headers: req.headers, body: JSON.parse(b || '{}') }); res.writeHead(status); res.end('ok'); }); }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const was = config.allowPrivateFetch;
  config.allowPrivateFetch = true;
  try { return await fn(`http://127.0.0.1:${server.address().port}/hook`, got); } finally { config.allowPrivateFetch = was; server.close(); }
}
const admin = (base, path, opts = {}) => fetch(`${base}/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}` }, body: opts.body ? JSON.stringify(opts.body) : undefined });
const SID = 'uploadSessionABCDEFGH12';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

test('new leads go to the webhook (signed) and the Google Sheet as a flat row', () => withReceiver(async (url, got) => {
  const t = makeTenant({ notifications: { webhookUrl: url, webhookSecret: 's3cret', sheetsUrl: url + '?sheet=1' } });
  const wa = '447700900881';
  await say(t, wa, 'hi');
  await say(t, wa, { action: 'lead:call:Kitchen refit' });
  await say(t, wa, { action: 'lead:when:Morning' });
  await say(t, wa, 'New kitchen, about £8k');
  await say(t, wa, { action: 'lead:skip' });
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 2, 'webhook + sheet');
  const hook = got.find((g) => g.headers['x-signature']);
  assert.ok(hook, 'the webhook is signed');
  assert.match(hook.headers['x-signature'], /^sha256=[a-f0-9]{64}$/);
  assert.equal(hook.body.event, 'lead.new');
  assert.equal(hook.body.data.phone, '+447700900881');
  assert.equal(hook.body.data.message, 'New kitchen, about £8k');
  assert.deepEqual([hook.body.row.sheet, hook.body.row.Wants, hook.body.row.Topic, hook.body.row['Best time']], ['Leads', 'Call back', 'Kitchen refit', 'Morning']);
  assert.ok(got.some((g) => !g.headers['x-signature']), 'the Google Sheet request is not signed');
}));

test('webhook test button, private addresses refused, CSV of leads, the Sheets script', () => withServer((base) => withReceiver(async (url, got) => {
  const t = makeTenant();
  let r = await admin(base, `/tenants/${t.id}/hooks/test`, { method: 'POST' });
  assert.equal(r.status, 400, 'nothing set yet');
  tenants.updateTenantSettings(t.id, { notifications: { webhookUrl: url } });
  r = await (await admin(base, `/tenants/${t.id}/hooks/test`, { method: 'POST' })).json();
  assert.deepEqual(r.results.map((x) => [x.kind, x.ok]), [['webhook', true]]);
  assert.equal(got.at(-1).body.event, 'test');
  // outside tests, internal addresses are never called
  config.allowPrivateFetch = false;
  const [res] = await sendHook(tenants.getTenant(t.id), 'test', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /not allowed/);
  config.allowPrivateFetch = true;
  // CSV export (formula-safe)
  getDb().prepare("INSERT INTO chat_leads (tenant_id, wa_id, channel, kind, topic, name, email, phone, message) VALUES (?, 'web:x', 'web', 'email', 'Prices', '=HYPERLINK(1)', 'a@b.test', '+447700900000', 'Hi, \"quote\" please')").run(t.id);
  const csv = await (await admin(base, `/tenants/${t.id}/export/leads.csv`)).text();
  assert.match(csv, /^(﻿)?Date,Wants,Topic,Name,Email/);
  assert.match(csv, /'=HYPERLINK\(1\)/);
  assert.match(csv, /"Hi, ""quote"" please"/);
  const { script } = await (await admin(base, `/tenants/${t.id}/hooks/sheets-script`)).json();
  assert.equal(script, SHEETS_SCRIPT);
  assert.match(script, /function doPost\(e\)/);
  assert.equal(hookRow('booking.new', { service: 'Cut', when: 'Fri 3pm' }).sheet, 'Bookings');
})));

test('website chat: visitors send a photo or PDF; it reaches the Inbox and the team is asked to look', () => withServer(async (base) => {
  const t = makeTenant();
  const up = (body, type, name = 'boiler.png') => fetch(`${base}/chat/${t.id}/upload?sessionId=${SID}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type }, body });
  let r = await up(PNG, 'image/png');
  assert.equal(r.status, 200);
  let b = await r.json();
  assert.match(b.replies[0].text, /got \*boiler\.png\*/);
  assert.ok(b.replies.some((m) => /member of our team/.test(m.text || '')), 'handed to the team');
  const msg = getDb().prepare("SELECT body FROM messages WHERE tenant_id = ? AND type = 'file'").get(t.id);
  const body = JSON.parse(msg.body);
  assert.equal(body.fileName, 'boiler.png');
  const file = await fetch(body.fileUrl.replace(config.publicUrl, base));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(PNG));
  // a second file doesn't alert the team again
  b = await (await up(Buffer.from('%PDF-1.7 test'), 'application/pdf', 'quote.pdf')).json();
  assert.match(b.replies.at(-1).text, /take a look/);
  // not a real image / wrong type → refused
  assert.equal((await up(Buffer.from('<script>alert(1)</script>'), 'image/png')).status, 400);
  assert.equal((await up(Buffer.from('<html>'), 'text/html')).status, 400);
  assert.equal((await fetch(`${base}/chat-files/${t.id}/..%2F..%2Fsecret.png`)).status, 404);
  // the shop can turn it off
  tenants.updateTenantSettings(t.id, { webchat: { uploads: false } });
  assert.equal((await up(PNG, 'image/png')).status, 404);
  assert.match(await (await fetch(`${base}/chat-widget/${t.id}.js`)).text(), /"upload":false/);
}));

test('full-page chat link and the chat inside a page', () => withServer(async (base) => {
  const t = makeTenant({ business: { name: 'Bloom & Co' } });
  const page = await (await fetch(`${base}/c/${t.id}`)).text();
  assert.match(page, /<title>Chat with Bloom &amp; Co<\/title>/);
  assert.match(page, new RegExp(`/chat-widget/${t.id}\\.js" data-embed="#chat"`));
  assert.match(page, /noindex/);
  const js = await (await fetch(`${base}/chat-widget/${t.id}.js`)).text();
  assert.match(js, /getAttribute\('data-embed'\)/);
  assert.match(js, /"upload":true/);
  assert.doesNotThrow(() => new Function(js), 'the widget is valid JavaScript');
  assert.equal((await fetch(`${base}/c/nope`)).status, 404);
}));
