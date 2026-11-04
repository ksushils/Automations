import { getDb } from '../db.js';
import { subtotal } from './cart.js';

const round = (n) => Math.round(n * 100) / 100;

// ---------- delivery zones (postcode / area based fees) ----------
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/i;

export function outwardCode(address) {
  const m = String(address || '').toUpperCase().match(UK_POSTCODE);
  return m ? m[1] : null;
}

function prefixMatches(prefix, outward, address) {
  const p = String(prefix || '').toUpperCase().replace(/\s+/g, '');
  if (!p) return false;
  if (outward) {
    if (/^[A-Z]+$/.test(p)) return (outward.match(/^[A-Z]+/) || [''])[0] === p; // area: "SE" ≠ "SW"
    if (outward === p) return true;
    return outward.startsWith(p) && !/\d/.test(outward[p.length]); // "SW1" matches "SW1A", "E1" not "E14"
  }
  // Non-UK address: match area names / codes anywhere in the text
  return String(address || '').toUpperCase().includes(String(prefix).toUpperCase());
}

/** zones: [{name, postcodes:["SW1","SE","Croydon"], fee, minOrder}] → matching zone or null */
export function matchZone(zones, address) {
  const outward = outwardCode(address);
  return (zones || []).find((z) => (z.postcodes || z.areas || []).some((p) => prefixMatches(p, outward, address))) || null;
}

// ---------- promo codes ----------
export function promoUses(tenantId, code) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND UPPER(promo_code) = UPPER(?) AND status != 'cancelled'").get(tenantId, code).n;
}

function customerUsed(tenantId, code, waId) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND UPPER(promo_code) = UPPER(?) AND wa_id = ? AND status != 'cancelled'").get(tenantId, code, waId).n > 0;
}

export const findPromo = (O, code) => (O.promoCodes || []).find((p) => p.code && String(p.code).toUpperCase() === String(code || '').trim().toUpperCase());

/** Returns { ok, promo, discount, freeDelivery, reason } */
export function validatePromo(tenant, code, { sub, waId, now = new Date() }) {
  const O = tenant.settings.ordering || {};
  const sym = tenant.settings.business.currencySymbol || '£';
  const promo = findPromo(O, code);
  if (!promo || promo.active === false) return { ok: false, reason: `Sorry, “${code}” isn't a valid code.` };
  if (promo.expires && now > new Date(promo.expires + (String(promo.expires).length <= 10 ? 'T23:59:59' : ''))) return { ok: false, reason: `Sorry, code ${promo.code} has expired.` };
  if (Number(promo.minSpend) > 0 && sub < Number(promo.minSpend)) return { ok: false, reason: `Code ${promo.code} needs a minimum spend of ${sym}${Number(promo.minSpend).toFixed(2)}.` };
  if (Number(promo.maxUses) > 0 && promoUses(tenant.id, promo.code) >= Number(promo.maxUses)) return { ok: false, reason: `Sorry, code ${promo.code} has been fully redeemed.` };
  if (promo.oncePerCustomer && waId && customerUsed(tenant.id, promo.code, waId)) return { ok: false, reason: `You've already used code ${promo.code}.` };
  const value = Number(promo.value) || 0;
  let discount = 0;
  if (promo.type === 'percent') discount = round((sub * Math.min(value, 100)) / 100);
  else if (promo.type === 'fixed') discount = Math.min(round(value), sub);
  return { ok: true, promo, discount, freeDelivery: promo.type === 'free_delivery' };
}

/**
 * Price an order. co = { fulfilment, address, promoCode }.
 * Returns { subtotal, discount, deliveryFee, total, zone, promo, minOrder, error }
 */
export function quote(tenant, cart, co = {}, { waId } = {}) {
  const O = tenant.settings.ordering || {};
  const sub = subtotal(cart);
  const res = { subtotal: sub, discount: 0, deliveryFee: 0, total: sub, zone: null, promo: null, minOrder: Number(O.minOrder) || 0, error: null };

  if (co.fulfilment === 'delivery') {
    const zones = (O.deliveryZones || []).filter((z) => z && (z.postcodes?.length || z.areas?.length));
    let fee = Number(O.deliveryFee) || 0;
    if (zones.length && co.address) {
      res.zone = matchZone(zones, co.address);
      if (!res.zone) res.error = 'no_zone';
      else {
        fee = Number(res.zone.fee) || 0;
        res.minOrder = Math.max(res.minOrder, Number(res.zone.minOrder) || 0);
      }
    }
    const freeOver = Number(res.zone?.freeOver ?? O.freeDeliveryOver) || 0;
    res.deliveryFee = freeOver > 0 && sub >= freeOver ? 0 : fee;
  }

  if (co.promoCode) {
    const v = validatePromo(tenant, co.promoCode, { sub, waId });
    if (v.ok) {
      res.promo = v.promo;
      res.discount = v.discount;
      if (v.freeDelivery) res.deliveryFee = 0;
    }
  }
  res.total = round(Math.max(0, sub - res.discount) + res.deliveryFee);
  return res;
}

// ---------- delivery / collection time slots ----------
function zonedParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, weekday: p.weekday };
}

/**
 * slots config: { enabled, days: 3, times: ["10:00-12:00", "14:00-16:00"], leadHours: 2, closedDays: [0] (0 = Sunday) }
 * Returns up to `max` upcoming slots: [{ id: "2026-11-05|14:00-16:00", label: "Thu 5 Nov · 14:00–16:00" }]
 */
export function upcomingSlots(slotsCfg, { now = new Date(), timeZone = 'Europe/London', max = 10 } = {}) {
  const cfg = slotsCfg || {};
  if (!cfg.enabled || !cfg.times?.length) return [];
  const days = Math.min(Number(cfg.days) || 3, 14);
  const lead = (Number(cfg.leadHours) || 0) * 60;
  const closed = new Set((cfg.closedDays || []).map(Number));
  const nowP = zonedParts(now, timeZone);
  const nowMinutes = nowP.h * 60 + nowP.min;
  const out = [];
  for (let i = 0; i < days && out.length < max; i++) {
    const day = new Date(Date.UTC(nowP.y, nowP.m - 1, nowP.d + i, 12));
    const dow = day.getUTCDay();
    if (closed.has(dow)) continue;
    const ymd = day.toISOString().slice(0, 10);
    const label = day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    for (const t of cfg.times) {
      const [start] = String(t).split('-');
      const [hh, mm] = start.split(':').map(Number);
      const startMin = hh * 60 + (mm || 0);
      if (i * 1440 + startMin < nowMinutes + lead) continue;
      out.push({ id: `${ymd}|${t}`, label: `${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : label} · ${String(t).replace('-', '–')}` });
      if (out.length >= max) break;
    }
  }
  return out;
}
