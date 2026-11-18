import express from 'express';
import { config } from '../config.js';
import { getTenant, bumpUsage, withinLimit } from '../tenants.js';
import { getDb, json } from '../db.js';
import { createSender, logMessage } from '../whatsapp/cloudApi.js';
import { handleInbound, menuOptions, openerFor, PAGE_OPENERS, DEFAULT_OPENER } from '../bot/engine.js';
import { enqueue } from '../whatsapp/webhook.js';
import { rateLimit } from './web.js';
import { isDemo, DEMO_MESSAGE_CAP } from '../instantDemo.js';

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
  return { url: url.slice(0, 300), title: String(p.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 150) };
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
  return { text: String(O.text || DEFAULT_OPENER).slice(0, 200), rules, chips: O.chips === false ? [] : chips, delay: n(O.delaySeconds, 10, 120), mobileDelay: n(O.mobileDelaySeconds, 15, 180), exit: O.exitIntent !== false };
}
export { openerFor };

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
    };
    res.send(WIDGET.replace('__CFG__', JSON.stringify(cfg).replace(/</g, '\\u003c')));
  });
  return r;
}

export const DEFAULT_LAUNCHER = "Hello! I'm the chat assistant. Talk to me anytime.";

const WIDGET = String.raw`(function(){
if(window.__waChat)return;window.__waChat=1;
var C=__CFG__,d=document,K='wachat-'+C.tenant,sid,last=0,open=false,polling,busy=0;
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
'.wc-w{font-size:12px;text-align:center;padding:4px;color:#667}.wc-w a{color:inherit}.wc-t{align-self:flex-start;color:#889;font-size:12px}';
var st=d.createElement('style');st.textContent=css;d.head.appendChild(st);
var w=d.createElement('div');w.className='wc';
w.innerHTML='<div class="wc-p" role="dialog" aria-label="Chat"><div class="wc-h"><button class="wc-x" aria-label="Close">×</button><b></b><span></span></div><div class="wc-m" aria-live="polite"></div><form class="wc-f"><input placeholder="Type a message…" aria-label="Message" maxlength="1000"><button>Send</button></form>'+(C.whatsapp?'<div class="wc-w">Prefer WhatsApp? <a target="_blank" rel="noopener" href="https://wa.me/'+C.whatsapp+'">Chat there</a></div>':'')+'</div>'+(C.launcher||C.opener?'<div class="wc-l" role="button" tabindex="0"><button class="wc-lx" aria-label="Hide message">×</button><span></span></div>':'')+'<button class="wc-b" aria-label="Open chat">💬</button>';
w.querySelector('.wc-h b').textContent=C.title;w.querySelector('.wc-h span').textContent=C.subtitle;
var P=w.querySelector('.wc-p'),M=w.querySelector('.wc-m'),F=w.querySelector('form'),I=F.querySelector('input');
function mark(k,v,ss){try{(ss?sessionStorage:localStorage).setItem(k,v)}catch(e){}}
function got(k,ss){try{return (ss?sessionStorage:localStorage).getItem(k)}catch(e){return null}}
function pg(){return{url:location.origin+location.pathname,title:String(d.title||'').slice(0,150)}}
var UTM=null;try{var q=new URLSearchParams(location.search),u={};['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(function(k){if(q.get(k))u[k]=q.get(k).slice(0,80)});if(Object.keys(u).length)sessionStorage.setItem(K+'-utm',JSON.stringify(u));UTM=JSON.parse(sessionStorage.getItem(K+'-utm')||'null')}catch(e){}
function esc(s){var e=d.createElement('div');e.textContent=s==null?'':String(s);return e.innerHTML}
function fmt(s){return esc(s).replace(/\*([^*\n]+)\*/g,'<b>$1</b>').replace(/(^|\s)_([^_\n]+)_/g,'$1<i>$2</i>').replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>')}
function add(html,cls){var b=d.createElement('div');b.className='wc-q '+cls;b.innerHTML=html;M.appendChild(b);M.scrollTop=M.scrollHeight;return b}
function render(m){
  if(!m)return;var h='',acts=[];
  if(m.type==='image')h=(m.url?'<img alt="" src="'+esc(m.url)+'">':'')+fmt(m.caption||'');
  else if(m.type==='buttons'){h=(m.header?'<b>'+esc(m.header)+'</b>\n':'')+fmt(m.text);acts=m.buttons.map(function(b){return '<button data-a="'+esc(b.id)+'" data-l="'+esc(b.title)+'">'+esc(b.title)+'</button>'})}
  else if(m.type==='list'){h=fmt(m.text);acts=[].concat.apply([],m.sections.map(function(s){return s.rows.map(function(r){return '<button data-a="'+esc(r.id)+'" data-l="'+esc(r.title)+'" title="'+esc(r.description||'')+'">'+esc(r.title)+'</button>'})}))}
  else if(m.type==='cta'){h=fmt(m.text);acts=['<a href="'+esc(m.url)+'" target="_blank" rel="noopener">'+esc(m.buttonText||'Open')+' ↗</a>']}
  else if(m.type==='template'||m.type==='flow')h=fmt(m.text||'');
  else h=fmt(m.text||'');
  if(!h&&!acts.length)return;
  add(h+(acts.length?'<div class="wc-c">'+acts.join('')+'</div>':''),'a');
}
function send(body,label){
  if(label)add(esc(label),'u');
  var typing=add('…','a wc-t');busy++;
  if(body.text||(body.actionId&&body.actionId!=='open'))mark(K+'-chatted','1',1);
  fetch(C.api+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({sessionId:sid,page:pg(),utm:UTM||undefined},body))})
  .then(function(r){return r.json()}).then(function(r){busy--;typing.remove();(r.replies||[]).forEach(render);if(r.lastId)last=Math.max(last,r.lastId)})
  .catch(function(){busy--;typing.remove();add('Sorry – connection problem, please try again.','a')});
}
function poll(){if(busy)return;fetch(C.api+'/poll?sessionId='+sid+'&after='+last).then(function(r){return r.json()}).then(function(r){if(last&&r.messages)r.messages.forEach(render);last=Math.max(last,r.lastId||0)}).catch(function(){})}
M.addEventListener('click',function(e){var b=e.target.closest('button[data-a]');if(b)send({actionId:b.dataset.a},b.dataset.l)});
F.onsubmit=function(e){e.preventDefault();var v=I.value.trim();if(!v)return;I.value='';send({text:v},v)};
var O=C.opener;
function toggle(first,label){open=!open;P.classList.toggle('on',open);w.classList.toggle('open',open);if(open){I.focus();if(L)L.style.display='none';if(!M.children.length)send(first||(O?{actionId:'open'}:{text:C.greeting}),label);clearInterval(polling);polling=setInterval(poll,8000);poll()}else clearInterval(polling)}
w.querySelector('.wc-b').onclick=function(){toggle()};w.querySelector('.wc-x').onclick=function(){toggle()};
var L=w.querySelector('.wc-l');
function snoozed(){return got(K+'-hint')==='1'}
function textFor(){var p=location.pathname.toLowerCase();for(var i=0;i<O.rules.length;i++){var r=O.rules[i],hit=false;try{hit=r.re?new RegExp(r.m,'i').test(p):p.indexOf(r.m)>=0}catch(e){}if(hit)return r.t}return O.text}
if(L&&O){
  L.className='wc-l op';L.style.display='none';L.setAttribute('role','status');L.setAttribute('aria-live','polite');L.setAttribute('aria-label','Message from '+C.title);L.removeAttribute('tabindex');
  var hide=function(){if(!L)return;L.remove();L=null;mark(K+'-closed','1',1);w.querySelector('.wc-b').focus()};
  d.addEventListener('keydown',function(e){if(e.key==='Escape'&&L&&L.style.display!=='none'&&!open)hide()});
  L.onclick=function(e){if(e.target.closest('.wc-lx')){e.stopPropagation();hide();return}var c=e.target.closest('button[data-a]');if(c){toggle({actionId:c.dataset.a},c.dataset.l);return}if(!e.target.closest('.wc-lc'))toggle()};
  var shown=false,mobile=window.matchMedia&&matchMedia('(max-width:640px)').matches;
  var show=function(){if(shown||open||!L)return;shown=true;mark(K+'-shown','1',1);
    L.querySelector('span').innerHTML='<b>'+esc(C.title)+'</b>'+esc(textFor())+(O.chips.length?'<div class="wc-lc">'+O.chips.slice(0,mobile?2:3).map(function(c){return '<button data-a="'+esc(c.id)+'" data-l="'+esc(c.label)+'">'+esc(c.label)+'</button>'}).join('')+'</div>':'')+'<button class="wc-lt" type="button">Or type your question</button>';
    L.style.display='';};
  if(got(K+'-chatted',1)||got(K+'-closed',1)||got(K+'-shown',1)){L.remove();L=null}
  else{setTimeout(show,(mobile?O.mobileDelay:O.delay)*1000);
    if(O.exit&&!mobile){var t0=Date.now();d.addEventListener('mouseout',function(e){if(!e.relatedTarget&&e.clientY<=0&&Date.now()-t0>5000)show()})}}
}else if(L){
  if(snoozed())L.remove();else{L.querySelector('span').textContent=C.launcher;
    L.onclick=function(e){if(e.target.closest('.wc-lx')){e.stopPropagation();L.remove();mark(K+'-hint','1');return}toggle()};
    L.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle()}}}}
(d.body||d.documentElement).appendChild(w);
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
