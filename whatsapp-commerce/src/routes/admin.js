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
import { createStaff, listStaff, deleteStaff, authenticateStaff, ROLES } from '../staff.js';
import { toCsv, productsFromCsv } from '../csv.js';
import { analytics } from '../analytics.js';
import { listFlows, getFlow, saveFlow, deleteFlow, validateFlow, getContact, updateContact } from '../bot/flows.js';
import { createCampaign, listCampaigns, cancelCampaign, resolveAudience, campaignStats } from '../campaigns.js';
import { listTemplates, createTemplate, deleteTemplate, TEMPLATE_LIBRARY } from '../templates.js';
import { parseCsv } from '../csv.js';
import { billingInfo, createSubscriptionCheckout, createBillingPortal, billingConfigured, completeEmbeddedSignup, embeddedSignupConfigured } from '../platform.js';
import { rateLimit } from './web.js';
import { provisionDifyBot, listDifyModels, consoleConfigured, buildPrompt, buildAgentPrompt } from '../dify/provision.js';

const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
const isSuper = (req) => !!config.superAdminKey && safeEqual(bearer(req), config.superAdminKey);

function requireSuper(req, res, next) {
  if (!isSuper(req)) return res.status(401).json({ error: 'super admin key required' });
  next();
}

function requireTenant(req, res, next) {
  const id = req.params.tenantId;
  req.isSuper = isSuper(req);
  if (req.isSuper || authenticateAdminKey(id, bearer(req))) req.role = 'owner';
  else {
    const staff = authenticateStaff(id, bearer(req));
    if (!staff) return res.status(401).json({ error: 'invalid key for this tenant' });
    req.role = staff.role;
    req.staff = staff;
  }
  req.tenant = getTenant(id);
  if (!req.tenant) return res.status(404).json({ error: 'tenant not found' });
  next();
}

function requireOwner(req, res, next) {
  if (req.role !== 'owner') return res.status(403).json({ error: 'only the shop owner can do this' });
  next();
}

const urls = (t) => ({
  whatsappWebhook: `${config.publicUrl}/webhooks/whatsapp/${t.id}`,
  difyToolsServer: `${config.publicUrl}/tools`,
  storeWebhook: `${config.publicUrl}/webhooks/store/${t.id}/${t.settings.storeWebhookSecret}`,
  dashboard: `${config.publicUrl}/admin`,
  storefront: `${config.publicUrl}/s/${t.id}`,
  stripeWebhook: `${config.publicUrl}/webhooks/stripe/${t.id}`,
});

const view = (t) => ({ id: t.id, name: t.name, plan: t.plan, active: t.active, createdAt: t.createdAt, settings: redactSettings(t.settings), usage: getUsage(t.id), planLimits: PLANS[t.plan], urls: urls(t) });

