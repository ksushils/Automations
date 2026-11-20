import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants, say, ids } from './helpers.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { ratingSummary } from '../src/ratings.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const admin = (base, path, opts = {}) => fetch(`${base}/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}` }, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('the Inbox sees when a website visitor is typing (kept in memory for a few seconds only)', () => withServer(async (base) => {
  const t = makeTenant();
  const sid = 'typingSessionABCDEFGH12';
  assert.equal((await admin(base, `/tenants/${t.id}/conversations/${encodeURIComponent('web:' + sid)}/typing`)).body.typing, false);
  assert.equal((await post(`${base}/chat/${t.id}/typing`, { sessionId: sid })).status, 204);
  assert.equal((await admin(base, `/tenants/${t.id}/conversations/${encodeURIComponent('web:' + sid)}/typing`)).body.typing, true);
  assert.match(await (await fetch(`${base}/chat-widget/${t.id}.js`)).text(), /\/typing'/);
}));

test('short form before the chat: off by default; required means filled in; the bot then knows name and phone', () => withServer(async (base) => {
  const t = makeTenant();
  assert.match(await (await fetch(`${base}/chat-widget/${t.id}.js`)).text(), /"preChat":null/);
  tenants.updateTenantSettings(t.id, { webchat: { preChat: { enabled: true, required: true } } });
  const js = await (await fetch(`${base}/chat-widget/${t.id}.js`)).text();
  assert.match(js, /"preChat":\{"required":true,"email":true,"phone":true/);
  assert.doesNotThrow(() => new Function(js));
  const sid = 'preChatSessionABCDEFGH1';
  assert.equal((await post(`${base}/chat/${t.id}/profile`, { sessionId: sid, name: '' })).status, 400);
  assert.equal((await post(`${base}/chat/${t.id}/profile`, { sessionId: sid, name: 'Priya', email: 'not-an-email' })).status, 400);
  assert.equal((await post(`${base}/chat/${t.id}/profile`, { sessionId: sid, name: 'Priya Shah', email: 'priya@example.test', phone: '07700 900456' })).status, 200);
  const c = getDb().prepare('SELECT name, email, attributes FROM customers WHERE tenant_id = ? AND wa_id = ?').get(t.id, `web:${sid}`);
  assert.deepEqual([c.name, c.email, JSON.parse(c.attributes).phone], ['Priya Shah', 'priya@example.test', '07700 900456']);
  // "Call me back": we already have the number and name, so straight to the best time
  const r = await (await post(`${base}/chat/${t.id}/message`, { sessionId: sid, actionId: 'lead:call:Prices' })).json();
  assert.match(JSON.stringify(r.replies), /When is best to call you/);
}));

test('ratings: 😀 / 😐 / 😞, a 😞 asks what went wrong, and the team hand-back asks for one', () => withServer(async (base) => {
  const t = makeTenant();
  const wa = '447700900771';
  await say(t, wa, 'hi');
  let r = await say(t, wa, { action: 'rate:3' });
  assert.match(r[0].text, /Thank you/);
  r = await say(t, wa, { action: 'rate:1' });
  assert.match(r[0].text, /What could we have done better/);
  await say(t, wa, 'nobody answered my question about delivery');
  let s = ratingSummary(t.id);
  assert.deepEqual([s.great, s.bad, s.byChat[wa].score, s.byChat[wa].comment], [0, 1, 1, 'nobody answered my question about delivery'], 'a second tap the same day changes the rating');
  // a website chat the team handled: handing back asks for a rating
  const sid = 'rateSessionABCDEFGH123';
  await post(`${base}/chat/${t.id}/message`, { sessionId: sid, text: 'hello' });
  await admin(base, `/tenants/${t.id}/conversations/${encodeURIComponent('web:' + sid)}/handover`, { method: 'POST', body: { on: true } });
  const back = await admin(base, `/tenants/${t.id}/conversations/${encodeURIComponent('web:' + sid)}/handover`, { method: 'POST', body: { on: false } });
  assert.equal(back.body.ratingAsked, true);
  const poll = await (await fetch(`${base}/chat/${t.id}/poll?sessionId=${sid}&after=0`)).json();
  assert.ok(poll.messages.some((m) => (m.buttons || []).some((b) => b.id === 'rate:3')));
  await post(`${base}/chat/${t.id}/message`, { sessionId: sid, actionId: 'rate:2' });
  s = (await admin(base, `/tenants/${t.id}/ratings`)).body;
  assert.equal(s.team, 1);
  assert.equal(s.ok, 1);
  // the widget asks too (after a few messages and a quiet spell)
  assert.match(await (await fetch(`${base}/chat-widget/${t.id}.js`)).text(), /"rating":true/);
}));

test('saved replies are stored in the shop settings', () => withServer(async (base) => {
  const t = makeTenant();
  const r = await admin(base, `/tenants/${t.id}/settings`, { method: 'PATCH', body: { inbox: { savedReplies: [{ title: 'Hours', text: 'Hi {{name}}, we open at 9.' }] } } });
  assert.equal(r.status, 200);
  assert.equal(tenants.getTenant(t.id).settings.inbox.savedReplies[0].title, 'Hours');
  void ids;
}));
