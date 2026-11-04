import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getDb } from './db.js';

// ---------- alerts (Slack / Discord / n8n webhook) ----------
const recent = new Map();
export async function alert(text, { key = text, throttleMs = 10 * 60000 } = {}) {
  console.error('[alert]', text);
  if (!config.alertWebhookUrl) return false;
  const last = recent.get(key);
  if (last && Date.now() - last < throttleMs) return false;
  recent.set(key, Date.now());
  const body = { text: `⚠️ WhatsApp Commerce: ${text}`, content: `⚠️ WhatsApp Commerce: ${text}` }; // Slack uses text, Discord uses content
  return fetch(config.alertWebhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }).then((r) => r.ok, () => false);
}

export function installCrashAlerts() {
  process.on('unhandledRejection', (e) => alert(`Unhandled rejection: ${e?.stack || e}`.slice(0, 1500), { key: String(e?.message || e) }));
  process.on('uncaughtException', (e) => {
    alert(`Uncaught exception: ${e?.stack || e}`.slice(0, 1500)).finally(() => process.exit(1));
  });
}

// ---------- backups (consistent SQLite snapshot via VACUUM INTO) ----------
export function backup({ dir = config.backupDir, keep = config.backupKeep } = {}) {
  if (config.databasePath === ':memory:') return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, `whatsapp-commerce-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = fs.readdirSync(dir).filter((f) => /^whatsapp-commerce-.*\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old), { force: true });
  return { file, size: fs.statSync(file).size, kept: Math.min(all.length, keep) };
}

export function listBackups(dir = config.backupDir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse().map((f) => ({ file: f, size: fs.statSync(path.join(dir, f)).size }));
}

// ---------- security headers ----------
export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/admin') || req.path.startsWith('/api')) res.set('X-Frame-Options', 'DENY');
  if (config.publicUrl.startsWith('https://')) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

export function systemStatus() {
  const d = getDb();
  const one = (sql) => Object.values(d.prepare(sql).get())[0];
  return {
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
    tenants: one('SELECT COUNT(*) FROM tenants'),
    activeTenants: one('SELECT COUNT(*) FROM tenants WHERE active = 1'),
    ordersToday: one("SELECT COUNT(*) FROM orders WHERE created_at > datetime('now', '-1 day')"),
    messagesToday: one("SELECT COUNT(*) FROM messages WHERE created_at > datetime('now', '-1 day')"),
    pendingJobs: one("SELECT COUNT(*) FROM scheduled WHERE done = 0"),
    overdueJobs: one("SELECT COUNT(*) FROM scheduled WHERE done = 0 AND run_at < datetime('now', '-10 minutes')"),
    deadLetters: one("SELECT COUNT(*) FROM messages WHERE direction = 'in' AND processed = -1"),
    backups: listBackups().slice(0, 5),
  };
}
