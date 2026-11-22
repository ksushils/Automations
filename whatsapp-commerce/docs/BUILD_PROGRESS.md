# Build progress

Read this first when you resume work. Item IDs (R0.1 and so on) are defined in `IMPLEMENTATION_ROADMAP.md`.

## Current state

- **Last batch:** batch 4 (verified answers and the honest results view), 22 November 2026.
- **Branch:** batches 1–4 are committed and pushed to `origin/main` and `claude/dazzling-darwin-uojvtj`.
- **Deploy:** the owner approved deploying ("keep doing all the batches… you can deploy"). The deploy is **not done yet**: since the start of batch 2, the VPS (191.215.46.170) has not answered on SSH or HTTPS, while the rest of the internet works from here.
- **How to deploy:** with `scripts/deploy-vps.sh` on the server. It snapshots the database, runs the tests inside the new image, checks `/health`, and rolls back automatically if anything fails.
- **Tests:** 290 of 290 pass locally on Node 24. They run again inside the Node 22 image during the deploy.
- **Live server:** still on commit `231ae4e`.

## Batch 4: verified answers and the results view (R3.4, R3.5)
- **Verified answers** (`src/verified.js`):
  - Every direct-AI answer is stored with the passages it was given (`answer_evidence` table, kept 90 days).
  - Each source gets a match score. Prices, times, durations and percentages in the answer that aren't in the sources or the product list are flagged ("Figure not in your information").
  - Sources not checked for 90+ days are flagged, and so are answers given with no source at all.
  - Where the owner sees it: Knowledge tab → **Verified answers**. Each answer shows its sources, the matching passage and when the source was last checked. A correction box teaches the assistant via `/teach`.
  - Tested end-to-end with a fake AI server: a made-up "£60" was flagged.
- **Results** (`src/results.js`) show four separate groups:
  - **Verified:** paid orders, completed cash orders, accepted quotes, completed bookings, deposits.
  - **Assisted:** open orders, recovered carts, basket adds, leads, future bookings.
  - **Estimated:** only if the owner enters an average job value. Always labelled ESTIMATE.
  - **Potential:** open quotes that have full prices, and new leads.
  - Every figure carries a "how it's worked out" note and the ids of the records it counts. It's shown at the top of the Analytics tab.
  - New setting: Settings → Results → average job value.
- **API:** `GET /tenants/:id/answers` (with `?flagged=1` for answers that need checking), `GET /tenants/:id/results` (with `?month=YYYY-MM`).
- **Tests:** `test/batch4.test.js`, 5 tests.

## Batch 3: Opportunities (R3.1)
- **Opportunities** tab (`src/opportunities.js`). It is built only from the business's own records:
  - callbacks and detail requests nobody has handled yet (after 15 minutes);
  - customers waiting for a person;
  - quotes waiting for approval, or sent more than 2 days ago with no answer;
  - booking requests not yet confirmed, and cancelled future slots that are free again;
  - questions the assistant couldn't answer (grouped into one item);
  - tickets with no reply after 8 hours;
  - customers who seemed unhappy in the last 3 days;
  - orders waiting for payment for more than an hour.
- Each item shows its evidence, the customer, how long ago it happened, the next step and action buttons:
  - view chat, call, mark as contacted, confirm booking, or open the related tab;
  - done, snooze, or reopen (stored in `opportunity_state`, and audited).
- A value appears only when the record has one: a fully priced quote's total or an order's subtotal. Nothing is predicted.
- **Tests:** `test/opportunities.test.js`, 3 tests. Checked in the browser, including the "Mark as contacted" button and phone width.

## Batch 2: Phase 0 continued (R0.8 code, R0.10, R0.11, R0.12, R0.14)
- **WhatsApp connection health** (`src/waHealth.js`):
  - A daily Meta check for each connected business, reduced to one plain state: ok, token_invalid, disconnected, name_declined, quality_low, approval_pending, check_failed or not_connected.
  - One failed call to Meta is tolerated; three in a row are reported.
  - Moving into a problem state emails the owner and alerts the platform owner. Recovery sends a "working again" email.
  - A dashboard banner shows while there's a problem.
- **Plan limits and usage** (`src/entitlements.js`):
  - The Billing tab now has a "Your usage this month" card: what's included, what's used, and what happens if you go over. Meta and payment fees are shown separately.
  - Staff seats are now limited per plan: Free 1, Starter 3, Growth 10, Managed 25. The limit is enforced on the server. **Business decision:** these numbers can be changed in `PLANS`.
- **Resend webhook** (`POST /webhooks/resend`, signed with Svix):
  - delivered, bounced and complained events are recorded on the email's entry;
  - addresses that bounced (in the last 90 days) or complained (ever) are not mailed again.
