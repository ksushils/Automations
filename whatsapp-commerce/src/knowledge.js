import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';
import { getDb } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { getTenant, updateTenantSettings, PLANS } from './tenants.js';
import { DifyConsole, consoleConfigured } from './dify/console.js';
import { stripHtml } from './stores/http.js';
import { extractText } from './ai/extract.js';
import { indexDoc, removeDocIndex } from './ai/rag.js';

// keep the local search index (direct AI mode + fallback) in step with every document change
const reindex = (id) => { const doc = getDb().prepare('SELECT id, tenant_id, name, text FROM knowledge_docs WHERE id = ?').get(id); if (doc) indexDoc(doc).catch((e) => console.warn('[index]', e.message)); };

/*
 * Knowledge base (RAG) per shop.
 * Documents are stored here first (so the dashboard works even before AI is connected), then synced to a
 * Dify knowledge base ("dataset") that is attached to the shop's chatbot. A small built-in keyword search
 * answers FAQ/policy questions when AI is unavailable.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|xml|csv))/;
const ALLOWED_EXT = /\.(pdf|docx?|txt|md|markdown|csv|xlsx?|html?|pptx?|epub|eml|msg|xml|json)$/i;

// ---------- documents ----------
const mapDoc = (r) => r && { id: r.id, name: r.name, source: r.source, url: r.url, mime: r.mime, size: r.size, status: r.status, error: r.error, difyDocumentId: r.dify_document_id, createdAt: r.created_at, updatedAt: r.updated_at, preview: (r.text || '').slice(0, 200) };

export const listDocs = (tenantId) => getDb().prepare("SELECT * FROM knowledge_docs WHERE tenant_id = ? AND status != 'deleted' ORDER BY id DESC").all(tenantId).map(mapDoc);

function checkLimit(tenantId) {
  const t = getTenant(tenantId);
  const max = PLANS[t?.plan]?.knowledgeDocs ?? 20;
  const n = getDb().prepare("SELECT COUNT(*) AS n FROM knowledge_docs WHERE tenant_id = ? AND status != 'deleted'").get(tenantId).n;
  if (n >= max) throw Object.assign(new Error(`Your plan includes ${max} knowledge documents – remove one or upgrade`), { status: 403 });
}

export function addTextDoc(tenantId, { name, text, source = 'text', url = null }) {
  const clean = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length < 20) throw Object.assign(new Error('The text is too short to be useful'), { status: 400 });
  if (clean.length > 500000) throw Object.assign(new Error('Text is too long (max 500,000 characters) – split it into several documents'), { status: 400 });
  // re-importing the same URL / name replaces the old version
  const existing = getDb().prepare("SELECT id FROM knowledge_docs WHERE tenant_id = ? AND status != 'deleted' AND ((url IS NOT NULL AND url = ?) OR (source = ? AND name = ?))").get(tenantId, url, source, String(name));
  if (existing) {
    getDb().prepare("UPDATE knowledge_docs SET text = ?, size = ?, status = 'pending', error = NULL, updated_at = datetime('now') WHERE id = ?").run(clean, Buffer.byteLength(clean), existing.id);
    reindex(existing.id);
    return mapDoc(getDb().prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(existing.id));
  }
  checkLimit(tenantId);
  const info = getDb().prepare('INSERT INTO knowledge_docs (tenant_id, name, source, url, mime, text, size) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tenantId, String(name || 'Untitled').slice(0, 120), source, url, 'text/plain', clean, Buffer.byteLength(clean));
  reindex(Number(info.lastInsertRowid));
  return mapDoc(getDb().prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(info.lastInsertRowid));
}

export function addFileDoc(tenantId, { filename, mime, buffer }) {
  if (!buffer?.length) throw Object.assign(new Error('Empty file'), { status: 400 });
  if (buffer.length > MAX_FILE_BYTES) throw Object.assign(new Error('File is larger than 10 MB'), { status: 413 });
  if (!ALLOWED_EXT.test(filename || '')) throw Object.assign(new Error('Supported files: PDF, Word, Excel, PowerPoint, TXT, Markdown, CSV, HTML'), { status: 400 });
  checkLimit(tenantId);
  // keep a text copy for the built-in search when the file is plain text
  // text copy for local search / direct AI (PDF, Word, PowerPoint, Excel extracted without Dify)
  let text = TEXT_TYPES.test(mime || '') || /\.(txt|md|markdown|csv|json|xml)$/i.test(filename) ? buffer.toString('utf8') : /\.html?$/i.test(filename) ? htmlToText(buffer.toString('utf8')).text : extractText(filename, buffer);
  if (text && text.replace(/\s/g, '').length < 20) text = null;
  const note = text ? null : /\.(pdf|docx|pptx|xlsx)$/i.test(filename) ? 'No readable text found (scanned image?) – it can still be used by Dify, or paste the text instead.' : null;
  const info = getDb().prepare('INSERT INTO knowledge_docs (tenant_id, name, source, mime, text, file, size, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(tenantId, String(filename).slice(0, 120), 'file', mime || 'application/octet-stream', text || null, buffer, buffer.length, note);
  if (text) reindex(Number(info.lastInsertRowid));
  return mapDoc(getDb().prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(info.lastInsertRowid));
}

export function removeDoc(tenantId, id) {
  removeDocIndex(Number(id));
  const r = getDb().prepare("UPDATE knowledge_docs SET status = CASE WHEN dify_document_id IS NULL THEN 'deleted' ELSE 'to_delete' END, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?").run(tenantId, Number(id));
  return r.changes > 0;
}

// ---------- HTML → text & safe fetching ----------
const decodeEntities = (s) => String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;|&#x27;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&pound;/g, '£').replace(/&mdash;|&ndash;/g, '–').replace(/&hellip;/g, '…').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

export function htmlToText(html) {
  const title = decodeEntities((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const main = String(html).match(/<main[\s\S]*?<\/main>/i)?.[0] || String(html).match(/<body[\s\S]*<\/body>/i)?.[0] || String(html);
  const text = main
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|dd|dt)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')

    .split('\n').map((l) => decodeEntities(l).replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
  return { title, text };
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

/** Fetch a public web page safely (no internal addresses, size + redirect limits). */
export async function safeFetch(url, { maxBytes = 2 * 1024 * 1024, redirects = 3, allowPrivate = config.allowPrivateFetch } = {}) {
  let u = new URL(url);
  for (let hop = 0; hop <= redirects; hop++) {
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
    if (!allowPrivate) {
      const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
      if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address is not allowed');
    }
    const res = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'WhatsAppCommerceBot/1.0 (+knowledge import)', Accept: 'text/html,application/json;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(20000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), u); continue; }
    const reader = res.body?.getReader();
    const chunks = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { reader.cancel(); break; }
      chunks.push(value);
    }
    return { status: res.status, url: u.toString(), contentType: res.headers.get('content-type') || '', body: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects');
}

export async function importUrl(tenantId, url, { name } = {}) {
  const r = await safeFetch(url);
  if (r.status !== 200) throw Object.assign(new Error(`Could not open the page (HTTP ${r.status})`), { status: 400 });
  const { title, text } = /html/.test(r.contentType) || /^\s*</.test(r.body) ? htmlToText(r.body) : { title: '', text: r.body };
  if (text.length < 80) throw Object.assign(new Error('That page has almost no text to learn from'), { status: 400 });
  return addTextDoc(tenantId, { name: name || title.replace(/\s+[–|-]\s+[^–|-]+$/, '') || r.url, text: `Source: ${r.url}\n\n${text}`, source: 'url', url: r.url });
}

// ---------- website detection & one-step onboarding ----------
export async function detectWebsite(url) {
  const u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
  const origin = u.origin;
  const meta = await safeFetch(`${origin}/meta.json`).then((r) => (r.status === 200 && /^\s*\{/.test(r.body) ? JSON.parse(r.body) : null)).catch(() => null);
  if (meta?.myshopify_domain || meta?.domain) {
    return { platform: 'shopify', origin, domain: meta.domain || u.hostname, name: meta.name, description: meta.description, currency: meta.currency, city: meta.city, country: meta.country };
  }
  const woo = await safeFetch(`${origin}/wp-json/wc/store/v1/products?per_page=1`).then((r) => r.status === 200 && /^\s*\[/.test(r.body)).catch(() => false);
  const home = await safeFetch(origin).catch(() => null);
  const html = home?.body || '';
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1] || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i)?.[1] || '';
  const name = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i)?.[1] || htmlToText(html).title.split(/[|–-]/)[0].trim();
  return { platform: woo ? 'woocommerce' : 'website', origin, domain: u.hostname, name, description: stripHtml(desc) };
}

