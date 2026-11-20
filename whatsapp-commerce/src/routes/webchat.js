import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { getTenant, bumpUsage, withinLimit, PLANS } from '../tenants.js';
import { getDb, json } from '../db.js';
import { createSender, logMessage } from '../whatsapp/cloudApi.js';
import { handleInbound, menuOptions, openerFor, PAGE_OPENERS, DEFAULT_OPENER } from '../bot/engine.js';
import { enqueue } from '../whatsapp/webhook.js';
import { rateLimit } from './web.js';
import { isDemo, DEMO_MESSAGE_CAP } from '../instantDemo.js';
import { createHandoff } from '../continuity.js';

/*
 * Website AI chat: the same bot (AI, knowledge base, catalogue, cart, flows, human hand-over) on the shop's own site.
 * Visitors are identified as "web:<random session id>" – no WhatsApp number, so no Meta account or fees involved.
 * Staff replies from the inbox are delivered by polling.
 */
const SESSION = /^[A-Za-z0-9_-]{16,64}$/;

function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*'); // public endpoints, no cookies
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

const visitorId = (sessionId) => `web:${sessionId}`;

// Files visitors send in the website chat (photos and PDFs): kept beside the database, unguessable names, 90 days.
export const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
const MIME = Object.fromEntries(Object.entries(FILE_TYPES).map(([m, e]) => [e, m]));
const MAGIC = {
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  gif: (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILES_PER_DAY = 10;
// Visitor typing (for the Inbox): kept in memory for a few seconds, never stored.
const typingAt = new Map();
export const isTyping = (tenantId, waId) => Date.now() - (typingAt.get(`${tenantId}:${waId}`) || 0) < 6000;
const KEEP_DAYS = 90;
export function chatFilesDir() {
  return config.databasePath === ':memory:' ? path.join(os.tmpdir(), 'wa-chat-files') : path.join(path.dirname(path.resolve(config.databasePath)), 'chat-files');
}
function pruneFiles(dir) {
  try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > KEEP_DAYS * 86400000) fs.unlinkSync(p); } } catch {}
}
const chatPageHtml = (t) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Chat with ${escHtml(t.settings.webchat?.title || t.settings.business.name)}</title>
<style>html,body{margin:0;height:100%;background:#eef1f0}#chat{height:100vh;height:100dvh;max-width:720px;margin:0 auto}</style></head>
<body><div id="chat"></div><script src="${config.publicUrl}/chat-widget/${encodeURIComponent(t.id)}.js" data-embed="#chat" data-page="1"></script></body></html>`;
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Campaign tags from the page the visitor landed on (utm_*, gclid, fbclid) – kept for lead attribution. */
export function cleanUtm(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']) if (u[k]) out[k] = String(u[k]).replace(/[^\w .:/@+-]/g, '').slice(0, 80);
  return Object.keys(out).length ? out : null;
}

/** The page the visitor is on (from the widget): same-site URL without query string, and the page title. */
export function cleanPage(p) {
  if (!p || typeof p !== 'object') return null;
  let url;
  try { const u = new URL(String(p.url || '')); if (!/^https?:$/.test(u.protocol)) return null; url = u.origin + u.pathname; } catch { return null; }
  const c = (v, n) => String(v ?? '').replace(/[\r\n<>]+/g, ' ').trim().slice(0, n);
  const pr = p.product && typeof p.product === 'object' ? { name: c(p.product.name, 120), price: c(p.product.price, 20), currency: c(p.product.currency, 3), availability: c(p.product.availability, 40), sku: c(p.product.sku, 60), handle: c(p.product.handle, 120), variant: String(p.product.variant || '').replace(/\D/g, '').slice(0, 20) } : null;
  const cart = p.cart && typeof p.cart === 'object' && Array.isArray(p.cart.items) ? { items: p.cart.items.slice(0, 10).map((x) => c(x, 120)), total: Math.max(0, Number(p.cart.total) || 0) } : null;
  const sections = Array.isArray(p.sections) ? [...new Set(p.sections.map((x) => c(x, 60)).filter((x) => x.length >= 3))].slice(0, 25) : [];
  return { url: url.slice(0, 300), title: String(p.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 150), ...(pr && Object.values(pr).some(Boolean) ? { product: pr } : {}), ...(cart ? { cart } : {}), ...(sections.length ? { sections } : {}), ...(p.form === true ? { form: true } : {}) };
}

/**
 * The pop-up greeting: a small bubble beside the button (the chat window only opens when they tap), shown once per
 * browsing session after a short delay – or earlier when a desktop visitor heads to leave – and never again in that
 * session once they chat or close it. Remembered in sessionStorage only, with no identifier (UK PECR: the safest
 * route; nothing persists after the tab closes). Defaults follow common practice: 10s desktop, 15s on phones.
 */
export function openerConfig(t) {
  const W = t.settings.webchat || {};
  const O = W.opener || {};
  if (O.enabled === false || (O.enabled === undefined && W.launcherText === '')) return null;
  const n = (v, d, max) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.min(x, max) : d; };
  const rules = [
    ...(Array.isArray(O.pages) ? O.pages : []).filter((r) => r?.match && r?.text).slice(0, 20).map((r) => ({ m: String(r.match).toLowerCase().slice(0, 100), t: String(r.text).slice(0, 200) })),
    ...(O.pageRules === false ? [] : PAGE_OPENERS.map((r) => ({ m: r.match, t: r.text, re: 1 }))),
  ];
  const own = menuOptions(t.settings).slice(0, 3).map((o, i) => ({ id: `wm:${i}`, label: String(o.label).trim().slice(0, 24) }));
  const S = t.settings;
  const chips = own.length ? own : S.store?.type === 'none'
    ? [{ id: 'book', label: String(S.business.bookingButton || '📅 Book now').slice(0, 24) }, { id: 'ask', label: '❓ Ask a question' }, { id: 'human', label: '🙋 Talk to a person' }]
    : [{ id: 'browse', label: '🛍️ Browse products' }, { id: 'status', label: '📦 Track my order' }, { id: 'human', label: '🙋 Talk to a person' }];
  const type = S.store?.type;
  const platform = type === 'woocommerce' ? 'woocommerce' : ['shopify', 'shopify_public'].includes(type) ? 'shopify' : null;
  const host = (u) => { try { return new URL(/^https?:\/\//.test(u) ? u : `https://${u}`).host.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
  const hosts = [S.store?.shopify?.domain, S.store?.shopify?.origin, S.store?.woocommerce?.url, S.business?.website, ...(S.store?.siteDomains || [])].map((x) => host(x || '')).filter(Boolean);
  const freeDelivery = Number(S.webchat?.freeDeliveryOver ?? S.ordering?.freeDeliveryOver) || 0;
  return { text: String(O.text || DEFAULT_OPENER).slice(0, 200), rules, chips: O.chips === false ? [] : chips, delay: n(O.delaySeconds, 10, 120), mobileDelay: n(O.mobileDelaySeconds, 15, 180), exit: O.exitIntent !== false,
    site: platform && hosts.length && S.ordering?.siteCart !== false ? { platform, hosts: [...new Set(hosts)] } : null, freeDelivery, sym: S.business?.currencySymbol || '£' };
}
export { openerFor };

