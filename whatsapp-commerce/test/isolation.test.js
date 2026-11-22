import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tenants } from './helpers.js';
import { createApp } from '../src/server.js';
import { getDb } from '../src/db.js';
import { createStaff } from '../src/staff.js';
import { createTicket } from '../src/tickets.js';
import { saveArticle } from '../src/help.js';
import { createQuote } from '../src/quotes.js';

/*
 * Tenant isolation: one business can never read or change another business's conversations, customers, leads,
 * orders, bookings, quotes, tickets, files or settings – neither by using its own key on the other business's
 * address, nor by putting the other business's record numbers into its own address (IDOR).
 */
async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const ADMIN_SRC = fs.readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
const ROUTES = [...ADMIN_SRC.matchAll(/r\.(get|post|put|patch|delete)\('(\/tenants\/:tenantId[^']*)',\s*([^\n]*)/g)].map((m) => ({ method: m[1].toUpperCase(), path: m[2], rest: m[3] }));

function seed() {
  const A = tenants.createTenant({ name: 'Alpha Plumbing', plan: 'growth' });
  const B = tenants.createTenant({ name: 'Beta Salon', plan: 'growth' });
  const d = getDb();
  const b = B.tenant.id;
  d.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, '447700900222', 'in', 'text', ?)").run(b, JSON.stringify({ text: 'SECRET-B-MESSAGE' }));
  d.prepare("INSERT INTO customers (tenant_id, wa_id, name) VALUES (?, '447700900222', 'Bea Customer')").run(b);
  const lead = Number(d.prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, name, phone, message) VALUES (?, '447700900222', 'call', 'Bea Lead', '07700900222', 'SECRET-B-LEAD')").run(b).lastInsertRowid);
  const order = Number(d.prepare("INSERT INTO orders (tenant_id, wa_id, store_order_name, status, items, subtotal) VALUES (?, '447700900222', 'B-1', 'pending', '[]', 10)").run(b).lastInsertRowid);
  const booking = Number(d.prepare("INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at) VALUES (?, '447700900222', 'Bea', 'Cut', '2030-01-01', '10:00', '2030-01-01T10:00:00Z')").run(b).lastInsertRowid);
  const ticket = createTicket(tenants.getTenant(b), { name: 'Bea', email: 'bea@example.test', subject: 'SECRET-B-TICKET', description: 'Private problem' });
  const article = saveArticle(b, { title: 'Beta secret article', body: 'Only for Beta Salon customers to read.', status: 'draft' });
  return { A, B, lead, order, booking, ticket, article };
}
const h = (k, json) => ({ Authorization: 'Bearer ' + k, ...(json ? { 'Content-Type': 'application/json' } : {}) });
const fill = (path, tenantId) => path.replace(':tenantId', tenantId).replace(/:(\w+)/g, '1');

test('every business route checks the key belongs to that business (static check)', () => {
  assert.ok(ROUTES.length > 100, `found ${ROUTES.length} routes`);
  const unguarded = ROUTES.filter((r) => !/^(requireTenant|requireSuper)\b/.test(r.rest.trim())); // requireSuper = platform owner only (stricter)
  assert.deepEqual(unguarded.map((r) => `${r.method} ${r.path}`), [], 'routes without requireTenant');
});

test("a business's key is refused on every route of another business (all methods)", () => withServer(async (base) => {
  const { A, B } = seed();
  const staffA = createStaff(A.tenant.id, { name: 'Alpha helper' });
  const failures = [];
  for (const r of ROUTES) {
    for (const key of [A.adminKey, staffA.key]) {
      const res = await fetch(base + '/api' + fill(r.path, B.tenant.id), { method: r.method, headers: h(key, r.method !== 'GET'), body: r.method === 'GET' ? undefined : '{}' });
      if (res.status !== 401) failures.push(`${r.method} ${r.path} → ${res.status}`);
    }
  }
  assert.deepEqual(failures, []);
}));

