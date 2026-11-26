import { getDb, json } from './db.js';
import { getTenant, listTenants } from './tenants.js';
import { getConversation, saveConversation } from './bot/state.js';
import { createSender, notify, inServiceWindow } from './whatsapp/cloudApi.js';
import { config } from './config.js';
import { formatCart } from './bot/cart.js';
import { dueJobs, markJobDone } from './bot/flows.js';
import { runCampaign } from './campaigns.js';
import { resumeFlow } from './bot/engine.js';
import { enqueue, recoverUnprocessed } from './whatsapp/webhook.js';
import { runAbandonedCheckouts } from './routes/storeWebhooks.js';
import { enforceTrials, enforceGracePeriods } from './platform.js';
import { track, integrityCheck } from './ops.js';
import { guarded, purgeAutomationLog } from './outreach.js';
import { runEmailRetries, purgeEmailLog } from './email.js';
import { HAS_CONSENT_SQL } from './consent.js';
import { applyRetention } from './privacy.js';
import { runWeeklyRefresh } from './refresh.js';
import { runMonthlyReports, runWeeklyUnanswered, runReviewRequests } from './insights.js';
import { runBookingJobs } from './bookings.js';
import { cleanupDemos } from './instantDemo.js';
import { runMorningBriefings } from './briefing.js';
import { runAppReminders } from './coexistence.js';
import { runStockAlerts } from './extras.js';
import { runWeeklyQuality } from './quality.js';

/** Scheduled work: flow delays and campaigns. */
export async function runScheduled() {
  let n = 0;
  for (const job of dueJobs()) {
    markJobDone(job.id);
    const tenant = getTenant(job.tenant_id);
    if (!tenant?.active) continue;
    try {
      if (job.kind === 'flow_resume') await enqueue(`${tenant.id}:${job.payload.waId}`, () => resumeFlow(tenant, job.payload, createSender(tenant)));
      else if (job.kind === 'campaign') await runCampaign(tenant, job.payload.campaignId);
      n++;
    } catch (e) {
      console.error('[scheduled]', job.kind, e.message);
    }
  }
  return n;
}

/**
 * Abandoned-cart reminders: one gentle nudge when a cart sits untouched for N minutes,
 * only while the free 24h customer-service window is still open.
 */
export async function runAbandonedCartReminders(now = Date.now()) {
  const rows = getDb()
    .prepare(`SELECT tenant_id, wa_id, updated_at, state_data FROM conversations WHERE cart != '[]' AND human_handover = 0 AND updated_at > datetime('now', '-23 hours')`)
    .all();
  let sent = 0;
  for (const row of rows) {
    if (json(row.state_data, {}).reminded) continue;
    const tenant = getTenant(row.tenant_id);
    const minutes = Number(tenant?.settings.notifications?.abandonedCartMinutes) || 0;
    if (!tenant?.active || !minutes) continue;
    if (now - Date.parse(row.updated_at + 'Z') < minutes * 60000) continue;
    if (!inServiceWindow(row.tenant_id, row.wa_id)) continue; // only free-form inside the 24h window
    const conv = getConversation(row.tenant_id, row.wa_id);
    const r = await guarded(tenant, row.wa_id, 'abandoned_cart', `cart:${row.wa_id}:${row.updated_at}`, () => createSender(tenant)(row.wa_id, {
      type: 'buttons',
      text: `👋 You left some items in your cart:\n\n${formatCart(conv.cart, tenant.settings.business.currencySymbol)}\n\nReady to complete your order?`,
      buttons: [{ id: 'checkout', title: '✅ Checkout' }, { id: 'cart', title: '🛒 View cart' }],
    }), { onDecided: () => { conv.data.reminded = true; saveConversation(conv); } });
    if (r === 'sent') sent++;
  }
  return sent;
}

