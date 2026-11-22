# Product build audit

**Audit date:** 22 November 2026.
**Source of truth:** the code in `whatsapp-commerce/` and the automated tests. The product summary (`AI-assistant-platform-summary.md`) was used only as an index.
**Live server:** wa.karatit.com. It has 12 businesses on it, none paying and none with WhatsApp connected. Email (Resend), Stripe, Meta, the alert webhook and off-server backups are **not configured** there.

## Status key

| Status | Meaning |
|---|---|
| **Verified** | Works end-to-end against the real service, in production or production-like conditions. |
| **Tested** | Automated tests cover the main and failure paths, with external services faked. Not proven against the real service. |
| **Built, untested** | The code exists, but few or no tests cover it. |
| **Partial** | Some of the required behaviour is missing. |
| **Missing** | Not built. |
| **Blocked** | Needs credentials, approval or a decision from the owner. |

Today nothing is **Verified**: no real Stripe, Resend or Meta account has been connected and tested.

## Architecture

| Area | What exists (evidence) | Risk | Notes |
|---|---|---|---|
| Stack | Node 22+, ES modules, Express 5 (the only dependency), `node:sqlite` with WAL (`src/db.js`) | Low | Small attack surface. Upgrading Node also upgrades SQLite. |
| Schema changes | `SCHEMA` uses CREATE IF NOT EXISTS, plus a `MIGRATIONS` map that adds columns only (`src/db.js`) | Low | Nothing is ever dropped. Adding a NOT NULL column needs a default. |
| Tenancy | One database. Every business table has `tenant_id`, and routes go through `requireTenant` (`src/routes/admin.js`) | Medium | Now covered by `test/isolation.test.js` (see Security). |
| Oversized files | `bot/engine.js` 1,273 lines, `public/index.html` 1,800+, `routes/admin.js` 830+ | Medium | New work goes into separate modules. Split these files when they're next touched. |
| Jobs | In-process `setInterval` timers (`src/jobs.js`), plus a `scheduled` table for delayed work | Medium | Each job is now tracked: failures are counted, alerts sent and stale jobs detected. SQLite and in-process jobs are enough at this scale (see roadmap R0.9). |

## Phase 0: production readiness

| Feature | Status | Evidence | What's missing | Risk | Priority |
|---|---|---|---|---|---|
| Stripe subscriptions (checkout, trial, portal) | Tested | `src/platform.js`, `test/platform.test.js` | Live test-mode run against real Stripe. Portal must be configured to allow plan changes. | High | P0 |
| Stripe webhook idempotency and ordering | **Tested (this batch)** | `billing_events` table, `handlePlatformStripeEvent`, `test/phase0.test.js` | Replay with real Stripe CLI events | High | P0 |
| Failed payments, grace period, recovery | **Tested (this batch)** | `invoice.payment_failed` / `invoice.paid`, `enforceGracePeriods` | Real dunning settings in Stripe | High | P0 |
| Lifecycle emails (trial ending, cancel, failed, recovered) | **Tested (this batch)** | `applyBillingEvent`, which queues `emailShop` | Resend not configured on live | Medium | P0 |
| Entitlements enforced on the server | Tested | `PLANS` and `withinLimit` in `src/tenants.js`. Free plan has no WhatsApp (test in `platform.test.js`). Spend cap can't be raised by the shop (`round3.test.js`). | A full audit of every plan-gated feature (campaigns, seats, knowledge-doc limits) | Medium | P1 |
| Usage alerts | Tested | 80% AI-budget warning to staff (`round3.test.js`) | Owner email at 80% and 100% of the message allowance | Low | P2 |
| Email delivery (Resend) | **Tested (this batch)** | `email_log` table: records, retries with back-off, failure alerts, manual retry, purge | Live Resend key and verified domain | High | P0 |
| Transactional vs marketing email | Partial | `kind` column on `email_log`. Marketing campaigns are WhatsApp-only, gated on consent (`src/consent.js`). | Marketing email isn't built (by design) | Low | P2 |
| Account recovery | Missing | Login is by admin key; there are no passwords | Key-recovery-by-email flow | Medium | P1 |
| WhatsApp webhook signature and dedupe | Tested | `src/whatsapp/webhook.js`, `test/http.test.js`, `test/coexistence.test.js` | Live Meta app | High | P0 (Blocked) |
| Message recovery after restart | Tested | `recoverUnprocessed` (on start-up and every 30 s), dead-letter list and retry | No | Medium | Done |
| 24-hour window and templates | Tested | `test/whatsapp.test.js` | Live templates approved by Meta | Medium | Blocked |
| Opt-in/opt-out, consent records | Tested | `src/consent.js`, `test/consent.test.js`, `privacy.test.js` | No | Medium | Done |
| Coexistence, AI pause on human reply | Tested | `test/coexistence.test.js` | Live number | Medium | Blocked |
| Embedded Signup | Tested | `completeEmbeddedSignup`, `platform.test.js` | Meta app review and Tech Provider status | High | Blocked |
| Token expiry and connection health alerts | Partial | `/whatsapp/health` endpoint | Proactive daily check plus an owner alert | Medium | P1 |
| Health endpoint | **Tested (this batch)** | `/health` reports the database and job state with no internal details | External monitor not set up | Medium | P0 |
| Job failure detection | **Tested (this batch)** | `track()` and `jobHealth()` in `src/ops.js`. Alert after 3 failures in a row. | No | Medium | Done |
| Database integrity check | **Tested (this batch)** | `integrityCheck()` runs `PRAGMA quick_check` daily and alerts on failure | No | Low | Done |
| Local backups | Tested | Daily `VACUUM INTO`, keeping N copies (`src/ops.js`). Last result now saved in kv. | No | Medium | Done |
| Off-server encrypted backups | Tested, **not configured** | `src/offsite.js` (AES-256-GCM, SigV4), `test/offsite.test.js` | An S3 or R2 bucket | **High** | P0 (Blocked) |
| Restore procedure | **Drill passed locally (this batch)** | Backup, then seal, then `src/cli/restoreBackup.js`: counts matched and `integrity_check` = ok | A drill on the live server | High | P0 |
| Alert channel | Built | `alert()` posts to a Slack/Discord/n8n webhook | `ALERT_WEBHOOK_URL` not set on live | High | P0 (Blocked) |
| Structured logs and error tracking | Partial | Prefixed console logs, crash alerts; JSON logs with `LOG_FORMAT=json` (batch 11: secrets masked, request ids) | Error-tracking service (optional) | Low | P2 |
| Rollback | Partial | Pre-deploy database snapshot plus git (see `docs/DEPLOY.md`) | A scripted rollback command | Medium | P1 |

