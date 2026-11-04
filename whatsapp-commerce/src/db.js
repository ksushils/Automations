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
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  triggers TEXT NOT NULL DEFAULT '{}',
  steps TEXT NOT NULL DEFAULT '[]',
  runs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  run_at TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled(done, run_at);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en_GB',
  components TEXT,
  audience TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_at TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS message_status (
  tenant_id TEXT NOT NULL,
  wa_message_id TEXT NOT NULL,
  wa_id TEXT NOT NULL,
  campaign_id INTEGER,
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT,
  replied INTEGER NOT NULL DEFAULT 0,
  clicked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, wa_message_id)
);
CREATE INDEX IF NOT EXISTS idx_msgstatus_campaign ON message_status(tenant_id, campaign_id);
CREATE TABLE IF NOT EXISTS store_events (
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  phone TEXT,
  data TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, kind, ref)
);
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'text',
  url TEXT,
  mime TEXT,
  text TEXT,
  file BLOB,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  dify_document_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kdocs_tenant ON knowledge_docs(tenant_id, status);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
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

// Columns added after v1 – applied to existing databases on start.
const MIGRATIONS = {
  orders: { discount: 'REAL NOT NULL DEFAULT 0', delivery_fee: 'REAL NOT NULL DEFAULT 0', promo_code: 'TEXT', slot: 'TEXT', receipt_token: 'TEXT', paid_at: 'TEXT', reminded_at: 'TEXT', stripe_session_id: 'TEXT' },
  customers: { last_inbound_at: 'TEXT', winback_sent_at: 'TEXT', tags: "TEXT NOT NULL DEFAULT '[]'", attributes: "TEXT NOT NULL DEFAULT '{}'", source: 'TEXT' },
  conversations: { assigned_to: 'TEXT' },
  tenants: { owner_email: 'TEXT', stripe_customer_id: 'TEXT', subscription_id: 'TEXT', subscription_status: 'TEXT', trial_ends_at: 'TEXT' },
};

export function initDb(file = config.databasePath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  for (const [table, cols] of Object.entries(MIGRATIONS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, def] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_receipt ON orders(receipt_token) WHERE receipt_token IS NOT NULL");
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
  'whatsapp.twoStepPin',
  'dify.apiKey',
  'dify.assistApiKey',
  'dify.agentApiKey',
  'store.shopify.adminToken',
  'store.woocommerce.consumerKey',
  'store.woocommerce.consumerSecret',
  'store.custom.apiKey',
  'store.shopify.webhookSecret',
  'store.woocommerce.webhookSecret',
  'payments.stripe.secretKey',
  'payments.stripe.webhookSecret',
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