const SYMBOLS = { GBP: '£', USD: '$', EUR: '€', AED: 'AED ', INR: '₹', AUD: 'A$', CAD: 'C$' };

/**
 * New shop gives us its website → we fill in the business details, connect the catalogue (Shopify: no token
 * needed) and import policy / FAQ / about pages into the knowledge base. Returns a summary of what happened.
 */
export async function onboardFromWebsite(tenantId, url) {
  const site = await detectWebsite(url);
  const t = getTenant(tenantId);
  const patch = { business: {}, ai: {} };
  if (site.name && (!t.settings.business.name || t.settings.business.name === t.name)) patch.business.name = site.name;
  if (site.currency) { patch.business.currency = site.currency; patch.business.currencySymbol = SYMBOLS[site.currency] || site.currency + ' '; }
  if (site.description && !t.settings.ai?.about) patch.ai.about = site.description + (site.city ? ` Based in ${site.city}${site.country ? ', ' + site.country : ''}.` : '');
  patch.business.website = site.origin;
  let store = null;
  if (site.platform === 'shopify' && (t.settings.store?.type || 'manual') === 'manual' && !(t.settings.store?.manual?.products || []).length) {
    patch.store = { type: 'shopify_public', shopify: { domain: new URL(site.origin).host, origin: site.origin } };
    store = 'shopify_public';
  }
  updateTenantSettings(tenantId, patch);

  const pages = site.platform === 'shopify'
    ? ['/policies/refund-policy', '/policies/shipping-policy', '/policies/terms-of-service', '/policies/privacy-policy', '/pages/faq', '/pages/faqs', '/pages/about', '/pages/about-us', '/pages/contact']
    : ['/', '/about', '/about-us', '/faq', '/faqs', '/delivery', '/shipping', '/returns', '/refund-policy', '/contact', '/terms'];
  const imported = [];
  const skipped = [];
  for (const path of pages) {
    try {
      const d = await importUrl(tenantId, site.origin + path);
      imported.push({ path, name: d.name });
    } catch (e) {
      skipped.push({ path, reason: e.message });
    }
  }
  return { site, store, imported, skipped: skipped.length };
}

