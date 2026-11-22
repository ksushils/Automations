# AI Business Assistant – build summary for external review

*Written 22 November 2026, after build batch 15. For a reviewer who hasn't seen the code. The detail and evidence for each point are in `docs/BUILD_PROGRESS.md`, `PRODUCT_BUILD_AUDIT.md`, `SECURITY_REVIEW.md` and `END_TO_END_TEST_RESULTS.md`.*

## What it is

- **For:** UK small businesses (trades, salons, clinics, takeaways, shops, travel agents, garages and more).
- **What it does:** an AI assistant that answers customers on the business's **website chat** and **WhatsApp**. It answers from the business's own website and documents, takes leads, bookings, quotes and orders, and hands the chat to a person when needed.
- **How it's sold:** as a multi-business SaaS with a dashboard for each business and a super-admin dashboard for the platform owner.
- **Live at** wa.karatit.com (production deploy). There are 12 businesses on it: 5 real, the rest instant-demo copies. None is paying and none has WhatsApp connected yet.

## Stack and architecture

- **Server:** Node.js (22 in production), ES modules, Express 5. Server-rendered marketing site, plus a single-page dashboard in plain JavaScript (no framework).
- **Database:** SQLite through `node:sqlite`.
  - Settings: WAL mode, `synchronous=NORMAL`, 5-second busy timeout.
  - Schema changes are additive only: columns are added, nothing is dropped.
  - One database holds all businesses; every row is scoped to its business by `tenant_id`.
- **AI:** OpenRouter, using gpt-4o-mini by default.
  - Privacy settings: providers must not collect data; strict zero-data-retention is optional.
  - Retrieval: local search over the business's knowledge base, with optional embeddings.
  - A Dify engine is supported but optional.
- **Hosting:** one VPS shared with other apps, running Docker behind Traefik.
- **Deploy script** (`scripts/deploy-vps.sh`), in order:
  1. snapshot the database;
  2. tag the current image as "previous";
  3. merge the new code;
  4. run the full test suite inside the new image, and stop if anything fails;
  5. restart;
  6. check health, and roll back automatically if that fails.
