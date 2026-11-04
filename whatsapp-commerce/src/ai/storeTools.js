import fs from 'node:fs';
import { getStore } from '../stores/index.js';
import { getConversation, saveConversation, upsertCustomer, updateCustomer } from '../bot/state.js';
import { addToCart, removeFromCart, subtotal, money, formatCart } from '../bot/cart.js';
import { placeOrder, listOrders } from '../bot/orders.js';

/*
 * The store tools an AI agent can use – shared by the Dify agent (HTTP /tools) and the direct AI agent
 * (in-process function calling). Every call is bound to ONE customer (tenant + waId) chosen by the server,
 * never by the model, so a prompt injection can't touch another customer's cart or orders.
 */

const spec = JSON.parse(fs.readFileSync(new URL('../../dify/store-tools.openapi.json', import.meta.url), 'utf8'));

/** OpenAI-style function definitions generated from the same OpenAPI spec Dify uses (minus session_token). */
export const TOOL_DEFS = Object.values(spec.paths).map(({ post }) => {
  const schema = structuredClone(post.requestBody.content['application/json'].schema);
  delete schema.properties.session_token;
  schema.required = (schema.required || []).filter((r) => r !== 'session_token');
  return { type: 'function', function: { name: post.operationId, description: post.description, parameters: schema } };
});

const brief = (p, sym) => ({ product_id: p.id, title: p.title, price: money(p.price, sym), in_stock: p.available, description: p.description?.slice(0, 200), url: p.url, options: p.variants.map((v) => ({ variant_id: v.id, title: v.title, price: money(v.price, sym), in_stock: v.available })) });

/**
 * Run one tool for one customer. deliver(msg) sends a WhatsApp message to that customer (used by checkout to
 * send the tappable pay/confirmation button).
 */
export async function runTool({ tenant, waId, deliver }, name, args = {}) {
  const store = getStore(tenant);
  const sym = tenant.settings.business.currencySymbol || '£';
  switch (name) {
    case 'search_products': {
      const products = await store.searchProducts(String(args.query || ''), { limit: Math.min(Number(args.limit) || 5, 10) });
      // remember results so the WhatsApp reply can include a tappable product list
      const conv = getConversation(tenant.id, waId);
      conv.data.lastSearch = { at: Date.now(), products: products.slice(0, 10).map((p) => ({ id: p.id, title: p.title, price: p.price, available: p.available, description: (p.description || '').slice(0, 60), compareAtPrice: p.compareAtPrice || null })) };
      saveConversation(conv);
      return { products: products.map((p) => brief(p, sym)) };
    }
    case 'list_categories':
      return { categories: await store.listCategories() };
    case 'get_product': {
      const p = await store.getProduct(String(args.product_id));
      return p ? brief(p, sym) : { error: 'not found' };
    }
    case 'add_to_cart': {
      const p = await store.getProduct(String(args.product_id));
      if (!p) return { error: 'product not found' };
      const v = p.variants.find((x) => String(x.id) === String(args.variant_id || '')) || (p.variants.length === 1 ? p.variants[0] : null);
      if (!v) return { error: 'variant_id required', options: p.variants.map((x) => ({ variant_id: x.id, title: x.title })) };
      if (!v.available) return { error: 'out of stock' };
      const conv = getConversation(tenant.id, waId);
      addToCart(conv.cart, { productId: p.id, variantId: v.id, title: v.title === p.title ? p.title : `${p.title} (${v.title})`, price: v.price, quantity: args.quantity || 1 });
      conv.data.reminded = false;
      saveConversation(conv);
      return { ok: true, cart: formatCart(conv.cart, sym), subtotal: money(subtotal(conv.cart), sym) };
    }
    case 'view_cart': {
      const conv = getConversation(tenant.id, waId);
      return { items: conv.cart.map((i, n) => ({ line: n + 1, ...i })), subtotal: money(subtotal(conv.cart), sym) };
    }
    case 'remove_from_cart': {
      const conv = getConversation(tenant.id, waId);
      removeFromCart(conv.cart, Number(args.line) - 1);
      saveConversation(conv);
      return { ok: true, cart: formatCart(conv.cart, sym) };
    }
    case 'checkout': {
      const O = tenant.settings.ordering;
      const conv = getConversation(tenant.id, waId);
      if (!conv.cart.length) return { error: 'cart is empty' };
      const online = store.type === 'shopify_public';
      const fulfilment = online ? 'online_checkout' : (O.fulfilment || ['delivery']).includes(args.fulfilment) ? args.fulfilment : (O.fulfilment || ['delivery'])[0];
      const methods = online ? ['payment_link'] : O.paymentMethods || ['payment_link'];
      const paymentMethod = methods.includes(args.payment_method) ? args.payment_method : methods[0];
      const customer = upsertCustomer(tenant.id, waId);
      if (args.customer_name) { customer.name = String(args.customer_name).slice(0, 120); updateCustomer(tenant.id, waId, { name: customer.name }); }
      const address = args.address ? String(args.address).slice(0, 500) : customer.address;
      if (fulfilment === 'delivery' && !address) return { error: 'delivery address required – ask the customer for name and full address' };
      if (address && fulfilment === 'delivery') updateCustomer(tenant.id, waId, { address });
      try {
        const { order, messages } = await placeOrder({ tenant, store, conv, customer, fulfilment, paymentMethod, address: fulfilment === 'delivery' ? address : '', send: deliver ? (to, m) => (to === waId ? deliver(m) : undefined) : undefined });
        saveConversation(conv);
        if (deliver) for (const m of messages.slice(0, 1)) await Promise.resolve(deliver(m)).catch(() => {});
        return { ok: true, order: order.store_order_name, total: order.subtotal, payment_method: paymentMethod, checkout_url: order.checkout_url, note: 'The confirmation / payment button was already sent to the customer; just tell them briefly.' };
      } catch (e) {
        return { error: 'could not create order: ' + (e.userMessage || e.message) };
      }
    }
    case 'order_status': {
      if (args.order_number) {
        const live = await store.getOrderStatus(String(args.order_number), waId).catch(() => null);
        if (live) return live;
      }
      return { orders: listOrders(tenant.id, { waId, limit: 5 }).map((o) => ({ order: o.store_order_name, status: o.status, payment: o.payment_status, total: o.subtotal, created: o.created_at })) };
    }
    case 'handover': {
      const conv = getConversation(tenant.id, waId);
      conv.humanHandover = true;
      saveConversation(conv);
      return { ok: true, note: 'A human agent will take over. Tell the customer someone will reply soon.' };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
