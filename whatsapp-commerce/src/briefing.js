import { getDb } from './db.js';
import { askCopilot, copilotText, detectIntent } from './copilot.js';
import { listTenants } from './tenants.js';
import { createSender, notify } from './whatsapp/cloudApi.js';
import { emailShop } from './email.js';
import { zonedToUtc } from './bookings.js';

/*
 * The owner's morning briefing on WhatsApp: yesterday in numbers, today's bookings and what needs them – so they
 * run the shop from their phone. Also on demand: the owner texts "briefing" (or "waiting") to the shop's number.
 */

const tz = (t) => t.settings.business?.timezone || 'Europe/London';
const sql = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const money = (n, s) => `${s}${Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

function localParts(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const addDays = (ymd, n) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10) + n, 12)).toISOString().slice(0, 10);

export const isStaffNumber = (tenant, waId) => (tenant.settings.notifications?.staffWaIds || []).some((s) => String(s).replace(/\D/g, '') === String(waId).replace(/\D/g, '') && String(waId).length > 5);

/** The briefing text for the day before `now` (shop time). */
export function briefingText(tenant, now = new Date()) {
  const d = getDb();
  const id = tenant.id;
  const zone = tz(tenant);
  const today = localParts(now, zone).ymd;
  const yesterday = addDays(today, -1);
  const from = sql(zonedToUtc(yesterday, '00:00', zone));
  const to = sql(zonedToUtc(today, '00:00', zone));
  const sym = tenant.settings.business?.currencySymbol || '£';
  const notSim = "COALESCE(json_extract(body, '$.simulated'), 0) = 0";

  const chats = d.prepare(`SELECT COUNT(DISTINCT wa_id) AS n FROM messages WHERE tenant_id = ? AND direction = 'in' AND ${notSim} AND created_at >= ? AND created_at < ?`).get(id, from, to).n;
  const staffChats = d.prepare(`SELECT COUNT(DISTINCT wa_id) AS n FROM messages WHERE tenant_id = ? AND direction = 'out' AND json_extract(body, '$.staff') IS NOT NULL AND created_at >= ? AND created_at < ?`).get(id, from, to).n;
  const orders = d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(subtotal), 0) AS v FROM orders WHERE tenant_id = ? AND status != 'cancelled' AND created_at >= ? AND created_at < ?").get(id, from, to);
  const recovered = d.prepare("SELECT COALESCE(SUM(subtotal), 0) AS v FROM orders WHERE tenant_id = ? AND status != 'cancelled' AND recovered = 1 AND created_at >= ? AND created_at < ?").get(id, from, to).v;
  const waiting = d.prepare('SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND human_handover = 1').get(id).n;
  const toConfirm = d.prepare("SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND status = 'requested' AND starts_at > datetime('now')").get(id).n;
  const unpaid = d.prepare("SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND payment_status = 'unpaid' AND payment_method = 'bank_transfer' AND status NOT IN ('cancelled', 'completed') AND created_at > datetime('now', '-7 days')").get(id).n;
  const toShip = d.prepare("SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND status IN ('new', 'confirmed', 'preparing')").get(id).n;
  const gaps = d.prepare("SELECT COUNT(*) AS n FROM unanswered WHERE tenant_id = ? AND status = 'open' AND created_at > datetime('now', '-7 days')").get(id).n;
  const todays = d.prepare("SELECT time, name, service, status FROM bookings WHERE tenant_id = ? AND day = ? AND status IN ('confirmed', 'requested', 'awaiting_deposit') ORDER BY time LIMIT 12").all(id, today);

  const name = tenant.settings.business?.name || tenant.name;
  const lines = [`☀️ *Good morning – ${name}*`, '', '*Yesterday*', `💬 ${chats} conversation${chats === 1 ? '' : 's'}${chats ? ` – ${Math.max(0, chats - staffChats)} handled by the assistant` : ''}`];
  if (orders.n) lines.push(`🛒 ${orders.n} order${orders.n === 1 ? '' : 's'} · ${money(orders.v, sym)}`);
  if (recovered) lines.push(`💷 ${money(recovered, sym)} from recovered carts`);
  if (todays.length) lines.push('', '*Today\'s bookings*', ...todays.map((b) => `• ${b.time} ${b.name || ''}${b.service ? ` – ${b.service}` : ''}${b.status !== 'confirmed' ? ' (not confirmed)' : ''}`));
  const needs = [
    waiting && `🙋 ${waiting} chat${waiting === 1 ? '' : 's'} waiting for a person`,
    toConfirm && `📅 ${toConfirm} booking${toConfirm === 1 ? '' : 's'} to confirm`,
    toShip && `📦 ${toShip} order${toShip === 1 ? '' : 's'} to prepare / send`,
    unpaid && `🏦 ${unpaid} bank transfer${unpaid === 1 ? '' : 's'} to check`,
    gaps && `❓ ${gaps} question${gaps === 1 ? '' : 's'} the assistant couldn't answer`,
  ].filter(Boolean);
  lines.push('', needs.length ? '*Needs you*' : '✅ Nothing needs you right now.', ...needs);
  if (needs.length) lines.push('', 'Open your dashboard to deal with these. Reply *waiting* to see who is waiting.');
  return { text: lines.join('\n'), quiet: !chats && !orders.n && !needs.length && !todays.length };
}