// ---------- built-in keyword retrieval (fallback when AI is off/unavailable) ----------
const STOP = new Set('a an and are as at be by can do does for from have how i if in is it me my of on or our please the to we what when where which who why will with you your'.split(' '));
const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1') || w;
const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
// small synonym map so "do you ship to Ireland?" finds "orders delivered outside the United Kingdom"
const SYN = [
  ['ship', 'deliver', 'delivery', 'postage', 'post', 'dispatch', 'courier', 'carrier'],
  ['return', 'refund', 'exchange', 'money back', 'send back'],
  ['ireland', 'europe', 'abroad', 'overseas', 'international', 'outside', 'countrie', 'worldwide'],
  ['cost', 'price', 'fee', 'charge'],
  ['open', 'hour', 'opening', 'time'],
  ['warranty', 'guarantee', 'faulty', 'broken', 'damage'],
  ['contact', 'phone', 'email', 'call'],
];
const expand = (ws) => { const out = new Set(ws); for (const w of ws) for (const g of SYN) if (g.some((x) => stem(x) === w)) g.forEach((x) => out.add(stem(x))); return [...out]; };
export const topicOf = (q) => { const ws = words(q); return SYN.slice(0, 2).find((g) => g.some((x) => ws.includes(stem(x))))?.[0] || null; };

