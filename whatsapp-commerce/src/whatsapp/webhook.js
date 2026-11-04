import express from 'express';
import { findTenantByPhoneNumberId, getTenant, bumpUsage } from '../tenants.js';
import { verifyMetaSignature, safeEqual } from '../crypto.js';
import { createSender, parseInbound, logMessage, markRead } from './cloudApi.js';
import { handleInbound } from '../bot/engine.js';

// Serialise processing per customer so rapid taps don't race each other.
const queues = new Map();
export function enqueue(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job, job).catch((e) => console.error('[queue]', e));
  queues.set(key, next);
  next.finally(() => queues.get(key) === next && queues.delete(key));
  return next;
}

export function processWebhookBody(body, { tenantOverride } = {}) {
  const jobs = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const tenant = tenantOverride || findTenantByPhoneNumberId(value.metadata?.phone_number_id);
      if (!tenant) continue;
      const send = createSender(tenant);
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        const ev = parseInbound(m);
        ev.profileName = names[m.from];
        // logMessage returns false for duplicates (Meta retries deliveries)
        if (!logMessage(tenant.id, ev.waId, 'in', { type: ev.kind, text: ev.text, id: ev.id, raw: m.type }, m.id)) continue;
        bumpUsage(tenant.id, 'inbound');
        jobs.push(
          enqueue(`${tenant.id}:${ev.waId}`, async () => {
            markRead(tenant, m.id);
            await handleInbound(tenant, ev, send);
          }),
        );
      }
      // value.statuses (sent/delivered/read/failed) – log failures for debugging
      for (const s of value.statuses || []) {
        if (s.status === 'failed') console.warn(`[wa status] tenant=${tenant.id} to=${s.recipient_id}`, JSON.stringify(s.errors || []));
      }
    }
  }
  return Promise.all(jobs);
}

export function whatsappRouter() {
  const r = express.Router();

  // Webhook verification (GET). One URL per tenant: /webhooks/whatsapp/:tenantId
  r.get('/:tenantId', (req, res) => {
    const tenant = getTenant(req.params.tenantId);
    const ok = tenant && req.query['hub.mode'] === 'subscribe' && safeEqual(req.query['hub.verify_token'], tenant.settings.whatsapp.verifyToken);
    if (ok) return res.status(200).send(String(req.query['hub.challenge']));
    return res.sendStatus(403);
  });

  r.post('/:tenantId', (req, res) => {
    const tenant = getTenant(req.params.tenantId);
    if (!tenant || !tenant.active) return res.sendStatus(404);
    if (!verifyMetaSignature(req.rawBody || Buffer.from(''), req.get('x-hub-signature-256'), tenant.settings.whatsapp.appSecret)) {
      return res.sendStatus(401);
    }
    res.sendStatus(200); // acknowledge fast; Meta retries if we take > ~10s
    processWebhookBody(req.body, { tenantOverride: tenant }).catch((e) => console.error('[webhook]', e));
  });

  return r;
}
