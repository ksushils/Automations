import { randomBytes } from 'node:crypto';
import { getDb, json } from './db.js';
import { addToCart } from './bot/cart.js';

/*
 * The assistant remembers and carries things across – so a customer never starts again from zero.
 *  1. Quick re-order: a returning WhatsApp customer is offered "Same as last time?" – their last order rebuilt from
 *     today's prices and stock, straight to checkout with their saved details.
 *  2. Continue on WhatsApp: the website chat hands over with a short code (wa.me/<number>?text=…ref ABC123); the
 *     WhatsApp conversation picks up the basket, the page they were on and what they'd said.
 *  3. Customer memory: a few durable facts (sizes, likes, party size, budget…) kept on the customer record and given
 *     to the AI next time. Never special-category data (health, religion, ethnicity, politics, sexuality), never
 *     payment details. "forget me" clears it; it is deleted with the customer (erasure / retention).
 */

// ---------- 1. quick re-order ----------
export function lastOrder(tenantId, waId) {
  const r = getDb().prepare("SELECT * FROM orders WHERE tenant_id = ? AND wa_id = ? AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1").get(tenantId, waId);
  return r ? { ...r, items: json(r.items, []) } : null;
}

const itemsLine = (items) => items.slice(0, 4).map((i) => `${i.quantity}× ${i.title}`).join(', ') + (items.length > 4 ? ` +${items.length - 4} more` : '');

/** "Same as last time?" for a returning customer with a past order in this chat (null if none). */
export function reorderOffer(ctx) {
  if (ctx.S.ordering?.reorder === false || ctx.S.store?.type === 'none' || String(ctx.conv.waId).startsWith('web:')) return null;
  const o = lastOrder(ctx.tenant.id, ctx.conv.waId);
  if (!o?.items?.length) return null;
  const sym = ctx.S.business.currencySymbol || '£';
  return { type: 'buttons', text: `🔁 Same as last time?\n${itemsLine(o.items)} – ${sym}${Number(o.total ?? o.subtotal ?? 0).toFixed(2)} last time`, buttons: [{ id: `reorder:${o.id}`, title: '🔁 Order again' }, { id: 'browse', title: '🛍️ Something else' }] };
}

