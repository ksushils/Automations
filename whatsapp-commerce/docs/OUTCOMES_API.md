# Customer outcomes API (for Demo Engine) – v1

**Status:**
- Built and tested on `main` (23 November 2026).
- **Not deployed:** deploying needs the owner's approval.
- **Code:** `src/outcomes.js` (events, summary, keys, API) and `src/leads.js` (lead stages, history, value provenance).
- **Tests:** `test/outcomes.test.js`.

## 1. What already existed (audited first, not rebuilt)

| Need | Already in WhatsApp Commerce | Used by this API |
|---|---|---|
| New enquiries | `chat_leads` (call-back / details requests from website chat and WhatsApp) | yes – `enquiry.created` |
| Enquiry source | `chat_leads.source` (UTM tags and page), `customers.source` (Click-to-WhatsApp ad referral), `chat_leads.page` | yes – `source` on events |
| Conversations | `messages` (in/out, per customer chat id; staff replies carry `staff`) | yes – `conversation.*` |
| Response times | Message timestamps; `chat_leads.contacted_at`; `leadSpeed()` on the dashboard | yes – derived |
| Bookings | `bookings` (requested / confirmed / completed / cancelled / no-show, deposits) | yes – `booking.*` |
| Quotes | `quotes` (created, `sent_at`, `accepted_at`, total) | yes – `quote.*` |
| Orders | `orders` (subtotal, `payment_status`, `paid_at`, Stripe session, cash on delivery) | yes – `order.*` |
| Verified value rules | `src/results.js`: paid orders, completed cash orders, accepted quotes, paid deposits | same rules |
| Lead stages | New / Contacted / Won / Lost with value and notes (batch 15) | extended (below) |
| Demo Engine's own endpoints | `/api/internal/*` (demo businesses, documents, conversion) – on the server branch, super-admin key | **not** used for outcomes |

**Added only what was missing:**
- **Lead stages:** a **QUALIFIED** stage, with `qualified_at` and `closed_at`.
- **Lead history:** every stage or value change is recorded with who made it and when (`lead_events`).
- **Value provenance** on leads: `value_source = owner_entered`, `value_set_by` and `value_set_at`.
- **Booking timestamps:** `confirmed_at` and `cancelled_at` are now recorded on bookings. Database triggers set them, so every route is covered: the chat, the dashboard and the Stripe deposit webhook.
- **An append-only event log** (`outcome_events`), derived from the records above.
- **Read-only reporting keys** (`reporting_keys`).

All schema changes are additive, and no existing data is changed.

**There is no second CRM.** The records stay the source of truth. Events are derived from them, and re-deriving is idempotent.

## 2. Authentication and permissions

- **One reporting key per business, read-only:** `Authorization: Bearer rpt_<43 characters>`.
- **The key decides the business.** No business id is taken from the URL or the query, so a key for business A can never read business B.
- **Created by the business owner,** or by the platform operator on the owner's behalf (audited), in one of two ways:
  - in the dashboard: Leads & customers → Leads → "📊 Reporting access" → "Create a reporting key";
  - through the API: `POST /api/tenants/:tenantId/reporting-keys` with `{ "label": "Demo Engine" }`.
    - Only the owner key or the super-admin key is accepted; staff keys get **403**.
    - The response is **201** `{ "id", "key", "note" }`, and the key is **shown once**. Only its SHA-256 hash is stored.
- **Listing and revoking:**
  - `GET /api/tenants/:tenantId/reporting-keys` lists keys with label, created by, created at, last used and revoked.
  - `DELETE /api/tenants/:tenantId/reporting-keys/:keyId` revokes a key immediately.
- **Keys not accepted here:** the outcomes API does **not** accept admin, staff or super-admin keys (least privilege). A revoked key gets `401 key_revoked`.
- **Audit log:** key creation, revocation and the first use each day are recorded (`reporting_key.created`, `reporting_key.revoked`, `outcomes.read`).
- **Rate limit:** 120 requests a minute per key. Over the limit you get `429 rate_limited` with `Retry-After: 60`.

## 3. Endpoints (base `https://<host>/api/v1/outcomes`)

Every response includes the headers `X-Outcomes-Version: 1` and `Cache-Control: no-store`.

