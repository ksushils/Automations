import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, tenants } = await import('./helpers.js');
const { getDb } = await import('../src/db.js');
const { updateLead } = await import('../src/leads.js');
const { setBookingStatus } = await import('../src/bookings.js');
const { syncOutcomes, readEvents, summary, customerRef, createReportingKey, revokeReportingKey } = await import('../src/outcomes.js');
const { createStaff } = await import('../src/staff.js');
const { createApp } = await import('../src/server.js');

/*
 * Fixtures only: records are inserted the way the chat engine writes them. No WhatsApp credentials, no network
 * (fetch is replaced with one that fails if anything tries to go out).
 */
const d = () => getDb();
const noNetwork = () => { const prev = globalThis.fetch; globalThis.fetch = async (u, o) => { if (String(u).startsWith('http://127.0.0.1')) return prev(u, o); throw new Error(`network call in test: ${u}`); }; return () => { globalThis.fetch = prev; }; };
const ago = (min) => new Date(Date.now() - min * 60000).toISOString().replace('T', ' ').slice(0, 19);

function fixture() {
  const t = makeTenant({ store: { type: 'none' }, business: { name: 'Fixture Plumbing' } });
  const db = d();
  const wa = '447700900301', web = 'web:fixtureSessionAAAA1111';
  // a WhatsApp customer who came from a Click-to-WhatsApp ad
  db.prepare("INSERT INTO customers (tenant_id, wa_id, name, source) VALUES (?, ?, 'Dave Private', ?)").run(t.id, wa, JSON.stringify({ source_id: '120208', source_type: 'ad', headline: 'Leak?' }));
  // conversation: customer writes, assistant replies 4 s later; next day writes again, staff reply after 10 min
  db.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, ?, 'in', 'text', ?, ?)").run(t.id, wa, JSON.stringify({ text: 'My ceiling is leaking, I live at 12 Secret Road' }), ago(3000));
  db.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, ?, 'out', 'text', ?, datetime(?, '+4 seconds'))").run(t.id, wa, JSON.stringify({ text: 'Sorry to hear that!' }), ago(3000));
  db.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, ?, 'in', 'text', ?, ?)").run(t.id, wa, JSON.stringify({ text: 'Any update?' }), ago(100));
  db.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, ?, 'out', 'text', ?, ?)").run(t.id, wa, JSON.stringify({ text: 'On my way', staff: 'Sam' }), ago(90));
  // a website visitor from a tagged link, and a test-bot chat that must be ignored
  db.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, ?, 'in', 'text', ?, ?)").run(t.id, web, JSON.stringify({ text: 'Price for a boiler service?' }), ago(500));
  db.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, ?, 'in', 'text', ?, ?)").run(t.id, 'qa:check', JSON.stringify({ text: 'test' }), ago(400));
  db.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, '440000000000', 'in', 'text', ?, ?)").run(t.id, JSON.stringify({ text: 'simulator', simulated: true }), ago(400));
  // leads
  const lead = Number(db.prepare("INSERT INTO chat_leads (tenant_id, wa_id, channel, kind, topic, name, email, phone, message, answers, urgent, page, created_at) VALUES (?, ?, 'whatsapp', 'call', 'Emergency leak', 'Dave Private', 'dave@private.example', '+447700900301', 'Job: leak at 12 Secret Road', ?, 1, 'https://fixture.example/leaks?email=dave@private.example', ?)").run(t.id, wa, JSON.stringify([{ key: 'job', label: 'Job', a: 'leak at 12 Secret Road' }]), ago(2990)).lastInsertRowid);
  const webLead = Number(db.prepare("INSERT INTO chat_leads (tenant_id, wa_id, channel, kind, name, source, page, created_at) VALUES (?, ?, 'web', 'email', 'Web Person', ?, 'https://fixture.example/boilers', ?)").run(t.id, web, JSON.stringify({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'boilers-nov' }), ago(495)).lastInsertRowid);
  const oldWon = Number(db.prepare("INSERT INTO chat_leads (tenant_id, wa_id, channel, kind, name, status, contacted_at, won_at, value, created_at) VALUES (?, '447700900302', 'whatsapp', 'call', 'Old Win', 'won', ?, ?, 300, ?)").run(t.id, ago(4000), ago(3900), ago(4100)).lastInsertRowid);
  // bookings, quotes, orders
  const bk = Number(db.prepare("INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status, deposit, deposit_paid, created_at) VALUES (?, ?, 'Dave Private', 'Boiler service', '2026-12-01', '10:00', '2026-12-01 10:00:00', 'requested', 20, 1, ?)").run(t.id, wa, ago(80)).lastInsertRowid);
  const bk2 = Number(db.prepare("INSERT INTO bookings (tenant_id, wa_id, service, day, time, starts_at, status, created_at) VALUES (?, ?, 'Leak visit', '2026-12-02', '10:00', '2026-12-02 10:00:00', 'requested', ?)").run(t.id, web, ago(70)).lastInsertRowid);
  db.prepare("INSERT INTO quotes (tenant_id, number, token, wa_id, name, request, items, total, status, sent_at, accepted_at, created_at) VALUES (?, 1001, 'tok-out-' || lower(hex(randomblob(6))), ?, 'Dave Private', 'replace tap at 12 Secret Road', '[]', 145, 'accepted', ?, ?, ?)").run(t.id, wa, ago(60), ago(50), ago(70));
  db.prepare("INSERT INTO orders (tenant_id, wa_id, status, payment_status, payment_method, items, subtotal, customer_name, address, stripe_session_id, paid_at, created_at, updated_at) VALUES (?, ?, 'confirmed', 'paid', 'payment_link', '[]', 35.5, 'Dave Private', '12 Secret Road', 'cs_test_1', ?, ?, ?)").run(t.id, wa, ago(40), ago(45), ago(40));
  db.prepare("INSERT INTO orders (tenant_id, wa_id, status, payment_status, payment_method, items, subtotal, created_at, updated_at) VALUES (?, ?, 'completed', 'unpaid', 'cod', '[]', 20, ?, ?)").run(t.id, web, ago(35), ago(30));
  return { t: tenants.getTenant(t.id), wa, web, lead, webLead, oldWon, bk, bk2 };
}