/** "waiting": the chats that need a person, newest first. */
export function waitingText(tenant) {
  const rows = getDb().prepare(`SELECT c.wa_id, cu.name, (SELECT json_extract(body, '$.text') FROM messages m WHERE m.tenant_id = c.tenant_id AND m.wa_id = c.wa_id AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1) AS last
    FROM conversations c LEFT JOIN customers cu ON cu.tenant_id = c.tenant_id AND cu.wa_id = c.wa_id WHERE c.tenant_id = ? AND c.human_handover = 1 ORDER BY c.updated_at DESC LIMIT 10`).all(tenant.id);
  if (!rows.length) return '✅ Nobody is waiting for a person right now.';
  return `🙋 *Waiting for a person (${rows.length})*\n\n${rows.map((r) => `• ${r.name || (String(r.wa_id).startsWith('web:') ? 'Website visitor' : '+' + r.wa_id)}: "${String(r.last || '').slice(0, 80)}"`).join('\n')}\n\nReply to them from the Inbox in your dashboard.`;
}

/** Owner texting the shop's own number. Returns a reply, or null when it isn't an owner command. */
export function ownerCommand(tenant, waId, text) {
  if (!isStaffNumber(tenant, waId)) return null;
  const t = String(text || '').trim().toLowerCase();
  if (/^(briefing|today|summary|stats|report)$/.test(t)) return briefingText(tenant).text;
  if (/^(waiting|who'?s waiting|queue)$/.test(t)) return waitingText(tenant);
  // questions about the business ("which customers need callbacks?") – read-only answers from the records
  if (/\?$|^(what|which|who|how many|any)\b/.test(t) && detectIntent(t)) return copilotText(askCopilot(tenant, text));
  if (/^(owner|commands|owner help)$/.test(t)) return '🛠️ *Owner commands*\n• *briefing* – yesterday and what needs you\n• *waiting* – chats waiting for a person\n• ask a question, e.g. *which customers need callbacks?*, *what appointments are booked tomorrow?*, *what should I prioritise today?*\n\nEverything else you send here is treated like a customer message, so you can test your assistant.';
  return null;
}

/** Hourly: send each shop's briefing at its chosen hour (default 8am shop time), once a day. */
export async function runMorningBriefings(now = new Date()) {
  let sent = 0;
  for (const t of listTenants()) {
    const B = t.settings.briefing || {};
    if (!t.active || t.settings.demo?.expiresAt || B.enabled === false) continue;
    const staff = (t.settings.notifications?.staffWaIds || []).map((s) => String(s).replace(/\D/g, '')).filter(Boolean);
    if (!staff.length && !B.email) continue;
    const { ymd, hour } = localParts(now, tz(t));
    if (hour !== Number(B.hour ?? 8)) continue;
    const key = `briefing:${t.id}:${ymd}`;
    if (getDb().prepare('SELECT 1 FROM kv WHERE key = ?').get(key)) continue;
    getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(key, now.toISOString());
    const { text, quiet } = briefingText(t, now);
    if (quiet && B.sendWhenQuiet !== true) continue;
    const send = createSender(t);
    const tpl = t.settings.notifications?.templates?.staffAlert;
    for (const s of staff) {
      const r = await notify(t, s, { type: 'text', text }, tpl ? { name: tpl, params: [text.replace(/\*/g, '').replace(/\n+/g, ' · ').slice(0, 1000)] } : null, send).catch((e) => { console.warn('[briefing]', e.message); return 'failed'; });
      if (r === 'sent' || r === 'template') sent++;
    }
    if (B.email) await emailShop(t, `Good morning – your ${t.settings.business?.name || t.name} briefing`, text).then((r) => r.ok && sent++, () => {});
  }
  return sent;
}
