import { getDb, json } from './db.js';
import { getTenant, listTenants, PLANS } from './tenants.js';
import { emailShop } from './email.js';
import { createSender, notify } from './whatsapp/cloudApi.js';
import { clickStats } from './tracking.js';
import { getStore } from './stores/index.js';

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
  if (month === 'week') {
    const sql = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
    return { month: 'week', start: sql(new Date(Date.now() - 7 * 86400000)), end: sql(new Date(Date.now() + 60000)) };
  }
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

/** Website sales that came through the assistant's links (Shopify with a read-only key). Cached 6h. */
export async function assistantSales(tenant, month) {
  const { month: m, start, end } = range(month);
  if (!['shopify_public', 'shopify'].includes(tenant.settings.store?.type)) return null;
  const key = `asales:${tenant.id}:${m}`;
  const hit = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key);
  if (hit) { const j = json(hit.value, null); if (j && Date.now() - Date.parse(j.at) < 6 * 3600000) return j.data; }
  const store = getStore(tenant);
  if (!store.assistantSales) return null;
  const data = await store.assistantSales({ from: start.replace(' ', 'T') + 'Z', to: end.replace(' ', 'T') + 'Z' }).catch((e) => { console.warn('[assistant sales]', e.message); return null; });
  if (data) getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify({ at: new Date().toISOString(), data }));
  return data;
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
  // leads, bookings, tickets and ratings – what turned into business
  const leads = d.prepare(`SELECT COUNT(*) AS n, SUM(kind = 'call') AS calls FROM chat_leads WHERE ${win}`).get(tenantId, start, end);
  const bookings = d.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE ${win} AND status != 'cancelled'`).get(tenantId, start, end).n;
  const tickets = d.prepare("SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ? AND solved_at >= ? AND solved_at < ?").get(tenantId, start, end).n;
  const rated = d.prepare(`SELECT SUM(score = 3) AS great, SUM(score = 2) AS ok, SUM(score = 1) AS bad FROM chat_ratings WHERE ${win}`).get(tenantId, start, end);
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
    partial: m === monthKey() || m === 'week',
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
    leads: { count: leads.n || 0, callbacks: leads.calls || 0 },
    bookings,
    ticketsSolved: tickets,
    ratings: { great: rated.great || 0, ok: rated.ok || 0, bad: rated.bad || 0 },
    links: clickStats(tenantId, start, end),
    assumptions: { minutesPerReply, hourlyRate, hours: `${R.openHour ?? 9}:00–${R.closeHour ?? 17}:00 Mon–Fri` },
  };
}

const money = (n, sym) => `${sym}${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const monthName = (m) => (m === 'week' ? 'the last 7 days' : new Date(`${m}-01T12:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }));

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
  if (r.leads?.count) lines.push(`📇 ${r.leads.count} leads (${r.leads.callbacks} call-back requests)`);
  if (r.bookings) lines.push(`📅 ${r.bookings} bookings made in the chat`);
  if (r.orders.count) lines.push(`🛒 ${r.orders.count} orders taken in chat: ${money(r.orders.value, s)}`);
  if (r.ticketsSolved) lines.push(`🎫 ${r.ticketsSolved} support tickets solved`);
  if (r.ratings && r.ratings.great + r.ratings.ok + r.ratings.bad) lines.push(`😀 ${r.ratings.great} · 😐 ${r.ratings.ok} · 😞 ${r.ratings.bad} chat ratings`);
  if (r.websiteSales?.orders) lines.push(`🌐 ${r.websiteSales.orders} website orders after chatting with the assistant: ${money(r.websiteSales.value, s)}`);
  if (r.links?.linksClicked) lines.push(`🔗 ${r.links.linksClicked} shop links opened from the chat${r.links.checkoutsStarted ? `, ${r.links.checkoutsStarted} checkouts started` : ''}`);
  if (r.recovered) lines.push(`💷 ${money(r.recovered, s)} recovered from abandoned carts and payment reminders`);
  if (r.reviewRequests) lines.push(`⭐ ${r.reviewRequests} review requests sent`);
  if (r.roi && r.month !== 'week') lines.push('', `Your ${r.plan.label} plan costs £${r.plan.priceGbp}/month. This month the assistant returned about *${r.roi}×* that.`);
  if (r.unanswered) lines.push('', `❓ ${r.unanswered} questions it couldn't answer – add the answers on the Knowledge base tab and it will know next time.`);
  lines.push('', `(Staff time counts ${r.assumptions.minutesPerReply} minutes per reply at ${s}${r.assumptions.hourlyRate}/hour – change these in Settings.)`);
  return lines.join('\n');
}

// ---------- questions the assistant couldn't answer ----------

const UNSURE = /\b(i'?m not (sure|certain)|i (do not|don'?t) (know|have (that|this|any|specific|the) (info|information|details))|i couldn'?t find|i could not find|no (specific )?information (about|on)|check with (the|our) team|(isn'?t|is not) (mentioned|listed|covered)|i (can'?t|cannot) (confirm|find))\b/i;

export function isUnsure(answer) { return UNSURE.test(String(answer || '')); }

/** Remember a question the assistant couldn't answer (one row per question per chat per day). */
export function recordUnanswered(tenantId, waId, question, answer, reason = 'unsure') {
  if (String(waId).startsWith('qa:')) return false; // the automatic answer check reports its own results
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
    r.websiteSales = await assistantSales(t, m);
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
    const { outreachCheck, logOutreach } = await import('./outreach.js');
    for (const o of rows) {
      const gate = outreachCheck(t, o.wa_id, 'review_request', { ref: `order:${o.id}` });
      if (!gate.ok && gate.retry) continue; // quiet hours – next run
      getDb().prepare("UPDATE orders SET review_sent_at = datetime('now') WHERE id = ?").run(o.id);
      if (!gate.ok) { getDb().prepare("UPDATE orders SET review_status = 'skipped_limit' WHERE id = ?").run(o.id); if (!gate.duplicate) logOutreach(t.id, o.wa_id, 'review_request', { ref: `order:${o.id}`, status: 'skipped', detail: gate.reason }); continue; }
      const recent = getDb().prepare("SELECT 1 FROM orders WHERE tenant_id = ? AND wa_id = ? AND id != ? AND review_sent_at > datetime('now', '-30 days') AND review_status = 'sent'").get(t.id, o.wa_id, o.id);
      if (recent) { getDb().prepare("UPDATE orders SET review_status = 'skipped_recent' WHERE id = ?").run(o.id); continue; }
      const first = (o.customer_name || 'there').split(' ')[0];
      const name = t.settings.business?.name || t.name;
      const text = (C.text || 'Hi {{name}}, thanks for your order from {{shop}}! 😊 If you have a minute, a quick Google review would really help us.')
        .replace(/\{\{name\}\}/g, first).replace(/\{\{shop\}\}/g, name);
      const r = await notify(t, o.wa_id, { type: 'cta', text, buttonText: '⭐ Leave a review', url: C.url }, C.template ? { name: C.template, language: C.language, params: [first, name] } : null, send)
        .catch((e) => { console.warn('[review request]', e.message); return 'failed'; });
      getDb().prepare('UPDATE orders SET review_status = ? WHERE id = ?').run(r === 'sent' || r === 'template' ? 'sent' : r, o.id);
      logOutreach(t.id, o.wa_id, 'review_request', { ref: `order:${o.id}`, status: r === 'sent' || r === 'template' ? 'sent' : r === 'failed' ? 'failed' : 'skipped', detail: r === 'sent' || r === 'template' ? null : r });
      if (r === 'sent' || r === 'template') sent++;
    }
  }
  return sent;
}

/** Monday morning: last week in a few lines, by email and to the team's WhatsApp (settings.report.weeklyDigest). */
export async function runWeeklyDigests(now = new Date()) {
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 7) return 0;
  const week = `${now.getUTCFullYear()}-${Math.ceil((now - new Date(Date.UTC(now.getUTCFullYear(), 0, 1))) / 604800000)}`;
  let sent = 0;
  for (const { id } of listTenants()) {
    const t = getTenant(id);
    if (!t?.active || t.settings.demo || t.settings.report?.weeklyDigest === false) continue;
    const d = getDb();
    if (d.prepare('SELECT 1 FROM kv WHERE key = ?').get(`digest:${id}:${week}`)) continue;
    d.prepare("INSERT INTO kv (key, value) VALUES (?, '1')").run(`digest:${id}:${week}`);
    const r = valueReport(id, 'week');
    if (!r || !r.chats) continue;
    const text = reportText(r, t.settings.business?.name || t.name);
    emailShop(t, `Your assistant last week: ${r.chats} chats, ${r.leads.count} leads${r.orders.count ? `, ${r.orders.count} orders` : ''}`, text, { button: 'See the details' }).catch(() => {});
    const short = `📊 Last week: ${r.chats} chats, ${r.handledByBot} handled by the assistant, ${r.leads.count} leads, ${r.bookings} bookings${r.orders.count ? `, ${r.orders.count} orders (${money(r.orders.value, r.sym)})` : ''}. ${r.afterHoursChats} out of hours.`;
    for (const s of t.settings.notifications?.staffWaIds || []) notify(t, String(s).replace(/\D/g, ''), { type: 'text', text: short }, null).catch(() => {});
    sent++;
  }
  return sent;
}

