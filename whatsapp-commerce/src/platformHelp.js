import express from 'express';
import { config } from './config.js';
import { chatCompletion, directConfigured } from './ai/direct.js';
import { renderBody } from './help.js';

/*
 * Our own help: guides for the businesses using the dashboard ("how do I connect WhatsApp?", "why isn't my chat
 * showing?"). Public at /guides, searchable, and the dashboard's "❓ Help" panel answers questions from them with
 * the AI (or plain search when the AI isn't set up).
 */
export const GUIDES = [
  { slug: 'getting-started', cat: 'Getting started', title: 'Getting started in 10 minutes', body: `The **Setup** tab walks you through everything, step by step. The short version:\n\n- **Add your website** on the Knowledge base tab. The assistant reads your pages and learns your prices, hours and policies.\n- **Pick your business type** (Settings → Business type). It sets up the menu, greeting and the right questions for your trade.\n- **Try it** on the Test bot tab – ask what your customers ask.\n- **Add the chat to your website** with one line of code (see "Add the chat to your website").\n\nWhatsApp is optional and can come later.` },
  { slug: 'add-chat-to-website', cat: 'Getting started', title: 'Add the chat to your website', body: `Settings → Website AI chat shows your one-line code. Paste it just above \`</body>\` on every page, or in your site's footer settings.\n\n- **Shopify:** Online Store → Themes → Edit code → theme.liquid → paste above </body>.\n- **WordPress / WooCommerce:** download our plugin from the Setup tab and upload it (no code).\n- **Wix:** Settings → Custom code → Body end.\n- **Squarespace:** Settings → Advanced → Code injection → Footer.\n\nYou can also share a **chat page link** (no website needed) or show the chat **inside a page** – both are under "Chat page link" on the same card.` },
  { slug: 'chat-not-showing', cat: 'Troubleshooting', title: "The chat isn't showing on my website", body: `Check these in order:\n\n- Is **Enabled** set to Yes in Settings → Website AI chat?\n- Did you paste the code on the **live** site and publish/save? Some builders need "Publish".\n- Clear your browser cache or open the site in a private window.\n- Have you hidden it on **phones** or on that **page**? (Settings → Website AI chat → Hide the chat.)\n- Cookie banners or "script blockers" can delay it – try another browser.\n\nThe Setup tab shows "we can see it on yourshop.co.uk" once it loads anywhere.` },
  { slug: 'teach-the-assistant', cat: 'The assistant', title: 'Teach the assistant (knowledge base)', body: `The assistant only answers from **your** information:\n\n- **Website:** add your address on the Knowledge base tab; it re-reads it every week.\n- **Documents:** upload PDFs, price lists, menus and policies.\n- **Questions it couldn't answer** appear on the Knowledge base tab – type the answer once and it knows it from then on.\n- **Teach from the Inbox:** under any reply your team sends, click **💡 Teach the bot**.\n- **Help centre articles** you publish also teach it.\n\nWrong answer? Fix the information, then ask again in Test bot.` },
  { slug: 'connect-whatsapp', cat: 'WhatsApp', title: 'Connect WhatsApp', body: `WhatsApp needs a paid plan and a WhatsApp Business account with Meta. The Setup tab's WhatsApp step guides you through it:\n\n- Use a number that is **not** already on the WhatsApp app (or use coexistence to keep using the app).\n- Meta verifies your business – this can take a day or two.\n- Meta bills message fees directly to your Meta account; we never mark them up.\n\nOnce connected, the same assistant answers on WhatsApp, and customers can order and book there too.` },
  { slug: 'welcome-menu-and-templates', cat: 'The assistant', title: 'Welcome menu, greeting and trade templates', body: `**Settings → Business type** gives you a ready-made start for your trade (dentist, salon, takeaway, garage, estate agent and more): menu, pop-up greeting, call-back question and safety rules for the AI.\n\nThen fine-tune in **Settings → Welcome menu**: each option can answer, open a page, ask the AI a question, start a booking, ask for a call back or open a ticket. "✨ Write it for me with AI" builds it from your website.` },
  { slug: 'leads-and-call-backs', cat: 'Customers', title: 'Leads and call-backs', body: `When a visitor taps "Call me back" or "Email me details", the assistant collects their details one question at a time and you get an email (and a WhatsApp alert if set) straight away.\n\nLeads are on the **Leads** tab. Download them as CSV, or send each one to **Google Sheets, Zapier or your CRM** (box at the bottom of the Leads tab).` },
  { slug: 'bookings', cat: 'Customers', title: 'Bookings and appointments', body: `Turn on bookings on the **Bookings** tab and set your services, times and closed days. Customers pick a service, a day on the calendar and a free time; website visitors give a name and phone number.\n\n- Confirm or cancel on the Bookings tab (or set auto-confirm).\n- Optional deposits by card (Stripe).\n- Reminders before the visit.\n\nWith bookings off, the assistant never pretends to book: it takes the customer's details so your team can arrange a time.` },
  { slug: 'support-tickets', cat: 'Customers', title: 'Support tickets', body: `Turn on tickets on the **Tickets** tab. When the assistant can't fix a problem it opens a ticket with a number (#1042), promises your reply time and tells you.\n\n- Reply on the Tickets tab: it reaches the customer in the chat and by email.\n- Private notes stay private.\n- Customers can ask "ticket 1042" in the chat for an update; when you're waiting for them, their reply is added to the ticket.` },
  { slug: 'help-centre', cat: 'Customers', title: 'Your help centre', body: `The **Help centre** tab gives you a public help site with articles, a search box and your assistant. Press **✨ Write articles for me** – the AI drafts articles from the questions your customers ask and your own website. Check them and press Publish. Published articles also teach the assistant.\n\nLink to it from your website footer and email signature.` },
  { slug: 'inbox', cat: 'Inbox', title: 'Using the Inbox', body: `Every chat – website and WhatsApp – is in the **Inbox**.\n\n- **Take over** to reply yourself; **Give back to bot** when done (the customer is asked to rate the chat).\n- **💬 Saved replies** for answers you send often (\`{{name}}\` becomes their first name).\n- **✨ Suggest** drafts a reply from your information; **🌐 Translate** for other languages.\n- **📝 Summary** gives you the chat in two lines; 😠 marks an unhappy customer.\n- You hear a sound when a customer writes, and see when they're typing.` },
  { slug: 'team-hours', cat: 'Inbox', title: 'Team hours and away mode', body: `Settings → Website AI chat → **Team hours**, e.g. \`Mon-Fri 09:00-17:30; Sat 10:00-14:00\`.\n\nThe chat then shows "🟢 Our team is online" or "🌙 Team back Mon at 9am". Out of hours, "talk to a person" takes the customer's details instead of promising a quick reply, and the assistant keeps helping.` },
  { slug: 'live-visitors-privacy', cat: 'Privacy', title: 'Live visitors, typing preview and privacy', body: `These are **off** until you switch them on (Settings → Website AI chat):\n\n- **Live visitors** – who is on your site now and which pages they've seen, with "Say hello". Kept in memory only.\n- **Typing preview** – see what a visitor types before they press send.\n- **Short form before the chat** – name, email and phone.\n\nIf you switch on live visitors or typing preview, mention them in your website's privacy/cookie notice.` },
  { slug: 'google-sheets-zapier', cat: 'Integrations', title: 'Send leads to Google Sheets, Zapier or your CRM', body: `At the bottom of the **Leads** tab:\n\n- **Google Sheets:** copy our script into Extensions → Apps Script, deploy it as a Web app, paste the URL. Each lead, booking and order becomes a row.\n- **Webhook:** paste a Zapier "Catch Hook", Make or n8n address. Add a secret to have each request signed.\n\nPress **Send a test** to check it works.` },
  { slug: 'plans-and-billing', cat: 'Account', title: 'Plans and billing', body: `- **Free:** website chat, 100 chats and 100 AI replies a month, a small "Powered by" link. No card.\n- **Starter, Growth, Managed:** WhatsApp, more replies, campaigns, and set-up done for you.\n\nUpgrade on the **Billing** tab. Meta's WhatsApp message fees are billed by Meta to you directly.` },
  { slug: 'photos-and-voice', cat: 'The assistant', title: 'Photos and voice messages', body: `In the website chat, customers can tap **📎** to send a photo or PDF, or **🎤** to talk instead of typing. The assistant looks at photos (and finds matching products if you sell online) and answers voice messages like typed ones. **🔈** reads replies aloud.\n\nTurn photo uploads off in Settings → Website AI chat if you prefer.` },
];

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
export function searchGuides(q, n = 4) {
  const qs = words(q);
  if (!qs.length) return [];
  return GUIDES.map((g) => { const tw = words(g.title), bw = words(g.body); const s = qs.reduce((a, w) => a + (tw.some((x) => x.startsWith(w.slice(0, 5))) ? 3 : 0) + (bw.some((x) => x.startsWith(w.slice(0, 5))) ? 1 : 0), 0); return { g, s }; })
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.g);
}

