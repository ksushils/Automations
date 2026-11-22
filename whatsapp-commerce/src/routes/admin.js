import express from 'express';
import { config } from '../config.js';
import { getDb, redactSettings, json } from '../db.js';
import { safeEqual, sha256 } from '../crypto.js';
import { onboardingStatus, connectShopStripe } from '../onboarding.js';
import { refreshWebsite, refreshRunning, lastRefresh } from '../refresh.js';
import { sendEmail, alertEmails, emailConfigured, emailLog, retryEmail } from '../email.js';
import { siteAssistantKnowledge } from '../site.js';
import { setupStatus, savePlatformSetup, testAi, autoSetupStripe } from '../platformSetup.js';
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
import { valueReport, reportText, listUnanswered, getUnanswered, setUnanswered, assistantSales, adReport } from '../insights.js';
import { runQualityCheck, lastQuality, qualityRunning } from '../quality.js';
import { listBookings, setBookingStatus } from '../bookings.js';
import { claimDemo, isDemo } from '../instantDemo.js';
import { wordpressPlugin, detectPlatform } from '../install.js';
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
import { listChatLeads, setLeadStatus, leadSpeed } from '../leads.js';
import { sendHook, SHEETS_SCRIPT } from '../hooks.js';
import { TRADES, tradeList, applyTrade } from '../trades.js';
import { ratingSummary, ratingAsk, ratingsOn } from '../ratings.js';
import { isTyping, typingDraft, liveVisitors, sayHello } from './webchat.js';
import { teamStatus } from '../hours.js';
import { suggestReply, translateText } from '../ai/assist.js';
import { listArticles, getArticle, saveArticle, deleteArticle, draftArticles } from '../help.js';
import { searchGuides, askGuides } from '../platformHelp.js';
import { menuSuggestions, dismissSuggestion } from '../learn.js';
import { customerProfile, saveCustomerNotes } from '../profile.js';
import { vapidKeys, saveSubscription, removeSubscription, pushTeam, subscriptionCount } from '../push.js';
import { draftQuiz } from '../quiz.js';
import { listQuotes, getQuote, updateQuote, sendQuote } from '../quotes.js';
import { tenantReferrals, creditSignup, createPartner, allReferrals } from '../referrals.js';
import { listTickets, getTicket, ticketEvents, createTicket, updateTicket, ticketStats } from '../tickets.js';
import { googleConfigured, calendarConnected, authUrl, disconnectCalendar, redirectUri } from '../gcal.js';
import { resumeAi } from '../coexistence.js';
import { estimateCampaign, monthEstimate } from '../metaPricing.js';
import { recordConsent, consentHistory, HAS_CONSENT_SQL } from '../consent.js';
import { createTopupCheckout } from '../platform.js';
import { billingHistory } from '../platform.js';
import { checkConnection, connectionStatus, connectionBanner } from '../waHealth.js';
import { entitlements, staffSeatsLeft } from '../entitlements.js';
import { listOpportunities, setOpportunityState } from '../opportunities.js';
import { buildTwin } from '../businessTwin.js';
import { listAnswers, answerStats } from '../verified.js';
import { automationLog } from '../outreach.js';
import { askCopilot, SUGGESTIONS } from '../copilot.js';
import { resultsBreakdown } from '../results.js';
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

  r.get('/plans', (req, res) => res.json({ plans: PLANS, storeTypes: STORE_TYPES, signupEnabled: config.signupEnabled, billing: billingConfigured(), trialDays: config.trialDays, productName: config.productName, supportEmail: config.supportEmail, trades: tradeList() }));
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
    // Came from "your assistant in 60 seconds": keep that shop (everything it learnt) instead of starting empty
    const claimed = req.body?.demo ? claimDemo(String(req.body.demo), { name, email }) : null;
    const free = plan === 'free';
    const markFree = (id) => getDb().prepare("UPDATE tenants SET trial_ends_at = NULL, subscription_status = 'free' WHERE id = ?").run(id);
    if (claimed) {
      updateTenantMeta(claimed.tenant.id, { plan });
      if (req.body?.ref) creditSignup(claimed.tenant.id, String(req.body.ref));
      if (TRADES[req.body?.trade]) applyTrade(claimed.tenant.id, req.body.trade); // keeps the menu the demo already wrote
      if (free) markFree(claimed.tenant.id);
      const website = claimed.tenant.settings.business?.website;
      if (website) onboardFromWebsite(claimed.tenant.id, website).catch((e) => console.warn('[signup onboarding]', e.message)); // the rest of the site
      let checkoutUrl = null;
      if (!free && billingConfigured() && config.stripePrices[plan]) checkoutUrl = await createSubscriptionCheckout(getTenant(claimed.tenant.id), plan).catch(() => null);
      return res.status(201).json({ tenantId: claimed.tenant.id, adminKey: claimed.adminKey, checkoutUrl, trialDays: free ? 0 : config.trialDays, plan, fromDemo: true });
    }
    const { tenant, adminKey } = createTenant({ name, plan });
    if (req.body?.ref) creditSignup(tenant.id, String(req.body.ref));
    if (TRADES[req.body?.trade]) applyTrade(tenant.id, req.body.trade);
    getDb().prepare("UPDATE tenants SET owner_email = ?, trial_ends_at = datetime('now', ?), subscription_status = 'trialing' WHERE id = ?").run(email, `+${config.trialDays} days`, tenant.id);
    if (free) markFree(tenant.id);
    // Website given → detect the shop, connect its catalogue, import policy/FAQ pages; then build the AI chatbot
    const website = String(req.body?.website || '').trim();
    (async () => {
      if (website) await onboardFromWebsite(tenant.id, website).catch((e) => console.warn('[signup onboarding]', e.message));
      if (consoleConfigured() && config.difyLicensed) await provisionDifyBot(tenant.id).catch((e) => console.warn('[signup ai]', e.message));
    })();
    let checkoutUrl = null;
    if (!free && billingConfigured() && config.stripePrices[plan]) checkoutUrl = await createSubscriptionCheckout(getTenant(tenant.id), plan).catch((e) => { console.warn('[signup billing]', e.message); return null; });
    res.status(201).json({ tenantId: tenant.id, adminKey, checkoutUrl, trialDays: free ? 0 : config.trialDays, plan });
  }));

  // Who am I? Super admin gets tenant list, tenant admin gets their tenant.
  // One key is enough to sign in: we work out whether it's the super admin key, a shop owner key or a staff key.
  r.get('/whoami', (req, res) => {
    if (isSuper(req)) return res.json({ super: true, tenantId: null });
    const key = bearer(req);
    if (!key) return res.json({ super: false, tenantId: null });
    const d = getDb();
    const tenantId = d.prepare('SELECT id FROM tenants WHERE admin_key_hash = ?').get(sha256(key))?.id
      || (key.startsWith('stf_') ? d.prepare('SELECT tenant_id FROM staff WHERE key_hash = ?').get(sha256(key))?.tenant_id : null) || null;
    res.json({ super: false, tenantId });
  });

  // ----- super admin: guided platform setup (instead of editing .env) -----
  r.get('/system/setup', requireSuper, (req, res) => res.json(setupStatus()));
  r.patch('/system/setup', requireSuper, (req, res) => res.json(savePlatformSetup(req.body || {})));
  r.post('/system/setup/test-ai', requireSuper, wrap(async (req, res) => res.json(await testAi())));
  r.post('/system/setup/test-email', requireSuper, wrap(async (req, res) => {
    const to = String(req.body?.to || config.supportEmail || '').trim();
    res.json({ to, ...(await sendEmail({ to, subject: `Test email from ${config.productName}`, text: 'It works. Shops will get their order alerts like this.', html: '<p>✅ It works. Shops will get their order alerts like this.</p>' })) });
  }));
  // The assistant that answers on your own homepage: a shop whose knowledge is your website copy.
  r.post('/system/site-assistant', requireSuper, (req, res) => {
    const k = siteAssistantKnowledge();
    let id = config.siteChatTenant && getTenant(config.siteChatTenant) ? config.siteChatTenant : null;
    if (!id) id = createTenant({ name: `${config.productName} website`, plan: 'pro' }).tenant.id;
    updateTenantSettings(id, {
      business: { name: config.productName, welcomeMessage: `Hi! 👋 Ask me anything about ${config.productName}: what it does, pricing, WhatsApp costs or how set-up works.` },
      ai: { provider: 'direct', enabled: true, assistantName: `${config.productName} assistant`, tone: 'professional', about: k.about, faq: k.faq, instructions: k.instructions },
      webchat: { enabled: true, title: config.productName, subtitle: 'Ask us anything. This is the assistant itself.', greeting: 'Hi' },
    });
    res.json({ ok: true, tenantId: id, status: savePlatformSetup({ siteChatTenant: id }) });
  });
  r.get('/system/leads', requireSuper, (req, res) => res.json({
    leads: getDb().prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 200').all().map((l) => ({ ...l, data: json(l.data, {}) })),
    feeChecker: getDb().prepare('SELECT * FROM fee_checker_leads ORDER BY id DESC LIMIT 200').all().map((l) => ({ ...l, breakdown: json(l.breakdown, []) })),
  }));
  r.post('/system/setup/stripe-auto', requireSuper, wrap(async (req, res) => {
    try { res.json({ ok: true, ...(await autoSetupStripe()) }); } catch (e) { res.status(400).json({ error: e.message }); }
  }));

  // ----- super admin: tenant management -----
  r.get('/tenants', requireSuper, (req, res) => { const all = listTenants(); res.json({ tenants: all.filter((t) => req.query.demos === '1' || !isDemo(t)).map(view), demos: all.filter(isDemo).length }); });
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
  r.get('/system/email-log', requireSuper, (req, res) => res.json({ configured: emailConfigured(), emails: emailLog({ status: req.query.status ? String(req.query.status) : undefined, limit: 200 }) }));
  r.post('/system/email-log/:id/retry', requireSuper, wrap(async (req, res) => { try { res.json(await retryEmail(req.params.id)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } }));
  r.get('/system/audit', requireSuper, (req, res) => res.json({ audit: listAudit(null, { limit: 500 }) }));
  r.post('/system/rotate-encryption', requireSuper, (req, res) => res.json({ ok: true, keyId: currentKeyId(), ...rotateEncryption() }));
  r.get('/system/dead-letters', requireSuper, (req, res) => res.json({ messages: getDb().prepare("SELECT tenant_id, wa_id, wa_message_id, attempts, created_at, body FROM messages WHERE direction = 'in' AND processed = -1 ORDER BY id DESC LIMIT 200").all().map((m) => ({ ...m, body: json(m.body, {}) })) }));
  r.post('/system/dead-letters/retry', requireSuper, (req, res) => res.json({ requeued: getDb().prepare("UPDATE messages SET processed = 0, attempts = 0, created_at = datetime('now', '-1 minute') WHERE direction = 'in' AND processed = -1").run().changes }));
  r.post('/system/backup', requireSuper, (req, res) => { try { res.json(backup() || { skipped: 'in-memory database' }); } catch (e) { res.status(500).json({ error: e.message }); } });
  r.delete('/tenants/:tenantId', requireSuper, (req, res) => { deleteTenant(req.params.tenantId, { force: true }); res.json({ ok: true }); });

  // ----- tenant scoped -----
  r.get('/tenants/:tenantId', requireTenant, (req, res) => res.json({ tenant: view(req.tenant), role: req.role, staffName: req.staff?.name || null, banner: billingBanner(req.tenant.id) || connectionBanner(req.tenant.id) }));

  // ----- the shop owner's step-by-step guide -----
  r.get('/tenants/:tenantId/onboarding', requireTenant, requireOwner, (req, res) => res.json(onboardingStatus(req.tenant)));
  r.get('/tenants/:tenantId/alert-emails', requireTenant, requireOwner, (req, res) => res.json({ emails: alertEmails(req.tenant), enabled: emailConfigured() }));
  r.post('/tenants/:tenantId/alert-emails/test', requireTenant, requireOwner, wrap(async (req, res) => {
    const { emailShop } = await import('../email.js');
    res.json(await emailShop(req.tenant, 'Test: your order alerts work', '✅ This is how new orders will reach you.\nYou can change who gets these in Settings → Notifications.'));
  }));
  r.post('/tenants/:tenantId/payments/stripe-connect', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json(await connectShopStripe(req.tenant, req.body?.secretKey)); } catch (e) { res.status(400).json({ error: e.message }); }
  }));

  // ----- knowledge base (RAG) -----
  const kbChanged = (id) => knowledgeChanged(id).catch((e) => console.warn('[knowledge sync]', e.message));
  const kbErr = (res, e) => res.status(e.status || 400).json({ error: e.message });
  r.get('/tenants/:tenantId/knowledge', requireTenant, (req, res) => {
    const d = req.tenant.settings.dify || {};
    const prov = req.tenant.settings.ai?.provider || (d.enabled && d.apiKey ? 'dify' : 'direct');
    res.json({ provider: prov, docs: listDocs(req.tenant.id), limit: PLANS[req.tenant.plan]?.knowledgeDocs ?? 20, aiConnected: consoleConfigured(), datasetId: d.datasetId || null, attached: !!d.datasetAttached && d.datasetAttached === d.datasetId, refresh: { last: lastRefresh(req.tenant.id), running: refreshRunning(req.tenant.id), auto: req.tenant.settings.knowledge?.autoRefresh !== false } });
  });
  // "Re-read my website now": runs in the background; the Knowledge tab polls GET /knowledge for the result
  r.post('/tenants/:tenantId/knowledge/refresh', requireTenant, requireOwner, (req, res) => {
    if (refreshRunning(req.tenant.id)) return res.status(409).json({ error: 'Already reading your website – give it a minute' });
    refreshWebsite(req.tenant.id, { onChange: (id) => kbChanged(id) }).catch((e) => console.warn('[kb refresh]', e.message));
    res.status(202).json({ started: true });
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
  r.get('/tenants/:tenantId/billing', requireTenant, requireOwner, (req, res) => res.json({ billing: billingInfo(req.tenant.id), plans: PLANS, history: billingHistory(req.tenant.id) }));
  r.get('/tenants/:tenantId/twin', requireTenant, (req, res) => res.json(buildTwin(req.tenant)));
  r.get('/tenants/:tenantId/opportunities', requireTenant, (req, res) => res.json(listOpportunities(req.tenant, { includeClosed: req.query.all === '1' })));
  r.post('/tenants/:tenantId/opportunities/:key/:action', requireTenant, (req, res) => {
    try {
      const out = setOpportunityState(req.tenant.id, req.params.key, req.params.action, { hours: req.body?.hours });
      audit({ tenantId: req.tenant.id, actor: req.staff?.name || 'owner', role: req.role, action: `opportunity.${req.params.action}`, target: String(req.params.key).slice(0, 100), ip: req.ip });
      res.json(out);
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
  r.get('/tenants/:tenantId/copilot', requireTenant, (req, res) => res.json({ suggestions: SUGGESTIONS }));
  r.post('/tenants/:tenantId/copilot', requireTenant, (req, res) => {
    const q = String(req.body?.question || '').trim().slice(0, 300);
    if (!q) return res.status(400).json({ error: 'Ask a question' });
    const out = askCopilot(req.tenant, q);
    audit({ tenantId: req.tenant.id, actor: req.staff?.name || 'owner', role: req.role, action: 'copilot.ask', detail: { intent: out.intent }, ip: req.ip });
    res.json(out);
  });
  const CHURN = ['too_expensive', 'not_enough_value', 'missing_feature', 'too_hard_to_set_up', 'ai_answers_not_good_enough', 'switching_tool', 'business_closed_or_paused', 'other'];
  r.post('/tenants/:tenantId/churn-feedback', requireTenant, requireOwner, (req, res) => {
    const reason = String(req.body?.reason || '');
    if (!CHURN.includes(reason)) return res.status(400).json({ error: 'Choose a reason' });
    getDb().prepare('INSERT INTO churn_feedback (tenant_id, reason, detail, plan) VALUES (?, ?, ?, ?)').run(req.tenant.id, reason, String(req.body?.detail || '').slice(0, 1000) || null, req.tenant.plan);
    res.json({ ok: true });
  });
  r.get('/system/churn', requireSuper, (req, res) => res.json({
    reasons: getDb().prepare("SELECT reason, COUNT(*) AS n FROM churn_feedback WHERE created_at > datetime('now', '-365 days') GROUP BY reason ORDER BY n DESC").all(),
    recent: getDb().prepare('SELECT f.reason, f.detail, f.plan, f.created_at, t.name FROM churn_feedback f LEFT JOIN tenants t ON t.id = f.tenant_id ORDER BY f.id DESC LIMIT 50').all(),
    subscriptions: getDb().prepare("SELECT COALESCE(subscription_status, 'none') AS status, COUNT(*) AS n FROM tenants GROUP BY 1").all(),
  }));
  r.get('/tenants/:tenantId/automation-log', requireTenant, (req, res) => res.json({ settings: { maxPerDay: Number(req.tenant.settings.followUps?.maxPerDay) || 2, quietStart: req.tenant.settings.followUps?.quietStart ?? 21, quietEnd: req.tenant.settings.followUps?.quietEnd ?? 8, enabled: req.tenant.settings.followUps?.enabled !== false }, log: automationLog(req.tenant.id, { waId: req.query.waId ? String(req.query.waId) : undefined, limit: req.query.limit }) }));
  r.get('/tenants/:tenantId/answers', requireTenant, (req, res) => res.json({ stats: answerStats(req.tenant.id), answers: listAnswers(req.tenant.id, { flagged: req.query.flagged === '1', limit: req.query.limit }) }));
  r.get('/tenants/:tenantId/results', requireTenant, (req, res) => res.json(resultsBreakdown(req.tenant, req.query.month ? String(req.query.month) : undefined)));
  r.get('/tenants/:tenantId/entitlements', requireTenant, (req, res) => res.json(entitlements(req.tenant)));
  r.get('/tenants/:tenantId/whatsapp/connection', requireTenant, wrap(async (req, res) => res.json({ connection: req.query.refresh ? await checkConnection(req.tenant) : connectionStatus(req.tenant.id) })));
  // emails sent for this business (alerts, quotes, tickets, follow-ups): status only, never other businesses' mail
  r.get('/tenants/:tenantId/email-log', requireTenant, requireOwner, (req, res) => res.json({ configured: emailConfigured(), emails: emailLog({ tenantId: req.tenant.id, limit: 50 }) }));
  r.post('/tenants/:tenantId/billing/checkout', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json({ url: await createSubscriptionCheckout(req.tenant, req.body?.plan) }); } catch (e) { res.status(400).json({ error: e.message }); }
  }));
  r.post('/tenants/:tenantId/billing/topup', requireTenant, requireOwner, wrap(async (req, res) => {
    try { res.json({ url: await createTopupCheckout(req.tenant, Number(req.body?.usd) || 10) }); } catch (e) { res.status(400).json({ error: e.message }); }
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
  r.post('/tenants/:tenantId/staff', requireTenant, requireOwner, (req, res, next) => {
    if (!req.isSuper && staffSeatsLeft(req.tenant) <= 0) return res.status(403).json({ error: `Your plan includes ${PLANS[req.tenant.plan]?.staffSeats} team member key(s). Remove one or upgrade to add more.` });
    next();
  }, (req, res) => {
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
  // "What your assistant did for you" – the monthly money-made report (also emailed on the 1st)
  r.get('/tenants/:tenantId/value-report', requireTenant, wrap(async (req, res) => {
    const rep = valueReport(req.tenant.id, req.query.month);
    rep.websiteSales = rep.month === 'week' ? null : await assistantSales(req.tenant, rep.month);
    res.json({ report: rep, text: reportText(rep, req.tenant.settings.business?.name || req.tenant.name) });
  }));
  r.get('/tenants/:tenantId/ad-report', requireTenant, (req, res) => res.json({ sources: adReport(req.tenant.id, req.query.days) }));
  // Automatic answer check (replays real questions, marks the answers)
  r.get('/tenants/:tenantId/quality', requireTenant, (req, res) => res.json({ last: lastQuality(req.tenant.id), running: qualityRunning(req.tenant.id) }));
  r.post('/tenants/:tenantId/quality/run', requireTenant, requireOwner, (req, res) => {
    if (qualityRunning(req.tenant.id)) return res.status(409).json({ error: 'Already checking – give it a minute' });
    runQualityCheck(req.tenant.id).catch((e) => console.warn('[quality]', e.message));
    res.status(202).json({ started: true });
  });
  // Questions the assistant couldn't answer: answer once, and it knows from then on
  r.get('/tenants/:tenantId/unanswered', requireTenant, (req, res) => res.json({ items: listUnanswered(req.tenant.id, { status: req.query.status === 'answered' ? 'answered' : 'open' }) }));
  r.post('/tenants/:tenantId/unanswered/:id/answer', requireTenant, requireOwner, (req, res) => {
    const q = getUnanswered(req.tenant.id, req.params.id);
    if (!q) return res.status(404).json({ error: 'not found' });
    const answer = String(req.body?.answer || '').trim();
    if (answer.length < 2) return res.status(400).json({ error: 'Type the answer first' });
    try {
      const doc = addTextDoc(req.tenant.id, { name: `Q&A: ${q.question.slice(0, 80)}`, text: `Question: ${q.question}\nAnswer: ${answer}` });
      // the same question asked by other customers is answered too
      getDb().prepare("UPDATE unanswered SET status = 'answered' WHERE tenant_id = ? AND status = 'open' AND lower(question) = lower(?)").run(req.tenant.id, q.question);
      setUnanswered(req.tenant.id, q.id, 'answered');
      kbChanged(req.tenant.id);
      res.json({ ok: true, doc });
    } catch (e) { kbErr(res, e); }
  });
  // One-click website installs
  r.get('/tenants/:tenantId/install/wordpress-plugin.zip', requireTenant, (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="ai-chat-assistant.zip"').type('application/zip').send(wordpressPlugin(req.tenant));
  });
  r.post('/tenants/:tenantId/install/check', requireTenant, wrap(async (req, res) => { const { checkInstall } = await import('../install.js'); res.json(await checkInstall(req.tenant, req.body?.url)); }));
  r.get('/tenants/:tenantId/menu-suggestions', requireTenant, (req, res) => res.json({ suggestions: menuSuggestions(req.tenant) }));
  r.post('/tenants/:tenantId/menu-suggestions/dismiss', requireTenant, requireOwner, (req, res) => { dismissSuggestion(req.tenant.id, String(req.body?.key || '')); res.json({ ok: true }); });
  r.get('/tenants/:tenantId/install/detect', requireTenant, wrap(async (req, res) => {
    const key = `platform:${req.tenant.id}`;
    const cached = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value;
    if (cached && req.query.fresh !== '1') return res.json(JSON.parse(cached));
    const website = req.tenant.settings.business?.website;
    const out = { website: website || null, platform: await detectPlatform(website) };
    if (out.platform) getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(out));
    res.json(out);
  }));
  // Bookings taken in the chat
  r.get('/tenants/:tenantId/bookings', requireTenant, (req, res) => res.json({ bookings: listBookings(req.tenant.id, { past: req.query.past === '1' }) }));
  r.post('/tenants/:tenantId/bookings/:id/status', requireTenant, wrap(async (req, res) => {
    const b = await setBookingStatus(req.tenant, req.params.id, String(req.body?.status || ''));
    if (!b) return res.status(404).json({ error: 'not found' });
    res.json({ booking: b });
  }));
  r.post('/tenants/:tenantId/unanswered/:id/ignore', requireTenant, requireOwner, (req, res) => res.json({ ok: setUnanswered(req.tenant.id, req.params.id, 'ignored') }));
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
    if (!req.isSuper && patch.ai) delete patch.ai.budgetUsd; // spend caps are set by the plan / operator, not the shop
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
      if (req.params.what === 'orders') { const s = getStore(t); return res.json(s.testOrders ? await s.testOrders() : { ok: false, error: 'This store type can\'t look up orders' }); }
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
  // light check every few seconds from the dashboard: the newest customer message and how many chats wait for a person
  r.get('/tenants/:tenantId/inbox/pulse', requireTenant, (req, res) => {
    const d = getDb();
    const lastIn = d.prepare("SELECT MAX(id) AS id FROM messages WHERE tenant_id = ? AND direction = 'in' AND wa_id NOT LIKE 'qa:%' AND COALESCE(json_extract(body, '$.simulated'), 0) = 0").get(req.tenant.id).id || 0;
    const waiting = d.prepare('SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND human_handover = 1').get(req.tenant.id).n;
    res.json({ lastIn, waiting });
  });
  r.get('/tenants/:tenantId/conversations', requireTenant, (req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT c.wa_id, c.state, c.human_handover, c.ai_paused_until, c.cart, c.updated_at, c.assigned_to, cu.name, json_extract(c.state_data, '$.unhappyAt') AS unhappy_at,
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
      await createSender(req.tenant)(req.params.waId, { type: 'text', text, staff: req.staff?.name || (req.isSuper ? 'Support' : 'Owner') });
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
  // Google Calendar for bookings
  r.get('/tenants/:tenantId/google', requireTenant, (req, res) => { const G = req.tenant.settings.bookings?.google || {}; res.json({ configured: googleConfigured(), connected: calendarConnected(req.tenant), connectedAt: G.connectedAt || null, lastError: G.lastError || null, redirectUri: redirectUri() }); });
  r.post('/tenants/:tenantId/google/connect', requireTenant, requireOwner, (req, res) => { if (!googleConfigured()) return res.status(400).json({ error: 'Google Calendar is not set up on this server yet (Setup → step 5)' }); res.json({ url: authUrl(req.tenant.id) }); });
  r.post('/tenants/:tenantId/google/disconnect', requireTenant, requireOwner, (req, res) => { disconnectCalendar(req.tenant.id); res.json({ ok: true }); });
  // AI auto-setup on demand ("Write it for me"): force rewrites parts the owner changed
  r.post('/tenants/:tenantId/auto-setup', requireTenant, requireOwner, wrap(async (req, res) => {
    const { autoSetup } = await import('../autoSetup.js');
    const out = await autoSetup(req.tenant.id, { force: req.body?.force === true });
    res.json({ ...out, tenant: (await import('../tenants.js')).getTenant(req.tenant.id) });
  }));
  r.get('/tenants/:tenantId/leads', requireTenant, (req, res) => res.json({ leads: listChatLeads(req.tenant.id), speed: leadSpeed(req.tenant.id) }));
  // A/B test of the pop-up greeting: visits, chats, leads and orders per variant (H = 10% who saw no greeting)
  r.get('/tenants/:tenantId/ab', requireTenant, (req, res) => {
    const O = req.tenant.settings.webchat?.opener || {};
    if (!O.abStarted) return res.json({ running: false });
    const d = getDb(), since = String(O.abStarted).replace('T', ' ').slice(0, 19);
    const out = {};
    for (const v of ['A', 'B', 'H']) {
      const visits = Number(d.prepare('SELECT value FROM kv WHERE key = ?').get(`ab:${req.tenant.id}:${O.abStarted}:${v}`)?.value || 0);
      const chats = d.prepare("SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND json_extract(state_data, '$.ab') = ? AND updated_at >= ?").get(req.tenant.id, v, since).n;
      const leads = d.prepare("SELECT COUNT(*) AS n FROM chat_leads l JOIN conversations c ON c.tenant_id = l.tenant_id AND c.wa_id = l.wa_id WHERE l.tenant_id = ? AND json_extract(c.state_data, '$.ab') = ? AND l.created_at >= ?").get(req.tenant.id, v, since).n;
      const orders = d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(o.subtotal), 0) AS rev FROM orders o JOIN conversations c ON c.tenant_id = o.tenant_id AND c.wa_id = o.wa_id WHERE o.tenant_id = ? AND json_extract(c.state_data, '$.ab') = ? AND o.created_at >= ?").get(req.tenant.id, v, since);
      out[v] = { visits, chats, leads, orders: orders.n, revenue: Math.round(orders.rev * 100) / 100 };
    }
    res.json({ running: true, since: O.abStarted, a: O.text || '', b: O.textB || '', holdout: Number(O.holdout ?? 10), variants: out });
  });
  r.get('/tenants/:tenantId/export/leads.csv', requireTenant, (req, res) => {
    const cell = (v) => { const s = String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&"); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = [['created_at', 'Date'], ['kind', 'Wants'], ['topic', 'Topic'], ['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['call_time', 'Best time'], ['message', 'Message'], ['summary', 'Chat summary'], ['page', 'Page'], ['channel', 'Channel'], ['marketing_opt_in', 'Offers by email'], ['status', 'Status']];
    const rows = listChatLeads(req.tenant.id, { limit: 10000 }).map((l) => cols.map(([k]) => cell(k === 'marketing_opt_in' ? (l[k] ? 'Yes' : 'No') : k === 'kind' ? (l[k] === 'call' ? 'Call back' : 'Details') : l[k])).join(','));
    res.type('text/csv').set('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`).send('\ufeff' + [cols.map((c) => c[1]).join(','), ...rows].join('\r\n'));
  });
  r.get('/trades', (req, res) => res.json({ trades: tradeList() }));
  // our own help for the dashboard's "❓ Help" panel
  r.get('/platform-help', (req, res) => res.json({ guides: searchGuides(String(req.query.q || ''), 6).map((g) => ({ title: g.title, url: `/guides/${g.slug}` })) }));
  r.post('/platform-help/ask', wrap(async (req, res) => res.json(await askGuides(req.body?.question))));
  r.post('/tenants/:tenantId/trade', requireTenant, requireOwner, (req, res) => {
    const out = applyTrade(req.tenant.id, String(req.body?.trade || ''), { force: req.body?.force === true });
    if (!out) return res.status(400).json({ error: 'Unknown business type' });
    res.json({ ...out, tenant: view(getTenant(req.tenant.id)) });
  });
  r.get('/tenants/:tenantId/hooks/sheets-script', requireTenant, (req, res) => res.json({ script: SHEETS_SCRIPT }));
  r.post('/tenants/:tenantId/hooks/test', requireTenant, requireOwner, async (req, res) => {
    const results = await sendHook(req.tenant, 'test', { message: `Test from ${req.tenant.settings.business.name} – it works!` });
    if (!results.length) return res.status(400).json({ error: 'Add a webhook address or a Google Sheets address first, and save.' });
    res.json({ results });
  });
  r.patch('/tenants/:tenantId/leads/:id', requireTenant, (req, res) => { setLeadStatus(req.tenant.id, req.params.id, String(req.body?.status || '')); res.json({ ok: true }); });
  r.post('/tenants/:tenantId/conversations/:waId/resume', requireTenant, (req, res) => {
    const c = resumeAi(req.tenant.id, req.params.waId);
    res.json({ ok: true, aiPausedUntil: c.aiPausedUntil, humanHandover: c.humanHandover });
  });
  r.post('/tenants/:tenantId/conversations/:waId/handover', requireTenant, wrap(async (req, res) => {
    const was = getDb().prepare('SELECT human_handover FROM conversations WHERE tenant_id = ? AND wa_id = ?').get(req.tenant.id, req.params.waId)?.human_handover;
    const c = setHandover(req.tenant.id, req.params.waId, !!req.body?.on);
    // the team finished: ask how it went (website chat or WhatsApp, inside the 24h window)
    let asked = false;
    if (was && !req.body?.on && req.body?.askRating !== false && ratingsOn(req.tenant.settings) && !/^qa:/.test(req.params.waId)) {
      asked = await createSender(req.tenant)(req.params.waId, ratingAsk('Thanks for chatting with our team! How did we do?')).then(() => true, () => false);
    }
    res.json({ ok: true, humanHandover: c.humanHandover, ratingAsked: asked });
  }));
  r.get('/tenants/:tenantId/conversations/:waId/typing', requireTenant, (req, res) => res.json({ typing: isTyping(req.tenant.id, req.params.waId), draft: typingDraft(req.tenant.id, req.params.waId) }));
  // ----- Help centre -----
  r.get('/tenants/:tenantId/help', requireTenant, (req, res) => res.json({ articles: listArticles(req.tenant.id), url: `${config.publicUrl}/help/${encodeURIComponent(req.tenant.id)}`, enabled: req.tenant.settings.help?.enabled !== false }));
  r.get('/tenants/:tenantId/help/:id', requireTenant, (req, res) => { const a = getArticle(req.tenant.id, req.params.id); return a ? res.json({ article: a }) : res.status(404).json({ error: 'not found' }); });
  r.post('/tenants/:tenantId/help', requireTenant, requireOwner, (req, res) => { try { res.json({ article: saveArticle(req.tenant.id, req.body || {}) }); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } });
  r.put('/tenants/:tenantId/help/:id', requireTenant, requireOwner, (req, res) => { try { res.json({ article: saveArticle(req.tenant.id, { ...(req.body || {}), id: req.params.id }) }); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } });
  r.delete('/tenants/:tenantId/help/:id', requireTenant, requireOwner, (req, res) => res.json({ ok: deleteArticle(req.tenant.id, req.params.id) }));
  r.post('/tenants/:tenantId/help-draft', requireTenant, requireOwner, wrap(async (req, res) => res.json({ articles: await draftArticles(req.tenant, { max: Math.min(10, Number(req.body?.max) || 6) }) })));
  // ----- Tickets -----
  r.get('/tenants/:tenantId/tickets', requireTenant, (req, res) => res.json({ tickets: listTickets(req.tenant.id, { status: String(req.query.status || 'active'), q: String(req.query.q || '').slice(0, 80) }), stats: ticketStats(req.tenant.id), enabled: req.tenant.settings.tickets?.enabled === true }));
  r.get('/tenants/:tenantId/tickets/:number', requireTenant, (req, res) => { const t = getTicket(req.tenant.id, req.params.number); return t ? res.json({ ticket: t, events: ticketEvents(t.id) }) : res.status(404).json({ error: 'not found' }); });
  r.post('/tenants/:tenantId/tickets', requireTenant, (req, res) => { try { const b = req.body || {}; res.status(201).json({ ticket: createTicket(req.tenant, { name: b.name, email: b.email, phone: b.phone, subject: b.subject, description: b.description, priority: b.priority, channel: 'dashboard' }) }); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } });
  r.patch('/tenants/:tenantId/tickets/:number', requireTenant, wrap(async (req, res) => { const b = req.body || {}; res.json(await updateTicket(req.tenant, req.params.number, { status: b.status, priority: b.priority, assignedTo: b.assignedTo, reply: b.reply, note: b.note, by: req.staff?.name || (req.isSuper ? 'Support' : 'Owner') })); }));
  r.get('/tenants/:tenantId/visitors', requireTenant, (req, res) => res.json({ enabled: req.tenant.settings.webchat?.liveVisitors === true, visitors: liveVisitors(req.tenant.id), team: teamStatus(req.tenant.settings) }));
  r.post('/tenants/:tenantId/visitors/:sessionId/hello', requireTenant, (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Type a message first' });
    if (!sayHello(req.tenant.id, req.params.sessionId, text)) return res.status(404).json({ error: 'That visitor has left the site' });
    res.json({ ok: true });
  });
  // "Teach the bot": a team answer becomes knowledge (and optionally a help-centre draft)
  // phone notifications (the installable dashboard app)
  r.get('/tenants/:tenantId/referrals', requireTenant, requireOwner, (req, res) => res.json(tenantReferrals(req.tenant.id)));
  r.get('/system/referrals', requireSuper, (req, res) => res.json(allReferrals()));
  r.post('/system/partners', requireSuper, (req, res) => { try { res.json(createPartner(req.body || {})); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } });
  r.get('/tenants/:tenantId/quotes', requireTenant, (req, res) => res.json({ quotes: listQuotes(req.tenant.id, { status: req.query.status || undefined }), enabled: req.tenant.settings.quotes?.enabled === true, autoSend: req.tenant.settings.quotes?.autoSend === true }));
  r.get('/tenants/:tenantId/quotes/:number', requireTenant, (req, res) => { const q = getQuote(req.tenant.id, req.params.number); return q ? res.json({ quote: q, url: `${config.publicUrl}/q/${q.token}` }) : res.status(404).json({ error: 'not found' }); });
  r.patch('/tenants/:tenantId/quotes/:number', requireTenant, wrap(async (req, res) => res.json({ quote: await updateQuote(req.tenant, req.params.number, req.body || {}) })));
  r.post('/tenants/:tenantId/quotes/:number/send', requireTenant, wrap(async (req, res) => res.json(await sendQuote(req.tenant, req.params.number, { by: req.staff?.name || 'Team' }))));
  r.post('/tenants/:tenantId/quiz/draft', requireTenant, requireOwner, wrap(async (req, res) => {
    const store = (await import('../stores/index.js')).getStore(req.tenant);
    const products = await store.searchProducts('', { limit: 40 }).catch(() => []);
    const cats = (req.tenant.settings.store?.manual?.categories || []).map((c) => c.title);
    res.json({ questions: await draftQuiz(req.tenant, { products: products.map((p) => p.title), categories: cats }) });
  }));
  r.get('/push/key', (req, res) => res.json({ publicKey: vapidKeys().publicKey }));
  r.post('/tenants/:tenantId/push/subscribe', requireTenant, (req, res) => { try { saveSubscription(req.tenant.id, req.body?.subscription, req.staff?.name || (req.isSuper ? 'Support' : 'Owner')); res.json({ ok: true, devices: subscriptionCount(req.tenant.id) }); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } });
  r.post('/tenants/:tenantId/push/unsubscribe', requireTenant, (req, res) => res.json({ ok: removeSubscription(req.body?.endpoint) }));
  r.post('/tenants/:tenantId/push/test', requireTenant, wrap(async (req, res) => res.json({ sent: await pushTeam(req.tenant, { title: '🔔 Notifications are on', body: "You'll get a buzz for new leads, tickets, bookings and customers asking for a person.", tag: 'test' }) })));
  r.get('/tenants/:tenantId/customers/:waId/profile', requireTenant, (req, res) => res.json({ profile: customerProfile(req.tenant.id, req.params.waId) }));
  r.patch('/tenants/:tenantId/customers/:waId/profile', requireTenant, (req, res) => res.json({ profile: saveCustomerNotes(req.tenant.id, req.params.waId, { notes: req.body?.notes, tags: req.body?.tags }) }));
  r.post('/tenants/:tenantId/teach', requireTenant, requireOwner, (req, res) => {
    const q = String(req.body?.question || '').trim().slice(0, 500), a = String(req.body?.answer || '').trim().slice(0, 4000);
    if (q.length < 3 || a.length < 2) return res.status(400).json({ error: 'Add the question and the answer' });
    try {
      const doc = addTextDoc(req.tenant.id, { name: `Q&A: ${q.slice(0, 80)}`, text: `Question: ${q}\nAnswer: ${a}` });
      getDb().prepare("UPDATE unanswered SET status = 'answered' WHERE tenant_id = ? AND status = 'open' AND lower(question) = lower(?)").run(req.tenant.id, q);
      kbChanged(req.tenant.id);
      let article = null;
      if (req.body?.article) article = saveArticle(req.tenant.id, { title: q.replace(/^\w/, (c) => c.toUpperCase()).slice(0, 150), category: 'General', body: a, status: 'draft', source: 'team' });
      res.json({ ok: true, doc, article });
    } catch (e) { kbErr(res, e); }
  });
  r.post('/tenants/:tenantId/conversations/:waId/summary', requireTenant, wrap(async (req, res) => {
    const { summarizeChat } = await import('../ai/direct.js');
    const s = await summarizeChat(req.tenant, req.params.waId).catch(() => null);
    if (!s) return res.status(400).json({ error: 'Not enough chat to summarise yet (or the AI is not set up)' });
    res.json({ summary: s });
  }));
  r.post('/tenants/:tenantId/conversations/:waId/suggest', requireTenant, wrap(async (req, res) => res.json(await suggestReply(req.tenant, req.params.waId))));
  r.post('/tenants/:tenantId/translate', requireTenant, wrap(async (req, res) => res.json(await translateText(req.tenant, String(req.body?.text || ''), String(req.body?.to || 'English')))));
  r.get('/tenants/:tenantId/ratings', requireTenant, (req, res) => res.json(ratingSummary(req.tenant.id, Math.min(365, Number(req.query.days) || 30))));

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
