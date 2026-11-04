# WhatsApp Commerce: product summary for review

**What it is:** a multi-tenant SaaS that lets any shop sell, answer questions and run marketing on WhatsApp, using an AI chatbot grounded in the shop's own knowledge base and live product catalogue. It is built to be resold: self-serve sign-up, subscription billing, plans and an admin console for the operator.

**Status (Nov 2026):**
- Feature-complete v1: 70 automated tests pass, and every page was checked in a browser.
- Not yet run in production.
- External services (WhatsApp Cloud API, Stripe, Shopify Admin, WooCommerce, Meta Embedded Signup, Dify) are tested against simulated responses.
- One live test ran against a real Shopify shop (rcshopper.com): website detection, real catalogue, real policies imported into the knowledge base, and a real Shopify checkout link.

**Repository:** `ksushils/Automations` → `whatsapp-commerce/` (branch `claude/dazzling-darwin-uojvtj`).

---

## 1. Who it is for, and the pitch

| Customer | What they get |
|---|---|
| Shopify / WooCommerce shops | Their existing catalogue sellable inside WhatsApp, with AI answering product and policy questions, campaigns and abandoned-checkout recovery |
| Small sellers with no website | A built-in catalogue, a storefront / link-in-bio page, and orders by WhatsApp |
| Any business wanting an AI assistant on WhatsApp | A knowledge-base chatbot (upload documents or import a website) with hand-off to humans |

**Positioning against competitors** (full comparison in `docs/COMPETITOR_REVIEW.md`):
- **Take.App** ($29–50/mo): a separate mini-shop with weak AI. We use the shop's existing catalogue and add an AI agent.
- **AiSensy** (marketing and automation): we match most automation features (flow builder, campaigns, retargeting, templates) and are much stronger on commerce.
- **Cuedesk** (£249–699/mo, inbox): we include an inbox and AI at a small-business price.

**Plans** (editable in `src/tenants.js`):

| Plan | Price | Monthly limits | Extras |
|---|---|---|---|
| Starter | £29/mo | 1,000 messages, 300 AI replies, 20 knowledge docs | — |
| Growth | £79/mo | 5,000 messages, 3,000 AI replies, 100 docs | Campaigns |
| Pro | £199/mo | Unlimited messages, 20,000 AI replies, 500 docs | — |

Meta's WhatsApp message fees are billed to each shop by Meta.

---

## 2. Architecture

```
Customer (WhatsApp)  ──►  Meta WhatsApp Cloud API  ──webhook──►  WhatsApp Commerce (Node.js 22 + Express 5)
                                                                     │
         ┌───────────────────────────┬──────────────────────────────┼───────────────────────────────┐
         ▼                           ▼                              ▼                               ▼
   Conversation engine         Store adapters                 Dify (self-hosted AI)            Jobs / scheduler
   menus · cart · checkout     shopify_public (URL only)      chat app or agent app            flow delays, campaigns,
   flows · handover · AI       shopify (Admin GraphQL)        per-shop knowledge base (RAG)    reminders, trials, backups
                               woocommerce (REST v3)          OpenAI / OpenRouter models
                               custom (6-endpoint API)
                               manual (built-in catalogue)
   Web: sales home page · sign-up · storefront + web basket · receipts · chat widget · legal pages
   Dashboard (vanilla JS SPA) · admin REST API · Stripe (shop payments + platform subscriptions)
```

- **Stack:** Node.js 22, Express 5 (the only npm dependency), built-in `node:sqlite` (WAL mode), plain HTML/JS dashboard, Docker / docker-compose.
- **Size:** about 5,500 lines of server code, 1,300 of front-end and 1,550 of tests; about 90 HTTP routes.
- **Multi-tenancy:** every row is keyed by `tenant_id`.
  - Per-tenant admin keys, owner/staff logins and a super-admin key.
  - Secrets (WhatsApp token, Stripe keys, store tokens, Dify keys) are encrypted at rest with AES-256-GCM.
- **AI:** a self-hosted Dify (`dify.rcshopper.com`, v1.17.1). The system uses Dify's console API to create each shop's chatbot app, its knowledge base and its API keys automatically.

---

## 3. Features in detail

### 3.1 WhatsApp channel
- **Cloud API webhook:**
  - per-tenant URL, or app-level for Embedded Signup;
  - `X-Hub-Signature-256` verification;
  - de-duplication of Meta retries;
  - per-customer processing queue;
  - read receipts plus typing indicator.
