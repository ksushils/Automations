import { httpJson } from './http.js';

/**
 * Generic adapter for any other site on your VPS (custom PHP/Laravel/Node shop, OpenCart, Magento bridge…).
 * The site exposes 6 small JSON endpoints – see docs/CUSTOM_STORE_API.md for the exact contract.
 */
export function customStore(settings) {
  const base = String(settings.baseUrl || '').replace(/\/$/, '');
  const api = (path, opts = {}) => httpJson(base + path, { ...opts, headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {} });
  const norm = (p) => ({
    id: String(p.id),
    title: p.title,
    description: p.description || '',
    image: p.image || null,
    url: p.url || null,
    currency: p.currency || 'GBP',
    price: Number(p.price || 0),
    compareAtPrice: Number(p.compareAtPrice) > Number(p.price) ? Number(p.compareAtPrice) : null,
    available: p.available !== false,
    variants: (p.variants?.length ? p.variants : [{ id: String(p.id), title: p.title, price: p.price, available: p.available !== false }]).map((v) => ({
      id: String(v.id), title: v.title, price: Number(v.price ?? p.price ?? 0), available: v.available !== false,
    })),
  });
  return {
    type: 'custom',
    async testConnection() { await api('/products?limit=1'); return { ok: true }; },
    async searchProducts(q, { limit = 10 } = {}) { return ((await api(`/products?q=${encodeURIComponent(q || '')}&limit=${limit}`)) || []).map(norm); },
    async listCategories() { return ((await api('/categories')) || []).map((c) => ({ id: String(c.id), title: c.title })); },
    async productsInCategory(id, { limit = 10 } = {}) { return ((await api(`/categories/${encodeURIComponent(id)}/products?limit=${limit}`)) || []).map(norm); },
    async getProduct(id) { const p = await api(`/products/${encodeURIComponent(id)}`).catch((e) => (e.status === 404 ? null : Promise.reject(e))); return p ? norm(p) : null; },
    async createOrder(payload) {
      const o = await api('/orders', { method: 'POST', body: payload });
      return { orderId: String(o.id), orderName: o.name || `#${o.id}`, checkoutUrl: o.checkoutUrl || null, total: Number(o.total), currency: o.currency };
    },
    async getOrderStatus(ref, phone) {
      return api(`/orders/${encodeURIComponent(String(ref).replace(/^#/, ''))}?phone=${encodeURIComponent(phone)}`).catch(() => null);
    },
  };
}