test('owner marks NEW → CONTACTED → QUALIFIED → WON with a value; each change is an event with who and when; the value carries its provenance', async () => {
  const restore = noNetwork();
  try {
    const f = fixture();
    updateLead(f.t.id, f.lead, { status: 'contacted' }, { actor: 'staff:Sam' });
    updateLead(f.t.id, f.lead, { status: 'qualified' }, { actor: 'owner' });
    updateLead(f.t.id, f.lead, { value: 450 }, { actor: 'owner' });
    updateLead(f.t.id, f.lead, { status: 'won' }, { actor: 'owner' });
    const row = d().prepare('SELECT * FROM chat_leads WHERE id = ?').get(f.lead);
    assert.ok(row.contacted_at && row.qualified_at && row.won_at && row.closed_at);
    assert.deepEqual([row.value, row.value_source, row.value_set_by], [450, 'owner_entered', 'owner']);
    syncOutcomes(f.t);
    const ev = readEvents(f.t.id, { limit: 500 }).events.filter((e) => e.subject.id === `lead_${f.lead}`);
    assert.deepEqual(ev.map((e) => e.type), ['enquiry.created', 'lead.status_changed', 'lead.status_changed', 'lead.value_set', 'lead.status_changed']);
    assert.deepEqual(ev.filter((e) => e.type === 'lead.status_changed').map((e) => [e.data.from, e.data.to, e.data.actor]), [['new', 'contacted', 'staff'], ['contacted', 'qualified', 'owner'], ['qualified', 'won', 'owner']]);
    const won = ev.at(-1);
    assert.deepEqual([won.data.value, won.data.provenance, won.data.currency], [450, 'owner_entered', 'GBP']);
    // lost after qualified also works, and reopening is allowed (owners correct mistakes)
    updateLead(f.t.id, f.webLead, { status: 'lost' }, { actor: 'owner' });
    updateLead(f.t.id, f.webLead, { status: 'contacted' }, { actor: 'owner' });
    assert.equal(d().prepare('SELECT closed_at FROM chat_leads WHERE id = ?').get(f.webLead).closed_at, null);
    assert.throws(() => updateLead(f.t.id, f.lead, { status: 'maybe' }), /bad status/);
  } finally { restore(); }
});

test('data minimisation: no names, phones, emails, addresses, message text or answers; page query strings removed; customer ids pseudonymous and per business', () => {
  const f = fixture();
  syncOutcomes(f.t);
  const all = JSON.stringify(readEvents(f.t.id, { limit: 500 }).events);
  for (const secret of ['Dave Private', '7700900301', 'dave@private', 'Secret Road', 'ceiling is leaking', 'Web Person', 'Sorry to hear', 'On my way', 'Sam']) assert.ok(!all.includes(secret), `leaked: ${secret}`);
  assert.match(all, /"landing_page":"https:\/\/fixture\.example\/leaks"/);
  const c = customerRef(f.t.id, f.wa);
  assert.match(c, /^c_[0-9a-f]{20}$/);
  assert.equal(customerRef(f.t.id, f.wa), c, 'stable');
  assert.notEqual(customerRef('another-business', f.wa), c, 'different per business');
  assert.ok(!all.includes('qa:check') && !all.includes('simulator'), 'test and simulator chats are left out');
});

