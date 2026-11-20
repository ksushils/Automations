import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants, say, ids } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { parseHours, teamStatus } from '../src/hours.js';
import { buildPrompt } from '../src/dify/provision.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const admin = (base, path, opts = {}) => fetch(`${base}/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}` }, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/** A team-hours line that is closed right now (a one-hour window twelve hours away, London time). */
function closedNow() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const o = (h + 12) % 24;
  return `Mon-Sun ${String(o).padStart(2, '0')}:00-${String(o).padStart(2, '0')}:59`;
}

test('team hours: parsing and online/away with when the team is back', () => {
  assert.deepEqual(parseHours('Mon-Fri 09:00-17:30; Sat 10am-2pm')[6], [[600, 840]]);
  const S = { teamHours: { enabled: true, text: 'Mon-Fri 09:00-17:30; Sat 10:00-14:00' }, business: { timezone: 'Europe/London' } };
  assert.deepEqual(teamStatus(S, new Date('2026-11-20T10:00:00Z')), { on: true, open: true, next: '' }); // Friday 10am
  assert.equal(teamStatus(S, new Date('2026-11-20T18:00:00Z')).next, 'tomorrow at 10am');
  assert.equal(teamStatus(S, new Date('2026-11-21T15:00:00Z')).next, 'Mon at 9am');
  assert.equal(teamStatus({}, new Date()).on, false);
});

test('outside team hours, "talk to a person" takes details instead of promising a quick reply', async () => {
  const t = makeTenant({ teamHours: { enabled: true, text: closedNow() } });
  const r = await say(t, '447700900881', 'human');
  assert.match(r[0].text, /Our team is away right now – back (today|tomorrow) at/);
  assert.deepEqual(ids(r), ['lead:email:Talk to the team', 'lead:call:Talk to the team', 'ask']);
  assert.equal(getDb().prepare('SELECT human_handover FROM conversations WHERE tenant_id = ?').get(t.id).human_handover, 0, 'the assistant keeps helping');
});

test('widget: team status line, hide on pages/phones, the AI replies in the customer\'s language', () => withServer(async (base) => {
  const t = makeTenant({ teamHours: { enabled: true, text: closedNow() }, webchat: { hidePaths: ['/checkout*', '/careers'], hideOnMobile: true } });
  const js = await (await fetch(`${base}/chat-widget/${t.id}.js`)).text();
  assert.match(js, /"team":\{"open":false,"next":"(today|tomorrow) at/);
  assert.match(js, /"hide":\{"paths":\["\/checkout\*","\/careers"\],"mobile":true\}/);
  assert.doesNotThrow(() => new Function(js));
  assert.match(buildPrompt(tenants.getTenant(t.id)), /Reply in the language the customer writes in/);
}));

test('live visitors (opt-in): pages they view, and a "hello" from the team pops up for them', () => withServer(async (base) => {
  const t = makeTenant();
  const sid = 'liveVisitorSessionABCD12';
  assert.deepEqual(await (await post(`${base}/chat/${t.id}/seen`, { sessionId: sid, page: { url: 'https://shop.test/', title: 'Home' } })).json(), {}, 'off by default: nothing kept');
  assert.equal((await admin(base, `/tenants/${t.id}/visitors`)).body.visitors.length, 0);
  tenants.updateTenantSettings(t.id, { webchat: { liveVisitors: true } });
  await post(`${base}/chat/${t.id}/seen`, { sessionId: sid, page: { url: 'https://shop.test/', title: 'Home' }, ref: 'https://www.google.com/' });
  await post(`${base}/chat/${t.id}/seen`, { sessionId: sid, page: { url: 'https://shop.test/prices', title: 'Prices' } });
  const v = (await admin(base, `/tenants/${t.id}/visitors`)).body;
  assert.equal(v.enabled, true);
  assert.deepEqual([v.visitors[0].page.title, v.visitors[0].pages, v.visitors[0].ref], ['Prices', 2, 'https://www.google.com/']);
  assert.equal((await admin(base, `/tenants/${t.id}/visitors/${sid}/hello`, { method: 'POST', body: { text: 'Hi! Need help with prices?' } })).status, 200);
  assert.deepEqual(await (await post(`${base}/chat/${t.id}/seen`, { sessionId: sid, page: { url: 'https://shop.test/prices', title: 'Prices' } })).json(), { hello: 'Hi! Need help with prices?' });
  assert.ok(getDb().prepare("SELECT 1 FROM messages WHERE tenant_id = ? AND wa_id = ? AND direction = 'out' AND body LIKE '%Need help with prices%'").get(t.id, `web:${sid}`), 'in the chat history');
  assert.equal((await admin(base, `/tenants/${t.id}/visitors/nobodyHereABCDEFGH1234/hello`, { method: 'POST', body: { text: 'hi' } })).status, 404);
}));

test('typing preview only when the shop turns it on', () => withServer(async (base) => {
  const t = makeTenant();
  const sid = 'previewSessionABCDEFGH12';
  const typing = () => admin(base, `/tenants/${t.id}/conversations/${encodeURIComponent('web:' + sid)}/typing`).then((r) => r.body);
  await post(`${base}/chat/${t.id}/typing`, { sessionId: sid, draft: 'do you deliver to' });
  assert.deepEqual(await typing(), { typing: true, draft: '' });
  tenants.updateTenantSettings(t.id, { webchat: { typingPreview: true } });
  await post(`${base}/chat/${t.id}/typing`, { sessionId: sid, draft: 'do you deliver to' });
  assert.deepEqual(await typing(), { typing: true, draft: 'do you deliver to' });
}));

test('Inbox AI: a suggested reply from the shop information, and translation both ways', () => withServer(async (base) => {
  const t = makeTenant();
  const prevCfg = { ...config };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '' });
  const prev = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('ai.test')) { const b = JSON.parse(o.body); seen.push(b); const sys = b.messages[0].content; return new Response(JSON.stringify({ choices: [{ message: { content: /Translate/.test(sys) ? (/into English/.test(sys) ? 'Do you deliver to Leeds?\nLANG: Polish' : 'Tak, dostarczamy do Leeds.\nLANG: English') : 'Yes, we deliver to Leeds for £3.50.' } }] })); }
    return prev(url, o);
  };
  try {
    getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, '447700900991', 'in', 'text', ?)").run(t.id, JSON.stringify({ type: 'text', text: 'Czy dostarczacie do Leeds?' }));
    let r = await admin(base, `/tenants/${t.id}/conversations/447700900991/suggest`, { method: 'POST' });
    assert.equal(r.body.text, 'Yes, we deliver to Leeds for £3.50.');
    assert.match(seen[0].messages[1].content, /Customer: Czy dostarczacie do Leeds\?/);
    r = await admin(base, `/tenants/${t.id}/translate`, { method: 'POST', body: { text: 'Czy dostarczacie do Leeds?', to: 'English' } });
    assert.deepEqual(r.body, { text: 'Do you deliver to Leeds?', from: 'Polish' });
    r = await admin(base, `/tenants/${t.id}/translate`, { method: 'POST', body: { text: 'Yes, we deliver to Leeds.', to: 'Polish' } });
    assert.equal(r.body.text, 'Tak, dostarczamy do Leeds.');
  } finally { globalThis.fetch = prev; Object.assign(config, prevCfg); }
}));
