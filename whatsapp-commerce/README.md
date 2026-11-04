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
- **Human handover.** The customer types "human" (or the AI decides), staff get an alert, and staff reply from the dashboard **Inbox**. The bot stays quiet until handed back.
- **Order updates.** Shopify and WooCommerce order webhooks send "confirmed / shipped / completed" updates to the customer on WhatsApp. Customers can also type "order status" or "order 1001".
- **Abandoned-cart reminder.** One nudge after N minutes, only inside the free 24-hour window.
- **Broadcasts.** Approved WhatsApp templates go to customers who opted in. Customers can type SUBSCRIBE or STOP.
- **Staff alerts.** New orders go to staff WhatsApp numbers, and to a webhook for n8n, Zapier or Make.
- **Reseller features.** Multiple clients (tenants), plans with monthly limits, usage metering, per-client admin keys, and secrets encrypted at rest (AES-256-GCM).
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
Use store type `manual` and enter products on the **Catalogue** tab. For online payment, set *Payment link* to a Stripe or PayPal link
(`{total}` and `{order}` placeholders are supported); otherwise use COD or bank transfer.

### 3. AI chatbot (created automatically in dify.rcshopper.com)

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

**Agent mode (the AI places orders itself):**
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

Plans live in `src/tenants.js` (`PLANS`). Defaults: **Starter £29**, **Growth £79** (adds broadcasts), **Pro £199**.
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

## Project layout

```
src/server.js              Express app & routes
src/whatsapp/              Cloud API client (send, payload limits, parse) + webhook (signature, dedupe, queue)
src/bot/engine.js          Conversation flow
src/bot/{cart,orders,state}.js
src/stores/                shopify.js · woocommerce.js · custom.js · manual.js (same interface)
src/dify/client.js         Dify streaming client
src/routes/                admin API, Dify tools API, store webhooks
public/index.html          Dashboard
dify/                      Prompts + OpenAPI tool schema for Dify
test/                      node:test suite (npm test)
```
