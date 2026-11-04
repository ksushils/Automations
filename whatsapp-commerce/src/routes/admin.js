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
import { listOrders, updateOrder, orderUpdateMessage, sendOrderUpdate } from '../bot/orders.js';
import { createStaff, listStaff, deleteStaff, authenticateStaff, ROLES } from '../staff.js';
import { toCsv, productsFromCsv } from '../csv.js';
import { analytics } from '../analytics.js';
import { listFlows, getFlow, saveFlow, deleteFlow, validateFlow, getContact, updateContact } from '../bot/flows.js';
import { createCampaign, listCampaigns, cancelCampaign, resolveAudience, campaignStats } from '../campaigns.js';
import { listTemplates, createTemplate, deleteTemplate, TEMPLATE_LIBRARY, numberHealth, getBusinessProfile, updateBusinessProfile, templateWarnings, cachedTemplates } from '../templates.js';
import { fetchMedia, logMessage } from '../whatsapp/cloudApi.js';
import { parseCsv } from '../csv.js';
import { goLiveChecklist } from '../goLive.js';
import { audit, listAudit, exportPerson, erasePerson, isSuppressed, rotateEncryption } from '../privacy.js';
import { currentKeyId } from '../crypto.js';
import { directConfigured } from '../ai/direct.js';
import { difyAllowed } from '../ai/gate.js';
import { estimateCampaign, monthEstimate } from '../metaPricing.js';
import { recordConsent, consentHistory, HAS_CONSENT_SQL } from '../consent.js';
import { billingInfo, createSubscriptionCheckout, createBillingPortal, billingConfigured, completeEmbeddedSignup, activateNumber, embeddedSignupConfigured, billingBanner } from '../platform.js';
import { rateLimit } from './web.js';
import { systemStatus, backup, alert } from '../ops.js';
import { provisionDifyBot, listDifyModels, consoleConfigured, buildPrompt, buildAgentPrompt, knowledgeChanged } from '../dify/provision.js';
import { listDocs, addTextDoc, addFileDoc, removeDoc, importUrl, onboardFromWebsite, searchKnowledge } from '../knowledge.js';

