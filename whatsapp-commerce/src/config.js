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