## Security

| Control | Status | Evidence |
|---|---|---|
| Tenant isolation, cross-business keys | **Tested (this batch)** | `test/isolation.test.js`: every `/tenants/:id/*` route (all methods) refuses another business's owner and staff keys |
| IDOR on record ids | **Tested (this batch)** | Tickets, articles, bookings, orders, leads, quotes and conversations can't be read or changed via your own address with another business's ids |
| Role-based access (owner vs staff) | **Tested (this batch)** | Every `requireOwner` route returns 403 to staff keys |
| Static route guard | **Tested (this batch)** | Every business route must start with `requireTenant` or `requireSuper` (the test fails otherwise) |
| Secrets at rest | Tested | `SECRET_FIELDS` encrypted, key rotation (`privacy.test.js`) |
| Webhook signatures | Tested | Meta (HMAC-SHA256), Stripe (`t=,v1=` with tolerance), outgoing hooks signed |
| SSRF | Tested | `isPrivateIp` guard on website import and hooks |
| Rate limits | Built | `/api` 600/min per IP. Sign-up 5/h. Chat 40/min per IP per shop. Demo 4/h. |
| XSS | Partial | `esc()` used throughout the dashboard. No CSP header yet. |
| Audit trail | Tested | `audit()` records field names, never values |
| Data retention | Tested | `applyRetention()` covers messages, consents and audit. `email_log` bodies are kept 30 days, records 180. |
| Prompt injection and AI tool permissions | Partial | Booking honesty guard. Prices only from the knowledge base. No AI tool can change data without a flow step. A formal evaluation suite is missing. |

Full detail is in `docs/SECURITY_REVIEW.md`.

## Phases 1–7 (summary)

| Area | Status | Notes |
|---|---|---|
| Instant website demo ("Business Twin") | Partial | `src/instantDemo.js` and `autoSetup.js` exist. Missing: show sources and uncertain facts, real progress, keep the configuration on claim. |
| Trades and salon demos | Partial | 16 trade templates (`src/trades.js`), including trades and salon. Missing: separate plumber, electrician, heating and barber variants; scripted demo scenarios. |
| Photo-to-quote | Partial | Photo understanding in web chat, quotes module with AI draft, team approval, PDF and accept. Missing: postcode/service-area check, linking the photo to the quote, trade qualification rules. |
| Lead qualification | Partial | Lead flows (`src/leads.js`). Missing: per-trade field sets, asked one question at a time. |
| Booking reliability | Tested | Slot capacity checks, deposits, reminders, Google Calendar (`bookings.js`, `gcal.js`). Missing: proof of correct times across the daylight-saving change, staff resources. |
| Follow-up engine | Partial | Lead nudges, quote follow-ups, abandoned carts, review requests. Missing: one history of automatic actions, a per-customer message cap. |
| Opportunity Radar | Missing | Data exists (leads, quotes, unanswered questions); there is no Opportunities view yet. |
| Owner copilot | Partial | Morning briefing and owner WhatsApp commands (`briefing.js`). Missing: dashboard Q&A, confirmation-gated actions. |
| Natural-language automations | Partial | Automation builder exists. AI-written drafts that are checked and simulated are missing. |
| Verified answers | Partial | Retrieval (RAG) keeps the source documents. Missing: an owner view of answer → source, flags for stale sources. |
| Results dashboard | Partial | Value report and results page. Missing: verified vs attributed vs estimated figures kept clearly apart. |
| Simple owner mode, onboarding | Partial | 9-step setup guide. Missing: the 6-item simple navigation. |
| Voice, Instagram, Messenger, agencies, multi-branch | Missing | Partner and referral tracking only. |
| Pricing packaging | Partial | Free/£29/£79/£249 in `PLANS`. The £500 setup fee is still on the marketing site (needs a business decision). |
| Marketing site | Partial | Server-rendered site. The name breaks Meta's trademark rules and must be changed. No fabricated testimonials found. |
| UK compliance | Partial | Consent ledger, data requests (export/erasure), retention, legal page templates. Needs legal review. |
| AI evaluations | Partial | `src/cli/qualityGate.js` and weekly quality score. Missing: a recorded evaluation suite with model, cost and latency. |
| Performance benchmarks | Missing | Nothing measured yet. |
