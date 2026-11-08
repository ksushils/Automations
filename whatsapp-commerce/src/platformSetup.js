import { config } from './config.js';
import { getDb } from './db.js';
import { encrypt, decrypt, randomToken } from './crypto.js';
import { PLANS } from './tenants.js';

/*
 * Platform setup saved from the dashboard (super admin → Setup), so nobody has to edit .env.
 * Values are stored encrypted in the kv table and applied on top of the .env values at start-up and on save.
 * A value saved here wins over .env; clearing it here falls back to .env again.
 */
const KV_KEY = 'platform_setup';

// field -> how it maps onto config / env. `secret` fields are never sent back to the browser.
export const SETUP_FIELDS = {
  aiApiKey: { secret: true, apply: (v) => { config.aiApiKey = v; if (!process.env.EMBEDDINGS_API_KEY) config.embeddingsApiKey = v; } },
  aiModel: { apply: (v) => { config.aiModel = v; } },
  platformStripeSecret: { secret: true, apply: (v) => { config.platformStripeSecret = v; } },
  platformStripeWebhookSecret: { secret: true, apply: (v) => { config.platformStripeWebhookSecret = v; } },
  stripePriceStarter: { apply: (v) => { config.stripePrices.starter = v; } },
  stripePriceGrowth: { apply: (v) => { config.stripePrices.growth = v; } },
  stripePricePro: { apply: (v) => { config.stripePrices.pro = v; } },
  metaAppId: { apply: (v) => { config.metaAppId = v; } },
  metaAppSecret: { secret: true, apply: (v) => { config.metaAppSecret = v; } },
  metaConfigId: { apply: (v) => { config.metaConfigId = v; } },
  metaWebhookVerifyToken: { apply: (v) => { config.metaWebhookVerifyToken = v; } },
  productName: { apply: (v) => { config.productName = v; process.env.PRODUCT_NAME = v; } },
  supportEmail: { apply: (v) => { config.supportEmail = v; } },
  legalCompanyName: { apply: (v) => { process.env.LEGAL_COMPANY_NAME = v; } },
  legalCompanyNumber: { apply: (v) => { process.env.LEGAL_COMPANY_NUMBER = v; } },
  legalAddress: { apply: (v) => { process.env.LEGAL_ADDRESS = v; } },
  legalContactEmail: { apply: (v) => { process.env.LEGAL_CONTACT_EMAIL = v; } },
  alertWebhookUrl: { apply: (v) => { config.alertWebhookUrl = v; } },
  contactPhone: { apply: (v) => { config.contactPhone = v; } },
  demoUrl: { apply: (v) => { config.demoUrl = v; } },
  siteChatTenant: { apply: (v) => { config.siteChatTenant = v; } },
  resendApiKey: { secret: true, apply: (v) => { config.resendApiKey = v; } },
  emailFrom: { apply: (v) => { config.emailFrom = v; } },
};

// What .env had at start-up, so clearing a dashboard value restores it.
const envValue = () => ({
  aiApiKey: config.aiApiKey, aiModel: config.aiModel,
  platformStripeSecret: config.platformStripeSecret, platformStripeWebhookSecret: config.platformStripeWebhookSecret,
  stripePriceStarter: config.stripePrices.starter, stripePriceGrowth: config.stripePrices.growth, stripePricePro: config.stripePrices.pro,
  metaAppId: config.metaAppId, metaAppSecret: config.metaAppSecret, metaConfigId: config.metaConfigId, metaWebhookVerifyToken: config.metaWebhookVerifyToken,
  productName: config.productName, supportEmail: config.supportEmail,
  legalCompanyName: process.env.LEGAL_COMPANY_NAME || '', legalCompanyNumber: process.env.LEGAL_COMPANY_NUMBER || '',
  legalAddress: process.env.LEGAL_ADDRESS || '', legalContactEmail: process.env.LEGAL_CONTACT_EMAIL || '',
  alertWebhookUrl: config.alertWebhookUrl,
  resendApiKey: config.resendApiKey, emailFrom: config.emailFrom,
  contactPhone: config.contactPhone, demoUrl: config.demoUrl, siteChatTenant: config.siteChatTenant,
});
let fromEnv = null;

function readSaved() {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(KV_KEY);
  if (!row) return {};
  try { return JSON.parse(decrypt(row.value)) || {}; } catch (e) { console.warn('[setup] could not read saved platform setup:', e.message); return {}; }
}

function writeSaved(obj) {
  getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KV_KEY, encrypt(JSON.stringify(obj)));
}

/** Apply saved values over .env. Call once after initDb(). */
export function loadPlatformSetup() {
  fromEnv ||= envValue();
  const saved = readSaved();
  for (const [k, f] of Object.entries(SETUP_FIELDS)) f.apply(saved[k] || fromEnv[k] || '');
  // The webhook verify token is needed before anyone can configure Meta, so make one up once.
  if (!config.metaWebhookVerifyToken) {
    const token = randomToken(18);
    writeSaved({ ...saved, metaWebhookVerifyToken: token });
    SETUP_FIELDS.metaWebhookVerifyToken.apply(token);
  }
}

/** Save some fields. Empty string clears a dashboard value (falls back to .env). Unknown keys are ignored. */
export function savePlatformSetup(patch = {}) {
  fromEnv ||= envValue();
  const saved = readSaved();
  for (const [k, v] of Object.entries(patch)) {
    if (!SETUP_FIELDS[k] || typeof v !== 'string') continue;
    const val = v.trim().slice(0, 2000);
    if (val) saved[k] = val; else delete saved[k];
    if (k === 'aiApiKey' || k === 'aiModel') setAiCheck(null); // new key or model: test it again
    SETUP_FIELDS[k].apply(saved[k] || fromEnv[k] || '');
  }
  writeSaved(saved);
  return setupStatus();
}