/** Rebuild the order from today's catalogue (price and stock now), then go to checkout. */
export async function reorder(ctx, orderId, { checkout }) {
  const o = getDb().prepare('SELECT * FROM orders WHERE tenant_id = ? AND id = ? AND wa_id = ?').get(ctx.tenant.id, Number(orderId), ctx.conv.waId);
  if (!o) return ctx.reply({ type: 'text', text: "I couldn't find that order. Type *menu* to start a new one." });
  const items = json(o.items, []);
  const missing = [];
  ctx.conv.cart = [];
  for (const i of items) {
    const p = await ctx.store.getProduct(i.productId).catch(() => null);
    const v = p && (i.variantId ? (p.variants || []).find((x) => String(x.id) === String(i.variantId)) : null);
    const available = p && p.available !== false && (!i.variantId || (v && v.available !== false));
    if (!available) { missing.push(i.title); continue; }
    addToCart(ctx.conv.cart, { productId: p.id, variantId: i.variantId || null, title: i.title, price: Number(v?.price ?? p.price) || 0, quantity: i.quantity });
  }
  if (!ctx.conv.cart.length) return ctx.reply({ type: 'buttons', text: `😔 Sorry, ${missing.length > 1 ? "those items aren't" : `${missing[0] || 'that'} isn't`} available right now.`, buttons: [{ id: 'browse', title: '🛍️ Browse' }, { id: 'human', title: '🙋 Talk to a person' }] });
  if (missing.length) ctx.reply({ type: 'text', text: `Heads up: ${missing.join(', ')} ${missing.length > 1 ? "aren't" : "isn't"} available today, so I've left ${missing.length > 1 ? 'them' : 'it'} out.` });
  return checkout(ctx);
}

// ---------- 2. continue on WhatsApp ----------
const CODE = /^[A-HJ-NP-Z2-9]{6}$/;
export function createHandoff(tenantId, webWaId) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = [...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join('');
  getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`handoff:${tenantId}:${code}`, JSON.stringify({ waId: webWaId, at: new Date().toISOString() }));
  return code;
}

/** "…(ref ABC123)" arriving on WhatsApp: bring the website chat across. Returns a welcome text, or null. */
export function claimHandoff(ctx, text) {
  if (String(ctx.conv.waId).startsWith('web:')) return null;
  const m = String(text || '').match(/\bref[:\s#]*([A-HJ-NP-Z2-9]{6})\b/i);
  if (!m || !CODE.test(m[1].toUpperCase())) return null;
  const key = `handoff:${ctx.tenant.id}:${m[1].toUpperCase()}`;
  const row = json(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value, null);
  if (!row || Date.now() - Date.parse(row.at) > 7 * 86400000) return null;
  getDb().prepare('DELETE FROM kv WHERE key = ?').run(key); // one use
  const web = getDb().prepare('SELECT * FROM conversations WHERE tenant_id = ? AND wa_id = ?').get(ctx.tenant.id, row.waId);
  if (!web) return null;
  const data = json(web.state_data, {});
  const cart = json(web.cart, []);
  if (!ctx.conv.cart.length && cart.length) ctx.conv.cart = cart;
  for (const k of ['page', 'utm']) if (data[k] && !ctx.conv.data[k]) ctx.conv.data[k] = data[k];
  // what they said on the website, for the AI (last few lines only)
  const lines = getDb().prepare('SELECT direction, body FROM messages WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC LIMIT 10').all(ctx.tenant.id, row.waId).reverse()
    .map((r) => { const b = json(r.body, {}); const t = String(b.text || '').trim(); return t && !/^\[/.test(t) ? `${r.direction === 'in' ? 'Customer' : 'Assistant'}: ${t.slice(0, 200)}` : ''; }).filter(Boolean);
  if (lines.length) ctx.conv.data.priorChat = lines.join('\n').slice(-1200);
  ctx.conv.data.continuedFrom = row.waId;
  // the web visitor's email (if they gave one) joins their WhatsApp record
  const webCustomer = getDb().prepare('SELECT email, attributes FROM customers WHERE tenant_id = ? AND wa_id = ?').get(ctx.tenant.id, row.waId);
  if (webCustomer?.email) getDb().prepare('UPDATE customers SET email = COALESCE(email, ?) WHERE tenant_id = ? AND wa_id = ?').run(webCustomer.email, ctx.tenant.id, ctx.conv.waId);
  const mem = json(webCustomer?.attributes, {}).memory;
  if (mem?.facts?.length) rememberFacts(ctx.tenant.id, ctx.conv.waId, mem.facts);
  const n = ctx.conv.cart.reduce((s, i) => s + i.quantity, 0);
  return `👋 Welcome! I've brought over your chat from our website${data.page?.title ? ` (you were looking at *${data.page.title}*)` : ''}${n ? ` and your basket (${n} item${n > 1 ? 's' : ''})` : ''}. How can I help?`;
}

// ---------- 3. customer memory ----------
const SENSITIVE = /\b(religio|faith|hindu|muslim|islam|christian|sikh|jewish|buddhis|church|temple|mosque|pray|health|medical|illness|disab|pregnan|diagnos|medicat|diabet|asthma|allerg|intoleran|cancer|depress|anxiety|mental|epilep|autis|adhd|hiv|wheelchair|therap|ethnic|race|caste|politic|vote|sexual|gay|lesbian|trans|card number|cvv|password|bank account|sort code)/i;
export function memoryOf(tenantId, waId) {
  const a = json(getDb().prepare('SELECT attributes FROM customers WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId)?.attributes, {});
  return Array.isArray(a.memory?.facts) ? a.memory.facts : [];
}
export function rememberFacts(tenantId, waId, facts) {
  const row = getDb().prepare('SELECT attributes FROM customers WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId);
  if (!row) return [];
  const a = json(row.attributes, {});
  const merged = [...new Set([...(facts || []), ...(a.memory?.facts || [])].map((f) => String(f).replace(/\s+/g, ' ').trim()).filter((f) => f.length >= 3 && f.length <= 120 && !SENSITIVE.test(f)))].slice(0, 8);
  a.memory = { facts: merged, updatedAt: new Date().toISOString() };
  getDb().prepare('UPDATE customers SET attributes = ? WHERE tenant_id = ? AND wa_id = ?').run(JSON.stringify(a), tenantId, waId);
  return merged;
}
export function forgetMemory(tenantId, waId) {
  const row = getDb().prepare('SELECT attributes FROM customers WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId);
  if (!row) return;
  const a = json(row.attributes, {});
  delete a.memory;
  getDb().prepare('UPDATE customers SET attributes = ? WHERE tenant_id = ? AND wa_id = ?').run(JSON.stringify(a), tenantId, waId);
}
export const memoryNote = (facts) => (facts.length ? `What we remember about this customer from earlier chats (use it naturally to help, don't recite it): ${facts.join('; ')}.` : '');
export { SENSITIVE as SENSITIVE_MEMORY };
