import express from 'express';
import { config } from './config.js';
import { getDb } from './db.js';
import { getTenant } from './tenants.js';
import { getRates, FREE_SERVICE_PER_MONTH, RATES_CHECKED_ON } from './metaPricing.js';
import { sendEmail } from './email.js';
import { rateLimit } from './routes/web.js';

/*
 * The public marketing website: home, pricing, takeaways, the WhatsApp cost calculator and "book a demo".
 * Server-rendered HTML (no JavaScript needed to read it) so search engines and AI assistants can index it.
 * Brand, contact details and the homepage chat come from the super admin Setup tab.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const brand = () => config.productName || 'WhatsApp Commerce';
const url = (path = '/') => `${config.publicUrl}${path}`;
const BUILT = new Date().toISOString().slice(0, 10);
const legal = () => ({
  company: process.env.LEGAL_COMPANY_NAME || '',
  number: process.env.LEGAL_COMPANY_NUMBER || '',
  address: process.env.LEGAL_ADDRESS || '',
});

export const PAGES = [
  { path: '/', title: () => `WhatsApp and website AI assistant for UK small businesses | ${brand()}`, description: 'Answer customer questions, take orders and recover abandoned carts on WhatsApp and your website. Set up for you in a day.' },
  { path: '/pricing', title: () => `Pricing | ${brand()}`, description: "Plans from £29 a month, plus a set-up service. A clear explanation of Meta's own per-message fees, so there are no surprises." },
  { path: '/takeaways', title: () => `WhatsApp ordering for UK takeaways | ${brand()}`, description: 'Take orders and answer questions on WhatsApp automatically. No commission per order, unlike the delivery apps.' },
  { path: '/whatsapp-cost-calculator', title: () => 'WhatsApp Business API cost calculator (UK, 2026)', description: 'Work out what Meta will charge you per month. Current UK rates, free service-message allowance included.' },
  { path: '/demo', title: () => `Book a demo | ${brand()}`, description: `Book 20 minutes. We load your website into ${brand()} live on the call and you ask it what your customers ask you.` },
];
const page = (path) => PAGES.find((p) => p.path === path);

const CSS = `:root{--bg:#f6f8f7;--card:#fff;--ink:#14201a;--mute:#56645c;--line:#dde4e0;--brand:#128c4a;--brand2:#0b6b38;--soft:#e6f4ec;--warn:#b5470b}
@media (prefers-color-scheme:dark){:root{--bg:#0e1411;--card:#16201a;--ink:#e8f0ea;--mute:#9cada3;--line:#28352d;--brand:#1fa055;--brand2:#25b862;--soft:#173322}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font:17px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand)}.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
header .wrap{display:flex;align-items:center;gap:18px;min-height:60px;flex-wrap:wrap}.logo{font-weight:700;font-size:18px;color:var(--ink);text-decoration:none;flex:1}
nav{display:flex;gap:16px;flex-wrap:wrap;align-items:center}nav a{text-decoration:none;color:var(--mute);font-size:15px}nav a:hover,nav a[aria-current]{color:var(--ink)}
.btn{display:inline-block;background:var(--brand);color:#fff!important;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600;border:0;cursor:pointer;font:inherit;font-weight:600}.btn:hover{background:var(--brand2)}
.btn.small{padding:8px 14px;font-size:15px}.btn.ghost{background:none;color:var(--brand)!important;border:1px solid var(--line)}
h1{font-size:clamp(32px,5vw,50px);line-height:1.1;margin:0 0 16px;letter-spacing:-.02em}h2{font-size:clamp(24px,3.4vw,34px);line-height:1.2;margin:0 0 12px;letter-spacing:-.01em}h3{font-size:19px;margin:0 0 6px}
.lead{font-size:20px;color:var(--mute);max-width:760px;margin:0 0 24px}.mute{color:var(--mute)}
section{padding:52px 0;border-top:1px solid var(--line)}section.hero{border-top:0;padding:64px 0 44px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}.card p{margin:0;color:var(--mute)}
ol.steps{list-style:none;padding:0;margin:0;counter-reset:s;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
ol.steps li{counter-increment:s;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}ol.steps li::before{content:counter(s);display:inline-flex;width:30px;height:30px;border-radius:50%;background:var(--soft);color:var(--brand);font-weight:700;align-items:center;justify-content:center;margin-bottom:8px}
ul.ticks{padding:0;list-style:none;margin:0;display:grid;gap:10px}ul.ticks li{padding-left:28px;position:relative}ul.ticks li::before{content:"✓";position:absolute;left:0;color:var(--brand);font-weight:700}
ul.plain{padding-left:20px;margin:0;display:grid;gap:8px}
.callout{background:var(--soft);border-radius:16px;padding:22px}
.faq details{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:8px 0}.faq summary{font-weight:600;cursor:pointer}.faq p{margin:8px 0 0;color:var(--mute)}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden}th,td{padding:12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:14px;color:var(--mute)}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
.price{font-size:36px;font-weight:700}.pill{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:2px 10px;font-size:13px;color:var(--mute)}
label{display:block;font-size:15px;font-weight:600;margin:14px 0 4px}input,select,textarea{width:100%;padding:11px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:inherit}
.big{font-size:44px;font-weight:700;margin:0}.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
footer{border-top:1px solid var(--line);padding:36px 0 48px;color:var(--mute);font-size:15px}footer .wrap{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}footer a{color:var(--mute)}footer ul{list-style:none;padding:0;margin:0;display:grid;gap:6px}
@media (max-width:640px){header{position:static}body{font-size:16px}.lead{font-size:18px}section{padding:40px 0}nav{gap:12px}}`;

const ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#128c4a"/><path d="M18 44l3-9a14 14 0 1 1 6 6z" fill="#fff"/></svg>')}`;

function faqLd(items) {
  return { '@type': 'FAQPage', mainEntity: items.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) };
}
const faqHtml = (items) => `<div class="faq">${items.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>`;

function layout(path, body, { ld = [], title, description, noindex = false, extraHead = '' } = {}) {
  const p = page(path) || {};
  const t = title || p.title?.() || brand();
  const d = description || p.description || '';
  const l = legal();
  const org = { '@type': 'Organization', name: brand(), url: url('/'), ...(config.supportEmail ? { email: config.supportEmail } : {}), ...(config.contactPhone ? { telephone: config.contactPhone } : {}), ...(l.company ? { legalName: l.company } : {}), ...(l.address ? { address: l.address } : {}) };
  const graph = { '@context': 'https://schema.org', '@graph': [org, { '@type': 'WebSite', name: brand(), url: url('/') }, ...ld] };
  const navItems = [['/#how-it-works', 'How it works'], ['/pricing', 'Pricing'], ['/takeaways', 'For takeaways'], ['/whatsapp-cost-calculator', 'Cost calculator']];
  const chat = path === '/' && siteChatTenant() ? `<script src="/chat-widget/${esc(siteChatTenant())}.js" async></script>` : '';
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t)}</title>
<meta name="description" content="${esc(d)}">
<link rel="canonical" href="${esc(url(path))}">
<meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(brand())}"><meta property="og:locale" content="en_GB">
<meta property="og:title" content="${esc(t)}"><meta property="og:description" content="${esc(d)}"><meta property="og:url" content="${esc(url(path))}">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(t)}"><meta name="twitter:description" content="${esc(d)}">
<meta name="theme-color" content="#128c4a"><link rel="icon" href="${ICON}">
<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>
<style>${CSS}</style>${extraHead}
</head>
<body>
<header><div class="wrap"><a class="logo" href="/">${esc(brand())}</a>
<nav aria-label="Main">${navItems.map(([h, n]) => `<a href="${h}"${h === path ? ' aria-current="page"' : ''}>${n}</a>`).join('')}<a class="btn small" href="/demo">Book a demo</a></nav></div></header>
<main>${body}</main>
<footer><div class="wrap">
<div><b style="color:var(--ink)">${esc(brand())}</b><p>An assistant for your website and WhatsApp that answers customers, takes orders and hands the tricky ones to you. Set up for you.</p></div>
<div><ul><li><a href="/#how-it-works">How it works</a></li><li><a href="/pricing">Pricing</a></li><li><a href="/takeaways">For takeaways</a></li><li><a href="/whatsapp-cost-calculator">WhatsApp cost calculator</a></li><li><a href="/demo">Book a demo</a></li></ul></div>
<div><ul><li><a href="/legal/privacy">Privacy</a></li><li><a href="/legal/terms">Terms</a></li><li><a href="/legal/dpa">Data processing agreement</a></li>${config.supportEmail ? `<li><a href="mailto:${esc(config.supportEmail)}">${esc(config.supportEmail)}</a></li>` : ''}${config.contactPhone ? `<li><a href="tel:${esc(config.contactPhone.replace(/[^\d+]/g, ''))}">${esc(config.contactPhone)}</a></li>` : ''}</ul></div>
<div>${l.company ? `<p>${esc(l.company)}${l.number ? `<br>Registered in England and Wales, company no. ${esc(l.number)}` : ''}${l.address ? `<br>${esc(l.address)}` : ''}</p>` : ''}</div>
</div></footer>${chat}
</body></html>`;
}

function siteChatTenant() {
  const id = config.siteChatTenant;
  if (!id) return null;
  const t = getTenant(id);
  return t?.active ? id : null;
}

const contactLine = () => [config.contactPhone && `<a href="tel:${esc(config.contactPhone.replace(/[^\d+]/g, ''))}">${esc(config.contactPhone)}</a>`, config.supportEmail && `<a href="mailto:${esc(config.supportEmail)}">${esc(config.supportEmail)}</a>`].filter(Boolean).join(' · ');

// ---------------- Home ----------------
const HOME_FAQ = [
  ['Will it say something stupid to my customers?', 'It answers from what you give it, and it is told to say "let me get someone" rather than guess. You see every conversation.'],
  ['Do I have to change how I work?', 'No. If you use the WhatsApp Business app on your phone, you keep using it. When you reply yourself, the assistant steps back.'],
  ['What does WhatsApp cost?', 'Meta charges you directly per message. Most small businesses land between £0 and £30 a month. Work out yours on the cost calculator.'],
  ['Can I turn it off?', 'Any time, from the dashboard, in one click.'],
];
function home() {
  const B = esc(brand());
  return layout('/', `
<section class="hero"><div class="wrap">
<h1>Your customers message at 11pm. Someone should answer.</h1>
<p class="lead">${B} puts an assistant on your website and your WhatsApp that knows your products, your prices, your opening hours and your delivery areas. It answers instantly, takes orders, and passes anything tricky to you.</p>
<p><a class="btn" href="/demo">Book a 20-minute demo</a>${siteChatTenant() ? ' <span class="mute">· Or try it now: the chat button in the corner is the real thing, answering questions about ' + B + '.</span>' : ''}</p>
</div></section>

<section><div class="wrap grid">
<div class="card"><p>Half your enquiries arrive when you're closed, and most people won't wait until morning.</p></div>
<div class="card"><p>The same fifteen questions, every day. Do you deliver to my postcode. Is this in stock. What time do you close. How much is delivery.</p></div>
<div class="card"><p>You answer them on your phone, between serving people, or you don't answer them at all.</p></div>
</div></section>

<section id="how-it-works"><div class="wrap">
<h2>How it works</h2>
<ol class="steps">
<li><h3>We set it up</h3><p class="mute">You send us your website, your price list and your policies. We load them in, write your messages and test it. Usually a day, sometimes two.</p></li>
<li><h3>It goes on your site, and on WhatsApp</h3><p class="mute">One line of code on your website. WhatsApp takes longer because Meta has to verify your business. We do that part with you.</p></li>
<li><h3>You watch it work</h3><p class="mute">Every conversation lands in one inbox. You step in whenever you want, from your phone.</p></li>
</ol></div></section>

<section><div class="wrap">
<h2>What it actually does</h2>
<div class="grid">
<div class="card"><h3>Answers questions</h3><p>From your own website, price list and policies. If it doesn't know, it says so and fetches you rather than inventing an answer.</p></div>
<div class="card"><h3>Takes orders</h3><p>Shows products, builds a basket, takes the order, and handles cash on delivery and delivery slots if you need them.</p></div>
<div class="card"><h3>Chases abandoned baskets</h3><p>On WhatsApp, which people actually read.</p></div>
<div class="card"><h3>Sends order updates</h3><p>So you stop answering "where is it".</p></div>
<div class="card"><h3>Runs campaigns</h3><p>To customers who have opted in, with the consent record kept properly for you.</p></div>
<div class="card"><h3>Hands over to you</h3><p>The moment someone asks for a person, or the moment it's out of its depth.</p></div>
</div></div></section>

<section><div class="wrap"><div class="callout">
<h2>The honest bit</h2>
<p>It won't replace your staff, and we won't pretend it does. It handles the repetitive half so the people half gets your attention. If you're the one answering WhatsApp at 11pm, that's the half it takes off you.</p>
</div></div></section>

<section><div class="wrap">
<h2>Questions owners ask us</h2>
${faqHtml(HOME_FAQ)}
<p><a href="/whatsapp-cost-calculator">Work out your WhatsApp bill →</a></p>
</div></section>

<section><div class="wrap">
<h2>See it on your own business first</h2>
<p class="lead">Book 20 minutes. We'll load your website into it live on the call and you can ask it anything your customers would. If it isn't good enough, you'll know inside five minutes and we'll both have saved a fortnight.</p>
<p><a class="btn" href="/demo">Book a demo</a>${config.supportEmail ? ` <span class="mute">· Or email <a href="mailto:${esc(config.supportEmail)}">${esc(config.supportEmail)}</a></span>` : ''}</p>
</div></section>`, {
    ld: [faqLd(HOME_FAQ), { '@type': 'SoftwareApplication', name: brand(), applicationCategory: 'BusinessApplication', operatingSystem: 'Web', url: url('/'), offers: { '@type': 'AggregateOffer', priceCurrency: 'GBP', lowPrice: '29', highPrice: '249', offerCount: '3' } }],
  });
}

// ---------------- Pricing ----------------
const PRICING_FAQ = [
  ['Is there a free trial?', "The website assistant, yes. We'll put it on your site and you can watch it work before you pay the monthly fee. WhatsApp can't be trialled properly because Meta has to verify your business first, which takes days."],
  ['How long is the contract?', 'Monthly, cancel whenever. The set-up fee is non-refundable once the work is done.'],
  ['What if I go over my AI replies?', 'We tell you before you get there, and you move up a plan or we add a top-up. It never just stops answering your customers.'],
  ['Do you take a cut of my sales?', 'No. Flat fee, whatever you sell.'],
  ['Who owns the data?', "You do. Export it or have it deleted at any time. We're your data processor and we'll sign a DPA."],
];
function pricing() {
  const r = getRates().GB;
  const p = (x) => `${+(x * 100).toFixed(1)}p`;
  const rows = [
    ['Monthly', '£29', '£79', '£249'],
    ['Website assistant', 'Yes', 'Yes', 'Yes'],
    ['WhatsApp', 'Yes', 'Yes', 'Yes'],
    ['AI replies included', '300', '3,000', '20,000'],
    ['Products and knowledge base', 'Yes', 'Yes', 'Yes'],
    ['Order updates and cart recovery', '—', 'Yes', 'Yes'],
    ['Campaigns with consent records', '—', 'Yes', 'Yes'],
    ['Changes made for you', '—', '—', 'Monthly'],
    ['Support', 'Email', 'Email', 'Phone, same day'],
  ];
  return layout('/pricing', `
<section class="hero"><div class="wrap">
<h1>Two prices, and Meta's</h1>
<p class="lead">We charge a one-off set-up fee and a monthly fee. Meta charges you separately for WhatsApp messages, directly, at their rates. We don't mark that up and we don't hide it. There's a calculator so you can see yours before you commit.</p>
</div></section>

<section><div class="wrap">
<h2>Set-up: from £500</h2>
<p>We load your products, prices, policies and opening hours, write your message templates, take you through Meta's verification, and test it against real questions until it holds up. One day for a straightforward shop, two or three for something complicated.</p>
<p>This isn't optional, and it's the reason it works. A bot loaded badly is worse than no bot.</p>
</div></section>

<section><div class="wrap">
<h2>Monthly plans</h2>
<p class="mute">Most businesses we work with take Managed, because they'd rather we kept it right than learn the dashboard.</p>
<div class="tablewrap"><table>
<thead><tr><th></th><th>Starter</th><th>Growth</th><th>Managed</th></tr></thead>
<tbody>${rows.map(([k, ...v], i) => `<tr><th scope="row">${esc(k)}</th>${v.map((x) => `<td>${i === 0 ? `<span class="price">${esc(x)}</span>` : esc(x)}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>
<p class="mute">Prices exclude VAT where it applies.</p>
<p><a class="btn" href="/demo">Book a demo</a></p>
</div></section>

<section id="meta-fees"><div class="wrap">
<h2>What WhatsApp costs on top</h2>
<p>Meta bills you directly for WhatsApp messages. You add a card to your own Meta account and they charge it. We never touch that money.</p>
<p>Since October 2026 the rough shape in the UK is:</p>
<ul class="plain">
<li><b>Replies to customers who messaged you first:</b> your first ${FREE_SERVICE_PER_MONTH.toLocaleString('en-GB')} a month are free, then about ${p(r.service)} each.</li>
<li><b>Order updates and confirmations:</b> about ${p(r.utility)} each.</li>
<li><b>Marketing messages:</b> about ${p(r.marketing)} each.</li>
</ul>
<p>A shop having thirty conversations a week typically pays Meta nothing at all. A busy one running campaigns might pay £20 to £40. Rates are set by where your customer is, not where you are, and Meta changes them from time to time.</p>
<p><a class="btn ghost" href="/whatsapp-cost-calculator">Work out your Meta bill</a></p>
</div></section>

<section><div class="wrap"><h2>Pricing questions</h2>${faqHtml(PRICING_FAQ)}</div></section>`, {
    ld: [faqLd(PRICING_FAQ), { '@type': 'Product', name: `${brand()} monthly plans`, brand: { '@type': 'Brand', name: brand() }, offers: [['Starter', 29], ['Growth', 79], ['Managed', 249]].map(([n, v]) => ({ '@type': 'Offer', name: n, price: String(v), priceCurrency: 'GBP', url: url('/pricing') })) }],
  });
}

// ---------------- Takeaways ----------------
const TAKEAWAY_FAQ = [
  ["I'm too busy to learn software.", "You don't need to. We set it up and you use WhatsApp exactly as you do now."],
  ['My menu changes.', 'Send us the new one and it updates, or change it yourself in two minutes.'],
  ['Customers want to speak to a person.', "Anyone who asks gets you. It's answering the ones who just want to know if you're open."],
  ['What about allergies?', 'It gives your allergen information and tells anyone with an allergy question to speak to you directly. It never guesses about food safety.'],
];
function takeaways() {
  const B = esc(brand());
  return layout('/takeaways', `
<section class="hero"><div class="wrap">
<h1>Take orders on WhatsApp. Keep the whole order value.</h1>
<p class="lead">Your customers already message you. ${B} answers them, shows the menu, takes the order and sends it to you, without the 14 to 30 per cent the delivery apps take off the top.</p>
<p><a class="btn" href="/demo">Book a 20-minute demo</a></p>
</div></section>

<section><div class="wrap">
<h2>Sound familiar?</h2>
<ul class="plain">
<li>The phone rings during the Friday rush and nobody can get to it.</li>
<li>Orders come in on WhatsApp, get written down on a pad, and one gets missed.</li>
<li>Someone asks if you deliver to their postcode for the fortieth time this week.</li>
<li>The apps bring orders but take a third of each one, and you never learn who the customer was.</li>
</ul></div></section>

<section><div class="wrap">
<h2>What changes</h2>
<ul class="ticks">
<li>Customers message your WhatsApp number and get an answer in seconds, at any hour.</li>
<li>The menu appears in the chat. They pick, it builds the order, it confirms the total.</li>
<li>It checks their postcode against your delivery area before taking the order, so you stop refunding people you can't reach.</li>
<li>It knows your opening hours, so at 2am it takes the order for tomorrow or says you're closed, rather than leaving someone waiting.</li>
<li>The order lands in one place with the address and the phone number: yours to keep, not the app's.</li>
</ul></div></section>

<section><div class="wrap"><div class="callout">
<h2>The money bit</h2>
<p>A £25 order through a delivery app costs you around £5 in commission. Twenty of those a week is roughly £400 a month, every month. Our Growth plan is £79.</p>
<p>We're not going to replace the apps. They bring you customers you'd never reach. But the customers who already know you and already message you shouldn't be costing you a third of the order.</p>
</div></div></section>

<section><div class="wrap"><h2>Takeaway owners ask</h2>${faqHtml(TAKEAWAY_FAQ)}</div></section>

<section><div class="wrap">
<h2>We'll load your menu on the call</h2>
<p class="lead">Twenty minutes, your actual menu, your actual postcodes. Ask it what your customers ask you.</p>
<p><a class="btn" href="/demo">Book a demo</a>${config.contactPhone ? ` <span class="mute">· <a href="tel:${esc(config.contactPhone.replace(/[^\d+]/g, ''))}">${esc(config.contactPhone)}</a></span>` : ''}</p>
</div></section>`, { ld: [faqLd(TAKEAWAY_FAQ), { '@type': 'Service', name: 'WhatsApp ordering for takeaways', provider: { '@type': 'Organization', name: brand() }, areaServed: 'GB', serviceType: 'WhatsApp ordering and customer messaging' }] });
}

// ---------------- Cost calculator ----------------
export const COUNTRIES = [['GB', 'United Kingdom'], ['IE', 'Ireland'], ['DEFAULT', 'Somewhere else (rough average)']];
const num = (v, d, max = 1e6) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : d; };
export function calcInputs(q = {}) {
  return { customers: num(q.c, 200), replies: num(q.r, 7, 200), updates: num(q.u, 200), marketing: num(q.m, 80), country: COUNTRIES.some(([k]) => k === q.cc) ? q.cc : 'GB' };
}
export function calculate(i) {
  const r = getRates()[i.country] || getRates().DEFAULT;
  const replies = i.customers * i.replies;
  const paidReplies = Math.max(0, replies - FREE_SERVICE_PER_MONTH);
  const lines = [
    { key: 'replies', label: 'Replies in conversation', count: replies, rate: r.service, free: FREE_SERVICE_PER_MONTH, cost: paidReplies * r.service },
    { key: 'updates', label: 'Order updates', count: i.updates, rate: r.utility, cost: i.updates * r.utility },
    { key: 'marketing', label: 'Marketing', count: i.marketing, rate: r.marketing, cost: i.marketing * r.marketing },
  ];
  const total = lines.reduce((s, l) => s + l.cost, 0);
  return { lines, total: Math.round(total * 100) / 100 };
}
const CALC_FACTS = [
  ['Does WhatsApp pricing depend on where my customer is?', 'Yes. The rate depends on where your customer is, not where you are.'],
  ['How many WhatsApp replies are free each month?', `Your first ${FREE_SERVICE_PER_MONTH.toLocaleString('en-GB')} replies each month are free, per phone number.`],
  ['How much do WhatsApp marketing messages cost?', 'Marketing messages cost about three times a normal reply, and Meta decides which category a message falls into, not you.'],
];
const money = (n) => `£${n.toFixed(2)}`;
const pence = (x) => `${+(x * 100).toFixed(1)}p`;
function resultHtml(i, res) {
  const rounded = res.total < 1 ? 'Nothing, most months' : `About £${Math.round(res.total)} a month`;
  return `<p class="mute" style="margin:0">Your estimated Meta bill</p><p class="big" id="calc-total">${esc(rounded)}</p>
<div class="tablewrap" style="margin-top:14px"><table><thead><tr><th>Messages</th><th>Count</th><th>Rate</th><th>Cost</th></tr></thead><tbody>
${res.lines.map((l) => `<tr><td>${esc(l.label)}</td><td>${l.count.toLocaleString('en-GB')}</td><td>${l.free ? `first ${l.free.toLocaleString('en-GB')} free, then ${pence(l.rate)}` : pence(l.rate)}</td><td>${money(l.cost)}</td></tr>`).join('')}
<tr><th scope="row">Total</th><td></td><td></td><th>${money(res.total)}</th></tr></tbody></table></div>`;
}
function calculator(q) {
  const i = calcInputs(q);
  const res = calculate(i);
  const share = `/whatsapp-cost-calculator?c=${i.customers}&r=${i.replies}&u=${i.updates}&m=${i.marketing}&cc=${i.country}`;
  const rates = getRates();
  const field = (name, label, value, help) => `<label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="number" min="0" inputmode="numeric" value="${value}">${help ? `<div class="mute" style="font-size:14px">${help}</div>` : ''}`;
  return layout('/whatsapp-cost-calculator', `
<section class="hero"><div class="wrap">
<h1>What will WhatsApp actually cost you?</h1>
<p class="lead">Meta changed how it charges in October 2026 and most comparison articles are still wrong about it. Put your numbers in and get a monthly figure at current UK rates.</p>
<p class="mute">No email needed. The result is right here.</p>
</div></section>

<section style="border-top:0;padding-top:0"><div class="wrap grid" style="align-items:start">
<form class="card" id="calc" method="get" action="/whatsapp-cost-calculator">
${field('c', 'How many customers message you in a month?', i.customers)}
${field('r', 'Roughly how many replies does a typical conversation take?', i.replies)}
${field('u', 'How many order updates or confirmations do you send a month?', i.updates)}
${field('m', 'How many marketing messages a month, if any?', i.marketing, 'Put 0 if you don\'t send offers.')}
<label for="f-cc">Where are most of your customers?</label><select id="f-cc" name="cc">${COUNTRIES.map(([k, n]) => `<option value="${k}"${k === i.country ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
<div class="mute" style="font-size:14px">This is the one most people get wrong: Meta charges by your customer's country.</div>
<p><button class="btn" type="submit">Work it out</button></p>
</form>
<div class="card" aria-live="polite"><div id="calc-result">${resultHtml(i, res)}</div>
<p style="margin-top:14px"><a id="calc-share" href="${esc(share)}">Link to this result</a> <span class="mute">(send it to your business partner)</span></p></div>
</div></section>

<section><div class="wrap">
<h2>Three things worth knowing</h2>
<ul class="plain">${CALC_FACTS.map(([, a]) => `<li>${esc(a)}</li>`).join('')}</ul>
<p class="mute">Rates checked against Meta's published rate card on ${esc(RATES_CHECKED_ON)}. Meta changes them periodically.</p>
</div></section>

<section><div class="wrap">
<p>That's Meta's bill. Ours is £29 to £249 a month depending on what you need, plus set-up. <a href="/pricing">See pricing</a> · <a href="/demo">Book a demo</a></p>
<form class="card" id="calc-email" style="max-width:560px" method="post" action="/calculator-email">
<h3>Email me this breakdown</h3><p>Optional. We'll send the numbers to you, and nothing else unless you ask.</p>
<input type="hidden" name="c" value="${i.customers}"><input type="hidden" name="r" value="${i.replies}"><input type="hidden" name="u" value="${i.updates}"><input type="hidden" name="m" value="${i.marketing}"><input type="hidden" name="cc" value="${esc(i.country)}">
<label for="ce-email">Your email</label><input id="ce-email" name="email" type="email" required autocomplete="email">
<div class="hp" aria-hidden="true"><label>Leave empty<input name="company_website" tabindex="-1" autocomplete="off"></label></div>
<p><button class="btn ghost" type="submit">Email it to me</button></p><p id="ce-res" class="mute"></p>
</form>
</div></section>
<script>
(() => {
  const RATES = ${JSON.stringify(rates)}, FREE = ${FREE_SERVICE_PER_MONTH};
  const f = document.getElementById('calc');
  const n = (v, max = 1e6) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0; };
  const p = (x) => +(x * 100).toFixed(1) + 'p', m = (x) => '£' + x.toFixed(2), fmt = (x) => x.toLocaleString('en-GB');
  const run = () => {
    const i = { c: n(f.c.value), r: n(f.r.value, 200), u: n(f.u.value), m: n(f.m.value), cc: f.cc.value };
    const r = RATES[i.cc] || RATES.DEFAULT, replies = i.c * i.r;
    const lines = [['Replies in conversation', replies, 'first ' + fmt(FREE) + ' free, then ' + p(r.service), Math.max(0, replies - FREE) * r.service], ['Order updates', i.u, p(r.utility), i.u * r.utility], ['Marketing', i.m, p(r.marketing), i.m * r.marketing]];
    const total = lines.reduce((s, l) => s + l[3], 0);
    document.getElementById('calc-result').innerHTML = '<p class="mute" style="margin:0">Your estimated Meta bill</p><p class="big">' + (total < 1 ? 'Nothing, most months' : 'About £' + Math.round(total) + ' a month') + '</p><div class="tablewrap" style="margin-top:14px"><table><thead><tr><th>Messages</th><th>Count</th><th>Rate</th><th>Cost</th></tr></thead><tbody>' + lines.map((l) => '<tr><td>' + l[0] + '</td><td>' + fmt(l[1]) + '</td><td>' + l[2] + '</td><td>' + m(l[3]) + '</td></tr>').join('') + '<tr><th scope="row">Total</th><td></td><td></td><th>' + m(total) + '</th></tr></tbody></table></div>';
    const qs = 'c=' + i.c + '&r=' + i.r + '&u=' + i.u + '&m=' + i.m + '&cc=' + encodeURIComponent(i.cc);
    document.getElementById('calc-share').href = '/whatsapp-cost-calculator?' + qs;
    history.replaceState(null, '', '?' + qs);
    const e = document.getElementById('calc-email'); ['c', 'r', 'u', 'm', 'cc'].forEach((k) => (e[k].value = i[k]));
  };
  f.addEventListener('input', run); f.addEventListener('submit', (ev) => { ev.preventDefault(); run(); });
  const e = document.getElementById('calc-email');
  e.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = document.getElementById('ce-res'); out.textContent = 'Sending…';
    const body = Object.fromEntries(new FormData(e));
    const res = await fetch('/calculator-email', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => ({ ok: false }));
    out.textContent = res.ok ? 'Sent. Check your inbox.' : (res.error || 'Sorry, that didn\\'t work. Please try again.');
  });
})();
</script>`, {
    ld: [faqLd(CALC_FACTS), { '@type': 'WebApplication', name: 'WhatsApp Business API cost calculator (UK)', url: url('/whatsapp-cost-calculator'), applicationCategory: 'BusinessApplication', operatingSystem: 'Web', offers: { '@type': 'Offer', price: '0', priceCurrency: 'GBP' } }],
  });
}

// ---------------- Demo ----------------
function demo({ sent = false, error = '' } = {}) {
  const B = esc(brand());
  return layout('/demo', `
<section class="hero"><div class="wrap" style="max-width:720px">
<h1>See it on your own business</h1>
<p class="lead">Twenty minutes. We load your website into ${B} live on the call, and you ask it anything your customers would. If it isn't good enough, you'll know inside five minutes.</p>
${config.demoUrl ? `<p><a class="btn" href="${esc(config.demoUrl)}" rel="noopener">Pick a time in our calendar</a> <span class="mute">or send us your details below and we'll get back to you.</span></p>` : ''}
${sent ? `<div class="callout"><h2>Thanks, we've got it</h2><p>We'll be in touch within one working day to find a time.${contactLine() ? ` If it's urgent: ${contactLine()}.` : ''}</p></div>` : `
<form class="card" method="post" action="/demo">
${error ? `<p style="color:var(--warn)">${esc(error)}</p>` : ''}
<label for="d-name">Your name</label><input id="d-name" name="name" required autocomplete="name">
<label for="d-business">Business name</label><input id="d-business" name="business" required autocomplete="organization">
<label for="d-email">Email</label><input id="d-email" name="email" type="email" required autocomplete="email">
<label for="d-phone">Phone (optional)</label><input id="d-phone" name="phone" type="tel" autocomplete="tel">
<label for="d-website">Your website (optional)</label><input id="d-website" name="website" placeholder="yourshop.co.uk" autocomplete="url">
<label for="d-message">Anything we should know? (optional)</label><textarea id="d-message" name="message" rows="3" placeholder="What do customers ask you most?"></textarea>
<div class="hp" aria-hidden="true"><label>Leave empty<input name="company_website" tabindex="-1" autocomplete="off"></label></div>
<p><button class="btn" type="submit">Request a demo</button></p>
<p class="mute" style="font-size:14px">We only use these details to arrange your demo. See our <a href="/legal/privacy">privacy policy</a>.</p>
</form>`}
${contactLine() ? `<p class="mute">Prefer to talk? ${contactLine()}</p>` : ''}
</div></section>`, { noindex: sent });
}

const clean = (v, n = 200) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);
const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
function saveLead(kind, b, data = {}) {
  return getDb().prepare('INSERT INTO leads (kind, name, business, email, phone, website, message, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(kind, clean(b.name, 120), clean(b.business, 120), clean(b.email, 200), clean(b.phone, 40), clean(b.website, 200), String(b.message ?? '').trim().slice(0, 2000), JSON.stringify(data)).lastInsertRowid;
}

export function sitemapXml() {
  const paths = [...PAGES.map((p) => p.path), '/legal/privacy', '/legal/terms', '/legal/dpa'];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${esc(url(p))}</loc><lastmod>${BUILT}</lastmod><changefreq>${p === '/whatsapp-cost-calculator' ? 'monthly' : p.startsWith('/legal') ? 'yearly' : 'monthly'}</changefreq><priority>${p === '/' ? '1.0' : p.startsWith('/legal') ? '0.3' : '0.8'}</priority></url>`).join('\n')}\n</urlset>\n`;
}

export function robotsTxt() {
  return `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /chat/\nDisallow: /webhooks/\nDisallow: /tools/\nDisallow: /r/\nDisallow: /signup\n\nSitemap: ${url('/sitemap.xml')}\n`;
}

export function siteRouter() {
  const r = express.Router();
  const html = (res, body, status = 200) => res.status(status).type('html').set('Cache-Control', 'public, max-age=300').send(body);
  r.get('/', (req, res) => html(res, home()));
  r.get('/pricing', (req, res) => html(res, pricing()));
  r.get('/takeaways', (req, res) => html(res, takeaways()));
  r.get('/whatsapp-cost-calculator', (req, res) => html(res, calculator(req.query)));
  r.get('/demo', (req, res) => html(res, demo()));
  r.get('/sitemap.xml', (req, res) => res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(sitemapXml()));
  r.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(robotsTxt()));

  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const limiter = rateLimit({ windowMs: 3600000, max: 8 });
  r.post('/demo', limiter, form, async (req, res) => {
    const b = req.body || {};
    if (b.company_website) return html(res, demo({ sent: true })); // bot trap
    const email = clean(b.email);
    if (!clean(b.name) || !clean(b.business) || !isEmail(email)) return html(res, demo({ error: 'Please fill in your name, business name and a valid email.' }), 400);
    const id = saveLead('demo', b);
    if (config.supportEmail) {
      const lines = [['Name', b.name], ['Business', b.business], ['Email', email], ['Phone', b.phone], ['Website', b.website], ['Message', b.message]].filter(([, v]) => clean(v));
      sendEmail({ to: config.supportEmail, replyTo: email, subject: `Demo request: ${clean(b.business, 80)}`, text: lines.map(([k, v]) => `${k}: ${String(v).trim()}`).join('\n') + `\n\nLead #${id}. Reply to this email to answer them.`, html: `<h2>New demo request</h2><table>${lines.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(String(v).trim())}</td></tr>`).join('')}</table><p>Lead #${id}. Reply to this email to answer them.</p>` }).catch(() => {});
    }
    html(res, demo({ sent: true }));
  });
  r.post('/calculator-email', limiter, form, express.json({ limit: '10kb' }), async (req, res) => {
    const b = req.body || {};
    const wantsJson = /json/.test(req.get('accept') || '');
    const done = (ok, error) => (wantsJson ? res.status(ok ? 200 : 400).json({ ok, error }) : res.redirect(303, `/whatsapp-cost-calculator?c=${calcInputs(b).customers}&r=${calcInputs(b).replies}&u=${calcInputs(b).updates}&m=${calcInputs(b).marketing}&cc=${calcInputs(b).country}`));
    if (b.company_website) return done(true);
    const email = clean(b.email);
    if (!isEmail(email)) return done(false, 'Please enter a valid email.');
    const i = calcInputs(b);
    const out = calculate(i);
    saveLead('calculator', { email }, { inputs: i, totalGbp: out.total });
    const link = url(`/whatsapp-cost-calculator?c=${i.customers}&r=${i.replies}&u=${i.updates}&m=${i.marketing}&cc=${i.country}`);
    const text = `Your estimated WhatsApp (Meta) bill: £${out.total.toFixed(2)} a month\n\n${out.lines.map((l) => `${l.label}: ${l.count.toLocaleString('en-GB')} × ${pence(l.rate)}${l.free ? ` (first ${l.free.toLocaleString('en-GB')} free)` : ''} = £${l.cost.toFixed(2)}`).join('\n')}\n\nRates checked on ${RATES_CHECKED_ON}. Meta bills you directly and changes rates from time to time.\n\nSee or change it: ${link}\n\n${brand()}${config.supportEmail ? ` · ${config.supportEmail}` : ''}`;
    const sent = await sendEmail({ to: email, replyTo: config.supportEmail, subject: `Your WhatsApp cost estimate: about £${Math.round(out.total)} a month`, text, html: `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">${resultHtml(i, out).replace(/class="[^"]*"/g, '')}<p>Rates checked on ${esc(RATES_CHECKED_ON)}. Meta bills you directly and changes rates from time to time.</p><p><a href="${esc(link)}">See or change your numbers</a></p><p>${esc(brand())}</p></div>` });
    done(sent.ok, sent.ok ? undefined : 'Sorry, we couldn\'t send email just now. Your result is saved in the link above.');
  });
  return r;
}

/** The homepage assistant's knowledge, written from the website copy. Used when the operator creates it from Setup. */
export function siteAssistantKnowledge() {
  const r = getRates().GB;
  return {
    about: `${brand()} is an assistant for UK small businesses' websites and WhatsApp. It answers customer questions from the business's own website, price list and policies, takes orders, chases abandoned baskets, sends order updates, runs campaigns to opted-in customers, and hands over to a person when asked. It is set up for the business (done for you), usually in a day.`,
    faq: `Pricing: one-off set-up from £500, then monthly: Starter £29, Growth £79, Managed £249. Starter: website assistant, WhatsApp, 300 AI replies, products and knowledge base, email support. Growth adds order updates, cart recovery and campaigns with consent records, 3,000 AI replies. Managed: 20,000 AI replies, changes made for you monthly, same-day phone support. Prices exclude VAT where it applies. Monthly, cancel any time; set-up fee non-refundable once the work is done. No cut of sales.
Meta fees: Meta bills the business directly for WhatsApp messages. In the UK: first ${FREE_SERVICE_PER_MONTH} replies a month free, then about ${pence(r.service)} each; order updates about ${pence(r.utility)}; marketing about ${pence(r.marketing)}. Most small businesses pay £0 to £30 a month. Calculator: ${url('/whatsapp-cost-calculator')}.
Trial: the website assistant can be trialled on your site before paying monthly. WhatsApp can't be trialled properly because Meta must verify the business first (days).
How it works: 1) we set it up from your website, price list and policies; 2) one line of code on your website, WhatsApp after Meta verification (we help); 3) every conversation lands in one inbox and you can step in from your phone.
WhatsApp Business app: you can keep using it on your phone; when you reply yourself, the assistant steps back.
It does not replace staff: it handles the repetitive questions so staff handle the rest.
Data: the business owns its data, can export or delete it, and we sign a DPA as data processor.
Takeaways: takes orders on WhatsApp with no commission per order; checks postcodes against delivery areas; knows opening hours; gives allergen information as written by the business and tells anyone with an allergy question to speak to the business directly.
To get started: book a 20-minute demo at ${url('/demo')}${config.contactPhone ? ` or call ${config.contactPhone}` : ''}${config.supportEmail ? ` or email ${config.supportEmail}` : ''}.`,
    instructions: 'You are answering visitors on our own sales website. Keep answers short. When someone is interested, suggest booking a demo at /demo. Never promise features or prices not listed here.',
  };
}