export function startJobs() {
  const M5 = 5 * 60000, M1 = 30000, H1 = 3600000, M10 = 600000;
  const log = (label) => (n) => { if (n && (typeof n !== 'object' || Object.values(n).some(Boolean))) console.log(`[${label}]`, typeof n === 'object' ? JSON.stringify(n) : n); return n; };
  const timer = setInterval(() => {
    track('abandoned-cart-reminders', M5, () => runAbandonedCartReminders());
    track('payment-reminders', M5, () => runPaymentReminders());
    track('abandoned-checkouts', M5, () => runAbandonedCheckouts());
    track('review-requests', M5, () => runReviewRequests());
    track('booking-jobs', M5, () => runBookingJobs());
  }, M5);
  const minutely = setInterval(() => {
    track('scheduled', M1, () => runScheduled());
    track('message-recovery', M1, () => recoverUnprocessed().then((n) => { if (n) console.log(`[recovery] replayed ${n} unfinished message(s)`); return n; }));
    track('email-retries', M1, () => runEmailRetries().then(log('email retries')));
    // leads still waiting for a reply: nudge the team (every 10 minutes)
    if (Date.now() - (globalThis.__leadNudgeAt || 0) > M10) { globalThis.__leadNudgeAt = Date.now(); track('lead-nudges', M10, () => import('./leads.js').then(({ runLeadNudges }) => runLeadNudges()).then(log('leads nudges'))); }
  }, M1);
  // also right after start-up (messages interrupted by the previous deploy/crash)
  setTimeout(() => track('message-recovery', M1, () => recoverUnprocessed({ olderThanSec: 0 })), 5000).unref();
  minutely.unref();
  const daily = setInterval(() => {
    track('win-back', H1, () => runWinBack());
    track('weekly-quality', H1, () => runWeeklyQuality().then((q) => { if (q) console.log('[quality]', q.score); return q?.score ?? 0; }));
    track('morning-briefings', H1, () => runMorningBriefings().then(log('briefing')));
    track('stock-alerts', H1, () => runStockAlerts().then(log('back in stock')));
    track('app-reminders', H1, () => runAppReminders().then(log('keep your number')));
    track('demo-cleanup', H1, () => log('instant demo cleanup')(cleanupDemos()));
    track('monthly-reports', H1, () => runMonthlyReports().then(log('value report')));
    track('learn-templates', H1, () => import('./learn.js').then(({ improveTradeTemplates }) => improveTradeTemplates()).then(log('learn')));
    track('weekly-digests', H1, () => import('./insights.js').then(({ runWeeklyDigests }) => runWeeklyDigests()).then(log('digest')));
    track('quote-follow-ups', H1, () => import('./quotes.js').then(({ runQuoteFollowUps }) => runQuoteFollowUps()).then(log('quotes')));
    track('weekly-unanswered', H1, () => runWeeklyUnanswered().then(log('unanswered')));
    track('trials', H1, () => log('billing: paused expired trials')(enforceTrials()));
    track('grace-periods', H1, () => log('billing: paused after grace period')(enforceGracePeriods()));
    track('retention', H1, () => import('./verified.js').then(({ purgeAnswers }) => log('retention')({ ...applyRetention(), emails: purgeEmailLog(), answers: purgeAnswers(), automation: purgeAutomationLog() })));
    track('whatsapp-health', H1, () => import('./waHealth.js').then(({ runConnectionChecks }) => runConnectionChecks()).then(log('whatsapp health')));
    track('db-integrity', H1, () => { if (Date.now() - (globalThis.__integrityAt || 0) < 24 * H1) return 'skipped'; globalThis.__integrityAt = Date.now(); return integrityCheck(); });
    // meaning-based search: vectors for pages learnt before embeddings were on (a few hundred chunks an hour)
    track('kb-embeddings', H1, () => import('./ai/rag.js').then(({ backfillEmbeddings }) => backfillEmbeddings()).then((n) => (n ? log('embeddings')({ added: n }) : 0)));
    // keep knowledge bases in step with the shops' websites (weekly per shop, one shop per hour)
    track('kb-refresh', H1, () => import('./dify/provision.js').then(({ knowledgeChanged }) => runWeeklyRefresh({ onChange: (id) => knowledgeChanged(id) }))
      .then((r) => { if (r) console.log('[kb refresh]', JSON.stringify({ updated: r.updated, added: r.added, removed: r.removed, failed: r.failed })); return r ? { updated: r.updated, failed: r.failed } : null; }));
  }, H1);
  timer.unref();
  daily.unref();
  return timer;
}

