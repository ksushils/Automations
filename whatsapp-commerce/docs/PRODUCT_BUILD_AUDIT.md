# Product build audit

**Audit date:** 22 November 2026 (first written for batch 1; the phase summary and the rows marked *updated* were brought up to date after batch 15).
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
| Account recovery | Built (batch 13) | One-time email link to the sign-up address makes a new admin key (`src/recovery.js`, `test/recovery.test.js`) | Live Resend key so the link can actually be sent | Medium | P1 |
| WhatsApp webhook signature and dedupe | Tested | `src/whatsapp/webhook.js`, `test/http.test.js`, `test/coexistence.test.js` | Live Meta app | High | P0 (Blocked) |
| Message recovery after restart | Tested | `recoverUnprocessed` (on start-up and every 30 s), dead-letter list and retry | No | Medium | Done |
| 24-hour window and templates | Tested | `test/whatsapp.test.js` | Live templates approved by Meta | Medium | Blocked |
| Opt-in/opt-out, consent records | Tested | `src/consent.js`, `test/consent.test.js`, `privacy.test.js` | No | Medium | Done |
| Coexistence, AI pause on human reply | Tested | `test/coexistence.test.js` | Live number | Medium | Blocked |
| Embedded Signup | Tested | `completeEmbeddedSignup`, `platform.test.js` | Meta app review and Tech Provider status | High | Blocked |
| Token expiry and connection health alerts | Built (batches 2 and 14) | Daily check per business (`src/waHealth.js`), owner email + banner on problems, warning 7 days before access ends | – | Medium | P1 |
| Health endpoint | **Tested (this batch)** | `/health` reports the database and job state with no internal details | External monitor not set up | Medium | P0 |
| Job failure detection | **Tested (this batch)** | `track()` and `jobHealth()` in `src/ops.js`. Alert after 3 failures in a row. | No | Medium | Done |
| Database integrity check | **Tested (this batch)** | `integrityCheck()` runs `PRAGMA quick_check` daily and alerts on failure | No | Low | Done |
| Local backups | Tested | Daily `VACUUM INTO`, keeping N copies (`src/ops.js`). Last result now saved in kv. | No | Medium | Done |
| Off-server encrypted backups | Tested, **not configured** | `src/offsite.js` (AES-256-GCM, SigV4), `test/offsite.test.js` | An S3 or R2 bucket | **High** | P0 (Blocked) |
| Restore procedure | **Drill passed locally (this batch)** | Backup, then seal, then `src/cli/restoreBackup.js`: counts matched and `integrity_check` = ok | A drill on the live server | High | P0 |
| Alert channel | Built | `alert()` posts to a Slack/Discord/n8n webhook | `ALERT_WEBHOOK_URL` not set on live | High | P0 (Blocked) |
| Structured logs and error tracking | Partial | Prefixed console logs, crash alerts; JSON logs with `LOG_FORMAT=json` (batch 11: secrets masked, request ids) | Error-tracking service (optional) | Low | P2 |
| Rollback | Built (*updated*) | `scripts/deploy-vps.sh` snapshots the database and tags the previous image, then rolls back by itself if the health check fails; `scripts/rollback-vps.sh` does it by hand | A rehearsal of a manual rollback on the live server | Medium | P1 |

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
| XSS | Partial (*updated*) | `esc()` used throughout the dashboard. Content-Security-Policy on the dashboard: safe directives enforced, the full policy in report-only mode (batch 2), with reports collected at `/csp-report`. |
| Audit trail | Tested | `audit()` records field names, never values |
| Data retention | Tested | `applyRetention()` covers messages, consents and audit. `email_log` bodies are kept 30 days, records 180. |
| Prompt injection and AI tool permissions | Tested (*updated*) | Booking honesty guard; prices only from the knowledge base; no AI tool can change data without a flow step. Evaluation suite (batch 8) includes prompt-injection, malicious-document and other-customers'-data cases; the real-model run passed 15/15. Automation drafts keep only allowed steps (batch 12). |

Full detail is in `docs/SECURITY_REVIEW.md`.

## Phases 1–7 (summary)

*Updated after batch 15. Details and dates are in `BUILD_PROGRESS.md`.*

| Area | Status | Notes |
|---|---|---|
| Instant website demo ("Business Twin") | Built (batches 1, 10) | What the demo learnt, with source pages; uncertain and missing facts flagged; kept when the demo is claimed. |
| Trades and salon demos | Built (batches 7, 11, 12) | 16 trade templates plus plumber, electrician, heating, handyman, property maintenance, hair, barber, beauty and nails variants. `/examples`: 8 scripted scenarios through the real engine on throwaway sample businesses. |
| Photo-to-quote | Built (batches 7, 9) | Postcode and service-area check, photos attached to the quote request, AI draft, team approval, PDF and accept, one follow-up. |
| Lead qualification | Built (batch 11) | Per-trade questions one at a time, urgent flag, owner-editable. |
| Bookings | Built (batches 11–13) | Overlap-aware times, buffers, staff capacity, customers choose who, per-staff day view, clock-change tests. |
| Follow-up engine | Built (batch 5) | One log of automatic actions, per-customer daily cap, quiet hours; review requests after orders and (batch 15) after visits. |
| Opportunity Radar | Built (batch 3) | Opportunities view with evidence and suggested actions. |
| Owner copilot | Built, read-only (batch 6) | Dashboard and WhatsApp Q&A; actions still go through the normal screens. |
| Natural-language automations | Built (batches 12, 13) | AI draft → allowed steps only → try-out on a throwaway copy → owner approval; change an existing automation the same way. |
| Verified answers | Built (batch 4) | Answer → source and date, stale sources flagged, figure checks. |
| Results dashboard | Built (batch 4) | Verified, attributed, estimated and opportunity figures kept apart. |
| Simple owner mode, onboarding | Built (batches 10, 12) | Grouped menu fitted to the business, "To do now" on Today, 9-step setup guide. |
| Light CRM | Built (batch 15) | Lead board (new, contacted, won, lost) with team-entered values and notes; open and won-this-month totals. |
| Account recovery | Built (batch 13) | Lost-key email link; needs Resend and an account email per business. |
| Voice, Instagram, Messenger, agencies, multi-branch | Missing | Instagram/Messenger researched (`INSTAGRAM_MESSENGER_RESEARCH.md`); needs Meta App Review first. |
| Pricing packaging | Partial | Free/£29/£79/£249 in `PLANS`. The £500 set-up fee is on the marketing site but not charged (needs a business decision). |
| Marketing site | Partial | Server-rendered; pages for takeaways, trades and salons (batch 15), comparisons, examples. The name breaks Meta's trademark rules and must be changed. No fabricated testimonials. |
| UK compliance | Partial | Consent ledger, data requests (export/erasure), retention, legal page templates. Needs legal review. |
| AI evaluations | Built (batch 8) | Recorded suite with model, cost and latency; real-model run 15/15 on the server. |
| Performance benchmarks | Built (batch 10) | Repeatable load test (`scripts/loadtest.js`); results in `END_TO_END_TEST_RESULTS.md`. |
