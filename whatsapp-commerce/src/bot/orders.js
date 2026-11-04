import { getDb, json } from '../db.js';
import { bumpUsage } from '../tenants.js';
import { subtotal, deliveryFee, money } from './cart.js';
import { toPlainText } from '../whatsapp/cloudApi.js';

const PAYMENT_LABELS = { payment_link: 'Pay online', cod: 'Cash on delivery/collection', bank_transfer: 'Bank transfer' };
export const paymentLabel = (m) => PAYMENT_LABELS[m] || m;

function fillLink(template, { total, order }) {
  return String(template).replace(/\{total\}/g, Number(total).toFixed(2)).replace(/\{order\}/g, encodeURIComponent(order || ''));
}

/**
 * Create the order in the connected store + our own DB, notify staff, clear the cart.
 * Returns { order, messages } – messages are what the customer should receive.
 */
export async function placeOrder({ tenant, store, conv, customer, fulfilment, paymentMethod, address, send }) {
  const S = tenant.settings;
  const sym = S.business.currencySymbol || '£';
  const items = conv.cart.map((i) => ({ ...i }));
  if (!items.length) throw new Error('Cart is empty');
  const sub = subtotal(items);
  const fee = deliveryFee(S.ordering, fulfilment, sub);

  const result = await store.createOrder({
    items,
    customer: { name: customer.name || 'WhatsApp customer', phone: conv.waId, email: customer.email || '', address: address || '' },
    paymentMethod,
    fulfilment,
    note: conv.data?.checkout?.note || '',
    shippingFee: fee,
  });

  const total = Number.isFinite(result.total) && result.total > 0 ? result.total : sub + fee;
  const d = getDb();
  const info = d
    .prepare(
      `INSERT INTO orders (tenant_id, wa_id, store_order_id, store_order_name, status, payment_status, payment_method, fulfilment, items, subtotal, currency, customer_name, address, checkout_url)
       VALUES (?, ?, ?, ?, 'new', 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(tenant.id, conv.waId, result.orderId, result.orderName, paymentMethod, fulfilment, JSON.stringify(items), total, result.currency || S.business.currency, customer.name || null, address || null, result.checkoutUrl || null);
  const localId = Number(info.lastInsertRowid);
  const ref = result.orderName || `WA-${localId}`;
  if (!result.orderName) d.prepare('UPDATE orders SET store_order_name = ? WHERE id = ?').run(ref, localId);

  let checkoutUrl = result.checkoutUrl;
  if (!checkoutUrl && paymentMethod === 'payment_link' && S.ordering.paymentLinkUrl) {
    checkoutUrl = fillLink(S.ordering.paymentLinkUrl, { total, order: ref });
    d.prepare('UPDATE orders SET checkout_url = ? WHERE id = ?').run(checkoutUrl, localId);
  }

  bumpUsage(tenant.id, 'orders');
  conv.cart = [];
  conv.state = 'idle';
  conv.data = { lastOrderId: localId };

  const summary = `${items.map((i) => `• ${i.title} × ${i.quantity}`).join('\n')}${fee ? `\n• Delivery — ${money(fee, sym)}` : ''}\n*Total: ${money(total, sym)}*`;
  const messages = [];
  if (paymentMethod === 'payment_link' && checkoutUrl) {
    messages.push({ type: 'cta', text: `✅ Order *${ref}* created!\n\n${summary}\n\nTap below to pay securely. Your order is confirmed as soon as payment is received.`, buttonText: 'Pay now', url: checkoutUrl });
  } else if (paymentMethod === 'bank_transfer') {
    messages.push({ type: 'text', text: `✅ Order *${ref}* received!\n\n${summary}\n\nPlease transfer *${money(total, sym)}* to:\n${S.ordering.bankDetails || '(bank details will be sent by our team)'}\nReference: *${ref}*\n\nReply here with a screenshot once paid.` });
  } else {
    const how = fulfilment === 'pickup' ? `collection${S.ordering.pickupAddress ? ` from ${S.ordering.pickupAddress}` : ''}` : 'delivery';
    messages.push({ type: 'text', text: `✅ Order *${ref}* confirmed!\n\n${summary}\n\nPayment: ${paymentLabel(paymentMethod)} on ${how}. We'll message you here with updates. Thank you! 🙏` });
  }
  messages.push({ type: 'buttons', text: 'Anything else?', buttons: [{ id: 'status', title: '📦 Order status' }, { id: 'browse', title: '🛍️ Keep shopping' }] });

  const order = getOrder(tenant.id, localId);
  notifyStaff(tenant, order, send).catch((e) => console.error('[notify]', e.message));
  return { order, messages };
}

