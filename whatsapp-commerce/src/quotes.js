import express from 'express';
import crypto from 'node:crypto';
import { getDb, json } from './db.js';
import { config } from './config.js';
import { getTenant, bumpUsage } from './tenants.js';
import { chatCompletion, directConfigured } from './ai/direct.js';
import { retrieve } from './ai/rag.js';
import { emailShop, sendEmail } from './email.js';
import { createSender, notify } from './whatsapp/cloudApi.js';
import { sendHook } from './hooks.js';
import { pushTeam } from './push.js';

/*
 * Instant quotes: the customer says what they need, the AI drafts a quote from the business's own price list
 * (prices it can't find are marked "to confirm" – never guessed), and:
 *  - by default the team checks it on the Quotes tab and presses Send;
 *  - with settings.quotes.autoSend, a quote where every line has a price goes straight to the customer.
 * The customer gets a quote page (print / PDF, "Accept quote"), in the chat and by email; one friendly follow-up
 * after 2 days if they haven't answered. Accepting tells the team at once.
 * settings.quotes = { enabled, autoSend, validDays (30), replyHours (24) }
 */
const fail = (m, status = 400) => Object.assign(new Error(m), { status });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const quotesOn = (S) => S.quotes?.enabled === true;
const money = (n, sym = '£') => `${sym}${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function cleanItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 30).map((x) => {
    const qty = Math.max(1, Math.min(9999, Number(x?.qty) || 1));
    const price = x?.price === null || x?.price === '' || x?.price === undefined || !Number.isFinite(Number(x.price)) ? null : Math.round(Number(x.price) * 100) / 100;
    return { item: String(x?.item || '').trim().slice(0, 160), qty, price };
  }).filter((x) => x.item);
}
export const quoteTotal = (items) => Math.round(items.reduce((s, x) => s + (x.price || 0) * x.qty, 0) * 100) / 100;
const map = (q) => q && { ...q, items: json(q.items, []), photos: json(q.photos, []) };

/**
 * Photos the customer sent in this chat in the last 2 days, attached to their quote request so the team sees them
 * next to the draft. Website photos are links to the stored file; WhatsApp photos are opened through the dashboard
 * (they're fetched from Meta with the business's own token). The AI's description is kept as a hint only – it never
 * decides the price, and quotes still need the team's approval unless auto-send is switched on.
 */
export function chatPhotos(tenantId, waId) {
  if (!waId) return [];
  return getDb().prepare("SELECT type, body, created_at FROM messages WHERE tenant_id = ? AND wa_id = ? AND direction = 'in' AND type IN ('file', 'image') AND created_at > datetime('now', '-2 days') ORDER BY id DESC LIMIT 6").all(tenantId, waId)
    .map((m) => ({ ...json(m.body, {}), _type: m.type, at: m.created_at }))
    .filter((b) => b._type === 'image' || String(b.mime || '').startsWith('image/'))
    .map((b) => ({ url: b.fileUrl || null, mediaId: b.mediaId || null, hint: String(b.text || b.caption || '').replace(/^📎 \[photo: [^\]]*\]\s*(–\s*)?/, '').slice(0, 200) || null, at: b.at }))
    .reverse();
}
export const getQuote = (tenantId, number) => map(getDb().prepare('SELECT * FROM quotes WHERE tenant_id = ? AND number = ?').get(tenantId, Number(number)));
export const quoteByToken = (token) => map(getDb().prepare('SELECT * FROM quotes WHERE token = ?').get(String(token)));
export const listQuotes = (tenantId, { status } = {}) => getDb().prepare(`SELECT * FROM quotes WHERE tenant_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id DESC LIMIT 200`).all(...[tenantId, status].filter(Boolean)).map(map);
export const quoteUrl = (q) => `${config.publicUrl}/q/${q.token}`;

/** The AI's draft lines, from the business's own information only. */
export async function draftLines(tenant, request) {
  if (!directConfigured()) return { items: [], notes: '' };
  const kb = await retrieve(tenant.id, `${request} price cost fee`, { k: 6 }).catch(() => []);
  const r = await chatCompletion({ temperature: 0, maxTokens: 700, messages: [{ role: 'user', content: `Draft a quote for ${tenant.settings.business.name} from the customer's request, using ONLY prices in the business information below. If a price isn't there, use null (never guess). Quantities from the request (default 1).

Customer request: ${String(request).slice(0, 1500)}

Business information:
${kb.map((c) => `(${c.doc}) ${String(c.text).slice(0, 1200)}`).join('\n\n') || '(none)'}

