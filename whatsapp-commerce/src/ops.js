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

// ---------- background job health ----------
/*
 * Every background job runs through track(name, everyMs, fn): it records the last run, last success, the last error
 * and how many runs in a row failed. 3 failures in a row → alert (then again every 24). A job that hasn't started for
 * 3x its interval is "stale" (e.g. the timer died). Shown in System health and summarised by /health.
 */
const JOBS = new Map();
export async function track(name, everyMs, fn) {
  const j = JOBS.get(name) || { name, runs: 0, failures: 0, lastStart: null, lastOk: null, lastError: null, lastErrorAt: null, lastResult: null };
  JOBS.set(name, j);
  j.everyMs = everyMs;
  j.lastStart = Date.now();
  try {
    const r = await fn();
    j.runs++; j.failures = 0; j.lastOk = Date.now();
    j.lastResult = typeof r === 'number' ? r : r && typeof r === 'object' ? JSON.stringify(r).slice(0, 200) : null;
    return r;
  } catch (e) {
    j.failures++;
    j.lastError = String(e?.message || e).slice(0, 300);
    j.lastErrorAt = Date.now();
    console.error(`[job ${name}]`, j.lastError);
    if (j.failures === 3 || (j.failures > 3 && j.failures % 24 === 0)) alert(`Background job "${name}" failed ${j.failures} times in a row: ${j.lastError}`, { key: `job:${name}`, throttleMs: 0 });
    return undefined;
  }
}
export function jobHealth(now = Date.now()) {
  return [...JOBS.values()].map((j) => ({
    name: j.name, runs: j.runs, failures: j.failures, lastResult: j.lastResult, lastError: j.lastError,
    lastStart: j.lastStart && new Date(j.lastStart).toISOString(), lastOk: j.lastOk && new Date(j.lastOk).toISOString(), lastErrorAt: j.lastErrorAt && new Date(j.lastErrorAt).toISOString(),
    state: j.failures ? 'failing' : j.lastStart && now - j.lastStart > j.everyMs * 3 ? 'stale' : j.lastOk ? 'ok' : 'running',
  })).sort((a, b) => a.name.localeCompare(b.name));
}
export const _resetJobs = () => JOBS.clear(); // tests

// ---------- database integrity ----------
let lastIntegrity = null;
/** PRAGMA quick_check (read-only, fast). Anything but "ok" alerts the platform owner. */
export function integrityCheck() {
  const rows = getDb().prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]);
  const ok = rows.length === 1 && rows[0] === 'ok';
  lastIntegrity = { ok, at: new Date().toISOString(), detail: ok ? 'ok' : rows.slice(0, 5).join('; ').slice(0, 500) };
  if (!ok) alert(`Database integrity check failed: ${lastIntegrity.detail}`, { key: 'db-integrity' });
  return lastIntegrity;
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
// The dashboard's full policy runs in report-only mode first: violations are counted (POST /csp-report) and shown in
// System health. Once a few weeks pass with no unexpected reports, move it to the enforced header.
export const CSP_REPORT_ONLY = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://connect.facebook.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://*.facebook.com; frame-src https://*.facebook.com; media-src 'self' data: blob:; font-src 'self' data:; report-uri /csp-report";
const CSP_SEEN = new Map();
export function recordCspReport(body) {
  const r = body?.['csp-report'] || (Array.isArray(body) ? body[0]?.body : body?.body) || body || {};
  const dir = String(r['violated-directive'] || r.effectiveDirective || r['effective-directive'] || '?').slice(0, 60);
  const blocked = String(r['blocked-uri'] || r.blockedURL || '?').replace(/\?.*$/, '').slice(0, 120);
  const k = `${dir} ${blocked}`;
  if (!CSP_SEEN.has(k) && CSP_SEEN.size < 200) console.warn('[csp report-only]', k);
  CSP_SEEN.set(k, (CSP_SEEN.get(k) || 0) + 1);
}
export const cspReports = () => [...CSP_SEEN.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => ({ violation: k, count: n }));

export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  if (req.path.startsWith('/admin') || req.path.startsWith('/api')) res.set('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/admin')) {
    res.set('Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    res.set('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY);
  }
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
    offsiteBackup: (() => { try { return JSON.parse(getDb().prepare("SELECT value FROM kv WHERE key = 'backup:offsite'").get()?.value || 'null'); } catch { return null; } })(), // null = not set up yet
    jobs: jobHealth(),
    cspReports: cspReports(),
    integrity: lastIntegrity,
    emails: (() => { const rows = d.prepare("SELECT status, COUNT(*) AS n FROM email_log WHERE created_at > datetime('now', '-7 days') GROUP BY status").all(); return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])); })(),
    billingWebhook: d.prepare('SELECT type, received_at FROM billing_events ORDER BY received_at DESC LIMIT 1').get() || null,
    emailConfigured: !!(config.resendApiKey && config.emailFrom),
    alertsConfigured: !!config.alertWebhookUrl,
  };
}