- **Dashboard security header (CSP):** safe directives are enforced on `/admin`. A full policy runs in report-only mode, with reports counted at `/csp-report` and shown in System health.
- **Deploy scripts:** `scripts/deploy-vps.sh` (safe deploy with automatic rollback) and `scripts/rollback-vps.sh`.
- **Auto-setup fix:** the "Create automatically" Stripe setup now listens to the invoice and trial events, and tops up webhooks created by older versions.
- **Tests:** `test/batch2.test.js`, 10 tests.

## Batch 1: Phase 0 reliability and billing

### Features built
| ID | What | Files |
|---|---|---|
| R0.1 | Every email is recorded in `email_log` with status `sent`, `retrying`, `failed` or `skipped`. Temporary errors (network, 408, 429, 5xx) are retried after 1, 5, 30, 120 and 360 minutes. Permanent errors are marked failed and send an alert. The platform owner can retry by hand. Bodies are kept 30 days, records 180. Each send carries an idempotency key, so the provider never delivers the same email twice. Each email is tagged transactional, marketing or system, plus a topic. | `src/email.js`, `src/db.js` |
| R0.2 | Stripe webhook: each event id is handled once (`billing_events`). A late, older subscription update can't overwrite a newer one (`tenants.billing_event_at`). Handling runs in a transaction, so a failure records nothing and Stripe retries. Malformed bodies get a 400. If checkout completes after the trial subscription event, the trial status is kept. | `src/platform.js` |
| R0.3 | `invoice.payment_failed` starts the grace period and emails the owner once. `enforceGracePeriods` (hourly) pauses the assistant after `BILLING_GRACE_DAYS` (default 7). A later "still past_due" update can't switch it back on. `invoice.paid` turns it back on and says so. Trial-ending, "will end" and "has ended" emails are sent. The dashboard banner counts down the grace days. | `src/platform.js`, `src/jobs.js` |
| R0.4 | Every background job runs through `track()`: runs, failures in a row, last error, stale detection, and an alert after 3 failures. A daily `PRAGMA quick_check` sends an alert if it fails. `/health` returns `{ ok, jobs: 'ok' or 'degraded' }`. System status now includes jobs, the integrity result, email counts, the last billing webhook and whether email and alerts are configured. The last local backup result is stored. | `src/ops.js`, `src/jobs.js`, `src/server.js` |
| R0.5 | Tenant isolation tests (see the Security section). | `test/isolation.test.js` |
| R0.6 | Restore drill on the local database copy: backup → AES-256-GCM seal → `restoreBackup.js` → same tenant and message counts, `integrity_check` = ok. | Results in `END_TO_END_TEST_RESULTS.md` |

### UI changes
- **Super admin, Clients page:** new **System health** card. It shows job state, the database check, missing email, alert or off-server backup setup, 7-day email counts, the last billing webhook, uptime, memory and stuck messages. A table lists undelivered emails, each with a **Retry** button.
- **Owner, Billing tab:** a **payment problem** notice showing the grace end date; **billing history** in plain words; **Emails sent for you** with each email's delivery status.
- **Fix:** the partners box on the Clients page threw an error if you moved to another page before it loaded.
- Both new screens were checked in the browser against a local server with no console errors from the new code.

### New API routes
| Route | Who can use it |
|---|---|
| `GET /api/tenants/:id/email-log` | Owner only; status only, never message bodies |
| `GET /api/tenants/:id/billing` | Owner; now also returns `history` |
| `GET /api/system/email-log?status=` | Super admin |
| `POST /api/system/email-log/:id/retry` | Super admin |

### Database changes
All additive and applied automatically on start:
- **New tables:** `email_log` (with indexes on status and tenant), `billing_events`.
- **New columns:** `tenants.billing_event_at` (INTEGER), `tenants.payment_failed_at` (TEXT).
- **Rollback:** the old code ignores the new tables and columns, so redeploying the previous commit is safe.

### Config
- New: `BILLING_GRACE_DAYS` (default 7).

### Tests added
| File | Tests | Covers |
|---|---|---|
| `test/phase0.test.js` | 16 | Email delivered, retried, failed with alert, out of retries, skipped and recorded, purge, per-business email log visibility. Billing: event replay, out-of-order updates, trial then checkout, failed → grace → paused → paid, trial-ending and cancellation emails, unknown business, malformed body, owner-only history. Jobs: failure count, alert, recovery, stale. `/health` hides internal details; integrity check. |
| `test/isolation.test.js` | 5 | Static route guard; another business's owner and staff keys refused on every business route (all methods); IDOR on tickets, articles, bookings, orders, leads, conversations and customer profiles; quote numbers; staff refused on every owner-only route. |

### Not done or not verified
- Nothing in this batch has run against **real** Stripe or Resend: there are no keys yet.
- Off-server backups are still not configured on live.
- No live restore drill yet.
- The alert webhook isn't set on live, so alerts only go to the container logs.

## Next batch

See "Recommended next batch" in `IMPLEMENTATION_ROADMAP.md`: R0.10, R0.12, the code part of R0.8, R0.11, R0.14, then R3.1.
