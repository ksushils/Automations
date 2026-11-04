/**
 * Built-in catalogue (no external store) – for small sellers like Take.App users.
 * Products live in tenant settings: store.manual.products = [{id,title,price,description,image,category,variants?:[{id,title,price}]}]
 * Orders are kept in this system's dashboard only.
 */
export function manualStore(settings, { currency = 'GBP' } = {}) {
  const inStock = (n) => n === undefined || n === null || n === '' || Number(n) > 0;
  const norm = (p) => withAvail({
    id: String(p.id),
    title: p.title,
    description: p.description || '',
    image: p.image || null,
    url: p.url || null,
    currency,
    price: Number(p.price || 0),
    compareAtPrice: Number(p.compareAtPrice) > Number(p.price) ? Number(p.compareAtPrice) : null,
    variants: (p.variants?.length ? p.variants : [{ id: String(p.id), title: p.title, price: p.price, stock: p.stock }]).map((v) => ({
      id: String(v.id), title: v.title, price: Number(v.price ?? p.price), available: v.available !== false && inStock(v.stock ?? p.stock), stock: v.stock ?? p.stock,
    })),
  });
  function withAvail(p) {
    p.available = p.variants.some((v) => v.available);
    return p;
  }
  const products = () => (settings.products || []).filter((p) => p.available !== false).map(norm);
  const raw = () => settings.products || [];
  return {
    type: 'manual',
    async testConnection() { return { ok: true, products: raw().length }; },
    async searchProducts(q, { limit = 10 } = {}) {
      const words = String(q || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
      const all = products();
      if (!words.length) return all.slice(0, limit);
      return all
        .map((p) => ({ p, score: words.reduce((s, w) => s + (p.title.toLowerCase().includes(w) || p.title.toLowerCase().includes(w.replace(/s$/, '')) ? 3 : 0) + (p.description.toLowerCase().includes(w) ? 1 : 0), 0) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.p);
    },
    async listCategories() {
      const used = new Set(raw().map((p) => String(p.category || 'general')));
      return (settings.categories || []).filter((c) => used.has(String(c.id)));
    },
    async productsInCategory(id, { limit = 10 } = {}) {
      const ids = new Set(raw().filter((p) => String(p.category || 'general') === String(id)).map((p) => String(p.id)));
      return products().filter((p) => ids.has(p.id)).slice(0, limit);
    },
    async getProduct(id) { return products().find((p) => p.id === String(id)) || null; },
    async createOrder({ items, paymentMethod, shippingFee = 0 }) {
      const total = Math.round((items.reduce((s, i) => s + i.price * i.quantity, 0) + shippingFee) * 100) / 100;
      return { orderId: null, orderName: null, checkoutUrl: null, total, currency, paymentMethod };
    },
    async getOrderStatus() { return null; },
  };
}
