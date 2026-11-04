import { getDb } from './db.js';
import { numberHealth, cachedTemplates } from './templates.js';

/*
 * Guided WhatsApp go-live checklist. Steps Meta exposes through the API are checked automatically;
 * the rest link to the right page in Meta Business Suite / WhatsApp Manager.
 */
const LINKS = {
  portfolio: 'https://business.facebook.com/settings/info',
  verification: 'https://business.facebook.com/settings/security',
  payment: 'https://business.facebook.com/billing_hub/payment_settings',
  manager: 'https://business.facebook.com/wa/manage/phone-numbers/',
};
const REQUIRED_TEMPLATES = ['order_update', 'staff_alert', 'payment_reminder'];

export async function goLiveChecklist(tenant) {
  const W = tenant.settings.whatsapp || {};
  const connected = !!(W.wabaId && W.accessToken);
  let health = null;
  if (W.phoneNumberId && W.accessToken) health = await numberHealth(tenant).catch(() => null);
  const tpl = cachedTemplates(tenant.id);
  const approved = REQUIRED_TEMPLATES.filter((n) => tpl[n]); // cached list holds the shop's templates; status shown on the Templates tab
  const inbound = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'in' AND wa_id NOT LIKE 'web:%' AND created_at > datetime('now', '-30 days')").get(tenant.id).n;
  const steps = [
    { key: 'portfolio', title: 'Meta business portfolio', help: 'Create or choose your business portfolio in Meta Business Suite – the sign-up flow can create one for you.', done: connected, link: LINKS.portfolio },
    { key: 'connect', title: 'Connect WhatsApp to this app', help: 'Press “Connect a new WhatsApp number” (or “I use the WhatsApp Business app on my number” to keep the app).', done: connected },
    { key: 'number', title: 'Phone number verified and active', help: 'Verify the number by SMS/voice in WhatsApp Manager, then press “Refresh number”.', done: W.numberStatus ? W.numberStatus === 'active' : !!W.phoneNumberId, link: LINKS.manager },
    { key: 'payment', title: 'Payment method on your WhatsApp account', help: 'Meta bills its message fees to you directly. Add a card under Billing & payments → WhatsApp Business account. Without it, replies after the 1,000 free per month and all templates will fail.', done: null, link: LINKS.payment },
    { key: 'name', title: 'Display name approved', help: 'Meta reviews your business display name. It must match your brand / website.', done: health ? health.name_status === 'APPROVED' : null, value: health?.name_status || null, link: LINKS.manager },
    { key: 'verification', title: 'Business verification (recommended)', help: 'Verified businesses get higher messaging limits faster. Upload company documents in Security Centre.', done: null, link: LINKS.verification },
    { key: 'templates', title: 'Message templates submitted', help: `Submit ${REQUIRED_TEMPLATES.join(', ')} from the Templates tab – they keep order updates and alerts working outside the 24-hour window.`, done: approved.length === REQUIRED_TEMPLATES.length, value: `${approved.length}/${REQUIRED_TEMPLATES.length}` },
    { key: 'quality', title: 'Number quality', help: 'Keep quality green: only message people who opted in, and make opting out easy.', done: health ? health.quality_rating !== 'RED' : null, value: health?.quality_rating || null },
    { key: 'webhook', title: 'Receiving messages', help: 'Send “hi” to your business number from your own phone – it should appear in the Inbox within seconds.', done: inbound > 0 },
  ];
  return { steps, ready: steps.filter((s) => s.done === false).length === 0 };
}
