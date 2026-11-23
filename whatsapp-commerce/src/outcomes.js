import crypto from 'node:crypto';
import express from 'express';
import { getDb, json } from './db.js';
import { getTenant } from './tenants.js';
import { audit } from './privacy.js';

/*
 * Customer outcome tracker – what Demo Engine (the marketing dashboard) may read, per business, read-only.
 *
 * Source of truth stays the existing records here (chat_leads, conversations/messages, bookings, quotes, orders).
 * Nothing is copied into a second CRM: events are DERIVED from those records into an append-only log
 * (outcome_events) the first time they're seen, each with a stable event_id (dedup key) and a monotonic seq
 * (reading cursor). Re-deriving is idempotent (INSERT OR IGNORE on event_id), so history can be backfilled safely.
 *
 * Data minimisation: no names, phone numbers, emails, addresses, message text or free-text answers ever leave.
 * A customer is a pseudonymous id (HMAC of their chat id, per business), so Demo Engine can follow one journey
 * (enquiry → booking → order) without knowing who it is. Page URLs lose their query strings.
 *
 * Money carries its provenance:
 *   payment_recorded   – an order marked paid (card via Stripe, or marked paid by the business) – verified
 *   cash_completed     – a cash-on-delivery order completed – verified
 *   customer_accepted  – a quote the customer accepted online – verified (agreed, not yet paid)
 *   deposit_paid       – a booking deposit paid through Stripe – verified
 *   quoted             – a quote sent (an offer, not money)
 *   order_total        – an order placed (not yet paid)
 *   owner_entered      – a value the business typed on a lead – NOT verified; labelled as such
 */
export const SCHEMA_VERSION = 1;
export const EVENT_TYPES = {
  'enquiry.created': 'A lead from the chat (call back or details request)',
  'lead.status_changed': 'NEW → CONTACTED → QUALIFIED → WON / LOST, by the business',
  'lead.value_set': 'The business entered (or cleared) the job/order value on a lead – provenance owner_entered',
  'conversation.started': 'A customer wrote after 24 hours or more of silence (website chat or WhatsApp)',
  'conversation.first_response': 'The first reply to that conversation (assistant or staff), with the delay',
  'booking.requested': 'A booking made in the chat',
  'booking.confirmed': 'Confirmed (by the business, automatically, or after a deposit)',
  'booking.completed': 'Marked done by the business',
  'booking.cancelled': 'Cancelled or a no-show',
  'quote.requested': 'A quote request from the chat',
  'quote.sent': 'The business sent the quote (value = quoted)',
  'quote.accepted': 'The customer accepted it online (value = customer_accepted, verified)',
  'order.created': 'An order placed in the chat (value = order_total)',
  'order.paid': 'The order was paid (value = payment_recorded, verified)',
  'order.completed': 'A cash order completed (value = cash_completed, verified)',
};
const GAP_HOURS = 24;
const MAX_LOOKBACK_DAYS = 400;

// ---------- helpers ----------
const iso = (sql) => (sql ? (String(sql).includes('T') ? new Date(String(sql).endsWith('Z') ? sql : `${sql}Z`).toISOString() : new Date(`${String(sql).replace(' ', 'T')}Z`).toISOString()) : null);
const r2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
// a random salt kept in the database (created once): customer ids stay the same even if the encryption key is rotated
let salt = null;
const pepper = () => {
  if (salt) return salt;
  const d = getDb();
  let v = d.prepare("SELECT value FROM kv WHERE key = 'outcomes:salt'").get()?.value;
  if (!v) { v = crypto.randomBytes(32).toString('hex'); d.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('outcomes:salt', ?)").run(v); v = d.prepare("SELECT value FROM kv WHERE key = 'outcomes:salt'").get().value; }
  return (salt = Buffer.from(v, 'hex'));
};
export const _resetSaltCache = () => { salt = null; }; // tests
/** Stable, pseudonymous customer id for one business (no way back to the phone number). */
export const customerRef = (tenantId, waId) => (waId ? 'c_' + crypto.createHmac('sha256', pepper()).update(`${tenantId}|${waId}`).digest('hex').slice(0, 20) : null);
const channelOf = (waId) => (String(waId || '').startsWith('web:') ? 'website' : waId ? 'whatsapp' : null);
const isTest = (waId) => /^(qa:|sim:|web:sample)/.test(String(waId || '')) || String(waId || '') === '440000000000';
const pathOnly = (u) => { try { const x = new URL(String(u)); return x.origin + x.pathname; } catch { return null; } };

/** Where the customer came from: a Click-to-WhatsApp ad, tagged links (UTM), a website page, or unknown. */
export function sourceOf({ leadSource, customerSource, page, channel }) {
  const s = { ...(json(customerSource, null) || {}), ...(json(leadSource, null) || {}) };
  const out = { type: 'direct' };
  if (s.source_id || s.ctwa_clid || s.source_type === 'ad') Object.assign(out, { type: 'ctwa_ad', ad_id: s.source_id ? String(s.source_id).slice(0, 40) : null });
  else if (s.utm_source || s.utm_campaign) out.type = 'utm';
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) if (s[k]) out[k] = String(s[k]).slice(0, 100);
  const p = pathOnly(page);
  if (p) out.landing_page = p;
  if (out.type === 'direct' && !p && channel === 'whatsapp' && !Object.keys(s).length) out.type = 'unknown';
  return out;
}

