import { getDb, json } from '../db.js';
import { bumpUsage, updateTenantSettings } from '../tenants.js';
import { money } from './cart.js';
import { quote } from './pricing.js';
import { config } from '../config.js';
import { randomToken } from '../crypto.js';
import { createCheckoutSession } from '../payments/stripe.js';
import { toPlainText, notify } from '../whatsapp/cloudApi.js';

const PAYMENT_LABELS = { payment_link: 'Pay online', cod: 'Cash on delivery/collection', bank_transfer: 'Bank transfer' };
export const paymentLabel = (m) => PAYMENT_LABELS[m] || m;

function fillLink(template, { total, order }) {
  return String(template).replace(/\{total\}/g, Number(total).toFixed(2)).replace(/\{order\}/g, encodeURIComponent(order || ''));
}

/** Built-in catalogue stock: check availability, decrement, return low-stock lines. */
function adjustManualStock(tenant, items) {
  const products = structuredClone(tenant.settings.store?.manual?.products || []);
  const low = [];
  const find = (i) => {
    const p = products.find((x) => String(x.id) === String(i.productId));
    const v = p?.variants?.find((x) => String(x.id) === String(i.variantId));
    return { p, holder: v && v.stock !== undefined && v.stock !== '' && v.stock !== null ? v : p };
  };
  for (const i of items) {
    const { p, holder } = find(i);
    if (!p || holder.stock === undefined || holder.stock === '' || holder.stock === null) continue;
    if (Number(holder.stock) < i.quantity) throw Object.assign(new Error(`Only ${holder.stock} left of ${i.title}`), { userMessage: `Sorry, we only have ${holder.stock} × ${i.title} left. Please update your cart.` });
  }
  let changed = false;
  for (const i of items) {
    const { p, holder } = find(i);
    if (!p || holder.stock === undefined || holder.stock === '' || holder.stock === null) continue;
    holder.stock = Number(holder.stock) - i.quantity;
    changed = true;
    if (holder.stock <= (Number(tenant.settings.ordering?.lowStockAlert) || 0)) low.push({ title: i.title, stock: holder.stock });
  }
  if (changed) updateTenantSettings(tenant.id, { store: { manual: { products } } });
  return low;
}

export const receiptUrl = (order) => (order?.receipt_token ? `${config.publicUrl}/r/${order.receipt_token}` : null);

/**
 * Create the order in the connected store + our own DB, notify staff, clear the cart.
 * co = { fulfilment, paymentMethod, address, promoCode, slot, note }
 * Returns { order, messages } – messages are what the customer should receive.
 */
