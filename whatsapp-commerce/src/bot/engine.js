import { getStore } from '../stores/index.js';
import { difyChat } from '../dify/client.js';
import { createSessionToken } from '../session.js';
import { withinLimit, bumpUsage, aiBudgetUsed } from '../tenants.js';
import { getConversation, saveConversation, upsertCustomer, updateCustomer } from './state.js';
import { addToCart, removeFromCart, subtotal, money, formatCart } from './cart.js';
import { placeOrder, listOrders, paymentLabel, STATUS_TEXT, findOrderByReceipt, receiptUrl } from './orders.js';
import { quote, validatePromo, findPromo, upcomingSlots } from './pricing.js';
import { findTriggeredFlow, startFlow, handleFlowButton, handleFlowAnswer, handleFlowForm, runFlow, getFlow, schedule } from './flows.js';
import { notify } from '../whatsapp/cloudApi.js';
import { getDb } from '../db.js';
import { config as appConfig } from '../config.js';
import { alert } from '../ops.js';
import { searchKnowledge, topicOf, topicDoc } from '../knowledge.js';
import { recordConsent, defaultWording } from '../consent.js';
import { directConfigured, directTurn } from '../ai/direct.js';
import { difyAllowed } from '../ai/gate.js';

const consentWording = (ctx) => ctx.S.notifications?.consentWording || defaultWording(ctx.S.business.name);

// ---------- helpers ----------
const PAY_BUTTONS = { payment_link: '💳 Pay online', cod: '💵 Pay on delivery', bank_transfer: '🏦 Bank transfer' };
const FUL_BUTTONS = { delivery: '🚚 Delivery', pickup: '🏬 Collection' };

/** Convert common Markdown (from the LLM) to WhatsApp formatting. */
export function toWhatsAppFormatting(s) {
  return String(s || '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1: $2')
    .replace(/~~(.+?)~~/g, '~$1~')
    .trim();
}

const wasPrice = (p, sym) => (p.compareAtPrice ? ` (was ${money(p.compareAtPrice, sym)})` : '');
const norm = (s) => String(s || '').trim().toLowerCase().replace(/[!?.]+$/g, '');

function availablePaymentMethods(tenant, store) {
  if (store.type === 'shopify_public') return ['payment_link']; // paid on the shop's own Shopify checkout
  const S = tenant.settings.ordering;
  return (S.paymentMethods || ['cod']).filter((m) => m !== 'payment_link' || store.type !== 'manual' || S.paymentLinkUrl || tenant.settings.payments?.stripe?.secretKey);
}

// ---------- screens ----------
function mainMenu(ctx, intro) {
  const n = ctx.conv.cart.reduce((s, i) => s + i.quantity, 0);
  return {
    type: 'buttons',
    text: intro || `What would you like to do? You can also just type what you're looking for (e.g. "${ctx.S.business.exampleQuery || 'gift ideas under £20'}").`,
    buttons: [
      { id: 'browse', title: '🛍️ Browse' },
      { id: 'cart', title: n ? `🛒 Cart (${n})` : '🛒 Cart' },
      { id: 'more', title: '☰ More' },
    ],
  };
}

function moreMenu() {
  return {
    type: 'list',
    text: 'How can we help?',
    button: 'Options',
    sections: [
      {
        title: 'Help',
        rows: [
          { id: 'status', title: '📦 Order status', description: 'Track a recent order' },
          { id: 'human', title: '🙋 Talk to a person', description: 'Chat with our team' },
          { id: 'subscribe', title: '🔔 Get offers', description: 'Receive deals on WhatsApp' },
          { id: 'unsubscribe', title: '🔕 Stop offers', description: 'Opt out of promotions' },
        ],
      },
    ],
  };
}

function productList(ctx, products, text) {
  const sym = ctx.S.business.currencySymbol || '£';
  return {
    type: 'list',
    text,
    button: 'View products',
    sections: [
      {
        title: 'Products',
        rows: products.slice(0, 10).map((p) => ({
          id: `p:${p.id}`,
          title: p.title,
          description: `${money(p.price, sym)}${wasPrice(p, sym)}${p.available ? '' : ' · out of stock'}${p.description ? ' · ' + p.description : ''}`,
        })),
      },
    ],
  };
}

async function showCategories(ctx) {
  const cats = await ctx.store.listCategories();
  if (!cats.length) return showSearchResults(ctx, '', 'Here are our products:');
  if (cats.length === 1) return showCategory(ctx, cats[0].id, cats[0].title);
  ctx.reply({
    type: 'list',
    text: 'Choose a category 👇',
    button: 'Categories',
    sections: [{ title: 'Categories', rows: cats.slice(0, 10).map((c) => ({ id: `cat:${c.id}`, title: c.title })) }],
    footer: 'Or type what you are looking for',
  });
}

async function showCategory(ctx, id, title) {
  const products = await ctx.store.productsInCategory(id, { limit: 10 });
  if (!products.length) return ctx.reply(mainMenu(ctx, 'That category is empty right now.'));
  ctx.reply(productList(ctx, products, title ? `*${title}* — tap a product to see details.` : 'Tap a product to see details.'));
}

async function showSearchResults(ctx, query, text) {
  const products = await ctx.store.searchProducts(query, { limit: 10 });
  if (!products.length) {
    ctx.reply(mainMenu(ctx, `Sorry, I couldn't find anything for “${query}”. Try another word or browse our categories.`));
    return [];
  }
  ctx.reply(productList(ctx, products, text || `Here's what I found for “${query}”:`));
  return products;
}

async function showProduct(ctx, productId) {
  const p = await ctx.store.getProduct(productId);
  if (!p) return ctx.reply(mainMenu(ctx, 'Sorry, that product is no longer available.'));
  const sym = ctx.S.business.currencySymbol || '£';
  const price = p.compareAtPrice ? `~${money(p.compareAtPrice, sym)}~ *${money(p.price, sym)}* 🔥` : money(p.price, sym);
  const caption = `*${p.title}*\n${price}${p.available ? '' : ' — currently out of stock'}\n\n${p.description || ''}`.trim();
  if (p.image) ctx.reply({ type: 'image', url: p.image, caption });
  const variants = p.variants.filter((v) => v.available);
  if (!p.available || !variants.length) {
    return ctx.reply({ type: 'buttons', text: p.image ? 'This item is out of stock.' : caption, buttons: [{ id: 'browse', title: '🛍️ Browse' }, { id: 'human', title: '🙋 Ask us' }] });
  }
  if (variants.length > 1) {
    return ctx.reply({
      type: 'list',
      text: p.image ? 'Choose an option:' : `${caption}\n\nChoose an option:`,
      button: 'Options',
      sections: [{ title: 'Options', rows: variants.slice(0, 10).map((v) => ({ id: `v:${p.id}|${v.id}`, title: v.title, description: money(v.price, sym) })) }],
    });
  }
  ctx.reply({
    type: 'buttons',
    text: p.image ? 'Would you like to add this to your cart?' : caption,
    buttons: [{ id: `v:${p.id}|${variants[0].id}`, title: '➕ Add to cart' }, { id: 'browse', title: '🛍️ Browse' }, { id: 'cart', title: '🛒 View cart' }],
  });
}

