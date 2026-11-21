import express from 'express';
import { getDb, json } from './db.js';
import { config } from './config.js';
import { getTenant, bumpUsage } from './tenants.js';
import { addTextDoc, removeDoc } from './knowledge.js';
import { retrieve } from './ai/rag.js';
import { chatCompletion, directConfigured } from './ai/direct.js';

/*
 * Help centre: a public help site for each business at /help/<shop>, with articles, a search box and the AI chat.
 *  - Articles are drafts until the owner publishes them; a published article is also added to the assistant's
 *    knowledge, so the chat and the help centre always say the same thing.
 *  - "Write articles for me": the AI drafts articles from the questions customers really ask (unanswered questions,
 *    common questions) and the business's own website pages. Nothing goes public until the owner publishes it.
 *  - Each article has "Was this helpful? Yes / No" so owners see which ones need work.
 */
const fail = (m, status = 400) => Object.assign(new Error(m), { status });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 70) || 'article';

function uniqueSlug(tenantId, title, id = 0) {
  const base = slugify(title);
  let slug = base, n = 2;
  while (getDb().prepare('SELECT 1 FROM help_articles WHERE tenant_id = ? AND slug = ? AND id != ?').get(tenantId, slug, id)) slug = `${base}-${n++}`;
  return slug;
}
const clean = (a) => a && { ...a };

export function listArticles(tenantId, { status } = {}) {
  return getDb().prepare(`SELECT id, slug, title, category, status, views, helpful_yes, helpful_no, source, updated_at, length(body) AS chars FROM help_articles WHERE tenant_id = ? ${status ? 'AND status = ?' : ''} ORDER BY category, title`).all(...[tenantId, status].filter(Boolean)).map(clean);
}
export const getArticle = (tenantId, idOrSlug) => clean(getDb().prepare('SELECT * FROM help_articles WHERE tenant_id = ? AND (id = ? OR slug = ?)').get(tenantId, Number(idOrSlug) || -1, String(idOrSlug)));

/** Keep the assistant's knowledge in step: published → a knowledge document; draft/deleted → removed. */
function syncKnowledge(tenantId, a) {
  if (a.status === 'published' && a.body.trim().length >= 20) {
    const doc = addTextDoc(tenantId, { name: `Help: ${a.title}`.slice(0, 200), text: `${a.title}\n\n${a.body}`, source: 'help', url: `${config.publicUrl}/help/${encodeURIComponent(tenantId)}/${a.slug}` });
    getDb().prepare('UPDATE help_articles SET doc_id = ? WHERE id = ?').run(doc.id, a.id);
  } else if (a.doc_id) {
    try { removeDoc(tenantId, a.doc_id); } catch {}
    getDb().prepare('UPDATE help_articles SET doc_id = NULL WHERE id = ?').run(a.id);
  }
}

export function saveArticle(tenantId, { id, title, category, body, status, source = 'manual' }) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (t.length < 3) throw fail('Give the article a title');
  const b = String(body || '').replace(/\r/g, '').trim().slice(0, 30000);
  const cat = String(category || 'General').replace(/\s+/g, ' ').trim().slice(0, 40) || 'General';
  const st = status === 'published' ? 'published' : 'draft';
  if (st === 'published' && b.length < 20) throw fail('Write a little more before publishing');
  const d = getDb();
  let row;
  if (id) {
    row = getArticle(tenantId, id);
    if (!row) throw fail('Article not found', 404);
    const slug = row.title === t ? row.slug : uniqueSlug(tenantId, t, row.id);
    if (slug !== row.slug && row.doc_id) { try { removeDoc(tenantId, row.doc_id); } catch {} d.prepare('UPDATE help_articles SET doc_id = NULL WHERE id = ?').run(row.id); } // its address changed
    d.prepare("UPDATE help_articles SET title = ?, category = ?, body = ?, status = ?, slug = ?, updated_at = datetime('now') WHERE id = ?").run(t, cat, b, st, slug, row.id);
  } else {
    const r = d.prepare('INSERT INTO help_articles (tenant_id, slug, title, category, body, status, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tenantId, uniqueSlug(tenantId, t), t, cat, b, st, source);
    row = { id: Number(r.lastInsertRowid) };
  }
  const a = getArticle(tenantId, row.id);
  syncKnowledge(tenantId, a);
  return getArticle(tenantId, row.id);
}