function money(tenant) { return tenant.settings?.business?.currency || 'GBP'; }

// ---------- derive events from the existing records (idempotent) ----------
export function syncOutcomes(tenant, { now = Date.now() } = {}) {
  const d = getDb();
  const tid = tenant.id;
  const since = new Date(now - MAX_LOOKBACK_DAYS * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const cur = money(tenant);
  const ins = d.prepare('INSERT OR IGNORE INTO outcome_events (tenant_id, event_id, type, occurred_at, payload) VALUES (?, ?, ?, ?, ?)');
  const custSrc = new Map(d.prepare('SELECT wa_id, source FROM customers WHERE tenant_id = ? AND source IS NOT NULL').all(tid).map((r) => [r.wa_id, r.source]));
  let added = 0;
  const emit = (event_id, type, occurred, { subject, waId = null, source = null, data = {} }) => {
    if (!occurred) return;
    const at = iso(occurred);
    const payload = { event_id, type, version: SCHEMA_VERSION, occurred_at: at, subject, customer: customerRef(tid, waId), channel: channelOf(waId), source, data };
    added += Number(ins.run(tid, event_id, type, at, JSON.stringify(payload)).changes);
  };
  const events = [];
  // leads
  for (const l of d.prepare('SELECT * FROM chat_leads WHERE tenant_id = ? AND created_at >= ?').all(tid, since)) {
    if (isTest(l.wa_id)) continue;
    const subject = { type: 'lead', id: `lead_${l.id}` };
    const source = sourceOf({ leadSource: l.source, customerSource: custSrc.get(l.wa_id), page: l.page, channel: channelOf(l.wa_id) });
    events.push([l.created_at, `lead_${l.id}.created`, 'enquiry.created', l.created_at, { subject, waId: l.wa_id, source, data: { kind: l.kind === 'call' ? 'callback' : 'details', urgent: !!l.urgent, answered_questions: (json(l.answers, []) || []).filter((a) => a.a).length, area_covered: json(l.area, null)?.covered ?? null } }]);
    const hist = d.prepare('SELECT * FROM lead_events WHERE tenant_id = ? AND lead_id = ? ORDER BY id').all(tid, l.id);
    if (!hist.some((h) => h.kind === 'status') && l.status && l.status !== 'new') {
      // changed before history was kept: one back-filled event from the stored timestamps
      const at = l.status === 'won' ? l.won_at || l.contacted_at : l.contacted_at;
      if (at) events.push([at, `lead_${l.id}.status.backfill.${l.status}`, 'lead.status_changed', at, { subject, waId: l.wa_id, data: { from: null, to: l.status, actor: 'unknown', backfilled: true, ...(l.status === 'won' && l.value != null ? { value: r2(l.value), currency: cur, provenance: l.value_source || 'owner_entered' } : {}) } }]);
    }
    for (const h of hist) {
      if (h.kind === 'status') {
        const won = h.to_status === 'won';
        const val = won ? d.prepare("SELECT value FROM lead_events WHERE tenant_id = ? AND lead_id = ? AND kind = 'value' AND id <= ? ORDER BY id DESC LIMIT 1").get(tid, l.id, h.id)?.value ?? null : null;
        events.push([h.created_at, `lead_${l.id}.status.${h.id}`, 'lead.status_changed', h.created_at, { subject, waId: l.wa_id, data: { from: h.from_status, to: h.to_status, actor: h.actor?.startsWith('staff:') ? 'staff' : h.actor || 'unknown', ...(won ? { value: r2(val), currency: cur, provenance: val == null ? null : 'owner_entered' } : {}) } }]);
      } else if (h.kind === 'value') {
        events.push([h.created_at, `lead_${l.id}.value.${h.id}`, 'lead.value_set', h.created_at, { subject, waId: l.wa_id, data: { value: r2(h.value), currency: cur, provenance: h.value == null ? null : 'owner_entered', actor: h.actor?.startsWith('staff:') ? 'staff' : h.actor || 'unknown' } }]);
      }
    }
  }
  // conversations: a customer message after 24 h of silence starts one; the first reply after it gives the delay
  const msgs = d.prepare("SELECT id, wa_id, direction, body, created_at FROM messages WHERE tenant_id = ? AND created_at >= ? ORDER BY wa_id, id").all(tid, since);
  let open = null, lastIn = null, curWa = null;
  for (const m of msgs) {
    if (m.wa_id !== curWa) { curWa = m.wa_id; open = null; lastIn = null; }
    if (isTest(m.wa_id)) continue;
    const b = json(m.body, {});
    if (b.simulated) continue;
    const t = Date.parse(iso(m.created_at));
    if (m.direction === 'in') {
      if (!lastIn || t - lastIn > GAP_HOURS * 3600000) {
        open = { id: m.id, at: m.created_at, t, responded: false };
        const source = sourceOf({ customerSource: custSrc.get(m.wa_id), channel: channelOf(m.wa_id) });
        events.push([m.created_at, `conv_${m.id}.started`, 'conversation.started', m.created_at, { subject: { type: 'conversation', id: `conv_${m.id}` }, waId: m.wa_id, source, data: {} }]);
      }
      lastIn = t;
    } else if (open && !open.responded && m.direction === 'out') {
      open.responded = true;
      events.push([m.created_at, `conv_${open.id}.first_response`, 'conversation.first_response', m.created_at, { subject: { type: 'conversation', id: `conv_${open.id}` }, waId: m.wa_id, data: { responder: b.staff ? 'staff' : 'assistant', seconds: Math.max(0, Math.round((t - open.t) / 1000)) } }]);
    }
  }
  // bookings
  for (const b of d.prepare('SELECT * FROM bookings WHERE tenant_id = ? AND created_at >= ?').all(tid, since)) {
    if (isTest(b.wa_id)) continue;
    const subject = { type: 'booking', id: `booking_${b.id}` };
    const base = { service: b.service || null, starts_at: iso(b.starts_at), with_deposit: Number(b.deposit) > 0 };
    events.push([b.created_at, `booking_${b.id}.requested`, 'booking.requested', b.created_at, { subject, waId: b.wa_id, source: sourceOf({ customerSource: custSrc.get(b.wa_id), channel: channelOf(b.wa_id) }), data: base }]);
    const confirmedAt = b.confirmed_at || (['confirmed', 'completed'].includes(b.status) ? b.updated_at || b.created_at : null);
    if (confirmedAt) events.push([confirmedAt, `booking_${b.id}.confirmed`, 'booking.confirmed', confirmedAt, { subject, waId: b.wa_id, data: { ...base, ...(b.deposit_paid ? { value: r2(b.deposit), currency: money(tenant), provenance: 'deposit_paid' } : {}) } }]);
    if (b.status === 'completed' && (b.completed_at || b.updated_at)) events.push([b.completed_at || b.updated_at, `booking_${b.id}.completed`, 'booking.completed', b.completed_at || b.updated_at, { subject, waId: b.wa_id, data: base }]);
    if (['cancelled', 'no_show'].includes(b.status) && (b.cancelled_at || b.updated_at)) events.push([b.cancelled_at || b.updated_at, `booking_${b.id}.cancelled`, 'booking.cancelled', b.cancelled_at || b.updated_at, { subject, waId: b.wa_id, data: { ...base, no_show: b.status === 'no_show' } }]);
  }
  // quotes
  for (const q of d.prepare('SELECT * FROM quotes WHERE tenant_id = ? AND created_at >= ?').all(tid, since)) {
    if (isTest(q.wa_id)) continue;
    const subject = { type: 'quote', id: `quote_${q.id}` };
    events.push([q.created_at, `quote_${q.id}.requested`, 'quote.requested', q.created_at, { subject, waId: q.wa_id, source: sourceOf({ customerSource: custSrc.get(q.wa_id), channel: channelOf(q.wa_id) }), data: { with_photos: (json(q.photos, []) || []).length > 0 } }]);
    if (q.sent_at) events.push([q.sent_at, `quote_${q.id}.sent`, 'quote.sent', q.sent_at, { subject, waId: q.wa_id, data: { value: r2(q.total), currency: cur, provenance: 'quoted' } }]);
    if (q.accepted_at) events.push([q.accepted_at, `quote_${q.id}.accepted`, 'quote.accepted', q.accepted_at, { subject, waId: q.wa_id, data: { value: r2(q.total), currency: cur, provenance: 'customer_accepted' } }]);
  }
  // orders
  for (const o of d.prepare('SELECT * FROM orders WHERE tenant_id = ? AND created_at >= ?').all(tid, since)) {
    if (isTest(o.wa_id)) continue;
    const subject = { type: 'order', id: `order_${o.id}` };
    const c = o.currency || cur;
    events.push([o.created_at, `order_${o.id}.created`, 'order.created', o.created_at, { subject, waId: o.wa_id, source: sourceOf({ customerSource: custSrc.get(o.wa_id), channel: channelOf(o.wa_id) }), data: { value: r2(o.subtotal), currency: c, provenance: 'order_total', fulfilment: o.fulfilment || null, payment_method: o.payment_method || null, recovered_cart: !!o.recovered, external_store: !!o.store_order_id } }]);
    if (o.payment_status === 'paid' && o.status !== 'cancelled') events.push([o.paid_at || o.updated_at, `order_${o.id}.paid`, 'order.paid', o.paid_at || o.updated_at, { subject, waId: o.wa_id, data: { value: r2(o.subtotal), currency: c, provenance: 'payment_recorded', method: o.stripe_session_id ? 'card' : o.payment_method || null } }]);
    if (o.payment_status !== 'paid' && o.status === 'completed' && o.payment_method === 'cod') events.push([o.updated_at, `order_${o.id}.completed`, 'order.completed', o.updated_at, { subject, waId: o.wa_id, data: { value: r2(o.subtotal), currency: c, provenance: 'cash_completed' } }]);
  }
  // oldest first, so seq follows time for anything first seen together (e.g. the first back-fill)
  events.sort((a, b) => (iso(a[0]) < iso(b[0]) ? -1 : iso(a[0]) > iso(b[0]) ? 1 : 0));
  d.exec('BEGIN');
  try { for (const [, id, type, at, x] of events) emit(id, type, at, x); d.exec('COMMIT'); } catch (e) { d.exec('ROLLBACK'); throw e; }
  return added;
}

/** Events after a cursor (seq), oldest first. */
export function readEvents(tenantId, { after = 0, limit = 200, types = null } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  const t = (types || []).filter((x) => EVENT_TYPES[x]);
  const rows = getDb().prepare(`SELECT seq, payload, recorded_at FROM outcome_events WHERE tenant_id = ? AND seq > ? ${t.length ? `AND type IN (${t.map(() => '?').join(',')})` : ''} ORDER BY seq LIMIT ?`).all(tenantId, Number(after) || 0, ...t, lim + 1);
  const more = rows.length > lim;
  const events = rows.slice(0, lim).map((r) => ({ seq: r.seq, ...JSON.parse(r.payload), recorded_at: r.recorded_at }));
  return { events, next_after: events.length ? events.at(-1).seq : Number(after) || 0, has_more: more };
}

const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); };

