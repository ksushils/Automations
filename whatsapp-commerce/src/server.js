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
import { webRouter } from './routes/web.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // Keep the raw body for Meta signature verification.
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use(customDomainMiddleware());
  app.use(publicRouter());
  app.use(webRouter());
  app.use('/webhooks/whatsapp', whatsappRouter());
  app.use('/webhooks/store', storeWebhookRouter());
  app.use('/tools', toolsRouter());
  app.use('/api', adminRouter());
  // Serve the Dify custom-tool schema with this deployment's URL filled in – paste this URL into Dify.
  app.get('/dify/store-tools.openapi.json', (req, res) => {
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dify', 'store-tools.openapi.json'), 'utf8'));
    spec.servers = [{ url: `${config.publicUrl}/tools` }];
    res.json(spec);
  });
  app.use('/admin', express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (req, res) => res.redirect('/admin'));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = assertProductionConfig();
  if (problems.length) {
    console.warn('⚠️  Configuration warnings:\n - ' + problems.join('\n - '));
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }
  initDb();
  startJobs();
  createApp().listen(config.port, () => console.log(`WhatsApp Commerce running on :${config.port} → ${config.publicUrl}/admin`));
}
