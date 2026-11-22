import { getDb } from './db.js';
import { getTenant, listTenants } from './tenants.js';
import { createSender, notify } from './whatsapp/cloudApi.js';
import { sendEmail, emailShop } from './email.js';
import { getStore } from './stores/index.js';
import { getOrder, updateOrder } from './bot/orders.js';

/*
 * Smaller "smart assistant" features from the research:
 *  1. Back-in-stock alerts – "🔔 Tell me when it's back" on an out-of-stock product; checked hourly; WhatsApp
 *     customers get a message (approved template outside the 24h window), website visitors an email.
 *  2. Order changes in the chat – cancel, or change the delivery address, while an in-chat order hasn't been
 *     prepared yet. Always a confirm step; the team is told at once (refunds stay with the team).
 *  3. Frustration – a customer who sounds fed up is offered a person straight away, not another bot answer.
 */
const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(String(s || '').trim());
const web = (ctx) => String(ctx.conv.waId).startsWith('web:');

// ---------- 1. back in stock ----------
export async function stockAlertAction(ctx, arg) {
  const [productId, variantId = ''] = String(arg || '').split('|');
  const p = await ctx.store.getProduct(productId).catch(() => null);
  if (!p) return ctx.reply({ type: 'text', text: "Sorry, I can't find that product any more." });
  if (p.available) return ctx.reply({ type: 'buttons', text: `Good news – *${p.title}* is in stock now!`, buttons: [{ id: `p:${p.id}`, title: '🛍️ See it' }] });
  if (web(ctx) && !ctx.customer?.email) {
    ctx.conv.state = 'stock_email';
    ctx.conv.data.stockAlert = { productId: p.id, variantId, title: p.title };
    return ctx.reply({ type: 'buttons', text: `🔔 I'll email you when *${p.title}* is back. What's your email address?\n_We'll only use it for this alert._`, buttons: [{ id: 'menu', title: 'Not now' }] });
  }
  saveAlert(ctx, { productId: p.id, variantId, title: p.title, email: web(ctx) ? ctx.customer.email : null });
  return ctx.reply({ type: 'text', text: `🔔 Done! I'll ${web(ctx) ? `email you at ${ctx.customer.email}` : 'message you here'} as soon as *${p.title}* is back in stock.` });
}

export function stockEmailText(ctx, text) {
  if (ctx.conv.state !== 'stock_email' || !ctx.conv.data.stockAlert) return false;
  const v = String(text || '').trim();
  if (!isEmail(v)) {
    if (/\?\s*$/.test(v) || v.split(/\s+/).length >= 5) { ctx.conv.state = 'idle'; return false; } // a question instead
    return ctx.reply({ type: 'buttons', text: "That doesn't look like an email address – could you check it?", buttons: [{ id: 'menu', title: 'Not now' }] });
  }
  const a = ctx.conv.data.stockAlert;
  ctx.conv.state = 'idle';
  delete ctx.conv.data.stockAlert;
  getDb().prepare('UPDATE customers SET email = COALESCE(email, ?) WHERE tenant_id = ? AND wa_id = ?').run(v.toLowerCase(), ctx.tenant.id, ctx.conv.waId);
  saveAlert(ctx, { ...a, email: v.toLowerCase() });
  return ctx.reply({ type: 'text', text: `🔔 Done! I'll email ${v.toLowerCase()} as soon as *${a.title}* is back in stock.` });
}

function saveAlert(ctx, a) {
  const exists = getDb().prepare('SELECT 1 FROM stock_alerts WHERE tenant_id = ? AND wa_id = ? AND product_id = ? AND notified_at IS NULL').get(ctx.tenant.id, ctx.conv.waId, String(a.productId));
  if (!exists) getDb().prepare('INSERT INTO stock_alerts (tenant_id, wa_id, product_id, variant_id, title, email) VALUES (?, ?, ?, ?, ?, ?)').run(ctx.tenant.id, ctx.conv.waId, String(a.productId), a.variantId || null, String(a.title).slice(0, 200), a.email || null);
}

