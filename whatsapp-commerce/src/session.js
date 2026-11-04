import crypto from 'node:crypto';
import { config } from './config.js';

// Signed per-customer token handed to Dify (as an input). Dify tools must send it back, so the LLM can only
// ever act on the cart of the customer it is talking to – it cannot be prompt-injected into another customer's cart.
const sign = (s) => crypto.createHmac('sha256', config.encryptionKey || 'dev-only-insecure-key').update(s).digest('base64url').slice(0, 32);

export function createSessionToken(tenantId, waId) {
  const body = Buffer.from(JSON.stringify({ t: tenantId, w: waId })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || sign(body) !== sig) return null;
  try {
    const { t, w } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return t && w ? { tenantId: t, waId: w } : null;
  } catch {
    return null;
  }
}
