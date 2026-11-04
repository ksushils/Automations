import { getDb } from './db.js';
import { randomToken, sha256 } from './crypto.js';

/** Team members with their own login keys. Roles: "owner" (everything) or "staff" (orders, inbox, test bot, analytics). */
export const ROLES = ['owner', 'staff'];

export function createStaff(tenantId, { name, role = 'staff' }) {
  const key = 'stf_' + randomToken(24);
  const info = getDb().prepare('INSERT INTO staff (tenant_id, name, role, key_hash) VALUES (?, ?, ?, ?)').run(tenantId, String(name).slice(0, 80), ROLES.includes(role) ? role : 'staff', sha256(key));
  return { id: Number(info.lastInsertRowid), key };
}

export const listStaff = (tenantId) => getDb().prepare('SELECT id, name, role, created_at FROM staff WHERE tenant_id = ? ORDER BY id').all(tenantId);

export const deleteStaff = (tenantId, id) => getDb().prepare('DELETE FROM staff WHERE tenant_id = ? AND id = ?').run(tenantId, id);

export function authenticateStaff(tenantId, key) {
  if (!key || !String(key).startsWith('stf_')) return null;
  return getDb().prepare('SELECT id, name, role FROM staff WHERE tenant_id = ? AND key_hash = ?').get(tenantId, sha256(key)) || null;
}
