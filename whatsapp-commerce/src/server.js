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
import { securityHeaders, installCrashAlerts, alert, backup, jobHealth, recordCspReport } from './ops.js';
import { getDb } from './db.js';
import { loadPlatformSetup } from './platformSetup.js';
import { trackingRouter } from './tracking.js';
import { siteRouter } from './site.js';
import { helpRouter } from './help.js';
import { quotesRouter } from './quotes.js';
import { installJsonLogs, requestLog } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // Keep the raw body for Meta signature verification.
  app.use(express.json({ limit: '15mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.use(requestLog); // one JSON line per request when LOG_FORMAT=json (src/log.js); does nothing otherwise
  app.use(securityHeaders);
  app.post('/csp-report', rateLimit({ max: 60 }), express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '20kb' }), (req, res) => { recordCspReport(req.body); res.sendStatus(204); });
  app.get('/health', (req, res) => {
    try { getDb().prepare('SELECT 1').get(); const bad = jobHealth().filter((j) => j.state === 'failing' || j.state === 'stale').length; res.json({ ok: true, jobs: bad ? 'degraded' : 'ok' }); } catch (e) { res.status(503).json({ ok: false, error: 'database unavailable' }); }
  });
  app.use(customDomainMiddleware());
  app.use(trackingRouter()); // /go/:code – counted links to the shop's own website
  app.use(helpRouter());
  app.use(quotesRouter()); // /q/<token> – the customer's quote page and PDF // /help/<shop> – each business's public help centre
  app.use(siteRouter()); // public website: /, /pricing, /takeaways, /whatsapp-cost-calculator, /demo, sitemap, robots
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
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installJsonLogs(); // LOG_FORMAT=json → structured logs
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
  // …and an encrypted copy off the server when BACKUP_S3_* is set (src/offsite.js)
  const doBackup = () => {
    let b = null;
    try { b = backup(); if (b) console.log('[backup]', b.file); getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('backup:local', JSON.stringify({ ok: true, file: b?.file, at: new Date().toISOString() })); } catch (e) { alert(`Backup failed: ${e.message}`); try { getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('backup:local', JSON.stringify({ ok: false, error: e.message, at: new Date().toISOString() })); } catch {} }
    if (b) import('./offsite.js').then(({ uploadBackup }) => uploadBackup(b.file)).then((u) => {
      if (!u) return;
      console.log('[backup] off-server copy', u.key, u.bytes);
      getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('backup:offsite', JSON.stringify({ key: u.key, bytes: u.bytes, at: new Date().toISOString() }));
    }).catch((e) => alert(`Off-server backup failed: ${e.message}`, { key: 'offsite-backup' }));
  };
  setTimeout(doBackup, 30000).unref();
  setInterval(doBackup, 24 * 3600000).unref();
  const server = createApp().listen(config.port, () => console.log(`WhatsApp Commerce running on :${config.port} → ${config.publicUrl}/admin`));
  const shutdown = () => { console.log('Shutting down…'); server.close(() => { try { getDb().close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
