import express from 'express';
import { config } from '../config.js';
import { getTenant, listTenants } from '../tenants.js';
import { getStore } from '../stores/index.js';
import { findOrderByReceipt, getOrder, updateOrder, notifyStaff, STATUS_TEXT, paymentLabel } from '../bot/orders.js';
import { money } from '../bot/cart.js';
import { verifyStripeSignature } from '../payments/stripe.js';
import { createSender } from '../whatsapp/cloudApi.js';
import { getDb } from '../db.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (title, body, { description = '', image = '' } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<style>
:root{--bg:#f5f7f6;--card:#fff;--ink:#17201b;--mute:#5d6b63;--line:#dfe5e1;--brand:#128c4a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--card:#17201b;--ink:#e7efe9;--mute:#9aaba1;--line:#2a362f;--brand:#25d366}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:960px;margin:0 auto;padding:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px}.mute{color:var(--mute)}
.btn{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.p img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;background:var(--bg)}.p h3{font-size:15px;margin:8px 0 2px}
s{color:var(--mute)}table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.chips a{border:1px solid var(--line);border-radius:99px;padding:4px 10px;color:var(--ink);text-decoration:none;font-size:13px}.chips a.on{background:var(--brand);color:#fff;border-color:var(--brand)}
header{display:flex;gap:12px;align-items:center}header img{width:56px;height:56px;border-radius:50%;object-fit:cover}
</style></head><body><main>${body}</main></body></html>`;

const waLink = (number, text) => `https://wa.me/${String(number || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

// Small in-memory cache so the storefront doesn't hit Shopify/WooCommerce on every visit
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function renderStorefront(tenant, { category, q } = {}) {
  const S = tenant.settings;
  const sym = S.business.currencySymbol || '£';
  const store = getStore(tenant);
  const number = S.business.whatsappNumber;
  const [cats, products] = await Promise.all([
    cached(`${tenant.id}:cats`, 300000, () => store.listCategories().catch(() => [])),
    cached(`${tenant.id}:p:${category || ''}:${q || ''}`, 300000, () => (category ? store.productsInCategory(category, { limit: 50 }) : store.searchProducts(q || '', { limit: 50 })).catch(() => [])),
  ]);
  const grid = products.map((p) => `<div class="card p">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">` : ''}<h3>${esc(p.title)}</h3>
    <div>${p.compareAtPrice ? `<s>${money(p.compareAtPrice, sym)}</s> ` : ''}<b>${money(p.price, sym)}</b>${p.available ? '' : ' <span class="mute">· sold out</span>'}</div>
    <p class="mute" style="font-size:13px">${esc((p.description || '').slice(0, 90))}</p>
    ${number && p.available ? `<a class="btn" href="${esc(waLink(number, `Hi! I'd like to order ${p.title} [ref:${p.id}]`))}">Order on WhatsApp</a>` : ''}</div>`).join('');
  const chips = cats.length > 1 ? `<div class="chips"><a href="?" class="${!category ? 'on' : ''}">All</a>${cats.map((c) => `<a href="?category=${encodeURIComponent(c.id)}" class="${category === c.id ? 'on' : ''}">${esc(c.title)}</a>`).join('')}</div>` : '';
  return page(S.business.name, `<div class="card"><header>${S.business.logoUrl ? `<img src="${esc(S.business.logoUrl)}" alt="">` : ''}<div><h1>${esc(S.business.name)}</h1><div class="mute">${esc(S.business.tagline || 'Order in a few taps on WhatsApp')}</div></div></header>
    ${number ? `<p><a class="btn" href="${esc(waLink(number, 'Hi'))}">💬 Chat & order on WhatsApp</a></p>` : '<p class="mute">(Set the business WhatsApp number in Settings to enable ordering buttons.)</p>'}
    <form><input name="q" value="${esc(q || '')}" placeholder="Search products…" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink)"></form>${chips}</div>
    <div class="grid">${grid || '<p class="mute">No products found.</p>'}</div>`, { description: S.business.tagline || `Order from ${S.business.name} on WhatsApp`, image: products[0]?.image || S.business.logoUrl });
}

export function renderReceipt(tenant, o, { justPaid } = {}) {
  const S = tenant.settings;
  const sym = S.business.currencySymbol || '£';
  const rows = o.items.map((i) => `<tr><td>${esc(i.title)} × ${i.quantity}</td><td>${money(i.price * i.quantity, sym)}</td></tr>`).join('');
  return page(`Order ${o.store_order_name} · ${S.business.name}`, `<div class="card"><h1>${esc(S.business.name)}</h1><div class="mute">Order ${esc(o.store_order_name)} · ${esc(o.created_at)} UTC</div></div>
  ${justPaid ? '<div class="card">✅ Thank you – your payment is being confirmed. You will get a WhatsApp message shortly.</div>' : ''}
  <div class="card"><table>${rows}
    ${o.discount ? `<tr><td>Discount${o.promo_code ? ` (${esc(o.promo_code)})` : ''}</td><td>-${money(o.discount, sym)}</td></tr>` : ''}
    ${o.fulfilment === 'delivery' ? `<tr><td>Delivery</td><td>${o.delivery_fee ? money(o.delivery_fee, sym) : 'FREE'}</td></tr>` : ''}
    <tr><td><b>Total</b></td><td><b>${money(o.subtotal, sym)}</b></td></tr></table>
    <p>Status: <b>${esc(STATUS_TEXT[o.status] || o.status)}</b><br>Payment: <b>${esc(o.payment_status)}</b> (${esc(paymentLabel(o.payment_method))})<br>
    ${o.fulfilment === 'delivery' ? `Delivery to: ${esc(o.address || '')}` : `Collection${S.ordering.pickupAddress ? ` from ${esc(S.ordering.pickupAddress)}` : ''}`}${o.slot ? `<br>Time: ${esc(o.slot)}` : ''}${o.notes ? `<br>Note: ${esc(o.notes)}` : ''}</p>
    ${o.payment_status !== 'paid' && o.checkout_url && o.status !== 'cancelled' ? `<p><a class="btn" href="${esc(o.checkout_url)}">Pay ${money(o.subtotal, sym)} now</a></p>` : ''}
    ${o.payment_method === 'bank_transfer' && o.payment_status !== 'paid' ? `<p class="mute">Bank transfer details:<br>${esc(S.ordering.bankDetails).replace(/\n/g, '<br>')}<br>Reference: ${esc(o.store_order_name)}</p>` : ''}
  </div>`);
}

export function publicRouter() {
  const r = express.Router();

  r.get('/r/:token', (req, res) => {
    const o = findOrderByReceipt(req.params.token);
    const t = o && getTenant(o.tenant_id);
    if (!o || !t) return res.status(404).send(page('Not found', '<div class="card">Receipt not found.</div>'));
    res.set('Cache-Control', 'no-store').send(renderReceipt(t, o, { justPaid: req.query.paid === '1' }));
  });

  r.get('/s/:tenantId', async (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t || !t.active) return res.status(404).send(page('Not found', '<div class="card">Shop not found.</div>'));
    res.send(await renderStorefront(t, { category: req.query.category, q: req.query.q }));
  });

  // Stripe → mark order paid, tell the customer and staff
  r.post('/webhooks/stripe/:tenantId', async (req, res) => {
    const t = getTenant(req.params.tenantId);
    const secret = t?.settings.payments?.stripe?.webhookSecret;
    if (!t || !verifyStripeSignature(req.rawBody?.toString('utf8') || '', req.get('stripe-signature'), secret)) return res.sendStatus(400);
    res.json({ received: true });
    const ev = req.body;
    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type)) return;
    const session = ev.data?.object || {};
    if (session.payment_status && session.payment_status !== 'paid') return;
    const orderId = Number(session.metadata?.order_id);
    const row = getDb().prepare('SELECT id FROM orders WHERE tenant_id = ? AND (id = ? OR stripe_session_id = ?)').get(t.id, orderId || -1, session.id || '');
    const o = row && getOrder(t.id, row.id);
    if (!o || o.payment_status === 'paid') return;
    const updated = updateOrder(t.id, o.id, { payment_status: 'paid', status: o.status === 'new' ? 'confirmed' : o.status });
    const send = createSender(t);
    const sym = t.settings.business.currencySymbol || '£';
    await send(o.wa_id, { type: 'text', text: `💳 Payment received for order *${o.store_order_name}* (${money(o.subtotal, sym)}). Thank you! Your order is confirmed ✅` }).catch((e) => console.warn('[stripe notify]', e.message));
    notifyStaff(t, updated, send, { event: 'order.paid', text: `💳 Order ${o.store_order_name} PAID – ${money(o.subtotal, sym)} (+${o.wa_id})` }).catch(() => {});
  });

  return r;
}

/** Serve the storefront on a client's own domain (CNAME → this server). */
export function customDomainMiddleware() {
  return async (req, res, next) => {
    if (req.method !== 'GET' || req.path !== '/') return next();
    const host = String(req.hostname || '').toLowerCase();
    if (!host || config.publicUrl.includes(`//${host}`)) return next();
    const t = listTenants().find((x) => x.active && String(x.settings.business?.customDomain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') === host);
    if (!t) return next();
    res.send(await renderStorefront(t, { category: req.query.category, q: req.query.q }));
  };
}
