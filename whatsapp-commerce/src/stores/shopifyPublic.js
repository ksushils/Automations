import { httpJson, stripHtml } from './http.js';
import { shopifyStore } from './shopify.js';

/**
 * "Just enter your shop URL" Shopify adapter – no admin token needed.
 * Reads the public storefront JSON (/products.json, /collections.json) and checks out with a Shopify
 * cart permalink (https://shop/cart/<variant>:<qty>,…), so payment, tax and shipping happen on the shop's
 * own Shopify checkout. Upgrade to the full "shopify" adapter (admin token) for draft orders & order status.
 */
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function normaliseDomain(d) {
  return String(d || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
}

export function shopifyPublicStore(settings, { currency = 'GBP' } = {}) {
  const domain = normaliseDomain(settings.domain);
  // origin is recorded when the shop is detected from its website; typed domains default to https
  const base = /^https?:\/\//.test(settings.origin || '') && normaliseDomain(settings.origin) === domain ? settings.origin.replace(/\/$/, '') : `https://${domain}`;

  const map = (p) => {
    const variants = (p.variants || []).map((v) => ({
      id: String(v.id),
      title: v.title === 'Default Title' ? p.title : v.title,
      price: Number(v.price),
      compareAtPrice: Number(v.compare_at_price) > Number(v.price) ? Number(v.compare_at_price) : null,
      available: v.available !== false,
    }));
    return {
      id: String(p.handle || p.id),
      title: p.title,
      description: stripHtml(p.body_html).slice(0, 500),
      image: p.images?.[0]?.src || p.image?.src || null,
      url: `${base}/products/${p.handle}`,
      currency,
      price: variants[0]?.price || 0,
      compareAtPrice: variants[0]?.compareAtPrice || null,
      available: variants.some((v) => v.available),
      variants,
      tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map((t) => t.trim()),
      vendor: p.vendor,
      type: p.product_type,
    };
  };

  // Up to 2,500 products, refreshed every 10 minutes
  const all = () => cached(`${domain}:all`, 600000, async () => {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const d = await httpJson(`${base}/products.json?limit=250&page=${page}`, { timeoutMs: 20000 });
      out.push(...(d.products || []).map(map));
      if ((d.products || []).length < 250) break;
    }
    return out;
  });

  const score = (p, words) => {
    const title = p.title.toLowerCase();
    const hay = `${title} ${p.tags.join(' ')} ${p.vendor || ''} ${p.type || ''}`.toLowerCase();
    const desc = p.description.toLowerCase();
    return words.reduce((s, w) => s + (title.includes(w) ? 5 : 0) + (hay.includes(w) ? 2 : 0) + (desc.includes(w) ? 1 : 0), 0) + (p.available ? 0.5 : 0);
  };

  return {
    type: 'shopify_public',
    async testConnection() {
      const meta = await httpJson(`${base}/meta.json`).catch(() => null);
      const n = (await all()).length;
      return { ok: true, name: meta?.name, products: n, currency: meta?.currency };
    },
    async searchProducts(q, { limit = 10 } = {}) {
      const text = String(q || '').toLowerCase();
      const { max, min } = priceLimits(text);
      const raw = text.replace(/(under|below|less than|up to|max(imum)?|over|above|more than|min(imum)?|from)\s*£?\s*\d+(\.\d+)?/g, ' ')
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
      // each word plus its singular and UK/US spelling: "batteries" finds "Battery", "tyres" finds "Tire"
      const forms = raw.map((w) => [...new Set([w, singular(w), ...(SPELL[w] || []), ...(SPELL[singular(w)] || [])])]);
      const words = [...new Set(forms.flat())];
      const wantsCar = /\b(car|cars|kit|kits|chassis|rtr|ready to run|starter|beginner|new to)\b/.test(text) && !/\b(part|parts|spare|spares|for my|upgrade)\b/.test(text);
      let list = (await all()).filter((p) => !SERVICE.test(p.title) && !SERVICE.test(p.type || '') && p.price > 0);
      if (max) list = list.filter((p) => p.price <= max);
      if (min) list = list.filter((p) => p.price >= min);
      if (!words.length) return list.filter((p) => p.available).slice(0, limit);
      const scored = list.map((p) => {
        const hay = `${p.title} ${p.tags.join(' ')} ${p.vendor || ''} ${p.type || ''}`.toLowerCase();
        // a concept counts once whichever form matched, so plurals don't outweigh real matches
        let s2 = forms.reduce((acc, f) => acc + Math.max(...f.map((w) => score(p, [w]))), 0);
        if (wantsCar && CAR.test(p.title) && p.price >= 80) s2 += 15; // a whole car, not a part with "kit" in its name
        return [p, s2, forms.some((f) => f.some((w) => hay.includes(w)))];
      }).filter(([, s2, hit]) => s2 >= 2 && hit);
      const top = Math.max(0, ...scored.map(([, s2]) => s2));
      return scored.filter(([, s2]) => s2 >= top * 0.5).sort((x, y) => (y[0].available - x[0].available) || y[1] - x[1]).slice(0, limit).map(([p]) => p);
    },
    async listCategories() {
      return cached(`${domain}:cols`, 600000, async () => {
        const d = await httpJson(`${base}/collections.json?limit=250`);
        return (d.collections || [])
          .filter((c) => (c.products_count ?? 1) > 0 && !/^(all|frontpage|home)/.test(c.handle))
          .sort((a, b) => (b.products_count || 0) - (a.products_count || 0))
          .filter((c, i, all) => all.findIndex((x) => x.title.trim().toLowerCase() === c.title.trim().toLowerCase()) === i) // shops often have duplicate collection names
          .slice(0, 30)
          .map((c) => ({ id: c.handle, title: c.title }));
      });
    },
    async productsInCategory(id, { limit = 10 } = {}) {
      const d = await cached(`${domain}:col:${id}`, 600000, () => httpJson(`${base}/collections/${encodeURIComponent(id)}/products.json?limit=50`));
      return (d.products || []).map(map).filter((p) => p.available).slice(0, limit);
    },
    async getProduct(id) {
      const hit = (await all()).find((p) => p.id === String(id) || p.variants.some((v) => v.id === String(id)));
      if (hit) return hit;
      const d = await httpJson(`${base}/products/${encodeURIComponent(id)}.json`).catch(() => null);
      return d?.product ? map(d.product) : null;
    },
    async createOrder({ items, customer, note }) {
      // Cart permalink: customer pays on the shop's own Shopify checkout (shipping, tax, discounts handled there)
      const lines = items.map((i) => `${i.variantId}:${i.quantity}`).join(',');
      const params = new URLSearchParams();
      if (customer?.email) params.set('checkout[email]', customer.email);
      if (note) params.set('note', note.slice(0, 500));
      params.set('ref', 'whatsapp');
      const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
      return { orderId: null, orderName: null, checkoutUrl: `${base}/cart/${lines}?${params}`, total, currency };
    },
    // Order status needs a read-only Admin API key (Settings → Store, or the guide). The Admin API lives on the
    // shop's *.myshopify.com address, which we read from the public meta.json when it isn't saved.
    async getOrderStatus(ref, phone, proof) {
      if (!settings.adminToken) return { unavailable: true };
      return (await admin()).getOrderStatus(ref, phone, proof);
    },
    async testOrders() {
      if (!settings.adminToken) return { ok: false, error: 'No Shopify key saved yet' };
      return (await admin()).testOrders();
    },
  };

  async function admin() {
    let myshopify = settings.myshopifyDomain;
    if (!myshopify) myshopify = (await httpJson(`${base}/meta.json`).catch(() => null))?.myshopify_domain || domain;
    return shopifyStore({ ...settings, domain: myshopify });
  }
}

