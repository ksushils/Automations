import express from 'express';
import { findTenantByPhoneNumberId, findTenantByWabaId, getTenant, bumpUsage, updateTenantSettings } from '../tenants.js';
import { alert } from '../ops.js';
import { config } from '../config.js';
import { getDb, json } from '../db.js';
import { verifyMetaSignature, safeEqual } from '../crypto.js';
import { createSender, parseInbound, logMessage, markRead } from './cloudApi.js';
import { handleInbound } from '../bot/engine.js';
import { PLANS } from '../tenants.js';
import { recordStatus, recordReply } from '../campaigns.js';
import { noteAppActivity, pauseAi } from '../coexistence.js';

// Serialise processing per customer so rapid taps don't race each other.
const queues = new Map();
export function enqueue(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job, job).catch((e) => console.error('[queue]', e));
  queues.set(key, next);
  next.finally(() => queues.get(key) === next && queues.delete(key));
  return next;
}

/** Handle one stored inbound message and mark it processed (also used by crash recovery). */
async function processStored(tenant, ev, waMessageId, send) {
  getDb().prepare('UPDATE messages SET attempts = attempts + 1 WHERE tenant_id = ? AND wa_message_id = ? AND direction = ?').run(tenant.id, waMessageId, 'in');
  markRead(tenant, waMessageId, { typing: true });
  try {
    if (PLANS[tenant.plan]?.whatsapp !== false) await handleInbound(tenant, ev, send);
  } finally {
    getDb().prepare('UPDATE messages SET processed = 1 WHERE tenant_id = ? AND wa_message_id = ? AND direction = ?').run(tenant.id, waMessageId, 'in');
  }
}

/**
 * Replay inbound messages that were stored but never finished (crash / deploy mid-processing).
 * Only recent ones (< 2h) and at most 3 attempts, so a poison message can't loop forever.
 */
export async function recoverUnprocessed({ olderThanSec = 20 } = {}) {
  // Give up after 3 attempts: park as dead-letter (processed = -1) and alert, so nothing vanishes silently
  const dead = getDb().prepare("SELECT tenant_id, wa_id, wa_message_id FROM messages WHERE direction = 'in' AND processed = 0 AND attempts >= 3").all();
  if (dead.length) {
    getDb().prepare("UPDATE messages SET processed = -1 WHERE direction = 'in' AND processed = 0 AND attempts >= 3").run();
    alert(`${dead.length} inbound message(s) failed 3 times and were moved to dead-letter: ${dead.slice(0, 5).map((d) => `${d.tenant_id}/${d.wa_id}`).join(', ')}`, { key: 'dead-letter' });
  }
  const rows = getDb().prepare(`SELECT tenant_id, wa_id, wa_message_id, body FROM messages WHERE direction = 'in' AND processed = 0 AND attempts < 3
     AND created_at < datetime('now', ?) AND created_at > datetime('now', '-2 hours') ORDER BY id LIMIT 200`).all(`-${olderThanSec} seconds`);
  let n = 0;
  for (const r of rows) {
    const tenant = getTenant(r.tenant_id);
    const stored = json(r.body, {});
    if (!tenant?.active || !stored.message) {
      getDb().prepare("UPDATE messages SET processed = 1 WHERE tenant_id = ? AND wa_message_id = ? AND direction = 'in'").run(r.tenant_id, r.wa_message_id);
      continue;
    }
    const ev = parseInbound(stored.message);
    ev.profileName = stored.profileName || undefined;
    await enqueue(`${tenant.id}:${ev.waId}`, () => processStored(tenant, ev, r.wa_message_id, createSender(tenant))).then(() => n++);
  }
  return n;
}

/** Remember new account identifiers if Meta starts sending them (account-model rollout), without depending on them. */
function captureAccountIds(tenant, value) {
  const ids = {};
  for (const k of ['waac_id', 'cs_id', 'messaging_account_id', 'whatsapp_account_id']) {
    const v = value?.metadata?.[k] ?? value?.[k];
    if (v && /^[\w-]{1,64}$/.test(String(v))) ids[k] = String(v);
  }
  if (!Object.keys(ids).length) return;
  const have = tenant.settings.whatsapp?.accountIds || {};
  if (Object.entries(ids).some(([k, v]) => have[k] !== v)) updateTenantSettings(tenant.id, { whatsapp: { accountIds: { ...have, ...ids } } });
}

function handleAccountUpdate(tenant, value) {
  const ev = String(value.event || '');
  if (/OFFBOARD|PARTNER_REMOVED|DISCONNECT|ACCOUNT_DELETED|BANNED|DISABLED/i.test(ev)) {
    updateTenantSettings(tenant.id, { whatsapp: { numberStatus: 'offboarded', lastAccountEvent: ev } });
    alert(`WhatsApp account event ${ev} for ${tenant.id} – the shop's number is no longer connected`, { key: `acct:${tenant.id}:${ev}` });
  } else if (ev) {
    updateTenantSettings(tenant.id, { whatsapp: { lastAccountEvent: ev } });
  }
}

