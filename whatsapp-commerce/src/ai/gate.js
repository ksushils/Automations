import { config } from '../config.js';

/**
 * May this shop use Dify? Only when you hold a Dify commercial licence (DIFY_LICENSED=true), when the super admin
 * marked the shop difyAllowed (e.g. your own shops), or when the shop points at its OWN Dify (not your console).
 */
export function difyAllowed(tenant) {
  if (config.difyLicensed || tenant?.settings?.difyAllowed === true) return true;
  const base = String(tenant?.settings?.dify?.baseUrl || '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const ours = String(config.difyConsoleUrl || '').replace(/\/$/, '');
  return !!(tenant?.settings?.dify?.apiKey && base && base !== ours);
}
