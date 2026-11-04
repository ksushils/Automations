import express from 'express';
import { authenticateToolKey, getTenant } from '../tenants.js';
import { verifySessionToken } from '../session.js';
import { getStore } from '../stores/index.js';
import { getConversation, saveConversation, upsertCustomer, updateCustomer } from '../bot/state.js';
import { addToCart, removeFromCart, subtotal, money, formatCart } from '../bot/cart.js';
import { placeOrder, listOrders } from '../bot/orders.js';
import { createSender } from '../whatsapp/cloudApi.js';

/**
 * Store tools for a Dify *Agent* app (import dify/store-tools.openapi.json as a Custom Tool).
 * Auth: header X-Tool-Key (per tenant) + session_token (per customer, injected by us as a Dify input).
 */
export function toolsRouter() {
  const r = express.Router();

  r.use((req, res, next) => {
    const token = req.body?.session_token || req.query.session_token;
    const session = verifySessionToken(token);
    if (!session) return res.status(401).json({ error: 'invalid session_token – pass the {{session_token}} input unchanged' });
    if (!authenticateToolKey(session.tenantId, req.get('x-tool-key'))) return res.status(401).json({ error: 'invalid X-Tool-Key' });
    const tenant = getTenant(session.tenantId);
    req.ctx = { tenant, waId: session.waId, store: getStore(tenant), sym: tenant.settings.business.currencySymbol || '£' };
    next();
  });

  const brief = (p, sym) => ({ product_id: p.id, title: p.title, price: money(p.price, sym), in_stock: p.available, description: p.description?.slice(0, 200), url: p.url, options: p.variants.map((v) => ({ variant_id: v.id, title: v.title, price: money(v.price, sym), in_stock: v.available })) });

  r.post('/search_products', async (req, res) => {
    const { store, sym } = req.ctx;
    const products = await store.searchProducts(String(req.body.query || ''), { limit: Math.min(Number(req.body.limit) || 5, 10) });
    res.json({ products: products.map((p) => brief(p, sym)) });
  });

  r.post('/list_categories', async (req, res) => {
    res.json({ categories: await req.ctx.store.listCategories() });
  });

  r.post('/get_product', async (req, res) => {
    const p = await req.ctx.store.getProduct(String(req.body.product_id));
    res.json(p ? brief(p, req.ctx.sym) : { error: 'not found' });
  });

  r.post('/add_to_cart', async (req, res) => {
    const { tenant, waId, store, sym } = req.ctx;
    const p = await store.getProduct(String(req.body.product_id));
    if (!p) return res.json({ error: 'product not found' });
    const v = p.variants.find((x) => String(x.id) === String(req.body.variant_id || '')) || (p.variants.length === 1 ? p.variants[0] : null);
    if (!v) return res.json({ error: 'variant_id required', options: p.variants.map((x) => ({ variant_id: x.id, title: x.title })) });
    if (!v.available) return res.json({ error: 'out of stock' });
    const conv = getConversation(tenant.id, waId);
    addToCart(conv.cart, { productId: p.id, variantId: v.id, title: v.title === p.title ? p.title : `${p.title} (${v.title})`, price: v.price, quantity: req.body.quantity || 1 });
    conv.data.reminded = false;
    saveConversation(conv);
    res.json({ ok: true, cart: formatCart(conv.cart, sym), subtotal: money(subtotal(conv.cart), sym) });
  });

  r.post('/view_cart', (req, res) => {
    const conv = getConversation(req.ctx.tenant.id, req.ctx.waId);
    res.json({ items: conv.cart.map((i, n) => ({ line: n + 1, ...i })), subtotal: money(subtotal(conv.cart), req.ctx.sym) });
  });

  r.post('/remove_from_cart', (req, res) => {
    const conv = getConversation(req.ctx.tenant.id, req.ctx.waId);
    removeFromCart(conv.cart, Number(req.body.line) - 1);
    saveConversation(conv);
    res.json({ ok: true, cart: formatCart(conv.cart, req.ctx.sym) });
  });

  r.post('/checkout', async (req, res) => {
    const { tenant, waId, store } = req.ctx;
    const O = tenant.settings.ordering;
    const conv = getConversation(tenant.id, waId);
    if (!conv.cart.length) return res.json({ error: 'cart is empty' });
    const fulfilment = (O.fulfilment || ['delivery']).includes(req.body.fulfilment) ? req.body.fulfilment : (O.fulfilment || ['delivery'])[0];
    const methods = O.paymentMethods || ['payment_link'];
    const paymentMethod = methods.includes(req.body.payment_method) ? req.body.payment_method : methods[0];
    const customer = upsertCustomer(tenant.id, waId);
    if (req.body.customer_name) { customer.name = String(req.body.customer_name).slice(0, 120); updateCustomer(tenant.id, waId, { name: customer.name }); }
    const address = req.body.address ? String(req.body.address).slice(0, 500) : customer.address;
    if (fulfilment === 'delivery' && !address) return res.json({ error: 'delivery address required – ask the customer for name and full address' });
    if (address) updateCustomer(tenant.id, waId, { address });
    try {
      const send = createSender(tenant);
      const { order, messages } = await placeOrder({ tenant, store, conv, customer, fulfilment, paymentMethod, address, send });
      saveConversation(conv);
      // Send the confirmation / pay button straight to WhatsApp so the customer gets a tappable link.
      for (const m of messages.slice(0, 1)) await send(waId, m).catch(() => {});
      res.json({ ok: true, order: order.store_order_name, total: order.subtotal, payment_method: paymentMethod, checkout_url: order.checkout_url, note: 'Confirmation was already sent to the customer on WhatsApp; just tell them briefly.' });
    } catch (e) {
      res.json({ error: 'could not create order: ' + e.message });
    }
  });

  r.post('/order_status', async (req, res) => {
    const { tenant, waId, store } = req.ctx;
    if (req.body.order_number) {
      const live = await store.getOrderStatus(String(req.body.order_number), waId).catch(() => null);
      if (live) return res.json(live);
    }
    res.json({ orders: listOrders(tenant.id, { waId, limit: 5 }).map((o) => ({ order: o.store_order_name, status: o.status, payment: o.payment_status, total: o.subtotal, created: o.created_at })) });
  });

  r.post('/handover', (req, res) => {
    const conv = getConversation(req.ctx.tenant.id, req.ctx.waId);
    conv.humanHandover = true;
    saveConversation(conv);
    res.json({ ok: true, note: 'A human agent will take over. Tell the customer someone will reply soon.' });
  });

  r.use((err, req, res, _next) => {
    console.error('[tools]', err.message);
    res.status(200).json({ error: err.message });
  });
  return r;
}