/** The optional form before the website chat (off by default): settings.webchat.preChat = { enabled, required, email, phone, intro }. */
export function preChatConfig(t) {
  const P = t.settings.webchat?.preChat || {};
  if (!P.enabled) return null;
  return { required: !!P.required, email: P.email !== false, phone: P.phone !== false, intro: String(P.intro || 'Before we start, who are we chatting with? So the team can get back to you if we get cut off.').slice(0, 200) };
}

export function webchatRouter() {
  const r = express.Router();
  r.use('/chat', cors);
  const limiter = rateLimit({ max: 40, key: (req) => `${req.ip}:${req.params.tenantId}` });

  r.post('/chat/:tenantId/message', limiter, async (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t?.active || t.settings.webchat?.enabled === false) return res.status(404).json({ error: 'chat unavailable' });
    const { sessionId, text, actionId } = req.body || {};
    const page = cleanPage(req.body?.page);
    const utm = cleanUtm(req.body?.utm);
    if (!SESSION.test(String(sessionId || ''))) return res.status(400).json({ error: 'invalid session' });
    if (!text && !actionId) return res.status(400).json({ error: 'empty message' });
    if (isDemo(t)) {
      if (Date.parse(t.settings.demo.expiresAt) < Date.now()) return res.status(404).json({ error: 'This demo has expired' });
      const used = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'in'").get(t.id).n;
      if (used >= DEMO_MESSAGE_CAP) return res.json({ replies: [{ type: 'text', text: "That's the end of the demo 🙂 Start your free trial to keep this assistant and carry on." }] });
    }
    if (!withinLimit(t, 'inbound')) return res.json({ replies: [{ type: 'text', text: `Thanks for your message! The ${t.settings.business.name} team will get back to you soon.` }] });
    const waId = visitorId(sessionId);
    const ev = actionId
      ? { waId, kind: 'action', id: String(actionId).slice(0, 200), text: '', page, utm }
      : { waId, kind: 'text', text: String(text).slice(0, 2000), profileName: null, page, utm };
    logMessage(t.id, waId, 'in', { type: ev.kind, text: ev.kind === 'text' ? ev.text : `[${ev.id}]`, channel: 'web' });
    bumpUsage(t.id, 'inbound');
    const sink = [];
    const toVisitor = createSender(t, { sink });
    const real = createSender(t); // staff alerts etc. still go out on WhatsApp
    await enqueue(`${t.id}:${waId}`, () => handleInbound(t, ev, (to, m) => (to === waId ? toVisitor(to, m) : real(to, m))));
    const lastId = getDb().prepare('SELECT MAX(id) AS id FROM messages WHERE tenant_id = ? AND wa_id = ?').get(t.id, waId).id || 0;
    res.json({ replies: sink, lastId });
  });

  // The widget added (or failed to add) an item to the shop's own basket: note it in the chat for the inbox and reports
  r.post('/chat/:tenantId/event', limiter, (req, res) => {
    const t = getTenant(req.params.tenantId);
    const sessionId = String(req.body?.sessionId || '');
    if (!t?.active) return res.sendStatus(404);
    if (!SESSION.test(sessionId)) return res.status(400).json({ error: 'invalid session' });
    const ev = req.body || {};
    if (ev.type !== 'site_cart') return res.status(400).json({ error: 'unknown event' });
    const ok = ev.ok === true;
    const title = String(ev.title || 'item').slice(0, 120), qty = Math.max(1, Math.min(99, Number(ev.quantity) || 1));
    logMessage(t.id, visitorId(sessionId), 'in', { type: 'event', text: `[site basket: ${ok ? 'added' : 'could not add'} ${qty} × ${title}${ok && ev.itemCount ? ` – ${Number(ev.itemCount)} item(s) in basket` : ''}]`, channel: 'web', siteCart: { ok, title, qty, error: ok ? undefined : String(ev.error || '').slice(0, 200) } });
    if (ok) bumpUsage(t.id, 'site_cart_adds');
    res.json({ ok: true });
  });

  // "Continue on WhatsApp": a one-use code that carries this chat (basket, page, what was said) across
  r.post('/chat/:tenantId/handoff', limiter, (req, res) => {
    const t = getTenant(req.params.tenantId);
    const num = String(t?.settings?.business?.whatsappNumber || '').replace(/\D/g, '');
    const sessionId = String(req.body?.sessionId || '');
    if (!t?.active || !num) return res.status(404).json({ error: 'WhatsApp is not connected for this shop' });
    if (!SESSION.test(sessionId)) return res.status(400).json({ error: 'invalid session' });
    const code = createHandoff(t.id, visitorId(sessionId));
    const text = `Hi! I'd like to continue my chat from your website (ref ${code})`;
    res.json({ code, url: `https://wa.me/${num}?text=${encodeURIComponent(text)}` });
  });

  r.post('/chat/:tenantId/typing', limiter, (req, res) => {
    const sessionId = String(req.body?.sessionId || '');
    if (!SESSION.test(sessionId) || !getTenant(req.params.tenantId)?.active) return res.sendStatus(204);
    if (typingAt.size > 5000) typingAt.clear();
    typingAt.set(`${req.params.tenantId}:${visitorId(sessionId)}`, Date.now());
    res.sendStatus(204);
  });

  // The short form before the chat: name, email, phone (whichever the shop asks for)
  r.post('/chat/:tenantId/profile', limiter, (req, res) => {
    const t = getTenant(req.params.tenantId);
    const sessionId = String(req.body?.sessionId || '');
    if (!t?.active) return res.sendStatus(404);
    if (!SESSION.test(sessionId)) return res.status(400).json({ error: 'invalid session' });
    const P = preChatConfig(t);
    const c = (v, n) => String(v ?? '').replace(/[\r\n<>]+/g, ' ').trim().slice(0, n);
    const name = c(req.body?.name, 80), email = c(req.body?.email, 200).toLowerCase(), phone = c(req.body?.phone, 30);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Please check your email address' });
    if (phone && phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Please check your phone number' });
    if (P?.required && (!name || (P.email && P.phone ? !email && !phone : (P.email && !email) || (P.phone && !phone)))) return res.status(400).json({ error: 'Please fill in your details to start the chat' });
    const waId = visitorId(sessionId);
    const d = getDb();
    d.prepare("INSERT INTO customers (tenant_id, wa_id, name, last_seen_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(tenant_id, wa_id) DO UPDATE SET last_seen_at = datetime('now')").run(t.id, waId, name || null);
    if (name) d.prepare('UPDATE customers SET name = ? WHERE tenant_id = ? AND wa_id = ?').run(name, t.id, waId);
    if (email) d.prepare('UPDATE customers SET email = ? WHERE tenant_id = ? AND wa_id = ?').run(email, t.id, waId);
    if (phone) d.prepare("UPDATE customers SET attributes = json_set(COALESCE(attributes, '{}'), '$.phone', ?) WHERE tenant_id = ? AND wa_id = ?").run(phone, t.id, waId);
    if (name || email || phone) logMessage(t.id, waId, 'in', { type: 'event', text: `[visitor details: ${[name, email, phone].filter(Boolean).join(' · ')}]`, channel: 'web' });
    res.json({ ok: true });
  });

  // A photo or PDF from the visitor (sent as the raw file): saved, shown in the Inbox, and the team is asked to look.
  r.post('/chat/:tenantId/upload', limiter, express.raw({ type: () => true, limit: MAX_FILE_BYTES }), async (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t?.active || t.settings.webchat?.enabled === false || t.settings.webchat?.uploads === false) return res.status(404).json({ error: 'Sending files is not available here' });
    const sessionId = String(req.query.sessionId || '');
    if (!SESSION.test(sessionId)) return res.status(400).json({ error: 'invalid session' });
    if (isDemo(t)) return res.status(403).json({ error: "Sending files isn't part of the demo." });
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = FILE_TYPES[mime];
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!ext || !buf?.length || !MAGIC[ext](buf)) return res.status(400).json({ error: 'Please send a photo (JPG, PNG, WebP or GIF) or a PDF, up to 5 MB.' });
    const waId = visitorId(sessionId);
    const today = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND wa_id = ? AND type = 'file' AND created_at > datetime('now', '-1 day')").get(t.id, waId).n;
    if (today >= FILES_PER_DAY) return res.status(429).json({ error: "That's the most files we can take today – please email them to us instead." });
    if (!withinLimit(t, 'inbound')) return res.json({ replies: [{ type: 'text', text: `Thanks! The ${t.settings.business.name} team will get back to you soon.` }] });
    const name = String(req.query.name || `file.${ext}`).replace(/[\u0000-\u001f<>"\\/]+/g, ' ').trim().slice(0, 80) || `file.${ext}`;
    const dir = path.join(chatFilesDir(), t.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${randomBytes(16).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(dir, file), buf);
    if (Math.random() < 0.05) pruneFiles(dir);
    const fileUrl = `${config.publicUrl}/chat-files/${encodeURIComponent(t.id)}/${file}`;
    logMessage(t.id, waId, 'in', { type: 'file', text: `📎 [${ext === 'pdf' ? 'PDF' : 'photo'}: ${name}]`, channel: 'web', fileUrl, fileName: name, mime });
    bumpUsage(t.id, 'inbound');
    const sink = [{ type: 'text', text: `📎 Thanks – we've got *${name}*.` }];
    const conv = getDb().prepare('SELECT human_handover FROM conversations WHERE tenant_id = ? AND wa_id = ?').get(t.id, waId);
    if (!conv?.human_handover) {
      // ask the team to take a look (the usual hand-over: Inbox, email and staff WhatsApp alerts)
      const toVisitor = createSender(t, { sink });
      const real = createSender(t);
      await enqueue(`${t.id}:${waId}`, () => handleInbound(t, { waId, kind: 'action', id: 'human', text: '' }, (to, m) => (to === waId ? toVisitor(to, m) : real(to, m))));
    } else sink.push({ type: 'text', text: 'Our team will take a look and reply here.' });
    const lastId = getDb().prepare('SELECT MAX(id) AS id FROM messages WHERE tenant_id = ? AND wa_id = ?').get(t.id, waId).id || 0;
    res.json({ replies: sink, lastId });
  });

  r.get('/chat-files/:tenantId/:file', (req, res) => {
    const m = String(req.params.file).match(/^([a-f0-9]{32})\.(jpg|png|webp|gif|pdf)$/);
    if (!m || !/^[\w-]+$/.test(req.params.tenantId)) return res.sendStatus(404);
    const p = path.join(chatFilesDir(), req.params.tenantId, req.params.file);
    if (!fs.existsSync(p)) return res.sendStatus(404);
    res.set({ 'Content-Type': MIME[m[2]], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'X-Robots-Tag': 'noindex' });
    if (m[2] === 'pdf') res.set('Content-Disposition', `inline; filename="file.pdf"`);
    fs.createReadStream(p).pipe(res);
  });

  // A full-page chat with its own link (emails, social bios, QR codes, ads)
  r.get('/c/:tenantId', (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t?.active || t.settings.webchat?.enabled === false) return res.status(404).send('This chat is not available.');
    res.type('html').send(chatPageHtml(t));
  });

  // New messages for the visitor (staff replies from the inbox, reminders)
  r.get('/chat/:tenantId/poll', limiter, (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t?.active) return res.sendStatus(404);
    const sessionId = String(req.query.sessionId || '');
    if (!SESSION.test(sessionId)) return res.status(400).json({ error: 'invalid session' });
    const after = Number(req.query.after) || 0;
    const rows = getDb().prepare("SELECT id, body FROM messages WHERE tenant_id = ? AND wa_id = ? AND direction = 'out' AND id > ? ORDER BY id LIMIT 20").all(t.id, visitorId(sessionId), after);
    res.json({ messages: rows.map((m) => json(m.body, {})), lastId: rows.at(-1)?.id || after });
  });

  // The embeddable widget: <script src="https://YOUR_SERVER/chat-widget/<tenantId>.js" async></script>
  r.get('/chat-widget/:tenantId.js', (req, res) => {
    const t = getTenant(req.params.tenantId);
    res.type('application/javascript').set('Cache-Control', 'public, max-age=300');
    if (!t?.active || t.settings.webchat?.enabled === false) return res.send('/* chat widget disabled */');
    noteWidgetSeen(t.id, req.get('referer'));
    const W = t.settings.webchat || {};
    const cfg = {
      api: `${config.publicUrl}/chat/${t.id}`,
      tenant: t.id,
      title: W.title || t.settings.business.name,
      subtitle: W.subtitle || 'Ask us anything – we usually reply instantly',
      color: /^#[0-9a-f]{3,8}$/i.test(W.color || '') ? W.color : t.settings.storefront?.brandColor || '#128c4a',
      position: W.position === 'left' ? 'left' : 'right',
      greeting: W.greeting || 'Hi',
      launcher: String(W.launcherText ?? DEFAULT_LAUNCHER).slice(0, 120), // static speech bubble beside the button when the pop-up greeting is off; '' hides it
      opener: openerConfig(t),
      whatsapp: t.settings.business.whatsappNumber ? String(t.settings.business.whatsappNumber).replace(/\D/g, '') : null,
      upload: W.uploads !== false && !isDemo(t),
      sound: W.sound !== false, // a soft ping when a reply arrives (the visitor can mute it)
      preChat: preChatConfig(t),
      rating: W.rating !== false && !isDemo(t), // "How did we do?" after a few messages and a quiet spell
      badge: PLANS[t.plan]?.badge ? { text: `Powered by ${config.productName}`, url: `${config.publicUrl}/?ref=chat-${encodeURIComponent(t.id)}` } : null,
    };
    res.send(WIDGET.replace('__CFG__', JSON.stringify(cfg).replace(/</g, '\\u003c')));
  });
  return r;
}

