# Competitor review: Take.App and Cuedesk (Nov 2026)

## Take.App: WhatsApp store / order taking
Aimed at small sellers. A hosted mini-store link; the order lands in WhatsApp.

| Area | What they offer |
|---|---|
| Catalogue | Unlimited products, categories, variants & add-ons, compare-at prices, services, link-in-bio, SEO, custom domain |
| Checkout | Chat checkout with options & quantity, delivery vs pickup, distance/weight delivery fees, minimum order, delivery date/time slots, promo codes, tips |
| Payments | 100+ local methods, COD, bank transfer / QR with **payment-proof upload**, Stripe/PayPal/Razorpay (cards on top tier). Money goes straight to the merchant |
| Orders | Dashboard with order + payment status, invoices, CSV import/export, analytics, POS, barcode scanning |
| Automation | Payment reminders, birthday / win-back campaigns, staff alerts for new orders & low stock, broadcasts |
| Integrations | API, webhooks, Meta Pixel, mobile apps |
| Pricing | Free (50 orders/mo) · Essential **$29/mo** · Business **$50/mo** (WhatsApp automation, inbox, 5 stores, API) |

**Weakness:** it is its own store. It doesn't sell *from* an existing Shopify/WooCommerce catalogue, and the AI is limited.

## Cuedesk: WhatsApp Business Solution Provider (UK)
Aimed at service teams. A shared inbox + chatbot builder on the official WhatsApp Business API.

| Area | What they offer |
|---|---|
| Inbox | Shared team inbox, ownership, permissions, human handover with context, reporting, calls with recording/transcripts |
| Automation | Chatbot builder, AI agents, auto-routing/assign, templates; capped "AI resolutions" (500–1,000/mo) |
| Broadcasts | Template broadcasts |
| Commerce | **No ordering/catalogue features advertised** |
| Integrations | CRM/helpdesk integrations, custom API workflows (1–3 apps by tier) |
| Pricing | Connect **£249/mo** (+£249 onboarding) · Automate **£499/mo** · Scale **£699/mo** · Enterprise |

**Weakness:** expensive, and no native ordering, so a shop has to build ordering flows itself.

## Our positioning
Combine the two: Take.App-style **tap-to-order checkout inside WhatsApp** and Cuedesk-style **inbox + AI agent + handover**,
**plugged into the merchant's existing Shopify / WooCommerce / custom store** (no second catalogue to maintain),
with AI from **our own Dify** (OpenAI / OpenRouter, so we control model costs), at a UK small-business price.

| Feature | Take.App | Cuedesk | **This system** |
|---|---|---|---|
| Official WhatsApp Cloud API | ✅ (Business) | ✅ | ✅ |
| Tap-to-order catalogue, variants, qty, cart | ✅ | ❌ | ✅ (interactive lists & buttons) |
| Uses existing Shopify / WooCommerce stock & prices | ❌ | ❌ | ✅ live |
| Built-in catalogue for sellers with no website | ✅ | ❌ | ✅ |
| Delivery / collection, delivery fee, free-over, min order | ✅ | ❌ | ✅ |
| Pay online link / COD / bank transfer + proof | ✅ | ❌ | ✅ (Shopify invoice, Woo payment URL, Stripe link) |
| AI assistant answering product questions | limited | ✅ | ✅ Dify (assist or agent mode, knowledge base) |
| AI that can add to cart & place orders | ❌ | ❌ | ✅ (agent mode tools) |
| Human handover + shared inbox | ✅ (Business) | ✅ | ✅ |
| Order status lookup & proactive updates | ✅ | ❌ | ✅ (store webhooks → WhatsApp) |
| Abandoned-cart reminder | partial | ❌ | ✅ |
| Broadcasts to opted-in customers | ✅ | ✅ | ✅ (templates, opt-in/STOP) |
| Staff new-order alerts + webhook to n8n/Zapier | ✅ | ✅ | ✅ |
| Multi-tenant reseller admin, plans & usage metering | ❌ | ❌ | ✅ |

## Take.App parity checklist (Nov 2026)

✅ = built · ⚠️ = partly / different approach · ❌ = not built

