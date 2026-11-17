import express from 'express';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRates, FREE_SERVICE_PER_MONTH, RATES_CHECKED_ON } from './metaPricing.js';
import { sendEmail } from './email.js';
import { rateLimit } from './routes/web.js';

/*
 * Public page /whatsapp-fee-checker: "how much is your WhatsApp provider adding on top of Meta's own fees?"
 * The monthly markup shows straight away. The yearly figure and the per-category breakdown unlock when the
 * visitor gives a name and business email: saved in fee_checker_leads with every input and result, and the
 * result is emailed to them. Marketing consent is a separate tickbox, unticked by default (PECR).
 * Meta's rates come from src/meta-rates.json (UK rates only here).
 *
 * feeInputs, computeFees, monthlyHtml and breakdownHtml are self-contained on purpose: the page embeds
 * their source so the browser and the server always work the figure out the same way.
 */
export const PATH = '/whatsapp-fee-checker';
export const PROVIDERS = ['Wati', 'Interakt', 'AiSensy', 'Gallabox', 'Respond.io', 'Trengo', 'Twilio', '360dialog', 'Other'];
export const ukRates = () => getRates().GB || getRates().DEFAULT;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const brand = () => config.productName || 'WhatsApp Commerce';
const url = (p = '/') => `${config.publicUrl}${p}`;
const clean = (v, n = 200) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);
const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
export const optInText = () => `Yes, send me occasional tips and offers from ${brand()} by email. I can unsubscribe at any time.`;

