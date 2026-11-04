import { getDb, json } from '../db.js';

export function getConversation(tenantId, waId) {
  const d = getDb();
  let row = d.prepare('SELECT * FROM conversations WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId);
  if (!row) {
    d.prepare('INSERT INTO conversations (tenant_id, wa_id) VALUES (?, ?)').run(tenantId, waId);
    row = d.prepare('SELECT * FROM conversations WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId);
  }
  return {
    id: row.id,
    tenantId,
    waId,
    state: row.state,
    data: json(row.state_data, {}),
    cart: json(row.cart, []),
    difyConversationId: row.dify_conversation_id,
    humanHandover: !!row.human_handover,
    updatedAt: row.updated_at,
  };
}

export function saveConversation(c) {
  getDb()
    .prepare(`UPDATE conversations SET state = ?, state_data = ?, cart = ?, dify_conversation_id = ?, human_handover = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(c.state, JSON.stringify(c.data || {}), JSON.stringify(c.cart || []), c.difyConversationId || null, c.humanHandover ? 1 : 0, c.id);
}

export function setHandover(tenantId, waId, on) {
  const c = getConversation(tenantId, waId);
  c.humanHandover = !!on;
  if (!on) c.state = 'idle';
  saveConversation(c);
  return c;
}

export function upsertCustomer(tenantId, waId, profileName) {
  const d = getDb();
  d.prepare(
    `INSERT INTO customers (tenant_id, wa_id, name, last_seen_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(tenant_id, wa_id) DO UPDATE SET last_seen_at = datetime('now'), name = COALESCE(customers.name, excluded.name)`,
  ).run(tenantId, waId, profileName || null);
  return d.prepare('SELECT * FROM customers WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId);
}

export function updateCustomer(tenantId, waId, fields) {
  const allowed = ['name', 'email', 'address', 'opted_in_marketing'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  getDb()
    .prepare(`UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND wa_id = ?`)
    .run(...keys.map((k) => fields[k]), tenantId, waId);
}
