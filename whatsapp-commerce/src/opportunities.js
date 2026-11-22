import { getDb, json } from './db.js';

/*
 * Opportunity Radar: things a business can act on today, found ONLY in its own records – never guessed.
 * Each item says why it's listed (with the evidence and when it happened), what to do next, and a value only when
 * the record itself has one (a quote's total, an order's subtotal) – never an estimate of what might be earned.
 * Items disappear on their own when the underlying record moves on (lead contacted, quote accepted, booking
 * confirmed…). The owner can also resolve or snooze an item; that choice is kept in opportunity_state.
 */
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ts = (s) => (s ? Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z') : NaN);
const money = (n, sym = '£') => `${sym}${Number(n).toFixed(2)}`;
const clip = (s, n = 160) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function listOpportunities(tenant, { now = Date.now(), includeClosed = false } = {}) {
  const d = getDb();
  const tid = tenant.id;
  const sym = tenant.settings?.business?.currencySymbol || '£';
  const items = [];
  const add = (o) => items.push({ value: null, valueBasis: null, customer: {}, actions: [], ...o, ageMinutes: Math.max(0, Math.round((now - o.at) / MIN)) });
  const names = new Map(d.prepare('SELECT wa_id, name FROM customers WHERE tenant_id = ?').all(tid).map((r) => [r.wa_id, r.name]));
  const who = (waId, name, phone, email) => ({ waId: waId || null, name: name || names.get(waId) || null, phone: phone || (waId && /^\d{8,15}$/.test(waId) ? '+' + waId : null), email: email || null });

  // 1. callbacks / detail requests nobody has answered yet
  for (const l of d.prepare("SELECT * FROM chat_leads WHERE tenant_id = ? AND status = 'new' ORDER BY id DESC LIMIT 200").all(tid)) {
    const at = ts(l.created_at);
    if (now - at < 15 * MIN) continue; // give the team a moment first
    const call = l.kind === 'call';
    add({
      key: `lead:${l.id}`, type: call ? 'callback' : 'enquiry', at,
      title: call ? 'Callback requested – nobody has replied yet' : 'Customer asked for details – not contacted yet',
      reason: `${call ? 'Asked to be called' : 'Left their details'}${l.topic ? ` about “${clip(l.topic, 60)}”` : ''}${l.call_time ? ` (best time: ${clip(l.call_time, 40)})` : ''}.`,
      evidence: clip(l.summary || l.message || l.topic, 240), source: { kind: 'lead', id: l.id },
      next: call ? 'Call them back' : 'Send them the details',
      priority: call || now - at > 4 * HOUR ? 'high' : 'medium',
      customer: who(l.wa_id, l.name, l.phone, l.email),
      actions: ['view', ...(l.phone ? ['call'] : []), 'mark_contacted'],
    });
  }

  // 2. customers waiting for a person (handover) whose last message has had no reply
  for (const c of d.prepare(`SELECT c.wa_id, c.updated_at,
      (SELECT MAX(id) FROM messages m WHERE m.tenant_id = c.tenant_id AND m.wa_id = c.wa_id AND m.direction = 'in') AS last_in,
      (SELECT MAX(id) FROM messages m WHERE m.tenant_id = c.tenant_id AND m.wa_id = c.wa_id AND m.direction = 'out') AS last_out
      FROM conversations c WHERE c.tenant_id = ? AND c.human_handover = 1`).all(tid)) {
    if (!c.last_in || (c.last_out && c.last_out > c.last_in)) continue;
    const m = d.prepare('SELECT body, created_at FROM messages WHERE id = ?').get(c.last_in);
    const at = ts(m.created_at);
    add({
      key: `handover:${c.wa_id}:${c.last_in}`, type: 'waiting_for_person', at,
      title: 'Customer is waiting for a person', reason: 'The assistant handed this chat to your team and the customer\'s last message has no reply.',
      evidence: clip(json(m.body, {}).text || json(m.body, {}).caption || '(photo or file)', 240), source: { kind: 'conversation', waId: c.wa_id },
      next: 'Reply in the Inbox', priority: 'high', customer: who(c.wa_id), actions: ['view'],
    });
  }

  // 3. quotes: waiting for the team's approval, or sent and not answered
  for (const q of d.prepare("SELECT * FROM quotes WHERE tenant_id = ? AND status IN ('draft', 'sent') ORDER BY id DESC LIMIT 200").all(tid)) {
    const items = json(q.items, []);
    const priced = items.length > 0 && items.every((i) => i.price != null && i.price !== '');
    const value = priced && q.total > 0 ? { value: q.total, valueBasis: `Quote Q-${q.number} total` } : {};
    if (q.status === 'draft') {
      const at = ts(q.created_at);
      add({
        key: `quote_draft:${q.id}`, type: 'quote_approval', at, ...value,
        title: `Quote Q-${q.number} is waiting for your approval`, reason: 'A customer asked for a quote. The draft has not been sent yet.',
        evidence: clip(q.request, 240), source: { kind: 'quote', number: q.number },
        next: priced ? 'Check the prices and send the quote' : 'Add the missing prices, then send the quote',
        priority: now - at > DAY ? 'high' : 'medium', customer: who(q.wa_id, q.name, q.phone, q.email), actions: ['open_quote', 'view'],
      });
    } else if (q.sent_at && now - ts(q.sent_at) > 2 * DAY) {
      add({
        key: `quote_sent:${q.id}`, type: 'quote_no_reply', at: ts(q.sent_at), ...value,
        title: `Quote Q-${q.number} sent – no answer yet`, reason: `Sent ${Math.round((now - ts(q.sent_at)) / DAY)} days ago and not accepted or declined.${q.followed_up_at ? ' An automatic reminder was already sent.' : ''}`,
        evidence: clip(q.request, 240), source: { kind: 'quote', number: q.number },
        next: q.phone ? 'Give them a quick call' : 'Send a short follow-up', priority: 'medium',
        customer: who(q.wa_id, q.name, q.phone, q.email), actions: ['open_quote', ...(q.phone ? ['call'] : []), 'view'],
      });
    }
  }

  // 4. bookings: requests not confirmed; cancelled future slots that are free again
  for (const b of d.prepare("SELECT * FROM bookings WHERE tenant_id = ? AND status IN ('requested', 'cancelled') AND starts_at > ? ORDER BY starts_at LIMIT 200").all(tid, new Date(now).toISOString().replace('T', ' ').slice(0, 19))) {
    const when = `${b.day} ${b.time}`;
    if (b.status === 'requested') add({
      key: `booking_req:${b.id}`, type: 'booking_request', at: ts(b.created_at),
      title: 'Booking request waiting for confirmation', reason: `${b.service ? clip(b.service, 60) + ' on ' : ''}${when}. The customer hasn't been told it's confirmed.`,
      evidence: clip(b.notes, 200) || null, source: { kind: 'booking', id: b.id },
      next: 'Confirm or suggest another time', priority: ts(b.starts_at) - now < 2 * DAY ? 'high' : 'medium',
      customer: who(b.wa_id, b.name), actions: ['confirm_booking', 'view'],
    });
    else add({
      key: `booking_free:${b.id}`, type: 'free_slot', at: ts(b.updated_at || b.created_at),
      title: `A cancelled slot is free: ${when}`, reason: `${b.service ? clip(b.service, 60) : 'A booking'} was cancelled, so this time is available again.`,
      evidence: null, source: { kind: 'booking', id: b.id }, next: 'Offer it to someone who wanted an earlier time', priority: 'low', customer: {}, actions: ['open_bookings'],
    });
  }

  // 5. questions the assistant couldn't answer (one item, grouped)
  const un = d.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM unanswered WHERE tenant_id = ? AND status = 'open'").get(tid);
  if (un.n > 0) {
    const ex = d.prepare("SELECT question FROM unanswered WHERE tenant_id = ? AND status = 'open' ORDER BY id DESC LIMIT 3").all(tid).map((r) => `“${clip(r.question, 80)}”`);
    add({
      key: `unanswered:${un.last}`, type: 'knowledge_gap', at: ts(un.last),
      title: `${un.n} customer question${un.n === 1 ? '' : 's'} the assistant couldn't answer`, reason: 'Teach the answer once and the assistant uses it from then on.',
      evidence: ex.join(' · '), source: { kind: 'unanswered' }, next: 'Add the answers', priority: un.n >= 5 ? 'medium' : 'low', actions: ['open_unanswered'],
    });
  }

  // 6. open tickets with no reply after a working day
  for (const t of d.prepare("SELECT * FROM tickets WHERE tenant_id = ? AND status = 'open' AND first_reply_at IS NULL ORDER BY id DESC LIMIT 100").all(tid)) {
    const at = ts(t.created_at);
    if (now - at < 8 * HOUR) continue;
    add({
      key: `ticket:${t.id}`, type: 'ticket_no_reply', at, title: `Ticket #${t.number} has no reply yet`, reason: clip(t.subject, 100),
      evidence: clip(t.summary || t.description, 240) === clip(t.subject, 100) ? null : clip(t.summary || t.description, 240), source: { kind: 'ticket', number: t.number }, next: 'Reply to the customer',
      priority: ['high', 'urgent'].includes(t.priority) || now - at > 2 * DAY ? 'high' : 'medium', customer: who(t.wa_id, t.name, t.phone, t.email), actions: ['open_ticket'],
    });
  }

  // 7. unhappy customers in the last 3 days
  for (const c of d.prepare("SELECT wa_id, json_extract(state_data, '$.unhappyAt') AS u FROM conversations WHERE tenant_id = ? AND json_extract(state_data, '$.unhappyAt') IS NOT NULL").all(tid)) {
    const at = ts(c.u);
    if (!at || now - at > 3 * DAY) continue;
    add({
      key: `unhappy:${c.wa_id}:${c.u}`, type: 'unhappy', at, title: 'A customer seemed unhappy', reason: 'Their messages read as frustrated or angry.',
      evidence: null, source: { kind: 'conversation', waId: c.wa_id }, next: 'Read the chat and reply personally', priority: 'high', customer: who(c.wa_id), actions: ['view'],
    });
  }

  // 8. orders waiting for payment for over an hour (shown, never chased automatically from here)
  for (const o of d.prepare("SELECT * FROM orders WHERE tenant_id = ? AND payment_status = 'unpaid' AND payment_method IN ('payment_link', 'bank_transfer') AND status NOT IN ('cancelled', 'completed') AND created_at > datetime('now', '-7 days') ORDER BY id DESC LIMIT 100").all(tid)) {
    const at = ts(o.created_at);
    if (now - at < HOUR) continue;
    add({
      key: `order_unpaid:${o.id}`, type: 'unpaid_order', at, value: o.subtotal, valueBasis: `Order ${o.store_order_name || o.id} subtotal`,
      title: `Order ${o.store_order_name || '#' + o.id} is waiting for payment`, reason: `${o.payment_method === 'bank_transfer' ? 'Bank transfer' : 'Payment link'} not paid yet${o.reminded_at ? ' (one reminder already sent)' : ''}.`,
      evidence: null, source: { kind: 'order', id: o.id }, next: 'Check your bank or contact the customer', priority: 'medium', customer: who(o.wa_id, o.customer_name), actions: ['open_order', 'view'],
    });
  }

  // owner decisions (resolved / snoozed)
  const states = new Map(d.prepare('SELECT key, status, snooze_until FROM opportunity_state WHERE tenant_id = ?').all(tid).map((r) => [r.key, r]));
  const order = { high: 0, medium: 1, low: 2 };
  const out = items.map((o) => {
    const s = states.get(o.key);
    const status = !s ? 'open' : s.status === 'snoozed' && ts(s.snooze_until) <= now ? 'open' : s.status;
    return { ...o, status, snoozeUntil: status === 'snoozed' ? s.snooze_until : null, valueText: o.value != null ? money(o.value, sym) : null };
  }).filter((o) => includeClosed || o.status === 'open')
    .sort((a, b) => order[a.priority] - order[b.priority] || a.at - b.at);
  return { items: out, counts: { high: out.filter((o) => o.priority === 'high').length, total: out.length }, note: 'Built from your own records only. Values are shown only where a quote or order has a total – they are not predictions.' };
}

export function setOpportunityState(tenantId, key, action, { hours = 24 } = {}) {
  const k = String(key || '').slice(0, 200);
  if (!/^[a-z_]+:/.test(k)) throw Object.assign(new Error('Unknown item'), { status: 400 });
  const d = getDb();
  if (action === 'reopen') { d.prepare('DELETE FROM opportunity_state WHERE tenant_id = ? AND key = ?').run(tenantId, k); return { ok: true }; }
  if (!['resolve', 'snooze'].includes(action)) throw Object.assign(new Error('Unknown action'), { status: 400 });
  const until = action === 'snooze' ? new Date(Date.now() + Math.min(24 * 30, Math.max(1, Number(hours) || 24)) * HOUR).toISOString() : null;
  d.prepare(`INSERT INTO opportunity_state (tenant_id, key, status, snooze_until) VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET status = excluded.status, snooze_until = excluded.snooze_until, updated_at = datetime('now')`).run(tenantId, k, action === 'resolve' ? 'resolved' : 'snoozed', until);
  return { ok: true, snoozeUntil: until };
}