/** Coexistence contacts sync (smb_app_state_sync): add the Business app's contacts with their names. */
function syncContacts(tenant, value) {
  for (const s of value.state_sync || []) {
    const c = s.contact || {};
    const wa = String(c.phone_number || '').replace(/\D/g, '');
    if (!wa || s.type !== 'contact') continue;
    if (s.action === 'remove') continue; // keep our record (orders/consent); the app contact was just deleted
    getDb().prepare(`INSERT INTO customers (tenant_id, wa_id, name) VALUES (?, ?, ?) ON CONFLICT(tenant_id, wa_id) DO UPDATE SET name = COALESCE(customers.name, excluded.name)`).run(tenant.id, wa, c.full_name || c.first_name || null);
  }
  noteAppActivity(tenant);
}

/**
 * Coexistence message history (up to 180 days) – stored for the inbox and AI context, never answered by the bot.
 * Marked source='history'; keyed on Meta's message id, so a re-sent chunk adds nothing. Returns how many were added.
 */
export function importHistory(tenant, value) {
  let added = 0;
  for (const h of value.history || []) {
    if (h.errors?.length) { console.warn(`[history] ${tenant.id}`, JSON.stringify(h.errors)); continue; }
    for (const th of h.threads || []) {
      const wa = String(th.id || '').replace(/\D/g, '');
      for (const m of th.messages || []) {
        const fromCustomer = String(m.from || '').replace(/\D/g, '') === wa;
        try {
          if (!m.id) continue;
          getDb().prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, wa_message_id, processed, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'history', datetime(?, 'unixepoch'))")
            .run(tenant.id, wa, fromCustomer ? 'in' : 'out', m.type || 'text', JSON.stringify({ type: 'text', text: m.text?.body || `[${m.type}]`, via: 'history' }), `hist-${m.id}`, Number(m.timestamp) || Math.floor(Date.now() / 1000));
          added++;
        } catch (e) { if (!/UNIQUE/.test(e.message)) throw e; /* already imported */ }
      }
    }
  }
  return added;
}

/**
 * Which business an (already signature-verified) change belongs to.
 *  - Per-business URL: the change must be for THAT business's number (or its WhatsApp Business Account when there's
 *    no number in the change, e.g. account_update). Anything else is skipped – a body signed with a shared app
 *    secret can't be replayed into another business's URL.
 *  - App-level URL: by phone_number_id only; the WABA id is used only when the change carries no number at all.
 *  Inactive businesses are skipped.
 */
export function resolveTenant(entry, value, tenantOverride) {
  const pnid = value?.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : null;
  if (tenantOverride) {
    const W = tenantOverride.settings?.whatsapp || {};
    const ok = pnid ? !!W.phoneNumberId && String(W.phoneNumberId) === pnid : !!entry?.id && !!W.wabaId && String(W.wabaId) === String(entry.id);
    return ok && tenantOverride.active ? tenantOverride : null;
  }
  const t = pnid ? findTenantByPhoneNumberId(pnid) : entry?.id ? findTenantByWabaId(entry.id) : null;
  return t && t.active ? t : null;
}

