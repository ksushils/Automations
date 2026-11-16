import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, say, ids, tenants, engine } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { getDb } = await import('../src/db.js');
const { listBookings, setBookingStatus, runBookingJobs, zonedToUtc, freeDays, bookingDepositPaid } = await import('../src/bookings.js');

const okFetch = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.t' }] }), { status: 200 });

test('zonedToUtc handles BST and GMT', () => {
  assert.equal(zonedToUtc('2026-07-01', '10:00', 'Europe/London').toISOString(), '2026-07-01T09:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01', '10:00', 'Europe/London').toISOString(), '2026-12-01T10:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01', '10:00', 'Asia/Dubai').toISOString(), '2026-12-01T06:00:00.000Z');
});

test('booking in the chat: service → day → time → confirm; team confirms; capacity; reminder; cancel from reminder', async () => {
  const t = makeTenant({
    whatsapp: { phoneNumberId: '1', accessToken: 'x' },
    store: { type: 'none' },
    bookings: { enabled: true, services: [{ name: 'Test day', minutes: 60, price: 120 }, { name: 'Taster', minutes: 30, price: 40 }], times: ['10:00', '14:00'], days: 7, leadHours: 0, perSlot: 1 },
  });
  const prev = globalThis.fetch;
  globalThis.fetch = async () => okFetch();
  try {
    const wa = '447700911001';
    let r = await say(t, wa, 'hi');
    assert.ok(ids(r).includes('book'));
    r = await say(t, wa, 'book');
    assert.deepEqual(ids(r), ['bsvc:0', 'bsvc:1']);
    r = await say(t, wa, { action: 'bsvc:1' });
    const day = ids(r)[0];
    assert.match(day, /^bday:\d{4}-\d{2}-\d{2}$/);
    r = await say(t, wa, { action: day });
    const time = ids(r)[0];
    assert.match(time, /^btime:\d{2}:\d{2}$/);
    r = await say(t, wa, { action: time });
    assert.ok(ids(r).includes('bconfirm'));
    assert.match(r[0].text, /Taster/);
    r = await say(t, wa, { action: 'bconfirm' });
    assert.match(r[0].text, /booking request/);
    let [b] = listBookings(t.id);
    assert.equal(b.status, 'requested');
    assert.equal(b.service, 'Taster');

    // the same slot can't be booked twice (perSlot 1)
    const free = freeDays(tenants.getTenant(t.id));
    const sameDay = free.find((d) => `bday:${d.ymd}` === day);
    assert.ok(!sameDay || sameDay.free === 1 || sameDay.free < 2);

    // team confirms → customer told
    const before = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND wa_id = ? AND direction = 'out'").get(t.id, wa).n;
    b = await setBookingStatus(tenants.getTenant(t.id), b.id, 'confirmed');
    assert.equal(b.status, 'confirmed');
    const after = getDb().prepare("SELECT body FROM messages WHERE tenant_id = ? AND wa_id = ? AND direction = 'out' ORDER BY id DESC").all(t.id, wa);
    assert.equal(after.length, before + 1);
    assert.match(JSON.parse(after[0].body).text, /confirmed/);

    // reminder when it's within 24h, once
    getDb().prepare("UPDATE bookings SET starts_at = datetime('now', '+3 hours') WHERE id = ?").run(b.id);
    assert.equal(await runBookingJobs(), 1);
    assert.equal(await runBookingJobs(), 0);
    const rem = JSON.parse(getDb().prepare("SELECT body FROM messages WHERE tenant_id = ? AND wa_id = ? AND direction = 'out' ORDER BY id DESC").get(t.id, wa).body);
    assert.match(rem.text, /Reminder/);
    assert.ok(rem.buttons.some((x) => x.id === `bcxl:${b.id}`));
    r = await say(t, wa, { action: `bcxl:${b.id}` });
    assert.match(r[0].text, /cancelled/);
    assert.equal(listBookings(t.id)[0].status, 'cancelled');
  } finally { globalThis.fetch = prev; }
});

