import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertProductionConfig } from './config.js';
import { initDb } from './db.js';
import { whatsappRouter } from './whatsapp/webhook.js';
import { toolsRouter } from './routes/tools.js';
import { adminRouter } from './routes/admin.js';
import { storeWebhookRouter } from './routes/storeWebhooks.js';
import { startJobs } from './jobs.js';
import { publicRouter, customDomainMiddleware } from './routes/public.js';
import { webRouter, rateLimit } from './routes/web.js';
import { webchatRouter } from './routes/webchat.js';
import { securityHeaders, installCrashAlerts, alert, backup } from './ops.js';
import { getDb } from './db.js';
import { loadPlatformSetup } from './platformSetup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // Keep the raw body for Meta signature verification.
  app.use(express.json({ limit: '15mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.use(securityHeaders);
  app.get('/health', (req, res) => {
    try { getDb().prepare('SELECT 1').get(); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
  });
  app.use(customDomainMiddleware());
  app.use(publicRouter());
  app.use(webRouter());
  app.use(webchatRouter());
  app.use('/webhooks/whatsapp', whatsappRouter());
  app.use('/webhooks/store', storeWebhookRouter());
  app.use('/tools', toolsRouter());
  app.use('/api', rateLimit({ max: 600, windowMs: 60000 }), adminRouter());
  // Serve the Dify custom-tool schema with this deployment's URL filled in – paste this URL into Dify.
  app.get('/dify/store-tools.openapi.json', (req, res) => {
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dify', 'store-tools.openapi.json'), 'utf8'));
    spec.servers = [{ url: `${config.publicUrl}/tools` }];
    res.json(spec);
  });
  app.use('/admin', express.static(path.join(__dirname, '..', 'public')));
  app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'signup.html')));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'home.html')));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = assertProductionConfig();
  if (problems.length) {
    console.warn('⚠️  Configuration warnings:\n - ' + problems.join('\n - '));
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }
  initDb();
  loadPlatformSetup();
  installCrashAlerts();
  startJobs();
  // build the local knowledge index for documents added before it existed
  import('./ai/rag.js').then(async ({ reindexTenant }) => { for (const r of getDb().prepare('SELECT id FROM tenants').all()) await reindexTenant(r.id).catch(() => {}); });
  // daily backup (and one at start-up)
  const doBackup = () => { try { const b = backup(); if (b) console.log('[backup]', b.file); } catch (e) { alert(`Backup failed: ${e.message}`); } };
  setTimeout(doBackup, 30000).unref();
  setInterval(doBackup, 24 * 3600000).unref();
  const server = createApp().listen(config.port, () => console.log(`WhatsApp Commerce running on :${config.port} → ${config.publicUrl}/admin`));
  const shutdown = () => { console.log('Shutting down…'); server.close(() => { try { getDb().close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