JSON only: {"items":[{"item":"short description","qty":1,"price":12.5 or null}],"notes":"one short line of assumptions or what needs confirming, or empty"}` }] });
  bumpUsage(tenant.id, 'ai_calls');
  const raw = String(r.choices?.[0]?.message?.content || '');
  try { const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); return { items: cleanItems(j.items), notes: String(j.notes || '').slice(0, 300) }; } catch { return { items: [], notes: '' }; }
}

/** A new quote request from the chat: drafted at once; sent automatically only if allowed and fully priced. */
export async function createQuote(tenant, { waId, name, email, phone, request }, { fromChat = false } = {}) {
  const req = String(request || '').trim().slice(0, 2000);
  if (req.length < 3) throw fail('Tell us what you need first');
  const { items, notes } = await draftLines(tenant, req).catch(() => ({ items: [], notes: '' }));
  const number = (getDb().prepare('SELECT MAX(number) AS n FROM quotes WHERE tenant_id = ?').get(tenant.id).n || 1000) + 1;
  const days = Math.max(1, Math.min(180, Number(tenant.settings.quotes?.validDays) || 30));
  const token = crypto.randomBytes(18).toString('base64url');
  getDb().prepare(`INSERT INTO quotes (tenant_id, number, token, wa_id, name, email, phone, request, items, total, notes, status, valid_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', date('now', ?))`).run(tenant.id, number, token, waId || null, name || null, email || null, phone || null, req, JSON.stringify(items), quoteTotal(items), notes, `+${days} days`);
  const photos = chatPhotos(tenant.id, waId);
  if (photos.length) getDb().prepare('UPDATE quotes SET photos = ? WHERE tenant_id = ? AND number = ?').run(JSON.stringify(photos), tenant.id, number);
  let q = getQuote(tenant.id, number);
  const auto = tenant.settings.quotes?.autoSend === true && items.length && items.every((x) => x.price !== null);
  let message = null;
  if (auto) ({ quote: q, message } = await sendQuote(tenant, number, { by: 'auto', skipChat: fromChat }));
  else {
    const text = `📝 Quote request Q-${number}: ${req.slice(0, 300)}\n${[name, email, phone].filter(Boolean).join(' · ')}${photos.length ? `\n📷 ${photos.length} photo${photos.length === 1 ? '' : 's'} attached – see the Quotes tab` : ''}`;
    emailShop(tenant, `Quote to check: Q-${number}`, `${text}\n\nThe AI has drafted it from your price list – check it on the Quotes tab and press Send.`, { button: 'Open Quotes' }).catch(() => {});
    pushTeam(tenant, { title: `📝 Quote to check: Q-${number}`, body: req.slice(0, 120), url: '/admin/#quotes', tag: `quote-${number}` }).catch(() => {});
    for (const s of tenant.settings.notifications?.staffWaIds || []) notify(tenant, String(s).replace(/\D/g, ''), { type: 'text', text }, null).catch(() => {});
  }
  sendHook(tenant, 'quote.new', { number, request: req, name, email, phone, total: q.total, status: q.status }).catch(() => {});
  return { quote: q, auto, message };
}

export async function updateQuote(tenant, number, { items, notes, status }) {
  const q = getQuote(tenant.id, number);
  if (!q) throw fail('Quote not found', 404);
  const it = items ? cleanItems(items) : q.items;
  getDb().prepare("UPDATE quotes SET items = ?, total = ?, notes = ?, status = ? WHERE id = ?").run(JSON.stringify(it), quoteTotal(it), notes !== undefined ? String(notes).slice(0, 500) : q.notes, ['draft', 'sent', 'accepted', 'declined', 'expired'].includes(status) ? status : q.status, q.id);
  return getQuote(tenant.id, number);
}

/** Send (or re-send) the quote to the customer: chat + email. */
export async function sendQuote(tenant, number, { by = 'Team', skipChat = false, sender = null } = {}) {
  const q = getQuote(tenant.id, number);
  if (!q) throw fail('Quote not found', 404);
  if (!q.items.length) throw fail('Add at least one line to the quote first');
  getDb().prepare("UPDATE quotes SET status = 'sent', sent_at = datetime('now'), followed_up_at = NULL WHERE id = ?").run(q.id);
  const sym = tenant.settings.business?.currencySymbol || '£';
  const text = `📝 Your quote *Q-${q.number}* from ${tenant.settings.business.name}\n\n${q.items.map((x) => `• ${x.qty > 1 ? `${x.qty} × ` : ''}${x.item}: ${x.price === null ? 'to confirm' : money(x.price * x.qty, sym)}`).join('\n')}\n\n*Total: ${money(q.total, sym)}*${q.items.some((x) => x.price === null) ? ' (plus items to confirm)' : ''}\nValid until ${q.valid_until}.\n\nSee it, download the PDF or accept it here: ${quoteUrl(q)}`;
  const out = { chat: false, email: false };
  if (q.wa_id && !skipChat) out.chat = await (sender || createSender(tenant))(q.wa_id, { type: 'text', text, staff: by === 'auto' ? undefined : by }).then(() => true, () => false);
  if (q.email) out.email = await sendEmail({ tenantId: tenant.id, topic: 'quote', to: q.email, replyTo: (tenant.settings.notifications?.alertEmails || [])[0], subject: `Your quote Q-${q.number} from ${tenant.settings.business.name}`, text: `${text.replace(/\*/g, '')}\n\n${tenant.settings.business.name}` }).then((r) => !!r?.ok, () => false);
  return { quote: getQuote(tenant.id, number), delivered: out, message: text };
}

