import { getDb, json } from './db.js';
import { getTenant, listTenants } from './tenants.js';
import { safeFetch, htmlToText, addTextDoc, importUrl, removeDoc, sitemapPages } from './knowledge.js';

/*
 * Keeps each shop's knowledge base in step with its website: re-reads every page it learnt (updating only pages
 * whose text changed), learns new pages listed in the site's sitemap, and removes pages that have gone (404/410
 * twice in a row, so an hour of downtime never wipes the bot's knowledge). Runs weekly per shop, and on demand from
 * the dashboard ("Re-read my website now").
 */
export const REFRESH_EVERY_MS = 7 * 86400000;
const MAX_PAGES = 400; // per run
const MAX_NEW = 40; // new pages learnt per run
const PAUSE_MS = Number(process.env.REFRESH_PAUSE_MS ?? 250); // be gentle with the shop's server

const kvGet = (k) => json(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value, null);
const kvSet = (k, v) => getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
const pathKey = (u) => { try { const x = new URL(u); return x.host + x.pathname.replace(/\/+$/, '') + x.search; } catch { return String(u); } };

const running = new Set();
export const refreshRunning = (tenantId) => running.has(tenantId);
export const lastRefresh = (tenantId) => kvGet(`kb_refresh:${tenantId}`);

/** Re-read one shop's website now. Returns a summary (also saved, shown in the dashboard). */
export async function refreshWebsite(tenantId, { onChange } = {}) {
  if (running.has(tenantId)) return { ok: false, error: 'Already running' };
  running.add(tenantId);
  const started = new Date().toISOString();
  const res = { ok: true, startedAt: started, checked: 0, updated: 0, unchanged: 0, added: 0, removed: 0, failed: 0, changedPages: [] };
  try {
    const t = getTenant(tenantId);
    if (!t) throw new Error('Shop not found');
    const d = getDb();
    const docs = d.prepare("SELECT id, name, url, text FROM knowledge_docs WHERE tenant_id = ? AND source = 'url' AND url IS NOT NULL AND status NOT IN ('deleted', 'to_delete') ORDER BY id").all(tenantId).slice(0, MAX_PAGES);
    const known = new Set(docs.map((x) => pathKey(x.url)));
    for (const doc of docs) {
      res.checked++;
      try {
        const r = await safeFetch(doc.url);
        const goneKey = `kb_gone:${doc.id}`;
        if (r.status === 404 || r.status === 410) {
          const n = (kvGet(goneKey) || 0) + 1;
          if (n >= 2) { removeDoc(tenantId, doc.id); d.prepare('DELETE FROM kv WHERE key = ?').run(goneKey); res.removed++; res.changedPages.push(`removed: ${doc.name}`); } else { kvSet(goneKey, n); res.failed++; }
        } else if (r.status !== 200) {
          res.failed++;
        } else {
          d.prepare('DELETE FROM kv WHERE key = ?').run(goneKey);
          const { title, text } = /html/.test(r.contentType) || /^\s*</.test(r.body) ? htmlToText(r.body) : { title: '', text: r.body };
          const fresh = norm(`Source: ${r.url}\n\n${text}`);
          if (text.length < 80) res.failed++; // page emptied (maybe a temporary error page): keep what we had
          else if (fresh === norm(doc.text)) res.unchanged++;
          else { addTextDoc(tenantId, { name: doc.name || title, text: fresh, source: 'url', url: doc.url }); res.updated++; res.changedPages.push(`updated: ${doc.name}`); }
        }
      } catch {
        res.failed++;
      }
      if (PAUSE_MS) await sleep(PAUSE_MS);
    }
    // new pages from the sitemap (same site only)
    const site = t.settings.business?.website;
    if (site) {
      let origin = '';
      try { origin = new URL(/^https?:\/\//.test(site) ? site : `https://${site}`).origin; } catch { origin = ''; }
      // shops with a live catalogue (Shopify, WooCommerce) get products from it; others learn product pages too
      const catalogue = !['shopify_public', 'shopify', 'woocommerce'].includes(t.settings.store?.type);
      const candidates = origin ? (await sitemapPages(origin, { limit: 500, catalogue }).catch(() => [])).filter((u) => !known.has(pathKey(u))) : [];
      for (const u of candidates.slice(0, MAX_NEW)) {
        try { const doc = await importUrl(tenantId, u); res.added++; res.changedPages.push(`new: ${doc.name}`); known.add(pathKey(u)); } catch (e) {
          if (e.status === 403 || /plan includes/i.test(e.message)) break; // plan's page limit reached
        }
        if (PAUSE_MS) await sleep(PAUSE_MS);
      }
    }
    res.changedPages = res.changedPages.slice(0, 30);
    res.finishedAt = new Date().toISOString();
    if ((res.updated || res.added || res.removed) && onChange) await Promise.resolve(onChange(tenantId)).catch(() => {});
    kvSet(`kb_refresh:${tenantId}`, res);
    return res;
  } catch (e) {
    const out = { ...res, ok: false, error: e.message, finishedAt: new Date().toISOString() };
    kvSet(`kb_refresh:${tenantId}`, out);
    return out;
  } finally {
    running.delete(tenantId);
  }
}

/** Hourly: re-read the website of the one shop most overdue (weekly), so shops are spread out over time. */
export async function runWeeklyRefresh({ now = Date.now(), onChange } = {}) {
  const due = listTenants()
    .filter((t) => t.active && t.settings.knowledge?.autoRefresh !== false)
    .filter((t) => getDb().prepare("SELECT 1 FROM knowledge_docs WHERE tenant_id = ? AND source = 'url' AND status NOT IN ('deleted', 'to_delete') LIMIT 1").get(t.id))
    .map((t) => ({ t, last: Date.parse(lastRefresh(t.id)?.startedAt || '') || 0 }))
    .filter((x) => now - x.last >= REFRESH_EVERY_MS)
    .sort((a, b) => a.last - b.last);
  if (!due.length) return null;
  return refreshWebsite(due[0].t.id, { onChange });
}
