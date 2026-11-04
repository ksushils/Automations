# WhatsApp Commerce: AI ordering on WhatsApp for Shopify, WooCommerce and VPS stores

A multi-tenant (resellable) WhatsApp ordering system. Customers browse, ask questions, build a cart and pay
inside WhatsApp. Products, prices and orders come **live from the client's existing store**: Shopify,
WooCommerce, any custom VPS site, or a built-in catalogue for sellers with no website. AI replies come from
**your Dify** (`https://dify.rcshopper.com`, using OpenAI / OpenRouter models).

See [docs/COMPETITOR_REVIEW.md](docs/COMPETITOR_REVIEW.md) for how this compares with Take.App and Cuedesk.

```
 Customer on WhatsApp
        │  (Meta WhatsApp Cloud API webhook, signature-verified)
        ▼
 ┌──────────────────────────── whatsapp-commerce (this service) ───────────────────────────┐
 │  Bot engine: menu · categories · product cards · variants · qty · cart · checkout       │
 │  delivery/collection · address · payment choice · order status · human handover        │
 │        │                         │                                  │                   │
 │   Store adapter             Dify client  ◄── /tools (Agent mode) ───┘                   │
 │  shopify | woocommerce |   (streaming)                                                  │
 │  custom | manual                                                                         │
 │  Dashboard: clients · test bot · inbox · orders · catalogue · settings · broadcasts      │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
        │                                   │
 Shopify Admin API / WooCommerce REST /   dify.rcshopper.com ── OpenAI / OpenRouter
 your VPS store API
```

## Features

- **Tap-to-order in chat.** WhatsApp interactive lists and buttons for categories, products (with image), variants, quantity, cart, checkout.
- **Checkout options.** Delivery or collection, delivery fee, free delivery over £X, minimum order, saved addresses, shared location.
- **Payments.**
  - *Pay online*: a Shopify draft-order invoice link, WooCommerce `payment_url`, or your own Stripe/PayPal link for the built-in catalogue.
  - *Cash on delivery/collection.*
  - *Bank transfer*: shows your bank details; staff get an alert when the customer sends a payment screenshot.
- **Orders are created in the real store.** Shopify draft orders (or completed orders with payment pending for COD), WooCommerce orders, or custom API orders. They also show in the dashboard.
- **AI chatbot, auto-created in your Dify** (see below). Two modes:
  - `assist` (recommended to start): the service searches the store, gives Dify the matching products and the cart, then sends the AI reply with a tappable product list underneath. Works with any Dify Chatbot or Chatflow app and its knowledge base.
  - `agent`: a Dify Agent app calls this service's store tools (search, add to cart, checkout, order status, handover) through an OpenAPI custom tool. Each call is locked to the customer in the chat by a signed `session_token`.
  - If Dify fails, the bot falls back to a plain catalogue search, so customers always get an answer.
- **Knowledge base (RAG) per shop.** Shops add knowledge four ways:
  - upload files (PDF, Word, Excel, PowerPoint, TXT, CSV);
  - paste text;
  - import web pages;
  - one click "auto-import my site" (policies, FAQ, about, contact).

  Each shop gets its own Dify knowledge base, created through Dify's knowledge API with one server-side key, and it is attached to the shop's chatbot automatically. It uses high-quality embeddings when the workspace has an embedding model, otherwise keyword indexing. A built-in keyword search with synonyms answers policy questions even before AI is connected, and points customers to the policy page plus a "talk to the team" button instead of guessing. Website imports are SSRF-protected: internal addresses, redirects and file size are all checked.
