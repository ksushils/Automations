import { getDb, json } from './db.js';
import { listOpportunities } from './opportunities.js';
import { topQuestions } from './learn.js';

/*
 * Owner copilot: answers the owner's everyday questions from the business's own records.
 * READ-ONLY by design – it never sends, changes or cancels anything. Answers are built by fixed rules from database
 * queries (no AI writing the numbers), so they can't invent customers, totals or bookings. Anything it can't answer
 * gets the list of questions it can.
 * Used from the dashboard (any team member) and from the team WhatsApp numbers saved in Settings (ownerCommand).
 */
const INTENTS = [
  ['priorities', /\b(priorit\w*|focus|what should i do|to ?do list|urgent)\b/i],
  ['today', /\b(what happened|today|summary|how (was|did) (today|it go)|overview|briefing)\b/i],
  ['callbacks', /\b(call ?backs?|call back|ring back|phone back|who (should|do) i call)\b/i],
  ['leads', /\b(leads?|enquir(y|ies)|inquir(y|ies))\b/i],
  ['quotes', /\bquotes?\b/i],
  ['tomorrow', /\b(tomorrow|appointments?|bookings?)\b/i],
  ['complaints', /\b(complain|complaints?|unhappy|angry|upset|problems?|issues?)\b/i],
  ['unanswered', /\b(could ?n.?t answer|not answer|unanswered|didn.?t know|gaps?)\b/i],
  ['common', /\b(common|popular|most (asked|frequent)|top (questions|requests)|what do (people|customers) ask)\b/i],
];
export const SUGGESTIONS = ['What happened today?', 'Which customers need callbacks?', 'What quotes are awaiting my approval?', 'What appointments are booked tomorrow?', 'Which complaints need attention?', 'What questions could the AI not answer?', 'What are my most common customer requests?', 'What should I prioritise today?'];

export function detectIntent(q) {
  const t = String(q || '');
  for (const [k, re] of INTENTS) if (re.test(t)) {
    if (k === 'leads' && /\bcall/i.test(t)) return 'callbacks';
    if (k === 'today' && /\b(appointments?|bookings?)\b/i.test(t) && /tomorrow/i.test(t)) return 'tomorrow';
    return k;
  }
  return null;
}

function localDay(tz, offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // YYYY-MM-DD
}
const name = (r) => r.name || (String(r.wa_id || '').startsWith('web:') ? 'Website visitor' : r.wa_id ? '+' + r.wa_id : 'Customer');

