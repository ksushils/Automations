import { getDb } from './db.js';
import { getTenant, listTenants } from './tenants.js';
import { createSender, notify } from './whatsapp/cloudApi.js';
import { emailShop } from './email.js';
import { createCheckoutSession } from './payments/stripe.js';
import { config } from './config.js';
import { createHmac } from 'node:crypto';

/*
 * Bookings in the chat: pick a service → day → time → confirm (optional Stripe deposit). The team confirms /
 * cancels / marks done on the Bookings tab. Reminders before the visit, a "book again" nudge after it.
 *
 * settings.bookings = { enabled, services: [{ name, minutes, price, deposit }], times: ["10:00","14:00"], days: 14,
 *   closedDays: [0], leadHours: 12, perSlot: 1, autoConfirm: false, reminderHours: 24, reminderTemplate,
 *   rebookDays: 0, rebookTemplate }
 */

export const bookingsEnabled = (S) => !!(S.bookings?.enabled && (S.bookings.times || []).length);
const tz = (S) => S.business?.timezone || 'Europe/London';
const sym = (S) => S.business?.currencySymbol || '£';
const money = (n, s) => `${s}${Number(n || 0).toFixed(Number(n) % 1 ? 2 : 0)}`;

function zonedParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
}

/** "2026-11-20" + "14:30" in the shop's time zone → UTC Date. */
export function zonedToUtc(ymd, hm, timeZone) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm || 0);
  const p = zonedParts(new Date(guess), timeZone);
  const asIf = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return new Date(guess - (asIf - guess));
}