/** Visitor's numbers, cleaned. Missing values get sensible defaults; bad or negative values too. */
export function feeInputs(q) {
  q = q || {};
  const num = (v, d, max, int) => {
    if (v === undefined || v === null || v === '') return d;
    let n = Number(v);
    if (!Number.isFinite(n) || n < 0) return d;
    n = Math.min(n, max);
    return int ? Math.floor(n) : Math.round(n * 100) / 100;
  };
  return {
    provider: String(q.provider || '').replace(/[\r\n<>"]+/g, ' ').trim().slice(0, 60),
    numbers: Math.max(1, num(q.numbers, 1, 50, true)),
    marketing: num(q.marketing, 1000, 10000000, true),
    utility: num(q.utility, 500, 10000000, true),
    authentication: num(q.authentication, 0, 10000000, true),
    service: num(q.service, 2500, 10000000, true),
    markupPct: num(q.markupPct, 20, 500),
    perMessageFee: num(q.perMessageFee, 0, 100),
    users: num(q.users, 3, 1000, true),
    perUserFee: num(q.perUserFee, 0, 1000),
  };
}

/**
 * What the provider adds on top of Meta's own charge, per month.
 * Service messages: the first `free` a month are free for EACH number, so they cost nothing at Meta and we add
 * no markup on them. Markup = markup % of Meta's charge + per-message fee (pence) on each paid message,
 * plus per-user fees.
 */
export function computeFees(i, rates, free) {
  const r2 = (x) => Math.round(x * 100) / 100;
  const cats = [['marketing', 'Marketing'], ['utility', 'Utility (order updates)'], ['authentication', 'Authentication (codes)'], ['service', 'Service (replies)']];
  const lines = cats.map(function (c) {
    const key = c[0];
    const count = i[key];
    const freeN = key === 'service' ? free * i.numbers : 0;
    const paid = Math.max(0, count - freeN);
    const meta = paid * rates[key];
    const markup = meta * i.markupPct / 100 + paid * i.perMessageFee / 100;
    return { key: key, label: c[1], count: count, free: Math.min(count, freeN), paid: paid, rate: rates[key], meta: r2(meta), markup: r2(markup) };
  });
  lines.push({ key: 'users', label: 'Per-user fees', count: i.users, free: 0, paid: i.users, rate: i.perUserFee, meta: 0, markup: r2(i.users * i.perUserFee) });
  const metaCost = r2(lines.reduce(function (s, l) { return s + l.meta; }, 0));
  const monthlyMarkup = r2(lines.reduce(function (s, l) { return s + l.markup; }, 0));
  return { lines: lines, metaCost: metaCost, providerCost: r2(metaCost + monthlyMarkup), monthlyMarkup: monthlyMarkup, yearlyMarkup: r2(monthlyMarkup * 12) };
}

export function monthlyHtml(out) {
  const v = out.monthlyMarkup;
  return '<p class="mute" style="margin:0">On top of Meta’s own fees, you pay about</p>'
    + '<p class="big"><span id="fc-monthly">£' + Math.round(v).toLocaleString('en-GB') + '</span><span style="font-size:20px;font-weight:600"> a month</span></p>'
    + (v < 1 ? '<p>Your provider adds little or nothing to Meta’s rates. Nice.</p>' : '');
}

export function breakdownHtml(out) {
  const m = function (x) { return '£' + x.toFixed(2); };
  const p = function (x) { return +(x * 100).toFixed(2) + 'p'; };
  const n = function (x) { return x.toLocaleString('en-GB'); };
  const rows = out.lines.filter(function (l) { return l.count || l.markup; }).map(function (l) {
    const users = l.key === 'users';
    return '<tr><td>' + l.label + '</td><td>' + n(l.count) + (users ? ' users' : '') + (l.free ? ' <span class="mute">(' + n(l.free) + ' free)</span>' : '')
      + '</td><td>' + (users ? m(l.rate) + ' each' : p(l.rate)) + '</td><td>' + (users ? '–' : m(l.meta)) + '</td><td><b>' + m(l.markup) + '</b></td></tr>';
  }).join('');
  return '<p class="mute" style="margin:16px 0 0">Over a year, that’s</p><p class="big" id="fc-yearly">£' + Math.round(out.yearlyMarkup).toLocaleString('en-GB') + '</p>'
    + '<div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>Category</th><th>Count a month</th><th>Meta rate</th><th>Meta charges</th><th>Your provider adds</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="5" class="mute">Nothing sent yet.</td></tr>')
    + '<tr><th scope="row">Total a month</th><td></td><td></td><th>' + m(out.metaCost) + '</th><th>' + m(out.monthlyMarkup) + '</th></tr></tbody></table></div>'
    + '<p class="mute" style="font-size:15px">Your provider bill: about ' + m(out.providerCost) + ' a month. At Meta’s own rates the messages cost ' + m(out.metaCost) + '.</p>';
}

const qs = (i) => new URLSearchParams(Object.entries(i).map(([k, v]) => [k, String(v)])).toString();

function ctaHtml() {
  const href = config.signupEnabled ? '/signup' : '/demo';
  return `<div class="callout" style="margin-top:18px"><h3>Switch to ${esc(brand())}: Meta fees at cost, no per-user fees, cancel anytime</h3>
<p style="margin:6px 0 12px">Meta bills you directly at its own rates. We don't add a penny to your messages.</p>
<a class="btn" id="fc-trial" href="${href}">${config.signupEnabled ? 'Start your free trial' : 'Book a demo'}</a></div>`;
}

function leadFormHtml(i, { error = '', name = '', email = '' } = {}) {
  return `<form class="card" id="fc-lead" method="post" action="${PATH}" style="margin-top:16px;background:var(--bg)">
<h3>See your yearly cost and where it comes from</h3>
<p>Get the yearly figure and the breakdown by message type. We'll email you a copy too.</p>
${error ? `<p style="color:var(--warn)" role="alert">${esc(error)}</p>` : ''}
${Object.entries(i).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}
<label for="fl-name">Your name</label><input id="fl-name" name="name" required autocomplete="name" maxlength="120" value="${esc(name)}">
<label for="fl-email">Business email</label><input id="fl-email" name="email" type="email" required autocomplete="email" maxlength="200" value="${esc(email)}">
<label style="display:flex;gap:10px;align-items:flex-start;font-weight:400"><input type="checkbox" name="marketingOptIn" value="1" style="width:auto;margin-top:5px"> <span>${esc(optInText())}</span></label>
<div class="hp" aria-hidden="true"><label>Leave empty<input name="company_website" tabindex="-1" autocomplete="off"></label></div>
<p><button class="btn" type="submit">Show my yearly cost</button></p><p id="fc-msg" class="mute" aria-live="polite"></p>
<p class="mute" style="font-size:14px">We use your details to send you this result${' '}and, only if you tick the box, occasional tips. See our <a href="/legal/privacy">privacy policy</a>.</p>
</form>`;
}

export function feePage(layout, i, { unlocked = false, emailed = null, error = '', name = '', email = '' } = {}) {
  const rates = ukRates();
  const out = computeFees(i, rates, FREE_SERVICE_PER_MONTH);
  const pence = (x) => `${+(x * 100).toFixed(2)}p`;
  const field = (k, label, help = '', step = '1') => `<label for="fc-${k}">${label}</label><input id="fc-${k}" name="${k}" type="number" min="0" step="${step}" inputmode="decimal" value="${esc(i[k])}">${help ? `<div class="mute" style="font-size:14px">${help}</div>` : ''}`;
  const unlockedHtml = `<div id="fc-breakdown">${breakdownHtml(out)}</div>${emailed === null ? '' : `<p class="mute">${emailed ? 'We’ve emailed this to you too.' : 'We couldn’t email it just now, but your result is above.'}</p>`}`;
  return layout(PATH, `
<section class="hero"><div class="wrap">
<h1>Are you paying too much for WhatsApp?</h1>
<p class="lead">Most WhatsApp platforms add a markup to Meta's message fees, and many charge per user as well. Enter what you send and what your provider charges. We'll show you what you pay on top of Meta's own UK rates.</p>
</div></section>

<section style="border-top:0;padding-top:0"><div class="wrap grid" style="align-items:start">
<form class="card" id="fc" method="get" action="${PATH}">
<label for="fc-provider">Who do you use now? (optional)</label><select id="fc-provider" name="provider"><option value="">Choose…</option>${PROVIDERS.map((p) => `<option${p === i.provider ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
${field('numbers', 'How many WhatsApp numbers?')}
<h3 style="margin-top:20px">Messages you send in a typical month</h3>
${field('marketing', 'Marketing', 'Offers, newsletters, "we miss you" messages.')}
${field('utility', 'Utility', 'Order, delivery and booking updates.')}
${field('authentication', 'Authentication', 'Login or verification codes. Most shops send none.')}
${field('service', 'Service', `Replies to customers who message you first. The first ${FREE_SERVICE_PER_MONTH.toLocaleString('en-GB')} a month are free for each number.`)}
<h3 style="margin-top:20px">What your provider charges</h3>
${field('markupPct', "Markup on Meta's fees (%)", 'Check your invoice or their pricing page. Put 0 if they pass Meta’s fees on at cost.', '0.1')}
${field('perMessageFee', 'Extra fee per message (pence)', 'Some providers add a flat fee to each message. Put 0 if not.', '0.01')}
${field('users', 'Team members using it')}
${field('perUserFee', 'Fee per user per month (£)', 'Put 0 if users are included in your plan.', '0.01')}
<p><button class="btn" type="submit">Check my fees</button></p>
</form>
<div class="card" aria-live="polite">
<div id="fc-month">${monthlyHtml(out)}</div>
<div id="fc-unlock">${unlocked ? unlockedHtml : leadFormHtml(i, { error, name, email })}</div>
${ctaHtml()}
<p style="margin-top:14px"><a id="fc-share" href="${esc(`${PATH}?${qs(i)}`)}">Link to these numbers</a></p>
</div>
</div></section>

<section><div class="wrap">
<h2>How we work it out</h2>
<ul class="plain">
<li>Meta's UK rates per message: marketing ${pence(rates.marketing)}, utility ${pence(rates.utility)}, authentication ${pence(rates.authentication)}, service ${pence(rates.service)}.</li>
<li>Service replies: the first ${FREE_SERVICE_PER_MONTH.toLocaleString('en-GB')} a month are free for each WhatsApp number. Meta charges nothing for those, so we count no markup on them.</li>
<li>What your provider adds = its markup % of Meta's charge, plus any per-message fee on each paid message, plus per-user fees.</li>
<li>Monthly platform fees aren't included. This is only what you pay above Meta's rates for the messages themselves, and for users.</li>
</ul>
<p class="mute">Meta's rates checked against its rate card on ${esc(RATES_CHECKED_ON)}. Meta changes them from time to time. To work out the Meta bill itself, use the <a href="/whatsapp-cost-calculator">WhatsApp cost calculator</a>.</p>
</div></section>
<script>
(() => {
  const PATH = ${JSON.stringify(PATH)}, RATES = ${JSON.stringify(rates)}, FREE = ${FREE_SERVICE_PER_MONTH};
  ${feeInputs}
  ${computeFees}
  ${monthlyHtml}
  ${breakdownHtml}
  const f = document.getElementById('fc');
  let unlocked = ${unlocked ? 'true' : 'false'};
  const vals = () => { const o = Object.fromEntries(new FormData(f)); for (const k in o) if (k !== 'provider' && o[k] === '') o[k] = '0'; return o; };
  const run = () => {
    const i = feeInputs(vals()), out = computeFees(i, RATES, FREE);
    document.getElementById('fc-month').innerHTML = monthlyHtml(out);
    if (unlocked) document.getElementById('fc-breakdown').innerHTML = breakdownHtml(out);
    const q = new URLSearchParams(Object.entries(i).map(([k, v]) => [k, String(v)])).toString();
    document.getElementById('fc-share').href = PATH + '?' + q;
    history.replaceState(null, '', PATH + '?' + q);
    const l = document.getElementById('fc-lead');
    if (l) for (const k in i) if (l.elements[k] && l.elements[k].type === 'hidden') l.elements[k].value = i[k];
  };
  f.addEventListener('input', run); f.addEventListener('change', run);
  f.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  const l = document.getElementById('fc-lead');
  if (l) l.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('fc-msg'); msg.textContent = 'Working it out…';
    const body = { ...Object.fromEntries(new FormData(l)), ...vals(), marketingOptIn: l.elements.marketingOptIn.checked };
    const r = await fetch(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ ok: false }));
    if (!r.ok) { msg.textContent = r.error || 'Sorry, that didn’t work. Please try again.'; return; }
    unlocked = true;
    document.getElementById('fc-unlock').innerHTML = '<div id="fc-breakdown"></div><p class="mute">' + (r.emailed ? 'We’ve emailed this to you too.' : 'We couldn’t email it just now, but your result is above.') + '</p>';
    run();
  });
})();
</script>`, {
    noindex: unlocked || !!error,
    ld: [{ '@type': 'WebApplication', name: 'WhatsApp fee checker (UK)', url: url(PATH), applicationCategory: 'BusinessApplication', operatingSystem: 'Web', offers: { '@type': 'Offer', price: '0', priceCurrency: 'GBP' } }],
  });
}

/** Save the lead with every input and result. Returns its id. */
export function saveFeeLead({ name, email, i, out, optIn }) {
  return Number(getDb().prepare(`INSERT INTO fee_checker_leads (name, email, provider, numbers, marketing_msgs, utility_msgs, authentication_msgs, service_msgs,
      markup_pct, per_message_fee_p, users, per_user_fee, meta_cost, provider_cost, monthly_markup, yearly_markup, breakdown, rates_checked_on,
      marketing_opt_in, opt_in_text, opt_in_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, email, i.provider || null, i.numbers, i.marketing, i.utility, i.authentication, i.service, i.markupPct, i.perMessageFee, i.users, i.perUserFee,
      out.metaCost, out.providerCost, out.monthlyMarkup, out.yearlyMarkup, JSON.stringify(out.lines), RATES_CHECKED_ON,
      optIn ? 1 : 0, optIn ? optInText() : null, optIn ? new Date().toISOString() : null).lastInsertRowid);
}

