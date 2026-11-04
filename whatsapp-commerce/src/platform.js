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
    subscription_data: { metadata: { tenant_id: tenant.id, plan }, ...(trialLeft > 1 ? { trial_period_days: trialLeft } : {}) },
    metadata: { tenant_id: tenant.id, plan },
    allow_promotion_codes: 'true',
    success_url: `${config.publicUrl}/admin/?billing=success`,
    cancel_url: `${config.publicUrl}/admin/?billing=cancelled`,
  });
  return session.url;
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
export async function completeEmbeddedSignup(tenantId, { code, phoneNumberId, wabaId }) {
  if (!embeddedSignupConfigured()) throw new Error('Embedded Signup is not configured on this server');
  if (!code || !phoneNumberId || !wabaId) throw new Error('code, phoneNumberId and wabaId are required');
  const { access_token: token } = await graph('GET', 'oauth/access_token', { query: { client_id: config.metaAppId, client_secret: config.metaAppSecret, code } });
  await graph('POST', `${wabaId}/subscribed_apps`, { token });
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  await graph('POST', `${phoneNumberId}/register`, { token, body: { messaging_product: 'whatsapp', pin } }).catch((e) => {
    if (!/already registered/i.test(e.message)) throw e;
  });
  const info = await graph('GET', phoneNumberId, { token, query: { fields: 'display_phone_number,verified_name' } }).catch(() => ({}));
  const t = updateTenantSettings(tenantId, {
    whatsapp: { phoneNumberId: String(phoneNumberId), wabaId: String(wabaId), accessToken: token, appSecret: config.metaAppSecret, twoStepPin: pin, connectedVia: 'embedded_signup' },
    ...(info.display_phone_number ? { business: { whatsappNumber: String(info.display_phone_number).replace(/\D/g, '') } } : {}),
  });
  return { tenant: t, displayPhoneNumber: info.display_phone_number || null, verifiedName: info.verified_name || null };
}