const startTime = (t) => String(t).split('-')[0].trim();
const dayLabel = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const whenText = (b) => `${new Date(`${b.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} at ${b.time}`;

function taken(tenantId, day, time) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND day = ? AND time = ? AND status NOT IN ('cancelled', 'no_show')").get(tenantId, day, time).n;
}

/** Free times for one day (respecting notice period and capacity). */
export function freeTimes(tenant, day, now = new Date()) {
  const B = tenant.settings.bookings || {};
  const lead = (Number(B.leadHours) || 0) * 3600000;
  const cap = Math.max(1, Number(B.perSlot) || 1);
  return (B.times || []).map(startTime).filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .filter((t) => zonedToUtc(day, t, tz(tenant.settings)).getTime() >= now.getTime() + lead)
    .filter((t) => taken(tenant.id, day, t) < cap);
}

/** Days (max 10, for a WhatsApp list) that still have a free time. */
export function freeDays(tenant, now = new Date(), { max = 10 } = {}) {
  const B = tenant.settings.bookings || {};
  const closed = new Set((B.closedDays || []).map(Number));
  const p = zonedParts(now, tz(tenant.settings));
  const out = [];
  for (let i = 0; i < Math.min(Number(B.days) || 14, 60) && out.length < max; i++) {
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + i, 12));
    if (closed.has(d.getUTCDay())) continue;
    const ymd = d.toISOString().slice(0, 10);
    const n = freeTimes(tenant, ymd, now).length;
    if (n) out.push({ ymd, label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayLabel(ymd), free: n });
  }
  return out;
}

const services = (S) => (S.bookings?.services || []).filter((s) => s?.name).slice(0, 10);

/** The soonest free slots, optionally only on one day and/or part of the day. */
export function soonestSlots(tenant, { day = null, part = null, limit = 3, now = new Date() } = {}) {
  const inPart = (t) => { const h = Number(t.split(':')[0]); return !part || (part === 'morning' ? h < 12 : part === 'afternoon' ? h >= 12 && h < 17 : h >= 17); };
  const days = day ? [{ ymd: day }] : freeDays(tenant, now, { max: 30 });
  const out = [];
  for (const d of days) {
    for (const t of freeTimes(tenant, d.ymd, now).filter(inPart)) { out.push({ day: d.ymd, time: t }); if (out.length >= limit) return out; }
  }
  return out;
}
const slotLabel = (s, now = new Date()) => { const today = now.toISOString().slice(0, 10); const tom = new Date(now.getTime() + 864e5).toISOString().slice(0, 10); return `${s.day === today ? 'Today' : s.day === tom ? 'Tomorrow' : dayLabel(s.day)} ${s.time}`.slice(0, 20); };

/**
 * "next Tuesday afternoon", "tomorrow at 2", "20 Nov", "this weekend" → { day, part, time }. Only what's said.
 * Days are in the shop's time zone; a weekday means the next one coming (today if it's today).
 */
const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseWhen(text, { timeZone = 'Europe/London', now = new Date() } = {}) {
  const t = ` ${String(text || '').toLowerCase().replace(/[,.!?]/g, ' ')} `;
  const p = zonedParts(now, timeZone);
  const base = Date.UTC(p.y, p.m - 1, p.d, 12);
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  let day = null;
  if (/\btoday\b|\btonight\b/.test(t)) day = ymd(base);
  else if (/\btomorrow\b|\btmrw\b/.test(t)) day = ymd(base + 864e5);
  else if (/\b(this )?weekend\b/.test(t)) { const dow = new Date(base).getUTCDay(); day = ymd(base + ((6 - dow + 7) % 7) * 864e5); }
  else {
    const w = WD.findIndex((d) => new RegExp(`\\b${d.slice(0, 3)}(${d.slice(3)})?\\b`).test(t));
    if (w >= 0) { const dow = new Date(base).getUTCDay(); let add = (w - dow + 7) % 7; if (/\bnext\b/.test(t) && add === 0) add = 7; day = ymd(base + add * 864e5); }
    const m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?(?: of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/) || t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)?\b/);
    if (m) {
      const [dd, mm] = /\d/.test(m[1]) ? [Number(m[1]), MON.indexOf(m[2])] : [Number(m[2]), MON.indexOf(m[1])];
      let y = p.y; if (Date.UTC(y, mm, dd, 12) < base) y++;
      if (dd >= 1 && dd <= 31) day = ymd(Date.UTC(y, mm, dd, 12));
    }
    const slash = t.match(/\b(\d{1,2})\/(\d{1,2})\b/); // 20/11 (UK order)
    if (!day && slash) { let y = p.y; const ms = Date.UTC(y, Number(slash[2]) - 1, Number(slash[1]), 12); day = ymd(ms < base ? Date.UTC(y + 1, Number(slash[2]) - 1, Number(slash[1]), 12) : ms); }
  }
  const part = /\bmorning\b|\bam\b/.test(t) ? 'morning' : /\bafternoon\b|\blunch(time)?\b/.test(t) ? 'afternoon' : /\bevening\b|\btonight\b|\bafter work\b/.test(t) ? 'evening' : null;
  let time = null;
  const tm = t.match(/\b(?:at|@|around|about)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/) || t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) || t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (tm) { let h = Number(tm[1]); const mi = tm[2] ? Number(tm[2]) : 0; if (tm[3] === 'pm' && h < 12) h += 12; if (tm[3] === 'am' && h === 12) h = 0; if (!tm[3] && h >= 1 && h <= 7) h += 12; if (h <= 23 && mi <= 59) time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`; }
  return day || part || time ? { day, part, time } : null;
}

/** Times on offer for what they asked: that time, else that part of the day, else that day, else the nearest days. */
function slotsFor(ctx, when) {
  const T = ctx.tenant;
  if (when.day && when.time && freeTimes(T, when.day).includes(when.time)) return { exact: { day: when.day, time: when.time } };
  let slots = soonestSlots(T, { day: when.day, part: when.part, limit: 3 });
  let note = '';
  if (!slots.length && when.day) { slots = soonestSlots(T, { part: when.part, limit: 3 }).filter((s) => s.day > when.day).concat(soonestSlots(T, { part: when.part, limit: 3 })).slice(0, 3); note = `Sorry, ${dayLabel(when.day)}${when.part ? ` ${when.part}` : ''} is full. The nearest free times:`; }
  if (!slots.length) { slots = soonestSlots(T, { limit: 3 }); note = slots.length ? 'The nearest free times:' : ''; }
  return { slots, note };
}

