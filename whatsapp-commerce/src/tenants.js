import { getDb, encryptSettings, decryptSettings, deepMerge, json } from './db.js';
import { randomToken, sha256, safeEqual } from './crypto.js';
import { config } from './config.js';

/** Plans you sell. Limits are per calendar month. null = unlimited. */
export const PLANS = {
  starter: { label: 'Starter', priceGbp: 29, monthlyConversationsIn: 1000, aiCalls: 300, broadcasts: false, storeTypes: ['manual', 'shopify', 'woocommerce', 'custom'] },
  growth: { label: 'Growth', priceGbp: 79, monthlyConversationsIn: 5000, aiCalls: 3000, broadcasts: true, storeTypes: ['manual', 'shopify', 'woocommerce', 'custom'] },
  pro: { label: 'Pro', priceGbp: 199, monthlyConversationsIn: null, aiCalls: 20000, broadcasts: true, storeTypes: ['manual', 'shopify', 'woocommerce', 'custom'] },
};

export function defaultSettings(name) {
  return {
    business: {
      name,
      currency: 'GBP',
      currencySymbol: '£',
      welcomeMessage: `Hi{{name}}! 👋 Welcome to ${name}. Browse our products, ask me anything, or type *menu* at any time.`,
      supportHours: 'Mon–Fri 9am–5pm',
      timezone: 'Europe/London',
      whatsappNumber: '', // public number customers message, e.g. 447700900123 (used by the storefront page)
      customDomain: '', // e.g. order.myshop.co.uk → CNAME to this server to serve the storefront
      tagline: '',
      logoUrl: '',
    },
    whatsapp: {
      phoneNumberId: '',
      wabaId: '',
      accessToken: '',
      appSecret: '',
      verifyToken: randomToken(12),
    },
    dify: {
      enabled: false,
      baseUrl: config.difyBaseUrl,
      apiKey: '',
      // "assist": we search the store and hand product context to Dify (works with any Chatbot/Chatflow app)
      // "agent":  Dify Agent app calls our store tools (OpenAPI) itself
      mode: 'assist',
    },
    ai: {
      assistantName: `${name} assistant`,
      tone: 'friendly', // friendly | professional | playful | luxury
      about: '',
      faq: '',
      instructions: '',
      model: '', // "provider|model" – empty = server/Dify default
      temperature: 0.4,
    },
    store: {
      type: 'manual', // manual | shopify | woocommerce | custom
      shopify: { domain: '', adminToken: '', webhookSecret: '' },
      woocommerce: { url: '', consumerKey: '', consumerSecret: '', webhookSecret: '' },
      custom: { baseUrl: '', apiKey: '' },
      manual: {
        categories: [{ id: 'general', title: 'All products' }],
        products: [],
      },
    },
    ordering: {
      paymentMethods: ['payment_link', 'cod'], // payment_link | cod | bank_transfer
      bankDetails: '',
      fulfilment: ['delivery', 'pickup'], // delivery | pickup
      deliveryFee: 0,
      freeDeliveryOver: 0,
      minOrder: 0,
      pickupAddress: '',
      // [{ name: 'Central London', postcodes: ['SW1', 'W1', 'EC'], fee: 3.5, minOrder: 15, freeOver: 50 }] – empty = deliver anywhere
      deliveryZones: [],
      // [{ code: 'WELCOME10', type: 'percent'|'fixed'|'free_delivery', value: 10, minSpend: 0, expires: '2026-12-31', maxUses: 0, oncePerCustomer: false }]
      promoCodes: [],
      slots: { enabled: false, days: 3, times: ['10:00-12:00', '14:00-16:00', '18:00-20:00'], leadHours: 2, closedDays: [] },
      askNote: true, // customers can add a note (gift message, cutlery…) on the summary
      paymentReminderMinutes: 60, // remind unpaid online / bank-transfer orders (0 = off)
      lowStockAlert: 3, // built-in catalogue: alert staff when stock falls to this level
    },
    payments: {
      // Stripe Checkout for the built-in catalogue / custom stores (Shopify & WooCommerce use their own checkout)
      stripe: { secretKey: '', webhookSecret: '' },
    },
    notifications: {
      staffWaIds: [], // staff phone numbers (international, digits only) that get new-order alerts
      webhookUrl: '', // optional: POST every new order as JSON (Zapier/n8n/Make)
      abandonedCartMinutes: 120, // 0 disables reminders
      // Win-back: approved template sent to opted-in customers who haven't ordered for N days
      winBack: { enabled: false, template: '', language: 'en_GB', afterDays: 30 },
      // WhatsApp templates for orders placed on the website (Shopify / WooCommerce), not via WhatsApp
      storeTemplates: {
        orderConfirmation: { enabled: false, template: 'order_confirmation', language: 'en_GB' },
        shipping: { enabled: false, template: 'shipping_update', language: 'en_GB' },
        abandonedCheckout: { enabled: false, template: 'abandoned_cart', language: 'en_GB', afterMinutes: 60, requireMarketingConsent: true },
      },
      defaultCountryCode: '44', // used to turn local numbers (07…) into WhatsApp numbers
    },
    storeWebhookSecret: randomToken(18),
  };
}