/** Counts and values for a date range (UTC dates, inclusive), computed from the event log. */
export function summary(tenant, { from, to } = {}) {
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? from : new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? to : new Date().toISOString().slice(0, 10);
  if (f > t) throw Object.assign(new Error('"from" is after "to"'), { status: 400, code: 'invalid_parameter' });
  if ((Date.parse(t) - Date.parse(f)) / 864e5 > 366) throw Object.assign(new Error('The range can be at most 366 days'), { status: 400, code: 'invalid_parameter' });
  const rows = getDb().prepare("SELECT payload FROM outcome_events WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at < ?").all(tenant.id, `${f}T00:00:00.000Z`, new Date(Date.parse(`${t}T00:00:00Z`) + 864e5).toISOString()).map((r) => JSON.parse(r.payload));
  const of = (type) => rows.filter((e) => e.type === type);
  const sum = (es) => r2(es.reduce((s, e) => s + Number(e.data?.value || 0), 0));
  const enquiries = of('enquiry.created');
  const bySource = {};
  for (const e of enquiries) bySource[e.source?.type || 'unknown'] = (bySource[e.source?.type || 'unknown'] || 0) + 1;
  const byChannel = (es) => ({ website: es.filter((e) => e.channel === 'website').length, whatsapp: es.filter((e) => e.channel === 'whatsapp').length });
  const firsts = of('conversation.first_response');
  const statusTo = (s) => of('lead.status_changed').filter((e) => e.data.to === s);
  const leadIds = (es) => new Set(es.map((e) => e.subject.id));
  const won = statusTo('won');
  const contactDelays = [];
  // lead response time: enquiry → first move out of NEW (any time up to now, so a lead from the range still counts)
  for (const e of enquiries) {
    const first = getDb().prepare("SELECT occurred_at FROM outcome_events WHERE tenant_id = ? AND type = 'lead.status_changed' AND json_extract(payload, '$.subject.id') = ? ORDER BY occurred_at LIMIT 1").get(tenant.id, e.subject.id);
    if (first) contactDelays.push(Math.round((Date.parse(first.occurred_at) - Date.parse(e.occurred_at)) / 60000));
  }
  return {
    version: SCHEMA_VERSION, from: f, to: t, currency: money(tenant),
    enquiries: { total: enquiries.length, by_channel: byChannel(enquiries), by_source: bySource, urgent: enquiries.filter((e) => e.data.urgent).length },
    conversations: { started: of('conversation.started').length, by_channel: byChannel(of('conversation.started')) },
    response_times: {
      first_reply_seconds_median: median(firsts.map((e) => e.data.seconds)),
      assistant_replies: firsts.filter((e) => e.data.responder === 'assistant').length,
      staff_first_replies: firsts.filter((e) => e.data.responder === 'staff').length,
      lead_to_first_contact_minutes_median: median(contactDelays),
      leads_with_contact: contactDelays.length,
    },
    leads: { qualified: leadIds(statusTo('qualified')).size, won: leadIds(won).size, lost: leadIds(statusTo('lost')).size, won_value_owner_entered: sum(won.filter((e) => e.data.provenance === 'owner_entered')) },
    bookings: { requested: of('booking.requested').length, confirmed: of('booking.confirmed').length, completed: of('booking.completed').length, cancelled: of('booking.cancelled').length, deposits_paid_value: sum(of('booking.confirmed').filter((e) => e.data.provenance === 'deposit_paid')) },
    quotes: { requested: of('quote.requested').length, sent: of('quote.sent').length, sent_value: sum(of('quote.sent')), accepted: of('quote.accepted').length, accepted_value: sum(of('quote.accepted')) },
    orders: { created: of('order.created').length, created_value: sum(of('order.created')), paid: of('order.paid').length, paid_value: sum(of('order.paid')), cash_completed: of('order.completed').length, cash_completed_value: sum(of('order.completed')) },
    verified_value: r2(sum(of('order.paid')) + sum(of('order.completed')) + sum(of('quote.accepted')) + sum(of('booking.confirmed').filter((e) => e.data.provenance === 'deposit_paid'))),
    notes: 'verified_value = paid orders + completed cash orders + accepted quotes + paid deposits. Owner-entered values are reported separately (leads.won_value_owner_entered) and are not verified. Accepted quotes are agreed but may not be paid yet.',
  };
}

