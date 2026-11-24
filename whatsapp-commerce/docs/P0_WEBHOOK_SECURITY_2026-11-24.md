# P0: WhatsApp webhook authentication and source recovery – 24 November 2026

**Status:** ✅ **Fixed in production on 24 November 2026**, with the owner's approval, at server commit `618fc8f`.
- The deployed code is identical to the reviewed merge `63c9775` (tree `ae4cb7d`).
- 388 of 389 tests passed inside the image (1 skipped).
- Health check ok; data matches the pre-deploy snapshot (5 businesses, 894 messages).
- On the live site, all 5 businesses refuse unsigned and forged webhook POSTs (403), and so does the app-level URL. Rejections are logged with business, reason and IP only.
- The first deploy attempt was delayed about 2 hours by a network outage (no SSH, HTTPS or ping). The machine itself stayed up; the owner restarted it from Hostinger.

## 1. Root cause

`verifyMetaSignature()` in `src/crypto.js` began with:

```js
if (!appSecret) return true; // signature check disabled for this tenant
```

**What that allowed:**
- The per-business route `POST /webhooks/whatsapp/:tenantId` passes the business's own app secret. When none was set, **any** POST was accepted and run through `processWebhookBody()`.
- That meant: messages stored, customers created or updated, leads and orders possible, the chat engine run, and AI calls made.
- The business was taken from the URL, never matched against the phone number in the body, so any business could be targeted.
- Business ids are public: they appear in each website's chat-widget address.

**Not affected:** the app-level route `POST /webhooks/whatsapp` already refused requests when the platform app secret was missing.

**Exposure found on production (read-only check):**
- All 5 real businesses were vulnerable. None had an app secret, and the platform Meta app secret isn't set.
- None has a WhatsApp number connected, so no WhatsApp reply could be sent.
- **No sign of use:** there are no inbound webhook messages recorded for any business. A forged request would have stored one before processing.

## 2. Patch

**`src/crypto.js`:**
- Fails closed: no secret (or one under 8 characters), no raw `Buffer` body, or a missing or malformed header gives `false`.
- HMAC-SHA256 of the exact raw body.
- Constant-time comparison of the decoded 32-byte digests.

**`src/whatsapp/webhook.js`:**
- **Secret used:** the business's own app secret, else the platform app's (numbers connected through Embedded Signup).
- **Responses:**
  - no secret available → **403**;
  - no raw JSON body → **400**;
  - missing signature → **401**;
  - invalid signature → **401**.
- **Order of work:** nothing is stored or processed before verification passes.
- **Per-business URL (every HTTP request):**
  - only processes changes for that business's own `phone_number_id`, or its WABA for events without a number;
  - so a genuinely signed event for another business replayed into this URL changes nothing.