// Result of the last "test the AI" (null = not tested since the key changed).
const AI_CHECK = 'platform_setup_ai_ok';
function setAiCheck(ok) {
  if (ok === null) getDb().prepare('DELETE FROM kv WHERE key = ?').run(AI_CHECK);
  else getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(AI_CHECK, ok ? '1' : '0');
}
const aiCheck = () => getDb().prepare('SELECT value FROM kv WHERE key = ?').get(AI_CHECK)?.value ?? null;

const mask = (v) => (v ? (v.length > 10 ? v.slice(0, 7) + '…' + v.slice(-4) : '••••') : '');

/** Everything the setup screen needs. Secrets come back masked. */
export function setupStatus() {
  const cur = {};
  for (const [k, f] of Object.entries(SETUP_FIELDS)) {
    const v = (k === 'stripePriceStarter' ? config.stripePrices.starter : k === 'stripePriceGrowth' ? config.stripePrices.growth : k === 'stripePricePro' ? config.stripePrices.pro
      : k.startsWith('legal') ? process.env['LEGAL_' + k.slice(5).replace(/[A-Z]/g, (c) => '_' + c).slice(1).toUpperCase()] : config[k]) || '';
    cur[k] = f.secret ? mask(v) : v;
  }
  const prices = !!(config.stripePrices.starter && config.stripePrices.growth && config.stripePrices.pro);
  const steps = {
    ai: !!config.aiApiKey && aiCheck() !== '0',
    payments: !!(config.platformStripeSecret && config.platformStripeWebhookSecret && prices),
    whatsapp: !!(config.metaAppId && config.metaAppSecret && config.metaConfigId),
    business: !!(process.env.LEGAL_COMPANY_NAME && config.supportEmail),
    email: !!(config.resendApiKey && config.emailFrom),
  };
  return {
    values: cur,
    steps,
    aiCheck: aiCheck(),
    done: Object.values(steps).filter(Boolean).length,
    total: Object.keys(steps).length,
    stripeMode: /^(sk|rk)_live_/.test(config.platformStripeSecret) ? 'live' : config.platformStripeSecret ? 'test' : null,
    urls: {
      publicUrl: config.publicUrl,
      whatsappWebhook: `${config.publicUrl}/webhooks/whatsapp`,
      stripeWebhook: `${config.publicUrl}/webhooks/platform-stripe`,
      privacy: `${config.publicUrl}/legal/privacy`,
      terms: `${config.publicUrl}/legal/terms`,
      domain: config.publicUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    },
  };
}

/** Check the AI key really works. */
export async function testAi() {
  if (!config.aiApiKey) return { ok: false, error: 'No AI key saved yet' };
  try {
    const res = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.aiApiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': config.publicUrl, 'X-Title': config.productName },
      body: JSON.stringify({ model: config.aiModel, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { if ([401, 402, 403].includes(res.status)) setAiCheck(false); return { ok: false, error: data.error?.message || `AI provider said ${res.status}` }; }
    setAiCheck(true);
    return { ok: true, reply: data.choices?.[0]?.message?.content?.trim() || '', model: data.model || config.aiModel };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- Stripe: create the plans and the webhook for you ----------
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(method, path, body, query, key = config.platformStripeSecret) {
  const qs = query ? '?' + form(query).toString() : '';
  const res = await fetch(`https://api.stripe.com/v1${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? form(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Stripe said ${res.status}`);
  return data;
}

export const STRIPE_EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];

/**
 * One click: make sure the 3 monthly plans and the webhook exist in the Stripe account whose key is saved.
 * Safe to run again – existing plans (found by lookup key) are reused.
 */
export async function autoSetupStripe() {
  if (!config.platformStripeSecret) throw new Error('Paste your Stripe secret key first');
  const done = [];
  const patch = {};
  const fieldFor = { starter: 'stripePriceStarter', growth: 'stripePriceGrowth', pro: 'stripePricePro' };
  for (const plan of ['starter', 'growth', 'pro']) {
    const p = PLANS[plan];
    const lookup = `wc_${plan}_monthly_gbp_${p.priceGbp}`;
    const found = await stripe('GET', '/prices', null, { lookup_keys: [lookup], active: true, limit: 1 });
    let price = found.data?.[0];
    if (!price) {
      price = await stripe('POST', '/prices', {
        currency: 'gbp', unit_amount: Math.round(p.priceGbp * 100), recurring: { interval: 'month' }, lookup_key: lookup,
        product_data: { name: `${config.productName} ${p.label}` }, metadata: { plan },
      });
      done.push(`Created the ${p.label} plan (£${p.priceGbp}/month)`);
    } else done.push(`${p.label} plan already existed`);
    patch[fieldFor[plan]] = price.id;
  }
  const url = `${config.publicUrl}/webhooks/platform-stripe`;
  if (!/^https:\/\//.test(url)) throw new Error('This server needs a public https:// address before Stripe can send it updates');
  const hooks = await stripe('GET', '/webhook_endpoints', null, { limit: 100 });
  const existing = (hooks.data || []).filter((h) => h.url === url);
  if (existing.length && config.platformStripeWebhookSecret) done.push('Webhook already existed');
  else {
    // A webhook's signing secret is only shown when it's created, so replace any old one we don't have the secret for.
    for (const h of existing) await stripe('DELETE', `/webhook_endpoints/${h.id}`);
    const hook = await stripe('POST', '/webhook_endpoints', { url, enabled_events: STRIPE_EVENTS, description: `${config.productName} subscriptions` });
    patch.platformStripeWebhookSecret = hook.secret;
    done.push('Created the webhook so Stripe tells us when shops pay or cancel');
  }
  return { done, status: savePlatformSetup(patch) };
}