/** One reminder for unpaid online / bank-transfer orders, only inside the 24h service window. */
export async function runPaymentReminders(now = Date.now()) {
  const rows = getDb()
    .prepare(`SELECT o.* FROM orders o WHERE o.payment_status = 'unpaid' AND o.status NOT IN ('cancelled', 'completed') AND o.reminded_at IS NULL
              AND o.payment_method IN ('payment_link', 'bank_transfer') AND o.created_at > datetime('now', '-23 hours')`)
    .all();
  let sent = 0;
  for (const o of rows) {
    const tenant = getTenant(o.tenant_id);
    const minutes = Number(tenant?.settings.ordering?.paymentReminderMinutes) || 0;
    if (!tenant?.active || !minutes || now - Date.parse(o.created_at + 'Z') < minutes * 60000) continue;
    const decided = () => getDb().prepare("UPDATE orders SET reminded_at = datetime('now') WHERE id = ?").run(o.id);
    const sym = tenant.settings.business.currencySymbol || '£';
    const tpl = tenant.settings.notifications?.templates?.paymentReminder;
    const fallback = tpl ? { name: tpl, params: [(o.customer_name || 'there').split(' ')[0], o.store_order_name, `${sym}${Number(o.subtotal).toFixed(2)}`, o.checkout_url || `${config.publicUrl}/r/${o.receipt_token}`] } : null;
    const msg = o.payment_method === 'payment_link' && o.checkout_url
      ? { type: 'cta', text: `⏰ Friendly reminder: order *${o.store_order_name}* (${sym}${Number(o.subtotal).toFixed(2)}) is waiting for payment.`, buttonText: 'Pay now', url: o.checkout_url }
      : { type: 'text', text: `⏰ Friendly reminder: we haven't received payment for order *${o.store_order_name}* (${sym}${Number(o.subtotal).toFixed(2)}) yet.\n${tenant.settings.ordering.bankDetails || ''}\nReference: ${o.store_order_name}\n\nAlready paid? Just send us the screenshot here 🙏` };
    if ((await guarded(tenant, o.wa_id, 'payment_reminder', `order:${o.id}`, () => notify(tenant, o.wa_id, msg, fallback), { onDecided: decided })) === 'sent') sent++;
  }
  return sent;
}

/** Win-back: approved template to opted-in customers whose last order is older than N days (max once per N days). */
export async function runWinBack() {
  let sent = 0;
  for (const tenant of listTenants()) {
    const W = tenant.settings.notifications?.winBack;
    if (!tenant.active || !W?.enabled || !W.template) continue;
    const days = Math.max(7, Number(W.afterDays) || 30);
    const rows = getDb()
      .prepare(`SELECT c.wa_id FROM customers c WHERE c.tenant_id = ? AND c.opted_in_marketing = 1 AND ${HAS_CONSENT_SQL}
                AND (c.winback_sent_at IS NULL OR c.winback_sent_at < datetime('now', ?))
                AND EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = c.tenant_id AND o.wa_id = c.wa_id)
                AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = c.tenant_id AND o.wa_id = c.wa_id AND o.created_at > datetime('now', ?))
                LIMIT 500`)
      .all(tenant.id, `-${days} days`, `-${days} days`);
    const send = createSender(tenant);
    for (const r of rows) {
      const res = await guarded(tenant, r.wa_id, 'win_back', `winback:${r.wa_id}:${new Date().toISOString().slice(0, 10)}`, () => send(r.wa_id, { type: 'template', name: W.template, language: W.language || 'en_GB' }),
        { onDecided: () => getDb().prepare("UPDATE customers SET winback_sent_at = datetime('now') WHERE tenant_id = ? AND wa_id = ?").run(tenant.id, r.wa_id) });
      if (res === 'sent') sent++;
    }
  }
  return sent;
}