- **Outbound message types:** text, reply buttons (max 3), list menus (max 10 rows), image, CTA URL button, templates, WhatsApp Flows forms. WhatsApp length limits are enforced, with a plain-text fallback.
- **Inbound message types:** text, button and list replies, template quick replies, location, images, documents, video, voice notes, Flows form replies, native catalogue carts, reactions, stickers, and Click-to-WhatsApp ad referrals.
- **24-hour service window:** the last inbound message is tracked per contact. Outside the window, notifications use approved templates (order update, payment reminder, staff alert) or are skipped.
- **Opt-in / opt-out:** SUBSCRIBE / STOP and "Stop offers" buttons. Campaigns go only to opted-in contacts.
- **Number health:** quality rating, messaging tier and display-name status. The WhatsApp business profile is editable from the dashboard.
- **Meta Embedded Signup:** shops connect their own number in a few clicks. The system exchanges the code, subscribes the WABA, registers the number and saves the token.

### 3.2 Shopping and checkout in chat
- **Browsing:** menu → categories → product card (photo, "was" price, stock) → options → quantity → cart (edit, remove, clear).
- **Checkout:**
  - delivery or collection;
  - saved address or shared location;
  - **delivery zones by UK postcode** (fee, minimum order, free-over);
  - **time slots** (lead time, closed days, timezone);
  - **promo codes** (percent, fixed, free delivery; minimum spend, expiry, usage limits, once per customer);
  - order note;
  - minimum order.
- **Payment:**
  - pay-online link: Shopify draft-order invoice, WooCommerce `payment_url`, **Stripe Checkout** for built-in and custom stores (webhook marks the order paid), or the Shopify cart permalink for URL-only shops;
  - cash on delivery;
  - bank transfer, with payment-proof photos attached to the order.
- **After the order:**
  - receipt page;
  - staff alerts on WhatsApp and to a webhook (n8n, Zapier, Make);
  - stock decrement and low-stock alerts (built-in catalogue);
  - order-status lookup;
  - proactive status updates from Shopify/WooCommerce webhooks;
  - payment and abandoned-cart reminders.
- **Website orders** (placed on Shopify/WooCommerce, not in WhatsApp): confirmation and shipping templates, plus **abandoned-checkout recovery** that respects marketing consent.

### 3.3 Store connections (same adapter interface)
- **`shopify_public`:** just the shop's URL. Reads the public `/products.json` and `/collections.json`; checkout is a cart permalink, so payment, tax and shipping happen on the shop's own Shopify checkout.
- **`shopify`:** Admin GraphQL token. Draft orders, completing orders for COD, order status and tracking.
- **`woocommerce`:** REST v3. Variations, orders, payment URL, discounts as fee lines.
- **`custom`:** a documented 6-endpoint JSON contract for any other site on the operator's VPS.
- **`manual`:** built-in catalogue with JSON editing or CSV import, variants and stock.

### 3.4 AI chatbot (Dify) and knowledge base (RAG)
- **Automatic setup per shop:**
  - creates a Dify app with generated instructions: tone, about, FAQ, shop facts such as fees and payment options, and hand-off rules;
  - creates the app's API key and switches AI on;
  - re-syncs when settings change.
- **Two modes:**
  - **Assistant:** the system searches the catalogue, sends product context with each question, and attaches a tappable product list to the AI reply.
  - **Agent:** a Dify function-calling agent with 9 store tools registered automatically as a custom OpenAPI tool: search, categories, product, add/remove/view cart, checkout, order status, handover. Each tool call is locked to that customer by a signed session token, so a prompt injection can't act on another customer's cart.
- **Knowledge base:**
  - **Sources:** file upload (PDF, Word, Excel, PowerPoint, TXT, CSV, HTML; 10 MB each), pasted text, imported URLs, one-click "auto-import my site".
  - **Sync:** documents are stored locally first, then synced to a per-shop Dify knowledge base. One server-side knowledge API key is created automatically. High-quality embeddings are used when the workspace has an embedding model, otherwise keyword indexing.
  - **Attachment:** the knowledge base is attached to the chatbot automatically, and indexing status is shown in the dashboard.
  - **Built-in fallback search** (keywords plus synonyms) answers policy questions when AI is off. When it has no exact answer it links the policy page and offers a human instead of guessing.
  - **Website import safety:** internal and private addresses are blocked, redirects are limited, and pages are size-capped (SSRF protection).
