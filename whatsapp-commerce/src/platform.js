import { config } from './config.js';
import { getDb } from './db.js';
import { getTenant, updateTenantMeta, updateTenantSettings, PLANS } from './tenants.js';
import { verifyStripeSignature } from './payments/stripe.js';

// ---------- your own subscription billing (Stripe Billing) ----------
export const billingConfigured = () => !!config.platformStripeSecret;

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method, path, body) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.platformStripeSecret}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? form(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${data.error?.message || res.status}`);
  return data;
}

export function billingInfo(tenantId) {
  const r = getDb().prepare('SELECT plan, owner_email, stripe_customer_id, subscription_id, subscription_status, trial_ends_at FROM tenants WHERE id = ?').get(tenantId);
  return r && { ...r, configured: billingConfigured(), prices: Object.fromEntries(Object.entries(config.stripePrices).map(([k, v]) => [k, !!v])) };
}

export async function createSubscriptionCheckout(tenant, plan) {
  if (!billingConfigured()) throw new Error('Billing is not configured on this server');
  const price = config.stripePrices[plan];
  if (!price) throw new Error(`No Stripe price configured for plan "${plan}"`);
  const row = getDb().prepare('SELECT owner_email, stripe_customer_id, trial_ends_at FROM tenants WHERE id = ?').get(tenant.id);
  const trialLeft = row.trial_ends_at ? Math.ceil((Date.parse(row.trial_ends_at + 'Z') - Date.now()) / 864e5) : 0;
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription',
    client_reference_id: tenant.id,
    ...(row.stripe_customer_id ? { customer: row.stripe_customer_id } : row.owner_email ? { customer_email: row.owner_email } : {}),
    line_items: { 0: { price, quantity: 1 } },
    // During a free trial no card is needed; if none is added by the end Stripe cancels and the bot pauses.
    subscription_data: { metadata: { tenant_id: tenant.id, plan }, ...(trialLeft > 1 ? { trial_period_days: trialLeft, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } } : {}) },
    ...(trialLeft > 1 ? { payment_method_collection: 'if_required' } : {}),
    metadata: { tenant_id: tenant.id, plan },
    allow_promotion_codes: 'true',
    ...(config.stripeAutomaticTax ? { automatic_tax: { enabled: 'true' }, tax_id_collection: { enabled: 'true' }, billing_address_collection: 'required', ...(row.stripe_customer_id ? { customer_update: { address: 'auto', name: 'auto' } } : {}) } : {}),
    success_url: `${config.publicUrl}/admin/?billing=success`,
    cancel_url: `${config.publicUrl}/admin/?billing=cancelled`,
  });
  return session.url;
}

/** One-off AI top-up for the current month (so hitting the cap isn't a dead end). Price: TOPUP_GBP_PER_USD x amount. */
export const TOPUP_OPTIONS = [5, 10, 25, 50];
export async function createTopupCheckout(tenant, usd) {
  if (!billingConfigured()) throw new Error('Billing is not configured on this server');
  if (!TOPUP_OPTIONS.includes(usd)) throw new Error(`Choose one of $${TOPUP_OPTIONS.join(', $')}`);
  const pence = Math.round(usd * (Number(process.env.TOPUP_GBP_PER_USD) || 1) * 100);
  const row = getDb().prepare('SELECT stripe_customer_id, owner_email FROM tenants WHERE id = ?').get(tenant.id);
  const s = await stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    client_reference_id: tenant.id,
    ...(row.stripe_customer_id ? { customer: row.stripe_customer_id } : row.owner_email ? { customer_email: row.owner_email } : {}),
    line_items: { 0: { quantity: 1, price_data: { currency: 'gbp', unit_amount: pence, product_data: { name: `Extra AI budget ($${usd}) – ${new Date().toISOString().slice(0, 7)}` } } } },
    metadata: { tenant_id: tenant.id, kind: 'ai_topup', usd: String(usd), period: new Date().toISOString().slice(0, 7) },
    success_url: `${config.publicUrl}/admin/?topup=success`,
    cancel_url: `${config.publicUrl}/admin/?topup=cancelled`,
  });
  return s.url;
}

/** Extra AI budget bought this month (micro-USD). */
export function topupMicro(tenantId, period = new Date().toISOString().slice(0, 7)) {
  return Number(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(`topup:${tenantId}:${period}`)?.value || 0);
}

export async function createBillingPortal(tenant) {
  const row = getDb().prepare('SELECT stripe_customer_id FROM tenants WHERE id = ?').get(tenant.id);
  if (!row?.stripe_customer_id) throw new Error('No subscription yet – choose a plan first');
  const s = await stripe('POST', '/billing_portal/sessions', { customer: row.stripe_customer_id, return_url: `${config.publicUrl}/admin/` });
  return s.url;
}

const planForPrice = (priceId) => Object.entries(config.stripePrices).find(([, v]) => v && v === priceId)?.[0];

/** Stripe Billing webhook → keep plan + status in sync; suspend on cancellation. */
export function handlePlatformStripeEvent(rawBody, signature) {
  if (!verifyStripeSignature(rawBody, signature, config.platformStripeWebhookSecret)) return { ok: false, status: 400 };
  const ev = JSON.parse(rawBody);
  const o = ev.data?.object || {};
  const d = getDb();
  if (ev.type === 'checkout.session.completed' && o.mode === 'payment' && o.metadata?.kind === 'ai_topup' && o.payment_status === 'paid') {
    const tid = o.metadata.tenant_id;
    const key = `topup:${tid}:${o.metadata.period}`;
    const done = `topup-session:${o.id}`;
    if (tid && getTenant(tid) && !d.prepare('SELECT 1 FROM kv WHERE key = ?').get(done)) {
      d.prepare("INSERT INTO kv (key, value) VALUES (?, '1')").run(done);
      d.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + excluded.value').run(key, String(Math.round(Number(o.metadata.usd) * 1e6)));
    }
  }
  if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') {
    const tid = o.client_reference_id || o.metadata?.tenant_id;
    if (tid && getTenant(tid)) {
      d.prepare("UPDATE tenants SET stripe_customer_id = ?, subscription_id = ?, subscription_status = 'active' WHERE id = ?").run(o.customer, o.subscription, tid);
      if (o.metadata?.plan && PLANS[o.metadata.plan]) updateTenantMeta(tid, { plan: o.metadata.plan, active: true });
    }
  }
  if (/^customer\.subscription\.(created|updated|deleted)$/.test(ev.type)) {
    const tid = o.metadata?.tenant_id || d.prepare('SELECT id FROM tenants WHERE subscription_id = ? OR stripe_customer_id = ?').get(o.id, o.customer)?.id;
    if (tid && getTenant(tid)) {
      const status = ev.type.endsWith('deleted') ? 'canceled' : o.status;
      d.prepare('UPDATE tenants SET subscription_id = ?, stripe_customer_id = COALESCE(stripe_customer_id, ?), subscription_status = ? WHERE id = ?').run(o.id, o.customer, status, tid);
      const plan = planForPrice(o.items?.data?.[0]?.price?.id);
      const active = ['active', 'trialing', 'past_due'].includes(status);
      updateTenantMeta(tid, { ...(plan ? { plan } : {}), active });
    }
  }
  return { ok: true, status: 200 };
}

/**
 * Trial enforcement (only when billing is configured): when a free trial ends without a subscription the bot
 * pauses (dashboard stays available so the owner can pick a plan). Returns the number of shops paused.
 */
export function enforceTrials() {
  if (!billingConfigured()) return 0;
  const rows = getDb().prepare("SELECT id FROM tenants WHERE active = 1 AND subscription_status = 'trialing' AND subscription_id IS NULL AND trial_ends_at IS NOT NULL AND trial_ends_at < datetime('now')").all();
  for (const r of rows) {
    getDb().prepare("UPDATE tenants SET subscription_status = 'trial_expired' WHERE id = ?").run(r.id);
    updateTenantMeta(r.id, { active: false });
  }
  return rows.length;
}

/** Banner text for the dashboard: trial days left / expired / payment problem. */
export function billingBanner(tenantId) {
  if (!billingConfigured()) return null;
  const r = getDb().prepare('SELECT subscription_status AS s, trial_ends_at AS t FROM tenants WHERE id = ?').get(tenantId);
  if (!r) return null;
  if (r.s === 'trialing' && r.t) {
    const days = Math.ceil((Date.parse(r.t + 'Z') - Date.now()) / 864e5);
    return { level: days <= 3 ? 'warn' : 'info', text: `Free trial: ${Math.max(0, days)} day${days === 1 ? '' : 's'} left. Choose a plan to keep your WhatsApp shop running.` };
  }
  if (r.s === 'trial_expired') return { level: 'warn', text: 'Your free trial has ended and your WhatsApp bot is paused. Choose a plan on the Billing tab to switch it back on.' };
  if (r.s === 'past_due' || r.s === 'unpaid') return { level: 'warn', text: 'We could not take your last payment. Please update your card on the Billing tab to avoid interruption.' };
  if (r.s === 'canceled') return { level: 'warn', text: 'Your subscription is cancelled and the bot is paused. Choose a plan on the Billing tab to restart.' };
  return null;
}

// ---------- Meta Embedded Signup ----------
export const embeddedSignupConfigured = () => !!(config.metaAppId && config.metaAppSecret && config.metaConfigId);

async function graph(method, path, { token, body, query } = {}) {
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta: ${data.error?.error_user_msg || data.error?.message || res.status}`);
  return data;
}

