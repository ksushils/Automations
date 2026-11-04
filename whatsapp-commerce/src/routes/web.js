import express from 'express';
import { config } from '../config.js';
import { getTenant } from '../tenants.js';
import { getStore } from '../stores/index.js';
import { getConversation, saveConversation, upsertCustomer, updateCustomer } from '../bot/state.js';
import { placeOrder, receiptUrl, paymentLabel } from '../bot/orders.js';
import { quote, upcomingSlots, validatePromo } from '../bot/pricing.js';
import { subtotal, money } from '../bot/cart.js';
import { createSender } from '../whatsapp/cloudApi.js';
import { toWaId } from './storeWebhooks.js';
import { updateContact } from '../bot/flows.js';

// ---------- tiny in-memory rate limiter ----------
export function rateLimit({ windowMs = 60000, max = 30, key = (req) => req.ip } = {}) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (n > max) return res.status(429).json({ error: 'Too many requests – please wait a minute.' });
    next();
  };
}

export const whatsappReady = (t) => !!(t.settings.whatsapp?.phoneNumberId && t.settings.whatsapp?.accessToken);

/** Re-price client items from the store (never trust browser prices). */
async function priceItems(store, items) {
  const out = [];
  for (const i of (items || []).slice(0, 50)) {
    const p = await store.getProduct(String(i.productId)).catch(() => null);
    const v = p?.variants.find((x) => String(x.id) === String(i.variantId || p?.variants[0]?.id));
    const qty = Math.max(1, Math.min(99, Math.floor(Number(i.quantity) || 1)));
    if (!p || !v || !v.available) throw Object.assign(new Error(`${p?.title || 'An item'} is no longer available`), { status: 400 });
    if (v.stock !== undefined && v.stock !== null && v.stock !== '' && Number(v.stock) < qty) throw Object.assign(new Error(`Only ${v.stock} left of ${p.title}`), { status: 400 });
    out.push({ productId: p.id, variantId: v.id, title: v.title === p.title ? p.title : `${p.title} (${v.title})`, price: v.price, quantity: qty });
  }
  if (!out.length) throw Object.assign(new Error('Your cart is empty'), { status: 400 });
  return out;
}