export function searchKnowledge(tenantId, query, { limit = 2 } = {}) {
  const base = [...new Set(words(query))];
  if (!base.length) return [];
  const q = expand(base);
  const docs = getDb().prepare("SELECT id, name, url, text FROM knowledge_docs WHERE tenant_id = ? AND status NOT IN ('deleted', 'to_delete') AND text IS NOT NULL").all(tenantId);
  const hits = [];
  for (const d of docs) {
    const paras = d.text.replace(/^Source: .*\n+/, '').split(/\n(?=\S)/).reduce((acc, line) => { const last = acc.at(-1); if (last && last.length < 500) acc[acc.length - 1] = last + '\n' + line; else acc.push(line); return acc; }, []);
    const nameWords = new Set(words(d.name));
    for (const p of paras) {
      const w = new Set(words(p));
      // how many of the customer's own concepts (word or synonym group) appear in this paragraph
      const concepts = base.filter((b) => w.has(b) || expand([b]).some((x) => w.has(x)));
      const bonus = base.some((b) => expand([b]).some((x) => nameWords.has(x))) ? 0.3 : 0;
      if (concepts.length) hits.push({ doc: d.name, url: d.url || null, text: p.replace(/^Source: .*\n+/, '').slice(0, 700), score: concepts.length / base.length + bonus, matched: concepts.length });
    }
  }
  return hits.filter((h) => h.matched >= Math.min(2, base.length)).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The policy document for a topic (e.g. shipping/returns), to link when no exact answer is found. */
export function topicDoc(tenantId, topic) {
  if (!topic) return null;
  const re = topic === 'ship' ? /(ship|deliver|postage)/i : /(refund|return)/i;
  return getDb().prepare("SELECT name, url FROM knowledge_docs WHERE tenant_id = ? AND status NOT IN ('deleted', 'to_delete')").all(tenantId).find((d) => re.test(d.name)) || null;
}

// ---------- Dify sync ----------
function kvGet(k) { const v = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value; return v ? decrypt(v) : null; }
function kvSet(k, v) { getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, encrypt(v)); }

/** One workspace-level Dify knowledge API key, created automatically and kept server-side only. */
export async function datasetKey(client = new DifyConsole()) {
  if (config.difyDatasetApiKey) return config.difyDatasetApiKey;
  let key = kvGet('dify_dataset_key');
  if (!key) {
    key = (await client.request('POST', '/datasets/api-keys', {})).token;
    if (!key || key.includes('...')) throw new Error('Dify did not return a knowledge API key');
    kvSet('dify_dataset_key', key);
  }
  return key;
}

async function kapi(method, path, { key, json, form } = {}) {
  const res = await fetch(`${config.difyConsoleUrl}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : form,
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Dify knowledge ${method} ${path} → ${res.status}: ${data.message || data.code || ''}`), { status: res.status });
  return data;
}

async function indexingTechnique(client) {
  try {
    const d = await client.request('GET', '/workspaces/current/default-model?model_type=text-embedding');
    return d?.data?.model ? 'high_quality' : 'economy';
  } catch { return 'economy'; }
}

