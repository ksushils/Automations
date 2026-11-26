# Build progress

Read this first when you resume work. Item IDs (R0.1 and so on) are defined in `IMPLEMENTATION_ROADMAP.md`.

## Current state

- **Last batch:** batch 16 (customer outcome tracker and read-only outcomes API for Demo Engine), 23 November 2026 – deployed with approval.
- **Branch:** batches 1–9 are committed and pushed to `origin/main` and `claude/dazzling-darwin-uojvtj`.
- **Deploy:** ✅ **P0 webhook security fix deployed 24 November 2026 with the owner's approval** (server `618fc8f` = reviewed merge `63c9775`; 388/389 tests in the image, 1 skipped; unsigned/forged webhook POSTs refused for all businesses on live; see `P0_WEBHOOK_SECURITY_2026-11-24.md`).
- **Earlier:** batch 16 deployed to wa.karatit.com on 23 November 2026 with the owner's approval** (server commit `6f6604f`; 381/382 tests in the image, 1 skipped; health ok; no merge conflict; `/api/v1/outcomes` answers 401 `unauthorized` without a reporting key, including for admin-style keys; new tables, columns and booking triggers present; no reporting keys created on live businesses; data matches the pre-deploy snapshot – 7 businesses and 931 messages, the 5 fewer than yesterday being unclaimed instant demos that expired overnight and were cleaned up as designed).
- **Earlier:** batch 15 deployed to wa.karatit.com on 22 November 2026** (server commit `6b4ed1b`; 376/377 tests in the image, 1 skipped; health ok; `/trades` and `/salons` live and in the sitemap; new lead and booking columns present; 12 businesses and 1,060 messages unchanged).
- **Earlier:** batch 14 deployed to wa.karatit.com on 22 November 2026** (server commit `c73d241`; 372/373 tests in the image, 1 skipped; health ok; 12 businesses and 1,060 messages unchanged; no live business has WhatsApp connected yet, so no expiry warnings are due).
- **Earlier:** batch 13 deployed to wa.karatit.com on 22 November 2026** (server commit `1e01ed4`; 371/372 tests in the image, 1 skipped; health ok; `/recover` answers honestly that email isn't set up; expired links refused; 12 businesses and 1,060 messages unchanged).
- **Earlier:** batch 12 deployed to wa.karatit.com on 22 November 2026** (server commit `3a1c687`; 366/367 tests in the image, 1 skipped; health ok; `/examples` shows all 8; `bookings.staff` column present; 12 businesses and 1,060 messages unchanged; no business was affected by the Online-shop menu bug).
- **Earlier:** batch 11 deployed to wa.karatit.com on 22 November 2026** (server commit `a565f41`; 354/355 tests in the image, 1 skipped; health ok; `/examples` live with all six scenarios and no sample business left behind; new `chat_leads.answers`/`urgent` columns present; no business had any of the four default-on settings switched off; the 5 live businesses intact – the 2 fewer since batch 10 are unclaimed instant demos that expired and were cleaned up as designed).
- **Earlier:** batch 10 deployed to wa.karatit.com on 22 November 2026** (server commit `e7f0fd2`; 333/334 tests in the image, 1 skipped; health ok; 14 businesses and 1,110 messages intact; `PRAGMA synchronous` = NORMAL live). Batches 1–9 were deployed earlier the same day (server commit `0e50038`), with `scripts/deploy-vps.sh`:
  - **Database snapshots:** taken first, in `/root/wa-backups/predeploy-20261122-*.db`.
  - **Tests:** run inside the Node 22 image.
  - **Health:** `/health` returned `{"ok":true,"jobs":"ok"}`.
  - **Data:** intact (14 businesses).
  - **Rollback:** `sh scripts/rollback-vps.sh`.
- **First deploy attempts:** one merge conflict with the demo-engine branch (`server.js` imports; both kept), and a calendar test that was flaky under load (fixed). The script stopped safely each time before restarting anything.
- **Tests:** 367 of 367 pass locally on Node 24 (batch 16). They run again inside the Node 22 image during the deploy.
- **Real-model AI evaluation on the live server:** 15/15 passed after two fixes (see `END_TO_END_TEST_RESULTS.md`).

## Batch 17 (26 Nov 2026): answer quality, from trying the assistant on real websites

**New tool:** `src/cli/trySite.js <url> ["question" ...]` sets up a throwaway business from any public website, exactly like an instant demo, and prints the conversation. It runs on an in-memory database, with email and alerts blanked, so nothing is sent. It costs about a penny per site.

**Sites tried:** Dishoom, Pimlico Plumbers, Beardbrand, Hershesons, Red Letter Days and travelrise.in. Audley Travel, Bupa and Franco Manca block automated visits; the demo says so and offers a hand set-up, and the bot does not try to get round the block.

**Fixes:**
- **Meaning-based search is now on.** `EMBEDDINGS_MODEL` was empty, so the bot searched by keywords alone, and "puddings" missed the desserts page. With the AI on OpenRouter and no separate key, it now uses the same key with `openai/text-embedding-3-small` (about $0.02 per million words), under the same provider rules (`data_collection: deny`). `EMBEDDINGS_AUTO=false` turns this off. An hourly job (`kb-embeddings`) adds vectors to pages learnt before.
- **Price guard:**
  - an amount the assistant already gave earlier in the chat can be repeated (Hershesons' "free over £45" had been removed);
  - menu prices printed without £ ("Lamb Samosas 8.20") count as known amounts (every Dishoom dessert price had been removed).
- **Handover:** "Would you like me to get someone from the team?" plus [HANDOVER] in the same reply used to hand the chat over without a yes, after which the bot went silent. Now the customer gets Yes / No buttons. A customer who asks for a person or complains is still handed over straight away.
- **One offer, not two:** a reply that already offers to check with the team gets one set of real buttons (Yes, ask the team / Call me back / No, thanks), instead of the AI's own options followed by a second "Sorry I couldn't answer…" message.
- **Prompt:** the bot no longer says the shop "doesn't offer" something its information doesn't mention. It now says it can't see it and offers to check.
- **Labels:** buttons and menu labels are cut at a word ("What dishes do you…", not "What dishes do you h").
- **Tap prompt:** "Tap View products" is no longer shown when there are no products.

**Tests:** `test/answer-quality.test.js` (9 tests). Suite: 384/384.

## Fix (26 Nov 2026): "More options" in the website pop-up

- The pop-up greeting beside the chat button shows only 3 buttons (2 on phones). A business with a longer welcome menu (Travel Rise has 9 options) had the rest hidden until the visitor opened the chat.
- When the menu has more options than fit, the last button is now "☰ More options", which opens the full menu in the chat (`openerConfig().menuTotal`, `chipsShown()` in the widget).
- Test: `test/opener.test.js` (9-option menu: 3 buttons plus More; the full list has all 9; the widget script parses).

## Batch 16: customer outcome tracker for Demo Engine (measurement, not a new chatbot)
- **Audited first:** enquiries, sources, conversations, bookings, quotes, orders and the "verified" money rules already existed. Demo Engine's own `/api/internal` endpoints (on the server branch) manage demo businesses with the super-admin key and have no outcome data. Nothing was rebuilt.
- **Lead stages NEW → CONTACTED → QUALIFIED → WON / LOST:** the Qualified stage is added to the Leads list and Board. Every change is recorded with who made it and when (`lead_events`). A value saved on a lead records `owner_entered`, who entered it and when. Saving "won" together with a value carries the value.
- **Booking timestamps:** `confirmed_at` and `cancelled_at` are set by database triggers, so the chat, the dashboard and the Stripe deposit path all record them.
- **Outcome events** (`src/outcomes.js`): derived from the existing records into an append-only log with a stable `event_id` (dedup) and `seq` (cursor). Re-deriving is idempotent, and the first read backfills up to 400 days. Test and simulator chats are excluded.
- **Data minimisation:** no names, phone numbers, emails, addresses, message text, notes or staff names. Customers appear as a pseudonymous id per business; landing pages lose their query strings.
- **Read-only reporting keys** (`rpt_…`): one per business, created by the owner (dashboard → Leads → "📊 Reporting access") or the platform operator; shown once, stored hashed, revocable, audited, 120 requests a minute. The outcomes API refuses admin, staff and super-admin keys.
- **API v1** at `/api/v1/outcomes`: `GET /schema`, `GET /events?after=&limit=&types=`, `GET /summary?from=&to=`, with JSON errors (`invalid_parameter`, `unauthorized`, `key_revoked`, `tenant_inactive`, `rate_limited`, `not_found`, `internal`). The full contract, blocked items and the tests Demo Engine needs are in `docs/OUTCOMES_API.md`.
- **Money provenance:** `verified_value` = paid orders + completed cash orders + accepted quotes + paid deposits (the same rules as the Results page). Owner-entered values are reported separately and never counted as verified.
- **Not changed:** no messaging permissions, nothing sent to customers, no other repository touched, **not deployed**.
- **Tests:** `test/outcomes.test.js` (5, fixtures only, network calls fail the test). Full suite 367/367. Checked in a browser on a local test copy: Qualified column; key created and shown once; the key reads events and summary.

## Batch 15: lead board (R5 light CRM), review requests after visits, trades and salons pages (R7), audit refresh
- **Lead board** (Leads tab → Board): New · Contacted · Won · Lost columns, each lead with an optional value and notes entered by the team, buttons to move it on, and per-column totals. Above the list: "Open: N worth £X · Won this month: N worth £Y" – from entered values only, never estimated. Additive columns `chat_leads.value`, `notes`, `won_at`; CSV now has Status, Value and Notes. Another business can't change your leads (tested).
- **Review requests after visits:** review requests went out only for delivered orders. Now a booking marked **Done** also gets one (same rules: once per visit, at most one per customer every 30 days across orders and visits, quiet hours, inside the WhatsApp window or with an approved template). Additive columns `bookings.completed_at`, `review_sent_at`, `review_status`. Found while fact-checking the salon page, which would otherwise have claimed something the product didn't do; the batch 12 automation label that said "or a visit is done" is now true as well.
- **Marketing pages** `/trades` and `/salons`: what the product really does for each (taken from built features, each linked to a live example), honest FAQs, no numbers or testimonials (a test checks). In the sitemap and footer.
- **Audit brought up to date** (`PRODUCT_BUILD_AUDIT.md`): the phase summary still said "missing" for things built since batch 3; rollback, CSP and prompt-injection rows corrected.
- **Checked in a browser** (local test copy): board (value saved, moved to Contacted, totals updated, no sideways scroll), `/salons` and `/trades` at phone width.
- **Tests:** `test/pipeline.test.js` (2), visit review requests in `insights.test.js` (1), `test/marketing-pages.test.js` (1). Full suite 362/362 locally.

## Batch 14: access expiry warning (R0.10), site assistant on more pages, Instagram/Messenger research (R5)
- **WhatsApp access expiry warning** (`src/waHealth.js`): the daily connection check now also asks Meta (`debug_token`) when the access token – or its data access – ends. Permanent System User tokens never do; tokens from a personal login do. Within 7 days: state `token_expiring`, a dashboard banner, and **one** email per expiry date ("reconnect in Settings before then"), plus a platform alert. The WhatsApp number card shows "WhatsApp access: doesn't expire" or the end date.
- **Site assistant on more pages:** the site's own chat assistant (when a site-chat business is set) now also appears on `/pricing` and `/examples`; the examples page ends with "Now ask it yourself". **On the live site no site-chat business is set, so it doesn't show yet.**
- **Instagram and Messenger:** researched before building – see `docs/INSTAGRAM_MESSENGER_RESEARCH.md`.
- **Checked in a browser** (local test copy): the Account email card from batch 13 (warning when empty, save, warning gone).
- **Tests:** expiry checks in `test/batch2.test.js` (soonest of the two dates, past dates, one email per date, permanent tokens never warn). Full suite 358/358 locally.

## Batch 13: choose who (R2.3), lost key (R0.13), change an automation (R3.3)
- **Customers choose who** (`src/bookings.js`): after picking a service that two or more staff do, the chat asks "Who would you like?" (Anyone, or a name). The times shown are that person's; the booking summary says "With: Amy" and the booking is recorded with them. If they're fully booked: "Anyone else" or talk to a person. A service only one person does skips the question. Settings → Bookings → "Let customers choose who" (on by default; listed in the default-on switches so Save never turns it off).
- **Day view per member of staff** (Bookings tab, upcoming): a day picker and a table – times down the side, one column per person (plus "Not assigned"), each booking with the customer and whether it still needs confirming. Changing "With" on a booking checks the name is on the staff list.
- **Lost admin key** (`src/recovery.js`; "Lost your key?" on the sign-in page): the owner types their sign-up email and gets a one-time link (30 minutes; only a hash is stored).
  - Same answer whether or not the email is known; the email is sent in the background so the reply time doesn't give it away. Alert addresses (which may be staff) can't recover.
  - Opening the link changes nothing (so email link scanners can't use it up); pressing the button makes a new admin key, shown once. The old key stops working; the Dify tool key and staff keys are untouched. A second email says the key was changed; both steps are in the audit log. Rate-limited.
  - **Needs email (Resend) to be set up on the server** – until then the form says so plainly and the platform operator can reset a key.
  - **Account email** (Billing → "🔑 Account email", owners only): none of the 12 live businesses had a sign-up email recorded (they were set up by hand), so recovery couldn't have reached them. Owners can now set it; changing it emails the old address and is audit-logged; Today shows "Add your account email" until it's set. (Checked in a browser in batch 14.)
- **Change an automation in plain English:** in "Describe an automation", choose "Change ‹name›" and say what to change. The AI gets the current automation and returns the whole updated one, which goes through the same checks and try-out; the draft shows what was added and removed and any trigger-word changes. Approving updates that automation in place (same id, on/off state kept); its own trigger words don't count as a clash.
- **Roadmap correction:** the plan usage page (Billing → "Your usage this month") and the cancellation reason were already built (batches 2 and 6) – R6 is marked accordingly.
- **Tests:** `test/recovery.test.js` (2), staff choice in `booking-edge.test.js` (1), automation change in `auto-draft.test.js` (1), `chooseStaff` in `settings-defaults.test.js`. Full suite 356/356 locally. Checked in a browser on a local test copy: day view (Dan / Raj / Not assigned), changing "With" (saved; unknown name refused), "Lost your key?" (shows the email-not-set-up message).

## Batch 12: automations from plain English (R3.3), "To do now" (R4), named staff (R2.3), more examples (R1.3)
- **Automations from plain English** (`src/autoDraft.js`; Automations tab → "✨ Describe an automation"): the owner writes what they want; the AI (one call) drafts either a chat flow, a change to the built-in follow-ups, or an honest "can't do that here – use Campaigns/…".
  - **Allowed steps only:** message, question, list, tag, hand-over, hand back to the assistant (menu/browse/status/cart), delay (≤ 24 h), go to, end. Webhooks, templates, forms and product ids are removed and listed as problems. **Allowed settings only:** review requests (+ hours), unfinished-basket reminder (shops), appointment reminders and "book again" (bookings on), quote follow-up, lead reminders, per-customer daily cap, quiet hours – numbers kept within limits; "already set" and missing review link flagged.
  - **Checks:** the flow builder's own validation, trigger words that clash with another automation, and everyday words ("hi", "menu", "stop") block approval.
  - **Try-out:** a flow is played through the real engine on a throwaway copy of the business (no WhatsApp, no email, no AI; deleted after) – one run per first choice, shown as chat bubbles; a settings change shows now → after.
  - **Approval:** owners only; checks run again at approval (e.g. a trigger word taken since); the flow then appears in Automations (active) and can be edited or deleted as usual. Drafts are kept (last 20) with who approved and when.
  - Without an AI key: a clear "needs the AI" message. Rate limit 20 drafts an hour.
- **"To do now" on Today** (`src/today.js`, `GET /api/tenants/:id/today`): chats waiting for a person, urgent leads to call, new leads, booking requests to confirm, today's appointments, quotes to price, orders to prepare (shops), open tickets, unanswered questions this week, automation drafts to review – urgent first, each linking to its page; rows only for features the business uses; "All clear" when nothing waits. Staff only see rows for pages they can open.
- **Named staff on bookings:** with staff listed, each booking made in the chat goes to a free member of staff who does that service (the one with fewest bookings that day); a busy stylist no longer leaves a slot "free" for a service only they do. Bookings tab: a "With" column to change it. Additive column `bookings.staff`.
- **More examples on `/examples`:** a hair salon (a full colour booked, given to the stylist who does colour) and an online shop (browse → size → pay on delivery → order, then "order status" answered from the order). 8 scenarios, three sample businesses, all labelled.
- **Fixes found on the way:**
  - Booking overlap check (batch 11) read stored start times ("YYYY-MM-DD HH:MM:SS", UTC) as server-local time – right on the UTC server, wrong elsewhere; now always UTC (test added).
  - The "Online shop" trade template dropped "Browse products" and "Track my order" from the menu for businesses on the built-in catalogue; fixed (test added). Existing menus aren't changed automatically.
- **Tests:** `test/auto-draft.test.js` (5), `test/today.test.js` (3), 3 more in `booking-edge.test.js`, salon/shop checks in `scenarios.test.js`, 1 in `trades.test.js`. Full suite 352/352 locally. Checked in a browser on a local test copy: To do now (and its link), the Automations card with and without AI, a draft with problems listed and two try-out paths, Approve → flow active in the list.

## Batch 11: lead questions (R2.2), demo scenarios (R1.3), booking availability (R2.3), JSON logs (R0.15)
- **Questions one at a time** (`src/qualify.js`): when someone asks for a call back or details, the assistant asks what this trade needs, one short question per message with a Skip – e.g. a plumber: the problem → the postcode → how soon (🚨 Today – urgent / This week); a travel agent: where → when → how many → budget. Up to 4 questions, up to 2 tap-to-answer choices each.
  - An "urgent" choice marks the lead 🚨 Urgent in the team's email, push and WhatsApp alert and on the Leads list. A postcode answer is checked against the areas covered (kind message if outside; the team still gets it).
  - Each answer is saved on its own (`chat_leads.answers`, `urgent`: additive columns) and shown line by line on the Leads list; the message line for CSV/webhooks reads "Job: … · Postcode: … · When: …".
  - Businesses with a trade get its questions automatically, unless the owner wrote their own single question (respected). Owners can write their own list in Settings → Leads ("How soon? | !Today | This week"), or switch back to the single question.
  - A question of the customer's own mid-way sets the form aside and is answered (never stuck in a form).
- **Scripted demo scenarios** (`src/scenarios.js`, public page `/examples`): emergency plumber, photo to quote, outside the area, booking a visit, talk to a person, quote follow-up – each a fixed script played through the real engine, then "what the team gets" (the lead alert, draft quote with photo, booking request, inbox hand-over, follow-up).
  - Runs against a sample business ("Northside Plumbing & Heating", labelled as a sample everywhere) created for the run and deleted straight after, with everything it created.
  - Nothing can leave the server: no WhatsApp number, every reply captured, and a "sample run" guard (`src/sampleRun.js`) that skips email and the AI for the duration. Tested with an AI key switched on: zero network calls. Phone numbers are Ofcom's drama range (07700 900xxx).
  - Results cached for 6 hours; linked from the demo page and the footer; in the sitemap.
- **Booking availability** (`src/bookings.js`): a time is free when fewer bookings overlap it than there are people to do it.
  - Each booking blocks its own service's length (a 2-hour colour at 10:00 also blocks 11:00); optional gap after each visit (`bufferMinutes`).
  - Optional staff list: capacity follows who works that weekday, who's away that date, and who does the chosen service.
  - Tests across both 2027 clock changes (times stay local; the notice period counts real hours); "Today/Tomorrow" labels now use UK time (they used UTC, wrong just after midnight in summer).
  - Settings → Bookings: "Gap after each visit" and "Staff" fields.
- **JSON logs** (`src/log.js`): `LOG_FORMAT=json` turns every log line into one JSON object (time, level, tag, message) plus one line per request (method, path, status, ms, request id; not /health). API keys, bearer tokens, Meta and Stripe secrets are masked; token-like path parts become `:token`; query strings are never logged. Off by default – nothing changes unless the variable is set.
- **Fixes found on the way:**
  - **Settings form switched defaults off:** four yes/no settings the server treats as ON when unset (lead capture, automatic follow-ups, order notes, and *marketing consent required for abandoned-checkout messages*) showed "No" in Settings, so pressing Save turned them off. The form now shows the real default; a test keeps the list in step with the code.
  - Hand-over message said "Your cart is saved" to businesses with no shop – only said now when there is a cart.
  - "And What's your email" → "And what's your email".
  - Deleting a demo business now also clears its email log, answer evidence, automation log and opportunity state.
- **Tests:** `test/qualify.test.js` (5), `test/scenarios.test.js` (4), `test/booking-edge.test.js` (7), `test/json-logs.test.js` (4), `test/settings-defaults.test.js` (1). Full suite 340/340 locally. Checked in a browser on a local test copy: `/examples` (all six, no sideways scroll), Leads list (urgent badge, answers), Settings (ready-made questions shown, own questions saved, defaults showing Yes).

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
