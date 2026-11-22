import crypto from 'node:crypto';
import express from 'express';
import { getDb, json } from './db.js';
import { createTenant, getTenant, updateTenantSettings, deleteTenant } from './tenants.js';
import { applyTrade } from './trades.js';
import { createSender, logMessage } from './whatsapp/cloudApi.js';
import { handleInbound } from './bot/engine.js';
import { leadSummary } from './leads.js';
import { whenText } from './bookings.js';
import { listQuotes, updateQuote, sendQuote, runQuoteFollowUps } from './quotes.js';
import { sampleRun } from './sampleRun.js';

/*
 * Scripted demo scenarios (R1.3): "see it handle a real situation" without anyone typing.
 * Each scenario is a short script – a customer's taps and answers – played through the REAL assistant engine
 * (the same code that answers live chats) against a sample business that exists only for that run:
 *   • the sample business has no WhatsApp number, no email and no staff contacts, and every reply goes into a
 *     capture list – nothing can be sent to anyone;
 *   • it is deleted (with everything the run created) straight after the run;
 *   • the scripts use the menu, questions and flows – no AI calls – so the result is the same every time and costs
 *     nothing. Free-text questions in a live chat are answered by the AI from the business's own website.
 * The page and API label everything as a sample business with sample data. Results are cached for a few hours.
 */
export const SAMPLE = { name: 'Northside Plumbing & Heating', areas: ['LS1', 'LS2', 'LS3', 'LS4', 'LS5', 'LS6', 'LS7'], hours: 'Mon–Sat 8am–6pm' };
const CUSTOMER = 'Sam';

const sampleSettings = (extra = {}) => ({
  business: { name: SAMPLE.name, serviceAreas: SAMPLE.areas, supportHours: SAMPLE.hours, currencySymbol: '£' },
  store: { type: 'none' },
  followUps: { quietStart: 0, quietEnd: 0 },
  notifications: { alertEmails: [], staffWaIds: [], webhookUrl: '' },
  teamHours: { enabled: false }, // no team hours: "talk to a person" hands over at any time of day
  ...extra,
});

export const SCENARIOS = [
  {
    key: 'emergency', emoji: '🚨', title: 'Emergency plumber', channel: 'whatsapp',
    blurb: 'A burst pipe at 7am. The assistant takes the details one question at a time and flags it urgent for the team.',
    steps: [{ say: 'Hi' }, { tap: /Emergency/ }, { tap: /Morning/ }, { say: 'Water is coming through the kitchen ceiling from the bathroom' }, { say: 'LS6 2AB' }, { tap: /urgent/ }, { tap: /Skip/ }],
  },
  {
    key: 'photo_quote', emoji: '📷', title: 'Photo to quote', channel: 'website',
    blurb: 'A customer sends a photo of a leaking tap and asks for a price. A draft quote with the photo waits for the team to approve.',
    settings: { quotes: { enabled: true } },
    steps: [{ tap: /quote/i, start: true }, { photo: { name: 'tap.jpg', seen: 'a chrome kitchen mixer tap with water pooling at the base' } }, { say: 'The kitchen tap is leaking at the base – please quote to replace it' }, { say: 'sam@example.com' }],
  },
  {
    key: 'service_area', emoji: '📍', title: 'Outside the area', channel: 'whatsapp',
    blurb: 'Someone outside the areas covered asks for a call back. They are told kindly and honestly, and the team still gets the lead to decide.',
    steps: [{ action: 'lead:call:general', label: '📞 Call me back' }, { tap: /Afternoon/ }, { say: 'New outside tap fitted' }, { say: 'M1 1AA' }, { tap: /This week/ }, { tap: /Skip/ }],
  },
  {
    key: 'booking', emoji: '📅', title: 'Booking a visit', channel: 'whatsapp',
    blurb: 'A boiler service booked in four taps, from the real free times. The team confirms it – nothing is promised that isn\'t really free.',
    settings: { bookings: { enabled: true, autoConfirm: false, services: [{ name: 'Boiler service', minutes: 60, price: 85 }, { name: 'Leak repair visit', minutes: 60 }], times: ['08:00', '10:00', '12:00', '14:00', '16:00'], closedDays: [0], days: 14, perSlot: 1, leadHours: 2, reminderHours: 24 } },
    steps: [{ action: 'book', label: '📅 Book a visit' }, { pick: 0 }, { pick: 0 }, { tap: /book|confirm|yes/i }],
  },
  {
    key: 'human', emoji: '🙋', title: 'Talk to a person', channel: 'website',
    blurb: 'A customer asks for a real person. The chat is handed to the team inbox straight away and the assistant steps back.',
    steps: [{ say: 'Hi' }, { say: 'Can I speak to a real person please' }],
  },
  {
    key: 'follow_up', emoji: '🔁', title: 'Quote follow-up', channel: 'whatsapp',
    blurb: 'The team sends a quote. Two days later, with no reply, the assistant sends one friendly reminder – once, never in quiet hours.',
    settings: { quotes: { enabled: true } },
    steps: [{ tap: /quote/i, start: true }, { say: 'Please quote for a new kitchen mixer tap, fitted' }, { team: 'send_quote' }, { later: '2 days later, no reply yet', run: 'quote_follow_ups' }],
  },
];

