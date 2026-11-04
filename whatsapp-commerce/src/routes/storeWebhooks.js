import express from 'express';
import crypto from 'node:crypto';
import { getTenant } from '../tenants.js';
import { safeEqual } from '../crypto.js';
import { getDb, json } from '../db.js';
import { findOrderByStoreId, updateOrder, sendOrderUpdate } from '../bot/orders.js';
import { createSender } from '../whatsapp/cloudApi.js';
import { updateContact } from '../bot/flows.js';
import { money } from '../bot/cart.js';

/** Map a Shopify / WooCommerce / custom order webhook payload to our status model. */
export function mapStoreEvent(headers, body) {
  if (headers['x-shopify-topic']) {
    const status = body.cancelled_at ? 'cancelled' : body.fulfillment_status === 'fulfilled' ? 'shipped' : body.financial_status === 'paid' ? 'confirmed' : null;
    return { storeOrderId: String(body.admin_graphql_api_id || body.id), altId: body.id, status, paid: body.financial_status === 'paid' };
  }
  if (headers['x-wc-webhook-topic']) {
    const map = { processing: 'confirmed', completed: 'completed', cancelled: 'cancelled', refunded: 'cancelled', failed: 'cancelled', 'on-hold': 'new' };
    return { storeOrderId: String(body.id), status: map[body.status] || null, paid: !!body.date_paid };
  }
  return { storeOrderId: String(body.orderId || body.id || ''), status: body.status || null, paid: body.paid === true || body.payment_status === 'paid' };
}

/** Turn a store phone number into a WhatsApp id (digits with country code). */
export function toWaId(phone, defaultCc = '44') {
  let d = String(phone || '').replace(/[^\d+]/g, '');
  if (!d) return null;
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = defaultCc + d.slice(1);
  return d.length >= 8 && d.length <= 15 ? d : null;
}

function verifySignature(req, tenant) {
  const raw = req.rawBody || Buffer.from('');
  const shopSecret = tenant.settings.store?.shopify?.webhookSecret;
  const wooSecret = tenant.settings.store?.woocommerce?.webhookSecret;
  if (req.get('x-shopify-hmac-sha256') && shopSecret) {
    return safeEqual(crypto.createHmac('sha256', shopSecret).update(raw).digest('base64'), req.get('x-shopify-hmac-sha256'));
  }
  if (req.get('x-wc-webhook-signature') && wooSecret) {
    return safeEqual(crypto.createHmac('sha256', wooSecret).update(raw).digest('base64'), req.get('x-wc-webhook-signature'));
  }
  return true; // URL secret already authenticates; signature is an optional extra check
}

/** Remember an event once (idempotent). Returns false if already seen. */
function once(tenantId, kind, ref, phone, data, status = 'done') {
  try {
    getDb().prepare('INSERT INTO store_events (tenant_id, kind, ref, phone, data, status) VALUES (?, ?, ?, ?, ?, ?)').run(tenantId, kind, String(ref), phone, JSON.stringify(data || {}), status);
    return true;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return false;
    throw e;
  }
}

function upsertWebCustomer(tenantId, waId, name, email) {
  getDb().prepare(`INSERT INTO customers (tenant_id, wa_id, name, email) VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id, wa_id) DO UPDATE SET name = COALESCE(customers.name, excluded.name), email = COALESCE(customers.email, excluded.email)`).run(tenantId, waId, name || null, email || null);
  updateContact(tenantId, waId, { addTags: ['web-customer'] });
}

const tplMsg = (cfg, params) => ({
  type: 'template',
  name: cfg.template,
  language: cfg.language || 'en_GB',
  components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text ?? '').slice(0, 1000) || '-' })) }],
});

/** Normalise website orders/checkouts from Shopify or WooCommerce. */
export function webOrderInfo(headers, b) {
  if (headers['x-shopify-topic']) {
    const addr = b.shipping_address || b.billing_address || {};
    const tracking = (b.fulfillments || []).map((f) => f.tracking_url || f.tracking_urls?.[0]).find(Boolean);
    return {
      platform: 'shopify',
      topic: headers['x-shopify-topic'],
      id: String(b.id),
      name: b.name || (b.order_number ? `#${b.order_number}` : String(b.id)),
      phone: b.phone || addr.phone || b.customer?.phone || b.billing_address?.phone,
      firstName: addr.first_name || b.customer?.first_name || '',
      email: b.email || b.customer?.email,
      total: Number(b.total_price || 0),
      currency: b.currency,
      checkoutToken: b.checkout_token || b.token,
      checkoutUrl: b.abandoned_checkout_url,
      orderStatusUrl: b.order_status_url,
      trackingUrl: tracking,
      fulfilled: b.fulfillment_status === 'fulfilled',
      marketingConsent: !!(b.buyer_accepts_marketing || b.customer?.accepts_marketing || b.customer?.sms_marketing_consent?.state === 'subscribed'),
      completed: !!b.completed_at,
    };
  }
  if (headers['x-wc-webhook-topic']) {
    const bill = b.billing || {};
    const tracking = (b.meta_data || []).filter((m) => m.key === '_wc_shipment_tracking_items').flatMap((m) => m.value || []).map((t) => t.custom_tracking_link).find(Boolean);
    return {
      platform: 'woocommerce',
      topic: headers['x-wc-webhook-topic'],
      id: String(b.id),
      name: '#' + (b.number || b.id),
      phone: bill.phone || b.shipping?.phone,
      firstName: bill.first_name || '',
      email: bill.email,
      total: Number(b.total || 0),
      currency: b.currency,
      trackingUrl: tracking,
      fulfilled: b.status === 'completed',
      wooStatus: b.status,
    };
  }
  return null;
}

