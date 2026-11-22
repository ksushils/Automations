# Manual actions required

These are things only the owner can do: accounts, payments, approvals, decisions. Each one says what it unblocks.

Enter keys on the server in the super admin **Setup** tab, or in the `.env` next to `docker-compose.vps.yml`. Never paste them into chat.

## 1. Decide the product name and domain (blocks Meta review and the marketing work)

The current name contains "WhatsApp", which Meta's brand rules don't allow in a product name.
1. Choose a name and buy the domain.
2. Point DNS at the server (A record → 191.215.46.170).
3. Tell Claude. Moving the app to the new domain (Traefik route plus `PUBLIC_URL`) takes about 30 minutes.

## 2. Alert webhook (5 minutes, free)

This is how failure alerts reach you: failed emails, failing jobs, failed backups, database problems.
1. Create a Slack or Discord channel and add an "incoming webhook" to it.
2. Set `ALERT_WEBHOOK_URL=<webhook url>` and restart the app.
3. Check: the System health card stops showing "No alert webhook".

## 3. Off-server backups (about 15 minutes; Cloudflare R2 has a free tier of 10 GB)

1. Create an R2 bucket, for example `assistant-backups`.
2. Create an API token with Object Read & Write on that bucket only.
3. Set these, then restart:
   - `BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`
   - `BACKUP_S3_BUCKET`
   - `BACKUP_S3_ACCESS_KEY`
   - `BACKUP_S3_SECRET_KEY`
   - `BACKUP_PASSPHRASE=<a long random phrase>`
4. **Save `BACKUP_PASSPHRASE` in your password manager.** Without it, the backups can't be opened.
5. Add a bucket lifecycle rule that deletes files after 90 days.
6. Ask Claude to run the live restore drill: download the latest backup, decrypt it to a new file, check it. It never touches the live database.

## 4. Email (Resend): about 20 minutes, free for up to 3,000 emails a month

1. Create a resend.com account and add your domain.
2. Add the DNS records Resend shows (SPF, DKIM) and wait for "Verified".
3. Create an API key. In super admin → Setup → Emails, enter the key and a From address such as `Assistant <alerts@yourdomain>`.
4. Press **Send test email**. Then check System health: "Emails (7 days)" should show 1 sent.

## 5. Stripe billing: test mode first, no live charges until you approve

1. In Stripe test mode, create 3 Products with monthly Prices: Starter £29, Growth £79, Managed £249.
2. Enter `PLATFORM_STRIPE_SECRET_KEY` (test key, `sk_test_…`) and the three price IDs, or use **Setup → Payments → Create automatically**.
3. Add a webhook endpoint at `https://<domain>/webhooks/platform-stripe` with these events:
   - `checkout.session.completed`
   - `customer.subscription.created`, `.updated`, `.deleted` and `.trial_will_end`
   - `invoice.paid`
   - `invoice.payment_failed`
4. Copy its signing secret into `PLATFORM_STRIPE_WEBHOOK_SECRET`.
5. Under Settings → Billing → Customer portal, allow: update payment method, switch plans (between the 3 prices), cancel at the end of the period, and view invoices.
6. Under Settings → Subscriptions and emails, set retries (Smart Retries) and decide what happens after all retries fail. **Recommended: cancel the subscription.** The app already pauses the assistant after 7 days.
7. Then ask Claude to run the test-mode end-to-end check (Stripe CLI `stripe trigger`) and record the results.
8. **Live mode is a separate decision.** It needs your business details in Stripe, and live keys entered by you.

## 6. Meta / WhatsApp (several days; start once the name is decided)

1. Buy a new phone number for the platform's own WhatsApp; don't use your personal number.
2. Create a Meta Business portfolio and a Meta app.
3. Submit business verification.
4. Add the number and fill in Setup → WhatsApp.
5. For Embedded Signup, apply to become a Tech Provider; Claude will write the App Review script.
6. **Unblocks:** live WhatsApp tests (scenario B), template approval, and connection-health checks against a real number.

## 7. Uptime monitor (5 minutes, free)

1. In UptimeRobot or Better Stack, add a keyword monitor on `https://<domain>/health` that checks for `"ok":true`.
2. Optionally add a second monitor that checks for `"jobs":"ok"`.

## 8. Business and legal decisions

| Decision | Options | Status |
|---|---|---|
| £500 set-up fee on the website | Remove it for Starter and Growth (recommended by the master plan) and keep paid onboarding as an option | Not decided |
| Partner and referral commission | 20% recurring is the current default | Needs your confirmation |
| What happens when a subscription is cancelled | Pause the assistant (current), or drop to the Free plan (keeps website chat running and keeps the customer) | Not decided |
| Legal pages (terms, privacy, data processing agreement, sub-processors) | The templates exist; they need review by a UK solicitor before taking payment | Open |
| AI provider data terms | Check OpenRouter's and the model providers' data retention and where data is stored, for the privacy notice | Open |