const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
const isSuper = (req) => [config.superAdminKey, ...(config.superAdminKeysExtra || [])].filter((k) => k && k.length >= 16).some((k) => safeEqual(bearer(req), k));

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

  // ----- audit trail: every change and every data export (values are not stored, only which fields) -----
  r.use((req, res, next) => {
    const auditable = req.method !== 'GET' || /\/export\/|\/contacts\/[^/]+\/export|\/media\//.test(req.path);
    if (!auditable || /\/simulate$|^\/signup$/.test(req.path)) return next();
    res.on('finish', () => {
      const m = req.path.match(/^\/tenants\/([^/]+)/);
      try {
        audit({
          tenantId: m?.[1] || null,
          actor: req.staff?.name || (req.isSuper ? 'super-admin' : req.role === 'owner' ? 'owner' : 'unknown'),
          role: req.isSuper ? 'super' : req.role || null,
          action: `${req.method} ${req.path.replace(/^\/tenants\/[^/]+/, '/tenants/:id')}`,
          target: req.path,
          detail: req.body && typeof req.body === 'object' ? { fields: Object.keys(req.body).slice(0, 30) } : null,
          ip: req.ip,
          status: res.statusCode,
        });
      } catch (e) { console.warn('[audit]', e.message); }
    });
    next();
  });

  r.get('/plans', (req, res) => res.json({ plans: PLANS, storeTypes: STORE_TYPES, signupEnabled: config.signupEnabled, billing: billingConfigured(), trialDays: config.trialDays, productName: config.productName, supportEmail: config.supportEmail }));
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
    // Website given → detect the shop, connect its catalogue, import policy/FAQ pages; then build the AI chatbot
    const website = String(req.body?.website || '').trim();
    (async () => {
      if (website) await onboardFromWebsite(tenant.id, website).catch((e) => console.warn('[signup onboarding]', e.message));
      if (consoleConfigured() && config.difyLicensed) await provisionDifyBot(tenant.id).catch((e) => console.warn('[signup ai]', e.message));
    })();
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
    if (consoleConfigured() && req.body.createAiBot !== false && (config.difyLicensed || req.body.difyAllowed)) {
      if (req.body.difyAllowed) updateTenantSettings(tenant.id, { difyAllowed: true });
      ai = await provisionDifyBot(tenant.id).then((r) => ({ created: true, ...r }), (e) => ({ created: false, reason: e.message }));
    }
    res.status(201).json({ tenant: view(getTenant(tenant.id)), adminKey, toolKey, ai, note: 'Store these keys now – they are not shown again.' });
  }));
  r.patch('/tenants/:tenantId/meta', requireSuper, (req, res) => {
    const t = updateTenantMeta(req.params.tenantId, req.body || {});
    t ? res.json({ tenant: view(t) }) : res.status(404).json({ error: 'not found' });
  });
  r.post('/tenants/:tenantId/rotate-keys', requireSuper, (req, res) => res.json(rotateKeys(req.params.tenantId)));
  r.get('/system/status', requireSuper, (req, res) => res.json(systemStatus()));
  r.get('/system/audit', requireSuper, (req, res) => res.json({ audit: listAudit(null, { limit: 500 }) }));
  r.post('/system/rotate-encryption', requireSuper, (req, res) => res.json({ ok: true, keyId: currentKeyId(), ...rotateEncryption() }));
  r.get('/system/dead-letters', requireSuper, (req, res) => res.json({ messages: getDb().prepare("SELECT tenant_id, wa_id, wa_message_id, attempts, created_at, body FROM messages WHERE direction = 'in' AND processed = -1 ORDER BY id DESC LIMIT 200").all().map((m) => ({ ...m, body: json(m.body, {}) })) }));
  r.post('/system/dead-letters/retry', requireSuper, (req, res) => res.json({ requeued: getDb().prepare("UPDATE messages SET processed = 0, attempts = 0, created_at = datetime('now', '-1 minute') WHERE direction = 'in' AND processed = -1").run().changes }));
  r.post('/system/backup', requireSuper, (req, res) => { try { res.json(backup() || { skipped: 'in-memory database' }); } catch (e) { res.status(500).json({ error: e.message }); } });
  r.delete('/tenants/:tenantId', requireSuper, (req, res) => { deleteTenant(req.params.tenantId); res.json({ ok: true }); });

  // ----- tenant scoped -----
  r.get('/tenants/:tenantId', requireTenant, (req, res) => res.json({ tenant: view(req.tenant), role: req.role, staffName: req.staff?.name || null, banner: billingBanner(req.tenant.id) }));

  // ----- knowledge base (RAG) -----
  const kbChanged = (id) => knowledgeChanged(id).catch((e) => console.warn('[knowledge sync]', e.message));
  const kbErr = (res, e) => res.status(e.status || 400).json({ error: e.message });
  r.get('/tenants/:tenantId/knowledge', requireTenant, (req, res) => {
    const d = req.tenant.settings.dify || {};
    const prov = req.tenant.settings.ai?.provider || (d.enabled && d.apiKey ? 'dify' : 'direct');
    res.json({ provider: prov, docs: listDocs(req.tenant.id), limit: PLANS[req.tenant.plan]?.knowledgeDocs ?? 20, aiConnected: consoleConfigured(), datasetId: d.datasetId || null, attached: !!d.datasetAttached && d.datasetAttached === d.datasetId });
  });
  r.post('/tenants/:tenantId/knowledge/text', requireTenant, requireOwner, (req, res) => {
    try { res.status(201).json({ doc: addTextDoc(req.tenant.id, { name: req.body?.name, text: req.body?.text }) }); kbChanged(req.tenant.id); } catch (e) { kbErr(res, e); }
  });
  r.post('/tenants/:tenantId/knowledge/file', requireTenant, requireOwner, (req, res) => {
    try {
      const buffer = Buffer.from(String(req.body?.contentBase64 || ''), 'base64');
      res.status(201).json({ doc: addFileDoc(req.tenant.id, { filename: req.body?.filename, mime: req.body?.mime, buffer }) });
      kbChanged(req.tenant.id);
    } catch (e) { kbErr(res, e); }
  });
  r.post('/tenants/:tenantId/knowledge/url', requireTenant, requireOwner, wrap(async (req, res) => {
    const urls = (Array.isArray(req.body?.urls) ? req.body.urls : [req.body?.url]).map((u) => String(u || '').trim()).filter(Boolean).slice(0, 20);
    if (!urls.length) return res.status(400).json({ error: 'Enter a web page address' });
    const results = [];
    for (const u of urls) results.push(await importUrl(req.tenant.id, /^https?:\/\//.test(u) ? u : `https://${u}`).then((doc) => ({ url: u, ok: true, doc }), (e) => ({ url: u, ok: false, error: e.message })));
    if (results.some((x) => x.ok)) kbChanged(req.tenant.id);
    res.json({ results });
  }));
  r.delete('/tenants/:tenantId/knowledge/:docId', requireTenant, requireOwner, (req, res) => { res.json({ ok: removeDoc(req.tenant.id, req.params.docId) }); kbChanged(req.tenant.id); });
  r.post('/tenants/:tenantId/knowledge/sync', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json({ ok: true, ...(await knowledgeChanged(req.tenant.id)) }); } catch (e) { res.json({ ok: false, error: e.message }); }
  }));
  r.get('/tenants/:tenantId/knowledge/search', requireTenant, (req, res) => res.json({ hits: searchKnowledge(req.tenant.id, req.query.q, { limit: 3 }) }));
  r.post('/tenants/:tenantId/onboarding/website', requireTenant, requireOwner, wrap(async (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Enter your website address' });
    try {
      const out = await onboardFromWebsite(req.tenant.id, url);
      kbChanged(req.tenant.id);
      res.json({ ok: true, ...out, tenant: view(getTenant(req.tenant.id)) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  }));

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
      res.json({ ok: true, numberStatus: r2.numberStatus, message: r2.message || null, displayPhoneNumber: r2.displayPhoneNumber || null, verifiedName: r2.verifiedName || null, tenant: view(r2.tenant) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  }));
  r.post('/tenants/:tenantId/whatsapp/refresh-number', requireTenant, requireOwner, wrap(async (req, res) => {
    try {
      const r2 = await activateNumber(req.tenant.id, {});
      res.json({ ok: true, numberStatus: r2.numberStatus, message: r2.message || null, displayPhoneNumber: r2.displayPhoneNumber || null, tenant: view(r2.tenant) });
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
    if (opted_in_marketing !== undefined) {
      if (opted_in_marketing && !String(req.body?.consentNote || '').trim()) return res.status(400).json({ error: 'Say how this person agreed (e.g. "signed up in shop 3 Nov, paper form")' });
      recordConsent(req.tenant.id, req.params.waId, { status: opted_in_marketing ? 'granted' : 'withdrawn', source: 'staff', wording: req.body?.consentWording || null, evidence: req.body?.consentNote || 'removed by staff', actor: req.staff?.name || 'owner' });
    }
    if (name) getDb().prepare('UPDATE customers SET name = ? WHERE tenant_id = ? AND wa_id = ?').run(String(name).slice(0, 120), req.tenant.id, req.params.waId);
    res.json({ contact: updateContact(req.tenant.id, req.params.waId, { addTags, removeTags, attributes }) });
  });
  r.post('/tenants/:tenantId/contacts/import', requireTenant, requireOwner, (req, res) => {
    // columns: phone,name,email,tags (separated by ;),opt_in (yes/no) – any other column becomes an attribute
    const rows = parseCsv(req.body?.csv || '');
    let imported = 0, consented = 0;
    const errors = [];
    // Opt-ins are only imported with a declaration of where consent came from (kept in the ledger as evidence)
    const decl = req.body?.consentDeclaration || {};
    const declared = decl.confirmed === true && String(decl.source || '').trim().length >= 3 && String(decl.wording || '').trim().length >= 10;
    rows.forEach((r, i) => {
      const wa = String(r.phone || r.whatsapp || r.wa_id || '').replace(/\D/g, '').replace(/^0(?=7)/, '44');
      if (wa.length < 8) return errors.push(`line ${i + 2}: invalid phone "${r.phone || ''}"`);
      const { phone, whatsapp, wa_id, name, email, tags, opt_in, ...attrs } = r;
      const { consent_date, consent_source, ...rest } = attrs;
      getDb().prepare(`INSERT INTO customers (tenant_id, wa_id, name, email) VALUES (?, ?, ?, ?)
        ON CONFLICT(tenant_id, wa_id) DO UPDATE SET name = COALESCE(excluded.name, customers.name), email = COALESCE(excluded.email, customers.email)`)
        .run(req.tenant.id, wa, name || null, email || null);
      if (/^(y|yes|true|1)$/i.test(opt_in || '') && declared && isSuppressed(req.tenant.id, wa)) { errors.push(`line ${i + 2}: ${r.phone} previously opted out / asked to be erased – not opted in`); }
      else if (/^(y|yes|true|1)$/i.test(opt_in || '') && declared) {
        recordConsent(req.tenant.id, wa, { status: 'granted', source: `import:${String(consent_source || decl.source).slice(0, 60)}`, wording: decl.wording, evidence: `CSV import ${new Date().toISOString().slice(0, 10)}${consent_date ? `; consented ${consent_date}` : ''}`, actor: req.staff?.name || 'owner' });
        consented++;
      }
      updateContact(req.tenant.id, wa, { addTags: String(tags || '').split(/[;|]/).map((t) => t.trim()).filter(Boolean), attributes: Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== '')) });
      imported++;
    });
    res.json({ imported, consented, errors: errors.slice(0, 20), note: declared ? `${consented} contact(s) opted in with your consent declaration recorded.` : 'Contacts were imported WITHOUT marketing consent. To import opt-ins, confirm where the consent came from and the wording people agreed to.' });
  });
  r.get('/tenants/:tenantId/audit', requireTenant, requireOwner, (req, res) => res.json({ audit: listAudit(req.tenant.id) }));
  r.get('/tenants/:tenantId/contacts/:waId/export', requireTenant, requireOwner, (req, res) => {
    res.attachment(`data-export-${req.params.waId}.json`).json(exportPerson(req.tenant.id, req.params.waId));
  });
  r.post('/tenants/:tenantId/contacts/:waId/erase', requireTenant, requireOwner, (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Send {"confirm": true} to permanently erase this person\'s data' });
    res.json({ ok: true, erased: erasePerson(req.tenant.id, req.params.waId), note: 'Chats and contact deleted, orders anonymised (kept for accounting), consent kept as a hashed suppression record.' });
  });
  r.get('/tenants/:tenantId/contacts/:waId/consent', requireTenant, (req, res) => res.json({ history: consentHistory(req.tenant.id, req.params.waId) }));
  r.get('/tenants/:tenantId/export/consent.csv', requireTenant, requireOwner, (req, res) => {
    const rows = getDb().prepare('SELECT wa_id, status, source, wording, evidence, actor, created_at FROM consents WHERE tenant_id = ? ORDER BY id').all(req.tenant.id);
    res.type('text/csv').attachment(`consent-ledger-${req.tenant.id}.csv`).send(toCsv(rows, [{ key: 'wa_id', label: 'whatsapp' }, { key: 'status' }, { key: 'source' }, { key: 'wording' }, { key: 'evidence' }, { key: 'actor' }, { key: 'created_at' }]));
  });

  // ----- campaigns (scheduled broadcasts, segments, retargeting) -----
  r.get('/tenants/:tenantId/campaigns', requireTenant, (req, res) => res.json({ campaigns: listCampaigns(req.tenant.id) }));
  r.post('/tenants/:tenantId/campaigns/preview', requireTenant, (req, res) => {
    const list = resolveAudience(req.tenant.id, req.body?.audience || {});
    const cat = cachedTemplates(req.tenant.id)[req.body?.template]?.category || req.body?.category || 'MARKETING';
    res.json({ recipients: list.length, cost: estimateCampaign(list, String(cat).toLowerCase() === 'utility' ? 'utility' : 'marketing') });
  });
  r.get('/tenants/:tenantId/meta-costs', requireTenant, (req, res) => res.json(monthEstimate(req.tenant.id)));
  r.post('/tenants/:tenantId/campaigns', requireTenant, requireOwner, (req, res) => {
    if (!PLANS[req.tenant.plan]?.broadcasts && !req.isSuper) return res.status(403).json({ error: 'Campaigns are not included in this plan' });
    if (!req.body?.template) return res.status(400).json({ error: 'template required' });
    const tpl = cachedTemplates(req.tenant.id)[req.body.template];
    if (tpl && tpl.category === 'MARKETING' && !tpl.optOut) return res.status(400).json({ error: `Template "${req.body.template}" has no opt-out. Marketing messages must include a "Stop offers" button or "Reply STOP" (UK PECR). Add one and resubmit the template.` });
    try { res.status(201).json({ campaign: createCampaign(req.tenant.id, req.body), category: tpl?.category || 'unknown' }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.post('/tenants/:tenantId/campaigns/:cid/cancel', requireTenant, requireOwner, (req, res) => res.json({ ok: cancelCampaign(req.tenant.id, req.params.cid) }));
  r.get('/tenants/:tenantId/campaigns/:cid', requireTenant, (req, res) => res.json({ stats: campaignStats(req.tenant.id, req.params.cid) }));

  // ----- WhatsApp templates (Meta) -----
  r.get('/tenants/:tenantId/templates', requireTenant, wrap(async (req, res) => {
    try { res.json({ templates: await listTemplates(req.tenant), library: TEMPLATE_LIBRARY }); } catch (e) { res.json({ templates: [], library: TEMPLATE_LIBRARY, error: e.message }); }
  }));
  r.post('/tenants/:tenantId/templates', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json({ ok: true, warnings: templateWarnings(req.body || {}), result: await createTemplate(req.tenant, req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); }
  }));
  r.delete('/tenants/:tenantId/templates/:name', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json({ ok: true, result: await deleteTemplate(req.tenant, req.params.name) }); } catch (e) { res.status(400).json({ error: e.message }); }
  }));

  // ----- WhatsApp number health, business profile, inbound media -----
  r.get('/tenants/:tenantId/whatsapp/checklist', requireTenant, wrap(async (req, res) => res.json(await goLiveChecklist(req.tenant))));
  r.get('/tenants/:tenantId/whatsapp/health', requireTenant, wrap(async (req, res) => {
    try { res.json({ ok: true, health: await numberHealth(req.tenant) }); } catch (e) { res.json({ ok: false, error: e.message }); }
  }));
  r.get('/tenants/:tenantId/whatsapp/profile', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json({ ok: true, profile: await getBusinessProfile(req.tenant) }); } catch (e) { res.json({ ok: false, error: e.message }); }
  }));
  r.post('/tenants/:tenantId/whatsapp/profile', requireTenant, requireOwner, wrap(async (req, res) => {
    try { await updateBusinessProfile(req.tenant, req.body || {}); res.json({ ok: true }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  }));
  r.get('/tenants/:tenantId/media/:mediaId', requireTenant, wrap(async (req, res) => {
    // only media that this tenant actually received
    const known = getDb().prepare("SELECT 1 FROM messages WHERE tenant_id = ? AND direction = 'in' AND body LIKE ? LIMIT 1").get(req.tenant.id, `%"mediaId":"${String(req.params.mediaId).replace(/[%_"]/g, '')}"%`);
    if (!known) return res.sendStatus(404);
    try { const m = await fetchMedia(req.tenant, req.params.mediaId); res.type(m.mime).set('Cache-Control', 'private, max-age=3600').send(m.body); } catch (e) { res.status(502).json({ error: e.message }); }
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
    if (!req.isSuper) delete patch.difyAllowed; // only the platform operator can grant Dify
    if (!req.isSuper && patch.ai?.provider === 'dify' && !difyAllowed(req.tenant)) return res.status(403).json({ error: 'The Dify engine is not available for this shop – use the built-in (Direct) AI.' });
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
    const a = req.tenant.settings.ai || {};
    const provider = (a.provider === 'dify' || (!a.provider && req.tenant.settings.dify?.enabled && req.tenant.settings.dify?.apiKey)) && difyAllowed(req.tenant) ? 'dify' : 'direct';
    const agent = (provider === 'direct' ? a.mode : req.tenant.settings.dify?.mode) === 'agent';
    res.json({ ...models, difyAllowed: difyAllowed(req.tenant), provider, direct: { configured: directConfigured(), defaultModel: config.aiModel, baseUrl: config.aiBaseUrl, embeddings: !!config.embeddingsModel, zeroRetention: config.aiZeroRetention, providers: config.aiProviderOrder }, prompt: agent ? buildAgentPrompt(req.tenant) : buildPrompt(req.tenant), dify: redactSettings(req.tenant.settings).dify, publicUrl: config.publicUrl });
  }));
  r.post('/tenants/:tenantId/ai/provision', requireTenant, requireOwner, wrap(async (req, res) => {
    if (!req.isSuper && !difyAllowed(req.tenant)) return res.status(403).json({ ok: false, error: 'The Dify engine is not available for this shop – use the built-in (Direct) AI.' });
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
    logMessage(req.tenant.id, waId, 'in', { type: ev.kind, text: ev.kind === 'text' ? ev.text : `[${ev.id}]`, simulated: true }); // history for the AI, like real chats
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
      notified = await sendOrderUpdate(req.tenant, o).then((r) => (r === 'outside_window' ? 'customer is outside the 24h window – set an order_update template in Settings → Notifications' : true), (e) => e.message);
    }
    res.json({ order: o, notified });
  }));

  // Conversations / inbox
  r.get('/tenants/:tenantId/conversations', requireTenant, (req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT c.wa_id, c.state, c.human_handover, c.cart, c.updated_at, c.assigned_to, cu.name,
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
  r.post('/tenants/:tenantId/conversations/:waId/assign', requireTenant, (req, res) => {
    const to = req.body?.to ? String(req.body.to).slice(0, 80) : null;
    getDb().prepare('UPDATE conversations SET assigned_to = ? WHERE tenant_id = ? AND wa_id = ?').run(to, req.tenant.id, req.params.waId);
    res.json({ ok: true, assignedTo: to });
  });
  r.get('/tenants/:tenantId/agents', requireTenant, (req, res) => res.json({ agents: ['Owner', ...listStaff(req.tenant.id).map((m) => m.name)], me: req.staff?.name || 'Owner' }));
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
      : getDb().prepare(`SELECT c.wa_id FROM customers c WHERE c.tenant_id = ? AND c.opted_in_marketing = 1 AND ${HAS_CONSENT_SQL}`).all(req.tenant.id).map((r) => r.wa_id);
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
    alert(`API error on ${req.method} ${req.path}: ${err.message}`, { key: `api:${req.path}:${err.message}` });
    res.status(500).json({ error: err.message });
  });
  return r;
}
