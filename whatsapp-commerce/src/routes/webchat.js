import express from 'express';
import { config } from '../config.js';
import { getTenant, bumpUsage, withinLimit } from '../tenants.js';
import { getDb, json } from '../db.js';
import { createSender, logMessage } from '../whatsapp/cloudApi.js';
import { handleInbound } from '../bot/engine.js';
import { enqueue } from '../whatsapp/webhook.js';
import { rateLimit } from './web.js';

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

export function webchatRouter() {
  const r = express.Router();
  r.use('/chat', cors);
  const limiter = rateLimit({ max: 40, key: (req) => `${req.ip}:${req.params.tenantId}` });

  r.post('/chat/:tenantId/message', limiter, async (req, res) => {
    const t = getTenant(req.params.tenantId);
    if (!t?.active || t.settings.webchat?.enabled === false) return res.status(404).json({ error: 'chat unavailable' });
    const { sessionId, text, actionId } = req.body || {};
    if (!SESSION.test(String(sessionId || ''))) return res.status(400).json({ error: 'invalid session' });
    if (!text && !actionId) return res.status(400).json({ error: 'empty message' });
    if (!withinLimit(t, 'inbound')) return res.json({ replies: [{ type: 'text', text: `Thanks for your message! The ${t.settings.business.name} team will get back to you soon.` }] });
    const waId = visitorId(sessionId);
    const ev = actionId
      ? { waId, kind: 'action', id: String(actionId).slice(0, 200), text: '' }
      : { waId, kind: 'text', text: String(text).slice(0, 2000), profileName: null };
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
    const W = t.settings.webchat || {};
    const cfg = {
      api: `${config.publicUrl}/chat/${t.id}`,
      tenant: t.id,
      title: W.title || t.settings.business.name,
      subtitle: W.subtitle || 'Ask us anything – we usually reply instantly',
      color: /^#[0-9a-f]{3,8}$/i.test(W.color || '') ? W.color : t.settings.storefront?.brandColor || '#128c4a',
      position: W.position === 'left' ? 'left' : 'right',
      greeting: W.greeting || 'Hi',
      whatsapp: t.settings.business.whatsappNumber ? String(t.settings.business.whatsappNumber).replace(/\D/g, '') : null,
    };
    res.send(WIDGET.replace('__CFG__', JSON.stringify(cfg).replace(/</g, '\\u003c')));
  });
  return r;
}

const WIDGET = String.raw`(function(){
if(window.__waChat)return;window.__waChat=1;
var C=__CFG__,d=document,K='wachat-'+C.tenant,sid,last=0,open=false,polling,busy=0;
try{sid=localStorage.getItem(K)}catch(e){}
if(!sid){sid=(crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+Date.now()).replace(/[^A-Za-z0-9]/g,'').slice(0,32);try{localStorage.setItem(K,sid)}catch(e){}}
var css='.wc{position:fixed;bottom:20px;'+C.position+':20px;z-index:2147483000;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111}'+
'.wc-b{width:58px;height:58px;border-radius:50%;border:0;background:'+C.color+';color:#fff;font-size:26px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25)}'+
'.wc-p{position:absolute;bottom:72px;'+C.position+':0;width:min(370px,calc(100vw - 32px));height:min(560px,calc(100vh - 110px));background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden}'+
'.wc-p.on{display:flex}.wc-h{background:'+C.color+';color:#fff;padding:12px 14px}.wc-h b{display:block;font-size:15px}.wc-h span{opacity:.85;font-size:12px}.wc-x{float:right;background:none;border:0;color:#fff;font-size:20px;cursor:pointer}'+
'.wc-m{flex:1;overflow-y:auto;padding:12px;background:#f4f6f5;display:flex;flex-direction:column;gap:6px}.wc-q{max-width:85%;padding:8px 10px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}'+
'.wc-q.u{align-self:flex-end;background:'+C.color+';color:#fff}.wc-q.a{align-self:flex-start;background:#fff;box-shadow:0 1px 1px rgba(0,0,0,.06)}.wc-q img{max-width:100%;border-radius:8px;display:block;margin-bottom:4px}'+
'.wc-c{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.wc-c button,.wc-c a{border:1px solid #d6ddd9;background:#fff;color:'+C.color+';border-radius:9px;padding:5px 9px;cursor:pointer;font:inherit;font-size:13px;text-decoration:none}'+
'.wc-f{display:flex;gap:6px;padding:8px;border-top:1px solid #e3e8e5;background:#fff}.wc-f input{flex:1;border:1px solid #d6ddd9;border-radius:10px;padding:9px;font:inherit}.wc-f button{border:0;background:'+C.color+';color:#fff;border-radius:10px;padding:0 14px;cursor:pointer;font:inherit}'+
'.wc-w{font-size:12px;text-align:center;padding:4px;color:#667}.wc-w a{color:inherit}.wc-t{align-self:flex-start;color:#889;font-size:12px}';
var st=d.createElement('style');st.textContent=css;d.head.appendChild(st);
var w=d.createElement('div');w.className='wc';
w.innerHTML='<div class="wc-p" role="dialog" aria-label="Chat"><div class="wc-h"><button class="wc-x" aria-label="Close">×</button><b></b><span></span></div><div class="wc-m" aria-live="polite"></div><form class="wc-f"><input placeholder="Type a message…" aria-label="Message" maxlength="1000"><button>Send</button></form>'+(C.whatsapp?'<div class="wc-w">Prefer WhatsApp? <a target="_blank" rel="noopener" href="https://wa.me/'+C.whatsapp+'">Chat there</a></div>':'')+'</div><button class="wc-b" aria-label="Open chat">💬</button>';
w.querySelector('.wc-h b').textContent=C.title;w.querySelector('.wc-h span').textContent=C.subtitle;
var P=w.querySelector('.wc-p'),M=w.querySelector('.wc-m'),F=w.querySelector('form'),I=F.querySelector('input');
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
  fetch(C.api+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({sessionId:sid},body))})
  .then(function(r){return r.json()}).then(function(r){busy--;typing.remove();(r.replies||[]).forEach(render);if(r.lastId)last=Math.max(last,r.lastId)})
  .catch(function(){busy--;typing.remove();add('Sorry – connection problem, please try again.','a')});
}
function poll(){if(busy)return;fetch(C.api+'/poll?sessionId='+sid+'&after='+last).then(function(r){return r.json()}).then(function(r){if(last&&r.messages)r.messages.forEach(render);last=Math.max(last,r.lastId||0)}).catch(function(){})}
M.addEventListener('click',function(e){var b=e.target.closest('button[data-a]');if(b)send({actionId:b.dataset.a},b.dataset.l)});
F.onsubmit=function(e){e.preventDefault();var v=I.value.trim();if(!v)return;I.value='';send({text:v},v)};
function toggle(){open=!open;P.classList.toggle('on',open);if(open){I.focus();if(!M.children.length)send({text:C.greeting});clearInterval(polling);polling=setInterval(poll,8000);poll()}else clearInterval(polling)}
w.querySelector('.wc-b').onclick=toggle;w.querySelector('.wc-x').onclick=toggle;
(d.body||d.documentElement).appendChild(w);
})();`;
