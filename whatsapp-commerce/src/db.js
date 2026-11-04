import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'starter',
  active INTEGER NOT NULL DEFAULT 1,
  admin_key_hash TEXT NOT NULL,
  tool_key_hash TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  wa_id TEXT NOT NULL,
  name TEXT,
  email TEXT,
  address TEXT,
  opted_in_marketing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  UNIQUE(tenant_id, wa_id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  wa_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  state_data TEXT NOT NULL DEFAULT '{}',
  cart TEXT NOT NULL DEFAULT '[]',
  dify_conversation_id TEXT,
  human_handover INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, wa_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  wa_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT,
  wa_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_wa ON messages(tenant_id, wa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_waid ON messages(tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL AND direction = 'in';
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  wa_id TEXT NOT NULL,
  store_order_id TEXT,
  store_order_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  payment_method TEXT,
  fulfilment TEXT,
  items TEXT NOT NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  currency TEXT,
  customer_name TEXT,
  address TEXT,
  notes TEXT,
  checkout_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id, id);
CREATE TABLE IF NOT EXISTS usage (
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,
  inbound INTEGER NOT NULL DEFAULT 0,
  outbound INTEGER NOT NULL DEFAULT 0,
  ai_calls INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period)
);
`;

export function initDb(file = config.databasePath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function getDb() {
  if (!db) initDb();
  return db;
}

// ---------- Tenant settings ----------
// Secret fields are encrypted at rest. Paths are "section.field".
export const SECRET_FIELDS = [
  'whatsapp.accessToken',
  'whatsapp.appSecret',
  'dify.apiKey',
  'store.shopify.adminToken',
  'store.woocommerce.consumerKey',
  'store.woocommerce.consumerSecret',
  'store.custom.apiKey',
];

function walk(obj, pathStr, fn) {
  const parts = pathStr.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === 'object' && cur[parts.at(-1)] !== undefined) {
    cur[parts.at(-1)] = fn(cur[parts.at(-1)]);
  }
}

export function encryptSettings(settings) {
  const copy = structuredClone(settings);
  for (const f of SECRET_FIELDS) walk(copy, f, (v) => (typeof v === 'string' && !v.startsWith('enc:') ? encrypt(v) : v));
  return copy;
}

export function decryptSettings(settings) {
  const copy = structuredClone(settings);
  for (const f of SECRET_FIELDS) walk(copy, f, decrypt);
  return copy;
}

export function redactSettings(settings) {
  const copy = structuredClone(settings);
  for (const f of SECRET_FIELDS) walk(copy, f, (v) => (v ? '••••••' : v));
  return copy;
}

export function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = deepMerge(target[k] && typeof target[k] === 'object' ? target[k] : {}, v);
    } else if (v !== '••••••') {
      // the redaction placeholder means "unchanged"
      target[k] = v;
    }
  }
  return target;
}

export const json = (s, fallback) => {
  try { return JSON.parse(s); } catch { return fallback; }
};