- **Background jobs** run in-process: reminders, follow-ups, health checks, backups and a weekly re-read of each business's website.
- **Tests:** 362 automated tests (Node's built-in test runner) pass locally; 376 of 377 pass in the production image. They cover isolation, roles, flows, bookings, payments logic, webhooks, privacy and AI guard rails.

## Channels

- **Website chat widget:** an embeddable script with a pop-up greeting, a welcome menu, photo and PDF upload, a calendar for bookings, page-aware greetings, and an option to fill in the website's own enquiry form.
- **WhatsApp Cloud API:**
  - signed webhooks, with recovery of unprocessed messages after a restart;
  - the 24-hour window and templates outside it;
  - catalogue and tap-to-order;
  - a daily connection-health check, now warning 7 days before access ends;
  - coexistence with the WhatsApp Business phone app (the AI goes quiet while staff reply from the phone).
- **Not built:** Instagram, Messenger and voice. Instagram and Messenger have been researched and need Meta App Review first.

## What the assistant does for customers

- **Answers questions** from the business's own website and documents, with trade-specific safety rules. For example: a dentist's assistant never diagnoses; a gas-leak question gets the National Gas Emergency number; prices are never invented; a booking is never claimed unless it was really made.
- **Lead capture:** "Email me details" or "Call me back".
  - Asks the questions that matter for the trade, one at a time with Skip (e.g. a plumber's: problem → postcode → urgency).
  - Urgent jobs are flagged.
  - The postcode is checked against the areas the business covers.
  - Marketing consent is a separate, optional tap.
- **Bookings:** from real free times.
  - Each booking blocks its service's length, plus any buffer between visits.
  - With staff listed, capacity follows who is working, and the customer can choose who.
  - Optional Stripe deposits.
  - Reminders, "book again" messages, reschedule and cancel.
  - Google Calendar sync.
  - Tested across UK clock changes.
- **Quotes:** request in the chat, with any photos attached; the AI drafts the lines from the price list and the team approves.
  - The customer gets a quote page and PDF, and can accept online.
  - One automatic follow-up after 2 days.
- **Orders (shops and takeaways):**
  - Ordering: built-in catalogue or Shopify/WooCommerce, basket, delivery zones and time slots, promo codes.
  - Payment: cash on delivery, bank transfer or Stripe payment links.
  - After the order: order status lookup and abandoned-basket reminders.
- **Hand-over to a person:**
  - The team inbox takes over the chat and the AI stays quiet.
  - Respects team hours.
  - If no staff reply within 15 minutes, the AI answers the customer's next message.
- **Support tickets** (e.g. for property maintenance repairs).

## What it does for the business owner

- **Setup:**
  - a 9-step guide;
  - AI auto-setup from the business's website;
  - trade templates: 16 trades plus 9 variants such as plumber, electrician, barber and nails.
- **Business Twin:** shows what the assistant learnt about the business, with the source page for each fact, and flags facts that conflict or are missing.
- **Today page ("To do now"):**
  - chats waiting for a person, urgent leads, bookings to confirm, quotes to price, orders, tickets, unanswered questions;
  - fitted to the type of business.
- **Leads:** list or board (New, Contacted, Won, Lost), with values and notes entered by the team. Reminders go to the team when a lead has waited 30 minutes and 4 hours. CSV export.
- **Opportunities:** gaps and missed follow-ups, each with its evidence.
- **Read-only owner copilot:** in the dashboard and over WhatsApp.
- **Morning briefing** over WhatsApp or email.
- **Automations:**
  - a keyword-triggered flow builder;
  - automations drafted from plain English: AI draft → only allowed steps kept → try-out on a throwaway copy → owner approval;
  - existing automations can be changed the same way.
- **Follow-ups:**
  - One log of every automatic message.
  - A cap per customer per day, plus quiet hours.
  - Review requests after orders and after visits.
  - Win-back messages, gated on consent.
- **Campaigns:** WhatsApp only, sent only to contacts who consented (UK PECR consent records).
- **Verified answers:** each answer is linked to its source and date, stale sources are flagged, and figures are checked.
- **Results page:** keeps verified, attributed, estimated and opportunity figures separate, each traceable to its records.
- **Integrations:**
  - webhooks for new leads, bookings and orders (Zapier, Make, n8n), plus Google Sheets;
  - Shopify app scaffolding.
- **Team:** staff keys with limited pages; an owner-only area for settings.
- **Billing:**
  - Stripe subscriptions with a trial and the customer portal.
  - Failed payments get a grace period.
  - Plan limits are enforced on the server, with a usage page.
  - Cancelling asks why.
  - Referral links.
- **Account recovery:** a "Lost your key?" one-time email link, sent to the account email.

## Marketing site and sales demo

- **Pages:** home, pricing, takeaways, trades, salons, a WhatsApp cost calculator, a fee checker against competitors, comparison pages, legal templates, a sitemap and robots.txt.
- **Instant demo (`/try`):** enter your website address and you get a working assistant in about a minute; it can be claimed as a trial.
- **`/examples`:** 8 scripted scenarios played through the real assistant engine on throwaway sample businesses (plumber, salon, shop), with what the team receives at the end. Nothing is sent and no AI is called.

## Safety, privacy and operations

- **Tenant isolation:**
  - Every business route requires that business's key; a test fails if a route doesn't.
  - Cross-business keys and record ids are refused (tested route by route).
  - Owner-only routes refuse staff keys.
- **Secrets:** encrypted at rest, with key rotation. Logs mask API keys and tokens (optional structured JSON logs).
- **Webhooks:**
  - incoming Meta and Stripe signatures are checked;
  - outgoing hooks are signed;
  - URL fetching is guarded against SSRF.
- **Other controls:**
  - Rate limits.
  - Dashboard security policy: safe rules enforced, the full policy in report-only mode.
  - An audit log that records field names, never values.
- **Privacy (UK GDPR):**
  - data export and erasure per person;
  - retention rules;
  - consent ledger;
  - a privacy page for each business.
- **Operations:**
  - health endpoint;
  - background-job failure alerts;
  - daily database integrity check;
  - daily local backups, plus encrypted off-server backups (built, but off until storage is configured);
  - scripted deploy and rollback, with a pre-deploy snapshot.
- **AI evaluation suite:** 15 cases with model, cost and latency recorded, including prompt injection, instructions hidden in documents, and requests for other customers' data. Real-model run: 15/15 passed. A load test is included; replies take about 240 ms of our own time on the server, before the AI's time.

## Not built, or blocked

- **Not built:**
  - a voice receptionist;
  - agency mode (one login across several client businesses);
  - multi-branch businesses;
  - Instagram and Messenger (researched; waiting on Meta App Review).
- **Waiting on the owner** (keys and accounts):
  - email delivery (Resend) and account emails for existing businesses;
  - live Stripe keys;
  - the first connected WhatsApp number;
  - storage for off-server backups;
  - the alert webhook.
- **Decisions needed:**
  - the product name (the current "WhatsApp…" name breaks Meta's trademark rules);
  - whether to charge the £500 set-up fee (shown on the site, not charged);
  - a legal review of the policy templates;
  - staff seats per plan;
  - what happens to data when someone cancels.

## Known trade-offs and risks (worth a reviewer's opinion)

1. **SQLite with in-process jobs on one VPS.** Deliberate for now, to be revisited at about 50 active businesses, if jobs fall behind, or if the database reports it is busy. There is no second instance or job queue.
2. **Login is a long-lived admin key kept in the browser.** There are no passwords or sessions. This is mitigated by the content-security policy, staff keys and key recovery, but it's weaker than session-based login.
3. **The dashboard is one large plain-JavaScript file** with escaping done by hand. Safety relies on `esc()` being used everywhere; the security policy isn't enforced yet.
4. **AI answers depend on the business's own website being accurate.** Guard rails exist (no invented prices, no claimed bookings, safety notices), but they are rules and evaluations, not proof.
5. **Meta policy risk:** the name and trademark, template approvals, and the 24-hour window.

## Questions we'd like a reviewer to look at

- Is the single-database, multi-business design (row-level `tenant_id`) adequately protected, or should anything move to per-business separation?
- What should replace the long-lived key login before paying customers arrive?
- Which of the not-built items (voice, agency mode, multi-branch, Instagram/Messenger) would matter most to UK small businesses first?
- Is anything in the AI guard rails or the evaluation suite clearly missing for a customer-facing assistant?
