import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, say } = await import('./helpers.js');
const { getDb } = await import('../src/db.js');
const { briefingText, runMorningBriefings } = await import('../src/briefing.js');

test('morning briefing: yesterday in numbers, today\'s bookings, what needs the owner; sent once at 8am shop time', async () => {
  const t = makeTenant({ whatsapp: { phoneNumberId: '1', accessToken: 'x' }, notifications: { staffWaIds: ['447700900500'] }, business: { timezone: 'Europe/London' } });
  const now = new Date('2026-11-16T08:20:00Z'); // 08:20 in London (GMT)
  const ins = getDb().prepare('INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(t.id, '447700900601', 'in', 'text', '{"text":"do you deliver?"}', '2026-11-15 10:00:00');
  ins.run(t.id, '447700900602', 'in', 'text', '{"text":"refund please"}', '2026-11-15 18:00:00');
  ins.run(t.id, '447700900603', 'in', 'text', '{"text":"too old"}', '2026-11-14 18:00:00');
  getDb().prepare("INSERT INTO orders (tenant_id, wa_id, status, items, subtotal, created_at) VALUES (?, '447700900601', 'new', '[]', 42, '2026-11-15 10:05:00')").run(t.id);
  getDb().prepare("INSERT INTO conversations (tenant_id, wa_id, human_handover) VALUES (?, '447700900602', 1)").run(t.id);
  getDb().prepare("INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status) VALUES (?, '447700900604', 'Sam', 'Haircut', '2026-11-16', '14:00', '2099-11-16 14:00:00', 'confirmed')").run(t.id);
  const { text, quiet } = briefingText(t, now);
  assert.equal(quiet, false);
  assert.match(text, /2 conversations/);
  assert.match(text, /1 order · £42/);
  assert.match(text, /14:00 Sam – Haircut/);
  assert.match(text, /1 chat waiting for a person/);
  assert.match(text, /1 order to prepare/);

  // owner texting the shop number gets it on demand; customers don't
  getDb().prepare("UPDATE customers SET last_inbound_at = datetime('now') WHERE tenant_id = ?").run(t.id);
  const prev = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ id: 'w' }] }));
  try {
    const r = await say(t, '447700900500', 'briefing');
    assert.match(r[0].text, /Good morning/);
    const w = await say(t, '447700900500', 'waiting');
    assert.match(w[0].text, /refund please/);
    const c = await say(t, '447700900777', 'briefing');
    assert.doesNotMatch(c.map((m) => m.text).join(' '), /Good morning/);
    // scheduled: not at 7am, once at 8am
    assert.equal(await runMorningBriefings(new Date('2026-11-16T07:20:00Z')), 0);
    assert.equal(await runMorningBriefings(now), 1);
    assert.equal(await runMorningBriefings(now), 0);
  } finally { globalThis.fetch = prev; }
});
