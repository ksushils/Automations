import crypto from 'node:crypto';
import util from 'node:util';

/*
 * Structured logs (opt-in): set LOG_FORMAT=json and every console line becomes one JSON object per line
 *   {"time":"…","level":"info|warn|error|debug","tag":"backup","msg":"…"}
 * plus one line per HTTP request {"type":"request","method","path","status","ms","id"} (not /health).
 * Without the flag nothing changes – the plain console output stays exactly as it was.
 * Secrets never reach the log: API keys, bearer tokens, Meta access tokens and Stripe secrets are masked, and long
 * token-like path segments (demo, quote and help links) are replaced with ":token". Query strings are never logged.
 */
const SECRET_PATTERNS = [
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, '$1_$2_***'],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, 'whsec_***'],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-***'],
  [/\bEAA[A-Za-z0-9]{20,}/g, 'EAA***'],
  [/\b(re|xox[bap])_[A-Za-z0-9_-]{12,}/g, '$1_***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/((?:access_?token|api_?key|secret|password|authorization)["'=:\s]+)["']?[^"'\s,}&]{6,}/gi, '$1***'],
];
export function redact(s) {
  let out = String(s);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}
export function safePath(url) {
  const p = String(url || '').split('?')[0];
  return p.split('/').map((seg) => (seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg) ? ':token' : seg)).join('/');
}

const LEVEL = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
let installed = null;
let reqWrite = null;

export function jsonLine(level, args) {
  const parts = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: Infinity })));
  let msg = parts.join(' ');
  let tag;
  const m = /^\[([\w:.-]{1,40})\]\s*/.exec(msg);
  if (m) { tag = m[1]; msg = msg.slice(m[0].length); }
  const o = { time: new Date().toISOString(), level };
  if (tag) o.tag = tag;
  o.msg = redact(msg);
  return JSON.stringify(o);
}

/** Switch console output to JSON lines when LOG_FORMAT=json (or force=true). Returns true when installed. */
export function installJsonLogs({ force = false, write } = {}) {
  if (!force && String(process.env.LOG_FORMAT || '').toLowerCase() !== 'json') return false;
  if (installed) return true;
  installed = {};
  reqWrite = write || ((line) => process.stdout.write(line + '\n'));
  for (const k of Object.keys(LEVEL)) {
    installed[k] = console[k];
    const out = write || ((line) => (k === 'error' || k === 'warn' ? process.stderr : process.stdout).write(line + '\n'));
    console[k] = (...args) => { try { out(jsonLine(LEVEL[k], args)); } catch { installed[k](...args); } };
  }
  return true;
}
export function uninstallJsonLogs() {
  if (!installed) return;
  for (const [k, f] of Object.entries(installed)) console[k] = f;
  installed = null;
  reqWrite = null;
}
export const jsonLogsOn = () => !!installed;

/** Express middleware: one JSON line per request (only while JSON logs are on). Adds an X-Request-Id header. */
export function requestLog(req, res, next) {
  if (!installed) return next();
  const id = String(req.get('x-request-id') || '').replace(/[^\w-]/g, '').slice(0, 64) || crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', id);
  if (req.path === '/health') return next();
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10;
    const line = { time: new Date().toISOString(), level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', type: 'request', id, method: req.method, path: safePath(req.originalUrl), status: res.statusCode, ms };
    try { (reqWrite || ((l) => process.stdout.write(l + '\n')))(JSON.stringify(line)); } catch {}
  });
  next();
}
