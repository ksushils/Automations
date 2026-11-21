import { getDb, json } from './db.js';

/*
 * One customer, everything we know, for the Inbox side panel: who they are, where they came from, their orders,
 * bookings, leads, tickets and ratings, the team's private notes, and totals (spent, orders, first/last seen).
 */
export function customerProfile(tenantId, waId) {
  const d = getDb();
  const c = d.prepare('SELECT * FROM customers WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId);
  const attrs = json(c?.attributes, {}) || {};
  const orders = d.prepare("SELECT id, store_order_name, subtotal, status, payment_status, created_at FROM orders WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC LIMIT 10").all(tenantId, waId);
  const spent = d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(subtotal), 0) AS v FROM orders WHERE tenant_id = ? AND wa_id = ? AND status != 'cancelled'").get(tenantId, waId);
  const bookings = d.prepare('SELECT id, service, day, time, status FROM bookings WHERE tenant_id = ? AND wa_id = ? ORDER BY starts_at DESC LIMIT 10').all(tenantId, waId);
  const leads = d.prepare('SELECT id, kind, topic, status, created_at FROM chat_leads WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC LIMIT 10').all(tenantId, waId);
  const tickets = d.prepare('SELECT number, subject, status, created_at FROM tickets WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC LIMIT 10').all(tenantId, waId);
  const ratings = d.prepare('SELECT score, comment, created_at FROM chat_ratings WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC LIMIT 5').all(tenantId, waId);
  const first = d.prepare('SELECT MIN(created_at) AS a, COUNT(*) AS n FROM messages WHERE tenant_id = ? AND wa_id = ? AND direction = \'in\'').get(tenantId, waId);
  const src = json(c?.source, null);
  return {
    waId,
    channel: String(waId).startsWith('web:') ? 'website' : 'whatsapp',
    name: c?.name || null,
    email: c?.email || null,
    phone: attrs.phone || (String(waId).startsWith('web:') ? null : `+${waId}`),
    tags: json(c?.tags, []) || [],
    notes: String(attrs.notes || ''),
    marketing: !!c?.opted_in_marketing,
    source: src ? (src.headline || src.source_url || src.utm_campaign || src.utm_source || (src.source_id ? `Ad ${src.source_id}` : null)) : null,
    firstSeen: first.a, lastSeen: c?.last_seen_at || null, messages: first.n,
    totals: { orders: spent.n, spent: Math.round(spent.v * 100) / 100, bookings: bookings.length, leads: leads.length, tickets: tickets.length },
    orders, bookings, leads, tickets, ratings,
  };
}

export function saveCustomerNotes(tenantId, waId, { notes, tags }) {
  const d = getDb();
  d.prepare("INSERT INTO customers (tenant_id, wa_id) VALUES (?, ?) ON CONFLICT(tenant_id, wa_id) DO NOTHING").run(tenantId, waId);
  if (notes !== undefined) d.prepare("UPDATE customers SET attributes = json_set(COALESCE(attributes, '{}'), '$.notes', ?) WHERE tenant_id = ? AND wa_id = ?").run(String(notes).slice(0, 4000), tenantId, waId);
  if (Array.isArray(tags)) d.prepare('UPDATE customers SET tags = ? WHERE tenant_id = ? AND wa_id = ?').run(JSON.stringify([...new Set(tags.map((x) => String(x).trim().slice(0, 30)).filter(Boolean))].slice(0, 20)), tenantId, waId);
  return customerProfile(tenantId, waId);
}