export async function acceptQuote(token) {
  const q = quoteByToken(token);
  if (!q || !['sent', 'accepted'].includes(q.status)) throw fail('This quote is not available', 404);
  if (q.status === 'accepted') return q;
  if (q.valid_until && q.valid_until < new Date().toISOString().slice(0, 10)) throw fail('This quote has expired – ask us for a new one', 410);
  getDb().prepare("UPDATE quotes SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?").run(q.id);
  const t = getTenant(q.tenant_id);
  const text = `✅ Quote Q-${q.number} accepted (${money(q.total, t.settings.business?.currencySymbol || '£')}) by ${[q.name, q.email, q.phone].filter(Boolean).join(' · ') || 'the customer'}.`;
  emailShop(t, `Quote Q-${q.number} accepted`, `${text}\n\nGet in touch to arrange it.`, { button: 'Open Quotes' }).catch(() => {});
  pushTeam(t, { title: `✅ Quote Q-${q.number} accepted`, body: text, url: '/admin/#quotes' }).catch(() => {});
  for (const s of t.settings.notifications?.staffWaIds || []) notify(t, String(s).replace(/\D/g, ''), { type: 'text', text }, null).catch(() => {});
  sendHook(t, 'quote.accepted', { number: q.number, total: q.total, name: q.name, email: q.email, phone: q.phone }).catch(() => {});
  return quoteByToken(token);
}

/** One friendly follow-up 2 days after sending, if the customer hasn't accepted. */
export async function runQuoteFollowUps({ tenantId = null, sender = null } = {}) {
  const rows = getDb().prepare(`SELECT * FROM quotes WHERE status = 'sent' AND followed_up_at IS NULL AND sent_at < datetime('now', '-2 days') AND sent_at > datetime('now', '-14 days') ${tenantId ? 'AND tenant_id = ?' : ''} LIMIT 200`).all(...(tenantId ? [tenantId] : [])).map(map);
  let n = 0;
  const { guarded } = await import('./outreach.js');
  for (const q of rows) {
    const t = getTenant(q.tenant_id);
    if (!t?.active || t.settings.quotes?.followUp === false) { getDb().prepare("UPDATE quotes SET followed_up_at = datetime('now') WHERE id = ?").run(q.id); continue; }
    const decided = () => getDb().prepare("UPDATE quotes SET followed_up_at = datetime('now') WHERE id = ?").run(q.id);
    const text = `Hi${q.name ? ` ${String(q.name).split(' ')[0]}` : ''}! Just checking you got your quote Q-${q.number} from ${t.settings.business.name}. Any questions? Reply here, or accept it when you're ready: ${quoteUrl(q)}`;
    let any = false;
    if (q.wa_id && !String(q.wa_id).startsWith('web:')) {
      const r = await guarded(t, q.wa_id, 'quote_followup', `quote:${q.id}`, () => (sender || createSender(t))(q.wa_id, { type: 'text', text }), { onDecided: decided });
      if (r === 'retry') continue; // quiet hours – try again later
      any = any || r === 'sent';
    } else decided();
    if (q.email) {
      const r = await guarded(t, q.wa_id, 'quote_followup', `quote-email:${q.id}`, async () => { const m = await sendEmail({ tenantId: t.id, topic: 'quote_followup', to: q.email, subject: `Your quote Q-${q.number}`, text: `${text}\n\n${t.settings.business.name}` }); if (!m.ok && !m.retrying) throw new Error(m.error || 'email not sent'); }, { channel: 'email' });
      any = any || r === 'sent';
    }
    if (any) n++;
  }
  return n;
}

