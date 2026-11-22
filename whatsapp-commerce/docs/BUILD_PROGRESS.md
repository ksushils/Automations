# Build progress

Read this first when you resume work. Item IDs (R0.1 and so on) are defined in `IMPLEMENTATION_ROADMAP.md`.

## Current state

- **Last batch:** batch 10 (Business Twin, simple menu, load test + SQLite tuning), 22 November 2026.
- **Branch:** batches 1–9 are committed and pushed to `origin/main` and `claude/dazzling-darwin-uojvtj`.
- **Deploy:** ✅ **deployed to wa.karatit.com on 22 November 2026** (server commit `0e50038`), with `scripts/deploy-vps.sh`:
  - **Database snapshots:** taken first, in `/root/wa-backups/predeploy-20261122-*.db`.
  - **Tests:** run inside the Node 22 image.
  - **Health:** `/health` returned `{"ok":true,"jobs":"ok"}`.
  - **Data:** intact (14 businesses).
  - **Rollback:** `sh scripts/rollback-vps.sh`.
- **First deploy attempts:** one merge conflict with the demo-engine branch (`server.js` imports; both kept), and a calendar test that was flaky under load (fixed). The script stopped safely each time before restarting anything.
- **Tests:** 319 of 319 pass locally on Node 24 (batch 10). They run again inside the Node 22 image during the deploy.
- **Real-model AI evaluation on the live server:** 15/15 passed after two fixes (see `END_TO_END_TEST_RESULTS.md`).

## Batch 10: Business Twin (R1.1), simple menu (R4), load test (R8)
- **Business Twin** (`src/businessTwin.js`): "what your assistant learnt about your business", built by fixed rules from the pages and documents it holds (no AI, so nothing invented).
  - Facts: business name, type, phone, email, postcode, opening hours, prices, delivery, returns, booking, areas covered – each with the page it came from (linked).
  - **Uncertain:** several different values (e.g. two phone numbers) – "tell us which one customers should use".
  - **Missing:** says what the assistant does instead (e.g. "won't make up times; offers to pass it to your team").
  - Shown on the instant-demo page under the chat ("What your assistant learnt", with the pages it read) and in the dashboard (Teach my AI → What it knows), with an "Add it" link for missing facts.
  - Endpoints: `GET /try/:token/twin` (only while the demo is ready and unclaimed) and `GET /api/tenants/:id/twin` (owner/staff of that business; covered by the isolation test).
  - Claiming a demo keeps everything it learnt (tested).
- **Simple menu** (dashboard): Today · Conversations · Leads & customers · Bookings & quotes · Teach my AI · Results · Grow · Settings, each with its own row of pages.
  - Fits the business: no Orders/Catalogue for enquiry businesses; a shop sees "Orders & quotes" (Orders first) and Bookings only if switched on. A hidden page you're already on still shows.
  - Staff only see staff pages. Every old page is still there; "Full menu" switches back to the old flat menu (remembered per browser).
  - Checked in a browser on a local test copy (plumber and shop).