const stem = (w) => (w.length > 6 && w.endsWith('ing') ? w.slice(0, -3) : w); // drifting -> drift
const singular = (w) => stem(w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 4 && /(ches|shes|sses|xes)$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const SPELL = { tyre: ['tire'], tire: ['tyre'], tyres: ['tires'], tires: ['tyres'], colour: ['color'], color: ['colour'], aluminium: ['aluminum', 'alum'], aluminum: ['aluminium', 'alum'], tyers: ['tyre', 'tire'], battery: ['li-po', 'lipo', 'nimh', 'li-ion'], lipo: ['li-po', 'battery'], charger: ['charger', 'charging'] };
const SERVICE = /^(shipping|postage|delivery) service|gift ?card|^service\b/i;
const CAR = /(drift car|car kit|chassis kit|\brtr\b|ready.to.run|rwd drift car|awd drift car|\bkit\b.*(rwd|awd|drift))/i;
export function priceLimits(text) {
  const n = (re) => { const m = String(text).match(re); return m ? Number(m[2]) : null; };
  return { max: n(/(under|below|less than|up to|max(?:imum)?|cheaper than)\s*£?\s*(\d+(?:\.\d+)?)/), min: n(/(over|above|more than|min(?:imum)?|at least)\s*£?\s*(\d+(?:\.\d+)?)/) };
}

const STOP = new Set(['the', 'and', 'for', 'you', 'have', 'do', 'any', 'with', 'what', 'is', 'are', 'can', 'get', 'got', 'need', 'want', 'looking', 'please', 'me', 'my', 'some', 'show', 'sell', 'buy', 'hi', 'hello', 'a', 'an', 'of', 'in', 'to', 'it', 'this', 'that', 'best', 'good', 'cheap', 'new', 'which', 'recommend', 'suggest', 'under', 'over', 'stock', 'price', 'much', 'how', 'your', 'there', 'they', 'them']);
