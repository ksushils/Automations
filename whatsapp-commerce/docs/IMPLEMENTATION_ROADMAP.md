# Implementation roadmap

Items are in priority order. Each one has an ID so `BUILD_PROGRESS.md` can refer to it.

**Status values:** ✅ done (tested) · 🟡 partly done · ⏳ next · 🔒 blocked on an outside dependency (see `MANUAL_ACTIONS_REQUIRED.md`) · ⬜ not started.

Rules that apply to every item:
- **Schema:** only add tables or columns; never drop or reset anything.
- **Tests:** every item gets tests.
- **Feature flags:** risky features stay switched off until tested.
- **Deploys:** never without the owner's approval.

## Phase 0: production readiness (do first)

| ID | Item | Status |
|---|---|---|
| R0.1 | Email delivery records, retries with back-off, failure alerts, manual retry, purge | ✅ batch 1 |
| R0.2 | Stripe webhook: idempotency, out-of-order protection, rollback if handling fails | ✅ batch 1 |
| R0.3 | Failed payment → 7-day grace → pause → recovery; trial-ending and cancellation emails; billing history in the dashboard | ✅ batch 1 |
| R0.4 | Background job health (failures, stale jobs, alerts), daily database integrity check, `/health` shows job state | ✅ batch 1 |
| R0.5 | Tenant isolation tests: cross-business keys, IDOR, owner vs staff, static route guard | ✅ batch 1 |
| R0.6 | Restore drill (local) | ✅ batch 1. Live drill 🔒 (needs a bucket) |
| R0.7 | Stripe test-mode end-to-end with the Stripe CLI (`stripe listen`, `stripe trigger`) | 🔒 needs test keys |
| R0.8 | Resend live check: verified domain, test send, bounce webhook → `email_log` | 🔒 needs key and domain. The bounce webhook itself is ⏳ buildable now. |
| R0.9 | Decide on SQLite and in-process jobs: **keep for now**. Revisit at about 50 active businesses, or if the job queue lags (overdue jobs > 0 for 10+ min) or `SQLITE_BUSY` errors appear. Move to a durable job table before a second process is added. | ✅ decision recorded |
| R0.10 | WhatsApp connection health: daily token/number check per business, owner alert on expiry or disconnection, "approval pending" status | ⏳ next |
| R0.11 | Content-Security-Policy header for the dashboard and public pages (report-only first) | ⏳ |
| R0.12 | Entitlement audit: list every plan-gated feature and prove each is enforced on the server (campaigns, seats, knowledge docs, WhatsApp, badge) | ⏳ |
| R0.13 | Key recovery for owners (email a one-time link to reset the admin key) | ⏳ (works fully once email is live) |
| R0.14 | Scripted rollback (`docs/DEPLOY.md`: restore the pre-deploy snapshot, check out the previous commit) | ⏳ |
| R0.15 | Structured JSON logs (opt-in env flag) | ⬜ |
| R0.16 | Rename the product away from "WhatsApp…" (Meta trademark) | 🔒 business decision |

## Phase 1: sales demo

| ID | Item | Status |
|---|---|---|
| R1.1 | Business Twin: show what was learnt, with source pages; flag uncertain or missing facts; real progress steps; keep the approved configuration when the demo is claimed | ⬜ |
| R1.2 | Trade variants (plumber, electrician, heating, handyman, property maintenance) and beauty variants (hair, barber, beauty, nails) on top of the existing templates | ⬜ |
| R1.3 | Scripted demo scenarios (emergency plumber, photo, quote, service area, booking, human, follow-up) running through the real engine, with sample data labelled as such | ⬜ |

## Phase 2: AI receptionist

| ID | Item | Status |
|---|---|---|
| R2.1 | Photo-to-quote: link the photo to the quote request; postcode and service-area check; urgency; owner approval by default | ⬜ |
| R2.2 | Per-trade qualification rules (one question at a time) | ⬜ |
| R2.3 | Booking: tests across the daylight-saving change, configurable buffers, staff or resource availability | ⬜ |
| R2.4 | Follow-up engine: one log of automatic actions, a per-customer cap, quiet hours | ⬜ |

## Phase 3: owner experience

| ID | Item | Status |
|---|---|---|
| R3.1 | **Opportunities** view: un-quoted requests, unanswered callbacks, unfinished bookings, gaps in the assistant's knowledge. Each shows its evidence and suggested actions. | ⬜ |
| R3.2 | Owner copilot in the dashboard and owner WhatsApp: read-only answers straight away; any action needs confirmation; everything logged | ⬜ |
| R3.3 | Natural-language automation drafts → checked against a fixed list of allowed steps → simulation → approval | ⬜ |
| R3.4 | Verified answers: owner can see each answer's source and date; stale sources flagged | ⬜ |
| R3.5 | Results dashboard: verified, attributed, estimated and opportunity figures kept apart, each traceable to its records | ⬜ |

## Phases 4–7

| ID | Item |
|---|---|
| R4 | Simple owner navigation; industry-aware dashboard; UX polish; first-run onboarding checklist |
| R5 | Voice receptionist (compare providers first); Instagram and Messenger; light CRM pipeline; Zapier/Make/n8n; agency mode; multi-branch |
| R6 | Plan entitlements made clear; usage page; optional setup fee; cancellation flow with a churn reason |
| R7 | Marketing site repositioned (receptionist and sales assistant), trades/salon/ecommerce pages, no made-up claims, real case studies only |
| R8 | AI evaluation suite (model, cost, latency, evidence recorded); repeatable load tests and benchmarks |

## Recommended next batch (batch 2)

These need no outside credentials:
1. **R0.10:** WhatsApp connection health checks and owner alerts.
2. **R0.12:** entitlement audit and tests.
3. **R0.8 (code part):** Resend bounce/complaint webhook (signature checked) → `email_log`.
4. **R0.11:** Content-Security-Policy, report-only first.
5. **R0.14:** rollback script.
6. **R3.1:** Opportunities view. It's high-value, and the data it needs already exists.