- **One-step onboarding:** at sign-up the shop enters its website. A Shopify store is detected via `/meta.json`, which fills in the name, currency and description, connects the catalogue and imports the policy, FAQ, about and contact pages.
- **Usage metering** of AI replies against plan limits. If Dify fails, the bot falls back to catalogue and knowledge search.

### 3.5 Automations: drag-and-drop flow builder
- **Canvas:**
  - a *Flow start* block (keywords, exact or contains, first message, Click-to-WhatsApp ad IDs) connected by drawn links;
  - blocks: text or media + buttons, list menu, question (validated, saved to the contact), single or multi product, template, WhatsApp form, add/remove tag, wait (scheduled), webhook, talk to a human, open shop menu, end;
  - each button or list row can branch;
  - variables: `{{name}}`, `{{phone}}`, `{{attr.x}}`.
- **Starting points:** welcome menu, lead capture and FAQ flows, plus validation of broken links and limits.

### 3.6 Marketing
- **Contacts:** tags, custom attributes, CSV import/export, and ad-source attribution.
- **Campaigns:**
  - approved templates;
  - segments (tags, include/exclude, ordered / never ordered, inactive N days);
  - scheduling up to 2 months ahead;
  - per-contact `{{name}}`;
  - sent / delivered / read / replied / failed tracking;
  - **retargeting** (didn't read, didn't reply, etc.).
- **Template manager:** create, list and delete Meta templates, with a one-click starter library: order confirmation, shipping update, order update, staff alert, abandoned cart, payment reminder, win-back, weekend offer, back in stock.
- **Win-back automation.**
- **Grow tools:** wa.me link + QR code, an embeddable WhatsApp chat button for any website, and a storefront / link-in-bio page on the operator's domain or the shop's own domain.

### 3.7 Team, inbox and analytics
- **Inbox:** shared inbox, take over / give back to the bot, assign chats, filters (needs a human, mine, unassigned), and photos/documents viewable.
- **Team logins:** owner or staff; staff can't change settings, AI, campaigns or billing.
- **Analytics:** revenue, orders, average order value, chat → buyer conversion, new and repeat customers, revenue per day, top products, promo usage.
- **Test bot simulator:** chat exactly as a customer would, without WhatsApp.