/** A typed day/time ("Friday afternoon") while booking, or "book … next Tuesday". Returns false if no date in it. */
export function bookingFromText(ctx, text) {
  const when = parseWhen(text, { timeZone: tz(ctx.S) });
  if (!when) return false;
  const draft = (ctx.conv.data.booking ||= {});
  if (draft.service === undefined) { const list = services(ctx.S); const hit = list.findIndex((s) => new RegExp(`\\b${s.name.split(/\s+/)[0].replace(/[^\w]/g, '')}`, 'i').test(text)); draft.service = (list[hit] || (list.length === 1 ? list[0] : null))?.name || null; draft.deposit = Number((list[hit] || (list.length === 1 ? list[0] : {}))?.deposit) || 0; }
  const { exact, slots, note } = slotsFor(ctx, when);
  if (exact) return bookingAction(ctx, 'bslot', `${exact.day}T${exact.time}`);
  if (!slots.length) return ctx.reply({ type: 'buttons', text: "😔 Sorry, we're fully booked for now. Our team can help find another time.", buttons: [{ id: 'human', title: '🙋 Talk to a person' }, { id: 'menu', title: '📋 Menu' }] });
  return ctx.reply({ type: 'buttons', text: `🕒 ${note || 'These times are free:'}`, buttons: [...slots.slice(0, 2).map((s) => ({ id: `bslot:${s.day}T${s.time}`, title: slotLabel(s) })), { id: 'bdays', title: '📅 Other day' }] });
}

/** Website calendar data (a month grid in the chat widget); WhatsApp shows the same days as a list. */
function dayPicker(ctx, text) {
  const all = freeDays(ctx.tenant, new Date(), { max: 42 });
  return { type: 'list', text, button: 'Choose a day', sections: [{ title: 'Available days', rows: all.slice(0, 10).map((d) => ({ id: `bday:${d.ymd}`, title: d.label, description: `${d.free} time${d.free > 1 ? 's' : ''} free` })) }], calendar: { days: all.map((d) => ({ ymd: d.ymd, free: d.free })), idPrefix: 'bday:' } };
}

// ---------- add to calendar ----------
const icsToken = (tenantId, id) => createHmac('sha256', String(process.env.ENCRYPTION_KEY || 'wc')).update(`ics:${tenantId}:${id}`).digest('base64url').slice(0, 22);
export const verifyIcsToken = (tenantId, id, tok) => tok === icsToken(tenantId, id);
const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '').replace(/ /, 'T') + (iso.endsWith('Z') ? '' : 'Z');
function eventTimes(tenant, b) {
  const svc = services(tenant.settings).find((s) => s.name === b.service);
  const start = zonedToUtc(b.day, b.time, tz(tenant.settings));
  const end = new Date(start.getTime() + (Number(svc?.minutes) || 60) * 60000);
  return { start: stamp(start.toISOString()), end: stamp(end.toISOString()) };
}
export function calendarLinks(tenant, b) {
  const { start, end } = eventTimes(tenant, b);
  const name = tenant.settings.business?.name || tenant.name;
  const title = `${b.service || 'Booking'} – ${name}`;
  const where = tenant.settings.business?.address || tenant.settings.ordering?.pickupAddress || '';
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${start}/${end}&ctz=${encodeURIComponent(tz(tenant.settings))}${where ? `&location=${encodeURIComponent(where)}` : ''}`;
  return { google, ics: `${config.publicUrl}/b/${encodeURIComponent(tenant.id)}/${b.id}/${icsToken(tenant.id, b.id)}.ics` };
}
export function icsFile(tenant, b) {
  const { start, end } = eventTimes(tenant, b);
  const esc = (s) => String(s || '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
  const name = tenant.settings.business?.name || tenant.name;
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WhatsApp Commerce//Bookings//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:booking-${b.id}-${tenant.id}@${new URL(config.publicUrl).host}`, `DTSTAMP:${stamp(new Date().toISOString())}`, `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${esc(`${b.service || 'Booking'} – ${name}`)}`, tenant.settings.business?.address ? `LOCATION:${esc(tenant.settings.business.address)}` : '', `DESCRIPTION:${esc(`Booked in the ${name} chat. Booking #${b.id}.`)}`, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
}
const addToCalendar = (ctx, id) => { const b = getBooking(ctx.tenant.id, id); if (!b) return; const l = calendarLinks(ctx.tenant, b); ctx.reply({ type: 'cta', text: `📆 Add it to your calendar so you don't forget.\nApple / Outlook: ${l.ics}`, buttonText: 'Google Calendar', url: l.google }); };