export const DEFAULT_LAUNCHER = "Hello! I'm the chat assistant. Talk to me anytime.";

const WIDGET = String.raw`(function(){
if(window.__waChat)return;window.__waChat=1;
var C=__CFG__,d=document,K='wachat-'+C.tenant,sid,last=0,open=false,polling,busy=0;
var CS=d.currentScript,EMB=null;try{var sel=CS&&CS.getAttribute('data-embed');if(sel)EMB=d.querySelector(sel)}catch(e){}
try{sid=localStorage.getItem(K)}catch(e){}
if(!sid){sid=(crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+Date.now()).replace(/[^A-Za-z0-9]/g,'').slice(0,32);try{localStorage.setItem(K,sid)}catch(e){}}
var css='.wc{position:fixed;bottom:20px;'+C.position+':20px;z-index:2147483000;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111}'+
'.wc-b{width:68px;height:68px;border-radius:50%;border:0;background:'+C.color+';color:#fff;font-size:32px;line-height:1;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:transform .15s}.wc-b:hover{transform:scale(1.06)}.wc-b:focus-visible{outline:3px solid #fff;outline-offset:2px}'+
'.wc-l{position:absolute;bottom:12px;'+C.position+':80px;width:max-content;max-width:min(240px,calc(100vw - 120px));background:#fff;color:#111;padding:10px 30px 10px 14px;border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.18);font-size:14px;line-height:1.35;cursor:pointer;animation:wcin .3s ease-out}'+
'.wc-l:after{content:"";position:absolute;bottom:16px;'+(C.position==='left'?'left:-6px':'right:-6px')+';width:12px;height:12px;background:#fff;transform:rotate(45deg)}'+
'.wc-lx{position:absolute;top:4px;right:6px;border:0;background:none;color:#889;font-size:16px;line-height:1;cursor:pointer;padding:2px}.wc.open .wc-l{display:none}'+
'.wc-l.op{max-width:min(280px,calc(100vw - 110px));padding:12px 30px 12px 14px}.wc-l.op b{display:block;font-size:12px;color:#667;font-weight:600;margin-bottom:2px}.wc-lc{display:flex;flex-direction:column;gap:5px;margin-top:9px}.wc-lc button{border:1px solid #d6ddd9;background:#fff;color:'+C.color+';border-radius:10px;padding:8px 10px;min-height:44px;cursor:pointer;font:inherit;font-size:13px;text-align:left}.wc-lc button:hover,.wc-lc button:focus-visible{border-color:'+C.color+'}.wc-lt{display:block;margin-top:7px;min-height:32px;font-size:12px;color:#667;text-decoration:underline;cursor:pointer;background:none;border:0;padding:0;font:inherit}'+
'@keyframes wcin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media (prefers-reduced-motion:reduce){.wc-l{animation:none}.wc-b{transition:none}}'+
'.wc-p{position:absolute;bottom:84px;'+C.position+':0;width:min(370px,calc(100vw - 32px));height:min(560px,calc(100vh - 110px));background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden}'+
'.wc-p.on{display:flex}.wc-h{background:'+C.color+';color:#fff;padding:12px 14px}.wc-h b{display:block;font-size:15px}.wc-h span{opacity:.85;font-size:12px}.wc-x{float:right;background:none;border:0;color:#fff;font-size:20px;cursor:pointer}'+
'.wc-m{flex:1;overflow-y:auto;padding:12px;background:#f4f6f5;display:flex;flex-direction:column;gap:6px}.wc-q{max-width:85%;padding:8px 10px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}'+
'.wc-q.u{align-self:flex-end;background:'+C.color+';color:#fff}.wc-q.a{align-self:flex-start;background:#fff;box-shadow:0 1px 1px rgba(0,0,0,.06)}.wc-q img{max-width:100%;border-radius:8px;display:block;margin-bottom:4px}'+
'.wc-c{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.wc-c button,.wc-c a{border:1px solid #d6ddd9;background:#fff;color:'+C.color+';border-radius:9px;padding:5px 9px;cursor:pointer;font:inherit;font-size:13px;text-decoration:none}'+
'.wc-f{display:flex;gap:6px;padding:8px;border-top:1px solid #e3e8e5;background:#fff}.wc-f input{flex:1;border:1px solid #d6ddd9;border-radius:10px;padding:9px;font:inherit}.wc-f button{border:0;background:'+C.color+';color:#fff;border-radius:10px;padding:0 14px;cursor:pointer;font:inherit}'+
'.wc-cal{margin-top:8px}.wc-cal b{font-size:13px}.wc-g{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-top:4px;text-align:center;font-size:12px}.wc-g i{font-style:normal;color:#889}.wc-g button{border:1px solid '+C.color+';background:#fff;color:'+C.color+';border-radius:8px;padding:0;min-height:32px;cursor:pointer;font:inherit;font-weight:600}.wc-g button:hover{background:'+C.color+';color:#fff}.wc-g .x{color:#c8ced0;line-height:32px}'+
'.wc-w{font-size:12px;text-align:center;padding:4px;color:#667}.wc-w a{color:inherit}.wc-t{align-self:flex-start;color:#889;font-size:12px}'+
'.wc-pc{background:#fff;border-radius:12px;padding:12px;box-shadow:0 1px 1px rgba(0,0,0,.06);display:flex;flex-direction:column;gap:7px}.wc-pc input{border:1px solid #d6ddd9;border-radius:9px;padding:9px;font:inherit}.wc-pc button{border:0;background:'+C.color+';color:#fff;border-radius:9px;padding:9px;cursor:pointer;font:inherit}.wc-pc .sk{background:none;color:#667;text-decoration:underline;padding:2px}.wc-pc small{color:#667}.wc-pc .er{color:#b42318;font-size:12px}'+
'.wc-snd{float:right;background:none;border:0;color:#fff;font-size:15px;cursor:pointer;opacity:.85;padding:4px 6px}'+
'.wc-lf{display:flex;gap:5px;margin-top:8px}.wc-lf input{flex:1;min-width:0;border:1px solid #d6ddd9;border-radius:10px;padding:8px 9px;font:inherit;font-size:13px}.wc-lf button{border:0;background:'+C.color+';color:#fff;border-radius:10px;padding:0 11px;cursor:pointer;font:inherit;font-size:13px}'+
'.wc-f .wc-up{background:#fff;color:'+C.color+';border:1px solid #d6ddd9;padding:0 10px;font-size:18px}'+
'.wc.wc-in{position:relative;bottom:auto;left:auto;right:auto;z-index:auto;height:100%;min-height:360px}.wc-in .wc-p{position:relative;bottom:auto;left:auto;right:auto;width:100%;height:100%;display:flex;box-shadow:0 2px 12px rgba(0,0,0,.12)}.wc-in .wc-b,.wc-in .wc-x{display:none}';
var st=d.createElement('style');st.textContent=css;d.head.appendChild(st);
var w=d.createElement('div');w.className='wc';
w.innerHTML='<div class="wc-p" role="dialog" aria-label="Chat"><div class="wc-h"><button class="wc-x" aria-label="Close">×</button>'+(C.sound?'<button class="wc-snd" aria-label="Sound on" title="Sound on/off">🔔</button>':'')+'<b></b><span></span></div><div class="wc-m" aria-live="polite"></div><form class="wc-f">'+(C.upload?'<button type="button" class="wc-up" aria-label="Send a photo or PDF" title="Send a photo or PDF">📎</button><input type="file" class="wc-fi" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" hidden>':'')+'<input class="wc-in-t" placeholder="Type a message…" aria-label="Message" maxlength="1000"><button>Send</button></form>'+(C.badge?'<div class="wc-w" style="font-size:11px;opacity:.75"><a class="wc-pb" target="_blank" rel="noopener"></a></div>':'')+(C.whatsapp?'<div class="wc-w">📱 <a class="wc-wa" target="_blank" rel="noopener" href="https://wa.me/'+C.whatsapp+'">Continue on WhatsApp</a> – your chat comes with you</div>':'')+'</div>'+(!EMB&&(C.launcher||C.opener)?'<div class="wc-l" role="button" tabindex="0"><button class="wc-lx" aria-label="Hide message">×</button><span></span></div>':'')+'<button class="wc-b" aria-label="Open chat">💬</button>';
w.querySelector('.wc-h b').textContent=C.title;w.querySelector('.wc-h span').textContent=C.subtitle;
var P=w.querySelector('.wc-p'),M=w.querySelector('.wc-m'),F=w.querySelector('form'),I=F.querySelector('.wc-in-t');
function mark(k,v,ss){try{(ss?sessionStorage:localStorage).setItem(k,v)}catch(e){}}
function got(k,ss){try{return (ss?sessionStorage:localStorage).getItem(k)}catch(e){return null}}
function prod(){try{var out=null;[].slice.call(d.querySelectorAll('script[type="application/ld+json"]')).some(function(s){var j=JSON.parse(s.textContent),list=[].concat(j&&j['@graph']||j);for(var i=0;i<list.length;i++){var x=list[i],ty=x&&x['@type'];if(ty==='Product'||(Array.isArray(ty)&&ty.indexOf('Product')>=0)){var o=[].concat(x.offers||[])[0]||{};if(o['@type']==='AggregateOffer')o={price:o.lowPrice,priceCurrency:o.priceCurrency,availability:o.availability};out={name:x.name,price:o.price,currency:o.priceCurrency,availability:String(o.availability||'').replace(/^https?:\/\/schema\.org\//,''),sku:x.sku};return true}}return false});
  var mm=location.pathname.match(/\/products\/([^\/?#]+)/);if(mm){out=out||{};out.handle=decodeURIComponent(mm[1]);var vv=new URLSearchParams(location.search).get('variant');if(vv)out.variant=vv}return out}catch(e){return null}}
var CART=null;
function vis(el){return !!(el.offsetWidth||el.offsetHeight||el.getClientRects().length)}
var NOISE='.wc,[role="dialog"],[aria-modal],dialog,cart-drawer,.cart-drawer,[id*="cookie" i],[class*="cookie" i],[class*="consent" i],a,[class*="card" i],[class*="recommend" i],[class*="related" i],footer,nav,header';
function secs2(){var out=[],seen={};[].slice.call(d.querySelectorAll('h1,h2,h3,summary,[role="tab"],dt,.accordion__title,.collapsible-trigger')).forEach(function(el){if(el.closest(NOISE)||out.length>=25)return;var t=String(el.textContent||'').replace(/\s+/g,' ').trim();if(t.length<3||t.length>60||seen[t.toLowerCase()]||!vis(el)&&el.tagName!=='SUMMARY')return;seen[t.toLowerCase()]=1;out.push(t)});return out}
function theForm(){var best=null;[].slice.call(d.forms).forEach(function(f){if(f.closest('.wc')||f.querySelector('input[type="password"]'))return;if(!f.querySelector('input[type="email"],input[type="tel"],textarea,input[name*="mail" i],input[name*="phone" i]'))return;if(/search/i.test((f.getAttribute('role')||'')+(f.action||'')+(f.className||'')))return;if(!best||f.elements.length>best.elements.length)best=f});return best}
function pg(){return{url:location.origin+location.pathname,title:String(d.title||'').slice(0,150),product:prod()||undefined,cart:CART||undefined,sections:secs2(),form:!!theForm()}}
function findSection(name){var n=String(name||'').toLowerCase().trim(),hit=null;[].slice.call(d.querySelectorAll('h1,h2,h3,h4,summary,[role="tab"],dt,.accordion__title,.collapsible-trigger,button,label')).some(function(el){if(el.closest(NOISE))return false;var t=String(el.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();if(t===n||(n.length>3&&t.indexOf(n)===0)){hit=el;return true}return false});return hit}
function showSection(name){var el=findSection(name);if(!el)return false;var det=el.closest('details');if(det)det.open=true;if(el.getAttribute('role')==='tab'||el.tagName==='SUMMARY'||/accordion|collapsible/.test(el.className))try{if(el.tagName!=='SUMMARY')el.click()}catch(e){}
  if(window.matchMedia&&matchMedia('(max-width:640px)').matches&&open)toggle();
  el.scrollIntoView({behavior:'smooth',block:'center'});var o=el.style.outline,oo=el.style.outlineOffset;el.style.outline='3px solid '+C.color;el.style.outlineOffset='4px';setTimeout(function(){el.style.outline=o;el.style.outlineOffset=oo},3500);return true}
function fillForm(m){var f=theForm(),F=m.fields||{},done=[];if(!f){add('I couldn\'t find the form on this page – no problem, our team has your details.','a');return}
  var set=function(el,v){if(!el||!v||el.value)return;var p=Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value');p.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));done.push(el)};
  var lab=function(el){var l=el.id&&f.querySelector('label[for="'+el.id+'"]');return ((el.name||'')+' '+(el.id||'')+' '+(el.placeholder||'')+' '+(el.getAttribute('aria-label')||'')+' '+(l?l.textContent:'')).toLowerCase()};
  var els=[].slice.call(f.querySelectorAll('input,textarea')).filter(function(el){return !/hidden|submit|button|checkbox|radio|file|password/.test(el.type)});
  var pick=function(test){return els.filter(function(el){return done.indexOf(el)<0&&test(el,lab(el))})[0]};
  var first=(F.name||'').split(' ')[0],last=(F.name||'').split(' ').slice(1).join(' ');
  set(pick(function(el,l){return el.type==='email'||/e-?mail/.test(l)}),F.email);
  set(pick(function(el,l){return el.type==='tel'||/phone|mobile|tel\b|contact number/.test(l)}),F.phone);
  var fn=pick(function(el,l){return /first.?name|forename|given/.test(l)});if(fn){set(fn,first);set(pick(function(el,l){return /last.?name|surname|family/.test(l)}),last)}else set(pick(function(el,l){return /name/.test(l)&&!/company|business|user/.test(l)}),F.name);
  set(pick(function(el,l){return el.tagName==='TEXTAREA'||/message|enquir|inquir|details|comment|requirement/.test(l)}),F.message);
  f.scrollIntoView({behavior:'smooth',block:'center'});var btn=f.querySelector('[type="submit"],button:not([type]),button[type="submit"]');if(btn){var o=btn.style.outline;btn.style.outline='3px solid '+C.color;setTimeout(function(){btn.style.outline=o},5000)}
  if(window.matchMedia&&matchMedia('(max-width:640px)').matches&&open)toggle();
  add(done.length?'✅ I\'ve filled in '+done.length+' field'+(done.length>1?'s':'')+' on the form – please check them and press its send button.':'I couldn\'t match the form\'s fields – our team has your details anyway.','a')}
var UTM=null;try{var q=new URLSearchParams(location.search),u={};['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(function(k){if(q.get(k))u[k]=q.get(k).slice(0,80)});if(Object.keys(u).length)sessionStorage.setItem(K+'-utm',JSON.stringify(u));UTM=JSON.parse(sessionStorage.getItem(K+'-utm')||'null')}catch(e){}
function esc(s){var e=d.createElement('div');e.textContent=s==null?'':String(s);return e.innerHTML}
function fmt(s){return esc(s).replace(/\*([^*\n]+)\*/g,'<b>$1</b>').replace(/(^|\s)_([^_\n]+)_/g,'$1<i>$2</i>').replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>')}
var AC=null,MUTE=got(K+'-mute')==='1';
function ping(){if(!C.sound||MUTE)return;try{AC=AC||new (window.AudioContext||window.webkitAudioContext)();if(AC.state==='suspended')AC.resume();var t=AC.currentTime,o=AC.createOscillator(),g=AC.createGain();o.type='sine';o.frequency.setValueAtTime(880,t);o.frequency.setValueAtTime(1320,t+0.09);g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(0.12,t+0.02);g.gain.exponentialRampToValueAtTime(0.0001,t+0.3);o.connect(g);g.connect(AC.destination);o.start(t);o.stop(t+0.32)}catch(e){}}
function add(html,cls){var b=d.createElement('div');b.className='wc-q '+cls;b.innerHTML=html;M.appendChild(b);M.scrollTop=M.scrollHeight;return b}
function cal(c){var free={};c.days.forEach(function(x){free[x.ymd]=x.free});var keys=Object.keys(free).sort(),h='',p2=function(n){return (n<10?'0':'')+n};
  var f=new Date(keys[0]+'T12:00:00Z'),l=new Date(keys[keys.length-1]+'T12:00:00Z'),cur=new Date(Date.UTC(f.getUTCFullYear(),f.getUTCMonth(),1,12));
  while(cur<=l){var y=cur.getUTCFullYear(),mo=cur.getUTCMonth(),pad=(cur.getUTCDay()+6)%7,n=new Date(Date.UTC(y,mo+1,0,12)).getUTCDate();
    h+='<div class="wc-cal"><b>'+esc(cur.toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'}))+'</b><div class="wc-g" role="grid">'+['Mo','Tu','We','Th','Fr','Sa','Su'].map(function(x){return '<i>'+x+'</i>'}).join('');
    for(var i=0;i<pad;i++)h+='<span></span>';
    for(var dd=1;dd<=n;dd++){var k=y+'-'+p2(mo+1)+'-'+p2(dd),lab=new Date(k+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
      h+=free[k]?'<button data-a="'+esc(c.idPrefix+k)+'" data-l="'+esc(lab)+'" aria-label="'+esc(lab+', '+free[k]+' free')+'">'+dd+'</button>':'<span class="x" aria-hidden="true">'+dd+'</span>'}
    h+='</div></div>';cur=new Date(Date.UTC(y,mo+1,1,12))}
  return h}
function siteAdd(m){
  var b=add(esc(m.text),'a'),it=m.items[0];
  var done=function(ok,count,err){
    b.innerHTML=ok?'✅ Added '+esc(m.quantity+' × '+m.title)+' to your basket'+(count?' ('+count+' item'+(count>1?'s':'')+' in it)':'')+'.'+(err?'<br><small>'+esc(err)+'</small>':'')+'<div class="wc-c"><a href="'+esc(m.cartUrl)+'">🛒 View basket</a><a href="'+esc(m.checkoutUrl)+'">💳 Checkout</a></div>'
      :'Sorry, I couldn\'t add it to the basket automatically. <div class="wc-c"><a href="'+esc(m.cartUrl)+'">🛒 Open the basket</a></div>';
    fetch(C.api+'/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,type:'site_cart',ok:ok,title:m.title,quantity:m.quantity,itemCount:count||0,error:err||''})}).catch(function(){});
  };
  var secs=function(S){if(!S)return;try{Object.keys(S).forEach(function(k){var el=d.getElementById(k)||d.getElementById('shopify-section-'+k);if(!el||!S[k])return;var tmp=d.createElement('div');tmp.innerHTML=S[k];var inner=tmp.querySelector('#'+k)||tmp.firstElementChild;if(inner&&k==='cart-icon-bubble')el.innerHTML=inner.innerHTML})}catch(e){}};
  // Shopify's standard cart actions (2026 themes) refresh the drawer and count themselves
  try{if(m.platform==='shopify'&&window.Shopify&&Shopify.actions&&typeof Shopify.actions.updateCart==='function'){m.std=1}}catch(e){}
  var refresh=function(){try{if(m.std&&Shopify.actions.getCart)Shopify.actions.getCart()}catch(e){}['cart:refresh','cart:updated','cart:change'].forEach(function(n){try{d.dispatchEvent(new CustomEvent(n,{bubbles:true}))}catch(e){}});
    try{if(window.jQuery){window.jQuery(d.body).trigger('wc_fragment_refresh')}}catch(e){}};
  if(m.platform==='shopify'){
    fetch('/cart/add.js',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({items:[{id:Number(it.id),quantity:it.quantity,properties:{_via_chat:'yes'}}],sections:'cart-icon-bubble,cart-drawer'})})
    .then(function(r){return r.json().then(function(j){if(!r.ok){m.note=j.description||j.message||'';if(r.status!==422)throw new Error(m.note||('HTTP '+r.status))}else secs(j.sections);return j})})
    .then(function(){return fetch('/cart/update.js',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({attributes:{'Chat assistant':'yes'}})}).catch(function(){})})
    .then(function(){return fetch('/cart.js',{credentials:'same-origin'}).then(function(r){return r.json()})})
    .then(function(c){var n=c&&c.item_count,line=(c&&c.items||[]).filter(function(x){return String(x.variant_id)===String(it.id)})[0];
      // Shopify says 422 when there isn't enough stock but may still add what it has: trust the basket
      if(!line){throw new Error(m.note||'not in basket')}
      if(line.quantity<m.quantity){m.quantity=line.quantity}
      d.querySelectorAll('[data-cart-count],.cart-count-bubble span[aria-hidden],.cart-count,.cart_count').forEach(function(el){if(n!=null)el.textContent=n});refresh();done(true,n,m.note)})
    .catch(function(e){done(false,0,String(e&&e.message||e))});
  }else{
    var fd=new FormData();fd.append('product_id',it.id);fd.append('quantity',it.quantity);
    fetch('/?wc-ajax=add_to_cart',{method:'POST',credentials:'same-origin',body:fd}).then(function(r){return r.json()})
    .then(function(j){if(!j||j.error)throw new Error('not added');try{if(window.jQuery)window.jQuery(d.body).trigger('added_to_cart',[j.fragments,j.cart_hash])}catch(e){}refresh();done(true,0)})
    .catch(function(e){done(false,0,String(e&&e.message||e))});
  }
}
function render(m){
  if(!m)return;var h='',acts=[];
  if(m.type==='image')h=(m.url?'<img alt="" src="'+esc(m.url)+'">':'')+fmt(m.caption||'');
  else if(m.type==='buttons'){h=(m.header?'<b>'+esc(m.header)+'</b>\n':'')+fmt(m.text);acts=m.buttons.map(function(b){return '<button data-a="'+esc(b.id)+'" data-l="'+esc(b.title)+'">'+esc(b.title)+'</button>'})}
  else if(m.type==='list'&&m.calendar&&m.calendar.days&&m.calendar.days.length){h=fmt(m.text)+cal(m.calendar)}
  else if(m.type==='list'){h=fmt(m.text);acts=[].concat.apply([],m.sections.map(function(s){return s.rows.map(function(r){return '<button data-a="'+esc(r.id)+'" data-l="'+esc(r.title)+'" title="'+esc(r.description||'')+'">'+esc(r.title)+'</button>'})}))}
  else if(m.type==='cta'){h=fmt(m.text);acts=['<a href="'+esc(m.url)+'" target="_blank" rel="noopener">'+esc(m.buttonText||'Open')+' ↗</a>']}
  else if(m.type==='site_cart'){siteAdd(m);return}
  else if(m.type==='fill_form'){fillForm(m);return}
  else if(m.type==='template'||m.type==='flow')h=fmt(m.text||'');
  else h=fmt(m.text||'');
  if(m.highlight&&findSection(m.highlight))acts.push('<button data-hl="'+esc(m.highlight)+'">👀 Show me on the page</button>');
  if(!h&&!acts.length)return;
  add(h+(acts.length?'<div class="wc-c">'+acts.join('')+'</div>':''),'a');
}
var sentN=0,rateT=null;
function rateLater(){if(!C.rating||got(K+'-rated',1)||sentN<3)return;clearTimeout(rateT);rateT=setTimeout(function(){if(busy||got(K+'-rated',1))return;mark(K+'-rated','1',1);render({type:'buttons',text:'How did we do today?',buttons:[{id:'rate:3',title:'😀 Great'},{id:'rate:2',title:'😐 OK'},{id:'rate:1',title:'😞 Not good'}]})},90000)}
function send(body,label){
  if(label)add(esc(label),'u');
  if(body.text){sentN++;clearTimeout(rateT)}if(body.actionId&&/^rate:/.test(body.actionId))mark(K+'-rated','1',1);
  var typing=add('…','a wc-t');busy++;
  if(body.text||(body.actionId&&body.actionId!=='open'))mark(K+'-chatted','1',1);
  fetch(C.api+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({sessionId:sid,page:pg(),utm:UTM||undefined},body))})
  .then(function(r){return r.json()}).then(function(r){busy--;typing.remove();(r.replies||[]).forEach(render);if((r.replies||[]).length)ping();if(r.lastId)last=Math.max(last,r.lastId);rateLater()})
  .catch(function(){busy--;typing.remove();add('Sorry – connection problem, please try again.','a')});
}
function poll(){if(busy)return;fetch(C.api+'/poll?sessionId='+sid+'&after='+last).then(function(r){return r.json()}).then(function(r){if(last&&r.messages&&r.messages.length){r.messages.forEach(render);ping()}last=Math.max(last,r.lastId||0)}).catch(function(){})}
var PB=w.querySelector('.wc-pb');if(PB){PB.textContent=C.badge.text;PB.href=C.badge.url}
var WA=w.querySelector('.wc-wa');if(WA)WA.onclick=function(e){e.preventDefault();var win=window.open('','_blank');fetch(C.api+'/handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid})}).then(function(r){return r.json()}).then(function(r){var u=r.url||WA.href;if(win)win.location=u;else location.href=u}).catch(function(){if(win)win.location=WA.href})};
M.addEventListener('click',function(e){var hl=e.target.closest('button[data-hl]');if(hl){showSection(hl.dataset.hl);return}var b=e.target.closest('button[data-a]');if(b)send({actionId:b.dataset.a},b.dataset.l)});
F.onsubmit=function(e){e.preventDefault();var v=I.value.trim();if(!v)return;I.value='';send({text:v},v)};
var lastTyping=0;I.addEventListener('input',function(){var n=Date.now();if(n-lastTyping<3000||!I.value)return;lastTyping=n;fetch(C.api+'/typing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid})}).catch(function(){})});
var SND=w.querySelector('.wc-snd');function sndIcon(){if(SND){SND.textContent=MUTE?'🔕':'🔔';SND.setAttribute('aria-label',MUTE?'Sound off':'Sound on')}}sndIcon();
if(SND)SND.onclick=function(){MUTE=!MUTE;mark(K+'-mute',MUTE?'1':'0');sndIcon();if(!MUTE)ping()};
window.waChat={ask:function(q){if(!open)toggle();send({text:q},q)}};
var UP=w.querySelector('.wc-up'),FI=w.querySelector('.wc-fi');
if(UP&&FI){UP.onclick=function(){FI.click()};FI.onchange=function(){var f=FI.files&&FI.files[0];FI.value='';if(!f)return;
  if(f.size>5242880){add('That file is too big – please send one under 5 MB.','a');return}
  add(esc('📎 '+f.name),'u');var typing=add('Sending…','a wc-t');busy++;
  fetch(C.api+'/upload?sessionId='+sid+'&name='+encodeURIComponent(f.name.slice(0,80)),{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream'},body:f})
  .then(function(r){return r.json()}).then(function(r){busy--;typing.remove();if(r.error)add(esc(r.error),'a');(r.replies||[]).forEach(render);if(r.lastId)last=Math.max(last,r.lastId)})
  .catch(function(){busy--;typing.remove();add('Sorry – the file didn\'t send, please try again.','a')})}}
var O=C.opener;
function preChat(go){var Q=C.preChat,b=d.createElement('div');b.className='wc-pc';
  b.innerHTML='<b></b>'+'<input class="n" placeholder="Your name" autocomplete="name" maxlength="80">'+(Q.email?'<input class="e" type="email" placeholder="Email" autocomplete="email" maxlength="200">':'')+(Q.phone?'<input class="p" type="tel" placeholder="Phone" autocomplete="tel" maxlength="30">':'')+'<span class="er"></span><button class="go">Start chat</button>'+(Q.required?'':'<button class="sk">Skip</button>')+'<small>We only use these to reply to you.</small>';
  b.querySelector('b').textContent=Q.intro;M.appendChild(b);
  var v=function(c){var x=b.querySelector(c);return x?x.value.trim():''};
  b.querySelector('.go').onclick=function(){fetch(C.api+'/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,name:v('.n'),email:v('.e'),phone:v('.p')})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Please check your details');b.remove();mark(K+'-pc','1');go()})}).catch(function(e){b.querySelector('.er').textContent=e.message})};
  var sk=b.querySelector('.sk');if(sk)sk.onclick=function(){b.remove();mark(K+'-pc','1');go()}}
function toggle(first,label){if(EMB&&open)return;open=!open;P.classList.toggle('on',open);w.classList.toggle('open',open);if(open){I.focus();if(L)L.style.display='none';if(!M.children.length){var go=function(){send(first||(O?{actionId:'open'}:{text:C.greeting}),label)};if(C.preChat&&!got(K+'-pc'))preChat(go);else go()}clearInterval(polling);polling=setInterval(poll,8000);poll()}else clearInterval(polling)}
w.querySelector('.wc-b').onclick=function(){toggle()};w.querySelector('.wc-x').onclick=function(){toggle()};
var L=w.querySelector('.wc-l');
function snoozed(){return got(K+'-hint')==='1'}
function textFor(){var p=location.pathname.toLowerCase();if(O.cartNudge)return O.cartNudge;for(var i=0;i<O.rules.length;i++){var r=O.rules[i],hit=false;try{hit=r.re?new RegExp(r.m,'i').test(p):p.indexOf(r.m)>=0}catch(e){}if(hit)return r.t}return O.text}
if(L&&O){
  L.className='wc-l op';L.style.display='none';L.setAttribute('role','status');L.setAttribute('aria-live','polite');L.setAttribute('aria-label','Message from '+C.title);L.removeAttribute('tabindex');
  var hide=function(){if(!L)return;L.remove();L=null;mark(K+'-closed','1',1);w.querySelector('.wc-b').focus()};
  d.addEventListener('keydown',function(e){if(e.key==='Escape'&&L&&L.style.display!=='none'&&!open)hide()});
  L.onclick=function(e){if(e.target.closest('.wc-lx')){e.stopPropagation();hide();return}var c=e.target.closest('button[data-a]');if(c){toggle({actionId:c.dataset.a},c.dataset.l);return}if(!e.target.closest('.wc-lc'))toggle()};
  var shown=false,mobile=window.matchMedia&&matchMedia('(max-width:640px)').matches;
  var onShop=O.site&&O.site.hosts.indexOf(location.host.replace(/^www\./,''))>=0,pr=onShop?prod():null;
  if(pr&&pr.handle&&O.site.platform==='shopify')O.chips=[{id:'p:'+pr.handle,label:'🛒 Add this to basket'}].concat(O.chips).slice(0,3);
  if(onShop&&O.site.platform==='shopify'&&/^\/cart\/?$/.test(location.pathname))fetch('/cart.js',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(c){
    CART={items:(c.items||[]).slice(0,10).map(function(i){return i.quantity+' × '+i.title}),total:(c.total_price||0)/100};
    var gap=O.freeDelivery?O.freeDelivery-CART.total:0;
    if(c.item_count&&gap>0){O.cartNudge='🚚 You\'re '+O.sym+gap.toFixed(2)+' away from free delivery. Want a suggestion to add?';O.chips=[{id:'say:Suggest something to add to my basket to reach free delivery',label:'💡 Suggest something'}].concat(O.chips).slice(0,3)}}).catch(function(){});
  var show=function(){if(shown||open||!L)return;shown=true;mark(K+'-shown','1',1);
    L.querySelector('span').innerHTML='<b>'+esc(C.title)+'</b>'+esc(textFor())+(O.chips.length?'<div class="wc-lc">'+O.chips.slice(0,mobile?2:3).map(function(c){return '<button data-a="'+esc(c.id)+'" data-l="'+esc(c.label)+'">'+esc(c.label)+'</button>'}).join('')+'</div>':'')+'<form class="wc-lf"><input placeholder="Type your question…" aria-label="Type your question" maxlength="500"><button type="submit">Send</button></form>';
    var LF=L.querySelector('.wc-lf');LF.onsubmit=function(e){e.preventDefault();e.stopPropagation();var v=LF.querySelector('input').value.trim();if(!v)return;toggle({text:v},v)};LF.onclick=function(e){e.stopPropagation()};
    L.style.display='';};
  if(got(K+'-chatted',1)||got(K+'-closed',1)||got(K+'-shown',1)){L.remove();L=null}
  else{setTimeout(show,(mobile?O.mobileDelay:O.delay)*1000);
    if(O.exit&&!mobile){var t0=Date.now();d.addEventListener('mouseout',function(e){if(!e.relatedTarget&&e.clientY<=0&&Date.now()-t0>5000)show()})}}
}else if(L){
  if(snoozed())L.remove();else{L.querySelector('span').textContent=C.launcher;
    L.onclick=function(e){if(e.target.closest('.wc-lx')){e.stopPropagation();L.remove();mark(K+'-hint','1');return}toggle()};
    L.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle()}}}}
if(EMB){w.classList.add('wc-in');EMB.appendChild(w);toggle()}else(d.body||d.documentElement).appendChild(w);
})();`;

/** Remember which website loaded the chat widget, so the shop's guide can say "we can see it on yourshop.co.uk". */
export function noteWidgetSeen(tenantId, referer) {
  let origin;
  try { origin = new URL(referer).origin; } catch { return; }
  if (!/^https?:/.test(origin) || origin === new URL(config.publicUrl).origin) return; // our own storefront doesn't count
  const d = getDb();
  const key = `widget_seen:${tenantId}`;
  const prev = json(d.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value, null);
  if (prev?.origin === origin && Date.now() - Date.parse(prev.at) < 3600000) return;
  d.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify({ origin, at: new Date().toISOString() }));
}