- **One-step onboarding from a website.** At sign-up (or from the Overview wizard) a shop enters its website. A Shopify site is detected via `/meta.json`, which fills in the name, currency and description, connects the catalogue with **no token** (`shopify_public`: reads `/products.json`, checks out with a Shopify cart permalink), and imports its policies into the knowledge base.
- **Take.App-style extras.**
  - Promo codes (percent, fixed or free delivery; min spend, expiry, usage limits).
  - Delivery zones by postcode, each with its own fee, minimum order and free-over amount.
  - Delivery or collection time slots.
  - Order notes and "was" prices.
  - Stock levels with low-stock alerts (built-in catalogue).
  - Receipt page for every order.
  - Stripe card payments with automatic "paid" confirmation.
  - Payment reminders and win-back offers.
- **Storefront / link-in-bio page** at `/s/<tenantId>` (or the client's own domain). Each "Order on WhatsApp" button opens that product in the chat.
- **Analytics** (revenue, orders, conversion, top products, promo usage), **CSV** product import and order/customer export, and **team logins** (owner / staff).
- **Human handover.** The customer types "human" (or the AI decides), staff get an alert, and staff reply from the dashboard **Inbox**. The bot stays quiet until handed back.
- **Order updates.** Shopify and WooCommerce order webhooks send "confirmed / shipped / completed" updates to the customer on WhatsApp. Customers can also type "order status" or "order 1001".
- **Abandoned-cart reminder.** One nudge after N minutes, only inside the free 24-hour window.
- **Drag-and-drop flow builder (Automations tab).** Like AiSensy's: a *Flow start* block (keywords, first message, Click-to-WhatsApp ad IDs) connected to these blocks:
  - text or media with up to 3 buttons, and list menus — each button or row can lead somewhere different;
  - questions, validated and saved to the contact;
  - single or multi product cards from the store, and approved templates;
  - tags, waits (delays), webhooks to a CRM, hand-off to a human, the shop menu, and end.

  Ready-made starting flows are included: welcome menu, lead capture and FAQ.
- **Contacts.** Tags, custom fields, CSV import, and which ad a contact came from.
- **Campaigns.** Approved templates sent to segments (tags, ordered / never ordered, inactive for N days). Schedule up to 2 months ahead, personalise with `{{name}}`, and see sent → delivered → read → replied. Retarget people who didn't read or didn't reply.
- **Template manager.** Create, list and delete Meta message templates, plus a one-click starter library (order confirmation, shipping update, abandoned cart, payment reminder, win-back, offers, back in stock).
- **Website orders (Shopify / WooCommerce).** WhatsApp order-confirmation and shipping templates, plus **abandoned-checkout recovery**. Recovery respects marketing consent and stops when the order completes.
- **Lite mode (no WhatsApp API needed).** The storefront gets a web basket and checkout. Orders land in the dashboard, and the customer taps "Send order on WhatsApp", which messages the shop's normal WhatsApp.
- **Website AI chat widget.** Add one line to any website: `<script src="https://<PUBLIC_URL>/chat-widget/<tenantId>.js" async></script>`.
  - It's the same bot as on WhatsApp: AI, knowledge base, products, cart, flows and hand-off to staff.
  - No Meta account is needed, so prospects can try it before the WhatsApp onboarding.
  - Checkout hands the basket to the storefront (or to Shopify's own checkout for URL-only shops).
  - Staff replies from the Inbox reach the visitor through polling.
  - Web visitors are never included in WhatsApp campaigns or Meta cost estimates.
- **WhatsApp go-live checklist** on the Overview page: business portfolio, connection, number verified, payment method, display name, templates, quality and receiving messages. Each step is checked automatically where Meta exposes it, otherwise it links to the right Meta page.
- **Grow tools.** wa.me link and QR-code generator, and an embeddable floating WhatsApp chat button for any website.
- **Broadcasts.** Approved WhatsApp templates go to customers who opted in. Customers can type SUBSCRIBE or STOP.
- **Staff alerts.** New orders go to staff WhatsApp numbers, and to a webhook for n8n, Zapier or Make.
- **Reseller / SaaS features.**
  - Multiple clients (tenants), plans with monthly limits, usage metering.
  - Per-client admin keys, owner/staff logins and chat assignment.
  - Secrets encrypted at rest (AES-256-GCM).
  - **Self-serve sign-up** with a free trial, **Stripe Billing** subscriptions and a billing portal.
  - **Meta Embedded Signup**, so clients connect their WhatsApp number themselves.
- **Operations.** Daily SQLite backups (kept 14 days), error alerts to Slack/Discord/n8n, security headers, rate limiting, graceful shutdown, and a system status endpoint.
- **Legal templates.** `/legal/terms`, `/legal/privacy` and `/legal/dpa` are drafts to fill in and have a solicitor review.
- **Built-in simulator** ("Test bot" tab) for trying the whole flow without WhatsApp.

## Quick start

Requires Node.js **22.13+** (uses the built-in `node:sqlite`; the only dependency is Express).

```bash
cd whatsapp-commerce
cp .env.example .env      # set ENCRYPTION_KEY, SUPER_ADMIN_KEY, PUBLIC_URL
npm install
npm test
npm start                 # http://localhost:3000/admin
```

Open `/admin`. Leave Tenant ID empty and sign in with `SUPER_ADMIN_KEY`, then go to **Clients → Create client**.
Save the **admin key** (give it to the client) and the **Dify tool key**. Each is shown once.

### Deploy on your VPS (Docker)

```bash
docker compose up -d --build
```

Put it behind HTTPS (nginx, Caddy or Traefik), e.g. `wa.rcshopper.com → 127.0.0.1:3000`. Meta requires HTTPS for webhooks.
The SQLite database lives in `./data`, so back that folder up.

## Connecting a client

All of this is done in the dashboard's **Settings** tab (signed in as the client or as super admin).

### 1. WhatsApp (Meta Cloud API)
1. Go to developers.facebook.com → **Create app (Business)** → add **WhatsApp**. Add and verify the business phone number.
2. In Business Settings → **System users**, create a system user, give it the app plus the WhatsApp account with `whatsapp_business_messaging` and `whatsapp_business_management`, and generate a **permanent token**.
3. In the dashboard Settings, fill in **Phone number ID**, **WABA ID**, **access token**, and **App secret** (App settings → Basic).
4. In Meta App → WhatsApp → Configuration → Webhook, set:
   - **Callback URL**: copy it from the dashboard Overview (`https://<PUBLIC_URL>/webhooks/whatsapp/<tenantId>`).
   - **Verify token**: also shown on the Overview.
   - Subscribe to **messages**.
5. On the Overview tab, use **Send test WhatsApp**.

### 2a. Shopify store
1. Shopify admin → Settings → Apps → **Develop apps** → create an app.
2. Grant the Admin API scopes `read_products`, `read_orders`, `write_orders`, `write_draft_orders`. Install it and copy the `shpat_…` token.
3. In Settings: Store type `shopify`, domain `yourshop.myshopify.com`, and the token.
4. Optional, for order updates: Settings → Notifications → Webhooks → *Order update* (JSON) → the **Store order webhook** URL from the Overview tab.

### 2b. WooCommerce store on your VPS
1. WooCommerce → Settings → Advanced → REST API → **Add key** with *Read/Write* permission.
2. In Settings: Store type `woocommerce`, site URL, `ck_…`, `cs_…`. The site must be on HTTPS.
3. Optional: WooCommerce → Settings → Advanced → Webhooks → *Order updated* → the Store order webhook URL.

### 2c. Other VPS sites
Implement the six small endpoints in [docs/CUSTOM_STORE_API.md](docs/CUSTOM_STORE_API.md) and choose store type `custom`.

### 2d. No website
Use store type `manual` and add products on the **Catalogue** tab, either as JSON or by CSV import (`id,title,price,compare_at_price,category,description,image,stock,options`).
For card payments, add the client's **Stripe secret key** and **webhook signing secret** in Settings, and create a Stripe webhook
for `checkout.session.completed` pointing at the Stripe webhook URL shown on the Overview tab. Each order gets its own Stripe Checkout
link, and the order is marked paid automatically. Alternatives: a static payment link (`{total}`/`{order}` placeholders), COD or bank transfer.

### 2e. Storefront page
Set *Public WhatsApp number* (plus optional tagline, logo and custom domain) in Settings. The link-in-bio page is at
`https://<PUBLIC_URL>/s/<tenantId>`. For a custom domain, point a CNAME at the server and add the domain to your HTTPS proxy.

### 3. AI engine: Direct (built in) or Dify

**Direct mode (recommended, no Dify needed).** Set:
- `AI_API_KEY` (OpenRouter by default; any OpenAI-compatible API via `AI_BASE_URL`);
- optionally `AI_MODEL`;
- optionally `EMBEDDINGS_MODEL`, for semantic knowledge search.

In this mode:
- The knowledge base is indexed inside the app: SQLite FTS5 with stemming, plus embeddings when configured. PDF, Word, PowerPoint and Excel text is extracted without extra libraries.
- Agent mode runs the same 9 store tools in-process. Each tool call is bound to the customer in that chat by the server, never chosen by the model.
- With OpenRouter, requests are routed with `data_collection: deny` and zero data retention, and only to the providers in `AI_PROVIDER_ORDER`. List those providers as your sub-processors.
- Shops choose the engine on the **AI assistant** tab. New shops use Direct automatically when no Dify app exists.

> **Dify licence note:** Dify's licence forbids operating a multi-tenant service without written permission from Dify (business@dify.ai). Direct mode avoids the question entirely; use the Dify mode below only with a licence or for your own shops.

### 3a. Dify mode (created automatically in dify.rcshopper.com)

The system creates and maintains each client's AI chatbot in your Dify. You don't build anything in Dify by hand.

**One-time server setup.** Give this service access to your Dify console, using one of these:
- **Admin API key (recommended).** In Dify's `docker/.env` set `ADMIN_API_KEY_ENABLE=true` and `ADMIN_API_KEY=<long random string>`, then restart Dify.
  Here, set `DIFY_ADMIN_API_KEY` to the same value and `DIFY_WORKSPACE_ID` to your workspace ID. You can get the ID with
  `docker exec -it docker-db-1 psql -U postgres -d dify -c "select id, name from tenants;"`.
- **Login.** Set `DIFY_CONSOLE_EMAIL` and `DIFY_CONSOLE_PASSWORD` to a Dify owner/admin account.

Make sure Dify has a model provider (OpenAI or OpenRouter) and a system default model
(Dify → Settings → Model Provider). Optionally, force a model with `DIFY_DEFAULT_MODEL=provider|model`.

**Per client:**
- When you create a client, its chatbot app is created in Dify, an API key is generated, and AI is switched on.
- The **AI assistant** tab lets you (or the client) set the assistant name, tone, model (any LLM in your Dify), the "about the shop" text, FAQ and policies, and extra instructions. Press **Save & update AI chatbot** and the Dify app is updated in place.
- Delivery fees, minimum order, payment options and support hours are written into the bot's instructions automatically, and re-synced whenever settings change.
- The app appears in Dify as "<Shop> · WhatsApp", where you can see its logs or attach a Knowledge base for long documents.

### 3b. Manual Dify setup (optional; e.g. a client's own Dify, or agent mode)
1. In Dify, **Create app → Chatbot** (or Chatflow) and pick your OpenAI or OpenRouter model.
2. Paste the instructions from [dify/assist-system-prompt.md](dify/assist-system-prompt.md).
3. Add the input variables `store_name`, `customer_name`, `currency`, `session_token` (Text, optional).
4. Optional: attach a **Knowledge** base with the client's FAQs, delivery and returns policy.
5. **Publish**, then go to **API Access → API Key** and create a key (`app-…`).
6. In Settings → AI: enable it, set Base URL `https://dify.rcshopper.com/v1`, the API key, and mode `assist`. Click **Test Dify** on the Overview tab.

**Agent mode (the AI places orders itself) is also automatic.** Choose *Agent* on the AI assistant tab and press Save. The system:
- registers a custom tool in Dify for that client (`wa_store_<tenant>`), pointing at `https://<PUBLIC_URL>/tools` with a fresh tool key;
- creates a Dify **Agent** app (function calling) with all 9 store tools enabled;
- switches the client over.

Products the agent finds are also sent as a tappable list. This needs `PUBLIC_URL` to be public HTTPS so Dify can reach the tools.
Switching back to *Assistant* re-uses the earlier chatbot app.

**Manual agent setup** (only for a Dify the server can't administer):
1. In Dify → Tools → **Custom** → Create, import from URL `https://<PUBLIC_URL>/dify/store-tools.openapi.json`.
2. Set Auth to *API Key*, header `X-Tool-Key`, value = the client's tool key.
3. Create an **Agent** app, enable all the tools, and paste [dify/agent-system-prompt.md](dify/agent-system-prompt.md).
4. Add the same input variables, publish, create the API key, and set mode `agent` in Settings.

Notes:
- One Dify app per client works best, because each has its own prompt and knowledge base. One shared app also works, since the shop name is passed as an input.
- Dify `inputs` are fixed when a conversation starts. That is why live product context goes into the message itself in assist mode.

## What customers can type

| Customer types | Bot does |
|---|---|
| `hi`, `menu` | Welcome + main menu |
| anything else | AI answer + matching products (or catalogue search if AI is off) |
| `browse`, `shop` | Categories |
| `cart`, `checkout`, `clear cart`, `remove 2` | Cart actions |
| `order status`, `order 1001`, `#1001` | Order tracking (store orders are only shown to the phone number that placed them) |
| `human`, `agent` | Handover to staff |
| `subscribe` / `stop` | Marketing opt-in / opt-out |

## Selling it

**Sales website.** `https://<PUBLIC_URL>/` is a marketing home page: hero, how it works, features, comparison, pricing (read live from your plans), FAQ and legal links. **Self-serve sign-up** is at `/signup`.

Each new shop gets a free trial (`TRIAL_DAYS`, default 14) with **no card needed**, and lands in its dashboard. The dashboard shows a "days left" banner. When billing is configured, a trial that ends without a subscription pauses that shop's bot, but the dashboard stays open so the owner can pick a plan. Set `STRIPE_AUTOMATIC_TAX=true` to charge UK VAT through Stripe Tax. Stripe itself emails receipts and trial reminders if you switch those emails on in Stripe → Settings → Emails.

**Charging clients (Stripe Billing):**
1. In your own Stripe account, create one recurring Price per plan.
2. Set `PLATFORM_STRIPE_SECRET_KEY`, `STRIPE_PRICE_STARTER/GROWTH/PRO` and `PLATFORM_STRIPE_WEBHOOK_SECRET`.
3. Add a Stripe webhook to `https://<PUBLIC_URL>/webhooks/platform-stripe` for these events:
   - `checkout.session.completed`
   - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`

Clients choose and pay for a plan on the **Billing** tab, which also opens Stripe's portal for card, invoices and cancellation. Plan changes sync automatically, and cancelled shops are suspended.

**One-click WhatsApp connection (Meta Embedded Signup):**
1. Become a Meta **Tech Provider**.
2. Create a *Facebook Login for Business* configuration for WhatsApp Embedded Signup.
3. Set `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID` and `META_WEBHOOK_VERIFY_TOKEN`.
4. Point the app-level webhook at `https://<PUBLIC_URL>/webhooks/whatsapp`.

Clients then click **Connect WhatsApp** on the Overview tab. The token, WABA subscription and number registration are handled for them.

**Operations:**
- `ALERT_WEBHOOK_URL` receives errors.
- Backups go to `BACKUP_DIR`. Copy that folder off the server too (e.g. rclone to S3 or Backblaze).
- `GET /api/system/status` (super admin) shows tenants, jobs and backups.
- SQLite is fine for tens of shops on one server. Move to Postgres before running hundreds.

Plans live in `src/tenants.js` (`PLANS`). Defaults: **Starter £29**, **Growth £79** (adds campaigns), **Pro £199**.
Limits cover monthly inbound messages and AI replies; the dashboard shows usage against the limit.
Compared with Take.App ($29–50, own catalogue only) and Cuedesk (£249–699, no ordering), the pitch is:
*"Your existing Shopify/WooCommerce shop, sellable on WhatsApp with an AI assistant, from £29/month."*
Meta's own per-conversation WhatsApp charges are billed to each client's Meta account.

## API reference (admin)

All endpoints need the header `Authorization: Bearer <super admin key | tenant admin key>`.

| Method & path | Purpose |
|---|---|
| `GET /api/tenants` · `POST /api/tenants` | List or create clients (super admin) |
| `PATCH /api/tenants/:id/meta` · `POST …/rotate-keys` · `DELETE …` | Plan, suspend, keys (super admin) |
| `GET /api/tenants/:id` · `PATCH …/settings` | Read or update settings (secrets are redacted on read) |
| `POST …/test/store\|dify\|whatsapp` | Connection tests |
| `POST …/simulate` `{text \| actionId, waId}` | Chat with the bot without WhatsApp |
| `GET …/orders` · `PATCH …/orders/:oid` `{status, payment_status, notify}` | Orders |
| `GET …/conversations` · `…/:waId/messages` · `POST …/:waId/reply` · `POST …/:waId/handover` | Inbox |
| `GET …/customers` · `POST …/broadcasts` `{template, language, components}` | Broadcasts |
| `GET/POST …/flows` · `PUT/DELETE …/flows/:id` | Automations (flow builder) |
| `GET …/contacts` · `PATCH …/contacts/:waId` · `POST …/contacts/import` | Contacts, tags, attributes |
| `GET/POST …/campaigns` · `POST …/campaigns/preview` · `POST …/campaigns/:id/cancel` | Campaigns |
| `GET/POST …/templates` · `DELETE …/templates/:name` | Meta message templates |
| `POST …/messages` `{to, text \| template}` | Send a WhatsApp message (developer API) |
| `GET …/analytics` · `GET …/export/orders.csv` · `GET …/export/customers.csv` · `POST …/catalogue/import` | Analytics & CSV |
| `GET/POST/DELETE …/staff` · `POST …/conversations/:waId/assign` | Team & chat assignment |
| `GET …/billing` · `POST …/billing/checkout` · `POST …/billing/portal` · `POST …/whatsapp/embedded` | Billing & Embedded Signup |
| `POST /api/signup` · `GET /api/system/status` · `POST /api/system/backup` | Sign-up, ops (super admin) |

## Project layout

```
src/server.js              Express app & routes
src/whatsapp/              Cloud API client (send, payload limits, parse) + webhook (signature, dedupe, queue)
src/bot/engine.js          Conversation flow
src/bot/{cart,orders,state,pricing,flows}.js   cart, orders, promo/zones/slots, flow engine
src/campaigns.js · src/templates.js · src/analytics.js · src/platform.js (billing, Embedded Signup) · src/ops.js · src/legal.js
src/stores/                shopify.js · woocommerce.js · custom.js · manual.js (same interface)
src/dify/client.js         Dify streaming client
src/routes/                admin API, Dify tools API, store webhooks, storefront/receipts/web checkout/widget
public/index.html          Dashboard · public/flow-builder.js (canvas builder) · public/signup.html
dify/                      Prompts + OpenAPI tool schema for Dify
test/                      node:test suite (npm test)
```
