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
  // re-importing the same page replaces the old version: web pages are matched by address (two pages can share a
  // title, e.g. "Hot Deals"), typed documents by name
  const existing = url
    ? getDb().prepare("SELECT id FROM knowledge_docs WHERE tenant_id = ? AND status != 'deleted' AND url = ?").get(tenantId, url)
    : getDb().prepare("SELECT id FROM knowledge_docs WHERE tenant_id = ? AND status != 'deleted' AND url IS NULL AND source = ? AND name = ?").get(tenantId, source, String(name));
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
const decodeEntities = (s) => String(s).replace(/&middot;|&bull;/g, '·').replace(/&starf;|&#9733;/g, '★').replace(/&rarr;/g, '→').replace(/&times;/g, '×').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;|&#x27;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&pound;/g, '£').replace(/&mdash;|&ndash;/g, '–').replace(/&hellip;/g, '…').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

/** Cloudflare hides email addresses as "[email protected]" with the address XOR-encoded in data-cfemail / the link. */
export function decodeCfEmail(hex) {
  if (!/^[0-9a-f]{4,}$/i.test(String(hex)) || hex.length % 2) return '';
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(out) ? out : '';
}
const revealEmails = (html) => String(html)
  .replace(/<(span|a)\b[^>]*data-cfemail=["']([0-9a-f]+)["'][^>]*>[\s\S]*?<\/\1>/gi, (m, tag, hex) => decodeCfEmail(hex) || m)
  .replace(/href=["'][^"']*\/cdn-cgi\/l\/email-protection#([0-9a-f]+)["']/gi, (m, hex) => { const e = decodeCfEmail(hex); return e ? `href="mailto:${e}"` : m; })
  .replace(/\[email(?:&#160;|&nbsp;|\s)protected\]/gi, '');

/**
 * Shop listings (Shopify especially) write each card's price as "Regular price / £12.00 GBP / Regular price / £0.00 GBP /
 * Sale price / £12.00 GBP / Unit price / per" on separate lines, so a price ends up between two product names and the
 * AI pairs it with the wrong one. Collapse that to one price and put it on the product's own line: "Gift Box – From £10.00".
 */
export function tidyPriceRows(text) {
  const P = String.raw`(?:From\s+)?£\s?\d[\d,]*(?:\.\d{2})?`;
  let t = String(text)
    .replace(/Regular price\s*£\s?0(?:\.00)?(?: GBP)?[ \t]*/gi, '')
    .replace(/[ \t]*Unit price(?:\s*\/\s*per)?[ \t]*/gi, '')
    .replace(new RegExp(String.raw`(£\s?\d[\d,]*(?:\.\d{2})?)\s?GBP\b`, 'g'), '$1')
    .replace(/(?:Regular|Sale) price\s*(?=(?:From\s+)?£)/gi, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  // "From £10.00 From £10.00" (regular then sale on one line) → once
  t = t.replace(new RegExp(String.raw`(${P})\s+\1(?=\s|$)`, 'g'), '$1');
  // the same price twice in a row (regular then sale) → once
  t = t.replace(new RegExp(String.raw`(^|\n)(${P})\n\2(?=\n|$)`, 'g'), '$1$2');
  // a line that is only a price belongs to the line above it (the product name)
  t = t.replace(new RegExp(String.raw`([^\n£]{3,120})\n(${P}(?:\s*[–-]\s*£\s?\d[\d,]*(?:\.\d{2})?)?)(?=\n|$)`, 'g'), '$1 – $2');
  return t.replace(/\n{2,}/g, '\n');
}

export function htmlToText(rawHtml) {
  const html = revealEmails(rawHtml);
  const title = decodeEntities((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const main = String(html).match(/<main[\s\S]*?<\/main>/i)?.[0] || String(html).match(/<body[\s\S]*<\/body>/i)?.[0] || String(html);
  const rawText = main
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<tr\b[\s\S]*?<\/tr>/gi, (row) => row.replace(/\s+/g, ' ').replace(/<\/t[dh]>/gi, ' | ').replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li)>/gi, ' ') + '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|dd|dt)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')

    .split('\n').map((l) => decodeEntities(l).replace(/[ \t]+/g, ' ').trim().replace(/^(\|\s*)+|(\s*\|)+$/g, '').replace(/(\s*\|)+\s*\|/g, ' |')).filter(Boolean).join('\n');
  const text = tidyPriceRows(rawText);
  const facts = footerFacts(html).filter((l) => !text.includes(l));
  return { title, text: facts.length ? `${text}\n\nFrom the website footer:\n${facts.join('\n')}` : text };
}

const DAY = /\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day|s|\.)?\b/i;
const TIME = /\b\d{1,2}([:.]\d{2})?\s*(am|pm)\b|\b\d{1,2}[:.]\d{2}\b|\bclosed\b|\b24\s*hours\b/i;
/** Opening hours, phone numbers, addresses and emails from the page footer (kept short; boilerplate otherwise dropped). */
export function footerFacts(html) {
  const foot = [...String(html).matchAll(/<footer[\s\S]*?<\/footer>/gi)].map((m) => m[0]).join('\n');
  if (!foot) return [];
  const lines = foot
    .replace(/<(script|style|noscript|svg|template|iframe|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|td|th|dd|dt|span)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .split('\n').map((l) => decodeEntities(l).replace(/[ \t]+/g, ' ').trim()).filter((l) => l.length >= 3 && l.length <= 160);
  // hours are often split over two lines ("<dt>Monday</dt><dd>10am - 4pm</dd>", "Monday — Friday<br>8:30 am — 6:30 pm"):
  // join a line naming only days with the time line that follows it
  for (let i = 0; i < lines.length - 1; i++) {
    if (DAY.test(lines[i]) && !TIME.test(lines[i]) && lines[i].length <= 40 && TIME.test(lines[i + 1]) && !DAY.test(lines[i + 1]) && lines[i + 1].length <= 60) {
      lines.splice(i, 2, `${lines[i]}: ${lines[i + 1]}`);
    }
  }
  const keep = lines.filter((l) => (DAY.test(l) && TIME.test(l)) || /opening hours|open(ing)? times|^hours\b/i.test(l)
    || /(\+44|\b0)\s?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/.test(l) || /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/.test(l) || /\b[\w.+-]+@[\w-]+\.[\w.]+\b/.test(l));
  return [...new Set(keep)].slice(0, 20);
}

/** Rank a site's page paths so the ones customers ask about (prices, services, hours, FAQ, contact) are read first. */
export function rankPaths(paths) {
  const score = (p) => {
    const s = p.toLowerCase();
    if (s === '/' || s === '') return 100;
    let n = 0;
    if (/\b(fees?|prices?|pricing|costs?|tariffs?|rates|menus?|packages?|plans)\b/.test(s)) n += 50;
    if (/\b(faqs?|frequently|help|contact(-us)?|opening|hours|find-us|locations?|visit)\b/.test(s)) n += 40;
    if (/\b(about|delivery|shipping|returns?|refunds?|book(ing)?|appointments?|emergency|treatments?|services?|finance)\b/.test(s)) n += 25;
    if (/gallery|blog|news|careers|jobs|cookie|privacy|terms|gdpr|policy|policies|compliance|accessibility|sitemap|feedback|questionnaire|my-account|login|testimonial|review|category|tag/.test(s)) n -= 40;
    return n - s.split('/').filter(Boolean).length * 3;
  };
  return [...new Set(paths)].map((p, i) => ({ p, i, s: score(p) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.p);
}

/**
 * Pages worth reading only if nothing better is left: near-identical area pages ("/kingswinford-heating-plumbing",
 * "/lye-heating-plumbing", "/driving-lessons-benton"…, beyond the first 2 of a family of 3 or more) and blog/news/gallery
 * pages. Returns them in the order given.
 */
export function lastResortPaths(paths) {
  const list = [...new Set(paths)];
  const keysOf = (p) => {
    const segs = p.toLowerCase().replace(/\/+$/, '').split('/');
    const tokens = (segs.pop() || '').split('-').filter(Boolean);
    const parent = segs.join('/');
    const keys = [];
    for (let n = 2; n < tokens.length; n++) { keys.push(`${parent}|<${tokens.slice(0, n).join('-')}`); keys.push(`${parent}|>${tokens.slice(-n).join('-')}`); }
    return keys;
  };
  const count = new Map();
  for (const p of list) for (const k of new Set(keysOf(p))) count.set(k, (count.get(k) || 0) + 1);
  const used = new Map();
  const out = [];
  for (const p of list) {
    if (/\/(blog|news|gallery|testimonials?|reviews?|case-studies)(\/|$)/i.test(p)) { out.push(p); continue; }
    const family = keysOf(p).filter((k) => count.get(k) >= 3).sort((a, b) => count.get(b) - count.get(a))[0];
    if (!family) continue;
    used.set(family, (used.get(family) || 0) + 1);
    if (used.get(family) > 2) out.push(p);
  }
  return out;
}

/** Same-site page links from a page's HTML (its menu and footer), as paths. */
export function pageLinks(html, origin) {
  const host = new URL(origin).host.replace(/^www\./, '');
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    try { const u = new URL(decodeEntities(m[1]), origin); if (/^https?:$/.test(u.protocol) && u.host.replace(/^www\./, '') === host && u.pathname.split('/').filter(Boolean).length <= 2 && !/\.(jpe?g|png|gif|pdf|zip|xml|css|js)$|\/(feed|wp-|cart|checkout)/i.test(u.pathname)) out.push(u.pathname.replace(/(.)\/$/, '$1')); } catch {}
  }
  return [...new Set(out)];
}

export function isPrivateIp(ip) {
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
  // many sites answer a missing page with "200 OK" and a "page not found" message: don't learn that
  if (/\b(page not found|404|not be found|doesn'?t exist|no longer exists?)\b/i.test(title) || (text.length < 1500 && /\b(page (you|you're|you are) looking for|page not found|error 404|404 error|oops!? (that|this) page)\b/i.test(text.slice(0, 600)))) throw Object.assign(new Error('That page was not found'), { status: 404 });
  // a catch-all site serves its home page at every address: skip pages whose text we already have under another address
  const body = text.replace(/\s+/g, ' ').trim();
  const twin = getDb().prepare("SELECT url, text FROM knowledge_docs WHERE tenant_id = ? AND status != 'deleted' AND url IS NOT NULL AND url != ? AND size BETWEEN ? AND ?").all(tenantId, r.url, Math.floor(Buffer.byteLength(body) * 0.9), Math.ceil(Buffer.byteLength(body) * 1.2) + 200)
    .find((d) => String(d.text).replace(/^Source: .*\n+/, '').replace(/\s+/g, ' ').trim() === body);
  if (twin) throw Object.assign(new Error(`Same text as ${twin.url}`), { status: 409 });
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
  // og:site_name may hold an apostrophe ("Noah's Barber") and some sites encode it twice ("&amp;amp;")
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=(["'])(.*?)\1/i)?.[2] || html.match(/<meta[^>]+content=(["'])(.*?)\1[^>]+property=["']og:site_name["']/i)?.[2] || '';
  const name = decodeEntities(decodeEntities(og)).trim() || decodeEntities(htmlToText(html).title).split(/\s[|–-]\s|\s?[|–]\s?/)[0].trim();
  return { platform: woo ? 'woocommerce' : 'website', origin, domain: u.hostname, name, description: stripHtml(desc) };
}

const SYMBOLS = { GBP: '£', USD: '$', EUR: '€', AED: 'AED ', INR: '₹', AUD: 'A$', CAD: 'C$' };

/**
 * New shop gives us its website → we fill in the business details, connect the catalogue (Shopify: no token
 * needed) and import policy / FAQ / about pages into the knowledge base. Returns a summary of what happened.
 */
/**
 * The shop's information pages from its sitemap (Shopify: sitemap_pages_*.xml; others: short top-level URLs),
 * so seller terms, marketplace policies, guides etc. are learnt too, not only a fixed list of usual paths.
 */
export async function sitemapPages(origin, { limit = 25, catalogue = false } = {}) {
  const locs = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const root = await safeFetch(`${origin}/sitemap.xml`).catch(() => null);
  if (!root || root.status !== 200) return [];
  let urls = locs(root.body);
  const pageMaps = urls.filter((u) => /sitemap_pages|page-sitemap|pages?\.xml/i.test(u));
  if (pageMaps.length) {
    urls = [];
    for (const m of pageMaps.slice(0, 3)) { const r = await safeFetch(m).catch(() => null); if (r?.status === 200) urls.push(...locs(r.body)); }
  } else if (urls.some((u) => /\.xml(\?|$)/.test(u))) return []; // an index of sitemaps we can't classify: skip
  const host = new URL(origin).host;
  const skip = catalogue ? /\/(cart|account|checkout|tags?|blogs?\/[^/]+\/.+|search)(\/|$)|opt-out|unsubscribe|\.(jpg|png|pdf|xml)$/i : /\/(products?|collections?|shop|cart|account|checkout|tags?|category|categories|blogs?\/[^/]+\/.+|search)(\/|$)|opt-out|unsubscribe|\.(jpg|png|pdf|xml)$/i;
  const ok = [...new Set(urls)].filter((u) => { try { const x = new URL(u); return x.host === host && !skip.test(x.pathname) && x.pathname.split('/').filter(Boolean).length <= 2; } catch { return false; } });
  if (catalogue) return ok.slice(0, limit);
  const byPath = new Map(ok.map((u) => [new URL(u).pathname, u]));
  return rankPaths([...byPath.keys()]).map((p) => byPath.get(p)).slice(0, limit);
}

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
  const fromSitemap = (await sitemapPages(site.origin).catch(() => [])).map((u) => new URL(u).pathname);
  for (const path of [...new Set([...pages, ...fromSitemap])]) {
    try {
      const d = await importUrl(tenantId, site.origin + path);
      imported.push({ path, name: d.name });
    } catch (e) {
      skipped.push({ path, reason: e.message });
    }
  }
  // AI auto-setup: welcome menu, greetings and lead question from what we just read (never overwrites owner edits)
  const auto = imported.length ? await import('./autoSetup.js').then(({ autoSetup }) => autoSetup(tenantId)).catch((e) => ({ applied: [], reason: e.message })) : null;
  return { site, store, imported, skipped: skipped.length, autoSetup: auto };
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
