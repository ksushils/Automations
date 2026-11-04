import { config } from './config.js';

/** WhatsApp message templates (Meta Business Management API) for a tenant's WABA. */
async function graph(tenant, method, path, body) {
  const { accessToken, wabaId } = tenant.settings.whatsapp || {};
  if (!accessToken || !wabaId) throw new Error('Set the WhatsApp Business Account ID and access token first');
  const res = await fetch(`https://graph.facebook.com/${config.graphVersion}/${wabaId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta: ${data.error?.error_user_msg || data.error?.message || res.status}`);
  return data;
}

export async function listTemplates(tenant) {
  const d = await graph(tenant, 'GET', '/message_templates?fields=name,status,category,language,components,rejected_reason&limit=200');
  return d.data || [];
}

export function createTemplate(tenant, t) {
  return graph(tenant, 'POST', '/message_templates', buildTemplate(t));
}

export function deleteTemplate(tenant, name) {
  return graph(tenant, 'DELETE', `/message_templates?name=${encodeURIComponent(name)}`);
}

/** Simple form → Meta template payload. Body variables are {{1}}, {{2}}… with example values. */
export function buildTemplate({ name, language = 'en_GB', category = 'MARKETING', header, body, footer, buttons = [], examples = [] }) {
  if (!/^[a-z0-9_]{1,512}$/.test(name || '')) throw new Error('Template name: lowercase letters, numbers and underscores only');
  if (!body) throw new Error('Template body is required');
  const vars = [...String(body).matchAll(/\{\{(\d+)\}\}/g)].length;
  const components = [];
  if (header) components.push({ type: 'HEADER', format: 'TEXT', text: header });
  components.push({ type: 'BODY', text: body, ...(vars ? { example: { body_text: [Array.from({ length: vars }, (_, i) => examples[i] || `example${i + 1}`)] } } : {}) });
  if (footer) components.push({ type: 'FOOTER', text: footer });
  const btns = buttons.filter((b) => b?.text).slice(0, 10).map((b) => (b.url ? { type: 'URL', text: b.text, url: b.url, ...(/\{\{1\}\}/.test(b.url) ? { example: [b.url.replace('{{1}}', 'abc123')] } : {}) } : { type: 'QUICK_REPLY', text: b.text }));
  if (btns.length) components.push({ type: 'BUTTONS', buttons: btns });
  return { name, language, category: String(category).toUpperCase(), components };
}

/** One-click starter templates used by the automations in this product. */
export const TEMPLATE_LIBRARY = [
  { name: 'order_confirmation', category: 'UTILITY', body: 'Hi {{1}}, thanks for your order {{2}} at {{3}}! Total: {{4}}. We will message you when it ships.', examples: ['Jane', '#1001', 'RC Shopper', '£42.00'], use: 'Website orders (Shopify / WooCommerce)' },
  { name: 'shipping_update', category: 'UTILITY', body: 'Good news {{1}}! Your order {{2}} has shipped. Track it here: {{3}}', examples: ['Jane', '#1001', 'https://track.example/abc'], use: 'Website order shipped' },
  { name: 'abandoned_cart', category: 'MARKETING', body: 'Hi {{1}}, you left something in your basket at {{2}} 🛒 Complete your order here: {{3}}', examples: ['Jane', 'RC Shopper', 'https://shop.example/checkout/abc'], buttons: [{ text: 'Stop offers' }], use: 'Abandoned checkout recovery' },
  { name: 'payment_reminder', category: 'UTILITY', body: 'Hi {{1}}, order {{2}} ({{3}}) is waiting for payment. Pay here: {{4}}', examples: ['Jane', 'WA-12', '£18.00', 'https://pay.example/abc'], use: 'Unpaid orders outside 24h' },
  { name: 'win_back', category: 'MARKETING', body: 'We miss you {{1}}! Here is {{2}} off your next order with code {{3}} 💚 Reply SHOP to browse.', examples: ['Jane', '10%', 'COMEBACK10'], buttons: [{ text: 'Shop now' }, { text: 'Stop offers' }], use: 'Win-back' },
  { name: 'weekend_offer', category: 'MARKETING', body: 'Hi {{1}}! This weekend only: {{2}}. Reply SHOP to order on WhatsApp.', examples: ['Jane', '20% off everything'], buttons: [{ text: 'Shop now' }, { text: 'Stop offers' }], use: 'Broadcast campaigns' },
  { name: 'back_in_stock', category: 'MARKETING', body: 'Hi {{1}}, {{2}} is back in stock! Reply SHOP to order before it sells out.', examples: ['Jane', 'Scented Candle'], buttons: [{ text: 'Shop now' }], use: 'Restock alerts' },
];
