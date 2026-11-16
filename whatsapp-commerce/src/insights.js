import { getDb, json } from './db.js';
import { getTenant, listTenants, PLANS } from './tenants.js';
import { emailShop } from './email.js';
import { createSender, notify } from './whatsapp/cloudApi.js';

/*
 * What the assistant did for the shop, in money and hours – the report every renewal depends on – plus the
 * "questions it couldn't answer" list (so owners can fill the gaps) and Google review requests after an order.
 */

const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (d = new Date()) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
const prevMonth = (d = new Date()) => monthKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// What an hour of a shop worker costs, by the shop's currency (UK National Living Wage from April 2026 for GBP).
const HOURLY = { GBP: 12.71, EUR: 13, USD: 15, AED: 40, INR: 200 };

function range(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || '')) ? String(month) : monthKey();
  const [y, mo] = m.split('-').map(Number);
  const start = `${m}-01 00:00:00`;
  const end = `${monthKey(new Date(Date.UTC(y, mo, 1)))}-01 00:00:00`;
  return { month: m, start, end };
}

/** Is this moment outside the shop's working hours? Default Mon–Fri 9am–5pm in the shop's time zone. */
function afterHours(utcSql, tz, open = 9, close = 17) {
  const d = new Date(utcSql.replace(' ', 'T') + 'Z');
  let parts;
  try { parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d); } catch { return false; }
  const wd = parts.find((p) => p.type === 'weekday')?.value;
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  return wd === 'Sat' || wd === 'Sun' || h < open || h >= close;
}