// ---------- the customer's quote page and PDF ----------
/** A tiny one-page PDF (Helvetica, text lines) – no libraries. Exported for tests. */
export function simplePdf(lines) {
  const enc = (s) => String(s).replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7e£]/g, '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = ['BT', '/F1 11 Tf', '50 790 Td', '15 TL', ...lines.slice(0, 48).map((l, i) => `${typeof l === 'object' ? `/F2 ${l.size || 13} Tf ` : '/F1 11 Tf '}(${enc(typeof l === 'object' ? l.text : l)}) ${i ? "'" : 'Tj'}`), 'ET'].join('\n');
  const body = Buffer.from(content, 'latin1');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', null];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offs = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    const chunk = o === null ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${body.length} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream\nendobj\n', 'latin1')]) : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    offs.push(pos); parts.push(chunk); pos += chunk.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`, 'latin1'));
  return Buffer.concat(parts);
}

export function quotesRouter() {
  const r = express.Router();
  const load = (req, res) => { const q = quoteByToken(req.params.token); if (!q || q.status === 'draft') { res.status(404).send('This quote is not available.'); return null; } return { q, t: getTenant(q.tenant_id) }; };
  r.get('/q/:token.pdf', (req, res) => {
    const x = load(req, res); if (!x) return;
    const { q, t } = x, sym = t.settings.business?.currencySymbol || '£';
    const lines = [{ text: `${t.settings.business.name} - Quote Q-${q.number}`, size: 16 }, '', `Date: ${String(q.sent_at || q.created_at).slice(0, 10)}    Valid until: ${q.valid_until}`, q.name ? `For: ${q.name}` : '', '', ...q.items.map((i) => `${i.qty > 1 ? `${i.qty} x ` : ''}${i.item}  ...  ${i.price === null ? 'to confirm' : money(i.price * i.qty, sym)}`), '', { text: `Total: ${money(q.total, sym)}`, size: 13 }, q.notes ? `Notes: ${q.notes}` : '', '', `Accept online: ${quoteUrl(q)}`, t.settings.business.website ? String(t.settings.business.website) : ''].filter((l) => l !== '' || true);
    res.type('application/pdf').set('Content-Disposition', `inline; filename="quote-Q-${q.number}.pdf"`).send(simplePdf(lines));
  });
  r.get('/q/:token', (req, res) => {
    const x = load(req, res); if (!x) return;
    const { q, t } = x, sym = t.settings.business?.currencySymbol || '£';
    const color = t.settings.storefront?.brandColor || '#128c4a';
    res.set('X-Robots-Tag', 'noindex').type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quote Q-${q.number} – ${esc(t.settings.business.name)}</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f8f7;color:#16201b}.w{max-width:720px;margin:0 auto;padding:24px 16px}.card{background:#fff;border:1px solid #e3e8e5;border-radius:14px;padding:20px}table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid #eef1ef;text-align:left}td.r,th.r{text-align:right}.btn{display:inline-block;background:${color};color:#fff;border:0;border-radius:10px;padding:12px 18px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}.ghost{background:#fff;color:${color};border:1px solid ${color}}.mute{color:#5d6b63}@media print{.np{display:none}}</style></head>
<body><div class="w"><div class="card"><p class="mute">${esc(t.settings.business.name)}</p><h1 style="margin:.2em 0">Quote Q-${q.number}</h1><p class="mute">${q.name ? `For ${esc(q.name)} · ` : ''}Valid until ${esc(q.valid_until)}</p>
<table><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th></tr>${q.items.map((i) => `<tr><td>${esc(i.item)}</td><td class="r">${i.qty}</td><td class="r">${i.price === null ? '<span class="mute">to confirm</span>' : esc(money(i.price * i.qty, sym))}</td></tr>`).join('')}
<tr><th>Total</th><th></th><th class="r">${esc(money(q.total, sym))}</th></tr></table>${q.notes ? `<p class="mute">${esc(q.notes)}</p>` : ''}
<p class="np" id="act">${q.status === 'accepted' ? '<b>✅ Accepted – thank you! We\'ll be in touch to arrange it.</b>' : `<button class="btn" id="acc">Accept quote</button> `}<a class="btn ghost" href="/q/${esc(q.token)}.pdf">Download PDF</a></p></div></div>
<script>var b=document.getElementById('acc');if(b)b.onclick=function(){b.disabled=true;fetch(location.pathname+'/accept',{method:'POST'}).then(function(r){return r.json()}).then(function(j){document.getElementById('act').innerHTML=j.ok?'<b>✅ Accepted – thank you! We\\'ll be in touch to arrange it.</b>':(j.error||'Sorry, something went wrong')})}</script></body></html>`);
  });
  r.post('/q/:token/accept', async (req, res) => { try { await acceptQuote(req.params.token); res.json({ ok: true }); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } });
  return r;
}
