import dns from 'node:dns/promises';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import { config } from './config.js';
import { isPrivateIp } from './knowledge.js';

/*
 * Sending new leads, bookings and orders to the shop's other tools.
 *  - notifications.webhookUrl: any webhook (Zapier "Catch Hook", Make, n8n, the shop's own system). Every event is
 *    POSTed as JSON: { event, tenant, at, data, row }. Signed with X-Signature (HMAC-SHA256 of the body) when the
 *    shop sets notifications.webhookSecret.
 *  - notifications.sheetsUrl: a Google Sheets Apps Script web app (we give the shop the 10-line script). It gets the
 *    same JSON; the script adds `row` (flat columns) to a tab named after the event type (Leads, Bookings, Orders).
 * Never blocks the chat: fire and forget, 10s timeout, no internal addresses.
 */
export const HOOK_EVENTS = ['lead.new', 'booking.new', 'booking.confirmed', 'booking.cancelled', 'order.created', 'order.paid', 'test'];

async function publicUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!config.allowPrivateFetch) {
    const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return null;
  }
  return u;
}

/** Flat columns for a spreadsheet row (same order every time for each kind). */
export function hookRow(event, data = {}) {
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const kind = event.split('.')[0];
  if (kind === 'lead') return { sheet: 'Leads', Date: at, Wants: data.kind === 'call' ? 'Call back' : 'Details', Topic: data.topic || '', Name: data.name || '', Email: data.email || '', Phone: data.phone || '', 'Best time': data.callTime || '', Message: data.message || '', Page: data.page || '', Channel: data.channel || '', 'Offers by email': data.marketingOptIn ? 'Yes' : 'No' };
  if (kind === 'booking') return { sheet: 'Bookings', Date: at, Status: event.split('.')[1], Service: data.service || '', When: data.when || '', Name: data.name || '', Phone: data.phone || '', Email: data.email || '', Notes: data.notes || '' };
  if (kind === 'order') return { sheet: 'Orders', Date: at, Status: event.split('.')[1], Order: data.store_order_name || data.id || '', Total: data.subtotal ?? '', Items: (data.items || []).map((i) => `${i.quantity} × ${i.title}`).join(', '), Name: data.customer_name || '', Phone: data.wa_id ? `+${data.wa_id}` : '', Payment: data.payment_status || '' };
  return { sheet: 'Test', Date: at, Message: data.message || 'Test from your chat assistant' };
}

async function post(url, body, secret) {
  const u = await publicUrl(url);
  if (!u) return { ok: false, error: 'That address is not allowed (it must be a public https:// address)' };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': `${config.productName || 'WhatsAppCommerce'}-webhook/1.0` };
  if (secret) headers['X-Signature'] = `sha256=${createHmac('sha256', String(secret)).update(body).digest('hex')}`;
  try {
    // Apps Script answers a POST with a redirect after running doPost(): that's a success, so no need to follow it
    const r = await fetch(u, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    return { ok: r.status < 400, status: r.status, error: r.status >= 400 ? `The address answered with HTTP ${r.status}` : undefined };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'No answer within 10 seconds' : e.message };
  }
}

/** Send one event to the shop's webhook and Google Sheet (whichever are set). Resolves with the results; never throws. */
export async function sendHook(tenant, event, data = {}) {
  const N = tenant?.settings?.notifications || {};
  const targets = [['webhook', N.webhookUrl], ['sheets', N.sheetsUrl]].filter(([, u]) => u);
  if (!targets.length) return [];
  const body = JSON.stringify({ event, tenant: tenant.id, at: new Date().toISOString(), data, row: hookRow(event, data) });
  return Promise.all(targets.map(async ([kind, url]) => {
    const r = await post(url, body, kind === 'webhook' ? N.webhookSecret : null);
    if (!r.ok && event !== 'test') console.warn(`[hook ${kind}] tenant=${tenant.id} ${event}: ${r.error}`);
    return { kind, ...r };
  }));
}

/** The Google Apps Script the shop pastes into Extensions → Apps Script (one tab per kind, headers added once). */
export const SHEETS_SCRIPT = `function doPost(e) {
  var msg = JSON.parse(e.postData.contents), row = msg.row || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet(), name = row.sheet || 'Data';
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var keys = Object.keys(row).filter(function (k) { return k !== 'sheet'; });
  if (sh.getLastRow() === 0) sh.appendRow(keys);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  keys.forEach(function (k) { if (head.indexOf(k) < 0) { head.push(k); sh.getRange(1, head.length).setValue(k); } });
  sh.appendRow(head.map(function (k) { return row[k] == null ? '' : row[k]; }));
  return ContentService.createTextOutput('ok');
}`;