const strip = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
const choices = (msgs) => msgs.flatMap((m) => [...(m.buttons || []).map((b) => ({ id: b.id, title: b.title })), ...(m.sections || []).flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title })))]);
// links into the sample business (calendar file, quote page) stop working once it is deleted: shown as [link]
const shown = (m) => ({ from: 'assistant', text: String(m.text || m.body || m.caption || '').replace(/\n*🤖 _[^_]*_\s*$/u, '').replace(/https?:\/\/\S+\/(b|q)\/\S+/g, '[link]').trim(), choices: choices([m]).map((c) => c.title) });

/** Play one scenario through the real engine. Returns { transcript, team, sample: true }. */
export function runScenario(key) {
  return sampleRun.run({ scenario: key }, () => playScenario(key)); // nothing leaves the server during the run
}
async function playScenario(key) {
  const sc = SCENARIOS.find((s) => s.key === key);
  if (!sc) return null;
  const { tenant } = createTenant({ name: `${SAMPLE.name} (sample)`, plan: 'pro' });
  const id = tenant.id;
  const transcript = [];
  const team = [];
  try {
    updateTenantSettings(id, { demo: { sample: true, scenario: key, expiresAt: new Date(Date.now() + 15 * 60000).toISOString() } });
    applyTrade(id, 'plumber');
    updateTenantSettings(id, sampleSettings(sc.settings));
    const waId = sc.channel === 'website' ? `web:sample${crypto.randomBytes(8).toString('hex')}` : `447700900${String(crypto.randomInt(0, 1000)).padStart(3, '0')}`; // 07700 900xxx: Ofcom's numbers for drama – nobody's
    let last = [];
    const sink = [];
    const send = createSender(getTenant(id), { sink });
    const play = async (ev) => {
      sink.length = 0;
      await handleInbound(getTenant(id), { profileName: CUSTOMER, ...ev, waId }, (to, m) => (to === waId ? send(to, m) : Promise.resolve()));
      last = [...sink];
      for (const m of last) transcript.push(shown(m));
    };
    for (const st of sc.steps) {
      if (st.say) { transcript.push({ from: 'customer', text: st.say }); await play({ kind: 'text', text: st.say }); continue; }
      if (st.photo) {
        // the website's photo upload stores the photo and (with AI vision on) a description of what it shows
        logMessage(id, waId, 'in', { type: 'file', text: `📎 [photo: ${st.photo.name}] – ${st.photo.seen}`, channel: 'web', fileUrl: '/site-assets/sample-photo.svg', fileName: st.photo.name, mime: 'image/jpeg' });
        transcript.push({ from: 'customer', text: `📷 ${st.photo.name}`, photo: true, note: `Sample photo – in a live chat the AI describes what it shows: "${st.photo.seen}"` });
        continue;
      }
      if (st.action) { transcript.push({ from: 'customer', text: st.label, tap: true }); await play({ kind: 'action', id: st.action, text: st.label }); continue; }
      if (st.tap || st.pick != null) {
        let c;
        if (st.start) c = (await startChoices(id, waId)).find((x) => st.tap.test(x.title));
        else if (st.pick != null) c = choices(last)[st.pick];
        else c = choices(last).find((x) => st.tap.test(x.title));
        if (!c) throw new Error(`scenario ${key}: no choice matching ${st.tap || st.pick}`);
        transcript.push({ from: 'customer', text: c.title, tap: true });
        await play({ kind: 'action', id: c.id, text: c.title });
        continue;
      }
      if (st.team === 'send_quote') {
        const q = listQuotes(id)[0];
        if (!q) throw new Error('no quote');
        await updateQuote(getTenant(id), q.number, { items: [{ item: 'Kitchen mixer tap (supplied and fitted)', qty: 1, price: 145 }] });
        sink.length = 0;
        await sendQuote(getTenant(id), q.number, { sender: send });
        transcript.push({ from: 'team', text: `The team prices quote Q-${q.number} in the dashboard (sample price) and taps Send.` });
        for (const m of sink) transcript.push(shown(m));
        continue;
      }
      if (st.run === 'quote_follow_ups') {
        getDb().prepare("UPDATE quotes SET sent_at = datetime('now', '-2 days', '-1 hour') WHERE tenant_id = ?").run(id);
        sink.length = 0;
        await runQuoteFollowUps({ tenantId: id, sender: send });
        transcript.push({ from: 'time', text: st.later });
        for (const m of sink) transcript.push(shown(m));
        continue;
      }
    }
    team.push(...teamView(id, waId));
  } finally {
    try { deleteTenant(id); } catch (e) { console.warn('[scenario] cleanup', e.message); }
  }
  return { key, title: sc.title, channel: sc.channel, business: SAMPLE.name, sample: true, transcript, team, ranAt: new Date().toISOString() };
}

