import { httpJson, stripHtml, phonesMatch, splitName } from './http.js';
import { config } from '../config.js';

/**
 * Shopify adapter – uses the Admin GraphQL API with a custom-app access token.
 * Required scopes: read_products, write_draft_orders, read_orders (+ write_orders for COD orders).
 */
export function shopifyStore(settings) {
  const domain = String(settings.domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const endpoint = `https://${domain}/admin/api/${config.shopifyApiVersion}/graphql.json`;

  async function gql(query, variables = {}) {
    const data = await httpJson(endpoint, { method: 'POST', headers: { 'X-Shopify-Access-Token': settings.adminToken }, body: { query, variables } });
    if (data.errors?.length) throw new Error('Shopify: ' + data.errors.map((e) => e.message).join('; '));
    return data.data;
  }

  const PRODUCT_FIELDS = `
    id title handle description onlineStoreUrl status totalInventory
    featuredImage { url }
    variants(first: 20) { nodes { id title price compareAtPrice availableForSale } }
  `;

  const map = (p, currency) => ({
    id: p.id,
    title: p.title,
    description: stripHtml(p.description).slice(0, 500),
    image: p.featuredImage?.url || null,
    url: p.onlineStoreUrl || `https://${domain}/products/${p.handle}`,
    currency,
    price: Number(p.variants.nodes[0]?.price || 0),
    compareAtPrice: Number(p.variants.nodes[0]?.compareAtPrice) > Number(p.variants.nodes[0]?.price) ? Number(p.variants.nodes[0].compareAtPrice) : null,
    available: p.variants.nodes.some((v) => v.availableForSale),
    variants: p.variants.nodes.map((v) => ({ id: v.id, title: v.title === 'Default Title' ? p.title : v.title, price: Number(v.price), available: v.availableForSale })),
  });

  let currencyCache;
  async function currency() {
    if (!currencyCache) currencyCache = (await gql('{ shop { currencyCode } }')).shop.currencyCode;
    return currencyCache;
  }

  const sanitize = (q) => String(q || '').replace(/["\\:()]/g, ' ').trim();

  return {
    type: 'shopify',
    async testConnection() {
      const d = await gql('{ shop { name currencyCode myshopifyDomain } }');
      return { ok: true, name: d.shop.name, currency: d.shop.currencyCode };
    },
    async searchProducts(query, { limit = 10 } = {}) {
      const q = sanitize(query);
      const search = q ? `status:active AND (${q.split(/\s+/).map((w) => `title:${w}* OR tag:${w} OR product_type:${w}* OR ${w}`).join(' OR ')})` : 'status:active';
      const d = await gql(`query($q: String!, $n: Int!) { products(first: $n, query: $q, sortKey: RELEVANCE) { nodes { ${PRODUCT_FIELDS} } } }`, { q: search, n: limit });
      const c = await currency();
      return d.products.nodes.map((p) => map(p, c));
    },
    async listCategories() {
      const d = await gql('{ collections(first: 20, sortKey: TITLE) { nodes { id title productsCount { count } } } }');
      return d.collections.nodes.filter((c) => (c.productsCount?.count ?? 1) > 0).map((c) => ({ id: c.id, title: c.title }));
    },
    async productsInCategory(categoryId, { limit = 10 } = {}) {
      const d = await gql(`query($id: ID!, $n: Int!) { collection(id: $id) { products(first: $n) { nodes { ${PRODUCT_FIELDS} } } } }`, { id: categoryId, n: limit });
      const c = await currency();
      return (d.collection?.products.nodes || []).filter((p) => p.status === 'ACTIVE').map((p) => map(p, c));
    },
    async getProduct(id) {
      const d = await gql(`query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id });
      return d.product ? map(d.product, await currency()) : null;
    },
    async createOrder({ items, customer, paymentMethod, fulfilment, note, shippingFee = 0, discount = 0, promoCode }) {
      const { first, last } = splitName(customer.name);
      const input = {
        lineItems: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
        note: [note, `Ordered via WhatsApp (${fulfilment}, ${paymentMethod})`].filter(Boolean).join('\n'),
        tags: ['whatsapp', `wa-${paymentMethod}`],
        phone: '+' + customer.phone.replace(/^\+/, ''),
        ...(customer.email ? { email: customer.email } : {}),
        ...(fulfilment === 'delivery' && customer.address
          ? { shippingAddress: { firstName: first, lastName: last, address1: customer.address.slice(0, 255), phone: '+' + customer.phone } }
          : {}),
        ...(discount > 0 ? { appliedDiscount: { value: discount, valueType: 'FIXED_AMOUNT', title: promoCode || 'Discount', description: 'WhatsApp promo' } } : {}),
        ...(shippingFee > 0 ? { shippingLine: { title: 'Delivery', priceWithCurrency: { amount: shippingFee, currencyCode: await currency() } } } : {}),
      };
      const d = await gql(
        `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name invoiceUrl totalPriceSet { shopMoney { amount currencyCode } } } userErrors { field message } } }`,
        { input },
      );
      const errs = d.draftOrderCreate.userErrors;
      if (errs?.length) throw new Error('Shopify: ' + errs.map((e) => e.message).join('; '));
      const draft = d.draftOrderCreate.draftOrder;
      const total = Number(draft.totalPriceSet.shopMoney.amount);
      const curr = draft.totalPriceSet.shopMoney.currencyCode;

      if (paymentMethod === 'payment_link') {
        return { orderId: draft.id, orderName: draft.name, checkoutUrl: draft.invoiceUrl, total, currency: curr };
      }
      // COD / bank transfer: convert the draft into a real order with payment pending.
      const c = await gql(
        `mutation($id: ID!) { draftOrderComplete(id: $id, paymentPending: true) { draftOrder { order { id name } } userErrors { message } } }`,
        { id: draft.id },
      );
      const order = c.draftOrderComplete.draftOrder?.order;
      if (!order) throw new Error('Shopify: ' + (c.draftOrderComplete.userErrors || []).map((e) => e.message).join('; '));
      return { orderId: order.id, orderName: order.name, checkoutUrl: null, total, currency: curr };
    },
    async getOrderStatus(ref, phone) {
      const name = String(ref).replace(/^#?/, '#');
      const d = await gql(
        `query($q: String!) { orders(first: 1, query: $q) { nodes { id name phone customer { phone } displayFinancialStatus displayFulfillmentStatus cancelledAt
           fulfillments(first: 5) { trackingInfo(first: 3) { number url company } } } } }`,
        { q: `name:${name}` },
      );
      const o = d.orders.nodes[0];
      if (!o || !(phonesMatch(o.phone, phone) || phonesMatch(o.customer?.phone, phone))) return null;
      const tracking = o.fulfillments.flatMap((f) => f.trackingInfo).filter((t) => t.number || t.url);
      return {
        name: o.name,
        status: o.cancelledAt ? 'cancelled' : String(o.displayFulfillmentStatus || '').toLowerCase(),
        payment: String(o.displayFinancialStatus || '').toLowerCase(),
        tracking,
      };
    },
  };
}