export async function askGuides(question) {
  const q = String(question || '').trim().slice(0, 500);
  if (!q) throw Object.assign(new Error('Type your question'), { status: 400 });
  const hits = searchGuides(q, 4);
  const links = hits.map((g) => ({ title: g.title, url: `${config.publicUrl}/guides/${g.slug}` }));
  if (!directConfigured()) return { answer: hits.length ? `These guides should help: ${hits.map((g) => g.title).join(', ')}.` : "I couldn't find a guide for that – email us and we'll help.", links };
  const ctx = (hits.length ? hits : GUIDES.slice(0, 6)).map((g) => `## ${g.title}\n${g.body}`).join('\n\n');
  const res = await chatCompletion({ temperature: 0.2, maxTokens: 350, messages: [{ role: 'system', content: `You are the support assistant for ${config.productName}, a website and WhatsApp AI chat product for UK small businesses. Answer the business owner's question using only the guides below, in at most 5 short sentences or bullets, naming the exact tab and button. If the guides don't cover it, say so and suggest emailing support${config.supportEmail ? ` (${config.supportEmail})` : ''}.\n\n${ctx}` }, { role: 'user', content: q }] });
  return { answer: String(res.choices?.[0]?.message?.content || '').trim() || 'Sorry, try again.', links };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function platformHelpRouter(layout) {
  const r = express.Router();
  r.get('/guides', (req, res) => {
    const cats = [...new Set(GUIDES.map((g) => g.cat))];
    const body = `<section class="hero"><div class="wrap"><h1>Guides</h1><p class="lead">How to get the most from your assistant.</p></div></section><section><div class="wrap">${cats.map((c) => `<h2>${esc(c)}</h2><ul>${GUIDES.filter((g) => g.cat === c).map((g) => `<li><a href="/guides/${g.slug}">${esc(g.title)}</a></li>`).join('')}</ul>`).join('')}</div></section>`;
    res.type('html').send(layout('/guides', body, { title: `Guides | ${config.productName}`, description: 'Step-by-step guides for the website and WhatsApp AI assistant.' }));
  });
  r.get('/guides/:slug', (req, res) => {
    const g = GUIDES.find((x) => x.slug === req.params.slug);
    if (!g) return res.redirect('/guides');
    const body = `<section class="hero"><div class="wrap"><p><a href="/guides">Guides</a> › ${esc(g.cat)}</p><h1>${esc(g.title)}</h1></div></section><section><div class="wrap">${renderBody(g.body.replace(/`([^`]+)`/g, '$1'))}</div></section>`;
    res.type('html').send(layout('/guides', body, { title: `${g.title} | ${config.productName}`, description: g.body.replace(/\s+/g, ' ').slice(0, 155) }));
  });
  return r;
}