test('deposit paid via Stripe confirms the booking', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: '1', accessToken: 'x' }, store: { type: 'none' }, bookings: { enabled: true, times: ['10:00'] } });
  const id = Number(getDb().prepare("INSERT INTO bookings (tenant_id, wa_id, name, day, time, starts_at, status, deposit) VALUES (?, '447700911009', 'Sam', '2026-12-01', '10:00', '2026-12-01 10:00:00', 'awaiting_deposit', 20)").run(t.id).lastInsertRowid);
  const prev = globalThis.fetch;
  globalThis.fetch = async () => okFetch();
  try {
    assert.equal(await bookingDepositPaid(tenants.getTenant(t.id), { metadata: { booking_id: String(id) } }), true);
    assert.equal(await bookingDepositPaid(tenants.getTenant(t.id), { metadata: { order_id: '5' } }), false);
  } finally { globalThis.fetch = prev; }
  const b = getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.deposit_paid, 1);
});

test('voice note: downloaded, transcribed, echoed, then answered like text', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: '1', accessToken: 'x' } });
  const prevCfg = { ...config };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', aiAudioModel: 'audio-model', embeddingsModel: '' });
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes('graph.facebook.com') && url.includes('MEDIA1')) return new Response(JSON.stringify({ url: 'https://media.test/v.ogg', mime_type: 'audio/ogg; codecs=opus' }));
    if (url === 'https://media.test/v.ogg') return new Response(Buffer.from('OggS fake audio'), { headers: { 'content-type': 'audio/ogg' } });
    if (url.startsWith('https://ai.test/v1/chat/completions')) {
      const body = JSON.parse(opts.body);
      calls.push(body);
      const audio = body.messages[0]?.content?.[1]?.type === 'input_audio';
      return new Response(JSON.stringify({ choices: [{ message: { content: audio ? 'Do you deliver to Leeds?' : 'Yes, we deliver to Leeds.' } }], usage: { total_tokens: 10 } }));
    }
    return okFetch();
  };
  try {
    const sent = [];
    getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, wa_message_id) VALUES (?, '447700911050', 'in', 'audio', '{\"type\":\"audio\",\"text\":\"[audio]\"}', 'wamid.voice1')").run(t.id);
    await engine.handleInbound(tenants.getTenant(t.id), { waId: '447700911050', messageId: 'wamid.voice1', kind: 'media', type: 'audio', mediaId: 'MEDIA1', mime: 'audio/ogg; codecs=opus', voice: true, text: '[audio]', profileName: 'Kim' }, async (to, m) => sent.push(m));
    const audioCall = calls.find((c) => c.model === 'audio-model');
    assert.ok(audioCall, 'transcription call made');
    assert.equal(audioCall.messages[0].content[1].input_audio.format, 'ogg');
    assert.equal(audioCall.provider?.data_collection, undefined); // only for OpenRouter
    const texts = sent.map((m) => m.text || '').join('\n');
    assert.match(texts, /🎙️ _"Do you deliver to Leeds\?"_/);
    assert.match(texts, /Yes, we deliver to Leeds/);
    const logged = JSON.parse(getDb().prepare("SELECT body FROM messages WHERE wa_message_id = 'wamid.voice1'").get().body);
    assert.equal(logged.transcript, 'Do you deliver to Leeds?');
  } finally { globalThis.fetch = prev; Object.assign(config, prevCfg); }
});

test('voice note with no speech: no invented transcript, polite fallback', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: '1', accessToken: 'x' } });
  const prevCfg = { ...config };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', aiAudioModel: 'audio-model' });
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('graph.facebook.com')) return new Response(JSON.stringify({ url: 'https://media.test/n.ogg', mime_type: 'audio/ogg' }));
    if (url === 'https://media.test/n.ogg') return new Response(Buffer.from('OggS'));
    if (url.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: 'NO_SPEECH' } }] }));
    return okFetch();
  };
  try {
    const sent = [];
    await engine.handleInbound(tenants.getTenant(t.id), { waId: '447700911070', kind: 'media', type: 'audio', mediaId: 'M3', mime: 'audio/ogg', text: '[audio]' }, async (to, m) => sent.push(m));
    const all = sent.map((m) => m.text).join(' ');
    assert.match(all, /couldn't make out any words/);
    assert.doesNotMatch(all, /NO_SPEECH/);
  } finally { globalThis.fetch = prev; Object.assign(config, prevCfg); }
});

test('voice note when voice is switched off: polite fallback', async () => {
  const t = makeTenant({ ai: { voiceNotes: false } });
  const sent = [];
  await engine.handleInbound(tenants.getTenant(t.id), { waId: '447700911060', kind: 'media', type: 'audio', mediaId: 'M2', mime: 'audio/ogg', text: '[audio]' }, async (to, m) => sent.push(m));
  assert.match(sent.map((m) => m.text).join(' '), /can't listen to voice notes/);
});
