import express from 'express';
import { config } from '../config.js';
import { getDb, redactSettings, json } from '../db.js';
import { safeEqual } from '../crypto.js';
import {
  PLANS, createTenant, getTenant, listTenants, updateTenantSettings, updateTenantMeta, rotateKeys, deleteTenant,
  authenticateAdminKey, getUsage,
} from '../tenants.js';
import { getStore, STORE_TYPES } from '../stores/index.js';
import { difyInfo } from '../dify/client.js';
import { createSender } from '../whatsapp/cloudApi.js';
import { handleInbound } from '../bot/engine.js';
import { enqueue } from '../whatsapp/webhook.js';
import { setHandover } from '../bot/state.js';
import { listOrders, updateOrder, orderUpdateMessage } from '../bot/orders.js';
import { provisionDifyBot, listDifyModels, consoleConfigured, buildPrompt, buildAgentPrompt } from '../dify/provision.js';

const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
const isSuper = (req) => !!config.superAdminKey && safeEqual(bearer(req), config.superAdminKey);

function requireSuper(req, res, next) {
  if (!isSuper(req)) return res.status(401).json({ error: 'super admin key required' });
  next();
}

function requireTenant(req, res, next) {
  const id = req.params.tenantId;
  if (!isSuper(req) && !authenticateAdminKey(id, bearer(req))) return res.status(401).json({ error: 'invalid key for this tenant' });
  req.tenant = getTenant(id);
  if (!req.tenant) return res.status(404).json({ error: 'tenant not found' });
  req.isSuper = isSuper(req);
  next();
}

const urls = (t) => ({
  whatsappWebhook: `${config.publicUrl}/webhooks/whatsapp/${t.id}`,
  difyToolsServer: `${config.publicUrl}/tools`,
  storeWebhook: `${config.publicUrl}/webhooks/store/${t.id}/${t.settings.storeWebhookSecret}`,
  dashboard: `${config.publicUrl}/admin`,
});

const view = (t) => ({ id: t.id, name: t.name, plan: t.plan, active: t.active, createdAt: t.createdAt, settings: redactSettings(t.settings), usage: getUsage(t.id), planLimits: PLANS[t.plan], urls: urls(t) });

