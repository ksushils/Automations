#!/usr/bin/env node
/*
 * Spike step 1 (and 4): read and switch on WhatsApp calling + SIP for one phone number.
 * DRY RUN by default: prints the exact request and changes nothing. Add --apply to send it.
 *
 *   WA_TOKEN=... WA_PHONE_NUMBER_ID=... node enable-calling.mjs --status
 *   WA_TOKEN=... WA_PHONE_NUMBER_ID=... node enable-calling.mjs --sip-host sip-eu.api.openai.com --sip-user proj_xxx          (dry run)
 *   WA_TOKEN=... WA_PHONE_NUMBER_ID=... node enable-calling.mjs --sip-host sip-eu.api.openai.com --sip-user proj_xxx --apply
 *   ... node enable-calling.mjs --disable --apply        (switch calling and SIP off again)
 *
 * Meta docs (checked 17 Nov 2026): POST /<PHONE_NUMBER_ID>/settings with a `calling` object.
 *  - Calling needs a messaging limit of 2,000 or more on the number.
 *  - With sip.status ENABLED the number takes calls ONLY over SIP (the Graph calling endpoints stop working).
 *  - srtp_key_exchange_protocol (DTLS default / SDES) – placement under `calling` NOT verified in the docs; the script
 *    sends it only with --srtp. If Meta rejects the field, re-run without it (DTLS is the default anyway).
 * Step 4 (coexistence): run --status, then the dry run / --apply against the coexistence number and record Meta's reply.
 */
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const token = process.env.WA_TOKEN, phone = process.env.WA_PHONE_NUMBER_ID, version = process.env.GRAPH_VERSION || 'v23.0';
if (!token || !phone) { console.error('Set WA_TOKEN and WA_PHONE_NUMBER_ID.'); process.exit(1); }
const base = `https://graph.facebook.com/${version}/${phone}`;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const redact = (s) => String(s).replace(/"sip_user_password":"[^"]*"/g, '"sip_user_password":"<hidden>"');

async function call(method, url, body) {
  log(method, url.replace(token, '<token>'), body ? JSON.stringify(body) : '');
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  log('→', res.status, redact(text));
  return { status: res.status, text };
}

// what kind of number is this? (coexistence numbers are on the WhatsApp Business app)
await call('GET', `${base}?fields=display_phone_number,verified_name,platform_type,throughput,messaging_limit_tier,quality_rating,code_verification_status`);
await call('GET', `${base}/settings`);
if (flag('--status')) process.exit(0);

let body;
if (flag('--disable')) body = { calling: { status: 'DISABLED', sip: { status: 'DISABLED', servers: [] } } };
else {
  const host = opt('--sip-host');
  if (!host) { console.error('Give --sip-host (e.g. sip-eu.api.openai.com) or --disable.'); process.exit(1); }
  const server = { hostname: host, port: opt('--sip-port', '5061') };
  if (opt('--sip-user')) server.request_uri_user_params = { user: opt('--sip-user') }; // OpenAI routes by project id in the user part – check the INVITE in the logs
  body = { calling: { status: 'ENABLED', call_icon_visibility: 'DEFAULT', sip: { status: 'ENABLED', webhook_delivery: 'ENABLED', servers: [server] }, ...(flag('--srtp') ? { srtp_key_exchange_protocol: opt('--srtp') || 'DTLS' } : {}) } };
}
if (!flag('--apply')) { log('DRY RUN – would POST', `${base}/settings`, JSON.stringify(body, null, 2)); log('Add --apply to send it.'); process.exit(0); }
const r = await call('POST', `${base}/settings`, body);
if (r.status >= 400) { log('Meta refused. Copy the error above into SPIKE_RESULT.md.'); process.exit(2); }
await call('GET', `${base}/settings`);
