import { getDb } from './db.js';
import { cachedTemplates } from './templates.js';
import { embeddedSignupConfigured, billingInfo } from './platform.js';
import { directConfigured } from './ai/direct.js';
import { json } from './db.js';
import { config } from './config.js';
import { updateTenantSettings } from './tenants.js';
import { stripe } from './platformSetup.js';

/*
 * The shop owner's step-by-step guide: one list, in the order that gets a shop selling fastest.
 * Everything that can be done today (website, products, AI, test, website chat) comes before
 * WhatsApp, because Meta's approvals can take days.
 */
export const REQUIRED_TEMPLATES = ['order_update', 'staff_alert', 'payment_reminder'];

export const PHASES = [
  { key: 'setup', title: 'Set up your shop', time: 'about 10 minutes' },
  { key: 'sell', title: 'Start selling on your website', time: 'today' },
  { key: 'whatsapp', title: 'Go live on WhatsApp', time: 'a few days, while Meta checks your business' },
  { key: 'plan', title: 'Keep it running', time: '1 minute' },
];

export function onboardingStatus(tenant) {
  const s = tenant.settings;
  const d = getDb();
  const count = (sql, ...a) => d.prepare(sql).get(...a).n;
  const products = s.store.type === 'manual' ? (s.store.manual?.products || []).length : null;
  const storeConnected = s.store.type === 'manual' ? products > 0
    : s.store.type === 'shopify_public' ? !!s.store.shopify?.domain
      : s.store.type === 'shopify' ? !!(s.store.shopify?.domain && s.store.shopify?.adminToken)
        : s.store.type === 'woocommerce' ? !!(s.store.woocommerce?.url && s.store.woocommerce?.consumerKey)
          : !!s.store.custom?.baseUrl;
  const docs = count('SELECT COUNT(*) AS n FROM knowledge_docs WHERE tenant_id = ?', tenant.id);
  const tested = count(`SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'in' AND body LIKE '%"simulated":true%'`, tenant.id);
  const webChats = count(`SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'in' AND wa_id LIKE 'web:%'`, tenant.id);
  const realInbound = count(`SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'in' AND wa_id NOT LIKE 'web:%' AND body NOT LIKE '%"simulated":true%'`, tenant.id);
  const W = s.whatsapp || {};
  const waConnected = !!(W.wabaId && W.accessToken && W.phoneNumberId && (!W.numberStatus || W.numberStatus === 'active'));
  const tpl = cachedTemplates(tenant.id) || {};
  const templatesIn = REQUIRED_TEMPLATES.filter((n) => tpl[n]);
  const staff = (s.notifications?.staffWaIds || []).length > 0;
  const bill = billingInfo(tenant.id) || {};
  const skipped = s.onboarding?.skipped || {};
  const seen = json(d.prepare('SELECT value FROM kv WHERE key = ?').get(`widget_seen:${tenant.id}`)?.value, null);
  // Shopify (website) and WooCommerce orders go through the shop's own checkout, which already handles payment and delivery.
  const ownCheckout = ['shopify_public', 'woocommerce'].includes(s.store.type);
  const O = s.ordering || {};

  const steps = [
    { key: 'shop', phase: 'setup', title: 'Tell us about your shop', why: 'We read your website and set most things up for you.', done: !!s.business?.website || storeConnected, data: { website: s.business?.website || '' } },
    { key: 'products', phase: 'setup', title: 'Add your products', why: 'So the assistant can show and sell them.', done: storeConnected, data: { storeType: s.store.type, products } },
    { key: 'orders', phase: 'setup', title: 'How customers pay and get their order', why: 'Card, bank transfer or cash; delivery or collection.', done: ownCheckout || !!s.onboarding?.ordersSet, data: { ownCheckout, storeType: s.store.type, paymentMethods: O.paymentMethods || [], fulfilment: O.fulfilment || [], deliveryFee: O.deliveryFee || 0, freeDeliveryOver: O.freeDeliveryOver || 0, pickupAddress: O.pickupAddress || '', bankDetails: O.bankDetails || '', paymentLinkUrl: O.paymentLinkUrl || '', stripe: !!s.payments?.stripe?.secretKey } },
    { key: 'assistant', phase: 'setup', title: 'Teach your assistant', why: 'Delivery, returns, opening hours: what customers ask most.', done: !!(s.ai?.about || s.ai?.faq) || docs > 0, data: { docs, aiReady: directConfigured() } },
    { key: 'test', phase: 'setup', title: 'Try it like a customer', why: 'Check the answers before real customers see them.', done: tested > 0 },
    { key: 'website', phase: 'sell', title: 'Add the chat to your website', why: 'Customers can ask and order straight away, no WhatsApp needed.', done: webChats > 0 || !!seen, data: { chats: webChats, seenOn: seen?.origin || null, seenAt: seen?.at || null } },
    { key: 'whatsapp', phase: 'whatsapp', title: 'Connect your WhatsApp number', why: 'Customers order inside WhatsApp.', done: waConnected, data: { oneClick: embeddedSignupConfigured(), pending: !!(W.wabaId && !waConnected), numberStatus: W.numberStatus || null } },
    { key: 'golive', phase: 'whatsapp', title: 'Finish the WhatsApp go-live checks', why: 'Order updates and staff alerts keep working, and you see messages arrive.', done: waConnected && templatesIn.length === REQUIRED_TEMPLATES.length && staff && realInbound > 0, data: { templates: templatesIn, required: REQUIRED_TEMPLATES, staff, inbound: realInbound } },
    { key: 'plan', phase: 'plan', title: 'Choose your plan', why: 'Keep everything running after your free trial.', done: bill.subscription_status === 'active', data: { status: bill.subscription_status || null, trialEndsAt: bill.trial_ends_at || null, billing: !!bill.configured } },
  ];
  for (const st of steps) st.skipped = !st.done && !!skipped[st.key];
  const next = steps.find((x) => !x.done && !x.skipped) || steps.find((x) => !x.done) || null;
  return { phases: PHASES, steps, next: next?.key || null, done: steps.filter((x) => x.done).length, total: steps.length };
}

/** Connect the shop's own Stripe: save the key and create the webhook that marks orders as paid. */
export async function connectShopStripe(tenant, secretKey) {
  const key = String(secretKey || '').trim();
  if (!/^(sk|rk)_(test|live)_/.test(key)) throw new Error("That doesn't look like a Stripe secret key. It starts with sk_live_ (or sk_test_ for testing).");
  const url = `${config.publicUrl}/webhooks/stripe/${tenant.id}`;
  if (!/^https:\/\//.test(url)) throw new Error('This server needs a public https:// address first');
  const hooks = await stripe('GET', '/webhook_endpoints', null, { limit: 100 }, key);
  for (const h of (hooks.data || []).filter((x) => x.url === url)) await stripe('DELETE', `/webhook_endpoints/${h.id}`, null, null, key);
  const hook = await stripe('POST', '/webhook_endpoints', { url, enabled_events: ['checkout.session.completed', 'checkout.session.async_payment_succeeded'], description: 'WhatsApp orders' }, null, key);
  const methods = tenant.settings.ordering?.paymentMethods || [];
  updateTenantSettings(tenant.id, { payments: { stripe: { secretKey: key, webhookSecret: hook.secret } }, ordering: { paymentMethods: methods.includes('payment_link') ? methods : [...methods, 'payment_link'] } });
  return { ok: true, mode: key.includes('_live_') ? 'live' : 'test' };
}