/**
 * Finish Embedded Signup: exchange the code for a business token, subscribe our app to the client's WABA,
 * register the number for Cloud API and store everything on the tenant.
 */
/**
 * Embedded Signup v4+ (v2/v3 were retired on 15 Oct 2026).
 * The business may finish with a verified number, an unverified number or no number at all, so a missing
 * phone number is a valid "connected – number pending" state. Coexistence (number stays on the WhatsApp
 * Business app) must not call /register.
 */
export async function completeEmbeddedSignup(tenantId, { code, phoneNumberId, wabaId, businessId, coexistence = false, event, extraIds = {} } = {}) {
  if (!embeddedSignupConfigured()) throw new Error('Embedded Signup is not configured on this server');
  if (!code || !wabaId) throw new Error('code and wabaId are required');
  const { access_token: token } = await graph('GET', 'oauth/access_token', { query: { client_id: config.metaAppId, client_secret: config.metaAppSecret, code } });
  await graph('POST', `${wabaId}/subscribed_apps`, { token });
  updateTenantSettings(tenantId, {
    whatsapp: { wabaId: String(wabaId), businessId: businessId ? String(businessId) : '', accountIds: Object.fromEntries(Object.entries(extraIds || {}).filter(([k, v]) => /^[a-z_]{2,20}$/.test(k) && /^[\w-]{1,64}$/.test(String(v))).map(([k, v]) => [k, String(v)])), accessToken: token, appSecret: config.metaAppSecret, connectedVia: coexistence ? 'coexistence' : 'embedded_signup', signupEvent: event || '', numberStatus: 'pending' },
  });
  return activateNumber(tenantId, { phoneNumberId, coexistence });
}

