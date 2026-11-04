import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dependency). Existing env vars win.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  databasePath: env.DATABASE_PATH || './data/whatsapp-commerce.db',
  encryptionKey: env.ENCRYPTION_KEY || '',
  superAdminKey: env.SUPER_ADMIN_KEY || '',
  difyBaseUrl: (env.DIFY_BASE_URL || 'https://dify.rcshopper.com/v1').replace(/\/$/, ''),
  graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v21.0',
  shopifyApiVersion: env.SHOPIFY_API_VERSION || '2025-07',
};

export function assertProductionConfig() {
  const problems = [];
  if (config.encryptionKey.length < 32) problems.push('ENCRYPTION_KEY must be at least 32 characters');
  if (config.superAdminKey.length < 16) problems.push('SUPER_ADMIN_KEY must be at least 16 characters');
  return problems;
}

// Dify console access – lets this service create/update chatbot apps in your Dify automatically.
Object.assign(config, {
  difyConsoleUrl: (env.DIFY_CONSOLE_URL || config.difyBaseUrl.replace(/\/v1$/, '')).replace(/\/$/, ''),
  difyAdminApiKey: env.DIFY_ADMIN_API_KEY || '',
  difyWorkspaceId: env.DIFY_WORKSPACE_ID || '',
  difyConsoleEmail: env.DIFY_CONSOLE_EMAIL || '',
  difyConsolePassword: env.DIFY_CONSOLE_PASSWORD || '',
  difyDefaultModel: env.DIFY_DEFAULT_MODEL || '', // optional "provider|model", e.g. "langgenius/openai/openai|gpt-4o-mini"
});

// SaaS: self-serve sign-up, your own subscription billing (Stripe Billing), Meta Embedded Signup
Object.assign(config, {
  signupEnabled: env.SIGNUP_ENABLED !== 'false',
  trialDays: Number(env.TRIAL_DAYS || 14),
  platformStripeSecret: env.PLATFORM_STRIPE_SECRET_KEY || '',
  platformStripeWebhookSecret: env.PLATFORM_STRIPE_WEBHOOK_SECRET || '',
  stripePrices: { starter: env.STRIPE_PRICE_STARTER || '', growth: env.STRIPE_PRICE_GROWTH || '', pro: env.STRIPE_PRICE_PRO || '' },
  metaAppId: env.META_APP_ID || '',
  metaAppSecret: env.META_APP_SECRET || '',
  metaConfigId: env.META_CONFIG_ID || '', // WhatsApp Embedded Signup configuration ID (Meta app → Facebook Login for Business → Configurations)
  metaWebhookVerifyToken: env.META_WEBHOOK_VERIFY_TOKEN || '',
  alertWebhookUrl: env.ALERT_WEBHOOK_URL || '', // errors are POSTed here (Slack/Discord/n8n)
  backupDir: env.BACKUP_DIR || './data/backups',
  backupKeep: Number(env.BACKUP_KEEP || 14),
  stripeAutomaticTax: env.STRIPE_AUTOMATIC_TAX === 'true', // UK VAT etc. via Stripe Tax (enable Stripe Tax in your dashboard first)
  productName: env.PRODUCT_NAME || 'WhatsApp Commerce',
  supportEmail: env.SUPPORT_EMAIL || env.LEGAL_CONTACT_EMAIL || '',
});

Object.assign(config, {
  difyDatasetApiKey: env.DIFY_DATASET_API_KEY || '', // optional – otherwise created automatically via the console API
  allowPrivateFetch: env.ALLOW_PRIVATE_FETCH === 'true', // tests / internal networks only
});

// Direct AI mode – any OpenAI-compatible API (OpenRouter by default), no Dify needed
Object.assign(config, {
  aiBaseUrl: (env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
  aiApiKey: env.AI_API_KEY || '',
  aiModel: env.AI_MODEL || 'openai/gpt-4o-mini',
  // OpenRouter routing: only these providers (comma list, e.g. "openai,anthropic") and no data retention / training
  aiProviderOrder: (env.AI_PROVIDER_ORDER || '').split(',').map((s) => s.trim()).filter(Boolean),
  aiZeroRetention: env.AI_ZERO_RETENTION !== 'false',
  embeddingsBaseUrl: (env.EMBEDDINGS_BASE_URL || env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
  embeddingsApiKey: env.EMBEDDINGS_API_KEY || env.AI_API_KEY || '',
  embeddingsModel: env.EMBEDDINGS_MODEL || '', // e.g. text-embedding-3-small – empty = keyword (FTS) search only
  // Fallback prices (USD per million tokens) when the provider doesn't report cost (OpenRouter does)
  // Dify's licence forbids running it as a multi-tenant service without written permission.
  // Only set DIFY_LICENSED=true if you hold that permission; otherwise Dify is limited to shops you mark difyAllowed.
  difyLicensed: env.DIFY_LICENSED === 'true',
  aiPriceInPerMTok: Number(env.AI_PRICE_INPUT_PER_MTOK || 0.15),
  aiPriceOutPerMTok: Number(env.AI_PRICE_OUTPUT_PER_MTOK || 0.6),
});
