import { getDb, json } from './db.js';
import { getTenant, listTenants } from './tenants.js';
import { handleInbound } from './bot/engine.js';
import { chatCompletion, directConfigured } from './ai/direct.js';
import { retrieve } from './ai/rag.js';
import { searchKnowledge } from './knowledge.js';

/*
 * Automatic answer check: replay real customer questions through the shop's assistant (nothing is sent to anyone)
 * and have a second AI pass mark each answer against the shop's own information. Runs weekly per shop, on demand
 * from the AI tab, and as a gate after each deploy (scripts/quality-gate.mjs), so an update can't quietly make
 * the bot worse.
 */
const QA = 'qa:';
const running = new Set();
const GENERIC = ['Do you deliver to Leeds and how much is it?', 'What is your returns policy?', 'What are your opening hours?', 'How can I contact you?', 'How do I place an order?'];
const COMMAND = /^(hi|hello|hey|menu|human|agent|cart|checkout|book|yes|no|ok|thanks?|thank you|stop|start)\b/i;

/** Questions to check: the shop's own list, else its real customers' recent questions (most asked first). */
export function questionsFor(tenant, limit = 20) {
  const own = (tenant.settings.quality?.questions || []).map(String).filter((q) => q.trim().length > 3);
  if (own.length) return own.slice(0, limit);
  const rows = getDb().prepare(`SELECT json_extract(body, '$.text') AS q, COUNT(*) AS n, MAX(id) AS last FROM messages
    WHERE tenant_id = ? AND direction = 'in' AND wa_id NOT LIKE 'qa:%' AND COALESCE(json_extract(body, '$.simulated'), 0) = 0 AND type = 'text'
      AND created_at > datetime('now', '-60 days') GROUP BY lower(json_extract(body, '$.text')) ORDER BY n DESC, last DESC LIMIT 400`).all(tenant.id);
  const real = rows.map((r) => String(r.q || '').trim()).filter((q) => q.length >= 10 && q.length <= 200 && !COMMAND.test(q) && !/^\[|\[order:|\[ref:/.test(q) && (/\?/.test(q) || /^(do|does|can|could|is|are|what|when|where|how|which|who|will|have|any)\b/i.test(q)));
  const out = [...new Set(real)].slice(0, limit);
  for (const g of GENERIC) if (out.length < Math.min(8, limit)) out.push(g);
  return out;
}

async function judge(tenant, question, answer) {
  const kb = await retrieve(tenant.id, question, { k: 4 }).catch(() => []);
  const info = (kb.length ? kb : searchKnowledge(tenant.id, question, { limit: 3 })).map((c, i) => `[${i + 1}] ${String(c.text).slice(0, 1200)}`).join('\n\n') || '(no matching shop information)';
  const r = await chatCompletion({
    temperature: 0, maxTokens: 160,
    messages: [{ role: 'user', content: `You check a shop assistant's reply to a customer.\n\nShop information (the only facts the assistant may use):\n${info}\n\nCustomer: ${question}\nAssistant: ${answer || '(no reply)'}\n\nScore the reply 1–5: 5 = answers the question correctly and helpfully using the shop information (or honestly offers a person when the information really doesn't say); 3 = vague, partly answers, or misses a fact that IS in the information; 1 = wrong, made up, contradicts the information, or no useful reply. Reply with JSON only: {"score": 1-5, "reason": "max 15 words"}` }],
  });
  const raw = String(r.choices?.[0]?.message?.content || '');
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const score = Math.max(1, Math.min(5, Math.round(Number(j.score) || 1)));
    return { score, reason: String(j.reason || '').slice(0, 200) };
  } catch { return { score: 3, reason: 'could not grade' }; }
}

function cleanup(tenantId) {
  const d = getDb();
  for (const table of ['messages', 'conversations', 'customers', 'unanswered', 'link_clicks']) d.prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND wa_id LIKE 'qa:%'`).run(tenantId);
}

export const qualityRunning = (tenantId) => running.has(tenantId);

/** Run the check for one shop. Returns the saved run. */
export async function runQualityCheck(tenantId, { questions, limit = 20 } = {}) {
  if (running.has(tenantId)) throw Object.assign(new Error('An answer check is already running'), { status: 409 });
  const tenant = getTenant(tenantId);
  if (!tenant) throw new Error('shop not found');
  if (!directConfigured()) throw new Error('The AI is not connected');
  running.add(tenantId);
  const stamp = Date.now().toString(36);
  try {
    const qs = (questions || questionsFor(tenant, limit)).slice(0, limit);
    const results = [];
    for (let i = 0; i < qs.length; i++) {
      const waId = `${QA}${stamp}:${i}`;
      const sink = [];
      await handleInbound(getTenant(tenantId), { waId, kind: 'text', text: qs[i], profileName: 'Answer check' }, async (to, m) => { if (to === waId) sink.push(m); });
      const answer = sink.map((m) => String(m.text || m.caption || '').replace(/^🤖 _[^\n]*automated assistant[^\n]*_\s*/u, '').trim()).filter(Boolean).join('\n').trim()
        + (sink.some((m) => m.type === 'list' && m.sections?.[0]?.rows?.length) ? `\n[shows products: ${sink.find((m) => m.type === 'list').sections[0].rows.slice(0, 5).map((r) => r.title).join(', ')}]` : '');
      const g = await judge(tenant, qs[i], answer).catch((e) => ({ score: 3, reason: `not graded: ${e.message}` }));
      results.push({ question: qs[i], answer: answer.slice(0, 1200), ...g, verdict: g.score >= 4 ? 'good' : g.score === 3 ? 'weak' : 'wrong' });
    }
    const good = results.filter((r) => r.verdict === 'good').length;
    const weak = results.filter((r) => r.verdict === 'weak').length;
    const wrong = results.filter((r) => r.verdict === 'wrong').length;
    const score = results.length ? Math.round((results.reduce((s, r) => s + (r.score - 1) / 4, 0) / results.length) * 100) : 0;
    const id = Number(getDb().prepare('INSERT INTO quality_runs (tenant_id, score, good, weak, wrong, results) VALUES (?, ?, ?, ?, ?, ?)').run(tenantId, score, good, weak, wrong, JSON.stringify(results)).lastInsertRowid);
    return lastQuality(tenantId, id);
  } finally {
    cleanup(tenantId);
    running.delete(tenantId);
  }
}

export function lastQuality(tenantId, id) {
  const r = id ? getDb().prepare('SELECT * FROM quality_runs WHERE id = ?').get(id) : getDb().prepare('SELECT * FROM quality_runs WHERE tenant_id = ? ORDER BY id DESC LIMIT 1').get(tenantId);
  if (!r) return null;
  const prev = getDb().prepare('SELECT score FROM quality_runs WHERE tenant_id = ? AND id < ? ORDER BY id DESC LIMIT 1').get(tenantId, r.id);
  return { id: r.id, at: r.created_at, score: r.score, good: r.good, weak: r.weak, wrong: r.wrong, previousScore: prev?.score ?? null, results: json(r.results, []) };
}

/** Hourly: the most overdue shop (weekly) gets its check. */
export async function runWeeklyQuality(now = Date.now()) {
  if (!directConfigured()) return null;
  const due = listTenants()
    .filter((t) => t.active && !t.settings.demo?.expiresAt && t.settings.quality?.weekly !== false && t.settings.ai?.enabled !== false)
    .filter((t) => getDb().prepare("SELECT 1 FROM knowledge_docs WHERE tenant_id = ? AND status != 'deleted' LIMIT 1").get(t.id))
    .map((t) => ({ t, last: Date.parse((lastQuality(t.id)?.at || '').replace(' ', 'T') + 'Z') || 0 }))
    .filter((x) => now - x.last >= 7 * 86400000)
    .sort((a, b) => a.last - b.last);
  if (!due.length) return null;
  return runQualityCheck(due[0].t.id, { limit: 15 });
}