test('stable ids and a cursor: re-syncing adds nothing; pages follow seq; new records appear after the cursor; types filter', async () => {
  const f = fixture();
  const n1 = syncOutcomes(f.t);
  assert.ok(n1 > 10);
  assert.equal(syncOutcomes(f.t), 0, 'idempotent – no duplicates');
  const p1 = readEvents(f.t.id, { after: 0, limit: 5 });
  assert.equal(p1.events.length, 5); assert.equal(p1.has_more, true);
  const p2 = readEvents(f.t.id, { after: p1.next_after, limit: 500 });
  const ids = [...p1.events, ...p2.events].map((e) => e.event_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...p1.events, ...p2.events].map((e) => e.seq), [...p1.events, ...p2.events].map((e) => e.seq).sort((a, b) => a - b));
  const last = p2.next_after;
  await setBookingStatus(f.t, f.bk2, 'confirmed');
  syncOutcomes(f.t);
  const p3 = readEvents(f.t.id, { after: last });
  assert.deepEqual(p3.events.map((e) => [e.type, e.subject.id]), [['booking.confirmed', `booking_${f.bk2}`]]);
  assert.equal(readEvents(f.t.id, { after: 0, types: ['order.paid'] }).events.length, 1);
});

test('summary: enquiries by source and channel, conversations, response times, qualified/won, bookings, quotes, orders, verified value kept apart from owner-entered', async () => {
  const f = fixture();
  updateLead(f.t.id, f.lead, { status: 'contacted' }, { actor: 'owner' });
  updateLead(f.t.id, f.lead, { status: 'qualified' }, { actor: 'owner' });
  updateLead(f.t.id, f.lead, { value: 450, status: 'won' }, { actor: 'owner' });
  await setBookingStatus(f.t, f.bk, 'confirmed');
  await setBookingStatus(f.t, f.bk2, 'cancelled');
  syncOutcomes(f.t);
  const s = summary(f.t, { from: new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
  assert.equal(s.enquiries.total, 3);
  assert.deepEqual(s.enquiries.by_channel, { website: 1, whatsapp: 2 });
  assert.equal(s.enquiries.by_source.ctwa_ad, 1); assert.equal(s.enquiries.by_source.utm, 1);
  assert.equal(s.conversations.started, 3, 'two WhatsApp conversations (24 h apart) + one website');
  assert.equal(s.response_times.assistant_replies, 1); assert.equal(s.response_times.staff_first_replies, 1);
  assert.ok(s.response_times.first_reply_seconds_median >= 4);
  assert.equal(s.leads.qualified, 1); assert.equal(s.leads.won, 2, 'including the one won before history was kept (back-filled)');
  assert.equal(s.leads.won_value_owner_entered, 750);
  assert.deepEqual([s.bookings.requested, s.bookings.confirmed, s.bookings.cancelled, s.bookings.deposits_paid_value], [2, 1, 1, 20]);
  assert.deepEqual([s.quotes.sent_value, s.quotes.accepted, s.quotes.accepted_value], [145, 1, 145]);
  assert.deepEqual([s.orders.paid_value, s.orders.cash_completed_value], [35.5, 20]);
  assert.equal(s.verified_value, 220.5, 'paid 35.5 + cash 20 + accepted quote 145 + deposit 20 – owner-entered 750 is not included');
  const ctwa = readEvents(f.t.id, { limit: 500 }).events.find((e) => e.type === 'enquiry.created' && e.source.type === 'ctwa_ad');
  assert.equal(ctwa.source.ad_id, '120208');
  const bf = readEvents(f.t.id, { limit: 500 }).events.find((e) => e.subject.id === `lead_${f.oldWon}` && e.type === 'lead.status_changed');
  assert.equal(bf.data.backfilled, true); assert.equal(bf.data.value, 300);
  assert.throws(() => summary(f.t, { from: '2026-01-01', to: '2025-01-01' }), /after/);
});

test('API: reporting key only (admin, staff and super-admin keys refused), one business per key, revocable, clear errors, rate limit; owners only create keys', async () => {
  const restore = noNetwork();
  const f = fixture();
  const other = makeTenant({ store: { type: 'none' } });
  d().prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, name) VALUES (?, '447700900399', 'call', 'Other Biz Lead')").run(other.id);
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, key) => fetch(base + path, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  try {
    // creating keys: owner (or platform) only
    const staffKey = createStaff(f.t.id, { name: 'Sam' }).key;
    assert.equal((await fetch(`${base}/api/tenants/${f.t.id}/reporting-keys`, { method: 'POST', headers: { Authorization: `Bearer ${staffKey}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const made = await fetch(`${base}/api/tenants/${f.t.id}/reporting-keys`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Demo Engine' }) });
    assert.equal(made.status, 201);
    const key = (await made.json()).key;
    assert.match(key, /^rpt_/);
    assert.equal(d().prepare('SELECT COUNT(*) AS n FROM reporting_keys WHERE key_hash = ?').get(key).n, 0, 'only a hash is stored');
    // the outcomes API
    assert.equal((await get('/api/v1/outcomes/events')).status, 401);
    assert.equal((await get('/api/v1/outcomes/events', process.env.SUPER_ADMIN_KEY)).status, 401, 'super-admin key not accepted');
    assert.equal((await get('/api/v1/outcomes/events', staffKey)).status, 401);
    const ok = await get('/api/v1/outcomes/events?limit=500', key);
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('x-outcomes-version'), '1');
    const body = await ok.json();
    assert.equal(body.tenant, f.t.id);
    assert.ok(body.events.length > 10);
    assert.ok(!JSON.stringify(body).includes('Other Biz Lead') && body.events.every((e) => e.customer === null || e.customer.startsWith('c_')));
    // a key for business A can't be pointed at business B (the business comes from the key, not the URL)
    assert.equal((await get(`/api/v1/outcomes/events?tenant=${other.id}`, key).then((r) => r.json())).tenant, f.t.id);
    const sch = await (await get('/api/v1/outcomes/schema', key)).json();
    assert.ok(sch.event_types['quote.accepted']); assert.deepEqual(sch.lead_statuses, ['new', 'contacted', 'qualified', 'won', 'lost']);
    const sum = await get('/api/v1/outcomes/summary', key);
    assert.equal(sum.status, 200); assert.equal((await sum.json()).enquiries.total, 3);
    for (const [q, code] of [['/api/v1/outcomes/events?after=-1', 'invalid_parameter'], ['/api/v1/outcomes/events?limit=9999', 'invalid_parameter'], ['/api/v1/outcomes/events?types=nope', 'invalid_parameter'], ['/api/v1/outcomes/summary?from=2026-01-01&to=2028-01-01', 'invalid_parameter']]) {
      const r = await get(q, key); assert.equal(r.status, 400, q); assert.equal((await r.json()).error.code, code);
    }
    assert.equal((await get('/api/v1/outcomes/nope', key)).status, 404);
    // revoked: refused straight away
    const k2 = createReportingKey(f.t.id, { label: 'temp' });
    assert.equal((await get('/api/v1/outcomes/schema', k2.key)).status, 200);
    revokeReportingKey(f.t.id, k2.id);
    const rv = await get('/api/v1/outcomes/schema', k2.key);
    assert.equal(rv.status, 401); assert.equal((await rv.json()).error.code, 'key_revoked');
    // another business's owner can't revoke this business's key
    const otherAdmin = tenants.createTenant({ name: 'Third' }).adminKey;
    assert.ok([401, 403].includes((await fetch(`${base}/api/tenants/${f.t.id}/reporting-keys/1`, { method: 'DELETE', headers: { Authorization: `Bearer ${otherAdmin}` } })).status));
    // inactive business
    d().prepare('UPDATE tenants SET active = 0 WHERE id = ?').run(f.t.id);
    assert.equal((await get('/api/v1/outcomes/schema', key)).status, 403);
    d().prepare('UPDATE tenants SET active = 1 WHERE id = ?').run(f.t.id);
    // rate limit: 120 a minute per key
    const k3 = createReportingKey(f.t.id, { label: 'burst' }).key;
    let last = 200;
    for (let i = 0; i < 121; i++) last = (await get('/api/v1/outcomes/schema', k3)).status;
    assert.equal(last, 429);
    assert.ok(d().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action IN ('reporting_key.created', 'outcomes.read')").get(f.t.id).n >= 2, 'creation and use are audited');
  } finally { server.close(); restore(); }
});