export function askCopilot(tenant, question) {
  const intent = detectIntent(question);
  const d = getDb();
  const tid = tenant.id;
  const sym = tenant.settings?.business?.currencySymbol || '£';
  const tz = tenant.settings?.business?.timezone || 'Europe/London';
  const out = (text, items = []) => ({ intent, answer: text, items, readOnly: true, source: 'Your own records (chats, leads, quotes, bookings, tickets)' });
  switch (intent) {
    case 'today': {
      const since = "datetime('now', 'start of day')";
      const one = (sql) => Number(Object.values(d.prepare(sql).get(tid))[0] || 0);
      const chats = one(`SELECT COUNT(DISTINCT wa_id) FROM messages WHERE tenant_id = ? AND direction = 'in' AND created_at >= ${since}`);
      const leads = one(`SELECT COUNT(*) FROM chat_leads WHERE tenant_id = ? AND created_at >= ${since}`);
      const orders = d.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(subtotal), 0) AS v FROM orders WHERE tenant_id = ? AND status != 'cancelled' AND created_at >= ${since}`).get(tid);
      const bookings = one(`SELECT COUNT(*) FROM bookings WHERE tenant_id = ? AND created_at >= ${since}`);
      const quotes = one(`SELECT COUNT(*) FROM quotes WHERE tenant_id = ? AND created_at >= ${since}`);
      const handovers = one('SELECT COUNT(*) FROM conversations WHERE tenant_id = ? AND human_handover = 1');
      const opp = listOpportunities(tenant).counts;
      return out(`Today so far (since midnight UTC): ${chats} customer${chats === 1 ? '' : 's'} chatted, ${leads} new lead${leads === 1 ? '' : 's'}, ${orders.n} order${orders.n === 1 ? '' : 's'}${orders.n ? ` (${sym}${Number(orders.v).toFixed(2)} ordered, not all paid yet)` : ''}, ${bookings} booking${bookings === 1 ? '' : 's'} made, ${quotes} quote request${quotes === 1 ? '' : 's'}. ${handovers} chat${handovers === 1 ? ' is' : 's are'} with your team. ${opp.total ? `${opp.total} thing${opp.total === 1 ? '' : 's'} need you (${opp.high} urgent) – see Opportunities.` : 'Nothing is waiting for you.'}`);
    }
    case 'callbacks': {
      const rows = d.prepare("SELECT id, wa_id, name, phone, topic, call_time, created_at FROM chat_leads WHERE tenant_id = ? AND status = 'new' AND kind = 'call' ORDER BY id LIMIT 20").all(tid);
      if (!rows.length) return out('No callbacks waiting. ✅');
      return out(`${rows.length} customer${rows.length === 1 ? '' : 's'} asked to be called back:`, rows.map((r) => `${name(r)}${r.phone ? ` – ${r.phone}` : ''}${r.topic && r.topic !== 'general' ? ` – about ${r.topic}` : ''}${r.call_time ? ` – best time: ${r.call_time}` : ''} (asked ${r.created_at.slice(0, 16)} UTC)`));
    }
    case 'leads': {
      const week = /\bweek\b/i.test(question);
      const rows = d.prepare(`SELECT kind, status, COUNT(*) AS n FROM chat_leads WHERE tenant_id = ? AND created_at >= datetime('now', ${week ? "'-7 days'" : "'start of day'"}) GROUP BY kind, status`).all(tid);
      const total = rows.reduce((s, r) => s + r.n, 0);
      const open = rows.filter((r) => r.status === 'new').reduce((s, r) => s + r.n, 0);
      return out(`${total} new lead${total === 1 ? '' : 's'} ${week ? 'in the last 7 days' : 'today'}${total ? ` – ${open} not contacted yet` : ''}.`);
    }
    case 'quotes': {
      const rows = d.prepare("SELECT number, name, request, total, items, status, sent_at FROM quotes WHERE tenant_id = ? AND status IN ('draft', 'sent') ORDER BY id LIMIT 20").all(tid);
      const drafts = rows.filter((r) => r.status === 'draft'), sent = rows.filter((r) => r.status === 'sent');
      if (!rows.length) return out('No quotes waiting – nothing to approve and nothing unanswered. ✅');
      const line = (r) => { const it = json(r.items, []); const priced = it.length && it.every((i) => i.price != null); return `Q-${r.number} ${r.name ? `for ${r.name} ` : ''}– ${String(r.request || '').slice(0, 60)}${priced ? ` – ${sym}${Number(r.total).toFixed(2)}` : ' – some prices still to confirm'}`; };
      return out(`${drafts.length} quote${drafts.length === 1 ? '' : 's'} waiting for your approval${sent.length ? `, ${sent.length} sent and not answered yet` : ''}.`, [...drafts.map((r) => '✏️ ' + line(r)), ...sent.map((r) => '📤 ' + line(r))]);
    }
    case 'tomorrow': {
      const day = localDay(tz, /\btoday\b/i.test(question) && !/tomorrow/i.test(question) ? 0 : 1);
      const rows = d.prepare("SELECT name, wa_id, service, time, status FROM bookings WHERE tenant_id = ? AND day = ? AND status NOT IN ('cancelled') ORDER BY time").all(tid, day);
      if (!rows.length) return out(`No appointments booked for ${day}.`);
      return out(`${rows.length} appointment${rows.length === 1 ? '' : 's'} on ${day}:`, rows.map((r) => `${r.time} – ${name(r)}${r.service ? ` – ${r.service}` : ''}${r.status !== 'confirmed' ? ` (${r.status.replace('_', ' ')})` : ''}`));
    }
    case 'complaints': {
      const unhappy = d.prepare("SELECT c.wa_id, cu.name, json_extract(c.state_data, '$.unhappyAt') AS u FROM conversations c LEFT JOIN customers cu ON cu.tenant_id = c.tenant_id AND cu.wa_id = c.wa_id WHERE c.tenant_id = ? AND json_extract(c.state_data, '$.unhappyAt') > datetime('now', '-7 days') ORDER BY u DESC LIMIT 10").all(tid);
      const tickets = d.prepare("SELECT number, name, subject, priority FROM tickets WHERE tenant_id = ? AND status IN ('open', 'pending') AND priority IN ('high', 'urgent') ORDER BY id LIMIT 10").all(tid);
      const bad = d.prepare("SELECT COUNT(*) AS n FROM chat_ratings WHERE tenant_id = ? AND score = 1 AND created_at > datetime('now', '-7 days')").get(tid).n;
      if (!unhappy.length && !tickets.length && !bad) return out('No complaints or unhappy customers in the last 7 days. ✅');
      return out(`In the last 7 days: ${unhappy.length} customer${unhappy.length === 1 ? '' : 's'} seemed unhappy, ${tickets.length} urgent ticket${tickets.length === 1 ? '' : 's'} open, ${bad} poor chat rating${bad === 1 ? '' : 's'}.`, [...unhappy.map((r) => `😠 ${name(r)} – read the chat in the Inbox`), ...tickets.map((t) => `🎫 Ticket #${t.number} (${t.priority}) – ${t.subject}${t.name ? ` – ${t.name}` : ''}`)]);
    }
    case 'unanswered': {
      const rows = d.prepare("SELECT question, COUNT(*) AS n FROM unanswered WHERE tenant_id = ? AND status = 'open' GROUP BY lower(question) ORDER BY n DESC, MAX(id) DESC LIMIT 10").all(tid);
      if (!rows.length) return out('The assistant answered everything it was asked recently. ✅');
      return out(`${rows.length} question${rows.length === 1 ? '' : 's'} the assistant couldn't answer – add the answers in Knowledge base:`, rows.map((r) => `“${String(r.question).slice(0, 100)}”${r.n > 1 ? ` (asked ${r.n} times)` : ''}`));
    }
    case 'common': {
      const rows = topQuestions(tid, { days: 30, n: 8 });
      if (!rows.length) return out('Not enough customer questions in the last 30 days to see a pattern yet.');
      return out('Most common customer questions in the last 30 days:', rows.map((r) => `${r.n}× like “${String(r.example).slice(0, 90)}”`));
    }
    case 'priorities': {
      const { items } = listOpportunities(tenant);
      if (!items.length) return out('Nothing urgent – no callbacks, quotes, bookings or customers waiting. ✅');
      return out(`Start with these (most urgent first):`, items.slice(0, 5).map((o) => `${o.priority === 'high' ? '🔴' : o.priority === 'medium' ? '🟠' : '⚪'} ${o.title}${o.customer?.name ? ` – ${o.customer.name}` : ''} → ${o.next}`));
    }
    default:
      return { intent: null, answer: 'I can answer questions about your own business records. Try one of these:', items: SUGGESTIONS, readOnly: true, source: null };
  }
}

/** Plain text for WhatsApp (owner/team numbers). */
export const copilotText = (r) => `${r.answer}${r.items.length ? '\n\n' + r.items.map((i) => `• ${i}`).join('\n') : ''}`;
