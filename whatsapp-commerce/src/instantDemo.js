import express from 'express';
import { config } from './config.js';
import { getDb } from './db.js';
import { createTenant, getTenant, listTenants, updateTenantSettings, deleteTenant, rotateKeys } from './tenants.js';
import { detectWebsite, importUrl, sitemapPages, listDocs, rankPaths, pageLinks, safeFetch } from './knowledge.js';
import { chatCompletion, directConfigured } from './ai/direct.js';
import { randomToken } from './crypto.js';
import { rateLimit } from './routes/web.js';

/*
 * "Your assistant in 60 seconds": a visitor types their website on our homepage, we read a dozen of its pages
 * (and connect the catalogue if it's a Shopify shop), and they chat with THEIR assistant straight away.
 * The demo is a short-lived shop (settings.demo) deleted after DEMO_HOURS unless they sign up, which keeps it.
 */
export const DEMO_HOURS = 48;
const MAX_PAGES = 14;
const DAILY_CAP = Number(process.env.INSTANT_DEMO_DAILY || 150);
export const DEMO_MESSAGE_CAP = 60;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const kvGet = (k) => getDb().prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
const kvSet = (k, v) => getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, typeof v === 'string' ? v : JSON.stringify(v));
const state = (token) => { try { return JSON.parse(kvGet(`idemo_state:${token}`) || 'null'); } catch { return null; } };
const setState = (token, patch) => kvSet(`idemo_state:${token}`, { ...(state(token) || {}), ...patch });

export const isDemo = (t) => !!t?.settings?.demo?.expiresAt;
export function demoTenantForToken(token) {
  const id = /^[A-Za-z0-9_-]{16,64}$/.test(String(token || '')) ? kvGet(`idemo:${token}`) : null;
  const t = id && getTenant(id);
  return t && isDemo(t) ? t : null;
}

const SKIP = /\/(cart|checkout|(my-)?account|login|register|search|wp-admin|wp-login|feed|tag|author|cookie[\w-]*)\b|\.(pdf|jpe?g|png|gif|zip|xml)$/i;

