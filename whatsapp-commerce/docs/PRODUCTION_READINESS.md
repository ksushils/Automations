# Production readiness

**Verdict (22 November 2026): not ready to take paying customers yet.** The code side of Phase 0 is mostly done and tested. What's missing is outside accounts and checks against the real services.

## Checklist

| Area | Ready? | What's missing |
|---|---|---|
| Subscription billing code | ✅ tested with Stripe faked | A test-mode run with real Stripe events (manual action 5) |
| Live billing | ❌ | Stripe account, prices, webhook and customer portal set up; owner approval to go live |
| Email | ❌ | Resend key and verified domain (manual action 4). The code records and retries every email. |
| Failure alerts | ❌ | `ALERT_WEBHOOK_URL` (manual action 2). Until then, alerts only go to the container logs. |
| Uptime monitoring | ❌ | External monitor on `/health` (manual action 7) |
| Backups on the server | ✅ | Daily snapshot inside the container volume |
| Backups off the server | ❌ | S3 or R2 bucket (manual action 3). **Biggest data risk today:** losing the VPS means losing everything. |
| Restore tested | 🟡 | Drill passed locally; a live drill is needed once off-server backups exist |
| Background job monitoring | ✅ | Shown in System health |
| Tenant isolation | ✅ tested | No |
| WhatsApp | ❌ | Meta app, verification and a real number (manual action 6) |
| Product name | ❌ | Rename away from "WhatsApp…" (manual action 1) |
| Legal | ❌ | Solicitor review of the terms, privacy notice and data processing agreement |

## Checks before every deploy

1. Run `npm audit`. There must be no high or critical issues in production dependencies.
2. Run the full test suite **inside the built image** (Node 22). Everything must pass.
3. Take a pre-deploy database snapshot (`VACUUM INTO`) and copy it to `/root/wa-backups/`.
4. Deploy only with the owner's approval in that conversation.
5. After the restart, check:
   - `curl https://<domain>/health` returns `{"ok":true,"jobs":"ok"}`;
   - System health shows no failing jobs;
   - the container logs have no errors in the first two minutes.

## Rollback

1. Run `git checkout <previous commit>` in `/opt/whatsapp-commerce`, then rebuild and run `up -d`.
   - Schema changes only ever add tables and columns, so older code runs against a newer database.
2. Restore the database only if data was damaged:
   - stop the container;
   - copy the current file aside;
   - put the pre-deploy snapshot in its place;
   - start the container.
   - **Warning:** this loses any changes made since the snapshot.

## Is SQLite still the right choice?

Yes, for now. One process, WAL mode, a handful of businesses, and writes measured in messages per minute are well within SQLite's limits. Move on when any of these happen:
- `SQLITE_BUSY` errors appear in the logs;
- jobs fall behind (System health shows overdue jobs for more than 10 minutes);
- a second app process or server is needed.

The first step would then be a durable job table, not PostgreSQL.