/** The monthly "money made" report. `month` is YYYY-MM (default: this month so far). */
export function valueReport(tenantId, month) {
  const t = getTenant(tenantId);
  if (!t) return null;
  const { month: m, start, end } = range(month);
  const d = getDb();
  const S = t.settings;
  const currency = S.business?.currency || 'GBP';
  const sym = S.business?.currencySymbol || '£';
  const R = S.report || {};
  const minutesPerReply = Number(R.minutesPerReply) > 0 ? Number(R.minutesPerReply) : 1.5;
  const hourlyRate = Number(R.hourlyRate) > 0 ? Number(R.hourlyRate) : HOURLY[currency] || 13;
  const notSim = "COALESCE(json_extract(body, '$.simulated'), 0) = 0";
  const win = 'tenant_id = ? AND created_at >= ? AND created_at < ?';

  const inbound = d.prepare(`SELECT wa_id, created_at FROM messages WHERE ${win} AND direction = 'in' AND ${notSim} LIMIT 200000`).all(tenantId, start, end);
  const chatIds = new Set(inbound.map((r) => r.wa_id));
  const webChats = [...chatIds].filter((w) => String(w).startsWith('web:')).length;
  const late = new Set();
  let lateMessages = 0;
  for (const r of inbound) if (afterHours(r.created_at, S.business?.timezone, Number(R.openHour ?? 9), Number(R.closeHour ?? 17))) { late.add(r.wa_id); lateMessages++; }

  const out = d.prepare(`SELECT wa_id, json_extract(body, '$.staff') AS staff FROM messages WHERE ${win} AND direction = 'out' AND type != 'template' AND ${notSim}`).all(tenantId, start, end).filter((r) => chatIds.has(r.wa_id));
  const botReplies = out.filter((r) => !r.staff).length;
  const staffChats = new Set(out.filter((r) => r.staff).map((r) => r.wa_id));

  const live = "status != 'cancelled'";
  const orders = d.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(subtotal), 0) AS v FROM orders WHERE ${win} AND ${live}`).get(tenantId, start, end);
  const recoveredCarts = d.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(subtotal), 0) AS v FROM orders WHERE ${win} AND ${live} AND recovered = 1`).get(tenantId, start, end);
  const chased = d.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(subtotal), 0) AS v FROM orders WHERE tenant_id = ? AND paid_at >= ? AND paid_at < ? AND reminded_at IS NOT NULL AND ${live}`).get(tenantId, start, end);
  const checkouts = d.prepare(`SELECT data FROM store_events WHERE ${win} AND kind = 'checkout' AND status = 'recovered'`).all(tenantId, start, end);
  const checkoutValue = checkouts.reduce((s, r) => s + (Number(json(r.data, {}).total) || 0), 0);
  const unanswered = d.prepare(`SELECT COUNT(*) AS n FROM unanswered WHERE ${win}`).get(tenantId, start, end).n;
  const reviews = d.prepare("SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND review_status = 'sent' AND review_sent_at >= ? AND review_sent_at < ?").get(tenantId, start, end).n;

  const hoursSaved = round2((botReplies * minutesPerReply) / 60);
  const staffValue = round2(hoursSaved * hourlyRate);
  const recovered = round2(recoveredCarts.v + checkoutValue + chased.v);
  const plan = PLANS[t.plan] || PLANS.starter;
  // Only compare like with like: the plan is billed in pounds
  const valueTotal = round2(recovered + staffValue);
  const roi = currency === 'GBP' && plan.priceGbp ? Math.round((valueTotal / plan.priceGbp) * 10) / 10 : null;

  return {
    month: m,
    partial: m === monthKey(),
    currency, sym,
    chats: chatIds.size,
    webChats,
    whatsappChats: chatIds.size - webChats,
    questions: inbound.length,
    botReplies,
    handledByBot: chatIds.size - staffChats.size,
    staffChats: staffChats.size,
    afterHoursChats: late.size,
    afterHoursMessages: lateMessages,
    orders: { count: orders.n, value: round2(orders.v) },
    recoveredCarts: { count: recoveredCarts.n, value: round2(recoveredCarts.v) },
    recoveredCheckouts: { count: checkouts.length, value: round2(checkoutValue) },
    paidAfterReminder: { count: chased.n, value: round2(chased.v) },
    recovered,
    hoursSaved,
    staffValue,
    valueTotal,
    plan: { label: plan.label, priceGbp: plan.priceGbp },
    roi,
    unanswered,
    reviewRequests: reviews,
    assumptions: { minutesPerReply, hourlyRate, hours: `${R.openHour ?? 9}:00–${R.closeHour ?? 17}:00 Mon–Fri` },
  };
}

const money = (n, sym) => `${sym}${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const monthName = (m) => new Date(`${m}-01T12:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function reportText(r, shopName) {
  const s = r.sym;
  const lines = [
    `*${shopName}: what your assistant did in ${monthName(r.month)}*`,
    '',
    `💬 ${r.chats} conversations (${r.whatsappChats} WhatsApp, ${r.webChats} website), ${r.questions} customer messages`,
    `🤖 ${r.handledByBot} handled without your team, ${r.botReplies} replies written for you`,
    `🌙 ${r.afterHoursChats} customers helped outside working hours (${r.assumptions.hours})`,
    `⏱️ About ${r.hoursSaved} hours of replies saved ≈ ${money(r.staffValue, s)} of staff time`,
  ];
  if (r.orders.count) lines.push(`🛒 ${r.orders.count} orders taken in chat: ${money(r.orders.value, s)}`);
  if (r.recovered) lines.push(`💷 ${money(r.recovered, s)} recovered from abandoned carts and payment reminders`);
  if (r.reviewRequests) lines.push(`⭐ ${r.reviewRequests} review requests sent`);
  if (r.roi) lines.push('', `Your ${r.plan.label} plan costs £${r.plan.priceGbp}/month. This month the assistant returned about *${r.roi}×* that.`);
  if (r.unanswered) lines.push('', `❓ ${r.unanswered} questions it couldn't answer – add the answers on the Knowledge base tab and it will know next time.`);
  lines.push('', `(Staff time counts ${r.assumptions.minutesPerReply} minutes per reply at ${s}${r.assumptions.hourlyRate}/hour – change these in Settings.)`);
  return lines.join('\n');
}

// ---------- questions the assistant couldn't answer ----------

const UNSURE = /\b(i'?m not (sure|certain)|i (do not|don'?t) (know|have (that|this|any|specific|the) (info|information|details))|i couldn'?t find|i could not find|no (specific )?information (about|on)|check with (the|our) team|(isn'?t|is not) (mentioned|listed|covered)|i (can'?t|cannot) (confirm|find))\b/i;

export function isUnsure(answer) { return UNSURE.test(String(answer || '')); }

/** Remember a question the assistant couldn't answer (one row per question per chat per day). */
export function recordUnanswered(tenantId, waId, question, answer, reason = 'unsure') {
  const q = String(question || '').trim().slice(0, 500);
  if (q.length < 6 || /^(hi|hello|hey|menu|human|thanks?|thank you|ok|yes|no)\b/i.test(q)) return false;
  const d = getDb();
  if (d.prepare("SELECT 1 FROM unanswered WHERE tenant_id = ? AND wa_id = ? AND question = ? AND created_at > datetime('now', '-1 day')").get(tenantId, waId, q)) return false;
  d.prepare('INSERT INTO unanswered (tenant_id, wa_id, question, answer, reason) VALUES (?, ?, ?, ?, ?)').run(tenantId, waId, q, String(answer || '').slice(0, 1000), reason);
  return true;
}

export function listUnanswered(tenantId, { status = 'open', limit = 100 } = {}) {
  return getDb().prepare('SELECT id, question, answer, reason, status, created_at FROM unanswered WHERE tenant_id = ? AND status = ? ORDER BY id DESC LIMIT ?').all(tenantId, status, limit);
}

export function setUnanswered(tenantId, id, status) {
  return getDb().prepare('UPDATE unanswered SET status = ? WHERE tenant_id = ? AND id = ?').run(status, tenantId, Number(id)).changes > 0;
}

export function getUnanswered(tenantId, id) {
  return getDb().prepare('SELECT * FROM unanswered WHERE tenant_id = ? AND id = ?').get(tenantId, Number(id));
}

// ---------- scheduled emails ----------

const once = (key) => {
  const r = getDb().prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').run(key, new Date().toISOString());
  return r.changes > 0;
};

/** On the 1st of each month (from 8am UTC): email each shop last month's report. */
export async function runMonthlyReports(now = new Date()) {
  if (now.getUTCDate() !== 1 || now.getUTCHours() < 8) return 0;
  const m = prevMonth(now);
  let sent = 0;
  for (const t of listTenants()) {
    if (!t.active || t.settings.report?.monthlyEmail === false) continue;
    const r = valueReport(t.id, m);
    if (!r || !r.chats) continue;
    if (!once(`value_report:${t.id}:${m}`)) continue;
    const name = t.settings.business?.name || t.name;
    await emailShop(t, `${name}: your assistant in ${monthName(m)}${r.roi ? ` – about ${r.roi}× its cost` : ''}`, reportText(r, name), { button: 'See the full report', path: '/admin/' })
      .then((x) => x.ok && sent++, (e) => console.warn('[value report]', e.message));
  }
  return sent;
}

/** Monday mornings: email each shop the questions its assistant couldn't answer last week. */
export async function runWeeklyUnanswered(now = new Date()) {
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 8) return 0;
  const week = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const t of listTenants()) {
    if (!t.active || t.settings.report?.unansweredEmail === false) continue;
    const rows = getDb().prepare("SELECT question, COUNT(*) AS n FROM unanswered WHERE tenant_id = ? AND status = 'open' AND created_at > datetime('now', '-7 days') GROUP BY lower(question) ORDER BY n DESC, MAX(id) DESC LIMIT 15").all(t.id);
    if (!rows.length || !once(`unanswered_report:${t.id}:${week}`)) continue;
    const name = t.settings.business?.name || t.name;
    const text = `*Questions your assistant couldn't answer this week*\n\n${rows.map((r) => `• ${r.question}${r.n > 1 ? ` (asked ${r.n}×)` : ''}`).join('\n')}\n\nOpen the Knowledge base tab, type the answer next to each question, and the assistant will use it from then on.`;
    await emailShop(t, `${name}: ${rows.length} question${rows.length > 1 ? 's' : ''} your assistant couldn't answer`, text, { button: 'Add the answers', path: '/admin/' })
      .then((x) => x.ok && sent++, (e) => console.warn('[unanswered report]', e.message));
  }
  return sent;
}

