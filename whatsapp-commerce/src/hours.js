/*
 * Team hours: when a person can reply in the chat (not the business's opening hours, though often the same).
 * settings.teamHours = { enabled, text: "Mon-Fri 09:00-17:30; Sat 10:00-14:00" } in the business's time zone.
 * Outside them the chat says the team is away and when it's back, and "talk to a person" takes their details instead
 * of promising a quick reply.
 */
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const day = (s) => DAYS.indexOf(String(s).toLowerCase().slice(0, 3));
const mins = (s) => { const m = String(s).match(/^(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?$/i); if (!m) return null; let h = Number(m[1]) % 24; const ap = (m[3] || '').toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; return h * 60 + Number(m[2] || 0); };

/** "Mon-Fri 09:00-17:30; Sat 10:00-14:00" → { 1: [[540, 1050]], …, 6: [[600, 840]] }. Unknown parts are ignored. */
export function parseHours(text) {
  const out = {};
  for (const part of String(text || '').split(/[;\n]+/)) {
    const m = part.trim().match(/^([a-z]{3,9})(?:\s*(?:-|–|to)\s*([a-z]{3,9}))?:?\s+(\d[\d:.]*\s*(?:am|pm)?)\s*(?:-|–|to)\s*(\d[\d:.]*\s*(?:am|pm)?)$/i);
    if (!m) continue;
    const a = day(m[1]), b = m[2] ? day(m[2]) : a, from = mins(m[3]), to = mins(m[4]);
    if (a < 0 || b < 0 || from == null || to == null || to <= from) continue;
    for (let i = a; ; i = (i + 1) % 7) { (out[i] ||= []).push([from, to]); if (i === b) break; }
  }
  return out;
}

function local(now, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { dow: day(p.weekday), m: Number(p.hour) * 60 + Number(p.minute) };
}
const hhmm = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`; };

/** { on, open, next } – on: hours are set; open: a person can reply now; next: "today at 2pm" / "Mon at 9am". */
export function teamStatus(S, now = new Date()) {
  const H = S?.teamHours;
  const days = H?.enabled ? parseHours(H.text) : {};
  if (!Object.keys(days).length) return { on: false, open: true, next: '' };
  const { dow, m } = local(now, S.business?.timezone || 'Europe/London');
  if ((days[dow] || []).some(([a, b]) => m >= a && m < b)) return { on: true, open: true, next: '' };
  for (let k = 0; k < 8; k++) {
    const d = (dow + k) % 7;
    const start = (days[d] || []).map(([a]) => a).filter((a) => k > 0 || a > m).sort((x, y) => x - y)[0];
    if (start != null) return { on: true, open: false, next: `${k === 0 ? 'today' : k === 1 ? 'tomorrow' : LABEL[d]} at ${hhmm(start)}` };
  }
  return { on: true, open: false, next: '' };
}
