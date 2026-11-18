/*
 * Add to the shop's REAL basket. When a visitor chats on the shop's own Shopify or WooCommerce site, "Add to basket"
 * puts the item in that site's own cart (the widget calls the site's cart from the page itself), so they check out
 * the way they always do – no second basket, no leaving the page.
 *   Shopify:     POST /cart/add.js { items: [{ id: <variant id>, quantity, properties }] }, then /cart/update.js marks the
 *                cart as chat-assisted (attributes) so the order shows it came via the assistant.
 *   WooCommerce: POST /?wc-ajax=add_to_cart (product_id = the product or variation id, quantity), then the theme's
 *                mini-cart is refreshed with the standard 'added_to_cart' / 'wc_fragment_refresh' events.
 * Only on the shop's own domain (the visitor's page must be on it); anywhere else the chat keeps its own basket.
 * Nothing here touches checkout or payment details.
 */
const host = (u) => { try { return new URL(/^https?:\/\//.test(u) ? u : `https://${u}`).host.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

/** { platform, origin } when this web visitor is on the shop's own Shopify / WooCommerce site, else null. */
export function siteCartFor(ctx) {
  if (!String(ctx.conv?.waId || '').startsWith('web:') || ctx.S.ordering?.siteCart === false) return null;
  const type = ctx.S.store?.type;
  const platform = type === 'woocommerce' ? 'woocommerce' : ['shopify', 'shopify_public'].includes(type) ? 'shopify' : null;
  const url = ctx.conv.data?.page?.url;
  if (!platform || !url) return null;
  const here = host(url);
  const shop = [ctx.S.store?.shopify?.domain, ctx.S.store?.shopify?.origin, ctx.S.store?.woocommerce?.url, ctx.S.store?.woocommerce?.baseUrl, ctx.S.business?.website, ...(ctx.S.store?.siteDomains || [])].map((d) => host(d || '')).filter(Boolean);
  if (!here || !shop.includes(here)) return null;
  return { platform, origin: new URL(url).origin };
}

/** The numeric id the site's cart wants (Shopify Admin API ids are gid://shopify/ProductVariant/123). */
export const cartId = (id) => { const m = String(id || '').match(/(\d+)\s*$/); return m ? m[1] : null; };

/** The chat message that makes the widget add the item to the site's basket (and say so). */
export function siteCartMessage(ctx, site, item, qty) {
  const id = cartId(item.variantId || item.productId);
  if (!id) return null;
  return {
    type: 'site_cart',
    text: `Adding ${qty} × ${item.title} to your basket…`,
    platform: site.platform,
    items: [{ id, quantity: qty }],
    title: item.title,
    quantity: qty,
    cartUrl: `${site.origin}/cart`,
    checkoutUrl: site.platform === 'shopify' ? `${site.origin}/checkout` : `${site.origin}/checkout/`,
    attribution: ctx.S.business?.name ? `Chat assistant` : 'Chat assistant',
  };
}