/** Hourly: tell people whose product is back. Alerts older than 90 days lapse. */
export async function runStockAlerts() {
  const d = getDb();
  d.prepare("DELETE FROM stock_alerts WHERE notified_at IS NULL AND created_at < datetime('now', '-90 days')").run();
  let sent = 0;
  const rows = d.prepare('SELECT * FROM stock_alerts WHERE notified_at IS NULL ORDER BY tenant_id, product_id LIMIT 500').all();
  const byTenant = new Map();
  for (const r of rows) (byTenant.get(r.tenant_id) || byTenant.set(r.tenant_id, []).get(r.tenant_id)).push(r);
  for (const [tenantId, list] of byTenant) {
    const t = getTenant(tenantId);
    if (!t?.active) continue;
    const store = getStore(t);
    const send = createSender(t);
    const checked = new Map();
    for (const a of list) {
      if (!checked.has(a.product_id)) checked.set(a.product_id, await store.getProduct(a.product_id).catch(() => null));
      const p = checked.get(a.product_id);
      const v = p && a.variant_id ? (p.variants || []).find((x) => String(x.id) === String(a.variant_id)) : null;
      if (!p || !(a.variant_id ? v?.available : p.available)) continue;
      d.prepare("UPDATE stock_alerts SET notified_at = datetime('now') WHERE id = ?").run(a.id);
      const name = t.settings.business?.name || t.name;
      const text = `🎉 Good news – *${a.title}* is back in stock at ${name}!${p.url ? `\n${p.url}` : ''}`;
      if (a.email) {
        await sendEmail({ tenantId: t.id, topic: 'stock_alert', to: a.email, subject: `${a.title} is back in stock`, text: `${text.replace(/\*/g, '')}\n\nYou asked us to tell you when it was back. This was a one-off alert.\n\n${name}` }).then((r) => r.ok && sent++, () => {});
      } else if (!String(a.wa_id).startsWith('web:')) {
        const tpl = t.settings.notifications?.templates?.backInStock;
        const r = await notify(t, a.wa_id, { type: 'buttons', text, buttons: [{ id: `p:${p.id}`, title: '🛍️ See it' }] }, tpl ? { name: tpl, params: [a.title] } : null, send).catch((e) => { console.warn('[back in stock]', e.message); return 'failed'; });
        const { logOutreach } = await import('./outreach.js');
        logOutreach(t.id, a.wa_id, 'stock_alert', { ref: `stock:${a.id}`, status: r === 'sent' || r === 'template' ? 'sent' : r === 'failed' ? 'failed' : 'skipped', detail: r === 'sent' || r === 'template' ? null : String(r) });
        if (r === 'sent' || r === 'template') sent++;
      }
    }
  }
  return sent;
}

// ---------- 2. order changes ----------
export const CHANGEABLE = new Set(['new', 'confirmed']);
/** Buttons under an in-chat order the customer can still change. */
export function orderChangeButtons(o) {
  if (!o || !CHANGEABLE.has(o.status) || o.store_order_id) return [];
  return [{ id: `ocxl:${o.id}`, title: '❌ Cancel order' }, ...(o.fulfilment === 'delivery' ? [{ id: `oaddr:${o.id}`, title: '📍 Change address' }] : [])];
}

function ownOrder(ctx, id) {
  const o = getOrder(ctx.tenant.id, Number(id));
  return o && o.wa_id === ctx.conv.waId ? o : null;
}
function tellTeam(t, subject, text, rawSend) {
  emailShop(t, subject, text, { button: 'Open Orders' }).catch(() => {});
  for (const s of t.settings.notifications?.staffWaIds || []) notify(t, String(s).replace(/\D/g, ''), { type: 'text', text: `🔔 ${subject}\n${text}` }, t.settings.notifications?.templates?.staffAlert ? { name: t.settings.notifications.templates.staffAlert, params: [`${subject}: ${text}`.replace(/\n/g, ' · ').slice(0, 900)] } : null, rawSend).catch(() => {});
}

