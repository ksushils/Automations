# Spike: WhatsApp calls answered by an AI voice

Goal: prove a customer's WhatsApp call can reach an AI voice agent before any product work. Nothing here touches the main app.

## Before you start (blockers)

- **A connected WhatsApp number.** RC Shopper's number must be on the Cloud API first (Meta business portfolio + number).
- **Messaging limit of 2,000 or more.** Meta only allows calling above this limit. A brand-new number starts lower, so check `messaging_limit_tier` with `--status` first.
- **SIP takes over calls.** Once `sip.status` is ENABLED, the number takes calls only over SIP. Use a test number, or switch it off again with `--disable --apply` afterwards.
- **An OpenAI project.** You need its project ID (`proj_…`), an API key, and a webhook secret (`whsec_…`) for the project's webhook.

## Steps

1. Check the number:
   ```bash
   WA_TOKEN=… WA_PHONE_NUMBER_ID=… node enable-calling.mjs --status
   ```
2. Route B (Meta straight to OpenAI):
   1. Start the webhook on the VPS behind HTTPS on a spare port, and add that URL as the OpenAI project's webhook. Use your usual temporary Traefik route; don't touch other apps.
      ```bash
      OPENAI_API_KEY=… OPENAI_WEBHOOK_SECRET=… PORT=8787 node openai-sip-webhook.mjs
      ```
   2. Point Meta's SIP at OpenAI. Do a dry run first, then add `--apply`:
      ```bash
      node enable-calling.mjs --sip-host sip-eu.api.openai.com --sip-user proj_xxx
      ```
   3. Call the number from a phone with WhatsApp. Everything is logged to `calls.log`.
   4. If there's no audio, try once with `--srtp DTLS`.
3. If route B fails (no INVITE, a rejected INVITE, no audio, or an encryption mismatch), copy the exact error into `SPIKE_RESULT.md`. Then try route A with VideoSDK's WhatsApp voice agent quick start.
4. Coexistence: run steps 1 and 2 against a number connected with the WhatsApp Business app, and record Meta's answer.
5. Fill in `SPIKE_RESULT.md`.
