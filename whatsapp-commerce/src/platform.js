import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb } from './db.js';
import { getTenant, updateTenantMeta, updateTenantSettings, PLANS } from './tenants.js';
import { verifyStripeSignature } from './payments/stripe.js';
import { emailShop } from './email.js';

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
  const r = getDb().prepare('SELECT plan, owner_email, stripe_customer_id, subscription_id, subscription_status, trial_ends_at, payment_failed_at FROM tenants WHERE id = ?').get(tenantId);
  if (!r) return r;
  const graceEndsAt = r.payment_failed_at ? new Date(Date.parse(r.payment_failed_at + 'Z') + graceDays() * 864e5).toISOString() : null;
  return { ...r, graceEndsAt, graceDays: graceDays(), configured: billingConfigured(), prices: Object.fromEntries(Object.entries(config.stripePrices).map(([k, v]) => [k, !!v])) };
}

/** The business's billing events in plain words (newest first) – what Stripe told us and what we did. */
export function billingHistory(tenantId, limit = 20) {
  return getDb().prepare('SELECT type, note, created, received_at FROM billing_events WHERE tenant_id = ? ORDER BY COALESCE(created, 0) DESC, received_at DESC LIMIT ?').all(tenantId, limit)
    .map((e) => ({ type: e.type, note: e.note, at: e.created ? new Date(e.created * 1000).toISOString() : e.received_at.replace(' ', 'T') + 'Z' }));
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

const graceDays = () => Math.max(0, Number(config.billingGraceDays ?? 7));
const money = (pence, cur = 'gbp') => `${String(cur).toLowerCase() === 'gbp' ? '£' : String(cur).toUpperCase() + ' '}${(Number(pence || 0) / 100).toFixed(2)}`;
const graceOver = (tid, now = Date.now()) => {
  const f = getDb().prepare('SELECT payment_failed_at FROM tenants WHERE id = ?').get(tid)?.payment_failed_at;
  return !!f && now - Date.parse(f + 'Z') > graceDays() * 864e5;
};
const tenantFor = (o) => {
  const d = getDb();
  const tid = o.metadata?.tenant_id || o.subscription_details?.metadata?.tenant_id || o.client_reference_id;
  if (tid && getTenant(tid)) return tid;
  return d.prepare('SELECT id FROM tenants WHERE (subscription_id IS NOT NULL AND subscription_id = ?) OR (stripe_customer_id IS NOT NULL AND stripe_customer_id = ?)').get(o.subscription || o.id || '', o.customer || '')?.id || null;
};

/**
 * Stripe Billing webhook → keep plan + status in sync.
 *  - Signature checked; each event handled once (billing_events, keyed by Stripe's event id). If handling throws,
 *    nothing is recorded and Stripe retries.
 *  - Out-of-order delivery: a subscription event older than the last one applied doesn't overwrite newer state.
 *  - Failed payment: the business keeps working for BILLING_GRACE_DAYS (default 7) and is emailed; after that the
 *    assistant pauses (enforceGracePeriods) until the card is updated. Paid again → back on, and told so.
 *  - Cancellation pauses the assistant (the dashboard and data stay, so they can choose a plan again).
 * Returns { ok, status, duplicate?, note? }. Emails go out after the database changes are saved.
 */
export function handlePlatformStripeEvent(rawBody, signature) {
  if (!verifyStripeSignature(rawBody, signature, config.platformStripeWebhookSecret)) return { ok: false, status: 400 };
  let ev;
  try { ev = JSON.parse(rawBody); } catch { return { ok: false, status: 400 }; }
  if (!ev?.type) return { ok: false, status: 400 };
  // Stripe always sends an event id; a signed body without one is de-duplicated by its hash
  if (!ev.id) ev.id = 'sha256:' + crypto.createHash('sha256').update(rawBody).digest('hex');
  const d = getDb();
  if (d.prepare('SELECT 1 FROM billing_events WHERE id = ?').get(ev.id)) return { ok: true, status: 200, duplicate: true };
  const emails = [];
  d.exec('BEGIN');
  let out;
  try {
    out = applyBillingEvent(ev, emails);
    d.prepare('INSERT INTO billing_events (id, type, tenant_id, created, note) VALUES (?, ?, ?, ?, ?)').run(ev.id, ev.type, out.tenantId || null, Number(ev.created) || null, out.note || null);
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch {}
    throw e;
  }
  for (const [tid, subject, text] of emails) { const t = getTenant(tid); if (t) emailShop(t, subject, text, { button: 'Open Billing', topic: 'billing' }).catch((e) => console.warn('[billing email]', e.message)); }
  return { ok: true, status: 200, note: out.note };
}

function applyBillingEvent(ev, emails) {
  const o = ev.data?.object || {};
  const d = getDb();
  const created = Number(ev.created) || 0;
  if (ev.type === 'checkout.session.completed' && o.mode === 'payment' && o.metadata?.kind === 'ai_topup' && o.payment_status === 'paid') {
    const tid = o.metadata.tenant_id;
    const done = `topup-session:${o.id}`;
    if (!tid || !getTenant(tid)) return { note: 'top-up for an unknown business – ignored' };
    if (d.prepare('SELECT 1 FROM kv WHERE key = ?').get(done)) return { tenantId: tid, note: 'top-up already credited' };
    d.prepare("INSERT INTO kv (key, value) VALUES (?, '1')").run(done);
    d.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + excluded.value').run(`topup:${tid}:${o.metadata.period}`, String(Math.round(Number(o.metadata.usd) * 1e6)));
    return { tenantId: tid, note: `Extra AI budget bought ($${o.metadata.usd})` };
  }
  if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') {
    const tid = (o.client_reference_id && getTenant(o.client_reference_id) && o.client_reference_id) || tenantFor(o);
    if (!tid) return { note: 'checkout for an unknown business – ignored' };
    const cur = d.prepare('SELECT subscription_id, subscription_status FROM tenants WHERE id = ?').get(tid);
    // the subscription.* events carry the real status (e.g. trialing); only fill it in if they haven't arrived yet
    const keepStatus = cur.subscription_id === o.subscription && cur.subscription_status;
    d.prepare('UPDATE tenants SET stripe_customer_id = ?, subscription_id = ?, subscription_status = ? WHERE id = ?').run(o.customer, o.subscription, keepStatus ? cur.subscription_status : 'active', tid);
    const plan = o.metadata?.plan && PLANS[o.metadata.plan] ? o.metadata.plan : null;
    updateTenantMeta(tid, { ...(plan ? { plan } : {}), active: true });
    return { tenantId: tid, note: `Subscribed${plan ? ` to ${PLANS[plan].label}` : ''}` };
  }
  if (/^customer\.subscription\.(created|updated|deleted)$/.test(ev.type)) {
    const tid = tenantFor(o);
    if (!tid) return { note: 'subscription for an unknown business – ignored' };
    const last = Number(d.prepare('SELECT billing_event_at FROM tenants WHERE id = ?').get(tid)?.billing_event_at || 0);
    if (created && created < last) return { tenantId: tid, note: 'older update arrived late – newer status kept' };
    const before = d.prepare('SELECT subscription_status, plan FROM tenants WHERE id = ?').get(tid);
    const status = ev.type.endsWith('deleted') ? 'canceled' : String(o.status || 'active');
    d.prepare('UPDATE tenants SET subscription_id = ?, stripe_customer_id = COALESCE(stripe_customer_id, ?), subscription_status = ?, billing_event_at = ? WHERE id = ?').run(o.id, o.customer || null, status, created || last, tid);
    if (['active', 'trialing'].includes(status)) d.prepare('UPDATE tenants SET payment_failed_at = NULL WHERE id = ?').run(tid);
    const plan = planForPrice(o.items?.data?.[0]?.price?.id);
    const active = ['active', 'trialing'].includes(status) || (status === 'past_due' && !graceOver(tid));
    updateTenantMeta(tid, { ...(plan ? { plan } : {}), active });
    if (status === 'canceled' && before.subscription_status !== 'canceled') emails.push([tid, 'Your subscription has ended', 'Your subscription has been cancelled, so your assistant is now paused.\n\nYour account, settings and conversations are still here. Choose a plan on the Billing tab any time to switch it back on.']);
    if (o.cancel_at_period_end && o.current_period_end && before.subscription_status !== 'canceled' && status !== 'canceled' && ev.data?.previous_attributes?.cancel_at_period_end === false)
      emails.push([tid, 'Your subscription will end', `You've asked to cancel. Your plan stays active until *${new Date(o.current_period_end * 1000).toLocaleDateString('en-GB')}*, then your assistant pauses.\n\nChanged your mind? Use "Manage billing" on the Billing tab to keep your plan.`]);
    const label = plan && plan !== before.plan ? ` – plan now ${PLANS[plan].label}` : '';
    return { tenantId: tid, note: `Subscription ${ev.type.split('.').pop()}: ${status}${label}` };
  }
  if (ev.type === 'invoice.payment_failed') {
    const tid = tenantFor(o);
    if (!tid) return { note: 'failed payment for an unknown business – ignored' };
    const first = !d.prepare('SELECT payment_failed_at FROM tenants WHERE id = ?').get(tid).payment_failed_at;
    d.prepare("UPDATE tenants SET payment_failed_at = COALESCE(payment_failed_at, datetime('now')) WHERE id = ?").run(tid);
    if (first) emails.push([tid, 'We could not take your payment', `Your payment of *${money(o.amount_due, o.currency)}* didn't go through.\n\nYour assistant keeps working for ${graceDays()} days. Please update your card: Billing tab → "Manage billing, invoices & card".`]);
    return { tenantId: tid, note: `Payment failed (${money(o.amount_due, o.currency)}${o.attempt_count ? `, attempt ${o.attempt_count}` : ''})` };
  }
  if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_succeeded') {
    const tid = tenantFor(o);
    if (!tid) return { note: 'payment for an unknown business – ignored' };
    const row = d.prepare('SELECT payment_failed_at, subscription_status FROM tenants WHERE id = ?').get(tid);
    if (row.payment_failed_at) {
      d.prepare('UPDATE tenants SET payment_failed_at = NULL WHERE id = ?').run(tid);
      if (['active', 'trialing', 'past_due'].includes(row.subscription_status)) updateTenantMeta(tid, { active: true });
      emails.push([tid, 'Payment received – thank you', `Your payment of *${money(o.amount_paid, o.currency)}* went through. Everything is running as normal.`]);
    }
    return { tenantId: tid, note: `Payment received (${money(o.amount_paid, o.currency)})` };
  }
  if (ev.type === 'customer.subscription.trial_will_end') {
    const tid = tenantFor(o);
    if (!tid) return { note: 'trial notice for an unknown business – ignored' };
    const end = o.trial_end ? new Date(o.trial_end * 1000).toLocaleDateString('en-GB') : 'soon';
    emails.push([tid, 'Your free trial ends soon', `Your free trial ends on *${end}*. Add a card on the Billing tab to keep your assistant running – there's nothing else to do.`]);
    return { tenantId: tid, note: `Trial ends ${end} – reminder sent` };
  }
  return { tenantId: tenantFor(o), note: 'not used' };
}

