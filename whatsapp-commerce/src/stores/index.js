import { shopifyStore } from './shopify.js';
import { wooStore } from './woocommerce.js';
import { customStore } from './custom.js';
import { manualStore } from './manual.js';
import { shopifyPublicStore } from './shopifyPublic.js';

export const STORE_TYPES = ['manual', 'shopify_public', 'shopify', 'woocommerce', 'custom'];

/** Returns the store adapter configured for a tenant. All adapters share the same interface. */
export function getStore(tenant) {
  const s = tenant.settings.store || {};
  switch (s.type) {
    case 'shopify': return shopifyStore(s.shopify || {});
    case 'woocommerce': return wooStore(s.woocommerce || {});
    case 'custom': return customStore(s.custom || {});
    case 'shopify_public': return shopifyPublicStore(s.shopify || {}, { currency: tenant.settings.business?.currency || 'GBP' });
    default: return manualStore(s.manual || {}, { currency: tenant.settings.business?.currency || 'GBP' });
  }
}