// ---------- Google review requests ----------

/**
 * A few hours after an order is delivered / completed, ask the customer for a review (once per order, max one per
 * customer every 30 days). Inside the 24h window it's a normal message with a button; outside it, only an approved
 * template can be used, so without one we skip.
 */
export async function runReviewRequests(now = Date.now()) {
  let sent = 0;
  for (const t of listTenants()) {
    const C = t.settings.notifications?.reviewRequest;
    if (!t.active || !C?.enabled || !C.url) continue;
    const hours = Math.max(0, Number(C.afterHours ?? 2));
    const rows = getDb().prepare(`SELECT * FROM orders WHERE tenant_id = ? AND status IN ('delivered', 'completed') AND review_sent_at IS NULL
      AND wa_id NOT LIKE 'web:%' AND updated_at > datetime('now', '-3 days') AND updated_at < datetime('now', ?)`).all(t.id, `-${hours * 60} minutes`);
    const send = createSender(t);
    for (const o of rows) {
      getDb().prepare("UPDATE orders SET review_sent_at = datetime('now') WHERE id = ?").run(o.id);
      const recent = getDb().prepare("SELECT 1 FROM orders WHERE tenant_id = ? AND wa_id = ? AND id != ? AND review_sent_at > datetime('now', '-30 days') AND review_status = 'sent'").get(t.id, o.wa_id, o.id);
      if (recent) { getDb().prepare("UPDATE orders SET review_status = 'skipped_recent' WHERE id = ?").run(o.id); continue; }
      const first = (o.customer_name || 'there').split(' ')[0];
      const name = t.settings.business?.name || t.name;
      const text = (C.text || 'Hi {{name}}, thanks for your order from {{shop}}! 😊 If you have a minute, a quick Google review would really help us.')
        .replace(/\{\{name\}\}/g, first).replace(/\{\{shop\}\}/g, name);
      const r = await notify(t, o.wa_id, { type: 'cta', text, buttonText: '⭐ Leave a review', url: C.url }, C.template ? { name: C.template, language: C.language, params: [first, name] } : null, send)
        .catch((e) => { console.warn('[review request]', e.message); return 'failed'; });
      getDb().prepare('UPDATE orders SET review_status = ? WHERE id = ?').run(r === 'sent' || r === 'template' ? 'sent' : r, o.id);
      if (r === 'sent' || r === 'template') sent++;
    }
  }
  return sent;
}