/** The first menu a customer sees (welcome menu) – for scripts that start by tapping an option. */
async function startChoices(id, waId) {
  const sink = [];
  await handleInbound(getTenant(id), { waId: `${waId}-peek`, kind: 'text', text: 'menu', profileName: CUSTOMER }, (to, m) => { sink.push(m); return Promise.resolve(); });
  return choices(sink);
}

/** What the team sees after the run: leads, bookings, quotes, hand-overs. */
function teamView(id, waId) {
  const d = getDb();
  const out = [];
  for (const l of d.prepare('SELECT * FROM chat_leads WHERE tenant_id = ?').all(id)) {
    const lead = { kind: l.kind, topic: l.topic, name: l.name, phone: l.phone, email: l.email, callTime: l.call_time, message: l.message, urgent: !!l.urgent, answers: json(l.answers, null) };
    const area = json(l.area, null);
    out.push({ kind: 'lead', title: `${l.urgent ? '🚨 Urgent lead' : '📇 New lead'} – the team is alerted straight away (email, plus WhatsApp to staff numbers you add)`, text: leadSummary(null, lead) + (area?.covered === false ? `\n⚠️ ${area.postcode} is outside the areas you cover` : area?.covered ? `\n✅ ${area.postcode} is in your area` : '') });
  }
  for (const b of d.prepare('SELECT * FROM bookings WHERE tenant_id = ?').all(id)) out.push({ kind: 'booking', title: b.status === 'confirmed' ? '📅 Booking confirmed' : '📅 Booking request – waiting for the team to confirm', text: `${b.service ? `${b.service} · ` : ''}${whenText(b)}${b.name ? ` · ${b.name}` : ''}` });
  for (const q of listQuotes(id)) {
    const photos = q.photos || [];
    out.push({ kind: 'quote', title: q.status === 'draft' ? '📝 Draft quote – the team adds prices and approves it' : `📝 Quote Q-${q.number} – ${q.status}`, text: `Q-${q.number}: "${String(q.request || '').slice(0, 160)}"${photos.length ? `\n📷 ${photos.length} photo attached from the chat` : ''}${q.followed_up_at ? '\n🔁 One follow-up sent' : ''}` });
  }
  const conv = d.prepare('SELECT human_handover FROM conversations WHERE tenant_id = ? AND wa_id = ?').get(id, waId);
  if (conv?.human_handover) out.push({ kind: 'handover', title: '🙋 In the team inbox', text: 'The chat is waiting in the Inbox with the whole conversation, and the assistant stays quiet while the team replies. If the customer writes again and nobody from the team has replied for 15 minutes, the assistant answers, so they\'re never talking to silence.' });
  return out;
}

const CACHE_HOURS = 6;
/** A cached run (the same script gives the same result); re-run after a few hours or after a deploy. */
export async function scenarioResult(key, { fresh = false } = {}) {
  const k = `scenario:${key}`;
  if (!fresh) {
    const r = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(k);
    const v = json(r?.value, null);
    if (v && Date.now() - Date.parse(v.ranAt) < CACHE_HOURS * 3600000 && v.version === VERSION) return v;
  }
  const v = await runScenario(key);
  if (!v) return null;
  v.version = VERSION;
  getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
  return v;
}
const VERSION = 2;

export const scenarioList = () => SCENARIOS.map(({ key, emoji, title, blurb, channel }) => ({ key, emoji, title, blurb, channel }));

