import { getDb, json } from './db.js';
import { emailShop, sendEmail } from './email.js';
import { createSender, notify } from './whatsapp/cloudApi.js';
import { sendHook } from './hooks.js';

/*
 * Support tickets: when the assistant can't fix something, it opens a ticket with a number (#1042), tells the
 * customer when to expect a reply, and the team works it on the Tickets tab (status, priority, owner, replies,
 * private notes). Replies and status changes go back to the customer in the chat (website or WhatsApp) and by email
 * when we have one. Customers can ask "what's happening with #1042?" in the chat.
 * settings.tickets = { enabled, replyHours (promised first reply, default 8 working hours), askEmail }
 */
export const STATUSES = ['open', 'pending', 'solved', 'closed'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const STATUS_TEXT = { open: 'open – our team is on it', pending: 'waiting for your reply', solved: 'solved', closed: 'closed' };
export const ticketsOn = (S) => S.tickets?.enabled === true;
const fail = (m, status = 400) => Object.assign(new Error(m), { status });

const nextNumber = (tenantId) => (getDb().prepare('SELECT MAX(number) AS n FROM tickets WHERE tenant_id = ?').get(tenantId).n || 1000) + 1;
const map = (t) => t && { ...t, events: undefined };

export function getTicket(tenantId, numberOrId, { byId = false } = {}) {
  return map(getDb().prepare(`SELECT * FROM tickets WHERE tenant_id = ? AND ${byId ? 'id' : 'number'} = ?`).get(tenantId, Number(numberOrId)));
}
export function ticketEvents(ticketId) {
  return getDb().prepare('SELECT kind, text, by_name AS by, public, created_at FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(ticketId).map((e) => ({ ...e, public: !!e.public }));
}
function addEvent(ticketId, kind, text, by, pub) {
  getDb().prepare('INSERT INTO ticket_events (ticket_id, kind, text, by_name, public) VALUES (?, ?, ?, ?, ?)').run(ticketId, kind, String(text || '').slice(0, 4000), by || null, pub ? 1 : 0);
}

export function listTickets(tenantId, { status, q, limit = 200 } = {}) {
  const where = ['tenant_id = ?'], args = [tenantId];
  if (status === 'active') where.push("status IN ('open', 'pending')");
  else if (STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
  if (q) { where.push('(subject LIKE ? OR description LIKE ? OR name LIKE ? OR email LIKE ? OR CAST(number AS TEXT) = ?)'); const like = `%${q}%`; args.push(like, like, like, like, String(q).replace(/\D/g, '')); }
  return getDb().prepare(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, id DESC LIMIT ?`).all(...args, limit).map(map);
}

/** Open a ticket (from the chat or the dashboard). Tells the team at once. */
export function createTicket(tenant, { waId = null, name, email, phone, subject, description, priority = 'normal', channel = 'chat', summary = null }) {
  const desc = String(description || '').trim().slice(0, 4000);
  if (desc.length < 3) throw fail('Describe the problem first');
  const subj = String(subject || desc.split(/[.!?\n]/)[0]).replace(/\s+/g, ' ').trim().slice(0, 120) || 'Support request';
  const hours = Math.max(1, Math.min(168, Number(tenant.settings.tickets?.replyHours) || 8));
  const number = nextNumber(tenant.id);
  const id = Number(getDb().prepare(`INSERT INTO tickets (tenant_id, number, wa_id, name, email, phone, subject, description, priority, channel, summary, due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`).run(tenant.id, number, waId, name || null, email || null, phone || null, subj, desc, PRIORITIES.includes(priority) ? priority : 'normal', channel, summary, `+${hours} hours`).lastInsertRowid);
  addEvent(id, 'created', desc, name || 'Customer', true);
  const who = [name, email, phone].filter(Boolean).join(' · ') || (String(waId || '').startsWith('web:') ? 'website visitor' : waId ? `+${waId}` : '');
  const text = `🎫 New ticket #${number}: ${subj}\n${who}\n\n${desc}`;
  emailShop(tenant, `New ticket #${number}: ${subj}`, `${text}\n\nOpen the Tickets tab to reply.`, { button: 'Open Tickets' }).catch(() => {});
  for (const s of tenant.settings.notifications?.staffWaIds || []) notify(tenant, String(s).replace(/\D/g, ''), { type: 'text', text }, null).catch(() => {});
  sendHook(tenant, 'ticket.new', { number, subject: subj, description: desc, name, email, phone, priority, channel }).catch(() => {});
  return { ...getTicket(tenant.id, number), hours };
}

/** Team update: status / priority / owner / a reply to the customer / a private note. Replies reach the customer. */
export async function updateTicket(tenant, number, { status, priority, assignedTo, reply, note, by = 'Team' }) {
  const t = getTicket(tenant.id, number);
  if (!t) throw fail('Ticket not found', 404);
  const d = getDb();
  const changes = [];
  if (status && STATUSES.includes(status) && status !== t.status) { d.prepare("UPDATE tickets SET status = ?, solved_at = CASE WHEN ? IN ('solved','closed') THEN datetime('now') ELSE NULL END WHERE id = ?").run(status, status, t.id); addEvent(t.id, 'status', status, by, true); changes.push(`status → ${status}`); }
  if (priority && PRIORITIES.includes(priority) && priority !== t.priority) { d.prepare('UPDATE tickets SET priority = ? WHERE id = ?').run(priority, t.id); addEvent(t.id, 'priority', priority, by, false); }
  if (assignedTo !== undefined && (assignedTo || null) !== t.assigned_to) { d.prepare('UPDATE tickets SET assigned_to = ? WHERE id = ?').run(assignedTo || null, t.id); addEvent(t.id, 'assigned', assignedTo || 'nobody', by, false); }
  if (note) addEvent(t.id, 'note', note, by, false);
  let delivered = null;
  const msg = String(reply || '').trim();
  if (msg) {
    addEvent(t.id, 'reply', msg, by, true);
    if (!t.first_reply_at) d.prepare("UPDATE tickets SET first_reply_at = datetime('now') WHERE id = ?").run(t.id);
    if (!status && t.status === 'open') d.prepare("UPDATE tickets SET status = 'pending' WHERE id = ?").run(t.id);
  }
  d.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(t.id);
  // tell the customer: a reply, or that it's solved
  const now = getTicket(tenant.id, number);
  const tellText = msg ? `💬 Update on ticket #${t.number} (${t.subject}):\n\n${msg}` : changes.length && ['solved', 'closed'].includes(now.status) ? `✅ Ticket #${t.number} (${t.subject}) is ${now.status}. Reply here if you still need help.` : '';
  if (tellText) delivered = await tellCustomer(tenant, now, tellText);
  return { ticket: now, events: ticketEvents(t.id), delivered };
}

async function tellCustomer(tenant, t, text) {
  const out = { chat: false, email: false };
  if (t.wa_id) out.chat = await createSender(tenant)(t.wa_id, { type: 'text', text, staff: 'Team' }).then(() => true, () => false);
  if (t.email) out.email = await sendEmail({ to: t.email, replyTo: (tenant.settings.notifications?.alertEmails || [])[0], subject: `Ticket #${t.number}: ${t.subject}`, text: `${text}\n\n${tenant.settings.business.name}` }).then((r) => !!r?.ok, () => false);
  return out;
}

/** What the customer sees when they ask about a ticket. Only their own tickets (same chat or same email). */
export function ticketStatusText(tenantId, number, { waId, email }) {
  const t = getTicket(tenantId, number);
  if (!t || !((waId && t.wa_id === waId) || (email && t.email && t.email.toLowerCase() === String(email).toLowerCase()))) return null;
  const last = ticketEvents(t.id).filter((e) => e.public && e.kind === 'reply').at(-1);
  return `🎫 Ticket #${t.number}: ${t.subject}\nStatus: ${STATUS_TEXT[t.status] || t.status}${last ? `\n\nLatest from the team: ${last.text.slice(0, 400)}` : ''}`;
}

export function ticketStats(tenantId) {
  const d = getDb();
  const one = (sql) => d.prepare(sql).get(tenantId).n || 0;
  return {
    open: one("SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ? AND status = 'open'"),
    pending: one("SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ? AND status = 'pending'"),
    overdue: one("SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ? AND status = 'open' AND first_reply_at IS NULL AND due_at < datetime('now')"),
    solved30: one("SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ? AND status IN ('solved','closed') AND solved_at > datetime('now','-30 days')"),
  };
}
void json;