export function deleteArticle(tenantId, id) {
  const a = getArticle(tenantId, id);
  if (!a) return false;
  syncKnowledge(tenantId, { ...a, status: 'deleted' });
  getDb().prepare('DELETE FROM help_articles WHERE id = ?').run(a.id);
  return true;
}

/** Search published articles: the knowledge search first (understands meaning), then plain text matching. */
export async function searchArticles(tenantId, q, limit = 8) {
  const query = String(q || '').trim().slice(0, 200);
  if (!query) return [];
  const pub = listArticles(tenantId, { status: 'published' });
  const byDoc = new Map(getDb().prepare("SELECT id, doc_id FROM help_articles WHERE tenant_id = ? AND status = 'published' AND doc_id IS NOT NULL").all(tenantId).map((r) => [r.doc_id, r.id]));
  const hits = await retrieve(tenantId, query, { k: 12 }).catch(() => []);
  const ids = [];
  for (const h of hits) {
    const doc = getDb().prepare('SELECT id FROM knowledge_docs WHERE tenant_id = ? AND name = ?').get(tenantId, h.doc);
    const aid = doc && byDoc.get(doc.id);
    if (aid && !ids.includes(aid)) ids.push(aid);
  }
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  for (const a of pub) if (!ids.includes(a.id) && words.some((w) => a.title.toLowerCase().includes(w))) ids.push(a.id);
  return ids.slice(0, limit).map((id) => pub.find((a) => a.id === id)).filter(Boolean);
}