### `GET /schema`
Returns the event types, the lead stages and the provenance values:
```json
{ "version": 1, "tenant": "<business id>", "event_types": { "enquiry.created": "…", … },
  "lead_statuses": ["new","contacted","qualified","won","lost"],
  "provenance": ["payment_recorded","cash_completed","customer_accepted","deposit_paid","quoted","order_total","owner_entered"] }
```

### `GET /events?after=<seq>&limit=<1..500>&types=<a,b>`
- **What it returns:** events oldest first, after the cursor.
- **Where to start:** `after=0`.
- **How to page:** store `next_after` and call again while `has_more` is true.
```json
{ "version": 1, "tenant": "…", "events": [ { "seq": 41, "event_id": "lead_12.status.7", "type": "lead.status_changed",
    "version": 1, "occurred_at": "2026-11-22T10:15:03.000Z", "recorded_at": "2026-11-22T10:20:00.123Z",
    "subject": { "type": "lead", "id": "lead_12" }, "customer": "c_3f9a…", "channel": "whatsapp", "source": null,
    "data": { "from": "qualified", "to": "won", "actor": "owner", "value": 450, "currency": "GBP", "provenance": "owner_entered" } } ],
  "next_after": 41, "has_more": false }
```

### `GET /summary?from=YYYY-MM-DD&to=YYYY-MM-DD`
- **Date range:** UTC dates, inclusive. The default is the last 30 days; the maximum is 366 days.
- **What it returns:**
  - **Enquiries:** total, split by channel and by source type, with the number of urgent ones.
  - **Conversations started,** by channel.
  - **Response times:**
    - median seconds to the first reply;
    - how many first replies came from the assistant and how many from staff;
    - median minutes from a new lead to its first stage change.
  - **Leads:** qualified, won and lost, plus the owner-entered value of won leads.
  - **Bookings:** requested, confirmed, completed and cancelled, plus the value of deposits paid.
  - **Quotes:** requested, sent (with value) and accepted (with value).
  - **Orders:** created, paid and cash-completed, each with value.
  - **`verified_value`:** see "Provenance" below.

### Errors

The body is always `{ "error": { "code", "message" } }`.

| Status | code | When |
|---|---|---|
| 400 | `invalid_parameter` | Bad `after`, `limit` or `types`; `from` is after `to`; or the range is over 366 days |
| 401 | `unauthorized` | No key, or not a reporting key (admin, staff and super-admin keys are refused) |
| 401 | `key_revoked` | The business revoked the key |
| 403 | `tenant_inactive` | The business is switched off |
| 404 | `not_found` | Unknown path |
| 429 | `rate_limited` | More than 120 requests a minute for this key |
| 500 | `internal` | Unexpected; safe to retry |

## 4. Events

| type | subject | data (no personal details) |
|---|---|---|
| `enquiry.created` | lead | `kind` (callback/details), `urgent`, `answered_questions` (count), `area_covered` (true/false/null) |
| `lead.status_changed` | lead | `from`, `to` (new/contacted/qualified/won/lost), `actor` (owner/staff/platform/system/unknown); for `to: won`: `value`, `currency`, `provenance`; `backfilled: true` when the change happened before history was kept |
| `lead.value_set` | lead | `value` (null = cleared), `currency`, `provenance: owner_entered`, `actor` |
| `conversation.started` | conversation | – (a customer message after ≥ 24 h of silence) |
| `conversation.first_response` | conversation | `responder` (assistant/staff), `seconds` |
| `booking.requested` / `.confirmed` / `.completed` / `.cancelled` | booking | `service`, `starts_at`, `with_deposit`; confirmed with a paid deposit adds `value` and `provenance: deposit_paid`; cancelled adds `no_show` |
| `quote.requested` / `.sent` / `.accepted` | quote | requested: `with_photos`; sent: `value`, `provenance: quoted`; accepted: `value`, `provenance: customer_accepted` |
| `order.created` / `.paid` / `.completed` | order | created: `value`, `provenance: order_total`, `fulfilment`, `payment_method`, `recovered_cart`, `external_store`; paid: `provenance: payment_recorded`, `method` (card or the method recorded); completed (cash on delivery): `provenance: cash_completed` |

