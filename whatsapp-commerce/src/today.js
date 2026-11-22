import { getDb, json } from './db.js';

/*
 * "Today" (R4): what needs doing now, from the business's own records – fitted to the business, so a plumber sees
 * urgent call-backs and quotes to approve, a salon sees bookings to confirm and today's appointments, a shop sees
 * orders to send. Rows only appear for features the business uses; an empty list says "all clear".
 * Every item links to the page where it's dealt with. Read-only: nothing here changes anything.
 */
const ago = (iso, now) => {
  const m = Math.max(0, Math.round((now - Date.parse(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'))) / 60000));
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const localDay = (now, tz) => new Date(now).toLocaleDateString('en-CA', { timeZone: tz || 'Europe/London' });

export function todayList(tenant, { now = Date.now() } = {}) {
  const d = getDb();
  const S = tenant.settings || {};
  const id = tenant.id;
  const items = [];
  const shop = ['shopify', 'shopify_public', 'woocommerce', 'custom'].includes(S.store?.type) || (S.store?.type === 'manual' && (S.store?.manual?.products || []).length > 0);
  // 1. people waiting for a person – most urgent
  const waiting = d.prepare("SELECT c.wa_id, c.updated_at, cu.name FROM conversations c LEFT JOIN customers cu ON cu.tenant_id = c.tenant_id AND cu.wa_id = c.wa_id WHERE c.tenant_id = ? AND c.human_handover = 1 AND c.wa_id NOT LIKE 'qa:%' ORDER BY c.updated_at LIMIT 20").all(id);
  if (waiting.length) items.push({ key: 'handover', level: 'urgent', icon: '🙋', title: `${waiting.length} ${waiting.length === 1 ? 'chat is' : 'chats are'} waiting for a person`, detail: waiting.slice(0, 3).map((w) => `${w.name || 'Customer'} (${ago(w.updated_at, now)})`).join(', '), tab: 'inbox' });
  // 2. urgent leads, then other new leads
  const leads = d.prepare("SELECT name, phone, topic, urgent, created_at FROM chat_leads WHERE tenant_id = ? AND status = 'new' ORDER BY urgent DESC, id LIMIT 50").all(id);
  const urgent = leads.filter((l) => l.urgent);
  if (urgent.length) items.push({ key: 'urgent_leads', level: 'urgent', icon: '🚨', title: `${urgent.length} urgent ${urgent.length === 1 ? 'lead' : 'leads'} to call`, detail: urgent.slice(0, 3).map((l) => `${l.name || l.phone || 'Lead'}${l.topic && l.topic !== 'general' ? ` – ${l.topic}` : ''} (${ago(l.created_at, now)})`).join(', '), tab: 'leads' });
  const other = leads.filter((l) => !l.urgent);
  if (other.length) items.push({ key: 'leads', level: 'todo', icon: '📇', title: `${other.length} new ${other.length === 1 ? 'lead' : 'leads'} to get back to`, detail: `Oldest ${ago(other[0].created_at, now)}`, tab: 'leads' });
  // 3. bookings
  if (S.bookings?.enabled) {
    const req = d.prepare("SELECT COUNT(*) AS n, MIN(starts_at) AS first FROM bookings WHERE tenant_id = ? AND status = 'requested' AND starts_at > ?").get(id, new Date(now).toISOString());
    if (req.n) items.push({ key: 'bookings_to_confirm', level: 'todo', icon: '📅', title: `${req.n} booking ${req.n === 1 ? 'request' : 'requests'} to confirm`, detail: 'The customer is waiting to hear back', tab: 'bookings' });
    const today = localDay(now, S.business?.timezone);
    const appts = d.prepare("SELECT time, service, name FROM bookings WHERE tenant_id = ? AND day = ? AND status IN ('confirmed', 'requested') ORDER BY time").all(id, today);
    if (appts.length) items.push({ key: 'appointments_today', level: 'info', icon: '🗓️', title: `${appts.length} ${appts.length === 1 ? 'appointment' : 'appointments'} today`, detail: appts.slice(0, 4).map((a) => `${a.time} ${a.service || ''}${a.name ? ` – ${a.name}` : ''}`.trim()).join(' · '), tab: 'bookings' });
  }
  // 4. quotes
  const drafts = d.prepare("SELECT COUNT(*) AS n FROM quotes WHERE tenant_id = ? AND status = 'draft'").get(id).n;
  if (drafts) items.push({ key: 'quotes', level: 'todo', icon: '📝', title: `${drafts} ${drafts === 1 ? 'quote' : 'quotes'} to price and send`, detail: 'Requests from the chat, waiting for your prices', tab: 'quotes' });
  // 5. orders to deal with (shops)
  if (shop) {
    const o = d.prepare("SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND status IN ('new', 'pending', 'confirmed', 'preparing', 'ready') AND created_at > datetime('now', '-14 days')").get(id).n;
    if (o) items.push({ key: 'orders', level: 'todo', icon: '📦', title: `${o} ${o === 1 ? 'order' : 'orders'} to prepare or send`, detail: 'From the last 14 days', tab: 'orders' });
  }
  // 6. tickets
  if (S.tickets?.enabled) {
    const tk = d.prepare("SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ? AND status = 'open'").get(id).n;
    if (tk) items.push({ key: 'tickets', level: 'todo', icon: '🛠️', title: `${tk} open ${tk === 1 ? 'ticket' : 'tickets'}`, detail: 'Repairs or support requests', tab: 'tickets' });
  }
  // 7. questions the assistant couldn't answer (last 7 days)
  const gaps = d.prepare("SELECT COUNT(*) AS n FROM unanswered WHERE tenant_id = ? AND created_at > datetime('now', '-7 days') AND status = 'open'").get(id)?.n || 0;
  if (gaps) items.push({ key: 'gaps', level: 'info', icon: '❓', title: `${gaps} ${gaps === 1 ? 'question' : 'questions'} your assistant couldn't answer this week`, detail: 'Add the answer once and it uses it from then on', tab: 'knowledge' });
  // 8. automation drafts waiting for approval
  const ad = d.prepare("SELECT value FROM kv WHERE key LIKE ?").all(`autodraft:${id}:%`).map((r) => json(r.value, {})).filter((x) => x.status === 'draft' && x.ok).length;
  if (ad) items.push({ key: 'automation_drafts', level: 'info', icon: '✨', title: `${ad} automation ${ad === 1 ? 'draft' : 'drafts'} to review`, detail: 'Not live until you approve', tab: 'automations' });
  const order = { urgent: 0, todo: 1, info: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  return { items, allClear: !items.some((i) => i.level !== 'info'), at: new Date(now).toISOString() };
}