### 3.8 SaaS and business layer
- **Sales website:** home page with hero, features, comparison, live pricing and FAQ; sign-up with plan picker and optional website; legal pages.
- **Billing (operator's Stripe):**
  - subscription checkout;
  - **card-free trial**, auto-cancelled if no card is added;
  - billing portal (card, invoices, cancel);
  - webhook keeps plan and status in sync;
  - cancelled or unpaid shops are paused;
  - expired trials pause the bot while the dashboard stays available;
  - optional Stripe Tax for UK VAT.
- **Super-admin:** list, create, suspend and change plan for clients; rotate keys; system status; backups.

### 3.9 Operations and security
- **Reliability:** daily SQLite snapshots with retention, error and crash alerts to Slack/Discord/n8n (throttled), graceful shutdown, health check, system status endpoint.
- **Hardening:** security headers, rate limiting (API, sign-up, public order endpoints), signed webhooks (Meta, Stripe, Shopify, WooCommerce).
- **Data handling:** browser prices are never trusted (server re-prices web orders). Order lookups are matched to the customer's phone, and media is served only for messages that tenant received.
- **Legal:** Terms, Privacy and an Article 28 UK GDPR DPA as **templates**, to be reviewed by a solicitor.

---

## 4. How a new shop uses it (target experience)

1. Lands on the home page and clicks **Start free trial**.
2. Enters business name, email and **website**, and picks a plan. No card is needed.
3. The system automatically:
   - detects the shop;
   - connects its catalogue;
   - imports its policies and FAQ into the knowledge base;
   - creates the AI chatbot in Dify with that knowledge attached.
4. The dashboard wizard shows what's left: optionally upload more documents, **Connect WhatsApp** (Embedded Signup), and try the **Test bot**.
5. Shares the WhatsApp link or QR, adds the website chat button, and customers start ordering.
6. Before the trial ends, chooses a plan on the Billing tab (Stripe).

## 5. How the operator deploys it

1. Run on a VPS with Docker (`docker compose up -d --build`) behind HTTPS (Caddy, nginx or Traefik).
2. Set `.env`:
   - core: `PUBLIC_URL`, `ENCRYPTION_KEY`, `SUPER_ADMIN_KEY`;
   - Dify: `DIFY_ADMIN_API_KEY` + `DIFY_WORKSPACE_ID` (or a Dify login);
   - billing: `PLATFORM_STRIPE_*` + `STRIPE_PRICE_*`;
   - WhatsApp sign-up: `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`, `META_WEBHOOK_VERIFY_TOKEN`;
   - operations and legal: `ALERT_WEBHOOK_URL`, `LEGAL_*`.
3. Meta: become a WhatsApp **Tech Provider** (an approval process), create the Embedded Signup configuration, and set the app-level webhook.
4. Stripe: create one monthly price per plan, plus one webhook.
5. Dify: add an OpenAI/OpenRouter model provider, a default chat model, and ideally an embedding model.

---

## 6. Honest limitations and risks

- **Never run with real traffic.** Real accounts are needed to validate WhatsApp, Stripe, Shopify Admin, WooCommerce, Embedded Signup and the real Dify. Expect fixes during a 2–4 week pilot.
- **Meta dependency:** Tech Provider approval, template approvals, quality ratings and messaging tiers can limit growth. Meta's per-message pricing changes over time.
- **SQLite on a single server:** fine for tens of shops. Move to Postgres plus a separate job worker before hundreds. In-memory rate limits and queues assume one instance.
- **The AI relies on Dify:** an outage falls back to keyword search. Model costs depend on the chosen OpenAI/OpenRouter models, so plan limits should be checked against real costs.
- **Built-in fallback search is keyword-based,** so it can't infer things a policy doesn't say literally. Dify's embeddings handle that.
- **URL-only Shopify connection** can't create orders in Shopify or track them; checkout happens on the shop's site. The Admin-token mode adds that.
- **Not built yet:**
  - **an AI chat widget for websites** (the current website button opens WhatsApp; non-WhatsApp businesses would want an on-site AI chat);
  - Instagram or Messenger;
  - mobile apps;
  - an ads manager;
  - AI flow/template generators;
  - URL-button click tracking;
  - tips and add-on modifiers;
  - distance-based delivery fees;
  - SOC 2 or ISO certification;
  - multi-language UI;
  - per-shop usage-based overage billing.
- **Legal pages are templates**; get them reviewed. The operator is a data processor for shoppers' data (UK GDPR, PECR for marketing).

## 7. Questions to ask a reviewer

1. Are the plan prices and limits sensible given WhatsApp fees and LLM costs per AI reply?
2. Which missing feature matters most to UK SMB buyers first: website AI chat widget, Instagram, or mobile app?
3. What's the best go-to-market: Shopify App Store listing, agencies/resellers, or direct to RC/hobby niches first?
4. Security review: tenant isolation, webhook verification, SSRF guard, key handling. Anything missing for selling to businesses?
5. Is SQLite + single node acceptable for launch, or should Postgres + a queue come before the first customers?
6. Onboarding friction: is Meta Tech Provider + Embedded Signup the right path, or should we start as a Meta partner's sub-provider?
7. GDPR/PECR: anything else needed for marketing campaigns and AI processing of customer messages?

---

## 8. Codebase map

```
whatsapp-commerce/
  src/server.js            Express app, routes, start-up, backups, graceful shutdown
  src/config.js            .env loader and settings
  src/db.js                SQLite schema + migrations, secret encryption helpers
  src/tenants.js           tenants, plans, usage metering, keys
  src/whatsapp/            Cloud API client (payloads, 24h window, media, notify) + webhook
  src/bot/engine.js        conversation engine (menus, cart, checkout, AI, knowledge, media, carts)
  src/bot/{cart,orders,pricing,flows,state}.js   cart, orders/receipts/Stripe, promo/zones/slots, flow engine
  src/stores/              shopify_public, shopify, woocommerce, custom, manual adapters
  src/dify/                chat client (SSE), console client, automatic chatbot/agent provisioning
  src/knowledge.js         knowledge docs, website import (SSRF-safe), onboarding, fallback search, Dify sync
  src/campaigns.js · templates.js · analytics.js · platform.js (billing, Embedded Signup) · ops.js · legal.js · staff.js · csv.js
  src/routes/              admin API, Dify tools API, store webhooks, public pages, web checkout + widget
  public/                  home.html (sales site), signup.html, index.html (dashboard), flow-builder.js
  dify/                    prompts + OpenAPI tool schema
  docs/                    COMPETITOR_REVIEW.md, CUSTOM_STORE_API.md, PRODUCT_SUMMARY.md
  test/                    70 node:test tests (engine, stores, Dify, knowledge, flows, campaigns, billing, WhatsApp, ops)
```
