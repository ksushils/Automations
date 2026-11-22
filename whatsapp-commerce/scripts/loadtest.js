#!/usr/bin/env node
// Repeatable load test – runs the real app in this process on a throwaway in-memory database with a fake AI server,
// so it measures OUR code (routing, database, engine, knowledge search), not the AI provider or the network.
//   node --disable-warning=ExperimentalWarning scripts/loadtest.js [--businesses 20] [--chats 200] [--concurrency 20]
// Prints p50/p95/max latencies and throughput, plus memory. Never touches a live database or sends anything.
import http from 'node:http';
import crypto from 'node:crypto';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const BUSINESSES = arg('businesses', 20), CHATS = arg('chats', 200), CONC = arg('concurrency', 20), AI_MS = arg('ai-ms', 0);

process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY ||= 'loadtest-encryption-key-loadtest-encryption';
process.env.SUPER_ADMIN_KEY ||= 'loadtest-super-admin-key';
process.env.PUBLIC_URL = 'http://127.0.0.1';

// fake OpenAI-compatible AI (optional delay to mimic a real model)
const ai = http.createServer((req, res) => { req.resume(); req.on('end', () => setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A hygienist appointment is £45. Would you like to book?' } }], usage: { prompt_tokens: 400, completion_tokens: 30, total_tokens: 430 } })); }, AI_MS)); });
await new Promise((r) => ai.listen(0, r));
process.env.AI_BASE_URL = `http://127.0.0.1:${ai.address().port}/v1`;
process.env.AI_API_KEY = 'sk-loadtest';
process.env.EMBEDDINGS_MODEL = '';

const { initDb, getDb } = await import('../src/db.js');
initDb(':memory:');
const { createTenant, updateTenantSettings } = await import('../src/tenants.js');
const { addTextDoc } = await import('../src/knowledge.js');
const { createApp } = await import('../src/server.js');
const { retrieve } = await import('../src/ai/rag.js');

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10 : 0; };
const stats = (name, times, wallMs) => ({ test: name, requests: times.length, p50_ms: pct(times, 50), p95_ms: pct(times, 95), max_ms: Math.round(Math.max(0, ...times) * 10) / 10, per_sec: wallMs ? Math.round((times.length / wallMs) * 1000 * 10) / 10 : null });
async function pool(n, conc, fn) { const times = []; let i = 0; const t0 = performance.now(); await Promise.all(Array.from({ length: conc }, async () => { while (i < n) { const k = i++; const s = performance.now(); await fn(k); times.push(performance.now() - s); } })); return { times, wall: performance.now() - t0 }; }

// set up businesses with a knowledge base each
const ids = [];
const page = Array.from({ length: 40 }, (_, i) => `Treatment ${i}: description of service number ${i} with details about aftercare, timings and who it suits. Price £${20 + i}.`).join('\n');
for (let b = 0; b < BUSINESSES; b++) {
  const { tenant } = createTenant({ name: `Load Test ${b}`, plan: 'pro' });
  updateTenantSettings(tenant.id, { store: { type: 'none' }, webchat: { enabled: true }, followUps: { quietStart: 0, quietEnd: 0 } });
  addTextDoc(tenant.id, { name: 'Price list', text: `Hygienist appointment £45. Check-up £30.\n${page}` });
  ids.push(tenant.id);
}
await new Promise((r) => setTimeout(r, 300));
const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const results = [];

// 1. widget script
let r = await pool(CHATS, CONC, (k) => fetch(`${base}/widget/${ids[k % ids.length]}.js`).then((x) => x.text()));
results.push(stats('Website widget script (GET /widget/:id.js)', r.times, r.wall));
// 2. health
r = await pool(CHATS, CONC, () => fetch(`${base}/health`).then((x) => x.json()));
results.push(stats('Health check (GET /health)', r.times, r.wall));
// 3. knowledge retrieval (direct)
r = await pool(CHATS, CONC, (k) => retrieve(ids[k % ids.length], `how much is treatment ${k % 40}?`, { k: 6 }));
results.push(stats('Knowledge search (retrieve, FTS5)', r.times, r.wall));
// 4. website chat message → AI reply (fake AI), many visitors across businesses at once
r = await pool(CHATS, CONC, (k) => fetch(`${base}/chat/${ids[k % ids.length]}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'loadtest' + crypto.randomBytes(9).toString('hex'), text: 'How much is a hygienist appointment?' }) }).then((x) => x.json()));
results.push(stats(`Website chat message → reply (fake AI${AI_MS ? ` +${AI_MS} ms` : ''})`, r.times, r.wall));
// 5. database: a typical dashboard read
r = await pool(CHATS, CONC, (k) => Promise.resolve(getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND created_at > datetime('now', '-30 days')").get(ids[k % ids.length])));
results.push(stats('Database read (messages count per business)', r.times, r.wall));

const mem = process.memoryUsage();
console.log(`\nLoad test – ${BUSINESSES} businesses, ${CHATS} requests per test, ${CONC} at a time, Node ${process.version}, ${new Date().toISOString()}`);
console.table(results);
console.log(`Memory: rss ${Math.round(mem.rss / 1048576)} MB, heap ${Math.round(mem.heapUsed / 1048576)} MB · messages stored: ${getDb().prepare('SELECT COUNT(*) AS n FROM messages').get().n}`);
console.log('Note: in-memory database and a fake AI – real replies add the AI provider\'s time (typically 1–4 s). Not a claim about maximum capacity.');
server.close(); ai.close();
process.exit(0);
