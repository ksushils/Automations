import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants } from './helpers.js';
import { createApp } from '../src/server.js';
import { getDb } from '../src/db.js';
import { resolveAudience } from '../src/campaigns.js';
import { monthEstimate } from '../src/metaPricing.js';
import { recordConsent } from '../src/consent.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const SID = 'webSessionABCDEFGH1234';
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }));

test('website AI chat: same bot over HTTP, no WhatsApp; checkout hands basket to storefront; staff replies via poll', () => withServer(async (base) => {
  const t = makeTenant({ whatsapp: { phoneNumberId: 'PN', accessToken: 'tok' } });
  const realFetch = globalThis.fetch;
  const graph = [];
  globalThis.fetch = async (u, o) => (String(u).startsWith('https://graph.facebook.com') ? (graph.push(u), new Response('{}')) : realFetch(u, o));
  try {
    let r = await post(`${base}/chat/${t.id}/message`, { sessionId: SID, text: 'hi' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.body.replies[0].text, /automated assistant/);
    r = await post(`${base}/chat/${t.id}/message`, { sessionId: SID, text: 'mug' });
    assert.ok(r.body.replies[0].sections[0].rows.some((x) => x.id === 'p:mug'));
    await post(`${base}/chat/${t.id}/message`, { sessionId: SID, actionId: 'v:mug|mug' });
    await post(`${base}/chat/${t.id}/message`, { sessionId: SID, actionId: 'q:2' });
    r = await post(`${base}/chat/${t.id}/message`, { sessionId: SID, actionId: 'checkout' });
    const cta = r.body.replies[0];
    assert.equal(cta.type, 'cta');
    const url = new URL(cta.url);
    assert.equal(url.pathname, `/s/${t.id}`);
    const items = JSON.parse(Buffer.from(url.searchParams.get('cart'), 'base64url').toString());
    assert.deepEqual(items.map((i) => [i.productId, i.quantity]), [['mug', 2]]);
    const last = r.body.lastId;
    // staff replies from the inbox → stored for the widget, not sent to WhatsApp
    const adminKey = tenants.rotateKeys(t.id).adminKey;
    const rep = await (await realFetch(`${base}/api/tenants/${t.id}/conversations/web:${SID}/reply`, { method: 'POST', headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hi, it is Sam – happy to help!' }) })).json();
    assert.ok(rep.ok);
    const p = await (await realFetch(`${base}/chat/${t.id}/poll?sessionId=${SID}&after=${last}`)).json();
    assert.deepEqual(p.messages.map((m) => m.text), ['Hi, it is Sam – happy to help!']);
    assert.equal(graph.filter((u) => u.includes('/messages')).length, 0, 'nothing went out through WhatsApp');
    // web visitors are never in WhatsApp campaigns or Meta cost estimates
    recordConsent(t.id, `web:${SID}`, { status: 'granted', source: 'test' });
    assert.ok(!resolveAudience(t.id, {}).some((w) => w.startsWith('web:')));
    assert.equal(monthEstimate(t.id).serviceMessages, 0);
  } finally { globalThis.fetch = realFetch; }
}));

test('website chat validates sessions and can be disabled; widget script is served', () => withServer(async (base) => {
  const t = makeTenant({ business: { whatsappNumber: '447700900123' } });
  assert.equal((await post(`${base}/chat/${t.id}/message`, { sessionId: 'short', text: 'hi' })).status, 400);
  const js = await (await fetch(`${base}/chat-widget/${t.id}.js`)).text();
  assert.match(js, /"tenant":"/);
  assert.match(js, /wa\.me\//);
  tenants.updateTenantSettings(t.id, { webchat: { enabled: false } });
  assert.equal((await post(`${base}/chat/${t.id}/message`, { sessionId: SID, text: 'hi' })).status, 404);
  assert.match(await (await fetch(`${base}/chat-widget/${t.id}.js`)).text(), /disabled/);
}));

test('go-live checklist reflects connection, number and templates', async () => {
  const { goLiveChecklist } = await import('../src/goLive.js');
  const t = makeTenant();
  let c = await goLiveChecklist(tenants.getTenant(t.id));
  assert.equal(c.ready, false);
  assert.equal(c.steps.find((s) => s.key === 'connect').done, false);
  assert.equal(c.steps.find((s) => s.key === 'payment').done, null); // can't be checked – links to Meta billing
  getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, '447700900777', 'in', 'text', '{}')").run(t.id);
  c = await goLiveChecklist(tenants.getTenant(t.id));
  assert.equal(c.steps.find((s) => s.key === 'webhook').done, true);
});
