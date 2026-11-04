import { config } from './config.js';
import { getDb } from './db.js';
import { senderId } from './whatsapp/cloudApi.js';

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
  const d = await graph(tenant, 'GET', '/message_templates?fields=name,status,category,previous_category,language,components,rejected_reason&limit=200');
  const list = d.data || [];
  cacheTemplates(tenant.id, list);
  return list;
}

// Cache of the shop's templates (category + components) for cost estimates and campaign opt-out checks
export function cacheTemplates(tenantId, list) {
  const map = Object.fromEntries(list.map((t) => [t.name, { category: t.category, previous: t.previous_category || null, optOut: hasOptOut(t.components) }]));
  getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`tpl:${tenantId}`, JSON.stringify(map));
}
export function cachedTemplates(tenantId) {
  try { return JSON.parse(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(`tpl:${tenantId}`)?.value || '{}'); } catch { return {}; }
}

/** PECR: every marketing message needs a simple, free way to opt out. */
export function hasOptOut(components = []) {
  const body = components.find((c) => c.type === 'BODY')?.text || '';
  const footer = components.find((c) => c.type === 'FOOTER')?.text || '';
  const btns = components.find((c) => c.type === 'BUTTONS')?.buttons || [];
  return /\bSTOP\b/.test(body + ' ' + footer) || btns.some((b) => b.type === 'QUICK_REPLY' && /stop|unsubscribe|opt.?out/i.test(b.text || ''));
}

const PROMO = /(\d+\s?%|\boff\b|\bsale\b|discount|promo|offer|deal|\bfree\b|limited time|shop now|new arrivals?|back in stock|coupon|code\b)/i;

/** Warnings shown before submitting: Meta recategorises promotional "utility" templates as marketing (~3x the price in the UK). */
export function templateWarnings(t) {
  const w = [];
  if (String(t.category || '').toUpperCase() === 'UTILITY' && PROMO.test(`${t.header || ''} ${t.body || ''}`)) w.push('This looks promotional – Meta will likely recategorise it as MARKETING, which costs about 3x a utility message in the UK and needs marketing consent.');
  return w;
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
  // marketing templates always carry an opt-out button (PECR) unless the text already says "Reply STOP"
  if (String(category).toUpperCase() === 'MARKETING' && !/\bSTOP\b/.test(`${body} ${footer || ''}`) && !buttons.some((b) => /stop|unsubscribe|opt.?out/i.test(b?.text || ''))) buttons = [...buttons, { text: 'Stop offers' }];
  const btns = buttons.filter((b) => b?.text).slice(0, 10).map((b) => (b.url ? { type: 'URL', text: b.text, url: b.url, ...(/\{\{1\}\}/.test(b.url) ? { example: [b.url.replace('{{1}}', 'abc123')] } : {}) } : { type: 'QUICK_REPLY', text: b.text }));
  if (btns.length) components.push({ type: 'BUTTONS', buttons: btns });
  return { name, language, category: String(category).toUpperCase(), components };
}

/** One-click starter templates used by the automations in this product. */
export const TEMPLATE_LIBRARY = [
  { name: 'order_confirmation', category: 'UTILITY', body: 'Hi {{1}}, thanks for your order {{2}} at {{3}}! Total: {{4}}. We will message you when it ships.', examples: ['Jane', '#1001', 'RC Shopper', '£42.00'], use: 'Website orders (Shopify / WooCommerce)' },
  { name: 'shipping_update', category: 'UTILITY', body: 'Good news {{1}}! Your order {{2}} has shipped. Track it here: {{3}}', examples: ['Jane', '#1001', 'https://track.example/abc'], use: 'Website order shipped' },
  { name: 'abandoned_cart', category: 'MARKETING', body: 'Hi {{1}}, you left something in your basket at {{2}} 🛒 Complete your order here: {{3}}', examples: ['Jane', 'RC Shopper', 'https://shop.example/checkout/abc'], buttons: [{ text: 'Stop offers' }], use: 'Abandoned checkout recovery' },
  { name: 'order_update', category: 'UTILITY', body: 'Hi {{1}}, an update on your order {{2}}: it is now {{3}}. Reply here if you have any questions.', examples: ['Jane', '#1001', 'on its way 🚚'], use: 'Order status updates outside the 24h window' },
  { name: 'staff_alert', category: 'UTILITY', body: 'Team alert: {{1}}', examples: ['New WhatsApp order WA-12 from +447700900123 – £24.00'], use: 'New-order / handover alerts to your team' },
  { name: 'payment_reminder', category: 'UTILITY', body: 'Hi {{1}}, order {{2}} ({{3}}) is waiting for payment. Pay here: {{4}}', examples: ['Jane', 'WA-12', '£18.00', 'https://pay.example/abc'], use: 'Unpaid orders outside 24h' },
  { name: 'win_back', category: 'MARKETING', body: 'We miss you {{1}}! Here is {{2}} off your next order with code {{3}} 💚 Reply SHOP to browse.', examples: ['Jane', '10%', 'COMEBACK10'], buttons: [{ text: 'Shop now' }, { text: 'Stop offers' }], use: 'Win-back' },
  { name: 'weekend_offer', category: 'MARKETING', body: 'Hi {{1}}! This weekend only: {{2}}. Reply SHOP to order on WhatsApp.', examples: ['Jane', '20% off everything'], buttons: [{ text: 'Shop now' }, { text: 'Stop offers' }], use: 'Broadcast campaigns' },
  { name: 'back_in_stock', category: 'MARKETING', body: 'Hi {{1}}, {{2}} is back in stock! Reply SHOP to order before it sells out.', examples: ['Jane', 'Scented Candle'], buttons: [{ text: 'Shop now' }, { text: 'Stop offers' }], use: 'Restock alerts' },
];

// ---------- phone number health & business profile ----------
async function phoneGraph(tenant, method, path, body) {
  const { accessToken, phoneNumberId } = tenant.settings.whatsapp || {};
  if (!accessToken || !phoneNumberId) throw new Error('WhatsApp is not connected');
  const res = await fetch(`https://graph.facebook.com/${config.graphVersion}/${senderId(tenant.settings.whatsapp)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta: ${data.error?.error_user_msg || data.error?.message || res.status}`);
  return data;
}

/** Quality rating (GREEN/YELLOW/RED), messaging limit tier, display-name status, verified name. */
export const numberHealth = (tenant) => phoneGraph(tenant, 'GET', '?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,code_verification_status,platform_type,throughput,status');

export async function getBusinessProfile(tenant) {
  const d = await phoneGraph(tenant, 'GET', '/whatsapp_business_profile?fields=about,address,description,email,websites,vertical,profile_picture_url');
  return d.data?.[0] || {};
}

export function updateBusinessProfile(tenant, p) {
  const allowed = ['about', 'address', 'description', 'email', 'websites', 'vertical'];
  const body = { messaging_product: 'whatsapp', ...Object.fromEntries(Object.entries(p || {}).filter(([k, v]) => allowed.includes(k) && v !== undefined)) };
  if (body.about) body.about = String(body.about).slice(0, 139);
  if (body.websites && !Array.isArray(body.websites)) body.websites = String(body.websites).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 2);
  return phoneGraph(tenant, 'POST', '/whatsapp_business_profile', body);
}