| Take.App feature | Status | How it works here |
|---|---|---|
| Unlimited products, images, categories | ✅ | Built-in catalogue, or live from Shopify / WooCommerce / custom store |
| Variants (size etc.) | ✅ | Option picker in chat |
| Add-ons / modifiers (extra toppings) | ⚠️ | Model them as variants; no separate multi-select add-ons yet |
| Compare-at ("was") price | ✅ | Shown as ~£20~ £15 in chat and on the storefront |
| Service listings with turnaround options | ⚠️ | List services as products; time slots cover booking times |
| Hosted store page / link in bio | ✅ | `/s/<tenant>` storefront with "Order on WhatsApp" buttons that open the product in chat |
| SEO for store pages | ✅ | Title, description and Open Graph tags on the storefront |
| Custom domain | ✅ | `business.customDomain`; CNAME the domain to the server (HTTPS via your proxy) |
| Chat checkout (options, quantity) | ✅ | Tap-to-order lists/buttons, or the AI agent takes the order |
| Delivery or pickup | ✅ | |
| Delivery fee by distance / weight | ⚠️ | Fees by **postcode zone** (per-zone fee, minimum order, free-over). No distance or weight pricing |
| Minimum order | ✅ | Global or per zone |
| Delivery date & time selection | ✅ | Configurable time slots, lead time, closed days, timezone |
| Promo codes | ✅ | Percent, fixed or free delivery; min spend, expiry, max uses, once per customer. Passed to Shopify/WooCommerce |
| Cutlery / special requests | ✅ | Order note on the summary step |
| Tips | ❌ | Not built |
| Order summary with tax | ⚠️ | Summary shows items, discount, delivery, total; tax comes from the connected store |
| Local payment methods / cash on delivery | ✅ | COD, bank transfer, pay-online link |
| Bank transfer + payment proof | ✅ | Bank details are sent; staff get an alert when a screenshot arrives |
| Card payments, auto-confirm | ✅ | Shopify invoice / WooCommerce payment page, or **Stripe Checkout** for built-in and custom stores; Stripe webhook marks the order paid and messages the customer |
| Money goes straight to the merchant | ✅ | Each client uses their own store or Stripe account |
| Orders dashboard (status, paid/unpaid) | ✅ | |
| Invoice / receipt link | ✅ | `/r/<token>` receipt page sent with every order |
| Order status tracking | ✅ | "order status" in chat + store webhooks for proactive updates |
| CSV import / export | ✅ | Product CSV import; orders and customers CSV export |
| Analytics | ✅ | Revenue, orders, AOV, chat→buyer conversion, new/repeat customers, revenue per day, top products, promo usage |
| Payment reminders | ✅ | One reminder for unpaid online / bank-transfer orders |
| Abandoned cart reminder | ✅ | |
| Win-back campaigns | ✅ | Approved template to opted-in customers with no order in N days |
| Birthday offers | ❌ | Not built (needs date-of-birth capture) |
| New-order / payment alerts to team | ✅ | WhatsApp to staff numbers + webhook (n8n / Zapier / Make) |
| Low-stock alerts | ✅ | Built-in catalogue stock is checked and decremented, with an alert at the threshold |
| WhatsApp broadcasts | ✅ | Approved templates to opted-in customers |
| Shared WhatsApp inbox + human handover | ✅ | |
| Instagram inbox | ❌ | WhatsApp only |
| Multiple stores | ✅ | Unlimited clients (tenants) |
| Staff accounts | ✅ | Owner / staff logins per client |
| Customer login & memberships | ❌ | Not built |
| API & webhooks | ✅ | Admin REST API, order webhooks, Dify tools API |
| Meta Pixel | ❌ | Not built |
| Browser POS / barcode scanning | ❌ | Not built |
| Mobile apps | ⚠️ | Dashboard works on mobile browsers; no native app |
| **AI that answers questions and takes orders** | ✅ **(Take.App doesn't have this)** | Dify assistant or agent, created automatically |
| **Sell from an existing Shopify / WooCommerce store** | ✅ **(Take.App doesn't have this)** | Live products, prices and stock; orders created in the store |

## Roadmap ideas (not built yet)
Tips · add-on modifiers · distance-based delivery fees · birthday offers · Meta Pixel · Instagram/Messenger channels ·
WhatsApp Flows forms for address capture · Meta catalogue sync (native WhatsApp cart) · Stripe Billing for your own
subscriptions · POS.
