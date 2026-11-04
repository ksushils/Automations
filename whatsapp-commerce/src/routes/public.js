import express from 'express';
import { config } from '../config.js';
import { getTenant, listTenants } from '../tenants.js';
import { getStore } from '../stores/index.js';
import { findOrderByReceipt, getOrder, updateOrder, notifyStaff, STATUS_TEXT, paymentLabel } from '../bot/orders.js';
import { money } from '../bot/cart.js';
import { verifyStripeSignature } from '../payments/stripe.js';
import { handlePlatformStripeEvent } from '../platform.js';
import { renderLegal } from '../legal.js';
import { createSender, notify } from '../whatsapp/cloudApi.js';
import { getDb } from '../db.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (title, body, { description = '', image = '', brand = '' } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<style>
:root{--bg:#f5f7f6;--card:#fff;--ink:#17201b;--mute:#5d6b63;--line:#dfe5e1;--brand:#128c4a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--card:#17201b;--ink:#e7efe9;--mute:#9aaba1;--line:#2a362f;--brand:#1fa055}}
${/^#[0-9a-f]{3,8}$/i.test(brand) ? `:root{--brand:${brand}}` : ''}
.btn.ghost{background:none;color:var(--brand);border:1px solid var(--line)}button.btn{border:0;cursor:pointer;font:inherit}
.var{width:100%;margin:0 0 8px;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
#cartbar[hidden],#co[hidden],#done[hidden]{display:none!important}#cartbar{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:5;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:calc(100% - 32px)}
#co label{display:block;font-size:13px;color:var(--mute);margin:10px 0 0}#co input,#co textarea,#co select{display:block;width:100%;padding:9px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;margin-top:3px}
#co .chk input,#co .seg input{display:inline;width:auto}.seg{display:flex;gap:16px;margin-top:10px}.seg label{margin:0;color:var(--ink)}
.line{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)}.line button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;width:26px;cursor:pointer}
.tot{margin:12px 0;line-height:1.7}.err{color:#c0392b}
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

export const storefrontMode = (t) => {
  const m = t.settings.storefront?.mode;
  if (m === 'chat' || m === 'cart') return m;
  return t.settings.whatsapp?.phoneNumberId && t.settings.whatsapp?.accessToken ? 'chat' : 'cart';
};

export async function renderStorefront(tenant, { category, q } = {}) {
  const S = tenant.settings;
  const sym = S.business.currencySymbol || '£';
  const store = getStore(tenant);
  const number = S.business.whatsappNumber;
  const mode = storefrontMode(tenant);
  const [cats, products] = await Promise.all([
    cached(`${tenant.id}:cats`, 300000, () => store.listCategories().catch(() => [])),
    cached(`${tenant.id}:p:${category || ''}:${q || ''}`, 300000, () => (category ? store.productsInCategory(category, { limit: 50 }) : store.searchProducts(q || '', { limit: 50 })).catch(() => [])),
  ]);
  const grid = products.map((p) => {
    const vars = p.variants.filter((v) => v.available);
    const action = !p.available ? '<span class="mute">Sold out</span>'
      : mode === 'cart'
        ? `${vars.length > 1 ? `<select class="var" aria-label="Option">${vars.map((v) => `<option value="${esc(v.id)}" data-price="${v.price}">${esc(v.title)} – ${money(v.price, sym)}</option>`).join('')}</select>` : ''}<button class="btn add" data-id="${esc(p.id)}" data-vid="${esc(vars[0]?.id)}" data-title="${esc(p.title)}" data-price="${vars[0]?.price ?? p.price}">Add to basket</button>`
        : number ? `<a class="btn" href="${esc(waLink(number, `Hi! I'd like to order ${p.title} [ref:${p.id}]`))}">Order on WhatsApp</a>` : '';
    return `<div class="card p">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">` : ''}<h3>${esc(p.title)}</h3>
    <div>${p.compareAtPrice ? `<s>${money(p.compareAtPrice, sym)}</s> ` : ''}<b>${money(p.price, sym)}</b></div>
    <p class="mute" style="font-size:13px">${esc((p.description || '').slice(0, 90))}</p>${action}</div>`;
  }).join('');
  const chips = cats.length > 1 ? `<div class="chips"><a href="?" class="${!category ? 'on' : ''}">All</a>${cats.map((c) => `<a href="?category=${encodeURIComponent(c.id)}" class="${category === c.id ? 'on' : ''}">${esc(c.title)}</a>`).join('')}</div>` : '';
  const O = S.ordering || {};
  const cfg = { tenant: tenant.id, sym, fulfilment: O.fulfilment || ['delivery'], payments: (O.paymentMethods || ['cod']).filter((m) => m !== 'payment_link' || store.type !== 'manual' || S.payments?.stripe?.secretKey || O.paymentLinkUrl), slots: !!O.slots?.enabled, promos: (O.promoCodes || []).length > 0, pickupAddress: O.pickupAddress || '' };
  const cartUi = mode !== 'cart' ? '' : `
  <button id="cartbar" class="btn" hidden>🛒 <span id="cartn">0</span> · <span id="cartt"></span> — Checkout</button>
  <div id="co" class="card" hidden>
    <h2>Your basket</h2><div id="lines"></div>
    <form id="cof">
      <label>Name<input name="name" required autocomplete="name"></label>
      <label>WhatsApp / mobile number<input name="phone" required inputmode="tel" autocomplete="tel" placeholder="07700 900123"></label>
      ${cfg.fulfilment.length > 1 ? `<div class="seg">${cfg.fulfilment.map((f, i) => `<label><input type="radio" name="fulfilment" value="${f}" ${i ? '' : 'checked'}> ${f === 'pickup' ? '🏬 Collection' : '🚚 Delivery'}</label>`).join('')}</div>` : `<input type="hidden" name="fulfilment" value="${cfg.fulfilment[0]}">`}
      <label id="addrw">Delivery address (incl. postcode)<textarea name="address" autocomplete="street-address"></textarea></label>
      ${cfg.slots ? '<label>Time<select name="slot" id="slot"></select></label>' : ''}
      ${cfg.promos ? '<label>Promo code<input name="promoCode" autocapitalize="characters"></label>' : ''}
      <label>Note (optional)<input name="note" placeholder="Gift message, instructions…"></label>
      <label>Payment<select name="paymentMethod">${cfg.payments.map((m) => `<option value="${m}">${{ payment_link: '💳 Pay online by card', cod: '💵 Cash on delivery / collection', bank_transfer: '🏦 Bank transfer' }[m] || m}</option>`).join('')}</select></label>
      <label class="chk"><input type="checkbox" name="optIn"> Send me offers on WhatsApp</label>
      <div id="tot" class="tot"></div><p id="err" class="err"></p>
      <button class="btn" type="submit" style="width:100%">Place order</button>
    </form>
  </div>
  <div id="done" class="card" hidden></div>
  <script>
  (function(){
    var C=${JSON.stringify(cfg).replace(/</g, '\\u003c')}, K='wa-cart-'+C.tenant, cart=[];
    try{cart=JSON.parse(localStorage.getItem(K)||'[]')}catch(e){}
    try{var hc=new URLSearchParams(location.search).get('cart');if(hc){var items=JSON.parse(atob(hc.replace(/-/g,'+').replace(/_/g,'/')));if(Array.isArray(items)&&items.length){cart=items.slice(0,50).map(function(i){return{productId:String(i.productId),variantId:String(i.variantId),title:String(i.title||''),price:Number(i.price)||0,quantity:Math.max(1,Math.min(99,Number(i.quantity)||1))}});try{localStorage.setItem(K,JSON.stringify(cart))}catch(e){}history.replaceState(null,'',location.pathname);setTimeout(function(){document.getElementById('cartbar').click()},300)}}}catch(e){}
    var $=function(s){return document.querySelector(s)}, m=function(n){return C.sym+Number(n).toFixed(2)};
    function save(){try{localStorage.setItem(K,JSON.stringify(cart))}catch(e){} draw()}
    function draw(){
      var n=cart.reduce(function(a,i){return a+i.quantity},0), t=cart.reduce(function(a,i){return a+i.price*i.quantity},0);
      $('#cartbar').hidden=!n; $('#cartn').textContent=n; $('#cartt').textContent=m(t);
      $('#lines').innerHTML=cart.map(function(i,k){return '<div class="line"><span>'+esc(i.title)+'</span><span><button type="button" data-k="'+k+'" data-d="-1">−</button> '+i.quantity+' <button type="button" data-k="'+k+'" data-d="1">+</button> '+m(i.price*i.quantity)+'</span></div>'}).join('')||'<p class="mute">Empty</p>';
    }
    function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}
    document.querySelectorAll('.add').forEach(function(b){b.onclick=function(){
      var sel=b.parentNode.querySelector('.var'), vid=sel?sel.value:b.dataset.vid, opt=sel?sel.selectedOptions[0]:null;
      var title=b.dataset.title+(sel&&sel.options.length>1?' ('+opt.textContent.split(' – ')[0]+')':''), price=Number(opt?opt.dataset.price:b.dataset.price);
      var ex=cart.find(function(i){return i.productId===b.dataset.id&&i.variantId===vid});
      if(ex)ex.quantity++;else cart.push({productId:b.dataset.id,variantId:vid,title:title,price:price,quantity:1});
      save(); b.textContent='✓ Added'; setTimeout(function(){b.textContent='Add to basket'},1200);
    }});
    $('#lines').onclick=function(e){var k=e.target.dataset.k;if(k===undefined)return;cart[k].quantity+=Number(e.target.dataset.d);if(cart[k].quantity<1)cart.splice(k,1);save();requote()};
    $('#cartbar').onclick=function(){$('#co').hidden=false;$('#co').scrollIntoView({behavior:'smooth'});requote()};
    var f=$('#cof'), qt;
    function body(){var d=Object.fromEntries(new FormData(f));d.optIn=!!f.optIn&&f.optIn.checked;d.items=cart.map(function(i){return{productId:i.productId,variantId:i.variantId,quantity:i.quantity}});return d}
    function fx(){var fl=(f.querySelector('[name=fulfilment]:checked')||f.fulfilment).value;$('#addrw').hidden=fl!=='delivery'}
    function requote(){clearTimeout(qt);qt=setTimeout(function(){fx();if(!cart.length)return;
      fetch('/s/'+C.tenant+'/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body())}).then(function(r){return r.json()}).then(function(q){
        if(q.error){$('#tot').textContent=q.error;return}
        $('#tot').innerHTML='Subtotal '+m(q.subtotal)+(q.discount?'<br>Discount −'+m(q.discount):'')+(q.deliveryFee||q.zone?'<br>Delivery '+(q.deliveryFee?m(q.deliveryFee):'FREE'):'')+'<br><b>Total '+m(q.total)+'</b>'+(q.error==='no_zone'?'<br>⚠️ We don\\'t deliver to that postcode yet':'')+(q.promoError?'<br>⚠️ '+esc(q.promoError):'');
        var s=$('#slot');if(s&&!s.options.length)s.innerHTML=(q.slots||[]).map(function(x){return '<option value="'+x.id+'">'+x.label+'</option>'}).join('');
      })},300)}
    f.addEventListener('input',requote);f.addEventListener('change',requote);
    f.onsubmit=function(e){e.preventDefault();$('#err').textContent='';var btn=f.querySelector('[type=submit]');btn.disabled=true;
      fetch('/s/'+C.tenant+'/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body())}).then(function(r){return r.json()}).then(function(r){
        btn.disabled=false;if(!r.ok){$('#err').textContent=r.error||'Something went wrong';return}
        cart=[];save();$('#co').hidden=true;var d=$('#done');d.hidden=false;
        d.innerHTML='<h2>✅ Order '+esc(r.order)+' placed!</h2><p>Total '+m(r.total)+'</p>'+(r.payUrl?'<p><a class="btn" href="'+r.payUrl+'">💳 Pay now</a></p>':'')+(r.whatsappUrl?'<p><a class="btn" href="'+r.whatsappUrl+'">💬 Send order on WhatsApp</a></p><p class="mute">Tap to confirm with us on WhatsApp and get updates there.</p>':'')+'<p><a href="'+r.receiptUrl+'">View receipt</a></p>';
        d.scrollIntoView({behavior:'smooth'});
      }).catch(function(){btn.disabled=false;$('#err').textContent='Network error – please try again'})};
    draw();fx();
  })();
  </script>`;
  return page(S.business.name, `<div class="card"><header>${S.business.logoUrl ? `<img src="${esc(S.business.logoUrl)}" alt="">` : ''}<div><h1>${esc(S.business.name)}</h1><div class="mute">${esc(S.business.tagline || (mode === 'cart' ? 'Order online in a few taps' : 'Order in a few taps on WhatsApp'))}</div></div></header>
    ${number ? `<p><a class="btn ${mode === 'cart' ? 'ghost' : ''}" href="${esc(waLink(number, 'Hi'))}">💬 Chat with us on WhatsApp</a></p>` : mode === 'chat' ? '<p class="mute">(Set the business WhatsApp number in Settings to enable ordering buttons.)</p>' : ''}
    <form><input name="q" value="${esc(q || '')}" placeholder="Search products…" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink)"></form>${chips}</div>
    <div class="grid">${grid || '<p class="mute">No products found.</p>'}</div>${cartUi}${S.webchat?.enabled !== false ? `<script src="/chat-widget/${esc(tenant.id)}.js" async></script>` : ''}`, { description: S.business.tagline || `Order from ${S.business.name}`, image: products[0]?.image || S.business.logoUrl, brand: S.storefront?.brandColor });
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

  r.get('/legal/:page', (req, res) => {
    const html = renderLegal(req.params.page);
    html ? res.send(html) : res.sendStatus(404);
  });

  // Your own SaaS billing (Stripe Billing subscriptions)
  r.post('/webhooks/platform-stripe', (req, res) => {
    try {
      const out = handlePlatformStripeEvent(req.rawBody?.toString('utf8') || '', req.get('stripe-signature'));
      res.status(out.status).json({ received: out.ok });
    } catch (e) {
      console.error('[platform stripe]', e.message);
      res.status(500).json({ error: 'failed' });
    }
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
    const tpl = t.settings.notifications?.templates?.orderUpdate;
    await notify(t, o.wa_id, { type: 'text', text: `💳 Payment received for order *${o.store_order_name}* (${money(o.subtotal, sym)}). Thank you! Your order is confirmed ✅` }, tpl ? { name: tpl, params: [(o.customer_name || 'there').split(' ')[0], o.store_order_name, 'paid and confirmed'] } : null, send).catch((e) => console.warn('[stripe notify]', e.message));
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
