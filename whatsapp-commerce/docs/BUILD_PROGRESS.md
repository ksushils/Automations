# Build progress

Read this first when you resume work. Item IDs (R0.1 and so on) are defined in `IMPLEMENTATION_ROADMAP.md`.

## Current state

- **Last batch:** batch 1 (Phase 0: reliability and billing), 22 November 2026.
- **Branch:** work is committed locally in the worktree on `main`. **Not pushed and not deployed.** Deploy only after the owner approves; the steps are in `docs/DEPLOY.md`.
- **Tests:** 272 of 272 pass locally on Node 24 (`node --test test/*.test.js`). The server image runs Node 22 and should be re-tested there before deploying.
- **Live server:** still on commit `231ae4e`, without this batch.

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