async function chooseVariant(ctx, productId, variantId) {
  const p = await ctx.store.getProduct(productId);
  const v = p?.variants.find((x) => String(x.id) === String(variantId));
  if (!p || !v || !v.available) return ctx.reply(mainMenu(ctx, 'Sorry, that option is no longer available.'));
  ctx.conv.state = 'awaiting_qty';
  ctx.conv.data.pending = { productId: p.id, variantId: v.id, title: v.title === p.title ? p.title : `${p.title} (${v.title})`, price: v.price, stock: v.stock ?? null };
  ctx.reply({
    type: 'list',
    text: `How many *${ctx.conv.data.pending.title}* would you like? (or type a number)`,
    button: 'Quantity',
    sections: [{ title: 'Quantity', rows: [1, 2, 3, 4, 5, 6, 8, 10].map((n) => ({ id: `q:${n}`, title: String(n) })) }],
  });
}

function addPending(ctx, qty) {
  const pending = ctx.conv.data.pending;
  if (!pending) return ctx.reply(mainMenu(ctx));
  if (pending.stock !== null && pending.stock !== undefined && pending.stock !== '') {
    const inCart = ctx.conv.cart.filter((i) => i.productId === pending.productId && i.variantId === pending.variantId).reduce((n, i) => n + i.quantity, 0);
    if (qty + inCart > Number(pending.stock)) return ctx.reply({ type: 'text', text: `Sorry, we only have ${Math.max(0, Number(pending.stock) - inCart)} more of ${pending.title} in stock. Please pick a smaller quantity.` });
  }
  const { stock: _stock, ...item } = pending;
  addToCart(ctx.conv.cart, { ...item, quantity: qty });
  delete ctx.conv.data.pending;
  ctx.conv.data.reminded = false;
  ctx.conv.state = 'idle';
  const sym = ctx.S.business.currencySymbol || '£';
  ctx.reply({
    type: 'buttons',
    text: `Added ${qty} × ${pending.title} to your cart ✅\nCart subtotal: *${money(subtotal(ctx.conv.cart), sym)}*`,
    buttons: [{ id: 'checkout', title: '✅ Checkout' }, { id: 'browse', title: '🛍️ Keep shopping' }, { id: 'cart', title: '🛒 View cart' }],
  });
}

function showCart(ctx) {
  const sym = ctx.S.business.currencySymbol || '£';
  if (!ctx.conv.cart.length) return ctx.reply(mainMenu(ctx, 'Your cart is empty. Let\'s find something you\'ll love!'));
  ctx.reply({ type: 'buttons', text: `🛒 *Your cart*\n\n${formatCart(ctx.conv.cart, sym)}\n\n_Type "remove 2" to remove item 2._`, buttons: [{ id: 'checkout', title: '✅ Checkout' }, { id: 'browse', title: '🛍️ Add more' }, { id: 'clear', title: '🗑️ Empty cart' }] });
}

// ---------- checkout ----------
function startCheckout(ctx) {
  const sym = ctx.S.business.currencySymbol || '£';
  if (!ctx.conv.cart.length) return ctx.reply(mainMenu(ctx, 'Your cart is empty — add something first.'));
  // Website chat visitors have no WhatsApp number: hand the basket to the storefront checkout
  // (Shopify URL-only shops go straight to Shopify's checkout through the normal flow).
  if (String(ctx.conv.waId).startsWith('web:') && ctx.store.type !== 'shopify_public') {
    const cart = Buffer.from(JSON.stringify(ctx.conv.cart.map(({ productId, variantId, quantity, title, price }) => ({ productId, variantId, quantity, title, price })))).toString('base64url');
    return ctx.reply({ type: 'cta', text: `🛒 ${formatCart(ctx.conv.cart, sym)}\n\nTap below to choose delivery or collection and pay securely.`, buttonText: 'Checkout', url: `${appConfig.publicUrl}/s/${ctx.tenant.id}?cart=${cart}#checkout` });
  }
  const min = Number(ctx.S.ordering.minOrder) || 0;
  if (min && subtotal(ctx.conv.cart) < min) {
    return ctx.reply({ type: 'buttons', text: `Our minimum order is ${money(min, sym)}. Your cart is ${money(subtotal(ctx.conv.cart), sym)}.`, buttons: [{ id: 'browse', title: '🛍️ Add more' }] });
  }
  ctx.conv.data.checkout = {};
  return nextCheckoutStep(ctx);
}

