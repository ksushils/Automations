import { shopifyStore } from './shopify.js';
import { wooStore } from './woocommerce.js';
import { customStore } from './custom.js';
import { manualStore } from './manual.js';
import { shopifyPublicStore } from './shopifyPublic.js';

// 'none' = enquiries and bookings only (services, experiences, salons…): answers questions and links to booking pages, no basket
export const STORE_TYPES = ['manual', 'shopify_public', 'shopify', 'woocommerce', 'custom', 'none'];

/** Returns the store adapter configured for a tenant. All adapters share the same interface. */
export function getStore(tenant) {
  const s = tenant.settings.store || {};
  switch (s.type) {
    case 'shopify': return shopifyStore(s.shopify || {});
    case 'woocommerce': return wooStore(s.woocommerce || {});
    case 'custom': return customStore(s.custom || {});
    case 'none': return manualStore({ products: [], categories: [] }, { currency: tenant.settings.business?.currency || 'GBP' });
    case 'shopify_public': return shopifyPublicStore(s.shopify || {}, { currency: tenant.settings.business?.currency || 'GBP' });
    default: return manualStore(s.manual || {}, { currency: tenant.settings.business?.currency || 'GBP' });
  }
}