export async function placeOrder({ tenant, store, conv, customer, fulfilment, paymentMethod, address, send, promoCode, slot, note }) {
  const S = tenant.settings;
  const sym = S.business.currencySymbol || '£';
  const items = conv.cart.map((i) => ({ ...i }));
  if (!items.length) throw new Error('Cart is empty');
  const co = conv.data?.checkout || {};
  promoCode ??= co.promoCode;
  slot ??= co.slot;
  note ??= co.note;
  const q = quote(tenant, items, { fulfilment, address, promoCode }, { waId: conv.waId });
  if (q.error === 'no_zone') throw Object.assign(new Error('Address outside delivery zones'), { userMessage: 'Sorry, we don’t deliver to that address yet.' });
  if (q.minOrder && q.subtotal < q.minOrder) throw Object.assign(new Error('Below minimum order'), { userMessage: `Our minimum order${q.zone ? ` for ${q.zone.name}` : ''} is ${money(q.minOrder, sym)}.` });

  const lowStock = store.type === 'manual' ? adjustManualStock(tenant, items) : [];
  const slotLabel = slot?.label || (typeof slot === 'string' ? slot : '');
  const fullNote = [note && `Note: ${note}`, slotLabel && `${fulfilment === 'pickup' ? 'Collection' : 'Delivery'} slot: ${slotLabel}`, q.promo && `Promo: ${q.promo.code} (-${money(q.discount, sym)})`].filter(Boolean).join('\n');

  const result = await store.createOrder({
    items,
    customer: { name: customer.name || 'WhatsApp customer', phone: conv.waId, email: customer.email || '', address: address || '' },
    paymentMethod,
    fulfilment,
    note: fullNote,
    shippingFee: q.deliveryFee,
    discount: q.discount,
    promoCode: q.promo?.code || null,
    slot: slotLabel || null,
  });

  const total = Number.isFinite(result.total) && result.total > 0 && store.type !== 'manual' ? result.total : q.total;
  const d = getDb();
  const token = randomToken(16);
  const info = d
    .prepare(
      `INSERT INTO orders (tenant_id, wa_id, store_order_id, store_order_name, status, payment_status, payment_method, fulfilment, items, subtotal, currency, customer_name, address, checkout_url, discount, delivery_fee, promo_code, slot, notes, receipt_token)
       VALUES (?, ?, ?, ?, 'new', 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(tenant.id, conv.waId, result.orderId, result.orderName, paymentMethod, fulfilment, JSON.stringify(items), total, result.currency || S.business.currency, customer.name || null, address || null, result.checkoutUrl || null, q.discount, q.deliveryFee, q.promo?.code || null, slotLabel || null, note || null, token);
  const localId = Number(info.lastInsertRowid);
  const ref = result.orderName || `WA-${localId}`;
  if (!result.orderName) d.prepare('UPDATE orders SET store_order_name = ? WHERE id = ?').run(ref, localId);

  let checkoutUrl = result.checkoutUrl;
  const stripe = S.payments?.stripe;
  if (!checkoutUrl && paymentMethod === 'payment_link' && stripe?.secretKey) {
    const session = await createCheckoutSession({
      secretKey: stripe.secretKey,
      amount: total,
      currency: result.currency || S.business.currency || 'GBP',
      orderRef: ref,
      description: items.map((i) => `${i.title} × ${i.quantity}`).join(', '),
      successUrl: `${config.publicUrl}/r/${token}?paid=1`,
      cancelUrl: `${config.publicUrl}/r/${token}`,
      metadata: { tenant_id: tenant.id, order_id: String(localId) },
    });
    checkoutUrl = session.url;
    d.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, localId);
  }
  if (!checkoutUrl && paymentMethod === 'payment_link' && S.ordering.paymentLinkUrl) checkoutUrl = fillLink(S.ordering.paymentLinkUrl, { total, order: ref });
  if (checkoutUrl !== result.checkoutUrl) d.prepare('UPDATE orders SET checkout_url = ? WHERE id = ?').run(checkoutUrl, localId);

  bumpUsage(tenant.id, 'orders');
  conv.cart = [];
  conv.state = 'idle';
  conv.data = { lastOrderId: localId, greeted: true };

  const order = getOrder(tenant.id, localId);
  const lines = [
    ...items.map((i) => `• ${i.title} × ${i.quantity}`),
    q.discount ? `• Discount (${q.promo.code}) — -${money(q.discount, sym)}` : null,
    fulfilment === 'delivery' ? `• Delivery — ${q.deliveryFee ? money(q.deliveryFee, sym) : 'FREE'}` : null,
  ].filter(Boolean);
  const summary = `${lines.join('\n')}\n*Total: ${money(total, sym)}*${slotLabel ? `\n🕒 ${slotLabel}` : ''}`;
  const receipt = `\n🧾 Receipt: ${receiptUrl(order)}`;
  const messages = [];
  if (fulfilment === 'online_checkout' && checkoutUrl) {
    messages.push({ type: 'cta', text: `🛒 Your basket is ready!\n\n${items.map((i) => `• ${i.title} × ${i.quantity}`).join('\n')}\n*Subtotal: ${money(total, sym)}*\n\nTap below to choose delivery and pay securely on our website.`, buttonText: 'Checkout', url: checkoutUrl });
  } else if (paymentMethod === 'payment_link' && checkoutUrl) {
    messages.push({ type: 'cta', text: `✅ Order *${ref}* created!\n\n${summary}\n\nTap below to pay securely. Your order is confirmed as soon as payment is received.`, buttonText: 'Pay now', url: checkoutUrl });
  } else if (paymentMethod === 'bank_transfer') {
    messages.push({ type: 'text', text: `✅ Order *${ref}* received!\n\n${summary}\n\nPlease transfer *${money(total, sym)}* to:\n${S.ordering.bankDetails || '(bank details will be sent by our team)'}\nReference: *${ref}*\n\nReply here with a screenshot once paid.${receipt}` });
  } else {
    const how = fulfilment === 'pickup' ? `collection${S.ordering.pickupAddress ? ` from ${S.ordering.pickupAddress}` : ''}` : 'delivery';
    messages.push({ type: 'text', text: `✅ Order *${ref}* confirmed!\n\n${summary}\n\nPayment: ${paymentLabel(paymentMethod)} on ${how}. We'll message you here with updates. Thank you! 🙏${receipt}` });
  }
  messages.push({ type: 'buttons', text: 'Anything else?', buttons: [{ id: 'status', title: '📦 Order status' }, { id: 'browse', title: '🛍️ Keep shopping' }] });

  notifyStaff(tenant, order, send, { lowStock }).catch((e) => console.error('[notify]', e.message));
  return { order, messages };
}

