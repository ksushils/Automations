import { getDb, json } from './db.js';
import { getTenant, listTenants } from './tenants.js';
import { getConversation, saveConversation } from './bot/state.js';
import { createSender } from './whatsapp/cloudApi.js';
import { formatCart } from './bot/cart.js';
import { dueJobs, markJobDone } from './bot/flows.js';
import { runCampaign } from './campaigns.js';
import { resumeFlow } from './bot/engine.js';
import { enqueue } from './whatsapp/webhook.js';

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
    const conv = getConversation(row.tenant_id, row.wa_id);
    conv.data.reminded = true;
    saveConversation(conv);
    await createSender(tenant)(row.wa_id, {
      type: 'buttons',
      text: `👋 You left some items in your cart:\n\n${formatCart(conv.cart, tenant.settings.business.currencySymbol)}\n\nReady to complete your order?`,
      buttons: [{ id: 'checkout', title: '✅ Checkout' }, { id: 'cart', title: '🛒 View cart' }],
    }).then(() => sent++, (e) => console.warn('[abandoned cart]', e.message));
  }
  return sent;
}

export function startJobs() {
  const timer = setInterval(() => {
    runAbandonedCartReminders().catch((e) => console.error('[jobs]', e));
    runPaymentReminders().catch((e) => console.error('[jobs]', e));
  }, 5 * 60000);
  const minutely = setInterval(() => runScheduled().catch((e) => console.error('[jobs]', e)), 30000);
  minutely.unref();
  const daily = setInterval(() => runWinBack().catch((e) => console.error('[jobs]', e)), 6 * 3600000);
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
    getDb().prepare("UPDATE orders SET reminded_at = datetime('now') WHERE id = ?").run(o.id);
    const sym = tenant.settings.business.currencySymbol || '£';
    const msg = o.payment_method === 'payment_link' && o.checkout_url
      ? { type: 'cta', text: `⏰ Friendly reminder: order *${o.store_order_name}* (${sym}${Number(o.subtotal).toFixed(2)}) is waiting for payment.`, buttonText: 'Pay now', url: o.checkout_url }
      : { type: 'text', text: `⏰ Friendly reminder: we haven't received payment for order *${o.store_order_name}* (${sym}${Number(o.subtotal).toFixed(2)}) yet.\n${tenant.settings.ordering.bankDetails || ''}\nReference: ${o.store_order_name}\n\nAlready paid? Just send us the screenshot here 🙏` };
    await createSender(tenant)(o.wa_id, msg).then(() => sent++, (e) => console.warn('[payment reminder]', e.message));
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
      .prepare(`SELECT c.wa_id FROM customers c WHERE c.tenant_id = ? AND c.opted_in_marketing = 1
                AND (c.winback_sent_at IS NULL OR c.winback_sent_at < datetime('now', ?))
                AND EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = c.tenant_id AND o.wa_id = c.wa_id)
                AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = c.tenant_id AND o.wa_id = c.wa_id AND o.created_at > datetime('now', ?))
                LIMIT 500`)
      .all(tenant.id, `-${days} days`, `-${days} days`);
    const send = createSender(tenant);
    for (const r of rows) {
      getDb().prepare("UPDATE customers SET winback_sent_at = datetime('now') WHERE tenant_id = ? AND wa_id = ?").run(tenant.id, r.wa_id);
      await send(r.wa_id, { type: 'template', name: W.template, language: W.language || 'en_GB' }).then(() => sent++, (e) => console.warn('[win-back]', e.message));
    }
  }
  return sent;
}
