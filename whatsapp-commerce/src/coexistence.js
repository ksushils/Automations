import { getDb } from './db.js';
import { getTenant, listTenants, updateTenantSettings } from './tenants.js';
import { getConversation, saveConversation } from './bot/state.js';
import { createSender, notify } from './whatsapp/cloudApi.js';
import { emailShop } from './email.js';

/*
 * "Keep your number" (Meta: coexistence). The owner keeps the WhatsApp Business app on their phone and our Cloud
 * API connection runs on the same number.
 *  - Owner takeover: when the owner replies from the phone (an echo webhook), the AI goes quiet in that chat for
 *    settings.coexistence.takeoverMinutes (default 30), so the owner and the bot never talk over each other.
 *  - 13-day rule: Meta needs the Business app opened at least every 13 days. We can't see the app being opened,
 *    only echoes and contact syncs, so after 10 (and again 12) quiet days we remind the owner by email and WhatsApp.
 * Shops on a normal Cloud API number never get echoes, so none of this changes anything for them.
 */
export const DEFAULT_TAKEOVER_MINUTES = 30;
const DAY = 86400000;
export const REMIND_AFTER_DAYS = [10, 12];

export function takeoverMinutes(tenant) {
  const n = Math.round(Number(tenant?.settings?.coexistence?.takeoverMinutes));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 5), 1440) : DEFAULT_TAKEOVER_MINUTES;
}

export const isCoexistence = (tenant) => tenant?.settings?.whatsapp?.connectedVia === 'coexistence';

/** True while the AI must stay quiet in this conversation. */
export function isAiPaused(conv, now = Date.now()) {
  const until = Date.parse(conv?.aiPausedUntil || '');
  return Number.isFinite(until) && until > now;
}

/** The owner replied from the phone: pause the AI in this chat. Returns the time it resumes. */
export function pauseAi(tenant, waId, now = Date.now()) {
  const until = new Date(now + takeoverMinutes(tenant) * 60000).toISOString();
  const c = getConversation(tenant.id, waId);
  if (c.humanHandover) { // a person was asked for and the owner has now answered: no more "our team will reply" notes
    c.data = { ...(c.data || {}), staffActiveAt: new Date(now).toISOString() };
    saveConversation(c);
  }
  getDb().prepare('UPDATE conversations SET ai_paused_until = ? WHERE id = ?').run(until, c.id);
  return until;
}

/** Inbox "Resume AI now": the AI answers this chat again straight away. */
export function resumeAi(tenantId, waId) {
  const c = getConversation(tenantId, waId);
  getDb().prepare('UPDATE conversations SET ai_paused_until = NULL WHERE id = ?').run(c.id);
  if (c.humanHandover) { c.humanHandover = false; c.state = 'idle'; saveConversation(c); }
  return getConversation(tenantId, waId);
}

/** Something happened in the Business app (echo or contact sync): the app is alive. Written at most hourly. */
export function noteAppActivity(tenant, now = Date.now()) {
  const W = getTenant(tenant.id)?.settings?.whatsapp || {};
  if (now - (Date.parse(W.lastAppActivityAt || '') || 0) < 3600000) return;
  updateTenantSettings(tenant.id, { whatsapp: { lastAppActivityAt: new Date(now).toISOString() } });
}

export function appReminderText(tenant, days) {
  return `📱 Please open the WhatsApp Business app on your phone today.\n\nWe haven't seen any activity from it for ${days} days. Meta needs the app opened at least once every 13 days, or it disconnects the app from your number and ${tenant.settings.business?.name || 'your shop'}'s AI assistant stops replying alongside you.\n\nJust open the app – nothing else to do.`;
}

/** Hourly: remind coexistence shops whose Business app has been quiet for 10 days (again at 12). */
export async function runAppReminders(now = Date.now()) {
  let sent = 0;
  for (const t of listTenants()) {
    const W = t.settings.whatsapp || {};
    if (!t.active || t.settings.demo?.expiresAt || W.connectedVia !== 'coexistence' || W.numberStatus !== 'active') continue;
    const last = Math.max(Date.parse(W.lastAppActivityAt || '') || 0, Date.parse(W.coexSync?.at || '') || 0, Date.parse(W.connectedAt || '') || 0);
    if (!last) continue;
    const days = Math.floor((now - last) / DAY);
    const stage = REMIND_AFTER_DAYS.filter((d) => days >= d).length;
    const done = Date.parse(W.appReminderSentAt || '') >= last ? Number(W.appReminderStage || 0) : 0;
    if (!stage || stage <= done) continue;
    updateTenantSettings(t.id, { whatsapp: { appReminderSentAt: new Date(now).toISOString(), appReminderStage: stage } });
    const text = appReminderText(t, days);
    await emailShop(t, 'Please open the WhatsApp Business app on your phone', text, { button: 'Open your dashboard' }).catch(() => {});
    const send = createSender(t);
    const tpl = t.settings.notifications?.templates?.staffAlert;
    for (const s of (t.settings.notifications?.staffWaIds || []).map((x) => String(x).replace(/\D/g, '')).filter(Boolean)) {
      await notify(t, s, { type: 'text', text }, tpl ? { name: tpl, params: [text.replace(/\n+/g, ' · ').slice(0, 1000)] } : null, send).catch(() => {});
    }
    sent++;
  }
  return sent;
}