export async function notifyStaff(tenant, order, send, { lowStock = [], text: customText, event = 'order.created' } = {}) {
  const S = tenant.settings;
  const sym = S.business.currencySymbol || '£';
  const text = customText || `🛒 *New WhatsApp order ${order.store_order_name}*\nCustomer: ${order.customer_name || ''} (+${order.wa_id})\n${order.items.map((i) => `• ${i.title} × ${i.quantity}`).join('\n')}${order.discount ? `\nDiscount ${order.promo_code}: -${money(order.discount, sym)}` : ''}\nTotal: ${money(order.subtotal, sym)}\n${order.fulfilment}${order.address ? `: ${order.address}` : ''}${order.slot ? `\nSlot: ${order.slot}` : ''}${order.notes ? `\nNote: ${order.notes}` : ''}\nPayment: ${paymentLabel(order.payment_method)}${lowStock.length ? `\n\n⚠️ Low stock: ${lowStock.map((l) => `${l.title} (${l.stock} left)`).join(', ')}` : ''}`;
  const jobs = [];
  const staffTpl = S.notifications?.templates?.staffAlert;
  for (const staff of S.notifications?.staffWaIds || []) {
    const to = String(staff).replace(/\D/g, '');
    if (send && to !== order.wa_id) jobs.push(notify(tenant, to, { type: 'text', text }, staffTpl ? { name: staffTpl, params: [text.replace(/\*/g, '').replace(/\n+/g, ' · ').slice(0, 900)] } : null, send).catch((e) => console.error('[notify staff]', e.message)));
  }
  if (S.notifications?.webhookUrl) {
    jobs.push(
      fetch(S.notifications.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, tenant: tenant.id, order }), signal: AbortSignal.timeout(10000) }).catch((e) => console.error('[notify webhook]', e.message)),
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
  const paidNow = payment_status === 'paid' && o.payment_status !== 'paid';
  getDb()
    .prepare(`UPDATE orders SET status = ?, payment_status = ?, notes = ?, paid_at = CASE WHEN ? THEN datetime('now') ELSE paid_at END, updated_at = datetime('now') WHERE id = ?`)
    .run(status ?? o.status, payment_status ?? o.payment_status, notes ?? o.notes, paidNow ? 1 : 0, id);
  return getOrder(tenantId, id);
}

export function findOrderByReceipt(token) {
  return mapOrder(getDb().prepare('SELECT * FROM orders WHERE receipt_token = ?').get(String(token || '')));
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

/** Order status update to the customer, with the order_update template outside the 24h window. */
export function sendOrderUpdate(tenant, order, send) {
  const tpl = tenant.settings.notifications?.templates?.orderUpdate;
  return notify(tenant, order.wa_id, orderUpdateMessage(tenant, order), tpl ? { name: tpl, params: [(order.customer_name || 'there').split(' ')[0], order.store_order_name, (STATUS_TEXT[order.status] || order.status).replace(/[^\w\s]/g, '').trim()] } : null, send);
}

export function orderUpdateMessage(tenant, order) {
  const sym = tenant.settings.business.currencySymbol || '£';
  return {
    type: 'text',
    text: `Update on your order *${order.store_order_name}*: it is now *${STATUS_TEXT[order.status] || order.status}*.${order.payment_status === 'paid' ? '\nPayment received — thank you!' : ''}\nTotal: ${money(order.subtotal, sym)}`,
  };
}

export { toPlainText };