**Common fields:**
- `event_id` – stable and unique per business; this is the **dedup key**.
- `seq` – monotonic per server; this is the **cursor**.
- `occurred_at` – when it happened, in UTC.
- `recorded_at` – when the event log first saw it.
- `customer` – a pseudonymous id, `c_` plus 20 hex characters. It is the same customer across events for one business, can't be turned back into a phone number, and differs between businesses.
- `channel` – `website` or `whatsapp`.
- `source` – where the customer came from:
  - `type`: `ctwa_ad`, `utm`, `direct` or `unknown`;
  - `ad_id` for Click-to-WhatsApp ads;
  - the `utm_*` fields;
  - `landing_page`, as origin and path only, with the query string removed.

## 5. Dedup, ordering and backfill

- **Events are never edited or deleted** (append-only). New facts become new events: a reopened lead is a new `lead.status_changed`, and a corrected value is a new `lead.value_set`.
- **Consumers should upsert by `event_id`** and keep `next_after` as their cursor. Re-reading the same page is harmless.
- **Ordering:** `seq` follows the time events were first recorded. When history is first backfilled, events are written oldest first. If you need event time, use `occurred_at`.
- **The first call for a business backfills** up to 400 days from the existing records. A lead that was moved before history was kept appears once, with `backfilled: true` and actor `unknown`.
- **Test traffic is excluded:**
  - the test-bot simulator;
  - automatic answer checks (`qa:`);
  - sample and demo-scenario runs.

## 6. Data minimisation

**Never included:**
- customer names, phone numbers, emails or addresses;
- message text;
- free-text answers and notes;
- quote request text;
- order items;
- staff names (staff changes show as `actor: "staff"`);
- page query strings.

**What is included:** counts, timestamps, stages, money values with their provenance, service names, pseudonymous customer ids and source attribution. A test checks fixture names, phone numbers, emails, addresses and message text never appear.

## 7. Provenance and "verified"

| provenance | Meaning | Counted in `verified_value` |
|---|---|---|
| `payment_recorded` | Order marked paid (card through Stripe, or marked paid by the business) | yes |
| `cash_completed` | Cash-on-delivery order completed | yes |
| `customer_accepted` | Quote accepted by the customer online (agreed, may not be paid yet) | yes (same rule as the Results page) |
| `deposit_paid` | Booking deposit paid through Stripe | yes |
| `quoted` | Quote sent | no |
| `order_total` | Order placed, not paid | no |
| `owner_entered` | Value typed on a lead by the business | **no** – reported separately as `leads.won_value_owner_entered` |

## 8. Blocked or not available

- **Not deployed.** The live server doesn't have this yet; deploying needs approval.
- **No payment data on the live server yet.** Stripe isn't configured there and no business is paying, so `payment_recorded` and `deposit_paid` will be empty until it is.
- **No WhatsApp conversations on the live server yet.** No business has a WhatsApp number connected, so the conversation and response-time figures will come from website chat only for now.
- **External shop orders (Shopify/WooCommerce)** only appear here when they were created in the chat (`external_store: true`). Orders placed directly in the shop aren't visible.
- **No push webhooks.** Demo Engine polls `/events`. Signed push delivery could be added later on the existing hook signing.
- **Not exposed:** ad spend, cost per lead and revenue attribution beyond the source of the first touch. Those belong to Demo Engine's own ad data; this API only gives each event's source.
- **No change to messaging permissions,** and this API sends nothing to customers.

## 9. Integration tests

**On this side (`test/outcomes.test.js`, fixtures only):**
- No WhatsApp credentials are used, and any outside network call fails the test.
- The tests cover:
  - stage changes, with the value saved together with "won";
  - data minimisation;
  - stable ids and the cursor;
  - the summary figures;
  - authentication and permissions: admin, staff and super-admin keys refused; one business per key; revocation; an inactive business; errors; the rate limit; the audit log.
- The existing isolation test covers the new `/reporting-keys` routes.

**Tests Demo Engine needs on its side,** against a test server with a fixture business:
1. Pages through `/events` from `after=0` until `has_more` is false. It must store `next_after` and get the same set when it re-reads.
2. Upserts by `event_id`: replaying a page creates no duplicates.
3. Handles `401 key_revoked` by stopping that business and flagging it to the operator. It must not retry with any other key.
4. Handles `429` by backing off for the `Retry-After` time. Handles `500` by retrying with back-off.
5. Never asks for, or stores, personal details. Its only customer reference is the `customer` pseudonym.
6. Keeps `owner_entered` values separate from `verified_value` in any report.
7. Treats unknown event `type`s and new `data` fields as additive within v1, and ignores them safely. Breaking changes will come as `/api/v2`.
