import express from 'express';
import { config } from './config.js';
import { getDb } from './db.js';
import { randomToken } from './crypto.js';

/*
 * Sales tracking for shops that sell on their own website (Shopify / WooCommerce / any site):
 *  - every link the assistant sends to the shop's own site carries utm_source=ai-assistant, so the shop's own
 *    analytics (Shopify "Sales by traffic source", Google Analytics) show what the assistant brought in;
 *  - buttons (checkout, "view on website") go through a short /go/ link so we can count clicks;
 *  - with a read-only Shopify key, orders whose visit came from those links are counted as assistant sales.
 */
export const UTM_SOURCE = 'ai-assistant';

function shopHosts(tenant) {
  const S = tenant.settings;
  const hosts = new Set();
  for (const u of [S.business?.website, S.store?.shopify?.origin, S.store?.shopify?.domain && `https://${S.store.shopify.domain}`, S.store?.woocommerce?.url, S.business?.bookingUrl]) {
    try { if (u) hosts.add(new URL(u).hostname.replace(/^www\./, '')); } catch {}
  }
  return hosts;
}

const isShopUrl = (hosts, u) => { try { return hosts.has(new URL(u).hostname.replace(/^www\./, '')); } catch { return false; } };

export function withUtm(url, medium) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('utm_source')) return url;
    u.searchParams.set('utm_source', UTM_SOURCE);
    u.searchParams.set('utm_medium', medium);
    u.searchParams.set('utm_campaign', 'chat');
    return u.toString();
  } catch { return url; }
}

export function trackedLink(tenant, waId, url, kind) {
  const code = randomToken(9);
  getDb().prepare('INSERT INTO link_clicks (code, tenant_id, wa_id, url, kind) VALUES (?, ?, ?, ?, ?)').run(code, tenant.id, String(waId || ''), url, kind);
  return `${config.publicUrl}/go/${code}`;
}

/** Rewrite one outgoing message (a copy): shop links get UTM tags, button links become counted /go/ links. */
export function trackMessage(tenant, waId, msg) {
  if (!msg || tenant.settings.tracking?.enabled === false) return msg;
  const hosts = shopHosts(tenant);
  if (!hosts.size) return msg;
  const medium = String(waId).startsWith('web:') ? 'webchat' : 'whatsapp';
  const tagText = (t) => (typeof t === 'string' ? t.replace(/https?:\/\/[^\s<>()"']+/g, (u) => {
    const trail = u.match(/[.,!?;:]+$/)?.[0] || '';
    const clean = trail ? u.slice(0, -trail.length) : u;
    return (isShopUrl(hosts, clean) ? withUtm(clean, medium) : clean) + trail;
  }) : t);
  const out = { ...msg };
  if (out.text) out.text = tagText(out.text);
  if (out.caption) out.caption = tagText(out.caption);
  if (out.type === 'cta' && out.url && isShopUrl(hosts, out.url)) {
    out.url = trackedLink(tenant, waId, withUtm(out.url, medium), /\/cart\/|checkout/.test(out.url) ? 'checkout' : 'link');
  }
  return out;
}

export function clickStats(tenantId, start, end) {
  const r = getDb().prepare(`SELECT COUNT(*) AS sent, SUM(clicks > 0) AS clicked, SUM(CASE WHEN kind = 'checkout' AND clicks > 0 THEN 1 ELSE 0 END) AS checkouts
    FROM link_clicks WHERE tenant_id = ? AND created_at >= ? AND created_at < ?`).get(tenantId, start, end);
  return { linksSent: r.sent || 0, linksClicked: r.clicked || 0, checkoutsStarted: r.checkouts || 0 };
}

export function trackingRouter() {
  const r = express.Router();
  r.get('/go/:code', (req, res) => {
    const row = /^[A-Za-z0-9_-]{8,20}$/.test(req.params.code) ? getDb().prepare('SELECT url FROM link_clicks WHERE code = ?').get(req.params.code) : null;
    if (!row) return res.status(404).type('text').send('This link has expired.');
    getDb().prepare("UPDATE link_clicks SET clicks = clicks + 1, first_click_at = COALESCE(first_click_at, datetime('now')) WHERE code = ?").run(req.params.code);
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').redirect(302, row.url);
  });
  return r;
}