- **App-level URL:** routes by `phone_number_id`, and uses the WABA id only when the event has no number. Inactive businesses are skipped.
- **Trusted internal calls** to `processWebhookBody()` (tests, Demo Engine's forward test) keep their old behaviour; only HTTP requests use the strict rule.
- **GET** is only the verification handshake. It needs a non-empty configured verify token and never processes events.
- **Duplicates:** the existing unique index on `(tenant_id, wa_message_id)` for inbound messages, so a retried event is stored and answered once (tested).
- **Logging:** a rejection logs the business id, reason and IP only, never the body, the header or a secret, and at most once a minute per reason.

**Acceptance tests:** `test/webhook-security.test.js` – 7 tests over real HTTP. They use no WhatsApp credentials: Graph API calls are answered locally and any other outside call fails. **4 of them fail on the old code.**

| Required test | Covered by |
|---|---|
| Valid signatures | business secret (processed, reply sent); platform secret |
| Invalid signatures | wrong secret, another business's secret, other body, altered digest, wrong algorithm, malformed |
| Missing signatures | missing and empty header → 401, nothing stored |
| Missing tenant app secrets | 403, nothing stored or sent, nothing logged from the message |
| Incorrect tenant secrets | another business's secret → 401 |
| Raw-body parsing | pretty-printed bytes verified as sent; a re-serialised signature refused; non-JSON → 400 |
| Duplicate webhooks | same event twice: stored once, one reply |
| Cross-tenant isolation | replay into another business's URL; unknown number; inactive and unknown business |
| Legitimate workflows | full suite (374 on main, 389 merged); load test: 20/20 signed WhatsApp chats answered |
| Leads, bookings, orders | existing tests unchanged and passing |
| Deployment and rollback | `deploy-vps.sh` runs the suite inside the image and rolls back on a failed health check; both scripts parse (`sh -n`) |

## 3. Production compared with Git

**Production:**
- `/opt/whatsapp-commerce`, branch `demo-engine-internal-endpoints`, at `6f6604f`.
- Clean working tree: there are no uncommitted changes.
- The running image was built from that commit (23 Nov 15:21 UTC).

**The "84 commits behind" was the server's local `main` ref:**
- `1608ada`, 86 behind; the server's `claude/dazzling-darwin-uojvtj` ref is 87 behind.
- Neither is deployed; both were left behind when the server switched branches on 14 November.
- The deployed branch contains everything on `origin/main` except the newest docs commit (`a2fb0d2`) and this fix.

**Server-only code** (never pushed to GitHub): 4 commits by the Demo Engine session, touching 6 files:
- `src/routes/internal.js`
- `src/demoTenants.js`
- `src/whatsapp/webhook.js` (inbound forward)
- `src/server.js`
- `src/db.js` (one secret field)
- `test/internal.test.js`

The other 60 commits ahead of `origin/main` are deploy merge commits.

**Ignored on the server and never committed:** `.env`, `data/` and `docker-compose.vps.yml`. No secret file appears anywhere in Git history.

## 4. Preservation and reconciliation

**Snapshots** in `/root/wa-backups/p0-20261124-110334/` (folder mode 700):
- `source-all.bundle` – every branch; `git bundle verify` passed;
- `production.db` – taken with `VACUUM INTO`;
- `env.copy` and `docker-compose.vps.yml` (mode 600);
- `PRODUCTION_HEAD`, `branches.txt` and `SHA256SUMS`.

**Other copies:**
- Git tag `prod-snapshot-20261124-110334` and Docker tag `whatsapp-commerce:prod-6f6604f` on the server.
- Off-server: the bundle (code only, sha256 `69d265a8…`) copied to the operator's machine, and production's branch fetched there as `prod/demo-engine-internal-endpoints`.

**Reconciliation:**
- Production (`6f6604f`) merged with `origin/main` (`4ff756a`): the merge was clean, and webhook.js auto-merged with Demo Engine's forward code.
- **389 of 389 tests pass**, including Demo Engine's `internal.test.js`.
- The merge commit `63c9775` is on a local branch, **not pushed**: the GitHub repo is public, and publishing Demo Engine's server-only code there is the owner's decision.
- `deploy-vps.sh` performs the same merge on the server.

## 5. Regressions found

1. **Fixed before merging.** Demo Engine's "inbound forward" test calls `processWebhookBody()` directly, with a simplified body that has no phone number. The first version of the fix applied the number check to every caller and skipped it. The strict check now applies to HTTP requests only, so Demo Engine's code and tests are unchanged.
2. **Pre-existing flaky test, fixed.** `onpage.test.js` tampered with a signature by replacing its last character with `x`, which changes nothing when that character is already `x` (1 run in 64).
3. **Intended behaviour change.** Any business that relied on the old "no secret = no check" can no longer receive WhatsApp webhooks until an app secret (its own, or the platform `META_APP_SECRET`) is set. No live business has WhatsApp connected, so nobody is affected today.

## 6. Deployment and rollback plan (needs approval)

**Deploy:**
1. Run `sh /tmp/deploy-vps.sh` from `/opt/whatsapp-commerce`, as for every previous batch. It:
   - snapshots the database to `/root/wa-backups/predeploy-*.db`;
   - tags the running image `:previous`;
   - merges `origin/main` (the same merge as `63c9775`);
   - builds;
   - runs the full suite inside the image, and stops if anything fails;
   - restarts;
   - checks `/health`, and rolls back automatically if that fails.
2. **Afterwards, check that** unsigned POSTs to `/webhooks/whatsapp/<business>` return 403 for every business. No real message is sent to do this.

**Rollback:** `sh scripts/rollback-vps.sh` runs the previous image again.
- The data is untouched; there are no schema changes in this fix.
- `whatsapp-commerce:prod-6f6604f` and the snapshot folder remain as a second fallback.
- **Rolling back brings the vulnerability back.** Do it only together with containment (below).

**Containment if the deploy is delayed:** with approval, set a random 32-character app secret on each business. Forged POSTs then fail even on the old code. It's reversible, and no customer is affected, since no number is connected.

## 7. Is it safe to connect a real WhatsApp number?

- **Not before this fix is deployed.**
- **After deploying, yes, as far as webhook authentication goes,** provided the app secret that signs that number's webhooks is configured:
  - the business's own Meta app secret, for a manually connected number; or
  - the platform `META_APP_SECRET`, for Embedded Signup.
- Without one, webhooks are refused (by design), and the number won't receive messages until it's set.

**Before going fully live, separately:**
- make sure email alerts (Resend) and the alert webhook are configured, so failures are noticed;
- send one test message from a test phone through the app-level or per-business URL.
