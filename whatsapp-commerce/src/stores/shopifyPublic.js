import { httpJson, stripHtml } from './http.js';

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
      const words = String(q || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
      const list = await all();
      if (!words.length) return list.filter((p) => p.available).slice(0, limit);
      // must match the title/tags/brand, in-stock first, and drop weak matches relative to the best one
      const scored = list.map((p) => [p, score(p, words)]).filter(([p, s]) => s >= 2 && words.some((w) => `${p.title} ${p.tags.join(' ')} ${p.vendor || ''} ${p.type || ''}`.toLowerCase().includes(w)));
      const top = Math.max(0, ...scored.map(([, s]) => s));
      return scored.filter(([, s]) => s >= top * 0.5).sort((a, b) => (b[0].available - a[0].available) || b[1] - a[1]).slice(0, limit).map(([p]) => p);
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
    async getOrderStatus() { return null; },
  };
}

const STOP = new Set(['the', 'and', 'for', 'you', 'have', 'do', 'any', 'with', 'what', 'is', 'are', 'can', 'get', 'got', 'need', 'want', 'looking', 'please', 'me', 'my', 'some', 'show', 'sell', 'buy', 'hi', 'hello', 'a', 'an', 'of', 'in', 'to', 'it', 'this', 'that']);
