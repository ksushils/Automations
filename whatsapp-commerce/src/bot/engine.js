import { getStore } from '../stores/index.js';
import { difyChat } from '../dify/client.js';
import { createSessionToken } from '../session.js';
import { withinLimit, bumpUsage } from '../tenants.js';
import { getConversation, saveConversation, upsertCustomer, updateCustomer } from './state.js';
import { addToCart, removeFromCart, subtotal, money, formatCart, deliveryFee } from './cart.js';
import { placeOrder, listOrders, paymentLabel, STATUS_TEXT } from './orders.js';

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

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[!?.]+$/g, '');

function availablePaymentMethods(tenant, store) {
  const S = tenant.settings.ordering;
  return (S.paymentMethods || ['cod']).filter((m) => m !== 'payment_link' || store.type !== 'manual' || S.paymentLinkUrl);
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
          description: `${money(p.price, sym)}${p.available ? '' : ' · out of stock'}${p.description ? ' · ' + p.description : ''}`,
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
  const caption = `*${p.title}*\n${money(p.price, sym)}${p.available ? '' : ' — currently out of stock'}\n\n${p.description || ''}`.trim();
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
  ctx.conv.data.pending = { productId: p.id, variantId: v.id, title: v.title === p.title ? p.title : `${p.title} (${v.title})`, price: v.price };
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
  addToCart(ctx.conv.cart, { ...pending, quantity: qty });
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
  if (!co.paymentMethod) {
    const opts = availablePaymentMethods(ctx.tenant, ctx.store);
    if (opts.length === 1) co.paymentMethod = opts[0];
    else {
      ctx.conv.state = 'checkout_payment';
      return ctx.reply({ type: 'buttons', text: 'How would you like to pay?', buttons: opts.slice(0, 3).map((m) => ({ id: `pay:${m}`, title: m === 'cod' && co.fulfilment === 'pickup' ? '💵 Pay on collection' : PAY_BUTTONS[m] })) });
    }
  }
  const sub = subtotal(ctx.conv.cart);
  const fee = deliveryFee(O, co.fulfilment, sub);
  ctx.conv.state = 'checkout_confirm';
  ctx.reply({
    type: 'buttons',
    header: 'Order summary',
    text: `${formatCart(ctx.conv.cart, sym)}${co.fulfilment === 'delivery' ? `\nDelivery: ${fee ? money(fee, sym) : 'FREE'}` : ''}\n*Total: ${money(sub + fee, sym)}*\n\n${co.fulfilment === 'delivery' ? `🚚 Deliver to: ${co.address}` : `🏬 Collection${O.pickupAddress ? ` from ${O.pickupAddress}` : ''}`}\n💳 Payment: ${paymentLabel(co.paymentMethod)}`,
    buttons: [{ id: 'confirm', title: '✅ Place order' }, { id: 'cart', title: '✏️ Edit cart' }, { id: 'cancel', title: '❌ Cancel' }],
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
  if (products.length) ctx.reply(productList(ctx, products, answer || 'Here are some products you might like:'));
  else ctx.reply({ type: 'text', text: answer || "Sorry, I didn't catch that. Type *menu* to see options." });
}

function handover(ctx) {
  ctx.conv.humanHandover = true;
  ctx.conv.state = 'idle';
  ctx.reply({ type: 'text', text: `🙋 A member of our team will reply here shortly${ctx.S.business.supportHours ? ` (${ctx.S.business.supportHours})` : ''}. Your cart is saved.` });
  const staff = ctx.S.notifications?.staffWaIds || [];
  for (const s of staff) ctx.rawSend(String(s).replace(/\D/g, ''), { type: 'text', text: `🙋 Customer +${ctx.conv.waId} (${ctx.customer.name || 'unknown'}) asked to talk to a person. Reply from the dashboard.` }).catch(() => {});
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
    case 'confirm': return confirmOrder(ctx);
    case 'cancel': ctx.conv.state = 'idle'; delete ctx.conv.data.checkout; return ctx.reply(mainMenu(ctx, 'Checkout cancelled — your cart is still saved.'));
    case 'status': return orderStatus(ctx);
    case 'human': return handover(ctx);
    case 'subscribe': updateCustomer(ctx.tenant.id, ctx.conv.waId, { opted_in_marketing: 1 }); return ctx.reply({ type: 'text', text: "🔔 You're subscribed to offers. Reply STOP any time to opt out." });
    case 'unsubscribe': updateCustomer(ctx.tenant.id, ctx.conv.waId, { opted_in_marketing: 0 }); return ctx.reply({ type: 'text', text: "🔕 You won't receive promotional messages. You can still order any time." });
    default: return ctx.reply(mainMenu(ctx));
  }
}

async function handleText(ctx, raw) {
  const text = String(raw || '').trim();
  const t = norm(text);
  if (!t) return ctx.reply(mainMenu(ctx));

  // State-driven input first
  if (ctx.conv.state === 'awaiting_address' && !GREETING.test(t) && !COMMANDS.has(t) && !/^(order status|track|remove \d+)/.test(t)) return setAddress(ctx, text);
  if (ctx.conv.state === 'awaiting_qty' && /^\d{1,2}$/.test(t)) return addPending(ctx, Number(t));

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

  // Free text → AI (if configured) or catalogue search
  const D = ctx.S.dify || {};
  if (D.enabled && D.apiKey && withinLimit(ctx.tenant, 'ai')) {
    try {
      return await askAi(ctx, text);
    } catch (e) {
      console.error(`[dify] tenant=${ctx.tenant.id}`, e.message);
    }
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
  const ctx = {
    tenant,
    S: tenant.settings,
    store: getStore(tenant),
    conv,
    customer,
    rawSend: send,
    reply: (m) => replies.push(m),
  };

  if (conv.humanHandover) {
    // A human is handling this chat – the bot stays quiet. "menu" lets the customer return to the bot.
    if (event.kind === 'text' && ['menu', 'bot'].includes(norm(event.text))) conv.humanHandover = false;
    else return replies;
  }
  if (!withinLimit(tenant, 'inbound')) return replies;

  try {
    if (event.kind === 'action') await handleAction(ctx, event.id);
    else if (event.kind === 'text') await handleText(ctx, event.text);
    else if (event.kind === 'location') {
      if (conv.state === 'awaiting_address') await setAddress(ctx, `${customer.name || ''}\n${event.text}\nhttps://maps.google.com/?q=${event.location.latitude},${event.location.longitude}`.trim());
      else ctx.reply(mainMenu(ctx, 'Thanks for sharing your location! 📍'));
    } else if (event.kind === 'unsupported' && ['image', 'document'].includes(event.type)) {
      ctx.reply({ type: 'text', text: 'Thanks! 🙏 A member of our team will check this shortly.' });
      for (const s of tenant.settings.notifications?.staffWaIds || []) send(String(s).replace(/\D/g, ''), { type: 'text', text: `📎 Customer +${conv.waId} sent a ${event.type} (possibly payment proof). Check the dashboard.` }).catch(() => {});
    } else {
      ctx.reply(mainMenu(ctx, "I can't read that type of message yet — please type or tap an option."));
    }
  } catch (e) {
    console.error(`[engine] tenant=${tenant.id}`, e);
    ctx.reply(mainMenu(ctx, 'Sorry, something went wrong on our side. Please try again in a moment.'));
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

// Exported for tests / tools
export { mainMenu, formatCart };