export function webRouter() {
  const r = express.Router();
  const limiter = rateLimit({ max: 20 });

  // Live totals for the web checkout (zones, promo, delivery fee)
  r.post('/s/:tenantId/quote', limiter, async (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t?.active) return res.sendStatus(404);
    try {
      const items = await priceItems(getStore(t), req.body?.items);
      const co = { fulfilment: req.body?.fulfilment, address: req.body?.address, promoCode: req.body?.promoCode };
      const q = quote(t, items, co);
      const promo = co.promoCode ? validatePromo(t, co.promoCode, { sub: subtotal(items) }) : null;
      res.json({ ...q, items, promoError: promo && !promo.ok ? promo.reason : null, slots: upcomingSlots(t.settings.ordering.slots, { timeZone: t.settings.business.timezone }) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Web checkout – works with or without the WhatsApp API ("lite" mode)
  r.post('/s/:tenantId/order', limiter, async (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t?.active) return res.sendStatus(404);
    const S = t.settings;
    const b = req.body || {};
    try {
      const waId = toWaId(b.phone, S.notifications?.defaultCountryCode || '44');
      if (!waId) return res.status(400).json({ error: 'Please enter a valid mobile number' });
      if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Please enter your name' });
      const fulfilment = (S.ordering.fulfilment || ['delivery']).includes(b.fulfilment) ? b.fulfilment : (S.ordering.fulfilment || ['delivery'])[0];
      if (fulfilment === 'delivery' && String(b.address || '').trim().length < 8) return res.status(400).json({ error: 'Please enter your full delivery address' });
      const store = getStore(t);
      const methods = (S.ordering.paymentMethods || ['cod']).filter((m) => m !== 'payment_link' || store.type !== 'manual' || S.payments?.stripe?.secretKey || S.ordering.paymentLinkUrl);
      const paymentMethod = methods.includes(b.paymentMethod) ? b.paymentMethod : methods[0];
      const items = await priceItems(store, b.items);
      const slots = upcomingSlots(S.ordering.slots, { timeZone: S.business.timezone });
      const slot = slots.find((x) => x.id === b.slot) || null;
      if (S.ordering.slots?.enabled && slots.length && !slot) return res.status(400).json({ error: 'Please choose a time slot' });

      const customer = upsertCustomer(t.id, waId, String(b.name).slice(0, 120));
      updateCustomer(t.id, waId, { name: String(b.name).slice(0, 120), ...(b.email ? { email: String(b.email).slice(0, 200) } : {}), ...(fulfilment === 'delivery' ? { address: String(b.address).slice(0, 500) } : {}), ...(b.optIn ? { opted_in_marketing: 1 } : {}) });
      updateContact(t.id, waId, { addTags: ['web-order'] });
      customer.name = String(b.name).slice(0, 120);
      customer.email = b.email || customer.email;
      const conv = getConversation(t.id, waId);
      const savedCart = conv.cart;
      conv.cart = items;
      conv.data.checkout = { promoCode: b.promoCode || null, slot, note: b.note ? String(b.note).slice(0, 300) : null };
      const send = whatsappReady(t) ? createSender(t) : async () => {};
      const { order } = await placeOrder({ tenant: t, store, conv, customer, fulfilment, paymentMethod, address: fulfilment === 'delivery' ? String(b.address) : '', send });
      conv.cart = savedCart.filter((i) => !items.some((x) => x.productId === i.productId && x.variantId === i.variantId));
      saveConversation(conv);

      // WhatsApp confirmation (template – the customer hasn't messaged us yet, so no free-form text)
      const tpl = S.notifications?.storeTemplates?.orderConfirmation;
      if (whatsappReady(t) && tpl?.enabled && tpl.template) {
        createSender(t)(waId, { type: 'template', name: tpl.template, language: tpl.language || 'en_GB', components: [{ type: 'body', parameters: [customer.name.split(' ')[0], order.store_order_name, S.business.name, money(order.subtotal, S.business.currencySymbol)].map((text) => ({ type: 'text', text })) }] }).catch((e) => console.warn('[web order tpl]', e.message));
      }
      const sym = S.business.currencySymbol || '£';
      const summary = `Hi! I've just placed order ${order.store_order_name} 🛒\n${order.items.map((i) => `• ${i.title} × ${i.quantity}`).join('\n')}\nTotal: ${money(order.subtotal, sym)} (${paymentLabel(paymentMethod)})\n${fulfilment === 'delivery' ? `Deliver to: ${order.address}` : 'Collection'}${order.slot ? `\nTime: ${order.slot}` : ''}\n[order:${order.receipt_token}]`;
      res.json({
        ok: true,
        order: order.store_order_name,
        total: order.subtotal,
        receiptUrl: receiptUrl(order),
        payUrl: paymentMethod === 'payment_link' ? order.checkout_url : null,
        whatsappUrl: S.business.whatsappNumber ? `https://wa.me/${String(S.business.whatsappNumber).replace(/\D/g, '')}?text=${encodeURIComponent(summary)}` : null,
      });
    } catch (e) {
      console.warn('[web order]', e.message);
      res.status(e.status || (e.userMessage ? 400 : 500)).json({ error: e.userMessage || e.message });
    }
  });

  // Embeddable floating WhatsApp chat button for any website:
  //   <script src="https://YOUR_SERVER/widget/<tenantId>.js" async></script>
  r.get('/widget/:tenantId.js', (req, res) => {
    const t = getTenant(req.params.tenantId);
    res.type('application/javascript').set('Cache-Control', 'public, max-age=300');
    if (!t?.active || !t.settings.business.whatsappNumber) return res.send('/* WhatsApp widget: set the public WhatsApp number in Settings */');
    const W = t.settings.widget || {};
    const cfg = {
      number: String(t.settings.business.whatsappNumber).replace(/\D/g, ''),
      color: /^#[0-9a-f]{3,8}$/i.test(W.color || '') ? W.color : '#25d366',
      position: W.position === 'left' ? 'left' : 'right',
      greeting: W.greeting || `Hi 👋 Need help or want to order? Chat with ${t.settings.business.name} on WhatsApp.`,
      prefill: W.prefill || 'Hi!',
      label: W.label || 'Chat with us',
      shop: t.settings.business.name,
    };
    res.send(`(function(){if(window.__waWidget)return;window.__waWidget=1;var c=${JSON.stringify(cfg)};
var d=document,s=d.createElement('style');s.textContent='.waw{position:fixed;bottom:20px;'+c.position+':20px;z-index:2147483000;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.waw-b{width:58px;height:58px;border-radius:50%;background:'+c.color+';box-shadow:0 4px 14px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;cursor:pointer;border:0}.waw-b svg{width:32px;height:32px;fill:#fff}.waw-p{position:absolute;bottom:72px;'+c.position+':0;width:280px;background:#fff;color:#111;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.2);padding:14px;font-size:14px;line-height:1.4;display:none}.waw-p.on{display:block}.waw-p b{display:block;margin-bottom:6px}.waw-p a{display:block;margin-top:10px;text-align:center;background:'+c.color+';color:#fff;text-decoration:none;padding:9px;border-radius:9px;font-weight:600}.waw-x{position:absolute;top:6px;right:10px;cursor:pointer;color:#888;background:none;border:0;font-size:16px}';
d.head.appendChild(s);var w=d.createElement('div');w.className='waw';
var url='https://wa.me/'+c.number+'?text='+encodeURIComponent(c.prefill);
w.innerHTML='<div class="waw-p" role="dialog"><button class="waw-x" aria-label="Close">×</button><b></b><span></span><a target="_blank" rel="noopener"></a></div><button class="waw-b" aria-label="'+c.label+'"><svg viewBox="0 0 32 32"><path d="M16 3C9 3 3.3 8.6 3.3 15.6c0 2.4.7 4.7 1.9 6.7L3 29l6.9-2.1c1.9 1 4 1.6 6.1 1.6 7 0 12.7-5.6 12.7-12.6S23 3 16 3zm0 23.1c-1.9 0-3.8-.5-5.4-1.5l-.4-.2-4.1 1.2 1.2-4-.3-.4c-1.1-1.7-1.7-3.6-1.7-5.6C5.3 9.8 10.1 5 16 5s10.7 4.8 10.7 10.6S21.9 26.1 16 26.1zm5.9-7.9c-.3-.2-1.9-.9-2.2-1-.3-.1-.5-.2-.7.2-.2.3-.8 1-1 1.2-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.6-1.6-1-.9-1.6-1.9-1.8-2.2-.2-.3 0-.5.1-.7l.5-.6c.2-.2.2-.4.3-.6.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.7s1.2 3.1 1.4 3.4c.2.2 2.4 3.6 5.7 5 .8.3 1.4.5 1.9.7.8.3 1.6.2 2.2.1.7-.1 1.9-.8 2.2-1.5.3-.7.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4z"/></svg></button>';
w.querySelector('b').textContent=c.shop;w.querySelector('span').textContent=c.greeting;var a=w.querySelector('a');a.href=url;a.textContent=c.label;
var p=w.querySelector('.waw-p');w.querySelector('.waw-b').onclick=function(){p.classList.toggle('on')};w.querySelector('.waw-x').onclick=function(){p.classList.remove('on')};
(d.body||d.documentElement).appendChild(w);})();`);
  });

  return r;
}

export { config };