export async function ensureDataset(tenantId, { client = new DifyConsole(), key } = {}) {
  const t = getTenant(tenantId);
  key ||= await datasetKey(client);
  let id = t.settings.dify?.datasetId;
  if (id) {
    const ok = await kapi('GET', `/datasets/${id}`, { key }).then(() => true, (e) => (e.status === 404 ? false : Promise.reject(e)));
    if (ok) return { id, key, created: false };
  }
  const technique = await indexingTechnique(client);
  const ds = await kapi('POST', '/datasets', { key, json: { name: `${t.settings.business.name}`.slice(0, 30) + ` · ${t.id.slice(-6)}`, description: `WhatsApp knowledge base for ${t.settings.business.name} (managed by WhatsApp Commerce)`, indexing_technique: technique, permission: 'only_me' } });
  updateTenantSettings(tenantId, { dify: { datasetId: ds.id, datasetTechnique: technique } });
  getDb().prepare("UPDATE knowledge_docs SET dify_document_id = NULL, status = CASE WHEN status = 'to_delete' THEN 'deleted' ELSE 'pending' END WHERE tenant_id = ? AND status != 'deleted'").run(tenantId);
  return { id: ds.id, key, created: true };
}

/** Push pending documents to Dify, delete removed ones, refresh indexing status. */
export async function syncKnowledge(tenantId, { client = new DifyConsole() } = {}) {
  if (!consoleConfigured() && !client.injected && !config.difyDatasetApiKey) return { synced: 0, skipped: 'Dify not connected' };
  const { id: ds, key, created } = await ensureDataset(tenantId, { client });
  const technique = getTenant(tenantId).settings.dify?.datasetTechnique || 'economy';
  const d = getDb();
  let synced = 0, deleted = 0, failed = 0;
  for (const doc of d.prepare("SELECT * FROM knowledge_docs WHERE tenant_id = ? AND status = 'to_delete'").all(tenantId)) {
    await kapi('DELETE', `/datasets/${ds}/documents/${doc.dify_document_id}`, { key }).catch((e) => { if (e.status !== 404) throw e; });
    d.prepare("UPDATE knowledge_docs SET status = 'deleted' WHERE id = ?").run(doc.id);
    deleted++;
  }
  for (const doc of d.prepare("SELECT * FROM knowledge_docs WHERE tenant_id = ? AND status IN ('pending', 'error')").all(tenantId)) {
    try {
      const process_rule = { mode: 'automatic' };
      let r;
      if (doc.dify_document_id && doc.text && !doc.file) {
        r = await kapi('POST', `/datasets/${ds}/documents/${doc.dify_document_id}/update-by-text`, { key, json: { name: doc.name, text: doc.text, process_rule } }).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
      }
      if (!r && doc.file) {
        const form = new FormData();
        form.append('data', JSON.stringify({ indexing_technique: technique, process_rule, doc_form: 'text_model' }));
        form.append('file', new Blob([doc.file], { type: doc.mime || 'application/octet-stream' }), doc.name);
        r = await kapi('POST', `/datasets/${ds}/document/create-by-file`, { key, form });
      } else if (!r) {
        r = await kapi('POST', `/datasets/${ds}/document/create-by-text`, { key, json: { name: doc.name, text: doc.text, indexing_technique: technique, process_rule, doc_form: 'text_model' } });
      }
      d.prepare("UPDATE knowledge_docs SET dify_document_id = ?, status = 'indexing', error = NULL, updated_at = datetime('now') WHERE id = ?").run(r.document?.id || doc.dify_document_id, doc.id);
      synced++;
    } catch (e) {
      failed++;
      d.prepare("UPDATE knowledge_docs SET status = 'error', error = ? WHERE id = ?").run(String(e.message).slice(0, 300), doc.id);
    }
  }
  // refresh indexing status
  const remote = await kapi('GET', `/datasets/${ds}/documents?page=1&limit=100`, { key }).catch(() => ({ data: [] }));
  for (const r of remote.data || []) {
    const st = r.indexing_status === 'completed' ? 'ready' : r.indexing_status === 'error' ? 'error' : 'indexing';
    d.prepare("UPDATE knowledge_docs SET status = ?, error = ? WHERE tenant_id = ? AND dify_document_id = ? AND status IN ('indexing', 'ready', 'error')").run(st, r.error || null, tenantId, r.id);
  }
  return { datasetId: ds, createdDataset: created, synced, deleted, failed };
}