export function adminRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  r.get('/plans', (req, res) => res.json({ plans: PLANS, storeTypes: STORE_TYPES }));

  // Who am I? Super admin gets tenant list, tenant admin gets their tenant.
  r.get('/whoami', (req, res) => res.json({ super: isSuper(req) }));

  // ----- super admin: tenant management -----
  r.get('/tenants', requireSuper, (req, res) => res.json({ tenants: listTenants().map(view) }));
  r.post('/tenants', requireSuper, wrap(async (req, res) => {
    if (!req.body?.name) return res.status(400).json({ error: 'name required' });
    const { tenant, adminKey, toolKey } = createTenant({ name: String(req.body.name).slice(0, 80), plan: req.body.plan });
    // Automatically create the client's AI chatbot in Dify (if console access is configured)
    let ai = { created: false, reason: 'Dify console access not configured on the server' };
    if (consoleConfigured() && req.body.createAiBot !== false) {
      ai = await provisionDifyBot(tenant.id).then((r) => ({ created: true, ...r }), (e) => ({ created: false, reason: e.message }));
    }
    res.status(201).json({ tenant: view(getTenant(tenant.id)), adminKey, toolKey, ai, note: 'Store these keys now – they are not shown again.' });
  }));
  r.patch('/tenants/:tenantId/meta', requireSuper, (req, res) => {
    const t = updateTenantMeta(req.params.tenantId, req.body || {});
    t ? res.json({ tenant: view(t) }) : res.status(404).json({ error: 'not found' });
  });
  r.post('/tenants/:tenantId/rotate-keys', requireSuper, (req, res) => res.json(rotateKeys(req.params.tenantId)));
  r.delete('/tenants/:tenantId', requireSuper, (req, res) => { deleteTenant(req.params.tenantId); res.json({ ok: true }); });

  // ----- tenant scoped -----
  r.get('/tenants/:tenantId', requireTenant, (req, res) => res.json({ tenant: view(req.tenant) }));

  r.patch('/tenants/:tenantId/settings', requireTenant, (req, res) => {
    const patch = req.body || {};
    delete patch.storeWebhookSecret;
    if (patch.store?.type && !STORE_TYPES.includes(patch.store.type)) return res.status(400).json({ error: 'invalid store type' });
    if (!req.isSuper && patch.store?.type && !(PLANS[req.tenant.plan]?.storeTypes || []).includes(patch.store.type)) return res.status(403).json({ error: 'store type not in plan' });
    const updated = updateTenantSettings(req.tenant.id, patch);
    // Keep the managed Dify bot's prompt in sync with the shop's settings
    if (req.query.sync !== '0' && updated.settings.dify?.managed && (patch.ai || patch.business || patch.ordering) && consoleConfigured()) {
      provisionDifyBot(updated.id).catch((e) => console.warn('[dify sync]', e.message));
    }
    res.json({ tenant: view(updated) });
  });

  // ----- AI assistant (Dify) -----
  r.get('/tenants/:tenantId/ai', requireTenant, wrap(async (req, res) => {
    const models = await listDifyModels().catch((e) => ({ configured: consoleConfigured(), models: [], error: e.message }));
    res.json({ ...models, prompt: req.tenant.settings.dify?.mode === 'agent' ? buildAgentPrompt(req.tenant) : buildPrompt(req.tenant), dify: redactSettings(req.tenant.settings).dify, publicUrl: config.publicUrl });
  }));
  r.post('/tenants/:tenantId/ai/provision', requireTenant, wrap(async (req, res) => {
    try {
      const mode = ['assist', 'agent'].includes(req.body?.mode) ? req.body.mode : undefined;
      res.json({ ok: true, ...(await provisionDifyBot(req.tenant.id, { mode })), tenant: view(getTenant(req.tenant.id)) });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
  }));

  r.post('/tenants/:tenantId/test/:what', requireTenant, wrap(async (req, res) => {
    const t = req.tenant;
    try {
      if (req.params.what === 'store') return res.json(await getStore(t).testConnection());
      if (req.params.what === 'dify') return res.json({ ok: true, app: await difyInfo(t.settings.dify) });
      if (req.params.what === 'whatsapp') {
        const to = String(req.body?.to || '').replace(/\D/g, '');
        if (!to) return res.status(400).json({ error: 'to (phone number) required' });
        await createSender(t)(to, { type: 'text', text: `✅ Test message from ${t.settings.business.name} WhatsApp ordering.` });
        return res.json({ ok: true });
      }
      res.status(404).json({ error: 'unknown test' });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
  }));

  // Simulator – chat with the bot from the dashboard without WhatsApp.
  r.post('/tenants/:tenantId/simulate', requireTenant, wrap(async (req, res) => {
    const waId = String(req.body?.waId || '440000000000').replace(/\D/g, '');
    const ev = req.body?.actionId
      ? { waId, kind: 'action', id: String(req.body.actionId), text: '' }
      : { waId, kind: 'text', text: String(req.body?.text || ''), profileName: 'Test Customer' };
    const sink = [];
    const send = createSender(req.tenant, { sink });
    const realSend = createSender(req.tenant);
    await enqueue(`${req.tenant.id}:${waId}`, () => handleInbound(req.tenant, ev, (to, m) => (to === waId ? send(to, m) : realSend(to, m))));
    res.json({ replies: sink });
  }));

  // Orders
  r.get('/tenants/:tenantId/orders', requireTenant, (req, res) => {
    res.json({ orders: listOrders(req.tenant.id, { limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0, status: req.query.status || undefined }) });
  });
  r.patch('/tenants/:tenantId/orders/:orderId', requireTenant, wrap(async (req, res) => {
    const o = updateOrder(req.tenant.id, Number(req.params.orderId), req.body || {});
    if (!o) return res.status(404).json({ error: 'not found' });
    let notified = false;
    if (req.body?.notify) {
      notified = await createSender(req.tenant)(o.wa_id, orderUpdateMessage(req.tenant, o)).then(() => true, (e) => e.message);
    }
    res.json({ order: o, notified });
  }));

  // Conversations / inbox
  r.get('/tenants/:tenantId/conversations', requireTenant, (req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT c.wa_id, c.state, c.human_handover, c.cart, c.updated_at, cu.name,
           (SELECT body FROM messages m WHERE m.tenant_id = c.tenant_id AND m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) AS last_body,
           (SELECT created_at FROM messages m WHERE m.tenant_id = c.tenant_id AND m.wa_id = c.wa_id AND direction = 'in' ORDER BY id DESC LIMIT 1) AS last_inbound_at
         FROM conversations c LEFT JOIN customers cu ON cu.tenant_id = c.tenant_id AND cu.wa_id = c.wa_id
         WHERE c.tenant_id = ? ORDER BY c.human_handover DESC, c.updated_at DESC LIMIT 200`,
      )
      .all(req.tenant.id)
      .map((r) => ({ ...r, cart: json(r.cart, []), last: json(r.last_body, {}) }));
    res.json({ conversations: rows });
  });
  r.get('/tenants/:tenantId/conversations/:waId/messages', requireTenant, (req, res) => {
    const rows = getDb().prepare('SELECT direction, type, body, created_at FROM messages WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC LIMIT 200').all(req.tenant.id, req.params.waId);
    res.json({ messages: rows.reverse().map((m) => ({ ...m, body: json(m.body, {}) })) });
  });
  r.post('/tenants/:tenantId/conversations/:waId/reply', requireTenant, wrap(async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    setHandover(req.tenant.id, req.params.waId, true);
    try {
      await createSender(req.tenant)(req.params.waId, { type: 'text', text });
      res.json({ ok: true });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message, hint: 'Outside the 24h customer-service window you must use an approved template (Broadcast).' });
    }
  }));
  r.post('/tenants/:tenantId/conversations/:waId/handover', requireTenant, (req, res) => {
    const c = setHandover(req.tenant.id, req.params.waId, !!req.body?.on);
    res.json({ ok: true, humanHandover: c.humanHandover });
  });

  // Customers + broadcasts (approved WhatsApp templates only)
  r.get('/tenants/:tenantId/customers', requireTenant, (req, res) => {
    res.json({ customers: getDb().prepare('SELECT wa_id, name, email, address, opted_in_marketing, created_at, last_seen_at FROM customers WHERE tenant_id = ? ORDER BY last_seen_at DESC LIMIT 1000').all(req.tenant.id) });
  });
  r.post('/tenants/:tenantId/broadcasts', requireTenant, wrap(async (req, res) => {
    if (!PLANS[req.tenant.plan]?.broadcasts && !req.isSuper) return res.status(403).json({ error: 'Broadcasts are not included in this plan' });
    const { template, language = 'en_GB', components, waIds } = req.body || {};
    if (!template) return res.status(400).json({ error: 'template (approved template name) required' });
    const recipients = Array.isArray(waIds) && waIds.length
      ? waIds.map((w) => String(w).replace(/\D/g, ''))
      : getDb().prepare('SELECT wa_id FROM customers WHERE tenant_id = ? AND opted_in_marketing = 1').all(req.tenant.id).map((r) => r.wa_id);
    const send = createSender(req.tenant);
    let sent = 0;
    const failed = [];
    for (const to of recipients) {
      try { await send(to, { type: 'template', name: template, language, components }); sent++; } catch (e) { failed.push({ to, error: e.message }); }
      await new Promise((r) => setTimeout(r, 60)); // gentle rate limiting
    }
    res.json({ recipients: recipients.length, sent, failed });
  }));

  r.use((err, req, res, _next) => {
    console.error('[admin]', err);
    res.status(500).json({ error: err.message });
  });
  return r;
}