async function nextCheckoutStep(ctx) {
  const co = (ctx.conv.data.checkout ||= {});
  const O = ctx.S.ordering;
  const sym = ctx.S.business.currencySymbol || '£';

  if (ctx.store.type === 'shopify_public') {
    // Delivery, tax and payment are chosen on the shop's Shopify checkout
    co.fulfilment = 'online_checkout';
    co.paymentMethod = 'payment_link';
    return showSummary(ctx);
  }
  if (!co.fulfilment) {
    const opts = (O.fulfilment?.length ? O.fulfilment : ['delivery']).filter((f) => FUL_BUTTONS[f]);
    if (opts.length === 1) co.fulfilment = opts[0];
    else {
      ctx.conv.state = 'checkout_fulfilment';
      return ctx.reply({ type: 'buttons', text: 'How would you like to receive your order?', buttons: opts.map((f) => ({ id: `ful:${f}`, title: FUL_BUTTONS[f] })) });
    }
  }
  if (co.fulfilment === 'delivery' && !co.address) {
    ctx.conv.state = 'awaiting_address';
    if (ctx.customer.address) {
      return ctx.reply({ type: 'buttons', text: `Deliver to your saved address?\n\n${ctx.customer.address}`, buttons: [{ id: 'addr:saved', title: '✅ Yes, use this' }, { id: 'addr:new', title: '✏️ New address' }] });
    }
    return ctx.reply({ type: 'text', text: '📍 Please send your *full name and delivery address* (including postcode) in one message — or share your location using 📎 → Location.' });
  }
  if (co.fulfilment === 'delivery' && co.address && (O.deliveryZones || []).length) {
    const q = quote(ctx.tenant, ctx.conv.cart, co);
    if (q.error === 'no_zone') {
      delete co.address;
      ctx.conv.state = 'awaiting_address';
      const pickup = (O.fulfilment || []).includes('pickup');
      return ctx.reply({ type: 'buttons', text: `😔 Sorry, we don't deliver to that area yet (we cover ${(O.deliveryZones || []).map((z) => z.name).filter(Boolean).join(', ') || 'selected areas'}).\n\nSend a different address${pickup ? ' or choose collection' : ''}.`, buttons: pickup ? [{ id: 'ful:pickup', title: FUL_BUTTONS.pickup }, { id: 'cancel', title: '❌ Cancel' }] : [{ id: 'cancel', title: '❌ Cancel' }] });
    }
    if (q.minOrder && q.subtotal < q.minOrder) {
      return ctx.reply({ type: 'buttons', text: `The minimum order for ${q.zone?.name || 'delivery to your area'} is ${money(q.minOrder, sym)}. Your cart is ${money(q.subtotal, sym)}.`, buttons: [{ id: 'browse', title: '🛍️ Add more' }, ...((O.fulfilment || []).includes('pickup') ? [{ id: 'ful:pickup', title: FUL_BUTTONS.pickup }] : [])] });
    }
  }
  if (O.slots?.enabled && !co.slot) {
    const slots = upcomingSlots(O.slots, { timeZone: ctx.S.business.timezone || 'Europe/London' });
    if (slots.length) {
      ctx.conv.state = 'checkout_slot';
      ctx.conv.data.slotOptions = slots;
      return ctx.reply({ type: 'list', text: `🕒 When would you like your ${co.fulfilment === 'pickup' ? 'collection' : 'delivery'}?`, button: 'Choose time', sections: [{ title: 'Available times', rows: slots.map((x) => ({ id: `slot:${x.id}`, title: x.label.split(' · ')[0], description: x.label.split(' · ')[1] })) }] });
    }
  }
  if (!co.paymentMethod) {
    const opts = availablePaymentMethods(ctx.tenant, ctx.store);
    if (opts.length === 1) co.paymentMethod = opts[0];
    else {
      ctx.conv.state = 'checkout_payment';
      return ctx.reply({ type: 'buttons', text: 'How would you like to pay?', buttons: opts.slice(0, 3).map((m) => ({ id: `pay:${m}`, title: m === 'cod' && co.fulfilment === 'pickup' ? '💵 Pay on collection' : PAY_BUTTONS[m] })) });
    }
  }
  return showSummary(ctx);
}

function showSummary(ctx, intro) {
  const co = ctx.conv.data.checkout;
  const O = ctx.S.ordering;
  const sym = ctx.S.business.currencySymbol || '£';
  const q = quote(ctx.tenant, ctx.conv.cart, co, { waId: ctx.conv.waId });
  ctx.conv.state = 'checkout_confirm';
  const hints = [(O.promoCodes || []).length && !q.promo ? '🏷️ Have a promo code? Type it now.' : '', O.askNote !== false && !co.note ? '📝 Want to add a note (gift message, instructions)? Just type it.' : ''].filter(Boolean).join('\n');
  ctx.reply({
    type: 'buttons',
    header: 'Order summary',
    text: `${intro ? intro + '\n\n' : ''}${formatCart(ctx.conv.cart, sym)}${q.discount ? `\nDiscount (${q.promo.code}): -${money(q.discount, sym)}` : ''}${co.fulfilment === 'delivery' ? `\nDelivery: ${q.deliveryFee ? money(q.deliveryFee, sym) : 'FREE'}` : ''}${co.fulfilment === 'online_checkout' ? '\n_Delivery is added at checkout._' : `\n*Total: ${money(q.total, sym)}*`}\n\n${co.fulfilment === 'online_checkout' ? '🚚 You’ll choose delivery and pay securely on our website checkout.' : co.fulfilment === 'delivery' ? `🚚 Deliver to: ${co.address}` : `🏬 Collection${O.pickupAddress ? ` from ${O.pickupAddress}` : ''}`}${co.slot ? `\n🕒 ${co.slot.label}` : ''}${co.fulfilment === 'online_checkout' ? '' : `\n💳 Payment: ${paymentLabel(co.paymentMethod)}`}${co.note ? `\n📝 Note: ${co.note}` : ''}${hints ? `\n\n${hints}` : ''}`,
    buttons: [{ id: 'confirm', title: co.fulfilment === 'online_checkout' ? '✅ Go to checkout' : '✅ Place order' }, { id: 'cart', title: '✏️ Edit cart' }, { id: 'cancel', title: '❌ Cancel' }],
  });
}

async function confirmOrder(ctx) {
  const co = ctx.conv.data.checkout;
  if (ctx.conv.state !== 'checkout_confirm' || !co?.paymentMethod) return startCheckout(ctx);
  if (!ctx.conv.cart.length) return ctx.reply(mainMenu(ctx, 'Your cart is empty.'));
  try {
    const { messages } = await placeOrder({ tenant: ctx.tenant, store: ctx.store, conv: ctx.conv, customer: ctx.customer, fulfilment: co.fulfilment, paymentMethod: co.paymentMethod, address: co.address, send: ctx.rawSend });
    messages.forEach((m) => ctx.reply(m));
  } catch (e) {
    console.error(`[order] tenant=${ctx.tenant.id}`, e.message);
    if (e.userMessage) return ctx.reply({ type: 'buttons', text: e.userMessage, buttons: [{ id: 'cart', title: '🛒 View cart' }, { id: 'human', title: '🙋 Talk to us' }] });
    ctx.reply({ type: 'buttons', text: 'Sorry, something went wrong while placing your order. Please try again, or talk to our team.', buttons: [{ id: 'confirm', title: '🔁 Try again' }, { id: 'human', title: '🙋 Talk to us' }] });
  }
}