function resultEmail(name, i, out) {
  const m = (x) => `£${x.toFixed(2)}`;
  const link = url(`${PATH}?${qs(i)}`);
  const trial = url(config.signupEnabled ? '/signup' : '/demo');
  const lines = out.lines.filter((l) => l.count || l.markup);
  const text = `Hi ${name},

Here's your WhatsApp fee check.

On top of Meta's own fees, you pay about ${m(out.monthlyMarkup)} a month: ${m(out.yearlyMarkup)} a year.

${lines.map((l) => `${l.label}: ${l.count.toLocaleString('en-GB')}${l.key === 'users' ? ' users' : ''}${l.free ? ` (${l.free.toLocaleString('en-GB')} free)` : ''}, your provider adds ${m(l.markup)}`).join('\n')}

Your provider bill: about ${m(out.providerCost)} a month. At Meta's own rates the messages cost ${m(out.metaCost)}.

Switch to ${brand()}: Meta fees at cost, no per-user fees, cancel anytime.
${config.signupEnabled ? 'Start your free trial' : 'Book a demo'}: ${trial}

See or change your numbers: ${link}

Meta's UK rates checked on ${RATES_CHECKED_ON}. Meta bills you directly and changes rates from time to time.

${brand()}${config.supportEmail ? ` · ${config.supportEmail}` : ''}
You're getting this email because you asked for your result on ${url(PATH)}.`;
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;color:#14201a">
<p>Hi ${esc(name)},</p><p>Here's your WhatsApp fee check.</p>
<p style="margin:0;color:#56645c">On top of Meta's own fees, you pay about</p><p style="font-size:32px;font-weight:700;margin:0">${esc(m(out.monthlyMarkup))} a month</p><p style="margin:0 0 14px"><b>${esc(m(out.yearlyMarkup))} a year</b></p>
<table style="border-collapse:collapse;width:100%"><tr><th align="left" style="padding:6px;border-bottom:1px solid #dde4e0">Category</th><th align="left" style="padding:6px;border-bottom:1px solid #dde4e0">Count a month</th><th align="left" style="padding:6px;border-bottom:1px solid #dde4e0">Meta charges</th><th align="left" style="padding:6px;border-bottom:1px solid #dde4e0">Your provider adds</th></tr>
${lines.map((l) => `<tr><td style="padding:6px;border-bottom:1px solid #dde4e0">${esc(l.label)}</td><td style="padding:6px;border-bottom:1px solid #dde4e0">${l.count.toLocaleString('en-GB')}${l.key === 'users' ? ' users' : ''}${l.free ? ` (${l.free.toLocaleString('en-GB')} free)` : ''}</td><td style="padding:6px;border-bottom:1px solid #dde4e0">${l.key === 'users' ? '–' : esc(m(l.meta))}</td><td style="padding:6px;border-bottom:1px solid #dde4e0"><b>${esc(m(l.markup))}</b></td></tr>`).join('')}
<tr><th align="left" style="padding:6px">Total a month</th><td></td><th align="left" style="padding:6px">${esc(m(out.metaCost))}</th><th align="left" style="padding:6px">${esc(m(out.monthlyMarkup))}</th></tr></table>
<div style="background:#e6f4ec;border-radius:12px;padding:16px;margin:18px 0"><b>Switch to ${esc(brand())}: Meta fees at cost, no per-user fees, cancel anytime</b><br>
<a href="${esc(trial)}" style="display:inline-block;margin-top:10px;background:#128c4a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600">${config.signupEnabled ? 'Start your free trial' : 'Book a demo'}</a></div>
<p><a href="${esc(link)}">See or change your numbers</a></p>
<p style="color:#56645c;font-size:13px">Meta's UK rates checked on ${esc(RATES_CHECKED_ON)}. Meta bills you directly and changes rates from time to time.<br>${esc(brand())}. You're getting this email because you asked for your result on ${esc(url(PATH))}.</p></div>`;
  return { subject: `Your WhatsApp fee check: about ${m(out.yearlyMarkup)} a year above Meta's rates`, text, html };
}