/** The AI drafts articles from what customers ask and the business's own pages. Drafts only. */
export async function draftArticles(tenant, { max = 6 } = {}) {
  if (!directConfigured()) throw fail('The AI is not set up on this server');
  const d = getDb();
  const asked = [
    ...d.prepare("SELECT question AS q, COUNT(*) AS n FROM unanswered WHERE tenant_id = ? GROUP BY lower(question) ORDER BY n DESC LIMIT 15").all(tenant.id).map((r) => r.q),
    ...d.prepare(`SELECT json_extract(body, '$.text') AS q, COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'in' AND type = 'text' AND wa_id NOT LIKE 'qa:%' AND length(json_extract(body, '$.text')) BETWEEN 12 AND 200 AND json_extract(body, '$.text') LIKE '%?%' GROUP BY lower(json_extract(body, '$.text')) ORDER BY n DESC LIMIT 25`).all(tenant.id).map((r) => r.q),
    ...(tenant.settings.quality?.tradeQuestions || []),
  ].filter(Boolean);
  const have = new Set(listArticles(tenant.id).map((a) => a.title.toLowerCase()));
  const topics = [...new Set(asked.map((q) => String(q).trim()))].slice(0, 20);
  const pages = d.prepare("SELECT name, substr(text, 1, 1500) AS text FROM knowledge_docs WHERE tenant_id = ? AND status NOT IN ('deleted', 'to_delete') AND source != 'help' ORDER BY id LIMIT 12").all(tenant.id);
  if (!topics.length && !pages.length) throw fail('Add your website or some documents on the Knowledge tab first, so there is something to write from');
  const res = await chatCompletion({
    temperature: 0.3, maxTokens: 3500,
    messages: [{ role: 'user', content: `You write help-centre articles for ${tenant.settings.business.name}, a UK business. Use ONLY the information below – never invent prices, times or policies; if something isn't covered, leave it out. British English, friendly and plain, short paragraphs, use "- " bullet points where useful. Each article answers one question customers ask.

Questions customers ask:
${topics.map((q) => `- ${q}`).join('\n') || '(none yet)'}

Already written (don't repeat): ${[...have].join('; ') || 'none'}

The business's own information:
${pages.map((p) => `### ${p.name}\n${p.text}`).join('\n\n')}

Reply with JSON only: {"articles": [{"title": "a question or clear topic, max 80 chars", "category": "one of a few short categories such as Prices, Bookings, Delivery, Opening hours, Getting started", "body": "the article, 60-250 words"}]} – at most ${max} articles, only ones the information really answers.` }],
  });
  bumpUsage(tenant.id, 'ai_calls');
  const raw = String(res.choices?.[0]?.message?.content || '').replace(/```(json)?/g, '');
  let list = [];
  try { list = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).articles || []; } catch { throw fail('The AI answer could not be read – try again'); }
  const made = [];
  for (const a of list.slice(0, max)) {
    if (!a?.title || !a?.body || have.has(String(a.title).toLowerCase())) continue;
    try { made.push(saveArticle(tenant.id, { title: a.title, category: a.category, body: a.body, status: 'draft', source: 'ai' })); } catch {}
  }
  return made;
}

export function articleFeedback(tenantId, slug, helpful) {
  return getDb().prepare(`UPDATE help_articles SET ${helpful ? 'helpful_yes = helpful_yes + 1' : 'helpful_no = helpful_no + 1'} WHERE tenant_id = ? AND slug = ? AND status = 'published'`).run(tenantId, String(slug)).changes > 0;
}

// ---------- public pages ----------
/** Article text → safe HTML: paragraphs, "- " bullets, **bold**, links. */
export function renderBody(body) {
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*|\*([^*\n]+)\*/g, (m, a, b) => `<b>${a || b}</b>`).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="noopener nofollow">$1</a>');
  return String(body || '').split(/\n{2,}/).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length && lines.every((l) => /^[-•*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^[-•*]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.length === 1 && /^#{1,3}\s/.test(lines[0])) return `<h3>${inline(lines[0].replace(/^#+\s*/, ''))}</h3>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
}

function page(t, title, body, { description = '', canonical = '' } = {}) {
  const color = /^#[0-9a-f]{3,8}$/i.test(t.settings.webchat?.color || '') ? t.settings.webchat.color : t.settings.storefront?.brandColor || '#128c4a';
  const name = esc(t.settings.business.name);
  const base = `/help/${encodeURIComponent(t.id)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${description ? `<meta name="description" content="${esc(description)}">` : ''}${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<style>:root{--c:${color};--ink:#16201b;--mute:#5d6b63;--line:#e3e8e5;--bg:#f6f8f7}*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--c);color:#fff;padding:28px 16px}header a{color:#fff;text-decoration:none}.w{max-width:820px;margin:0 auto}h1{margin:.2em 0;font-size:28px}
form.s{display:flex;gap:8px;margin-top:14px}form.s input{flex:1;padding:12px 14px;border:0;border-radius:10px;font:inherit}form.s button{border:0;border-radius:10px;padding:0 18px;background:#fff;color:var(--c);font:inherit;font-weight:600;cursor:pointer}
main{padding:20px 16px 60px}.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:14px 0}.card h2{margin:0 0 8px;font-size:18px}.card ul.list{list-style:none;padding:0;margin:0}.card ul.list li{padding:7px 0;border-top:1px solid var(--line)}.card ul.list li:first-child{border-top:0}
a{color:var(--c)}.mute{color:var(--mute)}article h1{font-size:26px}.fb button{border:1px solid var(--line);background:#fff;border-radius:9px;padding:6px 14px;margin-right:6px;cursor:pointer;font:inherit}footer{text-align:center;color:var(--mute);font-size:13px;padding:20px}</style></head>
<body><header><div class="w"><a href="${base}">${name} · Help centre</a><h1>${esc(title === `${t.settings.business.name} Help centre` ? 'How can we help?' : title)}</h1>
<form class="s" action="${base}/search"><input name="q" placeholder="Search for answers…" aria-label="Search the help centre"><button>Search</button></form></div></header>
<main class="w">${body}</main><footer>${t.settings.business.website ? `<a href="${esc(t.settings.business.website)}">${esc(String(t.settings.business.website).replace(/^https?:\/\//, ''))}</a> · ` : ''}Can't find it? Ask our assistant – bottom right.</footer>
${t.settings.webchat?.enabled === false ? '' : `<script src="${config.publicUrl}/chat-widget/${encodeURIComponent(t.id)}.js" async></script>`}</body></html>`;
}

export function helpRouter() {
  const r = express.Router();
  const shop = (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t?.active || t.settings.help?.enabled === false) { res.status(404).send('This help centre is not available.'); return null; }
    return t;
  };
  r.get('/help/:tenantId', (req, res) => {
    const t = shop(req, res); if (!t) return;
    const pub = listArticles(t.id, { status: 'published' });
    const cats = [...new Set(pub.map((a) => a.category))];
    const base = `/help/${encodeURIComponent(t.id)}`;
    const body = pub.length ? cats.map((c) => `<section class="card"><h2>${esc(c)}</h2><ul class="list">${pub.filter((a) => a.category === c).map((a) => `<li><a href="${base}/${esc(a.slug)}">${esc(a.title)}</a></li>`).join('')}</ul></section>`).join('')
      : '<div class="card"><p>Our help articles are on their way. In the meantime, ask our assistant (bottom right) – it knows our prices, opening hours and policies.</p></div>';
    res.type('html').send(page(t, `${t.settings.business.name} Help centre`, body, { description: `Answers to common questions about ${t.settings.business.name}.`, canonical: `${config.publicUrl}${base}` }));
  });
  r.get('/help/:tenantId/search', async (req, res) => {
    const t = shop(req, res); if (!t) return;
    const q = String(req.query.q || '').slice(0, 200);
    const hits = await searchArticles(t.id, q);
    const base = `/help/${encodeURIComponent(t.id)}`;
    const body = `<div class="card"><h2>${hits.length ? `Results for “${esc(q)}”` : `Nothing found for “${esc(q)}”`}</h2>${hits.length ? `<ul class="list">${hits.map((a) => `<li><a href="${base}/${esc(a.slug)}">${esc(a.title)}</a> <span class="mute">· ${esc(a.category)}</span></li>`).join('')}</ul>` : '<p>Try other words, or ask our assistant (bottom right) – it can answer straight away.</p>'}</div>`;
    res.set('X-Robots-Tag', 'noindex').type('html').send(page(t, 'Search', body));
  });
  r.get('/help/:tenantId/:slug', (req, res) => {
    const t = shop(req, res); if (!t) return;
    const a = getArticle(t.id, req.params.slug);
    if (!a || a.status !== 'published' || String(a.slug) !== req.params.slug) return res.status(404).type('html').send(page(t, 'Not found', '<div class="card"><p>That article has moved or been removed.</p></div>'));
    getDb().prepare('UPDATE help_articles SET views = views + 1 WHERE id = ?').run(a.id);
    const base = `/help/${encodeURIComponent(t.id)}`;
    const related = listArticles(t.id, { status: 'published' }).filter((x) => x.category === a.category && x.id !== a.id).slice(0, 5);
    const ld = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: a.title, acceptedAnswer: { '@type': 'Answer', text: a.body.slice(0, 3000) } }] };
    const body = `<article class="card"><p class="mute"><a href="${base}">Help centre</a> › ${esc(a.category)}</p>${renderBody(a.body)}
      <div class="fb" style="margin-top:22px"><span class="mute">Was this helpful?</span> <button data-h="1">👍 Yes</button><button data-h="0">👎 No</button> <span id="fbm" class="mute"></span></div></article>
      ${related.length ? `<div class="card"><h2>Related</h2><ul class="list">${related.map((x) => `<li><a href="${base}/${esc(x.slug)}">${esc(x.title)}</a></li>`).join('')}</ul></div>` : ''}
      <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
      <script>document.querySelectorAll('.fb button').forEach(function(b){b.onclick=function(){fetch(${JSON.stringify(`${base}/${a.slug}/feedback`)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({helpful:b.dataset.h==='1'})});document.querySelectorAll('.fb button').forEach(function(x){x.disabled=true});document.getElementById('fbm').textContent=b.dataset.h==='1'?'Thanks!':'Thanks – try asking our assistant, bottom right.'}})</script>`;
    res.type('html').send(page(t, a.title, body, { description: a.body.replace(/\s+/g, ' ').slice(0, 155), canonical: `${config.publicUrl}${base}/${a.slug}` }));
  });
  r.post('/help/:tenantId/:slug/feedback', (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t?.active) return res.sendStatus(404);
    res.json({ ok: articleFeedback(t.id, req.params.slug, req.body?.helpful === true) });
  });
  return r;
}
void json;