test("record numbers from another business can't be read or changed through your own address (IDOR)", () => withServer(async (base) => {
  const s = seed();
  const a = s.A.tenant.id, key = s.A.adminKey;
  const get = (p) => fetch(`${base}/api/tenants/${a}${p}`, { headers: h(key) });
  const send = (method, p, body = {}) => fetch(`${base}/api/tenants/${a}${p}`, { method, headers: h(key, true), body: JSON.stringify(body) });

  // conversations and customers
  const msgs = await (await get('/conversations/447700900222/messages')).json();
  assert.deepEqual(msgs.messages, []);
  const prof = await get('/customers/447700900222/profile');
  assert.ok(!(await prof.text()).includes('Bea Customer'));
  // tickets, articles, bookings, orders, quotes by number
  assert.equal((await get(`/tickets/${s.ticket.number}`)).status, 404);
  assert.equal((await send('PATCH', `/tickets/${s.ticket.number}`, { status: 'closed', reply: 'hijack' })).status >= 400, true);
  assert.equal((await get(`/help/${s.article.id}`)).status, 404);
  assert.equal((await send('DELETE', `/help/${s.article.id}`)).status, 200); // answers ok:false…
  assert.ok(getDb().prepare('SELECT 1 FROM help_articles WHERE id = ?').get(s.article.id), '…and the other business\'s article is untouched');
  assert.equal((await send('POST', `/bookings/${s.booking}/status`, { status: 'cancelled' })).status, 404);
  assert.equal((await send('PATCH', `/orders/${s.order}`, { status: 'cancelled' })).status, 404);
  await send('PATCH', `/leads/${s.lead}`, { status: 'lost' });

  const d = getDb();
  assert.equal(d.prepare('SELECT status FROM tickets WHERE id = ?').get(s.ticket.id).status, 'open');
  assert.equal(d.prepare('SELECT status FROM bookings WHERE id = ?').get(s.booking).status, 'requested');
  assert.equal(d.prepare('SELECT status FROM orders WHERE id = ?').get(s.order).status, 'pending');
  assert.equal(d.prepare('SELECT status FROM chat_leads WHERE id = ?').get(s.lead).status, 'new');

  // lists only ever contain your own records
  for (const p of ['/leads', '/tickets', '/quotes', '/help', '/orders', '/bookings', '/conversations', '/contacts']) {
    const res = await get(p);
    if (res.status === 404) continue; // route not present under this name
    const text = await res.text();
    assert.ok(!/SECRET-B|Bea /.test(text), `${p} leaked another business's data`);
  }
}));

test("quotes: another business's quote number is not reachable, and quote pages need the secret token", () => withServer(async (base) => {
  const s = seed();
  const qb = await createQuote(tenants.getTenant(s.B.tenant.id), { name: 'Bea', phone: '07700900222', request: 'Full colour and cut for a wedding' });
  const qa = await createQuote(tenants.getTenant(s.A.tenant.id), { name: 'Al', phone: '07700900111', request: 'Replace kitchen tap' });
  // both businesses may have a quote with the same number – each sees only its own
  const mine = await (await fetch(`${base}/api/tenants/${s.A.tenant.id}/quotes/${qb.number}`, { headers: h(s.A.adminKey) })).json();
  if (mine.quote) assert.equal(mine.quote.id, qa.id, 'got our own quote, not theirs');
  assert.equal((await fetch(`${base}/q/not-a-real-token`)).status, 404);
}));

test('staff keys cannot use owner-only routes (billing, staff, keys, data export)', () => withServer(async (base) => {
  const { A } = seed();
  const staff = createStaff(A.tenant.id, { name: 'Helper' });
  const ownerOnly = ROUTES.filter((r) => /requireOwner/.test(r.rest));
  assert.ok(ownerOnly.length > 20);
  const failures = [];
  for (const r of ownerOnly) {
    const res = await fetch(base + '/api' + fill(r.path, A.tenant.id), { method: r.method, headers: h(staff.key, r.method !== 'GET'), body: r.method === 'GET' ? undefined : '{}' });
    if (res.status !== 403) failures.push(`${r.method} ${r.path} → ${res.status}`);
  }
  assert.deepEqual(failures, []);
}));
