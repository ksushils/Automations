import { httpJson, stripHtml, phonesMatch, splitName } from './http.js';

/**
 * WooCommerce adapter (WordPress on your VPS). Uses the WC REST API v3 with a read/write API key
 * created in WooCommerce → Settings → Advanced → REST API. HTTPS required.
 */
export function wooStore(settings) {
  const base = String(settings.url || '').replace(/\/$/, '') + '/wp-json/wc/v3';
  const auth = 'Basic ' + Buffer.from(`${settings.consumerKey}:${settings.consumerSecret}`).toString('base64');
  const api = (path, opts = {}) => httpJson(base + path, { ...opts, headers: { Authorization: auth } });

  let currencyCache;
  async function currency() {
    if (!currencyCache) {
      const s = await api('/settings/general/woocommerce_currency').catch(() => null);
      currencyCache = s?.value || 'GBP';
    }
    return currencyCache;
  }

  async function map(p) {
    let variants = [{ id: String(p.id), title: p.name, price: Number(p.price || 0), available: p.stock_status !== 'outofstock' && p.purchasable !== false }];
    if (p.type === 'variable' && p.variations?.length) {
      const vs = await api(`/products/${p.id}/variations?per_page=20&status=publish`).catch(() => []);
      if (vs.length) {
        variants = vs.map((v) => ({
          id: String(v.id),
          title: v.attributes.map((a) => a.option).join(' / ') || `Option ${v.id}`,
          price: Number(v.price || 0),
          available: v.stock_status !== 'outofstock' && v.purchasable !== false,
        }));
      }
    }
    return {
      id: String(p.id),
      title: p.name,
      description: stripHtml(p.short_description || p.description).slice(0, 500),
      image: p.images?.[0]?.src || null,
      url: p.permalink,
      currency: await currency(),
      price: Number(p.price || variants[0]?.price || 0),
      available: variants.some((v) => v.available),
      variants,
    };
  }

  return {
    type: 'woocommerce',
    async testConnection() {
      await api('/products?per_page=1');
      return { ok: true, currency: await currency() };
    },
    async searchProducts(query, { limit = 10 } = {}) {
      const list = await api(`/products?status=publish&per_page=${limit}${query ? `&search=${encodeURIComponent(query)}` : ''}`);
      return Promise.all(list.map(map));
    },
    async listCategories() {
      const cats = await api('/products/categories?per_page=20&hide_empty=true&orderby=count&order=desc');
      return cats.filter((c) => c.slug !== 'uncategorized' || c.count > 0).map((c) => ({ id: String(c.id), title: stripHtml(c.name) }));
    },
    async productsInCategory(categoryId, { limit = 10 } = {}) {
      const list = await api(`/products?status=publish&per_page=${limit}&category=${encodeURIComponent(categoryId)}`);
      return Promise.all(list.map(map));
    },
    async getProduct(id) {
      const p = await api(`/products/${encodeURIComponent(id)}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
      return p ? map(p) : null;
    },
    async createOrder({ items, customer, paymentMethod, fulfilment, note, shippingFee = 0 }) {
      const { first, last } = splitName(customer.name);
      const pm = {
        cod: ['cod', 'Cash on delivery', 'processing'],
        bank_transfer: ['bacs', 'Direct bank transfer', 'on-hold'],
        payment_link: ['', 'Pay online', 'pending'],
      }[paymentMethod] || ['', 'WhatsApp', 'pending'];
      const addr = { first_name: first, last_name: last, address_1: (customer.address || '').slice(0, 200), phone: '+' + customer.phone, email: customer.email || '' };
      const order = await api('/orders', {
        method: 'POST',
        body: {
          status: pm[2],
          payment_method: pm[0],
          payment_method_title: pm[1],
          set_paid: false,
          billing: addr,
          shipping: fulfilment === 'delivery' ? addr : { first_name: first, last_name: last },
          customer_note: [note, `Ordered via WhatsApp (${fulfilment})`].filter(Boolean).join('\n'),
          line_items: items.map((i) => (i.variantId && i.variantId !== i.productId
            ? { product_id: Number(i.productId), variation_id: Number(i.variantId), quantity: i.quantity }
            : { product_id: Number(i.productId), quantity: i.quantity })),
          shipping_lines: shippingFee > 0 ? [{ method_id: 'flat_rate', method_title: 'Delivery', total: shippingFee.toFixed(2) }] : [],
          meta_data: [{ key: '_order_source', value: 'whatsapp' }],
        },
      });
      return {
        orderId: String(order.id),
        orderName: '#' + (order.number || order.id),
        checkoutUrl: paymentMethod === 'payment_link' ? order.payment_url : null,
        total: Number(order.total),
        currency: order.currency,
      };
    },
    async getOrderStatus(ref, phone) {
      const id = String(ref).replace(/\D/g, '');
      if (!id) return null;
      const o = await api(`/orders/${id}`).catch(() => null);
      if (!o || !phonesMatch(o.billing?.phone, phone)) return null;
      const tracking = (o.meta_data || [])
        .filter((m) => m.key === '_wc_shipment_tracking_items')
        .flatMap((m) => m.value || [])
        .map((t) => ({ number: t.tracking_number, url: t.custom_tracking_link || null, company: t.tracking_provider || t.custom_tracking_provider }));
      return { name: '#' + (o.number || o.id), status: o.status, payment: o.date_paid ? 'paid' : 'unpaid', tracking };
    },
  };
}
