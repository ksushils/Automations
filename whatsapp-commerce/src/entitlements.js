import { getDb } from './db.js';
import { PLANS, getUsage, aiBudgetUsed } from './tenants.js';
import { config } from './config.js';

/*
 * What a business's plan includes and how much of it is used this month – one place, read by the Billing tab.
 * Every limit here is enforced on the server where the action happens (never only in the browser):
 *   whatsapp        → whatsapp/webhook.js (Free: inbound WhatsApp is not answered)
 *   monthly messages → tenants.withinLimit('inbound') in the engine and website chat
 *   AI replies / AI budget → tenants.withinLimit('ai') (owner can't raise the cap: round3.test.js)
 *   campaigns       → routes/admin.js campaigns + broadcasts (403)
 *   knowledge docs  → knowledge.checkLimit
 *   staff seats     → staffSeatsLeft(), checked when a staff key is created
 *   "Powered by"    → routes/webchat.js (badge only on plans with badge: true)
 * Plan changes only come from the platform owner (requireSuper) or Stripe webhooks – a business can't change its own plan.
 */
export const plan = (tenant) => PLANS[tenant.plan] || PLANS.starter;

export function staffCount(tenantId) {
  return Number(getDb().prepare('SELECT COUNT(*) AS n FROM staff WHERE tenant_id = ?').get(tenantId).n);
}
export function staffSeatsLeft(tenant) {
  const max = plan(tenant).staffSeats;
  return max == null ? Infinity : Math.max(0, max - staffCount(tenant.id));
}

export function entitlements(tenant) {
  const p = plan(tenant);
  const u = getUsage(tenant.id);
  const docs = Number(getDb().prepare("SELECT COUNT(*) AS n FROM knowledge_docs WHERE tenant_id = ? AND status != 'deleted'").get(tenant.id).n);
  const budget = tenant.settings?.ai?.budgetUsd ?? p.aiBudgetUsd;
  const used = aiBudgetUsed(tenant);
  const renew = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return {
    plan: tenant.plan, label: p.label, priceGbp: p.priceGbp, period: u.period, resetsOn: renew,
    features: { whatsapp: p.whatsapp !== false, campaigns: !!p.broadcasts, poweredByBadge: !!p.badge },
    limits: [
      { key: 'messages', label: 'Customer messages', used: u.inbound || 0, included: p.monthlyConversationsIn, unit: 'this month', overage: 'Over the limit, customers get a polite "the team will reply" message instead of an AI answer.' },
      { key: 'ai', label: 'AI replies', used: u.ai_calls || 0, included: p.aiCalls, unit: 'this month', overage: 'Over the limit, the assistant answers from your saved answers and keyword search. Extra AI budget can be bought on this tab.' },
      { key: 'ai_budget', label: 'AI budget', used: used == null ? null : Math.round(used * 100), included: budget == null ? null : 100, unit: '% used', overage: 'A spending cap so AI costs can never run away.' },
      { key: 'knowledge', label: 'Knowledge documents', used: docs, included: p.knowledgeDocs, unit: 'in total', overage: 'Remove a document or upgrade to add more.' },
      { key: 'staff', label: 'Team members', used: staffCount(tenant.id), included: p.staffSeats ?? null, unit: 'besides the owner', overage: 'Upgrade to add more team members.' },
    ],
    external: [
      { label: 'WhatsApp (Meta) message fees', text: 'Billed to you directly by Meta, separately from this plan. Replies within 24 hours of a customer message are free.' },
      { label: 'Payment fees (Stripe / PayPal)', text: 'Charged by your payment provider on your customers\' payments.' },
    ],
    product: config.productName,
  };
}