const rowToTenant = (row) =>
  row && {
    id: row.id,
    name: row.name,
    plan: row.plan,
    active: !!row.active,
    createdAt: row.created_at,
    settings: decryptSettings(json(row.settings, {})),
  };

export function createTenant({ name, plan = 'starter', id }) {
  const tenantId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  const adminKey = 'adm_' + randomToken(24);
  const toolKey = 'tool_' + randomToken(24);
  const settings = defaultSettings(name);
  getDb()
    .prepare('INSERT INTO tenants (id, name, plan, admin_key_hash, tool_key_hash, settings) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tenantId, name, PLANS[plan] ? plan : 'starter', sha256(adminKey), sha256(toolKey), JSON.stringify(encryptSettings(settings)));
  return { tenant: getTenant(tenantId), adminKey, toolKey };
}

export function getTenant(id) {
  return rowToTenant(getDb().prepare('SELECT * FROM tenants WHERE id = ?').get(id));
}

export function listTenants() {
  return getDb().prepare('SELECT * FROM tenants ORDER BY created_at DESC').all().map(rowToTenant);
}

export function findTenantByPhoneNumberId(phoneNumberId) {
  // Small tenant counts: scan. Settings are encrypted only for secret fields, phoneNumberId is plain.
  for (const row of getDb().prepare('SELECT * FROM tenants WHERE active = 1').all()) {
    const s = json(row.settings, {});
    if (s?.whatsapp?.phoneNumberId && String(s.whatsapp.phoneNumberId) === String(phoneNumberId)) return rowToTenant(row);
  }
  return null;
}

export function updateTenantSettings(id, patch) {
  const t = getTenant(id);
  if (!t) return null;
  const merged = deepMerge(t.settings, patch);
  getDb().prepare('UPDATE tenants SET settings = ? WHERE id = ?').run(JSON.stringify(encryptSettings(merged)), id);
  return getTenant(id);
}

export function updateTenantMeta(id, { name, plan, active }) {
  const t = getTenant(id);
  if (!t) return null;
  getDb()
    .prepare('UPDATE tenants SET name = ?, plan = ?, active = ? WHERE id = ?')
    .run(name ?? t.name, plan && PLANS[plan] ? plan : t.plan, active === undefined ? (t.active ? 1 : 0) : active ? 1 : 0, id);
  return getTenant(id);
}

export function rotateKeys(id) {
  const adminKey = 'adm_' + randomToken(24);
  const toolKey = 'tool_' + randomToken(24);
  getDb().prepare('UPDATE tenants SET admin_key_hash = ?, tool_key_hash = ? WHERE id = ?').run(sha256(adminKey), sha256(toolKey), id);
  return { adminKey, toolKey };
}

/** New Dify tool key (used when pushing credentials to a Dify custom tool – only Dify needs it). */
export function rotateToolKey(id) {
  const toolKey = 'tool_' + randomToken(24);
  getDb().prepare('UPDATE tenants SET tool_key_hash = ? WHERE id = ?').run(sha256(toolKey), id);
  return toolKey;
}

export function deleteTenant(id) {
  const d = getDb();
  for (const table of ['messages', 'orders', 'conversations', 'customers', 'usage']) d.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(id);
  d.prepare('DELETE FROM tenants WHERE id = ?').run(id);
}

export function authenticateAdminKey(tenantId, key) {
  const row = getDb().prepare('SELECT admin_key_hash FROM tenants WHERE id = ?').get(tenantId);
  return !!row && !!key && safeEqual(row.admin_key_hash, sha256(key));
}

export function authenticateToolKey(tenantId, key) {
  const row = getDb().prepare('SELECT tool_key_hash FROM tenants WHERE id = ? AND active = 1').get(tenantId);
  return !!row && !!key && safeEqual(row.tool_key_hash, sha256(key));
}

// ---------- Usage metering ----------
const period = () => new Date().toISOString().slice(0, 7);

export function bumpUsage(tenantId, field, n = 1) {
  if (!['inbound', 'outbound', 'ai_calls', 'orders'].includes(field)) return;
  getDb()
    .prepare(`INSERT INTO usage (tenant_id, period, ${field}) VALUES (?, ?, ?) ON CONFLICT(tenant_id, period) DO UPDATE SET ${field} = ${field} + excluded.${field}`)
    .run(tenantId, period(), n);
}

export function getUsage(tenantId, p = period()) {
  return getDb().prepare('SELECT * FROM usage WHERE tenant_id = ? AND period = ?').get(tenantId, p) || { tenant_id: tenantId, period: p, inbound: 0, outbound: 0, ai_calls: 0, orders: 0 };
}

export function withinLimit(tenant, kind) {
  const plan = PLANS[tenant.plan] || PLANS.starter;
  const u = getUsage(tenant.id);
  if (kind === 'inbound') return plan.monthlyConversationsIn == null || u.inbound < plan.monthlyConversationsIn;
  if (kind === 'ai') return plan.aiCalls == null || u.ai_calls < plan.aiCalls;
  return true;
}
