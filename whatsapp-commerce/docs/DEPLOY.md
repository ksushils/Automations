# Deploying WhatsApp Commerce: step by step

You need about half a day of setup, plus waiting time for Meta and Stripe approvals. Do the steps in order.
Everything marked **(you)** happens in someone else's dashboard and can't be done from the code.

---

## 0. What you need before you start

| Thing | Why | Cost |
|---|---|---|
| A Linux VPS (Ubuntu 22.04/24.04, 1 vCPU, 1–2 GB RAM, 20 GB disk) | Runs the app | ~£5–10/month |
| A domain/subdomain, e.g. `wa.rcshopper.com` | Public HTTPS address for webhooks, dashboard, storefronts | — |
| OpenRouter account + API key | The AI (Direct mode) | Pay as you go |
| Stripe account (yours) | To charge shops monthly | Stripe fees |
| Meta developer account + Meta Business portfolio | WhatsApp | Free (Meta bills message fees to each shop) |
| A Slack/Discord webhook (optional) | Error alerts | Free |

> **Same server as Dify?** Dify's own nginx already uses ports 80/443 on `dify.rcshopper.com`. Either use a **separate small VPS**
> (simplest), or add a `wa.rcshopper.com` server block to Dify's nginx that proxies to `127.0.0.1:3000`, instead of installing Caddy.

---

### Using Oracle Cloud Always Free as the VPS

It works. The app is small, and the Docker image (`node:22-alpine`) runs on Oracle's Arm (Ampere) machines.

