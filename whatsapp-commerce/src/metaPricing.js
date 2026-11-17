import { readFileSync } from 'node:fs';
import { getDb } from './db.js';

/*
 * Approximate Meta (WhatsApp) per-message prices in GBP, used for ESTIMATES (dashboard, cost calculator, fee checker).
 * Meta bills the shop directly. The rates live in ONE file, src/meta-rates.json – update them there
 * (or override on the server with META_RATES_JSON). Service replies: first 1,000 free per number per month.
 */
const FILE = JSON.parse(readFileSync(new URL('./meta-rates.json', import.meta.url), 'utf8'));
const DEFAULT_RATES = FILE.rates;
export const FREE_SERVICE_PER_MONTH = FILE.freeServicePerNumber;
export const RATES_SOURCE = FILE.source;
// Shown on the public pages. Update checkedOn in meta-rates.json whenever you re-check the rates.
export const RATES_CHECKED_ON = process.env.META_RATES_CHECKED_ON || FILE.checkedOn;
export const getRates = () => rates();

function rates() {
  try { return { ...DEFAULT_RATES, ...JSON.parse(process.env.META_RATES_JSON || '{}') }; } catch { return DEFAULT_RATES; }
}

/** Very rough country from a WhatsApp number (enough for GB/IE; everything else uses DEFAULT). */
export function countryOf(waId) {
  const d = String(waId || '');
  if (d.startsWith('44')) return 'GB';
  if (d.startsWith('353')) return 'IE';
  return 'DEFAULT';
}

export function rateFor(waId, category) {
  const r = rates();
  return (r[countryOf(waId)] || r.DEFAULT)[category] ?? r.DEFAULT[category];
}

/** Estimated Meta cost of sending one marketing template to each recipient. */
export function estimateCampaign(recipients, category = 'marketing') {
  const total = recipients.reduce((s, w) => s + rateFor(w, category), 0);
  return { recipients: recipients.length, category, estimatedGbp: Math.round(total * 100) / 100 };
}

/** This month so far: outbound service replies (free allowance applied) + campaign (marketing) messages. */
export function monthEstimate(tenantId) {
  const d = getDb();
  const since = "datetime('now', 'start of month')";
  const out = d.prepare(`SELECT wa_id, type, body FROM messages WHERE tenant_id = ? AND direction = 'out' AND wa_id NOT LIKE 'web:%' AND COALESCE(source, '') NOT IN ('phone_app', 'history') AND created_at >= ${since}`).all(tenantId); // web chat isn't billed by Meta
  // Keep your number: messages the owner sends from the WhatsApp Business app are free; only API messages are charged
  const phoneApp = d.prepare(`SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'out' AND source = 'phone_app' AND created_at >= ${since}`).get(tenantId).n;
  let cats = {};
  try { cats = JSON.parse(d.prepare('SELECT value FROM kv WHERE key = ?').get(`tpl:${tenantId}`)?.value || '{}'); } catch {}
  let unknownCategory = 0;
  const campaignIds = new Set(d.prepare(`SELECT wa_id || ':' || campaign_id AS k FROM message_status WHERE tenant_id = ? AND campaign_id IS NOT NULL AND updated_at >= ${since}`).all(tenantId).map((r) => r.k));
  let service = 0, serviceCost = 0, templates = 0, templateCost = 0;
  const serviceRows = [];
  for (const m of out) {
    if (m.type === 'template') {
      // priced by the template's actual Meta category (falls back to marketing = upper bound when unknown)
      let name = null;
      try { name = JSON.parse(m.body || '{}').name; } catch {}
      const cat = String(cats[name]?.category || '').toLowerCase();
      if (!cat) unknownCategory++;
      templates++;
      templateCost += rateFor(m.wa_id, ['utility', 'authentication', 'marketing'].includes(cat) ? cat : 'marketing');
    } else { service++; serviceRows.push(m.wa_id); }
  }
  for (const w of serviceRows.slice(FREE_SERVICE_PER_MONTH)) serviceCost += rateFor(w, 'service');
  return {
    month: new Date().toISOString().slice(0, 7),
    serviceMessages: service,
    freeServiceLeft: Math.max(0, FREE_SERVICE_PER_MONTH - service),
    serviceGbp: Math.round(serviceCost * 100) / 100,
    templateMessages: templates,
    templateGbp: Math.round(templateCost * 100) / 100,
    templatesWithUnknownCategory: unknownCategory, // priced at the marketing rate until the Templates tab is opened once
    totalGbp: Math.round((serviceCost + templateCost) * 100) / 100,
    campaignsTracked: campaignIds.size,
    phoneAppMessages: phoneApp, // free: sent from the WhatsApp Business app
    note: 'Estimate only – Meta bills you directly using its current rate card.',
  };
}