// ---------- the public page: /examples ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (s) => esc(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,)])/g, '$1<i>$2</i>').replace(/\n/g, '<br>');
const CSS = `.sc-nav{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}.sc-nav a{border:1px solid var(--line);border-radius:999px;padding:6px 12px;text-decoration:none;color:var(--ink);background:var(--card);font-size:15px}
.sc{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:18px;margin:22px 0;scroll-margin-top:80px}.sc h2{margin:0 0 4px}
.chat{background:var(--bg);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;margin:12px 0}
.b{max-width:85%;padding:8px 12px;border-radius:12px;font-size:15px;line-height:1.45;word-wrap:break-word}.b.c{align-self:flex-end;background:var(--brand);color:#fff;border-bottom-right-radius:4px}.b.a{align-self:flex-start;background:var(--card);border:1px solid var(--line);border-bottom-left-radius:4px}
.b .ch{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.b .ch span{border:1px solid var(--brand);color:var(--brand);border-radius:999px;padding:2px 10px;font-size:13px}
.note{align-self:center;font-size:13px;color:var(--mute);background:var(--soft);border-radius:999px;padding:3px 12px;text-align:center}
.team{border-left:4px solid var(--brand);background:var(--soft);border-radius:8px;padding:10px 12px;margin-top:8px;font-size:15px}.team b{display:block;margin-bottom:4px}
.sample{display:inline-block;background:#fff4d6;color:#7a4b00;border-radius:6px;padding:2px 8px;font-size:13px;font-weight:600}`;

function scenarioHtml(sc, r) {
  const bubbles = r.transcript.map((m) => {
    if (m.from === 'customer') return `<div class="b c">${fmt(m.text)}${m.note ? `<div style="font-size:12px;opacity:.85;margin-top:4px">${esc(m.note)}</div>` : ''}</div>`;
    if (m.from === 'team' || m.from === 'time') return `<div class="note">${m.from === 'time' ? '⏱️ ' : '👩‍🔧 '}${esc(m.text)}</div>`;
    return `<div class="b a">${fmt(m.text)}${m.choices?.length ? `<div class="ch">${m.choices.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}</div>`;
  }).join('');
  return `<section class="sc" id="${esc(sc.key)}"><h2>${sc.emoji} ${esc(sc.title)}</h2><p class="mute" style="margin:0">${esc(sc.blurb)} <span class="mute">· ${sc.channel === 'website' ? '🌐 Website chat' : '📱 WhatsApp'}</span></p>
<div class="chat" role="log" aria-label="${esc(sc.title)} conversation">${bubbles}</div>
${r.team.map((t) => `<div class="team"><b>What the team gets: ${esc(t.title)}</b>${fmt(t.text)}</div>`).join('')}</section>`;
}

export function scenariosRouter(layout) {
  const r = express.Router();
  r.get('/examples', async (req, res) => {
    const results = [];
    for (const sc of SCENARIOS) {
      try { results.push([sc, await scenarioResult(sc.key)]); } catch (e) { console.warn('[scenario]', sc.key, e.message); }
    }
    const body = `<section class="hero"><div class="wrap" style="max-width:820px">
<h1>See it handle real situations</h1>
<p class="lead">Six everyday moments for a trades business – an emergency, a photo, a booking, someone outside your area – played through the real assistant, step by step, with what your team receives at the end.</p>
<p><span class="sample">Sample business · sample data</span> <span class="mute">“${esc(SAMPLE.name)}” isn't a real company. Each conversation is a fixed script run through the same engine that answers live chats; nothing is sent to anyone, and the sample business is deleted after each run. In a live chat, questions typed in the customer's own words are answered by the AI from your own website.</span></p>
<nav class="sc-nav" aria-label="Scenarios">${results.map(([sc]) => `<a href="#${esc(sc.key)}">${sc.emoji} ${esc(sc.title)}</a>`).join('')}</nav>
${results.map(([sc, res]) => scenarioHtml(sc, res)).join('')}
<p style="margin-top:28px"><a class="btn" href="/try">Try it on your own website</a> <a class="btn ghost" href="/demo">Book a demo</a></p>
</div></section>`;
    res.type('html').set('Cache-Control', 'public, max-age=300').send(layout('/examples', body, { extraHead: `<style>${CSS}</style>`, ld: [{ '@type': 'WebPage', name: 'See it handle real situations', description: 'Scripted examples run through the real assistant engine with a sample business.' }] }));
  });
  r.get('/examples/:key.json', async (req, res) => {
    if (!SCENARIOS.some((s) => s.key === req.params.key)) return res.status(404).json({ error: 'No such example' });
    try { res.set('Cache-Control', 'public, max-age=300').json(await scenarioResult(req.params.key)); } catch (e) { res.status(500).json({ error: 'Could not run the example' }); }
  });
  return r;
}