function setAddress(ctx, text) {
  const address = String(text).trim().slice(0, 500);
  if (address.length < 8) return ctx.reply({ type: 'text', text: 'That address looks too short — please include your name, street, town and postcode.' });
  ctx.conv.data.checkout.address = address;
  updateCustomer(ctx.tenant.id, ctx.conv.waId, { address });
  ctx.customer.address = address;
  return nextCheckoutStep(ctx);
}

// ---------- order status ----------
async function orderStatus(ctx, ref) {
  const sym = ctx.S.business.currencySymbol || '£';
  if (ref) {
    const live = await ctx.store.getOrderStatus(ref, ctx.conv.waId).catch(() => null);
    if (live) {
      const t = live.tracking?.length ? `\nTracking: ${live.tracking.map((x) => [x.company, x.number, x.url].filter(Boolean).join(' ')).join('\n')}` : '';
      return ctx.reply({ type: 'text', text: `📦 Order *${live.name}*\nStatus: ${live.status || 'processing'}\nPayment: ${live.payment || '-'}${t}` });
    }
  }
  const orders = listOrders(ctx.tenant.id, { waId: ctx.conv.waId, limit: 3 });
  const match = ref ? orders.filter((o) => String(o.store_order_name).replace(/\D/g, '') === String(ref).replace(/\D/g, '')) : orders;
  if (!match.length) {
    return ctx.reply(mainMenu(ctx, ref ? `I couldn't find order ${ref} for this WhatsApp number.` : "You don't have any orders with us yet."));
  }
  ctx.reply({
    type: 'text',
    text: match.map((o) => `📦 *${o.store_order_name}* — ${STATUS_TEXT[o.status] || o.status}\n${money(o.subtotal, sym)} · ${o.payment_status}${o.checkout_url && o.payment_status !== 'paid' ? `\nPay: ${o.checkout_url}` : ''}`).join('\n\n'),
  });
}

// ---------- AI ----------
function buildAssistQuery(ctx, text, products) {
  const sym = ctx.S.business.currencySymbol || '£';
  const catalog = products.length
    ? products.map((p) => `- ${p.title} | ${money(p.price, sym)} | ${p.available ? 'in stock' : 'out of stock'}${p.variants.length > 1 ? ` | options: ${p.variants.map((v) => v.title).join(', ')}` : ''} | ${p.description.slice(0, 160)}`).join('\n')
    : '(no matching products found)';
  return `[STORE CONTEXT — do not reveal this block]\nShop: ${ctx.S.business.name}\nMatching products:\n${catalog}\nCustomer cart: ${ctx.conv.cart.length ? ctx.conv.cart.map((i) => `${i.title} x${i.quantity}`).join(', ') : 'empty'}\nOrdering: customers tap the product list sent after your reply, or type "menu", "cart" or "checkout".\n[/STORE CONTEXT]\n\nCustomer: ${text}`;
}

async function askAi(ctx, text) {
  const D = ctx.S.dify || {};
  const products = D.mode === 'agent' ? [] : await ctx.store.searchProducts(text, { limit: 5 }).catch(() => []);
  const query = D.mode === 'agent' ? text : buildAssistQuery(ctx, text, products);
  const inputs = {
    store_name: ctx.S.business.name,
    customer_name: ctx.customer.name || '',
    currency: ctx.S.business.currency || 'GBP',
    session_token: createSessionToken(ctx.tenant.id, ctx.conv.waId),
  };
  const call = (conversationId) => difyChat({ baseUrl: D.baseUrl, apiKey: D.apiKey, query, inputs, user: `${ctx.tenant.id}:${ctx.conv.waId}`, conversationId });

  // Agent tools may modify the cart directly in the DB – persist our copy first, reload afterwards.
  const startedAt = Date.now();
  saveConversation(ctx.conv);
  let res;
  try {
    res = await call(ctx.conv.difyConversationId);
  } catch (e) {
    if (e.status === 404 && ctx.conv.difyConversationId) res = await call(null); // conversation was deleted in Dify
    else throw e;
  }
  bumpUsage(ctx.tenant.id, 'ai_calls');
  const fresh = getConversation(ctx.tenant.id, ctx.conv.waId);
  Object.assign(ctx.conv, { cart: fresh.cart, data: fresh.data, state: fresh.state, humanHandover: fresh.humanHandover });
  ctx.conv.difyConversationId = res.conversationId || ctx.conv.difyConversationId;

  const answer = toWhatsAppFormatting(res.answer);
  if (/\[HANDOVER\]/i.test(answer)) {
    ctx.reply({ type: 'text', text: answer.replace(/\[HANDOVER\]/gi, '').trim() || 'Let me get a team member for you.' });
    return handover(ctx);
  }
  // Agent mode: if the agent searched the catalogue this turn, attach those products as a tappable list.
  const searched = ctx.conv.data.lastSearch;
  if (!products.length && searched?.at >= startedAt && searched.products?.length && !ctx.conv.humanHandover) {
    products.push(...searched.products.map((p) => ({ ...p, variants: [] })));
  }
  if (products.length) ctx.reply(productList(ctx, products, answer || 'Here are some products you might like:'));
  else ctx.reply({ type: 'text', text: answer || "Sorry, I didn't catch that. Type *menu* to see options." });
}

function handover(ctx, text) {
  ctx.conv.humanHandover = true;
  ctx.conv.state = 'idle';
  ctx.reply({ type: 'text', text: text || `🙋 A member of our team will reply here shortly${ctx.S.business.supportHours ? ` (${ctx.S.business.supportHours})` : ''}. Your cart is saved.` });
  const staff = ctx.S.notifications?.staffWaIds || [];
  for (const s of staff) staffAlert(ctx.tenant, String(s).replace(/\D/g, ''), `🙋 Customer +${ctx.conv.waId} (${ctx.customer.name || 'unknown'}) asked to talk to a person. Reply from the dashboard.`, ctx.rawSend);
}

// ---------- routing ----------
const COMMANDS = new Set(['cart', 'basket', 'my cart', 'view cart', 'bag', 'checkout', 'check out', 'pay', 'order now', 'place order', 'clear cart', 'empty cart', 'clear basket', 'browse', 'shop', 'products', 'catalog', 'catalogue', 'categories', 'agent', 'human', 'staff', 'stop', 'unsubscribe', 'opt out', 'subscribe', 'cancel', 'my orders', 'my order']);
const GREETING = /^(hi+|hello|hey|hiya|yo|start|menu|home|main menu|good (morning|afternoon|evening)|salam|hola)\b/;

