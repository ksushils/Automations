# Security review

**Reviewed:** 22 November 2026, during batch 1.

This review is based on reading the code and on automated tests. It is **not** a penetration test or a certification, and it doesn't claim the product is secure. It records what has been checked and what hasn't.

## How access works

| Who | How they authenticate | Where it's enforced |
|---|---|---|
| Super admin (platform owner) | `SUPER_ADMIN_KEY` (at least 16 characters; several keys allowed during rotation), compared in constant time | `requireSuper` in `src/routes/admin.js` |
| Business owner | Per-business admin key `adm_…` (24 random bytes, stored only as a SHA-256 hash) | `requireTenant`. The key must belong to the `:tenantId` in the address. |
| Staff | Per-person staff key `stf_…` (hashed), role `owner` or `staff` | `requireTenant` sets the role. `requireOwner` blocks staff from owner-only routes. |
| Customers | No login. Web chat is tied to a random session id. Quote, receipt and ticket pages need a random token; ticket status also needs contact verification. | Route handlers |
| Webhooks | Meta: HMAC-SHA256 with the app secret. Stripe: `t=…,v1=…` HMAC within a 300-second window. Store webhooks: a per-business secret in the address. | `src/whatsapp/webhook.js`, `src/payments/stripe.js`, `src/routes/storeWebhooks.js` |

## Proven by tests (`test/isolation.test.js`, added in batch 1)

1. **Static guard.** Every `/tenants/:tenantId/*` route in `admin.js` starts with `requireTenant` or `requireSuper`. A new route without a guard fails the test.
2. **Cross-business keys.** Another business's owner key **and** staff key are refused (401) on **every** business route, for every HTTP method.
3. **IDOR.** Putting another business's ticket number, article id, booking id, order id, lead id, conversation id or customer id into your own address reads nothing and changes nothing. The other business's rows were checked unchanged in the database.
4. **Owner-only routes.** Every `requireOwner` route returns 403 to a staff key: billing, staff management, keys, data export and similar.
5. **Lists.** Leads, tickets, quotes, help articles, orders, bookings, conversations and contacts never include another business's records.
6. **Email and billing visibility** (`test/phase0.test.js`). A business sees only its own email delivery records, without message bodies, and only its own billing history. The platform-wide email log needs the super admin key.

## Other controls already in place (earlier tests)

| Control | Evidence |
|---|---|
| Secrets encrypted at rest; key rotation; old key still decrypts | `privacy.test.js` |
| Audit log records field names, never values | `privacy.test.js` |
| Subject access export and erasure; opt-out kept after erasure | `privacy.test.js` |
| Consent ledger; marketing only with consent | `consent.test.js` |
| Server-side request forgery (SSRF) guard (`isPrivateIp`) on URL import and outgoing hooks | `integrations.test.js`, `knowledge.test.js` |
| Rate limits | `/api` 600/min per IP. Sign-up 5/h. Chat 40/min per IP per business. Instant demo 4/h. Fee checker 10/h. |
| Security headers | nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options DENY on `/admin` and `/api`, HSTS on https |
| Backups encrypted off the server (AES-256-GCM, key from the passphrase via scrypt) | `offsite.test.js`; restore drill in `END_TO_END_TEST_RESULTS.md` |
| `/health` reveals no internal details | `phase0.test.js` |
| JSON logs (`LOG_FORMAT=json`) mask API keys, bearer tokens, Meta and Stripe secrets; token-like path parts become `:token`; query strings are never logged | `json-logs.test.js` |
| Demo scenarios run on a throwaway sample business that can't send anything (no WhatsApp number, replies captured, email and AI skipped during the run) and is deleted after each run | `scenarios.test.js` (zero network calls with an AI key on) |
| Automation drafts from plain English: only allowed steps and settings survive the server checks (no webhooks, templates or messages to people who haven't written in); try-outs run on a throwaway copy that can't send anything; nothing goes live without the owner's approval, re-checked at approval | `auto-draft.test.js` |
| Settings form no longer switches the abandoned-checkout consent rule (and three other default-on settings) off when the owner presses Save | `settings-defaults.test.js` |

## Open findings

| # | Finding | Severity | Plan |
|---|---|---|---|
| S1 | No Content-Security-Policy header. Dashboard XSS protection relies on `esc()` being used correctly everywhere. | Medium | R0.11: add CSP in report-only mode, then enforce |
| S2 | Admin keys are long-lived bearer tokens kept in `localStorage`. If someone injects script into the page (XSS), the key can be read. There's no expiry and no per-device session. | Medium | Consider short-lived sessions after login with the key; CSP (S1) reduces the risk |
| S3 | Rate limits are in memory and per process. They reset on restart and won't be shared if a second instance is added. | Low | Acceptable on a single VPS. Revisit when scaling out. |
| S4 | Prompt injection: no recorded evaluation suite yet. The booking honesty guard and server-side price checks limit the damage, and the AI can't change data except through flow steps. | Medium | R8: evaluation cases for injection attempts and requests for other customers' data |
| S5 | Uploaded files (photos, knowledge files) are only checked by type and size. There's no malware scan. | Low | Files are never run, and are served with nosniff. Document this; add a scan if customers upload documents for others. |
| S6 | No dependency audit tooling. Express is the only dependency, so `npm audit` is enough for now. | Low | Run `npm audit` before each deploy (added to the readiness checklist) |
| S7 | Platform-wide super admin key: whoever holds it can do everything. | Medium | Keep it in a password manager; rotate using the multi-key support. Consider adding a second factor for the super admin. |
| S8 | Email bodies (which may include customer names and details) are now stored for 30 days. | Low | Needed for retries and investigating problems. Purged automatically after 30 days; list it in the privacy notice. |