/** "my booking": upcoming bookings with Change / Cancel. */
export function myBookings(ctx) {
  const rows = getDb().prepare("SELECT * FROM bookings WHERE tenant_id = ? AND wa_id = ? AND starts_at >= datetime('now') AND status NOT IN ('cancelled', 'no_show', 'completed') ORDER BY starts_at LIMIT 3").all(ctx.tenant.id, ctx.conv.waId);
  if (!rows.length) return ctx.reply({ type: 'buttons', text: "I can't see an upcoming booking for you here. Would you like to make one?", buttons: [{ id: 'bstart', title: '📅 Book now' }, { id: 'human', title: '🙋 Talk to a person' }] });
  for (const b of rows) ctx.reply({ type: 'buttons', text: `📅 *${whenText(b)}*${b.service ? ` – ${b.service}` : ''}\nStatus: ${({ requested: 'waiting for the team to confirm', awaiting_deposit: 'waiting for the deposit', confirmed: 'confirmed ✅' })[b.status] || b.status}`, buttons: [{ id: `bresch:${b.id}`, title: '🔁 Change time' }, { id: `bcxl:${b.id}`, title: '❌ Cancel it' }, { id: `bcal:${b.id}`, title: '📆 Add to calendar' }] });
  return true;
}

// ---------- chat ----------