async function handleAction(ctx, id) {
  const [cmd, arg = ''] = id.split(/:(.*)/s);
  switch (cmd) {
    case 'menu': return ctx.reply(mainMenu(ctx));
    case 'more': return ctx.reply(moreMenu());
    case 'browse': return showCategories(ctx);
    case 'cat': return showCategory(ctx, arg);
    case 'p': return showProduct(ctx, arg);
    case 'v': { const [pid, vid] = arg.split('|'); return chooseVariant(ctx, pid, vid); }
    case 'q': return addPending(ctx, Number(arg) || 1);
    case 'cart': ctx.conv.state = 'idle'; return showCart(ctx);
    case 'clear': ctx.conv.cart = []; ctx.conv.state = 'idle'; return ctx.reply(mainMenu(ctx, 'Your cart has been emptied.'));
    case 'checkout': return startCheckout(ctx);
    case 'ful': (ctx.conv.data.checkout ||= {}).fulfilment = arg; return nextCheckoutStep(ctx);
    case 'addr':
      if (arg === 'saved' && ctx.customer.address) { (ctx.conv.data.checkout ||= {}).address = ctx.customer.address; return nextCheckoutStep(ctx); }
      ctx.conv.state = 'awaiting_address';
      return ctx.reply({ type: 'text', text: '📍 Please send your full name and delivery address (including postcode).' });
    case 'pay':
      if (!availablePaymentMethods(ctx.tenant, ctx.store).includes(arg)) return nextCheckoutStep(ctx);
      (ctx.conv.data.checkout ||= {}).paymentMethod = arg;
      return nextCheckoutStep(ctx);
    case 'slot': {
      const slot = (ctx.conv.data.slotOptions || []).find((x) => x.id === arg);
      if (!slot) return nextCheckoutStep(ctx);
      (ctx.conv.data.checkout ||= {}).slot = slot;
      delete ctx.conv.data.slotOptions;
      return nextCheckoutStep(ctx);
    }
    case 'confirm': return confirmOrder(ctx);
    case 'cancel': ctx.conv.state = 'idle'; delete ctx.conv.data.checkout; return ctx.reply(mainMenu(ctx, 'Checkout cancelled — your cart is still saved.'));
    case 'status': return orderStatus(ctx);
    case 'human': return handover(ctx);
    case 'subscribe':
      if (String(ctx.conv.waId).startsWith('web:')) return ctx.reply({ type: 'text', text: ctx.S.business.whatsappNumber ? `To get offers on WhatsApp, message us “subscribe” at https://wa.me/${String(ctx.S.business.whatsappNumber).replace(/\D/g, '')}` : 'Thanks! Ask our team about offers.' });
      // Ask first, record the exact wording only when they confirm (PECR: specific, informed, unambiguous)
      return ctx.reply({ type: 'buttons', text: `🔔 ${consentWording(ctx)}\n\nWe'll send a few offers a month. Reply STOP any time to opt out.`, buttons: [{ id: 'optin:yes', title: '✅ Yes, sign me up' }, { id: 'optin:no', title: 'No thanks' }] });
    case 'optin':
      if (arg !== 'yes') return ctx.reply({ type: 'text', text: "No problem – we won't send you promotions." });
      recordConsent(ctx.tenant.id, ctx.conv.waId, { status: 'granted', source: 'whatsapp_opt_in', wording: consentWording(ctx), evidence: ctx.event?.messageId ? `wamid ${ctx.event.messageId}` : 'whatsapp button', actor: 'customer' });
      return ctx.reply({ type: 'text', text: "🔔 You're subscribed to offers. Reply STOP any time to opt out." });
    case 'unsubscribe':
      recordConsent(ctx.tenant.id, ctx.conv.waId, { status: 'withdrawn', source: 'whatsapp_stop', evidence: ctx.event?.messageId ? `wamid ${ctx.event.messageId}` : 'whatsapp', actor: 'customer' });
      return ctx.reply({ type: 'text', text: "🔕 You won't receive promotional messages. You can still order any time." });
    default: {
      // Template quick-reply buttons send their text as the payload ("Stop offers", "Shop now"…)
      const t = norm(id.replace(/^[^\w]+/, ''));
      if (/^(stop|unsubscribe|stop offers|no more offers|opt out)/.test(t)) return handleAction(ctx, 'unsubscribe');
      if (/^(shop|shop now|browse|order now|view products)/.test(t)) return handleAction(ctx, 'browse');
      if (/^(track|order status|where is my order)/.test(t)) return handleAction(ctx, 'status');
      if (/^(talk|human|help|contact)/.test(t)) return handleAction(ctx, 'human');
      if (/^(pay|pay now)/.test(t)) return orderStatus(ctx);
      return id && !id.includes(':') && ctx.depth !== 1 ? ((ctx.depth = 1), handleText(ctx, id)) : ctx.reply(mainMenu(ctx));
    }
  }
}

/** Native WhatsApp catalogue cart (Meta catalogue synced from Shopify / WooCommerce / built-in). */
async function handleNativeCart(ctx, order) {
  const items = order?.product_items || [];
  let added = 0;
  for (const it of items) {
    const rid = String(it.product_retailer_id || '');
    // Shopify's Facebook channel uses ids like "shopify_GB_<productId>_<variantId>"; others use the product/variant id
    const parts = rid.split('_');
    const candidates = ctx.store.type === 'shopify' && parts.length >= 4 ? [`gid://shopify/Product/${parts.at(-2)}`] : [rid, parts.at(-1)];
    let p = null;
    for (const c of candidates) if (!p) p = await ctx.store.getProduct(c).catch(() => null);
    if (!p) continue;
    const v = p.variants.find((x) => String(x.id).endsWith(parts.at(-1)) || String(x.id) === rid) || p.variants[0];
    if (!v?.available) continue;
    addToCart(ctx.conv.cart, { productId: p.id, variantId: v.id, title: v.title === p.title ? p.title : `${p.title} (${v.title})`, price: Number(v.price ?? it.item_price), quantity: it.quantity });
    added++;
  }
  if (!added) return ctx.reply(mainMenu(ctx, "Sorry, I couldn't match those items to our shop. Please browse here instead."));
  ctx.conv.data.reminded = false;
  ctx.reply({ type: 'text', text: `🛒 Added ${added} item${added === 1 ? '' : 's'} from your WhatsApp cart.` });
  return startCheckout(ctx);
}

