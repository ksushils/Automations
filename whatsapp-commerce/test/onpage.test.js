import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { makeTenant, tenants, say } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { extractShow, pageNote } from '../src/bot/engine.js';
import { addTextDoc } from '../src/knowledge.js';
import { authUrl, checkState, refreshBusy, _setBusyForTest } from '../src/gcal.js';
import { freeTimes, zonedToUtc, getBooking, setBookingStatus } from '../src/bookings.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const post = (base, id, body) => fetch(`${base}/chat/${id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('point to the page: the AI is told the sections; [SHOW: …] becomes a "Show me on the page" button on the website only', async () => {
  const sections = ['Description', 'Delivery & returns', 'Size chart'];
  assert.deepEqual(extractShow('Delivery is free over £50. [SHOW: delivery & returns]', sections), { text: 'Delivery is free over £50.', show: 'Delivery & returns' });
  assert.deepEqual(extractShow('Hi [SHOW: Warranty]', sections), { text: 'Hi', show: null }, 'only sections that are really on the page');
  assert.match(pageNote({ waId: 'web:x', data: { page: { url: 'https://s.test/p', title: 'P', sections } } }), /Sections on this page: Description \| Delivery & returns \| Size chart\. If the answer is in one of these sections, end your reply with \[SHOW:/);

  const llm = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'It ships in 2 days, and returns are free within 30 days. [SHOW: Delivery & returns]' } }], usage: { total_tokens: 3 } })); }); });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const prev = { ...config };
  Object.assign(config, { aiBaseUrl: `http://127.0.0.1:${llm.address().port}/v1`, aiApiKey: 'sk-test', embeddingsModel: '' });
  try {
    await withServer(async (base) => {
      const t = makeTenant();
      // the shop's own information backs the delivery and returns times (invented times are removed by the time guard)
      addTextDoc(t.id, { name: 'Delivery & returns', text: 'We ship in 2 days. Returns are free within 30 days of delivery.' });
      const r = await post(base, t.id, { sessionId: 'sess' + 's'.repeat(20), text: 'how long does delivery take?', page: { url: 'https://shop.test/products/tee', title: 'Tee', sections } });
      const m = r.replies.find((x) => /ships in 2 days/.test(x.text || ''));
      assert.equal(m.highlight, 'Delivery & returns');
      assert.ok(!/SHOW/.test(m.text));
      const w = await say(t, '447700940001', 'how long does delivery take?');
      assert.ok(!w.some((x) => x.highlight || /SHOW/.test(x.text || '')), 'WhatsApp: no page to point at');
    });
  } finally { Object.assign(config, prev); llm.close(); }
});

test("the site's own enquiry form: after the lead, offered to be filled in with their details (they press send)", () => withServer(async (base) => {
  const t = makeTenant({ store: { type: 'none' }, business: { name: 'Karat Racing' } });
  const sid = 'sess' + 'f'.repeat(20);
  const page = { url: 'https://karat.test/contact', title: 'Contact', form: true };
  const ask = (b) => post(base, t.id, { sessionId: sid, page, ...b });
  await ask({ actionId: 'lead:call:Test days' });
  await ask({ text: '07700 900456' });
  await ask({ actionId: 'lead:when:Morning' });
  await ask({ text: 'Alex Smith' });
  let r = await ask({ text: 'A test day in March for 2 drivers' });
  r = r.replies.length ? r : r;
  const prevEmail = r.replies.find((m) => /email address/i.test(m.text || ''));
  if (prevEmail) r = await ask({ actionId: 'lead:skip' });
  const offer = r.replies.find((m) => /its own enquiry form too/.test(m.text || ''));
  assert.ok(offer, JSON.stringify(r.replies));
  r = await ask({ actionId: offer.buttons[0].id });
  const fill = r.replies.find((m) => m.type === 'fill_form');
  assert.deepEqual(fill.fields, { name: 'Alex Smith', email: '', phone: '07700900456', message: 'Test days: A test day in March for 2 drivers' });
  // another visitor can't pull this lead's details
  const other = await post(base, t.id, { sessionId: 'sess' + 'o'.repeat(20), actionId: offer.buttons[0].id, page });
  assert.ok(!other.replies.some((m) => m.type === 'fill_form'));
}));