/**
 * Revenue by advert / campaign: where each chat came from (a Click-to-WhatsApp ad, or the campaign tags on the page
 * they landed on) and what it turned into – chats, leads, bookings, orders and money.
 */
export function adReport(tenantId, days = 30) {
  const d = getDb();
  const since = `-${Math.max(1, Math.min(365, Number(days) || 30))} days`;
  const chats = d.prepare(`SELECT DISTINCT m.wa_id, cu.source AS csrc, c.state_data AS sd FROM messages m
    LEFT JOIN customers cu ON cu.tenant_id = m.tenant_id AND cu.wa_id = m.wa_id
    LEFT JOIN conversations c ON c.tenant_id = m.tenant_id AND c.wa_id = m.wa_id
    WHERE m.tenant_id = ? AND m.direction = 'in' AND m.wa_id NOT LIKE 'qa:%' AND m.created_at > datetime('now', ?)`).all(tenantId, since);
  const groups = new Map();
  for (const row of chats) {
    const src = json(row.csrc, null), utm = json(row.sd, {})?.utm;
    let key, label, kind;
    if (src?.source_id || src?.headline || src?.source_url) { kind = 'ad'; key = `ad:${src.source_id || src.headline || src.source_url}`; label = src.headline || src.source_url || `Ad ${src.source_id}`; }
    else if (utm?.utm_campaign || utm?.utm_source || utm?.gclid || utm?.fbclid) { kind = 'campaign'; label = utm.utm_campaign ? `${utm.utm_source || 'campaign'} · ${utm.utm_campaign}` : utm.gclid ? 'Google Ads' : utm.fbclid ? 'Facebook / Instagram' : utm.utm_source; key = `utm:${label}`; }
    else { kind = 'direct'; key = 'direct'; label = 'No advert (direct, search or social)'; }
    const g = groups.get(key) || { key, kind, label: String(label).slice(0, 120), chats: 0, leads: 0, bookings: 0, orders: 0, revenue: 0, waIds: [] };
    g.chats++; g.waIds.push(row.wa_id);
    groups.set(key, g);
  }
  const count = (sql, ids) => (ids.length ? d.prepare(sql.replace('(?)', `(${ids.map(() => '?').join(',')})`)).get(tenantId, ...ids, since) : { n: 0, v: 0 });
  const out = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.waIds.length; i += 400) {
      const ids = g.waIds.slice(i, i + 400);
      g.leads += count("SELECT COUNT(*) AS n FROM chat_leads WHERE tenant_id = ? AND wa_id IN (?) AND created_at > datetime('now', ?)", ids).n;
      g.bookings += count("SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND wa_id IN (?) AND status != 'cancelled' AND created_at > datetime('now', ?)", ids).n;
      const o = count("SELECT COUNT(*) AS n, COALESCE(SUM(subtotal), 0) AS v FROM orders WHERE tenant_id = ? AND wa_id IN (?) AND status != 'cancelled' AND created_at > datetime('now', ?)", ids);
      g.orders += o.n; g.revenue += o.v || 0;
    }
    const { waIds, ...rest } = g;
    out.push({ ...rest, revenue: round2(rest.revenue) });
  }
  return out.sort((a, b) => (a.kind === 'direct') - (b.kind === 'direct') || b.revenue - a.revenue || b.leads - a.leads || b.chats - a.chats);
}