/** Staff alerts: free-form inside 24h, otherwise the staff alert template (if configured). */
function staffAlert(tenant, staffWaId, text, send) {
  const tpl = tenant.settings.notifications?.templates?.staffAlert;
  return notify(tenant, staffWaId, { type: 'text', text }, tpl ? { name: tpl, params: [text.slice(0, 900)] } : null, send).catch((e) => console.warn('[staff alert]', e.message));
}

async function handleText(ctx, raw) {
  const text = String(raw || '').trim();
  const t = norm(text);
  if (!t) return ctx.reply(mainMenu(ctx));

  // State-driven input first
  if (ctx.conv.state === 'awaiting_address' && !GREETING.test(t) && !COMMANDS.has(t) && !/^(order status|track|remove \d+)/.test(t)) return setAddress(ctx, text);
  if (ctx.conv.state === 'awaiting_qty' && /^\d{1,2}$/.test(t)) return addPending(ctx, Number(t));
  if (ctx.conv.state === 'checkout_confirm' && ctx.conv.data.checkout) {
    const co = ctx.conv.data.checkout;
    const O = ctx.S.ordering;
    const explicit = t.match(/^(?:promo|code|coupon|discount)(?: code)?\s*:?\s*([a-z0-9_-]{2,30})$/);
    const candidate = explicit ? explicit[1] : /^[a-z0-9_-]{3,30}$/.test(t) && !COMMANDS.has(t) && !['yes', 'no', 'ok', 'confirm'].includes(t) ? t : null;
    if (candidate && (explicit || findPromo(O, candidate))) {
      const v = validatePromo(ctx.tenant, candidate, { sub: subtotal(ctx.conv.cart), waId: ctx.conv.waId });
      if (!v.ok) return showSummary(ctx, `❌ ${v.reason}`);
      co.promoCode = v.promo.code;
      return showSummary(ctx, `🎉 Code *${v.promo.code}* applied!`);
    }
    if (O.askNote !== false && !COMMANDS.has(t) && !GREETING.test(t) && text.split(/\s+/).length >= 2 && !/^(yes|no|ok|confirm|place order)\b/.test(t)) {
      co.note = text.slice(0, 300);
      return showSummary(ctx, '📝 Note added.');
    }
  }

  // Customer confirming a web order on WhatsApp: "… [order:RECEIPT_TOKEN]"
  const webOrder = text.match(/\[order:([A-Za-z0-9_-]{8,64})\]/);
  if (webOrder) {
    const o = findOrderByReceipt(webOrder[1]);
    if (o && o.tenant_id === ctx.tenant.id && o.wa_id === ctx.conv.waId) {
      ctx.conv.data.greeted = true;
      const sym = ctx.S.business.currencySymbol || '£';
      return ctx.reply({ type: 'buttons', text: `✅ Thanks ${ctx.customer.name?.split(' ')[0] || ''}! We've got your order *${o.store_order_name}* (${money(o.subtotal, sym)}).${o.checkout_url && o.payment_status !== 'paid' ? `\n💳 Pay here: ${o.checkout_url}` : ''}\n🧾 ${receiptUrl(o)}\n\nWe'll message you here with updates.`, buttons: [{ id: 'status', title: '📦 Order status' }, { id: 'browse', title: '🛍️ Keep shopping' }] });
    }
  }

  // Deep link from the storefront page / ads: "… [ref:PRODUCT_ID]"
  const ref = text.match(/\[ref:([^\]\s]{1,120})\]/i);
  if (ref) { ctx.conv.data.greeted = true; return showProduct(ctx, ref[1]); }

  // Keyword commands
  if (GREETING.test(t) && t.split(/\s+/).length <= 4) {
    const first = !ctx.conv.data.greeted;
    ctx.conv.data.greeted = true;
    ctx.conv.state = 'idle';
    const welcome = (ctx.S.business.welcomeMessage || 'Welcome!').replace('{{name}}', ctx.customer.name ? ` ${ctx.customer.name.split(' ')[0]}` : '');
    return ctx.reply(mainMenu(ctx, first ? welcome : undefined));
  }
  if (['cart', 'basket', 'my cart', 'view cart', 'bag'].includes(t)) return handleAction(ctx, 'cart');
  if (['checkout', 'check out', 'pay', 'order now', 'place order'].includes(t)) return handleAction(ctx, 'checkout');
  if (['clear cart', 'empty cart', 'clear basket'].includes(t)) return handleAction(ctx, 'clear');
  if (['browse', 'shop', 'products', 'catalog', 'catalogue', 'categories'].includes(t)) return handleAction(ctx, 'browse');
  if (/^(agent|human|staff|person|operator|speak to (a )?(human|person|someone|agent)|talk to (a )?(human|person|someone|agent))$/.test(t)) return handleAction(ctx, 'human');
  if (['stop', 'unsubscribe', 'opt out'].includes(t)) return handleAction(ctx, 'unsubscribe');
  if (['subscribe', 'start offers', 'offers'].includes(t)) return handleAction(ctx, 'subscribe');
  if (t === 'cancel') return handleAction(ctx, 'cancel');
  if (['yes', 'confirm', 'place order'].includes(t) && ctx.conv.state === 'checkout_confirm') return handleAction(ctx, 'confirm');
  const rm = t.match(/^(remove|delete)\s+(\d+)$/);
  if (rm) { removeFromCart(ctx.conv.cart, Number(rm[2]) - 1); return showCart(ctx); }
  const os = t.match(/(?:order|track|tracking|status)\D{0,15}#?\s*(\d{3,})/) || (t.match(/^#(\d{3,})$/));
  if (os) return orderStatus(ctx, os[1]);
  if (/^(order status|track( my)? order|where is my order|my orders?)$/.test(t)) return orderStatus(ctx);

  // Free text → AI (if configured) or knowledge base + catalogue search
  const D = ctx.S.dify || {};
  if (aiAvailable(ctx) && !withinLimit(ctx.tenant, 'ai')) ownerNotice(ctx.tenant, 'ai', ctx.rawSend);
  else if (aiAvailable(ctx) && (aiBudgetUsed(ctx.tenant) ?? 0) >= 0.8) ownerNotice(ctx.tenant, 'ai80', ctx.rawSend, { monthly: true });
  if (aiAvailable(ctx) && withinLimit(ctx.tenant, 'ai')) {
    try {
      return aiProvider(ctx) === 'direct' ? await askDirect(ctx, text) : await askAi(ctx, text);
    } catch (e) {
      console.error(`[dify] tenant=${ctx.tenant.id}`, e.message);
    }
  }
  const isQuestion = /\?|^(what|how|when|where|do|does|can|is|are|which|who|why|whats|what's)\b|\b(return|refund|deliver|delivery|shipping|postage|warranty|exchange|open|hours|policy|cost of delivery|track)/i.test(text);
  const kb = isQuestion ? searchKnowledge(ctx.tenant.id, text, { limit: 1 }) : [];
  if (kb.length) {
    ctx.reply({ type: 'text', text: `${kb[0].text.length > 650 ? kb[0].text.slice(0, 650).replace(/\s\S*$/, '') + '…' : kb[0].text}\n\n_From our ${kb[0].doc}${kb[0].url ? `: ${kb[0].url}` : ''}_` });
    return ctx.reply(mainMenu(ctx, 'Anything else I can help with?'));
  }
  // A policy-type question we can't answer exactly: point to the policy and offer a person – don't guess.
  const topic = isQuestion ? topicOf(text) : null;
  if (topic) {
    const doc = topicDoc(ctx.tenant.id, topic);
    return ctx.reply({ type: 'buttons', text: `Good question! I don't have that exact detail to hand.${doc ? `\nYou can read our ${doc.name.toLowerCase()} here: ${doc.url || ''}` : ''}\n\nA member of our team can confirm for you 🙂`, buttons: [{ id: 'human', title: '🙋 Ask the team' }, { id: 'browse', title: '🛍️ Browse' }] });
  }
  return showSearchResults(ctx, text);
}

/**
 * Main entry point. `event` is a normalised inbound message (see parseInbound).
 * `send(to, msg)` delivers a message. Returns the list of messages sent to the customer.
 */
export async function handleInbound(tenant, event, send) {
  const conv = getConversation(tenant.id, event.waId);
  const customer = upsertCustomer(tenant.id, event.waId, event.profileName);
  const replies = [];
  const ctx = buildCtx(tenant, conv, customer, send, replies);
  ctx.event = event;

  // Click-to-WhatsApp ad attribution (first touch wins)
  if (event.referral && !customer.source) {
    getDb().prepare('UPDATE customers SET source = ? WHERE tenant_id = ? AND wa_id = ?').run(JSON.stringify({ ...event.referral, at: new Date().toISOString() }), tenant.id, conv.waId);
  }
  const isFirstMessage = !conv.data.seen;
  conv.data.seen = true;
  // opens / extends the 24h customer-service window
  getDb().prepare("UPDATE customers SET last_inbound_at = datetime('now') WHERE tenant_id = ? AND wa_id = ?").run(tenant.id, conv.waId);
  if (event.kind === 'ignore') { saveConversation(conv); return replies; }

  if (conv.humanHandover) {
    // A human is handling this chat – the bot stays quiet. "menu" lets the customer return to the bot.
    if (event.kind === 'text' && ['menu', 'bot'].includes(norm(event.text))) conv.humanHandover = false;
    else return replies;
  }
  if (!withinLimit(tenant, 'inbound')) {
    // Plan limit reached: never leave a customer in silence – acknowledge once a day, hand to a human, tell the owner.
    const key = `limit:${tenant.id}:${conv.waId}:${new Date().toISOString().slice(0, 10)}`;
    if (!getDb().prepare('SELECT 1 FROM kv WHERE key = ?').get(key)) {
      getDb().prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').run(key, '1');
      conv.humanHandover = true;
      saveConversation(conv);
      await send(conv.waId, { type: 'text', text: `Thanks for your message! 🙏 A member of the ${tenant.settings.business.name} team will reply here shortly.` }).catch(() => {});
      ownerNotice(tenant, 'inbound', send);
    }
    return replies;
  }

  try {
    const busy = ['awaiting_address', 'awaiting_qty', 'checkout_confirm', 'checkout_slot'].includes(conv.state);
    let flow = null;
    if (event.kind === 'action' && event.id.startsWith('flow:')) {
      if (!(await handleFlowButton(ctx, event.id))) ctx.reply(mainMenu(ctx));
    } else if (event.kind === 'form') {
      if (!(await handleFlowForm(ctx, event.response))) ctx.reply({ type: 'text', text: 'Thanks – we received your details ✅' });
    } else if (event.kind === 'native_order') {
      await handleNativeCart(ctx, event.order);
    } else if (event.kind === 'text' && (await handleFlowAnswer(ctx, event.text))) {
      // answered a flow question
    } else if ((event.kind === 'text' || event.referral) && (flow = findTriggeredFlow(tenant.id, { text: event.text, isFirstMessage, adId: event.referral?.source_id })) && (!busy || flow.triggers.keywords?.includes(norm(event.text)))) {
      await startFlow(ctx, flow);
    } else if (event.kind === 'action') await handleAction(ctx, event.id);
    else if (event.kind === 'text') await handleText(ctx, event.text);
    else if (event.kind === 'location') {
      if (conv.state === 'awaiting_address') await setAddress(ctx, `${customer.name || ''}\n${event.text}\nhttps://maps.google.com/?q=${event.location.latitude},${event.location.longitude}`.trim());
      else ctx.reply(mainMenu(ctx, 'Thanks for sharing your location! 📍'));
    } else if (event.kind === 'media' && event.type === 'audio') {
      ctx.reply({ type: 'buttons', text: "🎙️ Sorry, I can't listen to voice notes yet. Please type your message, or a team member can help.", buttons: [{ id: 'menu', title: '📋 Menu' }, { id: 'human', title: '🙋 Talk to us' }] });
    } else if (event.kind === 'media') {
      // Most likely a payment proof (bank transfer) or a photo for the team
      const unpaid = getDb().prepare("SELECT id, store_order_name FROM orders WHERE tenant_id = ? AND wa_id = ? AND payment_status = 'unpaid' AND payment_method = 'bank_transfer' AND status != 'cancelled' ORDER BY id DESC LIMIT 1").get(tenant.id, conv.waId);
      if (unpaid) getDb().prepare("UPDATE orders SET notes = TRIM(COALESCE(notes, '') || ' [payment proof received ' || datetime('now') || ']'), updated_at = datetime('now') WHERE id = ?").run(unpaid.id);
      ctx.reply({ type: 'text', text: unpaid ? `Thanks! 🙏 We've received your payment proof for order *${unpaid.store_order_name}* and will confirm shortly.` : 'Thanks! 🙏 A member of our team will check this shortly.' });
      for (const s of tenant.settings.notifications?.staffWaIds || []) staffAlert(tenant, String(s).replace(/\D/g, ''), `📎 Customer +${conv.waId} sent a ${event.type}${unpaid ? ` – payment proof for ${unpaid.store_order_name}` : ''}. View it in the dashboard inbox.`, send);
    } else if (event.kind === 'text' && event.text) {
      await handleText(ctx, event.text);
    } else {
      ctx.reply(mainMenu(ctx, "I can't read that type of message yet — please type or tap an option."));
    }
  } catch (e) {
    console.error(`[engine] tenant=${tenant.id}`, e);
    alert(`Bot error for ${tenant.id}: ${e.message}`, { key: `engine:${tenant.id}:${e.message}` });
    ctx.reply(mainMenu(ctx, 'Sorry, something went wrong on our side. Please try again in a moment.'));
  }

  // Transparency: tell people on their first message that they're talking to an automated assistant
  if (isFirstMessage && tenant.settings.ai?.disclosure !== false && replies.length) {
    const name = tenant.settings.ai?.assistantName || `${tenant.settings.business.name} assistant`;
    const note = `🤖 _I'm ${name}, an automated assistant${aiAvailable(ctx) ? ' (AI)' : ''}. Type *human* any time to talk to a person._`;
    // put it on top of the first reply (one message, not two – every message is billed by Meta)
    const first = replies.find((m) => ['text', 'buttons', 'list', 'cta', 'flow'].includes(m.type));
    if (first) first.text = `${note}\n\n${first.text}`;
    else replies.unshift({ type: 'text', text: note });
  }
  saveConversation(conv);
  for (const m of replies) {
    try {
      await send(conv.waId, m);
    } catch (e) {
      console.error(`[send] tenant=${tenant.id}`, e.message);
    }
  }
  return replies;
}

/** Which AI engine serves this shop: explicit setting, else Dify if the shop has a Dify app, else direct. */
function aiProvider(ctx) {
  const p = ctx.S.ai?.provider;
  if (p === 'direct') return 'direct';
  const difyReady = ctx.S.dify?.enabled && ctx.S.dify?.apiKey && difyAllowed(ctx.tenant);
  if (p === 'dify') return difyReady ? 'dify' : 'direct';
  return difyReady ? 'dify' : 'direct';
}

/** Is an AI engine configured for this shop (Dify app or direct provider)? */
function aiAvailable(ctx) {
  const D = ctx.S.dify || {};
  if (aiProvider(ctx) === 'direct') return !!(ctx.S.ai?.enabled !== false && directConfigured());
  return !!(D.enabled && D.apiKey);
}

/** Direct AI mode (OpenRouter / OpenAI-compatible, local knowledge search, in-process store tools). */
async function askDirect(ctx, text) {
  saveConversation(ctx.conv); // agent tools read/write the cart in the DB
  const { answer, products } = await directTurn(ctx, text);
  const fresh = getConversation(ctx.tenant.id, ctx.conv.waId);
  Object.assign(ctx.conv, { cart: fresh.cart, data: fresh.data, state: fresh.state, humanHandover: fresh.humanHandover });
  const out = toWhatsAppFormatting(answer);
  if (/\[HANDOVER\]/i.test(out)) {
    ctx.reply({ type: 'text', text: out.replace(/\[HANDOVER\]/gi, '').trim() || 'Let me get a team member for you.' });
    return handover(ctx);
  }
  if (products.length && !ctx.conv.humanHandover) ctx.reply(productList(ctx, products, out || 'Here are some products you might like:'));
  else ctx.reply({ type: 'text', text: out || "Sorry, I didn't catch that. Type *menu* to see options." });
}

/** Tell the shop owner (once a day per kind) that a plan limit was reached. */
function ownerNotice(tenant, kind, send, { monthly = false } = {}) {
  const key = `notice:${tenant.id}:${kind}:${new Date().toISOString().slice(0, monthly ? 7 : 10)}`;
  if (getDb().prepare('SELECT 1 FROM kv WHERE key = ?').get(key)) return;
  getDb().prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').run(key, '1');
  const text = kind === 'ai80' ? `ℹ️ ${tenant.settings.business.name}: 80% of this month's AI budget is used. When it runs out the bot keeps answering with keyword search. Buy a top-up or upgrade on the Billing tab.` : kind === 'ai' ? `⚠️ ${tenant.settings.business.name}: this month's AI budget is used up – the bot now answers with keyword search and product search only (customers still get replies). Buy a top-up or upgrade on the Billing tab.` : `⚠️ ${tenant.settings.business.name}: this month's message limit is reached – new chats are handed to your team instead of the bot. Upgrade on the Billing tab.`;
  for (const s of tenant.settings.notifications?.staffWaIds || []) staffAlert(tenant, String(s).replace(/\D/g, ''), text, send);
  alert(`Plan limit (${kind}) reached for ${tenant.id}`, { key: `limit:${tenant.id}:${kind}` });
}

function buildCtx(tenant, conv, customer, send, replies) {
  const ctx = {
    tenant,
    S: tenant.settings,
    store: getStore(tenant),
    conv,
    customer,
    rawSend: send,
    reply: (m) => replies.push(m),
  };
  ctx.runAction = (id) => handleAction(ctx, id);
  ctx.handover = (text) => handover(ctx, text);
  ctx.schedule = (kind, payload, minutes) => schedule(tenant.id, kind, payload, minutes);
  ctx.showProducts = async (ids, text) => {
    const products = (await Promise.all(ids.slice(0, 10).map((id) => ctx.store.getProduct(id).catch(() => null)))).filter(Boolean);
    if (!products.length) return showCategories(ctx);
    ctx.reply(productList(ctx, products, text || 'Tap a product to see details 👇'));
  };
  return ctx;
}

/** Continue a flow after a delay step (called by the scheduler). */
export async function resumeFlow(tenant, { waId, flowId, step }, send) {
  const flow = getFlow(tenant.id, flowId);
  if (!flow || !flow.active) return [];
  const conv = getConversation(tenant.id, waId);
  if (conv.humanHandover) return [];
  const customer = upsertCustomer(tenant.id, waId);
  const replies = [];
  const ctx = buildCtx(tenant, conv, customer, send, replies);
  await runFlow(ctx, flow, step);
  saveConversation(conv);
  for (const m of replies) await send(waId, m).catch((e) => console.warn('[flow resume]', e.message));
  return replies;
}

// Exported for tests / tools
export { mainMenu, formatCart };