// ---------- reporting keys: read-only, one business, created by its owner (or the platform operator), revocable ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function createReportingKey(tenantId, { label = 'Demo Engine', by = 'owner' } = {}) {
  const key = 'rpt_' + crypto.randomBytes(24).toString('base64url');
  const id = Number(getDb().prepare('INSERT INTO reporting_keys (tenant_id, key_hash, label, created_by) VALUES (?, ?, ?, ?)').run(tenantId, sha(key), String(label).slice(0, 60), String(by).slice(0, 60)).lastInsertRowid);
  return { id, key };
}
export const listReportingKeys = (tenantId) => getDb().prepare('SELECT id, label, created_by, created_at, revoked_at, last_used_at FROM reporting_keys WHERE tenant_id = ? ORDER BY id DESC').all(tenantId);
export const revokeReportingKey = (tenantId, id) => Number(getDb().prepare("UPDATE reporting_keys SET revoked_at = datetime('now') WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL").run(tenantId, Number(id)).changes);
function keyLookup(raw) {
  if (!/^rpt_[\w-]{20,}$/.test(String(raw || ''))) return null;
  return getDb().prepare('SELECT * FROM reporting_keys WHERE key_hash = ?').get(sha(raw)) || null;
}

// ---------- the API: /api/v1/outcomes ----------
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
export function outcomesRouter() {
  const r = express.Router();
  const hits = new Map(); // per key: 120 requests a minute
  r.use((req, res, next) => {
    res.set('X-Outcomes-Version', String(SCHEMA_VERSION)).set('Cache-Control', 'no-store');
    const raw = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const k = keyLookup(raw);
    if (!k) return fail(res, 401, 'unauthorized', 'A reporting key (Authorization: Bearer rpt_…) is required. Admin and super-admin keys are not accepted here.');
    if (k.revoked_at) return fail(res, 401, 'key_revoked', 'This reporting key was revoked by the business.');
    const tenant = getTenant(k.tenant_id);
    if (!tenant || !tenant.active) return fail(res, 403, 'tenant_inactive', 'This business is not active.');
    const now = Date.now();
    const h = (hits.get(k.id) || []).filter((x) => now - x < 60000);
    if (h.length >= 120) { res.set('Retry-After', '60'); return fail(res, 429, 'rate_limited', 'Too many requests: at most 120 a minute per key.'); }
    h.push(now); hits.set(k.id, h);
    const today = new Date().toISOString().slice(0, 10);
    if (!k.last_used_at || !String(k.last_used_at).startsWith(today)) audit({ tenantId: tenant.id, actor: `reporting-key:${k.id}`, role: 'reporting', action: 'outcomes.read', ip: req.ip });
    getDb().prepare("UPDATE reporting_keys SET last_used_at = datetime('now') WHERE id = ?").run(k.id);
    req.tenant = tenant; req.reportingKey = k;
    next();
  });
  r.get('/schema', (req, res) => res.json({ version: SCHEMA_VERSION, tenant: req.tenant.id, event_types: EVENT_TYPES, lead_statuses: ['new', 'contacted', 'qualified', 'won', 'lost'], provenance: ['payment_recorded', 'cash_completed', 'customer_accepted', 'deposit_paid', 'quoted', 'order_total', 'owner_entered'] }));
  r.get('/events', (req, res) => {
    const after = req.query.after === undefined ? 0 : Number(req.query.after);
    if (!Number.isInteger(after) || after < 0) return fail(res, 400, 'invalid_parameter', '"after" must be a whole number (the last seq you received, or 0).');
    if (req.query.limit !== undefined && !(Number.isInteger(Number(req.query.limit)) && Number(req.query.limit) >= 1 && Number(req.query.limit) <= 500)) return fail(res, 400, 'invalid_parameter', '"limit" must be 1–500.');
    const types = req.query.types ? String(req.query.types).split(',').map((x) => x.trim()).filter(Boolean) : null;
    const bad = (types || []).filter((x) => !EVENT_TYPES[x]);
    if (bad.length) return fail(res, 400, 'invalid_parameter', `Unknown event type: ${bad.join(', ')}`);
    try {
      syncOutcomes(req.tenant);
      res.json({ version: SCHEMA_VERSION, tenant: req.tenant.id, ...readEvents(req.tenant.id, { after, limit: req.query.limit, types }) });
    } catch (e) { console.warn('[outcomes]', e.message); fail(res, 500, 'internal', 'Could not read events – try again.'); }
  });
  r.get('/summary', (req, res) => {
    try { syncOutcomes(req.tenant); res.json({ tenant: req.tenant.id, ...summary(req.tenant, { from: req.query.from, to: req.query.to }) }); } catch (e) { if (e.code === 'invalid_parameter') return fail(res, 400, e.code, e.message); console.warn('[outcomes]', e.message); fail(res, 500, 'internal', 'Could not build the summary – try again.'); }
  });
  r.use((req, res) => fail(res, 404, 'not_found', 'No such endpoint. See GET /api/v1/outcomes/schema.'));
  return r;
}