- **Load test** (`scripts/loadtest.js`): added the WhatsApp webhook (signed POSTs → acknowledged → fully answered; sends to Meta are caught inside the process, nothing leaves) and `--file` (real database file on disk).
  - Found: with a file database every write waited for the disk – chat replies ~500 ms of our own time. **Fix:** `PRAGMA synchronous = NORMAL` (SQLite's recommended setting with WAL; crash-safe, only the last moment of writes could be lost on a power cut) plus a 5 s `busy_timeout`. `SQLITE_SYNCHRONOUS=FULL` switches back.
  - Result locally: chat reply p50 498 → 174 ms; WhatsApp messages fully answered 40 → 87 per second. Numbers in `END_TO_END_TEST_RESULTS.md`.
- **Tests:** `test/twin.test.js` (3), `test/navigation.test.js` (4), `test/sqlite-settings.test.js` (1), plus twin checks and a page-script parse check in `test/instant-demo.test.js`. Full suite: 319/319 locally.

## Batch 9: photo to quote (R2.1, rest)
- When a quote is requested, photos the customer sent in the same chat in the last 2 days are attached to it (`quotes.photos`, `chatPhotos()` in `src/quotes.js`).
  - Website photos show as thumbnails on the quote.
  - WhatsApp photos open through the dashboard with the login key; they are never public links.
- The AI's description of a photo is shown as "the AI's guess – check the photo yourself". It never sets a price.
- Quotes stay drafts for the team to approve, unless the owner has switched auto-send on.
- The team's alert says how many photos are attached.
- **Tests:** `test/photo-quote.test.js`.

## Batch 8: AI safety guards and the evaluation suite (R8)
- **Price guard** (`guardPrices` in `src/verified.js`, used in `src/ai/direct.js`; switch it off with `settings.ai.blockUnverifiedPrices: false`):
  - Any £/$/€ amount in an AI answer must come from the business's own information.
  - Amounts that count as known:
    - the passages the AI was given;
    - matching products, and every price in a built-in catalogue;
    - the delivery fee, free-delivery threshold and minimum order;
    - items in the basket;
    - a known price × 2–20, or the sum of two known amounts;
    - the customer's own figures (e.g. their budget);
    - tap-to-choose options (budget bands are questions, not price claims).
  - Anything else is removed with its sentence, and the customer is told the team will confirm the price.
  - The answer is recorded with an "Unconfirmed price removed before sending" flag in Verified answers.
- **Emergency notices** (`src/safety.js`, called in the engine before anything else):
  - gas smell or leak → 0800 111 999;
  - carbon monoxide → 0800 111 999 (and 999 if anyone is unwell);
  - medical emergency → 999.
  - Sent by fixed rules whatever the AI says, also during a handover or an AI pause, at most once every 10 minutes per chat.
- **Human requests:** a clear request such as "can I speak to a real person please?" (up to 120 characters) now always hands over. Before, only exact words like "agent" did.
- **Evaluation suite** (`src/evals.js`), 15 cases:
  - **6 "guard" cases must pass even with a deliberately bad AI:** invented price, fake booking, gas emergency, medical emergency, human request, AI provider down.
  - **9 "model" cases:** correct price, missing opening hours, prompt injection, instructions hidden in a document, other customers' data, payment-change request, allergens, Spanish, frustrated customer.
  - Each records pass/fail, what was expected, what was said, the model, tokens, cost and latency.
- **How to run it:** `node src/cli/runEvals.js` (add `--guard-only` to skip the real model). It reads the AI settings, then runs everything in an in-memory database, so no live data or customer is touched. Reports are saved to `data/evals/`.
  - Guard-only run locally: 6/6 passed.
  - **The real-model run is still to do on the server, which has the AI key.**
- **Tests:** `test/evals.test.js`, 4 tests. Every guard case is run against a fake AI giving bad answers.

## Batch 7: trade and beauty templates (R1.2) and service area (R2.1, part)
- **9 specialist templates**, built on the existing trades and salon templates (all 16 originals kept):
  - plumber, electrician, heating engineer, handyman, property maintenance;
  - hair salon, barber, beauty salon, nail salon.
  - Each has its own greeting, menu, the one question to ask, the questions customers ask most, and safety rules:
    - gas and carbon monoxide numbers;
    - "switch off at the consumer unit if safe";
    - Gas Safe / NICEIC / Part P mentioned only if the business's information says so;
    - no firm price without seeing the job;
    - patch tests;
    - no treatment-safety advice.
  - The beauty templates come with typical services ready to edit. Bookings stay off until the owner turns them on.
- **Template detection** now picks the specialist template (e.g. "Smith Plumbing" → plumber, "Kings Barber" → barber).
- **Service area** (`src/serviceArea.js`). Settings → Service area takes postcode areas, districts, ranges or towns (e.g. "SW, SE1, CR0-CR4, Croydon").
  - When a callback request includes a postcode outside those areas, the customer is told honestly that the team will check. Nobody is refused.
  - The postcode and whether it's covered are saved on the lead (`chat_leads.area`) and shown in Opportunities.
  - The areas also go into the AI's instructions.
- **Tests:** `test/batch7.test.js`, 6 tests. The old template-detection test was updated, because the specialist templates now win.

## Batch 6: owner copilot (R3.2) and cancellation feedback (R6)
- **Copilot** (`src/copilot.js`):
  - It answers the owner's everyday questions straight from the records: what happened today, new leads, callbacks, quotes awaiting approval, tomorrow's appointments, complaints, questions the AI couldn't answer, the most common requests, and what to prioritise.
  - **Read-only, and the answers are built by fixed rules** from database queries, so no AI writes the numbers. Anything else gets the list of questions it can answer.
  - **Dashboard:** "Ask about your business" box at the top of Opportunities, for any team member. Every question is audited.
  - **WhatsApp:** the team numbers saved in Settings can ask the same questions (through the existing owner commands). Customers asking the same question get the normal assistant and no business data; this is tested.
- **Cancellation feedback:**
  - The Billing tab has a "Thinking of cancelling?" link. It asks an optional reason (8 choices plus a note) before opening the Stripe billing page. "Skip" is just as prominent, with no pressure tactics.
  - Answers are stored in `churn_feedback`. The platform owner sees them at `GET /api/system/churn` (reasons over 12 months, recent answers, and how many businesses are in each subscription status).
- **Tests:** `test/copilot.test.js`, 5 tests.

## Batch 5: follow-up guard rails (R2.4)
- **Guard rails** (`src/outreach.js`). Every automatic message to a customer goes through one gate:
  - **Off switch:** settings.followUps.enabled = false turns all optional follow-ups off.
  - **No duplicates:** the same follow-up for the same record (order, quote, cart) is never sent twice.
  - **Quiet hours:** default 21:00–08:00 in the business's own time zone. Messages wait and go in the morning.
  - **Daily cap:** at most 2 automatic messages per customer in 24 hours (configurable).
- **Covered so far:** abandoned carts, payment reminders, quote follow-ups, review requests and win-back. Back-in-stock alerts and the 24-hour lead follow-up email are logged but not held back, because the customer asked for them.
- **Log:** every automatic message is recorded in `automation_log` as sent, held back (with the reason) or failed (with the error). Shown in the **Automatic messages** card on the Automations tab; kept 180 days.
- **Bug fixed:** a quote follow-up that failed to send used to be counted as sent (the error was silently swallowed). Now it's logged as failed and not counted.
- **Settings → Automatic follow-ups:** on/off, daily limit, quiet hours.
- **Tests:** `test/outreach.test.js`, 4 tests. The shared test helper switches quiet hours off, so other tests don't depend on the time of day.

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