export async function notifyStaff(tenant, order, send) {
  const S = tenant.settings;
  const sym = S.business.currencySymbol || '£';
  const text = `🛒 *New WhatsApp order ${order.store_order_name}*\nCustomer: ${order.customer_name || ''} (+${order.wa_id})\n${order.items.map((i) => `• ${i.title} × ${i.quantity}`).join('\n')}\nTotal: ${money(order.subtotal, sym)}\n${order.fulfilment}${order.address ? `: ${order.address}` : ''}\nPayment: ${paymentLabel(order.payment_method)}`;
  const jobs = [];
  for (const staff of S.notifications?.staffWaIds || []) {
    if (send && String(staff).replace(/\D/g, '') !== order.wa_id) jobs.push(send(String(staff).replace(/\D/g, ''), { type: 'text', text }).catch((e) => console.error('[notify staff]', e.message)));
  }
  if (S.notifications?.webhookUrl) {
    jobs.push(
      fetch(S.notifications.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'order.created', tenant: tenant.id, order }), signal: AbortSignal.timeout(10000) }).catch((e) => console.error('[notify webhook]', e.message)),
    );
  }
  await Promise.all(jobs);
}

const mapOrder = (r) => r && { ...r, items: json(r.items, []) };

export function getOrder(tenantId, id) {
  return mapOrder(getDb().prepare('SELECT * FROM orders WHERE tenant_id = ? AND id = ?').get(tenantId, id));
}

export function listOrders(tenantId, { waId, limit = 50, offset = 0, status } = {}) {
  const where = ['tenant_id = ?'];
  const args = [tenantId];
  if (waId) { where.push('wa_id = ?'); args.push(waId); }
  if (status) { where.push('status = ?'); args.push(status); }
  return getDb().prepare(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(mapOrder);
}

export function updateOrder(tenantId, id, { status, payment_status, notes }) {
  const o = getOrder(tenantId, id);
  if (!o) return null;
  getDb()
    .prepare(`UPDATE orders SET status = ?, payment_status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status ?? o.status, payment_status ?? o.payment_status, notes ?? o.notes, id);
  return getOrder(tenantId, id);
}

export function findOrderByStoreId(tenantId, storeOrderId) {
  return mapOrder(getDb().prepare('SELECT * FROM orders WHERE tenant_id = ? AND (store_order_id = ? OR store_order_id LIKE ?) ORDER BY id DESC LIMIT 1').get(tenantId, String(storeOrderId), `%/${storeOrderId}`));
}

export const STATUS_TEXT = {
  new: 'received 📝',
  confirmed: 'confirmed ✅',
  preparing: 'being prepared 👩‍🍳',
  shipped: 'on its way 🚚',
  ready: 'ready for collection 🛍️',
  delivered: 'delivered 📦',
  completed: 'completed ✅',
  cancelled: 'cancelled ❌',
};

export function orderUpdateMessage(tenant, order) {
  const sym = tenant.settings.business.currencySymbol || '£';
  return {
    type: 'text',
    text: `Update on your order *${order.store_order_name}*: it is now *${STATUS_TEXT[order.status] || order.status}*.${order.payment_status === 'paid' ? '\nPayment received — thank you!' : ''}\nTotal: ${money(order.subtotal, sym)}`,
  };
}

export { toPlainText };
