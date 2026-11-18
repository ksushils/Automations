import { createHmac } from 'node:crypto';
import { config } from './config.js';
import { getTenant, updateTenantSettings } from './tenants.js';
import { safeEqual } from './crypto.js';

/*
 * Google Calendar for bookings: no double bookings, and confirmed bookings land in the owner's calendar.
 *  - The owner connects once (OAuth, "Connect Google Calendar" on the Bookings tab). Narrow scopes only:
 *    calendar.freebusy (see busy times, not event details) and calendar.events.owned (add our own events).
 *  - Times shown in the chat leave out anything the calendar marks busy (checked live, cached ~2 minutes) and are
 *    checked again right before a booking is confirmed.
 *  - Confirmed bookings are written to the calendar ("Test day – Sam, via chat").
 * Needs a Google Cloud OAuth client (Setup: googleClientId / googleClientSecret, redirect URI below). Until Google
 * verifies the app, up to 100 users can connect and they see an "unverified app" warning.
 */
export const SCOPES = ['https://www.googleapis.com/auth/calendar.freebusy', 'https://www.googleapis.com/auth/calendar.events.owned'];
export const redirectUri = () => `${config.publicUrl}/oauth/google/callback`;
export const googleConfigured = () => !!(config.googleClientId && config.googleClientSecret);
export const calendarConnected = (t) => !!t?.settings?.bookings?.google?.refreshToken;

const sign = (s) => createHmac('sha256', String(process.env.ENCRYPTION_KEY || 'wc')).update(`gcal:${s}`).digest('base64url').slice(0, 32);
export function authUrl(tenantId, now = Date.now()) {
  const state = `${tenantId}.${now}`;
  const q = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: redirectUri(), response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', scope: SCOPES.join(' '), state: `${state}.${sign(state)}` });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}
/** state → tenantId if it's ours and under 30 minutes old. */
export function checkState(state, now = Date.now()) {
  const m = String(state || '').match(/^([\w-]+)\.(\d+)\.([\w-]+)$/);
  if (!m || !safeEqual(m[3], sign(`${m[1]}.${m[2]}`)) || now - Number(m[2]) > 30 * 60000) return null;
  return m[1];
}

async function tokenCall(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...body }), signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google: ${j.error_description || j.error || res.status}`);
  return j;
}

/** OAuth callback: keep the refresh token (encrypted with the shop's other secrets). */
export async function connectCalendar(tenantId, code) {
  const j = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!j.refresh_token) throw new Error('Google did not return a refresh token – please try connecting again');
  updateTenantSettings(tenantId, { bookings: { google: { refreshToken: j.refresh_token, calendarId: 'primary', connectedAt: new Date().toISOString(), lastError: null } } });
  tokens.delete(tenantId);
  busy.delete(tenantId);
  return true;
}
export function disconnectCalendar(tenantId) {
  updateTenantSettings(tenantId, { bookings: { google: { refreshToken: null, calendarId: null, connectedAt: null } } });
  tokens.delete(tenantId); busy.delete(tenantId);
}

const tokens = new Map(); // tenantId → { token, exp }
async function accessToken(t) {
  const c = tokens.get(t.id);
  if (c && c.exp > Date.now() + 60000) return c.token;
  const j = await tokenCall({ refresh_token: t.settings.bookings.google.refreshToken, grant_type: 'refresh_token' });
  tokens.set(t.id, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}
async function api(t, path, body) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${await accessToken(t)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Calendar: ${j.error?.message || res.status}`);
  return j;
}

// ---------- busy times (cached; the booking code reads them synchronously) ----------
const busy = new Map(); // tenantId → { at, from, to, list: [[startMs, endMs]] }
const DAY = 86400000;
/** Fetch busy times for the booking window if older than maxAgeMs. Never throws (no calendar = no filtering). */
export async function refreshBusy(tenant, { maxAgeMs = 120000, days = 60 } = {}) {
  if (!calendarConnected(tenant) || !googleConfigured()) return null;
  const c = busy.get(tenant.id);
  if (c && Date.now() - c.at < maxAgeMs) return c;
  const from = Date.now(), to = from + days * DAY;
  try {
    const calendarId = tenant.settings.bookings.google.calendarId || 'primary';
    const j = await api(tenant, 'freeBusy', { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: calendarId }] });
    const list = (j.calendars?.[calendarId]?.busy || []).map((b) => [Date.parse(b.start), Date.parse(b.end)]).filter(([a, b]) => a < b);
    const v = { at: Date.now(), from, to, list };
    busy.set(tenant.id, v);
    return v;
  } catch (e) {
    console.warn('[gcal]', tenant.id, e.message);
    if (!c) updateTenantSettings(tenant.id, { bookings: { google: { lastError: e.message.slice(0, 200) } } });
    return c || null; // keep the last good answer rather than offering everything
  }
}
/** True if [start, end) overlaps a busy time in the cached calendar (false when no calendar). */
export function isBusy(tenantId, startMs, endMs) {
  const c = busy.get(tenantId);
  return !!c && c.list.some(([a, b]) => startMs < b && endMs > a);
}
export const _setBusyForTest = (tenantId, list) => busy.set(tenantId, { at: Date.now(), from: 0, to: Infinity, list });

/** Write a confirmed booking into the owner's calendar. Returns the event id, or null. */
export async function addBookingEvent(tenantId, b, { startIso, endIso, summary, description, location } = {}) {
  const t = getTenant(tenantId);
  if (!calendarConnected(t) || !googleConfigured()) return null;
  try {
    const calendarId = t.settings.bookings.google.calendarId || 'primary';
    const ev = await api(t, `calendars/${encodeURIComponent(calendarId)}/events`, { summary, description, location, start: { dateTime: startIso }, end: { dateTime: endIso }, extendedProperties: { private: { wcBookingId: String(b.id) } } });
    const c = busy.get(tenantId); // the new event is busy now
    if (c) c.list.push([Date.parse(startIso), Date.parse(endIso)]);
    return ev.id || null;
  } catch (e) { console.warn('[gcal event]', e.message); return null; }
}