/** Start a demo; the reading happens in the background (status is polled). Returns { token }. */
export async function startDemo(rawUrl, { ip = '' } = {}) {
  if (process.env.INSTANT_DEMO === 'false') throw Object.assign(new Error('Instant demos are switched off right now – book a demo instead.'), { status: 503 });
  if (!directConfigured()) throw Object.assign(new Error('The AI is not connected yet – book a demo instead.'), { status: 503 });
  let u;
  try { u = new URL(/^https?:\/\//i.test(String(rawUrl).trim()) ? String(rawUrl).trim() : `https://${String(rawUrl).trim()}`); } catch { u = null; }
  const local = !u || !/\./.test(u.hostname) || /^(localhost|[\d.]+|\[.*\])$/i.test(u.hostname);
  if (!u || (local && !config.allowPrivateFetch)) throw Object.assign(new Error('Please enter your website address, e.g. yourshop.co.uk'), { status: 400 });
  const day = new Date().toISOString().slice(0, 10);
  const n = Number(kvGet(`idemo_count:${day}`) || 0);
  if (n >= DAILY_CAP) throw Object.assign(new Error("We've had a lot of demos today – book a demo and we'll set yours up personally."), { status: 429 });
  kvSet(`idemo_count:${day}`, String(n + 1));

  const token = randomToken(18);
  const { tenant } = createTenant({ name: u.hostname.replace(/^www\./, ''), plan: 'starter' });
  updateTenantSettings(tenant.id, {
    demo: { expiresAt: new Date(Date.now() + DEMO_HOURS * 3600000).toISOString(), url: u.origin, token, startedAt: new Date().toISOString() },
    business: { website: u.origin, supportHours: '' },
    store: { type: 'none' },
    knowledge: { autoRefresh: false },
    report: { monthlyEmail: false, unansweredEmail: false },
  });
  kvSet(`idemo:${token}`, tenant.id);
  setState(token, { status: 'reading', step: 'Opening your website', pages: 0, origin: u.origin, ipHash: ip ? String(ip).slice(0, 3) : '' });
  buildDemo(tenant.id, token, u.origin).catch((e) => { console.warn('[instant demo]', e.message); setState(token, { status: 'failed', error: friendly(e) }); });
  return { token };
}

const friendly = (e) => (/abort|timeout|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(e.message) ? "We couldn't open that website. Check the address, or book a demo and we'll set it up for you." : e.message);

async function buildDemo(tenantId, token, origin) {
  const site = await detectWebsite(origin);
  const name = (site.name || new URL(site.origin).hostname.replace(/^www\./, '')).slice(0, 80);
  const shopify = site.platform === 'shopify';
  const SYM = { GBP: '£', USD: '$', EUR: '€', AED: 'AED ', INR: '₹', AUD: 'A$', CAD: 'C$' };
  const before = getTenant(tenantId).settings;
  updateTenantSettings(tenantId, {
    // the defaults were written with the bare domain as the name – redo the ones that show it
    business: { name, welcomeMessage: String(before.business?.welcomeMessage || '').split(before.business?.name || '\u0000').join(name), website: site.origin, ...(site.currency ? { currency: site.currency, currencySymbol: SYM[site.currency] || `${site.currency} ` } : {}) },
    ai: { assistantName: `${name} assistant`, about: [site.description, site.city && `Based in ${site.city}${site.country ? ', ' + site.country : ''}.`].filter(Boolean).join(' ') },
    ...(shopify ? { store: { type: 'shopify_public', shopify: { domain: new URL(site.origin).host, origin: site.origin } } } : {}),
  });
  getDb().prepare('UPDATE tenants SET name = ? WHERE id = ?').run(name, tenantId);
  setState(token, { step: shopify ? 'Connecting your Shopify catalogue' : 'Reading your pages', name, shopify });

  const usual = shopify
    ? ['/', '/policies/shipping-policy', '/policies/refund-policy', '/pages/faq', '/pages/faqs', '/pages/about', '/pages/about-us', '/pages/contact']
    : ['/', '/about', '/about-us', '/faq', '/faqs', '/contact', '/prices', '/pricing', '/fees', '/fee-guide', '/price-list', '/services', '/delivery', '/returns'];
  const fromMap = (await sitemapPages(site.origin, { limit: 60 }).catch(() => [])).map((x) => { try { return new URL(x).pathname; } catch { return null; } }).filter(Boolean);
  const fromMenu = pageLinks((await safeFetch(site.origin).catch(() => null))?.body || '', site.origin);
  // pages the site really links to come before guessed paths; then the ones customers ask about most (prices, contact...)
  const known = rankPaths([...fromMenu, ...fromMap]);
  const paths = [...new Set(['/', ...known.slice(0, 20), ...usual, ...known.slice(20)])].filter((p) => !SKIP.test(p));
  let ok = 0;
  const deadline = Date.now() + 40000;
  for (let i = 0; i < paths.length && ok < MAX_PAGES && Date.now() < deadline; i += 4) {
    const batch = paths.slice(i, i + 4);
    const res = await Promise.allSettled(batch.map((p) => importUrl(tenantId, site.origin + p)));
    ok += res.filter((r) => r.status === 'fulfilled').length;
    setState(token, { pages: ok, step: `Read ${ok} page${ok === 1 ? '' : 's'}` });
  }
  if (!ok && !shopify) throw new Error("We couldn't read any pages from that website (it may block automated visits). Book a demo and we'll set it up by hand.");

  setState(token, { step: 'Writing your welcome menu and questions' });
  const auto = import('./autoSetup.js').then(({ autoSetup }) => autoSetup(tenantId)).catch(() => null);
  let suggestions = [];
  try {
    const docs = listDocs(tenantId).slice(0, 10).map((d) => `- ${d.name}`).join('\n');
    const r = await chatCompletion({
      temperature: 0.3, maxTokens: 200,
      messages: [{ role: 'user', content: `A business called "${name}" (${site.description || site.origin}) has these website pages:\n${docs || '(home page only)'}${shopify ? '\nIt sells products online (Shopify).' : ''}\n\nWrite 4 short questions a real customer would send this business on WhatsApp, which its pages can answer (delivery, prices, opening hours, returns, specific products or services...). Max 8 words each. Output a JSON array of strings only.` }],
    });
    const raw = String(r.choices?.[0]?.message?.content || '').replace(/```(json)?/g, '');
    suggestions = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)).filter((s) => typeof s === 'string').map((s) => s.slice(0, 80)).slice(0, 4);
  } catch {}
  if (suggestions.length < 2) suggestions = shopify ? ['How much is delivery?', 'Can I return an item?', 'What do you recommend under £50?', 'How long does delivery take?'] : ['What are your opening hours?', 'How much does it cost?', 'Where are you based?', 'How do I book?'];
  await auto;
  setState(token, { status: 'ready', step: 'Ready', suggestions, tenantId });
}

/** Signup with a demo token: the demo shop becomes the customer's real shop. Returns { tenant, adminKey } or null. */
export function claimDemo(token, { name, email }) {
  const t = demoTenantForToken(token);
  if (!t) return null;
  // a kept demo becomes a live (protected) shop
  updateTenantSettings(t.id, { demo: null, claimedFromDemoAt: new Date().toISOString(), knowledge: { autoRefresh: true }, report: { monthlyEmail: true, unansweredEmail: true }, ...(name ? { business: { name } } : {}) });
  if (name) getDb().prepare('UPDATE tenants SET name = ? WHERE id = ?').run(name, t.id);
  getDb().prepare("UPDATE tenants SET owner_email = ?, trial_ends_at = datetime('now', ?), subscription_status = 'trialing' WHERE id = ?").run(email, `+${config.trialDays} days`, t.id);
  getDb().prepare('DELETE FROM kv WHERE key = ?').run(`idemo:${token}`);
  const { adminKey } = rotateKeys(t.id);
  return { tenant: getTenant(t.id), adminKey };
}

/** Hourly: delete demo shops nobody kept. */
export function cleanupDemos(now = Date.now()) {
  let n = 0;
  for (const t of listTenants()) {
    if (!isDemo(t) || Date.parse(t.settings.demo.expiresAt) > now) continue;
    getDb().prepare('DELETE FROM kv WHERE key IN (?, ?)').run(`idemo:${t.settings.demo.token}`, `idemo_state:${t.settings.demo.token}`);
    deleteTenant(t.id);
    n++;
  }
  return n;
}

// ---------- pages ----------

function demoPage(token, s, layout) {
  const name = esc(s?.name || 'your business');
  const body = `
<section class="hero" style="padding-bottom:20px"><div class="wrap">
<h1 id="h">${s?.status === 'ready' ? `Meet the ${name} assistant` : 'Building your assistant…'}</h1>
<p class="lead" id="lead">${s?.status === 'ready' ? `It has read ${s.pages || 'your'} pages of ${esc(s.origin)}${s.shopify ? ' and is connected to your Shopify catalogue' : ''}. Ask it what your customers ask you.` : 'Reading your website. This usually takes 20–40 seconds.'}</p>
</div></section>
<section style="border-top:0;padding-top:0"><div class="wrap demo-grid">
<div>
  <div class="card" id="progress" ${s?.status === 'ready' ? 'hidden' : ''}><ol class="ticks" id="ticks"><li id="t1">Opening your website</li><li id="t2">${s?.shopify ? 'Connecting your catalogue' : 'Reading your pages'}</li><li id="t3">Writing questions your customers ask</li></ol><p class="mute" id="step">${esc(s?.step || '')}</p></div>
  <div id="ready" ${s?.status === 'ready' ? '' : 'hidden'}>
    <h2 style="margin-top:0">Try asking</h2>
    <div id="chips" class="chips"></div>
    <div class="card" style="margin-top:18px"><h3 style="margin-top:0">Like it? Keep it.</h3>
      <p class="mute">Start your free trial and this exact assistant becomes yours: we keep everything it learnt, add it to your website with one line, and connect your WhatsApp when you're ready.</p>
      <p><a class="btn" id="keep" href="/signup?demo=${esc(token)}&website=${encodeURIComponent(s?.origin || '')}">Keep this assistant – start free trial</a> <a class="btn ghost" href="/signup?demo=${esc(token)}&plan=free&website=${encodeURIComponent(s?.origin || '')}">Keep it free (website chat only)</a></p>
      <p class="mute" style="font-size:13px">This demo is deleted after ${DEMO_HOURS} hours if you don't keep it. No card needed to try.</p></div>
  </div>
  <div class="card" id="failed" hidden><h3 style="margin-top:0">We couldn't build it automatically</h3><p id="ferr" class="mute"></p><p><a class="btn" href="/demo">Book a demo instead</a></p></div>
</div>
<div class="phone" aria-label="Chat preview"><div class="ph-top"><span class="ph-av">${name.slice(0, 1).toUpperCase()}</span><div><b>${name}</b><div style="font-size:12px;opacity:.85">online · replies instantly</div></div></div>
  <div class="ph-msgs" id="msgs"><div class="ph-note">🔒 Demo chat – messages are not sent to anyone</div></div>
  <form class="ph-in" id="f"><input id="q" placeholder="Type a message" autocomplete="off" ${s?.status === 'ready' ? '' : 'disabled'}><button aria-label="Send">➤</button></form></div>
</div></section>
<style>
.demo-grid{display:grid;grid-template-columns:1fr 360px;gap:28px;align-items:start}@media(max-width:820px){.demo-grid{grid-template-columns:1fr}}
.phone{border:10px solid #1b1f1d;border-radius:34px;overflow:hidden;background:#efeae2;height:620px;display:flex;flex-direction:column;box-shadow:0 18px 40px rgba(0,0,0,.18);max-width:360px;width:100%;margin:0 auto}
.ph-top{background:#075e54;color:#fff;display:flex;gap:10px;align-items:center;padding:12px}.ph-av{width:36px;height:36px;border-radius:50%;background:#25d366;display:grid;place-items:center;font-weight:700}
.ph-msgs{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:6px}.ph-note{align-self:center;background:#fff7d6;color:#5b5030;font-size:12px;padding:4px 10px;border-radius:8px;margin-bottom:6px}
.b{max-width:85%;padding:7px 10px;border-radius:8px;font-size:14.5px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;color:#111;box-shadow:0 1px 1px rgba(0,0,0,.08)}.b.in{background:#fff;align-self:flex-start}.b.out{background:#d9fdd3;align-self:flex-end}
.b a{color:#0b6b38}.btns{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:85%}.btns button{background:#fff;border:1px solid #cfd8d3;color:#0b6b38;border-radius:16px;padding:6px 10px;font-size:13.5px;cursor:pointer}
.ph-in{display:flex;gap:6px;padding:8px;background:#f0f0f0}.ph-in input{flex:1;border:0;border-radius:20px;padding:10px 14px;font-size:15px}.ph-in button{border:0;background:#128c4a;color:#fff;border-radius:50%;width:42px;height:42px;font-size:16px;cursor:pointer}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chips button{border:1px solid var(--line);background:var(--card,#fff);border-radius:20px;padding:9px 14px;font-size:15px;cursor:pointer;color:inherit}
.ticks{padding-left:20px}.ticks li{margin:6px 0;color:var(--mute,#5d6b63)}.ticks li.on{color:inherit;font-weight:600}.ticks li.done::marker{content:"✓  "}
.typing{align-self:flex-start;background:#fff;border-radius:8px;padding:8px 12px;font-size:13px;color:#667}
</style>
<script>
(() => {
  const token = ${JSON.stringify(token)};
  let tenant = ${JSON.stringify(s?.tenantId || '')};
  const sid = 'demo' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const $ = (id) => document.getElementById(id);
  const msgs = $('msgs');
  const escH = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fmt = (t) => escH(t).replace(/\\*([^*\\n]+)\\*/g, '<b>$1</b>').replace(/_([^_\\n]+)_/g, '<i>$1</i>').replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener nofollow">$1</a>');
  const bubble = (t, cls) => { const d = document.createElement('div'); d.className = 'b ' + cls; d.innerHTML = fmt(t); msgs.appendChild(d); msgs.scrollTop = 1e9; };
  function render(m) {
    if (m.type === 'cta') { bubble(m.text + '\\n' + (m.url || ''), 'in'); return; }
    bubble(m.text || '', 'in');
    const opts = (m.buttons || []).concat(...(m.sections || []).map((s) => s.rows || []));
    if (opts.length) { const w = document.createElement('div'); w.className = 'btns'; opts.slice(0, 10).forEach((o) => { const b = document.createElement('button'); b.textContent = o.title; b.onclick = () => send({ actionId: o.id, label: o.title }); w.appendChild(b); }); msgs.appendChild(w); msgs.scrollTop = 1e9; }
  }
  let busy = false;
  async function send({ text, actionId, label }) {
    if (busy || !tenant) return; busy = true;
    bubble(text || label, 'out');
    const ty = document.createElement('div'); ty.className = 'typing'; ty.textContent = 'typing…'; msgs.appendChild(ty); msgs.scrollTop = 1e9;
    try {
      const r = await fetch('/chat/' + tenant + '/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, text, actionId }) }).then((x) => x.json());
      ty.remove(); (r.replies || []).forEach(render);
      if (r.error) bubble(r.error, 'in');
    } catch { ty.remove(); bubble('Sorry, something went wrong – please try again.', 'in'); }
    busy = false;
  }
  $('f').onsubmit = (e) => { e.preventDefault(); const q = $('q').value.trim(); if (!q) return; $('q').value = ''; send({ text: q }); };
  function ready(st) {
    tenant = st.tenantId; $('progress').hidden = true; $('ready').hidden = false; $('q').disabled = false;
    $('h').textContent = 'Meet the ' + (st.name || 'your') + ' assistant';
    $('lead').textContent = 'It has read ' + st.pages + ' pages of ' + st.origin + (st.shopify ? ' and is connected to your Shopify catalogue' : '') + '. Ask it what your customers ask you.';
    $('chips').innerHTML = ''; (st.suggestions || []).forEach((q) => { const b = document.createElement('button'); b.textContent = q; b.onclick = () => send({ text: q }); $('chips').appendChild(b); });
    if (!msgs.querySelector('.b')) send({ text: 'Hi' });
  }
  async function poll() {
    const st = await fetch('/try/' + token + '/status').then((r) => r.json()).catch(() => null);
    if (!st) return setTimeout(poll, 2000);
    $('step').textContent = st.step || '';
    const at = st.status === 'ready' ? 4 : /question/i.test(st.step) ? 3 : st.pages || /Read|Connect/.test(st.step) ? 2 : 1;
    ['t1', 't2', 't3'].forEach((id, i) => { $(id).className = i + 1 < at ? 'done' : i + 1 === at ? 'on' : ''; });
    if (st.status === 'ready') return ready(st);
    if (st.status === 'failed' || st.status === 'gone') { $('progress').hidden = true; $('failed').hidden = false; $('ferr').textContent = st.error || 'This demo has expired.'; $('h').textContent = 'Sorry about that'; return; }
    setTimeout(poll, 1500);
  }
  ${s?.status === 'ready' ? `ready(${JSON.stringify({ tenantId: s.tenantId, name: s.name, pages: s.pages, origin: s.origin, shopify: !!s.shopify, suggestions: s.suggestions || [] }).replace(/</g, '\\u003c')});` : 'poll();'}
})();
</script>`;
  return layout('/try', body, { title: `${s?.name ? s.name + ' – ' : ''}your AI assistant demo`, description: 'Your own AI assistant, built from your website.', noindex: true });
}

export function instantDemoRouter(layout) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 3600000, max: 4 });
  r.post('/try', limiter, express.urlencoded({ extended: false, limit: '4kb' }), express.json({ limit: '4kb' }), async (req, res) => {
    const wantsJson = req.is('application/json');
    if (req.body?.company_website) return res.status(400).end(); // bot trap
    try {
      const { token } = await startDemo(req.body?.website, { ip: req.ip });
      return wantsJson ? res.status(202).json({ token, url: `/try/${token}` }) : res.redirect(303, `/try/${token}`);
    } catch (e) {
      return wantsJson ? res.status(e.status || 400).json({ error: e.message }) : res.status(e.status || 400).type('html').send(layout('/try', `<section class="hero"><div class="wrap"><h1>Hmm.</h1><p class="lead">${esc(e.message)}</p><p><a class="btn" href="/#try">Try again</a> <a href="/demo">or book a demo</a></p></div></section>`, { noindex: true }));
    }
  });
  r.get('/try/:token', (req, res) => {
    const s = state(req.params.token);
    if (!s) return res.status(404).type('html').send(layout('/try', '<section class="hero"><div class="wrap"><h1>This demo has expired</h1><p class="lead">Demos are kept for 48 hours. Build a new one in a minute.</p><p><a class="btn" href="/#try">Build my assistant</a></p></div></section>', { noindex: true }));
    res.set('Cache-Control', 'no-store').type('html').send(demoPage(req.params.token, s, layout));
  });
  r.get('/try/:token/status', (req, res) => {
    const s = state(req.params.token);
    res.set('Cache-Control', 'no-store').json(s ? { status: s.status, step: s.step, pages: s.pages, name: s.name, origin: s.origin, shopify: !!s.shopify, suggestions: s.suggestions || [], tenantId: s.status === 'ready' ? s.tenantId : undefined, error: s.error } : { status: 'gone' });
  });
  return r;
}