/** Pick / register the WABA's phone number. Safe to call again ("Refresh") after the business adds or verifies one. */
export async function activateNumber(tenantId, { phoneNumberId, coexistence } = {}) {
  const t = getTenant(tenantId);
  const W = t.settings.whatsapp || {};
  const token = W.accessToken;
  coexistence ??= W.connectedVia === 'coexistence';
  if (!token || !W.wabaId) throw new Error('Connect WhatsApp first');
  if (!phoneNumberId) {
    const list = await graph('GET', `${W.wabaId}/phone_numbers`, { token, query: { fields: 'id,display_phone_number,verified_name,code_verification_status,status' } }).catch(() => ({ data: [] }));
    phoneNumberId = (list.data || []).find((n) => n.code_verification_status === 'VERIFIED')?.id || list.data?.[0]?.id;
  }
  if (!phoneNumberId) {
    return { tenant: getTenant(tenantId), numberStatus: 'pending', message: 'Connected – add or verify a phone number in WhatsApp Manager, then press “Refresh number”.' };
  }
  let pin = W.twoStepPin;
  if (!coexistence) {
    pin ||= String(Math.floor(100000 + Math.random() * 900000));
    const reg = await graph('POST', `${phoneNumberId}/register`, { token, body: { messaging_product: 'whatsapp', pin } }).then(() => 'ok', (e) => (/already registered/i.test(e.message) ? 'ok' : e.message));
    if (reg !== 'ok') {
      updateTenantSettings(tenantId, { whatsapp: { phoneNumberId: String(phoneNumberId), numberStatus: 'unverified', twoStepPin: pin } });
      return { tenant: getTenant(tenantId), numberStatus: 'unverified', message: `Number found but not ready yet (${reg}). Verify it in WhatsApp Manager, then press “Refresh number”.` };
    }
  }
  const info = await graph('GET', phoneNumberId, { token, query: { fields: 'display_phone_number,verified_name' } }).catch(() => ({}));
  // Coexistence: Meta requires contacts + message history to be synced within 24h of onboarding, or the business
  // must offboard and sign up again. Each sync can only be requested once per onboarding.
  let coexSync = null;
  if (coexistence && !W.coexSync?.history) {
    coexSync = { ...(W.coexSync || {}), at: new Date().toISOString() };
    for (const type of ['smb_app_state_sync', 'history']) {
      const key = type === 'history' ? 'history' : 'contacts';
      if (coexSync[key]) continue;
      coexSync[key] = await graph('POST', `${phoneNumberId}/smb_app_data`, { token, body: { messaging_product: 'whatsapp', sync_type: type } }).then((r) => r.request_id || 'requested', (e) => `error: ${e.message}`);
    }
  }
  const tenant = updateTenantSettings(tenantId, {
    whatsapp: { phoneNumberId: String(phoneNumberId), numberStatus: 'active', ...(pin ? { twoStepPin: pin } : {}), ...(coexSync ? { coexSync } : {}) },
    ...(info.display_phone_number ? { business: { whatsappNumber: String(info.display_phone_number).replace(/\D/g, '') } } : {}),
  });
  return { tenant, numberStatus: 'active', displayPhoneNumber: info.display_phone_number || null, verifiedName: info.verified_name || null };
}
