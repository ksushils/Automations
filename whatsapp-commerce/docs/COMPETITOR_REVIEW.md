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

## Roadmap ideas (not built yet)
Promo codes · delivery time slots · distance-based delivery fees · WhatsApp Flows forms for address capture ·
Meta catalogue sync (native WhatsApp cart) · Stripe Billing for your own subscriptions · CSV export · multi-staff logins ·
Instagram/Messenger channels · low-stock alerts.