/** Daily: a failed payment still not fixed after the grace period → pause the assistant (dashboard stays open). */
export function enforceGracePeriods(now = Date.now()) {
  if (!billingConfigured()) return 0;
  const rows = getDb().prepare("SELECT id FROM tenants WHERE active = 1 AND payment_failed_at IS NOT NULL AND subscription_status IN ('past_due', 'unpaid', 'incomplete')").all();
  let n = 0;
  for (const r of rows) {
    if (!graceOver(r.id, now)) continue;
    updateTenantMeta(r.id, { active: false });
    getDb().prepare('INSERT OR IGNORE INTO billing_events (id, type, tenant_id, created, note) VALUES (?, ?, ?, ?, ?)').run(`grace:${r.id}:${new Date(now).toISOString().slice(0, 10)}`, 'grace_period_ended', r.id, Math.floor(now / 1000), 'Payment still failing after the grace period – assistant paused');
    const t = getTenant(r.id);
    if (t) emailShop(t, 'Your assistant is paused', 'We still could not take your payment, so your assistant is paused. Update your card on the Billing tab ("Manage billing") and it switches back on as soon as the payment goes through.', { button: 'Open Billing', topic: 'billing' }).catch(() => {});
    n++;
  }
  return n;
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
  if (r.s === 'free') return { level: 'info', text: 'Free plan: website chat, 100 chats and 100 AI replies a month. Upgrade on the Billing tab for WhatsApp, more replies and no "Powered by" link.' };
  if (r.s === 'trialing' && r.t) {
    const days = Math.ceil((Date.parse(r.t + 'Z') - Date.now()) / 864e5);
    return { level: days <= 3 ? 'warn' : 'info', text: `Free trial: ${Math.max(0, days)} day${days === 1 ? '' : 's'} left. Choose a plan to keep your WhatsApp shop running.` };
  }
  if (r.s === 'trial_expired') return { level: 'warn', text: 'Your free trial has ended and your WhatsApp bot is paused. Choose a plan on the Billing tab to switch it back on.' };
  if (r.s === 'past_due' || r.s === 'unpaid') {
    const f = getDb().prepare('SELECT payment_failed_at FROM tenants WHERE id = ?').get(tenantId)?.payment_failed_at;
    const left = f ? Math.ceil((Date.parse(f + 'Z') + graceDays() * 864e5 - Date.now()) / 864e5) : null;
    return { level: 'warn', text: left === null ? 'We could not take your last payment. Please update your card on the Billing tab to avoid interruption.' : left > 0 ? `We could not take your last payment. Please update your card on the Billing tab – your assistant keeps working for ${left} more day${left === 1 ? '' : 's'}.` : 'We could not take your payment, so your assistant is paused. Update your card on the Billing tab to switch it back on.' };
  }
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
