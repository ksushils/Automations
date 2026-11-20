import { config } from '../config.js';
import { getDb } from '../db.js';

/*
 * Local retrieval for direct AI mode: documents are split into chunks, indexed with SQLite FTS5
 * (porter stemming, BM25) and – when an embeddings model is configured – with vectors for semantic search.
 * Both rankings are merged with reciprocal-rank fusion.
 */

export function chunkText(text, { size = 900, overlap = 150 } = {}) {
  const paras = String(text || '').replace(/\r/g, '').split(/\n\s*\n|\n(?=[A-Z0-9#•\-])/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 1 > size) {
      chunks.push(cur);
      cur = cur.slice(-overlap).replace(/^\S*\s/, '') + '\n' + p;
    } else cur = cur ? `${cur}\n${p}` : p;
    while (cur.length > size * 1.5) { chunks.push(cur.slice(0, size)); cur = cur.slice(size - overlap); }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.map((c) => c.trim()).filter((c) => c.length > 20);
}

// ---------- embeddings (optional) ----------
export const embeddingsEnabled = () => !!(config.embeddingsModel && config.embeddingsApiKey);

export async function embed(texts) {
  const res = await fetch(`${config.embeddingsBaseUrl}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.embeddingsApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.embeddingsModel, input: texts }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${data.error?.message || ''}`);
  return data.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
}

const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

// ---------- index maintenance ----------
export function removeDocIndex(docId) {
  const d = getDb();
  for (const c of d.prepare('SELECT id FROM knowledge_chunks WHERE doc_id = ?').all(docId)) d.prepare('DELETE FROM knowledge_fts WHERE chunk_id = ?').run(c.id);
  d.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docId);
}

/** (Re)build the chunks for one document. Embeddings are added when configured (failures fall back to FTS only). */
export async function indexDoc(doc) {
  removeDocIndex(doc.id);
  if (!doc.text) return 0;
  const d = getDb();
  const chunks = chunkText(`${doc.name}\n${doc.text}`);
  const ids = [];
  chunks.forEach((text, idx) => {
    const id = Number(d.prepare('INSERT INTO knowledge_chunks (tenant_id, doc_id, idx, text) VALUES (?, ?, ?, ?)').run(doc.tenant_id, doc.id, idx, text).lastInsertRowid);
    d.prepare('INSERT INTO knowledge_fts (text, tenant_id, chunk_id) VALUES (?, ?, ?)').run(text, doc.tenant_id, id);
    ids.push(id);
  });
  if (embeddingsEnabled() && chunks.length) {
    try {
      for (let i = 0; i < chunks.length; i += 64) {
        const vecs = await embed(chunks.slice(i, i + 64));
        vecs.forEach((v, j) => d.prepare('UPDATE knowledge_chunks SET embedding = ? WHERE id = ?').run(toBlob(v), ids[i + j]));
      }
    } catch (e) {
      console.warn('[rag] embeddings failed, keyword search only:', e.message);
    }
  }
  return chunks.length;
}

/** Index every live document of a tenant that has no chunks yet (or all with force). */
export async function reindexTenant(tenantId, { force = false } = {}) {
  const d = getDb();
  const docs = d.prepare("SELECT id, tenant_id, name, text FROM knowledge_docs WHERE tenant_id = ? AND status NOT IN ('deleted', 'to_delete') AND text IS NOT NULL").all(tenantId);
  let n = 0;
  for (const doc of docs) {
    const has = d.prepare('SELECT 1 FROM knowledge_chunks WHERE doc_id = ? LIMIT 1').get(doc.id);
    if (force || !has) n += await indexDoc(doc);
  }
  return n;
}

// ---------- retrieval ----------
// Words people use for a topic that pages title differently ("my son is 14" → under-18s; "included" → "involves").
const EXPAND = [
  [/\b(son|daughter|child|children|kid|kids|teen|teenager|junior|1[0-7]|aged?|young)\b/, ['under', '18s', 'junior', 'age', 'minimum']],
  [/\b(included|include|includes|what do i get|what you get)\b/, ['includes', 'involves', 'included']],
  [/\b(cost|price|prices|how much|fee|fees)\b/, ['price', 'cost', 'fee']],
  [/\b(rain|raining|weather|wet)\b/, ['weather', 'rain', 'wet']],
  [/\b(refund|cancel|cancellation|reschedule|change my booking)\b/, ['cancellation', 'refund', 'change']],
];
export function queryTerms(q) {
  const text = String(q || '').toLowerCase();
  const terms = text.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  for (const [re, extra] of EXPAND) if (re.test(text)) terms.push(...extra);
  return [...new Set(terms)];
}
const ftsQuery = (q) => {
  const terms = queryTerms(q);
  // Each word as written (stemmed: "returns" finds "return") and as a prefix ("deliver" finds "delivery", which stems differently).
  // Long words also as a shorter prefix: "hygienist" finds "hygiene", "orthodontist" finds "orthodontic".
  return terms.length ? terms.map((t) => `"${t}" OR "${t}"*${t.length >= 8 ? ` OR "${t.slice(0, t.length - 3)}"*` : ''}`).join(' OR ') : null;
};
const STOP = new Set('the and for you your are was were have has had can could would should will what when where which who why how does did do this that with from about into our not but any all get got there their them they its it is me my we us an a of to in on at by be or if'.split(' '));

export async function retrieve(tenantId, query, { k = 4 } = {}) {
  const d = getDb();
  const ranked = new Map(); // chunk_id -> score (reciprocal rank fusion)
  const add = (id, rank) => ranked.set(id, (ranked.get(id) || 0) + 1 / (60 + rank));
  const fq = ftsQuery(query);
  if (fq) {
    const rows = d.prepare('SELECT chunk_id, bm25(knowledge_fts) AS s FROM knowledge_fts WHERE knowledge_fts MATCH ? AND tenant_id = ? ORDER BY s LIMIT 12').all(fq, tenantId);
    rows.forEach((r, i) => add(Number(r.chunk_id), i));
  }
  if (embeddingsEnabled()) {
    try {
      const [qv] = await embed([String(query).slice(0, 2000)]);
      const rows = d.prepare('SELECT id, embedding FROM knowledge_chunks WHERE tenant_id = ? AND embedding IS NOT NULL LIMIT 20000').all(tenantId);
      rows.map((r) => [r.id, cosine(qv, fromBlob(r.embedding))]).sort((a, b) => b[1] - a[1]).slice(0, 12).filter(([, s]) => s > 0.2).forEach(([id], i) => add(id, i));
    } catch (e) {
      console.warn('[rag] query embedding failed:', e.message);
    }
  }
  // Pages whose *title* matches the question rank higher: on a site with 30 test-day programmes, the guide called
  // "What a test day involves" should win "what's included in a test day?".
  const terms = queryTerms(query).filter((t) => t.length > 2);
  if (terms.length) {
    const words = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/);
    const hits = (name) => { const w = words(name); return terms.filter((t) => w.some((x) => x === t || (t.length >= 4 && x.startsWith(t.slice(0, Math.max(4, t.length - (t.length >= 8 ? 3 : 2))))))).length; };
    const docs = d.prepare("SELECT id, name FROM knowledge_docs WHERE tenant_id = ? AND status NOT IN ('deleted', 'to_delete')").all(tenantId)
      .map((x) => ({ ...x, h: hits(x.name) })).filter((x) => x.h >= Math.min(2, terms.length)).sort((a, b) => b.h - a.h).slice(0, 3);
    docs.forEach((doc, i) => {
      const first = d.prepare('SELECT id FROM knowledge_chunks WHERE doc_id = ? ORDER BY idx LIMIT 2').all(doc.id);
      first.forEach((c) => { add(c.id, i); add(c.id, i); }); // counts like being top in two searches
    });
  }
  const top = [...ranked.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
  if (!top.length) return [];
  return top.map((id) => d.prepare('SELECT c.id, c.text, k.name AS doc, k.url FROM knowledge_chunks c JOIN knowledge_docs k ON k.id = c.doc_id WHERE c.id = ?').get(id)).filter(Boolean);
}