export async function orderAction(ctx, cmd, arg) {
  const o = ownOrder(ctx, arg);
  const name = o?.store_order_name || (o ? `#${o.id}` : '');
  if (!o) return ctx.reply({ type: 'text', text: "I couldn't find that order. Type *human* and our team will help." });
  if (!CHANGEABLE.has(o.status)) return ctx.reply({ type: 'buttons', text: `Order *${name}* is already being prepared, so I can't change it here – our team can help.`, buttons: [{ id: 'human', title: '🙋 Talk to a person' }] });
  if (cmd === 'ocxl') return ctx.reply({ type: 'buttons', text: `Cancel order *${name}*? This can't be undone.`, buttons: [{ id: `ocxlyes:${o.id}`, title: '✅ Yes, cancel it' }, { id: 'menu', title: 'Keep my order' }] });
  if (cmd === 'ocxlyes') {
    updateOrder(ctx.tenant.id, o.id, { status: 'cancelled', notes: [o.notes, 'Cancelled by the customer in the chat'].filter(Boolean).join(' · ') });
    tellTeam(ctx.tenant, `Order ${name} cancelled by the customer`, `${o.customer_name || ''} (${String(o.wa_id).startsWith('web:') ? 'website chat' : '+' + o.wa_id})${o.payment_status === 'paid' ? '\nIt was PAID – please refund it.' : ''}`, ctx.rawSend);
    return ctx.reply({ type: 'text', text: `Your order *${name}* is cancelled.${o.payment_status === 'paid' ? " As you've already paid, our team will refund you – you'll hear from us soon." : ''}` });
  }
  if (cmd === 'oaddr') {
    ctx.conv.state = 'order_addr';
    ctx.conv.data.orderAddr = o.id;
    return ctx.reply({ type: 'buttons', text: `📍 What's the new delivery address for *${name}*? (house number, street, town and postcode)`, buttons: [{ id: 'menu', title: 'Keep the old one' }] });
  }
  return false;
}

export function orderAddressText(ctx, text) {
  if (ctx.conv.state !== 'order_addr' || !ctx.conv.data.orderAddr) return false;
  const v = String(text || '').trim();
  ctx.conv.state = 'idle';
  const id = ctx.conv.data.orderAddr;
  delete ctx.conv.data.orderAddr;
  if (v.length < 8 || !/\d/.test(v)) return ctx.reply({ type: 'buttons', text: "That doesn't look like a full address. Let's try again?", buttons: [{ id: `oaddr:${id}`, title: '📍 Try again' }, { id: 'human', title: '🙋 Talk to a person' }] });
  const o = ownOrder(ctx, id);
  if (!o || !CHANGEABLE.has(o.status)) return ctx.reply({ type: 'buttons', text: "Sorry, that order can't be changed any more – our team can help.", buttons: [{ id: 'human', title: '🙋 Talk to a person' }] });
  getDb().prepare("UPDATE orders SET address = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(v.slice(0, 500), [o.notes, `Address changed by the customer (was: ${o.address || '–'})`].filter(Boolean).join(' · ').slice(0, 1000), o.id);
  const name = o.store_order_name || `#${o.id}`;
  tellTeam(ctx.tenant, `Order ${name}: new delivery address`, `New address: ${v}\nOld: ${o.address || '–'}`, ctx.rawSend);
  return ctx.reply({ type: 'text', text: `✅ Updated – order *${name}* will go to:\n${v}\n\nOur team has been told.` });
}

// ---------- 3. frustration ----------
const FED_UP = /\b(useless|ridiculous|rubbish|terrible|awful|pathetic|disgusting|disgusted|furious|angry|annoyed|fed up|sick of|waste of (my )?time|not helpful|unhelpful|doesn'?t help|not listening|stupid (bot|thing)|this is a joke|joke of a|complain(t)?|scam|rip[- ]?off|worst|never again)\b|!!!|\b(wtf|ffs)\b/i;
/** True (and a reply sent) when the customer sounds fed up: offer a person instead of another bot answer. */
export function frustrationOffer(ctx, text) {
  if (!FED_UP.test(String(text || ''))) return false;
  const last = Date.parse(ctx.conv.data.fedUpAt || '') || 0;
  if (Date.now() - last < 30 * 60000) return false; // offered recently: let them carry on
  ctx.conv.data.fedUpAt = new Date().toISOString();
  ctx.reply({ type: 'buttons', text: `I'm sorry this has been frustrating. 🙏 Would you like a member of the ${ctx.S.business?.name || ''} team to take over?`.replace('the  team', 'our team'), buttons: [{ id: 'human', title: '🙋 Yes, a person' }, { id: 'ask', title: 'Keep trying here' }] });
  return true;
}
export { FED_UP };
void listTenants;
