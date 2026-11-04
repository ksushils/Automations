import { getDb, json } from './db.js';
import { getTenant } from './tenants.js';
import { getConversation, saveConversation } from './bot/state.js';
import { createSender } from './whatsapp/cloudApi.js';
import { formatCart } from './bot/cart.js';

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
  const timer = setInterval(() => runAbandonedCartReminders().catch((e) => console.error('[jobs]', e)), 5 * 60000);
  timer.unref();
  return timer;
}