export function adminRouter() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  r.get('/plans', (req, res) => res.json({ plans: PLANS, storeTypes: STORE_TYPES, signupEnabled: config.signupEnabled, billing: billingConfigured(), trialDays: config.trialDays }));
  r.get('/meta/config', (req, res) => res.json({ enabled: embeddedSignupConfigured(), appId: config.metaAppId || null, configId: config.metaConfigId || null, graphVersion: config.graphVersion }));

  // ----- public self-serve sign-up -----
  r.post('/signup', rateLimit({ windowMs: 3600000, max: 5 }), wrap(async (req, res) => {
    if (!config.signupEnabled) return res.status(403).json({ error: 'Sign-up is closed' });
    const name = String(req.body?.business || '').trim().slice(0, 80);
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
    if (name.length < 2) return res.status(400).json({ error: 'Please enter your business name' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
    if (!req.body?.acceptTerms) return res.status(400).json({ error: 'Please accept the terms' });
    const plan = PLANS[req.body?.plan] ? req.body.plan : 'starter';
    const { tenant, adminKey } = createTenant({ name, plan });
    getDb().prepare("UPDATE tenants SET owner_email = ?, trial_ends_at = datetime('now', ?), subscription_status = 'trialing' WHERE id = ?").run(email, `+${config.trialDays} days`, tenant.id);
    if (consoleConfigured()) provisionDifyBot(tenant.id).catch((e) => console.warn('[signup ai]', e.message));
    let checkoutUrl = null;
    if (billingConfigured() && config.stripePrices[plan]) checkoutUrl = await createSubscriptionCheckout(getTenant(tenant.id), plan).catch((e) => { console.warn('[signup billing]', e.message); return null; });
    res.status(201).json({ tenantId: tenant.id, adminKey, checkoutUrl, trialDays: config.trialDays });
  }));

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
  r.get('/tenants/:tenantId', requireTenant, (req, res) => res.json({ tenant: view(req.tenant), role: req.role, staffName: req.staff?.name || null }));

  // ----- billing (your SaaS subscription) -----
  r.get('/tenants/:tenantId/billing', requireTenant, requireOwner, (req, res) => res.json({ billing: billingInfo(req.tenant.id), plans: PLANS }));
  r.post('/tenants/:tenantId/billing/checkout', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json({ url: await createSubscriptionCheckout(req.tenant, req.body?.plan) }); } catch (e) { res.status(400).json({ error: e.message }); }
  }));
  r.post('/tenants/:tenantId/billing/portal', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json({ url: await createBillingPortal(req.tenant) }); } catch (e) { res.status(400).json({ error: e.message }); }
  }));

  // ----- connect WhatsApp via Meta Embedded Signup -----
  r.post('/tenants/:tenantId/whatsapp/embedded', requireTenant, requireOwner, wrap(async (req, res) => {
    try {
      const r2 = await completeEmbeddedSignup(req.tenant.id, req.body || {});
      res.json({ ok: true, displayPhoneNumber: r2.displayPhoneNumber, verifiedName: r2.verifiedName, tenant: view(r2.tenant) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  }));

  // ----- team (staff logins) -----
  r.get('/tenants/:tenantId/staff', requireTenant, requireOwner, (req, res) => res.json({ staff: listStaff(req.tenant.id), roles: ROLES }));
  r.post('/tenants/:tenantId/staff', requireTenant, requireOwner, (req, res) => {
    if (!req.body?.name) return res.status(400).json({ error: 'name required' });
    res.status(201).json({ ...createStaff(req.tenant.id, req.body), note: 'Give this key to the team member – it is shown once.' });
  });
  r.delete('/tenants/:tenantId/staff/:staffId', requireTenant, requireOwner, (req, res) => { deleteStaff(req.tenant.id, Number(req.params.staffId)); res.json({ ok: true }); });

  // ----- automations (flow builder) -----
  r.get('/tenants/:tenantId/flows', requireTenant, (req, res) => res.json({ flows: listFlows(req.tenant.id) }));
  r.get('/tenants/:tenantId/flows/:flowId', requireTenant, (req, res) => {
    const f = getFlow(req.tenant.id, req.params.flowId);
    f ? res.json({ flow: f }) : res.status(404).json({ error: 'not found' });
  });
  const putFlow = (req, res) => {
    const f = { ...(req.body || {}), id: req.params.flowId || undefined };
    const errors = validateFlow(f);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    if (f.id && !getFlow(req.tenant.id, f.id)) return res.status(404).json({ error: 'not found' });
    res.json({ flow: saveFlow(req.tenant.id, f) });
  };
  r.post('/tenants/:tenantId/flows', requireTenant, requireOwner, putFlow);
  r.put('/tenants/:tenantId/flows/:flowId', requireTenant, requireOwner, putFlow);
  r.delete('/tenants/:tenantId/flows/:flowId', requireTenant, requireOwner, (req, res) => { deleteFlow(req.tenant.id, req.params.flowId); res.json({ ok: true }); });

  // ----- contacts (tags, attributes, import) -----
  r.get('/tenants/:tenantId/contacts', requireTenant, (req, res) => {
    const q = `%${String(req.query.q || '').toLowerCase()}%`;
    const tag = String(req.query.tag || '').toLowerCase();
    const rows = getDb().prepare(`SELECT wa_id, name, email, tags, attributes, source, opted_in_marketing, created_at, last_seen_at FROM customers WHERE tenant_id = ? AND (LOWER(COALESCE(name,'')) LIKE ? OR wa_id LIKE ?) ORDER BY last_seen_at DESC LIMIT 2000`).all(req.tenant.id, q, q)
      .map((c) => ({ ...c, tags: json(c.tags, []), attributes: json(c.attributes, {}), source: json(c.source, null) }))
      .filter((c) => !tag || c.tags.includes(tag));
    const allTags = [...new Set(getDb().prepare('SELECT tags FROM customers WHERE tenant_id = ?').all(req.tenant.id).flatMap((r) => json(r.tags, [])))].sort();
    res.json({ contacts: rows, tags: allTags });
  });
  r.patch('/tenants/:tenantId/contacts/:waId', requireTenant, (req, res) => {
    const { addTags, removeTags, attributes, opted_in_marketing, name } = req.body || {};
    if (!getContact(req.tenant.id, req.params.waId)) return res.status(404).json({ error: 'not found' });
    if (opted_in_marketing !== undefined) getDb().prepare('UPDATE customers SET opted_in_marketing = ? WHERE tenant_id = ? AND wa_id = ?').run(opted_in_marketing ? 1 : 0, req.tenant.id, req.params.waId);
    if (name) getDb().prepare('UPDATE customers SET name = ? WHERE tenant_id = ? AND wa_id = ?').run(String(name).slice(0, 120), req.tenant.id, req.params.waId);
    res.json({ contact: updateContact(req.tenant.id, req.params.waId, { addTags, removeTags, attributes }) });
  });
  r.post('/tenants/:tenantId/contacts/import', requireTenant, requireOwner, (req, res) => {
    // columns: phone,name,email,tags (separated by ;),opt_in (yes/no) – any other column becomes an attribute
    const rows = parseCsv(req.body?.csv || '');
    let imported = 0;
    const errors = [];
    rows.forEach((r, i) => {
      const wa = String(r.phone || r.whatsapp || r.wa_id || '').replace(/\D/g, '').replace(/^0(?=7)/, '44');
      if (wa.length < 8) return errors.push(`line ${i + 2}: invalid phone "${r.phone || ''}"`);
      const { phone, whatsapp, wa_id, name, email, tags, opt_in, ...attrs } = r;
      getDb().prepare(`INSERT INTO customers (tenant_id, wa_id, name, email, opted_in_marketing) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, wa_id) DO UPDATE SET name = COALESCE(excluded.name, customers.name), email = COALESCE(excluded.email, customers.email), opted_in_marketing = excluded.opted_in_marketing`)
        .run(req.tenant.id, wa, name || null, email || null, /^(y|yes|true|1)$/i.test(opt_in || '') ? 1 : 0);
      updateContact(req.tenant.id, wa, { addTags: String(tags || '').split(/[;|]/).map((t) => t.trim()).filter(Boolean), attributes: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== '')) });
      imported++;
    });
    res.json({ imported, errors: errors.slice(0, 20), note: 'Only contacts with opt_in = yes receive marketing campaigns (WhatsApp policy).' });
  });

  // ----- campaigns (scheduled broadcasts, segments, retargeting) -----
  r.get('/tenants/:tenantId/campaigns', requireTenant, (req, res) => res.json({ campaigns: listCampaigns(req.tenant.id) }));
  r.post('/tenants/:tenantId/campaigns/preview', requireTenant, (req, res) => res.json({ recipients: resolveAudience(req.tenant.id, req.body?.audience || {}).length }));
  r.post('/tenants/:tenantId/campaigns', requireTenant, requireOwner, (req, res) => {
    if (!PLANS[req.tenant.plan]?.broadcasts && !req.isSuper) return res.status(403).json({ error: 'Campaigns are not included in this plan' });
    if (!req.body?.template) return res.status(400).json({ error: 'template required' });
    try { res.status(201).json({ campaign: createCampaign(req.tenant.id, req.body) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.post('/tenants/:tenantId/campaigns/:cid/cancel', requireTenant, requireOwner, (req, res) => res.json({ ok: cancelCampaign(req.tenant.id, req.params.cid) }));
  r.get('/tenants/:tenantId/campaigns/:cid', requireTenant, (req, res) => res.json({ stats: campaignStats(req.tenant.id, req.params.cid) }));

  // ----- WhatsApp templates (Meta) -----
  r.get('/tenants/:tenantId/templates', requireTenant, wrap(async (req, res) => {
    try { res.json({ templates: await listTemplates(req.tenant), library: TEMPLATE_LIBRARY }); } catch (e) { res.json({ templates: [], library: TEMPLATE_LIBRARY, error: e.message }); }
  }));
  r.post('/tenants/:tenantId/templates', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json({ ok: true, result: await createTemplate(req.tenant, req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); }
  }));
  r.delete('/tenants/:tenantId/templates/:name', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json({ ok: true, result: await deleteTemplate(req.tenant, req.params.name) }); } catch (e) { res.status(400).json({ error: e.message }); }
  }));

  // ----- developer API: send a message -----
  r.post('/tenants/:tenantId/messages', requireTenant, requireOwner, wrap(async (req, res) => {
    const to = String(req.body?.to || '').replace(/\D/g, '');
    const { text, template } = req.body || {};
    if (!to || (!text && !template?.name)) return res.status(400).json({ error: 'to and (text or template.name) required' });
    try {
      const r2 = await createSender(req.tenant)(to, template?.name ? { type: 'template', name: template.name, language: template.language || 'en_GB', components: template.components } : { type: 'text', text: String(text) });
      res.json({ ok: true, id: r2?.messages?.[0]?.id || null });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  }));

  // ----- analytics & exports -----
  r.get('/tenants/:tenantId/analytics', requireTenant, (req, res) => res.json(analytics(req.tenant.id, req.query.days)));
  r.get('/tenants/:tenantId/export/orders.csv', requireTenant, (req, res) => {
    const rows = listOrders(req.tenant.id, { limit: 100000 });
    res.type('text/csv').attachment(`orders-${req.tenant.id}.csv`).send(toCsv(rows, [
      { key: 'store_order_name', label: 'order' }, { key: 'created_at' }, { key: 'status' }, { key: 'payment_status' }, { key: 'payment_method' },
      { key: 'customer_name' }, { key: 'wa_id', label: 'whatsapp' }, { key: 'fulfilment' }, { key: 'address' }, { key: 'slot' },
      { key: 'items', get: (o) => o.items.map((i) => `${i.title} x${i.quantity}`).join('; ') }, { key: 'promo_code' }, { key: 'discount' }, { key: 'delivery_fee' }, { key: 'subtotal', label: 'total' }, { key: 'currency' }, { key: 'notes' },
    ]));
  });
  r.get('/tenants/:tenantId/export/customers.csv', requireTenant, (req, res) => {
    const rows = getDb().prepare(`SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = c.tenant_id AND o.wa_id = c.wa_id AND o.status != 'cancelled') AS orders,
      (SELECT ROUND(COALESCE(SUM(subtotal),0),2) FROM orders o WHERE o.tenant_id = c.tenant_id AND o.wa_id = c.wa_id AND o.status != 'cancelled') AS spent FROM customers c WHERE c.tenant_id = ? ORDER BY c.id`).all(req.tenant.id);
    res.type('text/csv').attachment(`customers-${req.tenant.id}.csv`).send(toCsv(rows, [
      { key: 'name' }, { key: 'wa_id', label: 'whatsapp' }, { key: 'email' }, { key: 'address' }, { key: 'opted_in_marketing', label: 'offers_opt_in' }, { key: 'orders' }, { key: 'spent' }, { key: 'created_at', label: 'first_seen' }, { key: 'last_seen_at', label: 'last_seen' },
    ]));
  });
  r.post('/tenants/:tenantId/catalogue/import', requireTenant, requireOwner, (req, res) => {
    const { products, errors } = productsFromCsv(req.body?.csv || '');
    if (errors.length) return res.status(400).json({ error: 'CSV has problems', errors: errors.slice(0, 20) });
    const existing = req.tenant.settings.store?.manual || {};
    const merged = req.body?.replace ? products : [...(existing.products || []).filter((p) => !products.some((n) => n.id === String(p.id))), ...products];
    const keep = req.body?.replace ? [] : existing.categories || [];
    const cats = new Set(keep.map((c) => String(c.id)));
    const categories = [...keep];
    for (const p of products) if (!cats.has(p.category)) { cats.add(p.category); categories.push({ id: p.category, title: p.category.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }); }
    const t = updateTenantSettings(req.tenant.id, { store: { manual: { products: merged, categories } } });
    res.json({ imported: products.length, total: merged.length, tenant: view(t) });
  });

  r.patch('/tenants/:tenantId/settings', requireTenant, requireOwner, (req, res) => {
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
  r.get('/tenants/:tenantId/ai', requireTenant, requireOwner, wrap(async (req, res) => {
    const models = await listDifyModels().catch((e) => ({ configured: consoleConfigured(), models: [], error: e.message }));
    res.json({ ...models, prompt: req.tenant.settings.dify?.mode === 'agent' ? buildAgentPrompt(req.tenant) : buildPrompt(req.tenant), dify: redactSettings(req.tenant.settings).dify, publicUrl: config.publicUrl });
  }));
  r.post('/tenants/:tenantId/ai/provision', requireTenant, requireOwner, wrap(async (req, res) => {
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
  r.post('/tenants/:tenantId/broadcasts', requireTenant, requireOwner, wrap(async (req, res) => {
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