export function feeCheckerRouter(layout) {
  const r = express.Router();
  const send = (res, body, status = 200, cache = true) => res.status(status).type('html').set('Cache-Control', cache ? 'public, max-age=300' : 'no-store').send(body);
  r.get(PATH, (req, res) => send(res, feePage(layout, feeInputs(req.query))));
  r.post(PATH, rateLimit({ windowMs: 3600000, max: 10 }), express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
    const b = req.body || {};
    const wantsJson = /json/.test(req.get('accept') || '');
    const i = feeInputs(b);
    const out = computeFees(i, ukRates(), FREE_SERVICE_PER_MONTH);
    const name = clean(b.name, 120);
    const email = clean(b.email, 200);
    const optIn = b.marketingOptIn === true || ['1', 'on', 'true', 'yes'].includes(String(b.marketingOptIn ?? '').toLowerCase());
    const ok = (emailed) => (wantsJson ? res.json({ ok: true, html: breakdownHtml(out), emailed }) : send(res, feePage(layout, i, { unlocked: true, emailed }), 200, false));
    if (b.company_website) return ok(false); // bot trap: show the result, save nothing
    if (!name || !isEmail(email)) {
      const error = 'Please enter your name and a valid business email.';
      return wantsJson ? res.status(400).json({ ok: false, error }) : send(res, feePage(layout, i, { error, name, email }), 400, false);
    }
    const id = saveFeeLead({ name, email, i, out, optIn });
    const msg = resultEmail(name, i, out);
    const mail = await sendEmail({ to: email, replyTo: config.supportEmail, ...msg });
    getDb().prepare('UPDATE fee_checker_leads SET email_sent = ?, email_error = ? WHERE id = ?').run(mail.ok ? 1 : 0, mail.ok ? null : String(mail.error || '').slice(0, 300), id);
    if (config.supportEmail) {
      sendEmail({ to: config.supportEmail, replyTo: email, subject: `Fee checker lead: ${name} (about £${Math.round(out.yearlyMarkup)} a year markup)`,
        text: `${name} <${email}>\nProvider: ${i.provider || 'not given'}\nMarkup: £${out.monthlyMarkup.toFixed(2)} a month, £${out.yearlyMarkup.toFixed(2)} a year\nMarketing emails: ${optIn ? 'yes, opted in' : 'no'}\n\nTheir numbers: ${url(`${PATH}?${qs(i)}`)}\nLead #${id}. Reply to this email to answer them.` }).catch(() => {});
    }
    ok(mail.ok);
  });
  return r;
}