/** Handle a booking button. Returns true when handled. */
export async function bookingAction(ctx, cmd, arg) {
  const S = ctx.S;
  const draft = (ctx.conv.data.booking ||= {});
  if (cmd === 'bstart') {
    ctx.conv.data.booking = {};
    const list = services(S);
    if (list.length > 1) {
      const web = S.bookings?.websiteNote || (S.business?.bookingUrl ? `Booking something else? You can also book online: ${S.business.bookingUrl}` : '');
      return ctx.reply({ type: 'list', text: `📅 What would you like to book?${web ? `\n\n${web}` : ''}`, button: 'Choose', sections: [{ title: 'Services', rows: list.map((s, i) => ({ id: `bsvc:${i}`, title: s.name.slice(0, 24), description: [s.minutes ? `${s.minutes} min` : '', s.price ? money(s.price, sym(S)) : '', s.deposit ? `${money(s.deposit, sym(S))} deposit` : ''].filter(Boolean).join(' · ').slice(0, 72) || undefined })) }] });
    }
    return bookingAction(ctx, 'bsvc', list.length ? '0' : '');
  }
  if (cmd === 'bsvc') {
    const svc = services(S)[Number(arg)];
    ctx.conv.data.booking = { service: svc?.name || null, deposit: Number(svc?.deposit) || 0 };
    if (draft.rescheduleOf) ctx.conv.data.booking.rescheduleOf = draft.rescheduleOf;
    const soon = soonestSlots(ctx.tenant, { limit: 2 });
    if (!soon.length) return ctx.reply({ type: 'buttons', text: "😔 Sorry, we're fully booked for now. Our team can help find another time.", buttons: [{ id: 'human', title: '🙋 Talk to a person' }, { id: 'menu', title: '📋 Menu' }] });
    // the soonest times first (fewest taps), any other day on the calendar – or they can just type "Friday afternoon"
    return ctx.reply({ type: 'buttons', text: `📅 ${svc ? `*${svc.name}* – t` : 'T'}he next free times are below. Or type a day, e.g. _Friday afternoon_.`, buttons: [...soon.map((s) => ({ id: `bslot:${s.day}T${s.time}`, title: slotLabel(s) })), { id: 'bdays', title: '📅 Other day' }] });
  }
  if (cmd === 'bdays') return ctx.reply(dayPicker(ctx, '📅 Which day suits you?'));
  if (cmd === 'bslot') {
    const [day, time] = String(arg).split('T');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !freeTimes(ctx.tenant, day).includes(time)) return ctx.reply({ type: 'buttons', text: 'Sorry, that time has just gone. Here are the next ones:', buttons: [...soonestSlots(ctx.tenant, { limit: 2 }).map((s) => ({ id: `bslot:${s.day}T${s.time}`, title: slotLabel(s) })), { id: 'bdays', title: '📅 Other day' }] });
    draft.day = day;
    return bookingAction(ctx, 'btime', time);
  }
  if (cmd === 'bmine') return myBookings(ctx);
  if (cmd === 'bcal') return addToCalendar(ctx, Number(arg)) || true;
  if (cmd === 'bresch') {
    const old = getBooking(ctx.tenant.id, Number(arg));
    if (!old || old.wa_id !== ctx.conv.waId) return myBookings(ctx);
    const i = services(S).findIndex((s) => s.name === old.service);
    ctx.conv.data.booking = { rescheduleOf: old.id };
    return bookingAction(ctx, 'bsvc', String(i >= 0 ? i : services(S).length ? 0 : ''));
  }
  if (cmd === 'bday') {
    const times = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? freeTimes(ctx.tenant, arg) : [];
    if (!times.length) return ctx.reply(dayPicker(ctx, 'Sorry, that day has just filled up. Which other day suits you?'));
    draft.day = arg;
    return ctx.reply({ type: 'list', text: `🕒 ${dayLabel(arg)} – what time?`, button: 'Choose a time', sections: [{ title: 'Free times', rows: times.slice(0, 10).map((t) => ({ id: `btime:${t}`, title: t })) }] });
  }
  if (cmd === 'btime') {
    if (!draft.day || !freeTimes(ctx.tenant, draft.day).includes(arg)) return ctx.reply({ type: 'buttons', text: 'Sorry, that time has just gone. Please pick another.', buttons: [{ id: 'bstart', title: '📅 Pick again' }] });
    draft.time = arg;
    if (!ctx.customer.name || String(ctx.conv.waId).startsWith('web:')) {
      ctx.conv.state = 'booking_name';
      return ctx.reply({ type: 'text', text: `👤 Who is the booking for? Please send the name${String(ctx.conv.waId).startsWith('web:') ? ' and a phone number' : ''}${S.bookings?.askNotes ? ` (and ${S.bookings.askNotes})` : ''}.` });
    }
    return bookingSummary(ctx);
  }
  if (cmd === 'bconfirm') return confirmDraft(ctx);
  if (cmd === 'bcxl') return customerCancel(ctx, Number(arg));
  return false;
}

/** Free-text answer while we're waiting for the booking name. */
export function bookingText(ctx, text) {
  if (ctx.conv.state !== 'booking_name' || !ctx.conv.data.booking?.time) return false;
  ctx.conv.data.booking.name = String(text).trim().slice(0, 200);
  ctx.conv.state = 'idle';
  return bookingSummary(ctx) || true;
}

function bookingSummary(ctx) {
  const b = ctx.conv.data.booking;
  const S = ctx.S;
  const lines = [`📋 *Your booking*`, b.service ? `• ${b.service}` : '', `• ${whenText(b)}`, `• Name: ${b.name || ctx.customer.name}`, b.deposit ? `• Deposit: ${money(b.deposit, sym(S))} (paid now by card, taken off the price)` : ''].filter(Boolean);
  ctx.reply({ type: 'buttons', text: `${lines.join('\n')}\n\nShall I book it?`, buttons: [{ id: 'bconfirm', title: b.deposit ? '✅ Book & pay' : '✅ Book it' }, { id: 'bstart', title: '🔁 Change' }, { id: 'menu', title: '❌ Cancel' }] });
  return true;
}