test('Google Calendar: signed sign-in link; busy times are kept free; confirmed bookings are added to the calendar', async () => {
  const prev = { ...config };
  Object.assign(config, { googleClientId: 'cid.apps.googleusercontent.com', googleClientSecret: 'secret' });
  const t = makeTenant({ store: { type: 'none' }, business: { name: 'Karat Racing', address: 'Silverstone' }, bookings: { enabled: true, services: [{ name: 'Planning call', minutes: 30 }], times: ['10:00', '14:00'], days: 14, leadHours: 0, autoConfirm: true } });
  const u = new URL(authUrl(t.id));
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events.owned');
  assert.equal(checkState(u.searchParams.get('state')), t.id);
  const st = u.searchParams.get('state');
  assert.equal(checkState(st.slice(0, -1) + (st.endsWith('x') ? 'y' : 'x')), null, 'tampered state refused'); // always a different last character (was flaky 1 in 64)
  assert.equal(checkState(u.searchParams.get('state'), Date.now() + 31 * 60000), null, 'expired');
  const calls = [];
  const real = globalThis.fetch;
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const busyStart = zonedToUtc(day, '10:00', 'Europe/London');
  globalThis.fetch = async (url, opts = {}) => {
    const s = String(url);
    if (s.startsWith('https://oauth2.googleapis.com/token')) { calls.push(['token', String(opts.body)]); return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt-123', expires_in: 3600 }), { status: 200 }); }
    if (s.endsWith('/freeBusy')) { calls.push(['freebusy', JSON.parse(opts.body)]); return new Response(JSON.stringify({ calendars: { primary: { busy: [{ start: busyStart.toISOString(), end: new Date(busyStart.getTime() + 3600000).toISOString() }] } } }), { status: 200 }); }
    if (s.includes('/calendars/primary/events')) { calls.push(['event', JSON.parse(opts.body)]); return new Response(JSON.stringify({ id: 'ev1' }), { status: 200 }); }
    return real(url, opts);
  };
  try {
    await withServer(async (base) => {
      const cb = await real(`${base}/oauth/google/callback?code=abc&state=${encodeURIComponent(u.searchParams.get('state'))}`);
      assert.match(await cb.text(), /Google Calendar connected/);
    });
    const raw = getDb().prepare('SELECT settings FROM tenants WHERE id = ?').get(t.id).settings;
    assert.ok(!raw.includes('rt-123'), 'the refresh token is stored encrypted');
    assert.equal(tenants.getTenant(t.id).settings.bookings.google.refreshToken, 'rt-123');
    await refreshBusy(tenants.getTenant(t.id), { maxAgeMs: 0 });
    assert.deepEqual(freeTimes(tenants.getTenant(t.id), day), ['14:00'], '10:00 is busy in Google Calendar');
    // a confirmed booking goes into the calendar once
    const wa = '447700940011';
    await say(t, wa, 'hi');
    _setBusyForTest(t.id, []);
    const id = Number(getDb().prepare("INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status, deposit) VALUES (?, ?, 'Sam', 'Planning call', ?, '14:00', ?, 'requested', 0)").run(t.id, wa, day, zonedToUtc(day, '14:00', 'Europe/London').toISOString().replace('T', ' ').slice(0, 19)).lastInsertRowid);
    await setBookingStatus(tenants.getTenant(t.id), id, 'confirmed');
    // the calendar sync runs in the background: wait for it (up to 3 s – a busy server can take longer than 50 ms)
    for (let i = 0; i < 60 && !calls.some((c) => c[0] === 'event'); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 50)); // and make sure a second, duplicate call would have arrived too
    const ev = calls.filter((c) => c[0] === 'event');
    assert.equal(ev.length, 1);
    assert.match(ev[0][1].summary, /Planning call – Sam \(via chat\)/);
    assert.equal(ev[0][1].location, 'Silverstone');
    assert.equal(new Date(ev[0][1].end.dateTime) - new Date(ev[0][1].start.dateTime), 30 * 60000);
    assert.equal(getBooking(t.id, id).gcal_event_id, 'ev1');
    await setBookingStatus(tenants.getTenant(t.id), id, 'confirmed');
    assert.equal(calls.filter((c) => c[0] === 'event').length, 1, 'not added twice');
  } finally { globalThis.fetch = real; Object.assign(config, prev); _setBusyForTest(t.id, []); }
});

test('Shopify app embed: loads the same widget from the shop ID, no permissions requested', () => {
  const liquid = fs.readFileSync(new URL('../shopify-app/extensions/chat-embed/blocks/chat.liquid', import.meta.url), 'utf8');
  assert.match(liquid, /\/chat-widget\/\{\{ block\.settings\.shop_id \| url_encode \}\}\.js" async/);
  const schema = JSON.parse(liquid.match(/\{% schema %\}([\s\S]*)\{% endschema %\}/)[1]);
  assert.equal(schema.target, 'body');
  assert.deepEqual(schema.settings.map((s) => s.id), ['shop_id', 'server']);
  assert.match(fs.readFileSync(new URL('../shopify-app/shopify.app.toml', import.meta.url), 'utf8'), /scopes = ""/);
  assert.match(fs.readFileSync(new URL('../shopify-app/extensions/chat-embed/shopify.extension.toml', import.meta.url), 'utf8'), /type = "theme"/);
});