export function processWebhookBody(body, { tenantOverride } = {}) {
  const jobs = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const tenant = resolveTenant(entry, value, tenantOverride);
      if (!tenant) { console.warn(`[webhook] skipped a change for an unknown or mismatched number${tenantOverride ? ` (url business ${tenantOverride.id})` : ''}`); continue; }
      captureAccountIds(tenant, value);
      if (change.field === 'account_update') { handleAccountUpdate(tenant, value); continue; }
      if (change.field === 'smb_app_state_sync') { syncContacts(tenant, value); continue; }
      if (change.field === 'history') { importHistory(tenant, value); continue; }
      const send = createSender(tenant);
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        const ev = parseInbound(m);
        ev.profileName = names[m.from];
        // Persist first (processed = 0), then handle. logMessage returns false for duplicates (Meta retries).
        // If the server dies mid-reply, recoverUnprocessed() replays it – so a retry being de-duplicated never loses a message.
        const stored = { type: ev.kind, text: ev.text, id: ev.id, raw: m.type, ...(ev.mediaId ? { mediaId: ev.mediaId, mime: ev.mime } : {}), message: m, profileName: ev.profileName || null };
        if (!logMessage(tenant.id, ev.waId, 'in', stored, m.id, { processed: ev.kind === 'ignore' ? 1 : 0 })) continue;
        bumpUsage(tenant.id, 'inbound');
        recordReply(tenant.id, ev.waId, { isButton: m.type === 'button' });
        if (ev.kind === 'ignore') continue; // reactions, stickers – nothing to answer
        jobs.push(enqueue(`${tenant.id}:${ev.waId}`, () => processStored(tenant, ev, m.id, send)));
      }
      // Coexistence: messages the owner sent from the WhatsApp Business app on their phone
      // Stored as source='phone_app' (free at Meta), and the AI pauses in that chat so the owner and bot don't talk over each other.
      for (const e of value.message_echoes || []) {
        const to = String(e.to || '').replace(/\D/g, '');
        if (!to) continue;
        if (!logMessage(tenant.id, to, 'out', { type: 'text', text: e.text?.body || `[${e.type} sent from the WhatsApp Business app]`, via: 'phone_app' }, e.id ? String(e.id) : null, { source: 'phone_app' })) continue; // Meta retry
        noteAppActivity(tenant);
        jobs.push(enqueue(`${tenant.id}:${to}`, async () => pauseAi(tenant, to)));
      }
      // value.statuses (sent/delivered/read/failed) – log failures for debugging
      for (const s of value.statuses || []) {
        recordStatus(tenant.id, s);
        if (s.status === 'failed') console.warn(`[wa status] tenant=${tenant.id} to=${s.recipient_id}`, JSON.stringify(s.errors || []));
      }
    }
  }
  return Promise.all(jobs);
}

/** The app secret that signs this business's webhooks: its own Meta app's, else the platform app's. */
export const tenantAppSecret = (tenant) => tenant?.settings?.whatsapp?.appSecret || config.metaAppSecret || '';

/** Why a webhook POST can't be trusted, or null. Fails closed: no secret configured → refused. */
export function signatureProblem(req, secret) {
  if (!secret) return 'no_app_secret';
  if (!Buffer.isBuffer(req.rawBody)) return 'no_raw_body';
  const h = req.get('x-hub-signature-256');
  if (!h) return 'missing_signature';
  return verifyMetaSignature(req.rawBody, h, secret) ? null : 'invalid_signature';
}
const REJECT_STATUS = { no_app_secret: 403, no_raw_body: 400, missing_signature: 401, invalid_signature: 401 };
const rejectLog = new Map();
/** Refuse and log (business id, reason and IP only – never the body, the header or the secret). At most once a minute per reason. */
function reject(res, why, tenantId, req) {
  const k = `${tenantId || 'app'}:${why}`;
  const now = Date.now();
  if (now - (rejectLog.get(k) || 0) > 60000) { rejectLog.set(k, now); console.warn(`[webhook] rejected POST business=${tenantId || 'app-level'} reason=${why} ip=${req.ip}`); }
  return res.sendStatus(REJECT_STATUS[why] || 401);
}

export function whatsappRouter() {
  const r = express.Router();

  // App-level webhook for numbers connected through Embedded Signup (all clients share your Meta app).
  // Messages are routed to the right client by phone_number_id.
  // GET = Meta's one-time verification handshake only (never processes events). POST = events, always signed.
  r.get('/', (req, res) => {
    const ok = !!config.metaWebhookVerifyToken && req.query['hub.mode'] === 'subscribe' && safeEqual(req.query['hub.verify_token'], config.metaWebhookVerifyToken);
    return ok ? res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? '').slice(0, 200)) : res.sendStatus(403);
  });
  r.post('/', (req, res) => {
    const why = signatureProblem(req, config.metaAppSecret);
    if (why) return reject(res, why, null, req);
    res.sendStatus(200);
    processWebhookBody(req.body).catch((e) => console.error('[webhook] processing failed:', e.message));
  });

  // Webhook verification (GET). One URL per tenant: /webhooks/whatsapp/:tenantId
  r.get('/:tenantId', (req, res) => {
    const tenant = getTenant(req.params.tenantId);
    const token = tenant?.settings?.whatsapp?.verifyToken;
    const ok = !!tenant && !!token && req.query['hub.mode'] === 'subscribe' && safeEqual(req.query['hub.verify_token'], token);
    if (ok) return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? '').slice(0, 200));
    return res.sendStatus(403);
  });

  r.post('/:tenantId', (req, res) => {
    const tenant = getTenant(req.params.tenantId);
    if (!tenant || !tenant.active) return res.sendStatus(404);
    // the business's own Meta app secret, else the platform app's (numbers connected through Embedded Signup)
    const why = signatureProblem(req, tenantAppSecret(tenant));
    if (why) return reject(res, why, tenant.id, req);
    res.sendStatus(200); // acknowledge fast; Meta retries if we take > ~10s
    processWebhookBody(req.body, { tenantOverride: tenant }).catch((e) => console.error('[webhook] processing failed:', e.message));
  });

  return r;
}