async function confirmDraft(ctx) {
  const b = ctx.conv.data.booking || {};
  const S = ctx.S;
  if (!b.day || !b.time || !freeTimes(ctx.tenant, b.day).includes(b.time)) {
    return ctx.reply({ type: 'buttons', text: 'Sorry, that time has just been taken. Please pick another.', buttons: [{ id: 'bstart', title: '📅 Pick again' }] });
  }
  const stripeKey = S.payments?.stripe?.secretKey;
  const deposit = b.deposit && stripeKey ? b.deposit : 0;
  const status = deposit ? 'awaiting_deposit' : S.bookings?.autoConfirm ? 'confirmed' : 'requested';
  const startsAt = zonedToUtc(b.day, b.time, tz(S)).toISOString().replace('T', ' ').slice(0, 19);
  const id = Number(getDb().prepare('INSERT INTO bookings (tenant_id, wa_id, name, service, day, time, starts_at, status, deposit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ctx.tenant.id, ctx.conv.waId, b.name || ctx.customer.name || null, b.service, b.day, b.time, startsAt, status, deposit).lastInsertRowid);
  delete ctx.conv.data.booking;
  const booking = getBooking(ctx.tenant.id, id);
  if (b.rescheduleOf) {
    const old = getBooking(ctx.tenant.id, b.rescheduleOf);
    if (old && old.wa_id === ctx.conv.waId && !['cancelled', 'completed', 'no_show'].includes(old.status)) {
      getDb().prepare("UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(old.id);
      if (old.deposit_paid) getDb().prepare('UPDATE bookings SET deposit_paid = 1, status = ? WHERE id = ?').run(S.bookings?.autoConfirm ? 'confirmed' : 'requested', id); // the deposit moves with the booking
      alertTeam(ctx.tenant, old, `MOVED by the customer to ${whenText(b)}`);
    }
  }
  if (deposit) {
    try {
      const s = await createCheckoutSession({ secretKey: stripeKey, amount: deposit, currency: S.business.currency || 'GBP', orderRef: `B${id}`, description: `Deposit – ${b.service || 'booking'} ${whenText(b)}`, successUrl: `${config.publicUrl}/paid`, metadata: { booking_id: String(id), tenant_id: ctx.tenant.id } });
      getDb().prepare('UPDATE bookings SET checkout_url = ?, stripe_session_id = ? WHERE id = ?').run(s.url, s.id, id);
      ctx.reply({ type: 'cta', text: `📅 Nearly done! We're holding *${whenText(b)}* for you.\nPay the ${money(deposit, sym(S))} deposit to confirm your booking.`, buttonText: 'Pay deposit', url: s.url });
    } catch (e) {
      console.warn('[booking deposit]', e.message);
      getDb().prepare("UPDATE bookings SET status = 'requested' WHERE id = ?").run(id);
      ctx.reply({ type: 'text', text: `📅 Thanks! We've received your booking request for *${whenText(b)}*. Our team will confirm it here shortly.` });
    }
  } else if (status === 'confirmed') {
    ctx.reply({ type: 'text', text: `✅ You're booked: *${whenText(b)}*${b.service ? ` – ${b.service}` : ''}.${Number(S.bookings?.reminderHours ?? 24) ? " We'll send you a reminder before." : ''} See you then!\n\nNeed to change it? Type *my booking*.` });
    addToCalendar(ctx, id);
  } else {
    const web = String(ctx.conv.waId).startsWith('web:');
    ctx.reply({ type: 'text', text: `📅 Thanks! We've received your booking request for *${whenText(b)}*${b.service ? ` – ${b.service}` : ''}. ${web ? 'Our team will contact you on the number you gave to confirm it.' : 'Our team will confirm it here shortly.'}\n\nNeed to change it? Type *my booking*.` });
    addToCalendar(ctx, id);
  }
  alertTeam(ctx.tenant, booking, deposit ? 'awaiting its deposit' : status === 'confirmed' ? 'confirmed automatically' : 'waiting for you to confirm');
  return true;
}

async function customerCancel(ctx, id) {
  const b = getBooking(ctx.tenant.id, id);
  if (!b || b.wa_id !== ctx.conv.waId || ['cancelled', 'completed', 'no_show'].includes(b.status)) return ctx.reply({ type: 'text', text: "I couldn't find that booking – it may already be cancelled. Type *human* to ask our team." });
  getDb().prepare("UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(id);
  ctx.reply({ type: 'buttons', text: `Your booking for *${whenText(b)}* is cancelled.${b.deposit_paid ? ' Our team will be in touch about your deposit.' : ''}`, buttons: [{ id: 'bstart', title: '📅 Book another time' }, { id: 'menu', title: '📋 Menu' }] });
  alertTeam(ctx.tenant, b, 'CANCELLED by the customer');
  return true;
}

function alertTeam(tenant, b, what) {
  const text = `📅 Booking ${what}\n${b.service ? `${b.service}\n` : ''}${whenText(b)}\n${b.name || ''} (+${String(b.wa_id).replace(/^web:.*/, 'website chat')})${b.deposit ? `\nDeposit: ${money(b.deposit, sym(tenant.settings))}` : ''}`;
  emailShop(tenant, `Booking ${what.toLowerCase()}: ${whenText(b)}`, text, { button: 'Open Bookings' }).catch(() => {});
  const send = createSender(tenant);
  const tpl = tenant.settings.notifications?.templates?.staffAlert;
  for (const s of tenant.settings.notifications?.staffWaIds || []) {
    notify(tenant, String(s).replace(/\D/g, ''), { type: 'text', text }, tpl ? { name: tpl, params: [text.replace(/\n/g, ' · ')] } : null, send).catch(() => {});
  }
}

// ---------- dashboard ----------

export function getBooking(tenantId, id) {
  return getDb().prepare('SELECT * FROM bookings WHERE tenant_id = ? AND id = ?').get(tenantId, Number(id));
}

export function listBookings(tenantId, { past = false, limit = 200 } = {}) {
  return getDb().prepare(`SELECT * FROM bookings WHERE tenant_id = ? AND starts_at ${past ? '<' : '>='} datetime('now', '-6 hours') ORDER BY starts_at ${past ? 'DESC' : 'ASC'} LIMIT ?`).all(tenantId, limit);
}

const STATUS_MSG = {
  confirmed: (b) => `✅ Your booking is confirmed: *${whenText(b)}*${b.service ? ` – ${b.service}` : ''}. See you then!`,
  cancelled: (b) => `😔 Sorry, we've had to cancel your booking for *${whenText(b)}*. Reply here and we'll find you another time.`,
};

/** Owner / staff changes a booking's status; the customer is told about confirmations and cancellations. */
export async function setBookingStatus(tenant, id, status) {
  if (!['requested', 'confirmed', 'cancelled', 'completed', 'no_show'].includes(status)) throw Object.assign(new Error('invalid status'), { status: 400 });
  const b = getBooking(tenant.id, id);
  if (!b) return null;
  getDb().prepare("UPDATE bookings SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, b.id);
  const after = getBooking(tenant.id, b.id);
  if (STATUS_MSG[status] && b.status !== status && !String(b.wa_id).startsWith('web:')) {
    const tpl = tenant.settings.notifications?.templates?.orderUpdate;
    await notify(tenant, b.wa_id, { type: 'text', text: STATUS_MSG[status](b) }, tpl ? { name: tpl, params: [(b.name || 'there').split(' ')[0], `booking ${whenText(b)}`, status] } : null).catch((e) => console.warn('[booking notify]', e.message));
  }
  return after;
}

/** Stripe paid the deposit → confirm. Returns true when the session belonged to a booking. */
export async function bookingDepositPaid(tenant, session) {
  const id = Number(session.metadata?.booking_id);
  if (!id) return false;
  const b = getBooking(tenant.id, id);
  if (!b || b.deposit_paid) return true;
  getDb().prepare("UPDATE bookings SET deposit_paid = 1, status = CASE WHEN status IN ('awaiting_deposit', 'requested') THEN 'confirmed' ELSE status END, updated_at = datetime('now') WHERE id = ?").run(id);
  await notify(tenant, b.wa_id, { type: 'text', text: `💳 Deposit received – thank you! ✅ You're booked: *${whenText(b)}*${b.service ? ` – ${b.service}` : ''}.` }, null).catch(() => {});
  alertTeam(tenant, getBooking(tenant.id, id), 'confirmed – deposit paid');
  return true;
}

// ---------- jobs ----------

/** Reminders N hours before; "book again" nudges N days after a completed visit; release unpaid holds after 2h. */
export async function runBookingJobs(now = Date.now()) {
  let sent = 0;
  const d = getDb();
  d.prepare("UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE status = 'awaiting_deposit' AND created_at < datetime('now', '-2 hours')").run();
  for (const t of listTenants()) {
    const B = t.settings.bookings;
    if (!t.active || !B?.enabled) continue;
    const send = createSender(t);
    const hours = Number(B.reminderHours ?? 24);
    if (hours > 0) {
      const due = d.prepare(`SELECT * FROM bookings WHERE tenant_id = ? AND status = 'confirmed' AND reminded_at IS NULL AND wa_id NOT LIKE 'web:%'
        AND starts_at > datetime('now') AND starts_at <= datetime('now', ?)`).all(t.id, `+${hours * 60} minutes`);
      for (const b of due) {
        d.prepare("UPDATE bookings SET reminded_at = datetime('now') WHERE id = ?").run(b.id);
        const first = (b.name || 'there').split(' ')[0];
        const r = await notify(t, b.wa_id, { type: 'buttons', text: `⏰ Reminder: ${first}, see you *${whenText(b)}*${b.service ? ` for ${b.service}` : ''} at ${t.settings.business?.name || t.name}.\n\nCan't make it? Let us know so someone else can have the slot.`, buttons: [{ id: 'menu', title: '👍 See you then' }, { id: `bcxl:${b.id}`, title: '❌ Cancel booking' }] },
          B.reminderTemplate ? { name: B.reminderTemplate, language: B.reminderLanguage, params: [first, whenText(b), t.settings.business?.name || t.name] } : null, send).catch((e) => { console.warn('[booking reminder]', e.message); return 'failed'; });
        if (r === 'sent' || r === 'template') sent++;
      }
    }
    const rebook = Number(B.rebookDays) || 0;
    if (rebook > 0 && B.rebookTemplate) {
      const rows = d.prepare(`SELECT * FROM bookings b WHERE tenant_id = ? AND status = 'completed' AND rebook_sent_at IS NULL AND wa_id NOT LIKE 'web:%'
        AND starts_at < datetime('now', ?) AND starts_at > datetime('now', ?)
        AND NOT EXISTS (SELECT 1 FROM bookings x WHERE x.tenant_id = b.tenant_id AND x.wa_id = b.wa_id AND x.starts_at > b.starts_at AND x.status != 'cancelled')`).all(t.id, `-${rebook} days`, `-${rebook + 14} days`);
      for (const b of rows) {
        d.prepare("UPDATE bookings SET rebook_sent_at = datetime('now') WHERE id = ?").run(b.id);
        await send(b.wa_id, { type: 'template', name: B.rebookTemplate, language: B.rebookLanguage || 'en_GB', components: [{ type: 'body', parameters: [{ type: 'text', text: (b.name || 'there').split(' ')[0] }] }] }).then(() => sent++, (e) => console.warn('[rebook]', e.message));
      }
    }
  }
  return sent;
}