async function handleWebOrder(t, headers, body) {
  const info = webOrderInfo(headers, body);
  if (!info) return;
  const N = t.settings.notifications || {};
  const T = N.storeTemplates || {};
  const waId = toWaId(info.phone, N.defaultCountryCode || '44');
  const send = createSender(t);
  const sym = t.settings.business.currencySymbol || '£';

  // Abandoned checkouts (Shopify checkouts/create|update)
  if (info.platform === 'shopify' && /^checkouts\//.test(info.topic)) {
    if (!waId || !info.checkoutUrl) return;
    const data = { firstName: info.firstName, url: info.checkoutUrl, total: info.total, consent: info.marketingConsent };
    if (!once(t.id, 'checkout', info.checkoutToken || info.id, waId, data, info.completed ? 'completed' : 'pending')) {
      getDb().prepare("UPDATE store_events SET phone = ?, data = ?, status = CASE WHEN ? THEN 'completed' ELSE status END WHERE tenant_id = ? AND kind = 'checkout' AND ref = ?").run(waId, JSON.stringify(data), info.completed ? 1 : 0, t.id, String(info.checkoutToken || info.id));
    }
    return;
  }

  const isCreate = /orders\/create|order\.created/.test(info.topic);
  if (isCreate && info.checkoutToken) {
    getDb().prepare("UPDATE store_events SET status = 'completed' WHERE tenant_id = ? AND kind = 'checkout' AND ref = ?").run(t.id, String(info.checkoutToken));
  }
  if (!waId) return;
  upsertWebCustomer(t.id, waId, info.firstName, info.email);

  if (isCreate && T.orderConfirmation?.enabled && T.orderConfirmation.template && once(t.id, 'order_confirm', info.id, waId)) {
    await send(waId, tplMsg(T.orderConfirmation, [info.firstName || 'there', info.name, t.settings.business.name, money(info.total, sym)])).catch((e) => console.warn('[web order confirm]', e.message));
  }
  if (info.fulfilled && T.shipping?.enabled && T.shipping.template && once(t.id, 'order_shipped', info.id, waId)) {
    await send(waId, tplMsg(T.shipping, [info.firstName || 'there', info.name, info.trackingUrl || info.orderStatusUrl || t.settings.business.name])).catch((e) => console.warn('[web order shipped]', e.message));
  }
}

/** Job: send the abandoned-checkout template once, after N minutes, if the checkout wasn't completed. */
export async function runAbandonedCheckouts(now = Date.now()) {
  const rows = getDb().prepare("SELECT * FROM store_events WHERE kind = 'checkout' AND status = 'pending' AND created_at > datetime('now', '-2 days')").all();
  let sent = 0;
  for (const r of rows) {
    const t = getTenant(r.tenant_id);
    const cfg = t?.settings.notifications?.storeTemplates?.abandonedCheckout;
    if (!t?.active || !cfg?.enabled || !cfg.template) continue;
    if (now - Date.parse(r.created_at + 'Z') < (Number(cfg.afterMinutes) || 60) * 60000) continue;
    const d = json(r.data, {});
    getDb().prepare("UPDATE store_events SET status = ? WHERE tenant_id = ? AND kind = 'checkout' AND ref = ?").run(cfg.requireMarketingConsent !== false && !d.consent ? 'skipped_no_consent' : 'sent', t.id, r.ref);
    if (cfg.requireMarketingConsent !== false && !d.consent) continue;
    await createSender(t)(r.phone, tplMsg(cfg, [d.firstName || 'there', t.settings.business.name, d.url])).then(() => sent++, (e) => console.warn('[abandoned checkout]', e.message));
  }
  return sent;
}

export function storeWebhookRouter() {
  const r = express.Router();
  r.post('/:tenantId/:secret', async (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t || !safeEqual(req.params.secret, t.settings.storeWebhookSecret)) return res.sendStatus(404);
    if (!verifySignature(req, t)) return res.sendStatus(401);
    res.sendStatus(200);
    try {
      const ev = mapStoreEvent(req.headers, req.body || {});
      const order = findOrderByStoreId(t.id, ev.storeOrderId) || (ev.altId && findOrderByStoreId(t.id, ev.altId));
      if (!order) return handleWebOrder(t, req.headers, req.body || {}); // an order placed on the website
      const status = ev.status || order.status;
      const payment = ev.paid ? 'paid' : order.payment_status;
      if (status === order.status && payment === order.payment_status) return;
      const updated = updateOrder(t.id, order.id, { status, payment_status: payment });
      await sendOrderUpdate(t, updated).catch((e) => console.warn('[store webhook notify]', e.message));
    } catch (e) {
      console.error('[store webhook]', e.message);
    }
  });
  return r;
}
