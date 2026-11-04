import express from 'express';
import { getTenant } from '../tenants.js';
import { safeEqual } from '../crypto.js';
import { findOrderByStoreId, updateOrder, orderUpdateMessage } from '../bot/orders.js';
import { createSender } from '../whatsapp/cloudApi.js';

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

export function storeWebhookRouter() {
  const r = express.Router();
  r.post('/:tenantId/:secret', async (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t || !safeEqual(req.params.secret, t.settings.storeWebhookSecret)) return res.sendStatus(404);
    res.sendStatus(200);
    try {
      const ev = mapStoreEvent(req.headers, req.body || {});
      const order = findOrderByStoreId(t.id, ev.storeOrderId) || (ev.altId && findOrderByStoreId(t.id, ev.altId));
      if (!order) return; // not a WhatsApp order
      const status = ev.status || order.status;
      const payment = ev.paid ? 'paid' : order.payment_status;
      if (status === order.status && payment === order.payment_status) return;
      const updated = updateOrder(t.id, order.id, { status, payment_status: payment });
      await createSender(t)(order.wa_id, orderUpdateMessage(t, updated)).catch((e) => console.warn('[store webhook notify]', e.message));
    } catch (e) {
      console.error('[store webhook]', e.message);
    }
  });
  return r;
}
