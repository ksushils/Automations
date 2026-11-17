#!/usr/bin/env node
/*
 * Spike step 2 (route B): Meta → OpenAI Realtime SIP directly. OpenAI tells us a call has arrived with a webhook;
 * we accept it with a 3-line test prompt. Every step is logged with timings to calls.log.
 *
 *   OPENAI_API_KEY=sk-... OPENAI_WEBHOOK_SECRET=whsec_... PORT=8787 node openai-sip-webhook.mjs
 *   (put it behind HTTPS, e.g. a temporary Traefik route or a tunnel, and set that URL as the project's webhook
 *    in the OpenAI dashboard, events: realtime.call.incoming / live.transport.incoming)
 *   DRY_RUN=1 … logs and verifies the webhook but does not accept the call (it rings out).
 *
 * OpenAI docs (checked 17 Nov 2026): two APIs on the same SIP address –
 *  - Realtime: event realtime.call.incoming → POST /v1/realtime/calls/{call_id}/accept {type:'realtime', model, instructions}
 *  - GPT-Live: event live.transport.incoming → POST /v1/live/sessions/{session_id}/accept {session:{type:'live', model, instructions, audio}}
 * Signatures: Standard Webhooks (webhook-id / webhook-timestamp / webhook-signature "v1,<base64>"), HMAC-SHA256 over
 * "id.timestamp.body" with the base64 part of the whsec_ secret. Verified here without the SDK.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY = process.env.OPENAI_API_KEY, SECRET = process.env.OPENAI_WEBHOOK_SECRET || '', DRY = process.env.DRY_RUN === '1';
const MODEL = process.env.REALTIME_MODEL || 'gpt-realtime', LIVE_MODEL = process.env.LIVE_MODEL || 'gpt-live-1';
const PROMPT = [
  'You are a test assistant for RC Shopper, a UK shop selling RC drift cars. Start by saying you are an AI assistant.',
  'Answer in one or two short sentences, in British English.',
  'If asked about an order, say this is a test line and the team will call back.',
].join('\n');
const out = fs.createWriteStream(new URL('./calls.log', import.meta.url), { flags: 'a' });
const log = (...a) => { const l = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`; console.log(l); out.write(l + '\n'); };

function verify(req, raw) {
  if (!SECRET) return 'no secret set – NOT verified';
  const id = req.headers['webhook-id'], ts = req.headers['webhook-timestamp'], sig = String(req.headers['webhook-signature'] || '');
  if (!id || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
  const want = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return sig.split(' ').some((p) => { const v = p.split(',')[1] || ''; return v.length === want.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(want)); });
}

async function openai(path, body) {
  const t0 = Date.now();
  const res = await fetch(`https://api.openai.com${path}`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  log('POST', path, '→', res.status, `${Date.now() - t0}ms`, (await res.text()).slice(0, 500));
  return res.status;
}

http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(200); return res.end('wa-calling spike webhook'); }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const received = Date.now();
    const ok = verify(req, raw);
    if (ok === false) { log('webhook REJECTED: bad signature'); res.writeHead(400); return res.end(); }
    res.writeHead(200); res.end();
    let ev = {};
    try { ev = JSON.parse(raw); } catch { return log('webhook: not JSON'); }
    const headers = Object.fromEntries((ev.data?.sip_headers || []).map((h) => [h.name, h.value]));
    log('webhook', ev.type, { signature: ok === true ? 'ok' : ok, call_id: ev.data?.call_id, session_id: ev.data?.session_id, from: headers.From, to: headers.To, sip_call_id: headers['Call-ID'] });
    if (DRY) return log('DRY_RUN – not accepting');
    if (ev.type === 'realtime.call.incoming') {
      await openai(`/v1/realtime/calls/${ev.data.call_id}/accept`, { type: 'realtime', model: MODEL, instructions: PROMPT });
    } else if (ev.type === 'live.transport.incoming' || ev.type === 'live.call.incoming') {
      await openai(`/v1/live/sessions/${ev.data.session_id}/accept`, { session: { type: 'live', model: LIVE_MODEL, instructions: PROMPT, audio: { output: { voice: 'marin' } } } });
    } else return;
    log('call setup: webhook → accepted in', `${Date.now() - received}ms`, '(note when the caller first hears audio, by hand, in SPIKE_RESULT.md)');
  });
}).listen(Number(process.env.PORT || 8787), () => log('listening on', process.env.PORT || 8787, DRY ? '(DRY RUN)' : ''));