**Limits** (from [Oracle's Always Free docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)):
- **Ampere A1 (Arm), recommended:** 2 OCPUs and 12 GB RAM in total, as one instance or two. Use one `VM.Standard.A1.Flex` with 2 OCPU / 12 GB.
- **AMD micro:** 1/8 OCPU and 1 GB RAM. Too small for comfort; avoid it.
- **Storage and traffic:** 200 GB of block storage including boot volumes; 10 TB of outbound data a month.

**Watch out for:**
1. **Pick your home region carefully at sign-up:** UK South (London) for UK data. You can't change it later, and free instances must be created in the home region.
2. **"Out of host capacity" errors:** free Arm capacity in popular regions is often full. Retry at different times.
3. **Idle reclamation.** Oracle says idle Always Free instances "may be reclaimed" if, over 7 days, CPU (95th percentile), network and memory are all under 20%. A quiet pilot server can easily look idle. Upgrading the account to **Pay As You Go** is the usual fix: Always Free resources stay free, and reclamation is aimed at free-only accounts. Check Oracle's current terms, and set a budget alert at £1. Don't run fake load to dodge it.
4. **Open the ports in two places:**
   - in the VCN **Security List** (or Network Security Group), add ingress TCP 80 and 443 from `0.0.0.0/0`;
   - in the OS: Oracle's Ubuntu images block them with iptables:
     ```bash
     sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
     ```
     ```bash
     sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
     ```
     ```bash
     sudo netfilter-persistent save
     ```
5. **Reserve a public IP** for the instance, so DNS doesn't break if you recreate it.
6. **Off-site backups:** Object Storage includes 20 GB free (enough for nightly database snapshots), though an account at a different provider is safer.

## 1. DNS **(you)**

At your DNS provider, add an **A record** `wa` → your VPS IP address (and AAAA for IPv6 if you have one).
Wait until `ping wa.rcshopper.com` shows the VPS IP.

## 2. Server: Docker + HTTPS

SSH into the VPS:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git caddy
```

Get the code (it's on the branch `claude/dazzling-darwin-uojvtj` until you merge it):

```bash
git clone -b claude/dazzling-darwin-uojvtj https://github.com/ksushils/Automations.git
cd Automations/whatsapp-commerce
cp .env.example .env
```

HTTPS with Caddy (gets and renews the certificate automatically). Put this in `/etc/caddy/Caddyfile`:

```
wa.rcshopper.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

If your shops will use their **own domains** for storefronts (e.g. `order.theirshop.co.uk`), add each one to the Caddyfile
the same way. They CNAME it to `wa.rcshopper.com`, and you set it in their Settings → Custom domain.

## 3. Core settings in `.env` (required)

Generate secrets with `openssl rand -base64 48`:

```ini
PUBLIC_URL=https://wa.rcshopper.com
ENCRYPTION_KEY=<openssl rand -base64 48>      # encrypts all stored tokens – back it up, never lose it
SUPER_ADMIN_KEY=<openssl rand -base64 36>     # your own login to the admin dashboard
SUPPORT_EMAIL=support@yourdomain.co.uk
PRODUCT_NAME=WhatsApp Commerce                # name shown on the sales site
WHATSAPP_GRAPH_VERSION=v26.0
```

Start it:

```bash
docker compose up -d --build
docker compose logs -f     # should end with "WhatsApp Commerce running on :3000"
```

Check `https://wa.rcshopper.com/health` shows `{"ok":true}`, and `https://wa.rcshopper.com/` shows the sales page.

## 4. AI: OpenRouter (Direct mode) **(you)**

1. Go to openrouter.ai, create an account and add credit (e.g. $20).
2. In **Settings → Privacy**, turn off training/logging on your prompts.
3. Create an **API key**.
4. Optional, for search by meaning in the knowledge base: create an OpenAI API key for embeddings.

```ini
AI_API_KEY=sk-or-...
AI_MODEL=openai/gpt-4o-mini        # cheap and good; keep it unless you have a reason
AI_PROVIDER_ORDER=openai           # only these providers (list them as sub-processors)
AI_ZERO_RETENTION=true
# optional semantic search:
EMBEDDINGS_BASE_URL=https://api.openai.com/v1
EMBEDDINGS_API_KEY=sk-...
EMBEDDINGS_MODEL=text-embedding-3-small
```

Leave the `DIFY_*` settings empty unless you get written permission from Dify (see `PLATFORM_NOTES.md`).

## 5. Stripe: charging shops monthly **(you)**

Work in **Test mode** first, then repeat in Live mode.

1. **Products → Add product**, three times: *Starter £29/month*, *Growth £79/month*, *Pro £199/month* (recurring, monthly).
   Copy each **Price ID** (`price_...`).
2. **Developers → API keys**: copy the **Secret key** (`sk_live_...`, or a restricted key with Checkout + Billing Portal + Customers).
3. **Developers → Webhooks → Add endpoint**:
   - URL `https://wa.rcshopper.com/webhooks/platform-stripe`;
   - events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`;
   - copy the **Signing secret** (`whsec_...`).
4. **Settings → Billing → Customer portal**: turn it on, and allow cancel, switch plan and update card.
5. **Settings → Emails**: turn on receipts and "trial ending" reminders.
6. Optional UK VAT: **Tax → turn on Stripe Tax** and register your VAT number, then set `STRIPE_AUTOMATIC_TAX=true`.

```ini
PLATFORM_STRIPE_SECRET_KEY=sk_live_...
PLATFORM_STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_PRO=price_...
TRIAL_DAYS=14
TOPUP_GBP_PER_USD=1.5
STRIPE_AUTOMATIC_TAX=false
```

## 6. Meta / WhatsApp **(you)**

This is the slowest part (days to weeks for reviews). You can run the pilot meanwhile with the **website AI chat** and the
**Test bot**, which don't need Meta.

### 6a. Your Meta app
1. developers.facebook.com → **My Apps → Create app** → type **Business** → add the **WhatsApp** product.
2. **App settings → Basic**: copy the **App ID** and **App secret**. Add a privacy policy URL (`https://wa.rcshopper.com/legal/privacy`)
   and terms URL (`/legal/terms`).
3. **Business verification** of *your* company in Meta Business Suite → Security Centre (needed for Tech Provider).
4. Apply to become a **Tech Provider** (WhatsApp → Partner/Tech Provider onboarding in the app dashboard), and request
   **Advanced access** for `whatsapp_business_messaging` and `whatsapp_business_management` (App Review). This can take a while.

### 6b. Webhook (app level)
In **WhatsApp → Configuration → Webhook**:
- Callback URL: `https://wa.rcshopper.com/webhooks/whatsapp`
- Verify token: a random string you choose, the same one you put in `META_WEBHOOK_VERIFY_TOKEN`.
- Subscribe to the fields `messages`, `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes`, `message_template_status_update`.

### 6c. Embedded Signup v4 configuration (important)
**Facebook Login for Business → Configurations → Create configuration**:
- login variation: **Embedded Signup**;
- **select your products** (WhatsApp Cloud API; optionally Marketing Messages API, Click-to-WhatsApp ads). Selecting products is what makes it **v4**;
- copy the **Configuration ID**;
- under Facebook Login for Business **Settings**, add `wa.rcshopper.com` to **Allowed domains**.

```ini
META_APP_ID=...
META_APP_SECRET=...
META_CONFIG_ID=...        # the NEW v4 configuration – not an old one
META_WEBHOOK_VERIFY_TOKEN=...
```

Restart after editing `.env`:

```bash
docker compose up -d
```

## 7. Alerts, backups, legal

```ini
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...   # or a Discord/n8n webhook
BACKUP_DIR=./data/backups
BACKUP_KEEP=14
LEGAL_COMPANY_NAME=Your Company Ltd
LEGAL_COMPANY_NUMBER=12345678
LEGAL_ADDRESS=1 High Street, London, AB1 2CD
LEGAL_CONTACT_EMAIL=privacy@yourdomain.co.uk
```

- **Off-server backups**: copy `data/backups/` somewhere else every night, for example with rclone to Backblaze B2 or S3, from cron.
  The server keeps 14 daily snapshots, but they don't help if the disk dies.
- **Back up `.env`** (especially `ENCRYPTION_KEY`) in a password manager. Without it, stored tokens can't be decrypted.
- Have a solicitor review `/legal/terms`, `/legal/privacy` and `/legal/dpa`.

## 8. First run and smoke test

1. Open `https://wa.rcshopper.com/admin/`. Leave Tenant ID empty, enter your `SUPER_ADMIN_KEY` and sign in.
2. Or test the customer journey: go to `https://wa.rcshopper.com/` → **Start free trial**, enter **rcshopper.com** as the website,
   and save the shop ID + admin key shown.
3. In the shop dashboard:
   1. **Overview**: the wizard should show the website, products and knowledge base done.
   2. **AI assistant**: engine *Direct* → Save.
   3. **Test bot**: ask "what's your returns policy?" and search for a product.
   4. **Grow**: copy the **Website AI chat** snippet onto a test page and chat with it.
4. **Connect WhatsApp** (Overview → *Connect a new WhatsApp number*, or *I use the WhatsApp Business app on my number*).
   Then follow the **go-live checklist** on the Overview page.
5. **Templates** tab: submit `order_update`, `staff_alert`, `payment_reminder` and the marketing ones you'll use. Wait for approval.
6. **Settings → Notifications**: set your staff WhatsApp numbers, and the templates for messages outside the 24-hour window
   (`order_update`, `payment_reminder`, `staff_alert`).
7. Send "hi" to the business number from your phone and check it appears in the **Inbox**.
8. **Billing** tab: subscribe to a plan with a Stripe test card (4242 4242 4242 4242) and check the plan updates.

Check after every deploy (from your laptop):

```bash
curl -s https://wa.rcshopper.com/health
curl -s -H "Authorization: Bearer $SUPER_ADMIN_KEY" https://wa.rcshopper.com/api/system/status
```

## 9. Updating later

```bash
cd Automations/whatsapp-commerce
git pull
docker compose up -d --build
```

The database migrates itself on start. Messages interrupted by a restart are replayed automatically.

---

## All settings at a glance

| Setting | Required? | Where it comes from |
|---|---|---|
| `PUBLIC_URL` | **Yes** | Your domain, `https://…` |
| `ENCRYPTION_KEY` | **Yes** | `openssl rand -base64 48` – back it up |
| `SUPER_ADMIN_KEY` | **Yes** | `openssl rand -base64 36` |
| `AI_API_KEY` | **Yes** (for AI) | OpenRouter → Keys |
| `AI_MODEL`, `AI_PROVIDER_ORDER`, `AI_ZERO_RETENTION` | Recommended | Defaults are fine |
| `EMBEDDINGS_*` | Optional | OpenAI API key, for semantic knowledge search |
| `PLATFORM_STRIPE_SECRET_KEY`, `PLATFORM_STRIPE_WEBHOOK_SECRET` | **Yes** (to charge) | Stripe → Developers |
| `STRIPE_PRICE_STARTER/GROWTH/PRO` | **Yes** (to charge) | Stripe → Products |
| `STRIPE_AUTOMATIC_TAX` | Optional | `true` after enabling Stripe Tax |
| `TRIAL_DAYS`, `SIGNUP_ENABLED`, `TOPUP_GBP_PER_USD` | Optional | Defaults 14 / true / 1.5 |
| `META_APP_ID`, `META_APP_SECRET` | **Yes** (WhatsApp) | Meta app → Settings → Basic |
| `META_CONFIG_ID` | **Yes** (WhatsApp) | Facebook Login for Business → *new* v4 configuration |
| `META_WEBHOOK_VERIFY_TOKEN` | **Yes** (WhatsApp) | Any random string, same as in the Meta webhook settings |
| `WHATSAPP_GRAPH_VERSION` | Recommended | `v26.0` |
| `ALERT_WEBHOOK_URL` | Recommended | Slack/Discord incoming webhook |
| `SUPPORT_EMAIL`, `PRODUCT_NAME`, `LEGAL_*` | Recommended | Your details |
| `BACKUP_DIR`, `BACKUP_KEEP` | Optional | Defaults are fine |
| `META_RATES_JSON` | Optional | Override Meta price estimates from the rate card |
| `DIFY_*`, `DIFY_LICENSED` | Leave empty | Only with a Dify commercial licence |
| `SUPER_ADMIN_KEYS_EXTRA`, `ENCRYPTION_KEYS_OLD` | Only when rotating keys | See README |

**Per shop (entered by the shop in its dashboard, not in `.env`):**
- WhatsApp: filled automatically by *Connect WhatsApp*.
- Store: a Shopify URL (nothing else needed), a Shopify Admin token, WooCommerce keys, or the built-in catalogue.
- The shop's **own** Stripe keys, if it wants card payments for built-in-catalogue orders.
- Staff alert numbers, delivery zones, promo codes and knowledge documents.
