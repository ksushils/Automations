import { getDb } from './db.js';
import { config } from './config.js';
import { safeFetch } from './knowledge.js';

/*
 * One-click website installs: a ready-made WordPress plugin with the shop's chat already inside, and detection of
 * the website builder so the dashboard shows the right steps first.
 */

// ---------- tiny ZIP writer (stored entries – a plugin is a few KB) ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const n = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    local.push(lh, n, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const phpStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A WordPress plugin that adds this shop's chat button to every page. Upload → Activate, nothing to configure. */
export function wordpressPlugin(tenant) {
  const src = `${config.publicUrl}/chat-widget/${tenant.id}.js`;
  const brand = config.productName || 'WhatsApp Commerce';
  const slug = 'ai-chat-assistant';
  const php = `<?php
/**
 * Plugin Name: ${brand} – AI chat for ${String(tenant.settings.business?.name || tenant.name).replace(/\*\//g, '')}
 * Description: Adds your AI assistant's chat button to every page of this website. Change how it looks in your ${brand} dashboard.
 * Version: 1.0.0
 * Author: ${brand}
 * License: GPL-2.0-or-later
 */
if (!defined('ABSPATH')) { exit; }
add_action('wp_enqueue_scripts', function () {
    if (is_admin()) { return; }
    wp_enqueue_script('${slug}', ${phpStr(src)}, array(), null, array('in_footer' => true, 'strategy' => 'async'));
});
add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    $links[] = '<a href="' . esc_url(${phpStr(config.publicUrl + '/admin/')}) . '" target="_blank" rel="noopener">Dashboard</a>';
    return $links;
});
`;
  const readme = `=== ${brand} AI chat ===\nStable tag: 1.0.0\nLicense: GPL-2.0-or-later\n\nAdds your ${brand} AI assistant to every page. Upload this zip in Plugins → Add New → Upload Plugin, then Activate.\n`;
  return zip({ [`${slug}/${slug}.php`]: php, [`${slug}/readme.txt`]: readme });
}

/** Which website builder does this site use? (shopify | wordpress | wix | squarespace | webflow | godaddy | other | null) */
export async function detectPlatform(website) {
  if (!website) return null;
  let r;
  try { r = await safeFetch(/^https?:\/\//.test(website) ? website : `https://${website}`, { maxBytes: 600000 }); } catch { return null; }
  const h = String(r.body || '').toLowerCase();
  if (/cdn\.shopify\.com|shopify\.theme|myshopify\.com/.test(h)) return 'shopify';
  if (/wp-content\/|wp-includes\/|<meta name="generator" content="wordpress/.test(h)) return 'wordpress';
  if (/static\.wixstatic\.com|wix\.com website builder|_wixcssimports/.test(h)) return 'wix';
  if (/squarespace\.com|static1\.squarespace/.test(h)) return 'squarespace';
  if (/webflow\.(js|com)|data-wf-site/.test(h)) return 'webflow';
  if (/img1\.wsimg\.com|godaddy/.test(h)) return 'godaddy';
  if (/googletagmanager\.com\/gtm\.js/.test(h)) return 'gtm';
  return 'other';
}

/** "Check my website": open the site now and look for this shop's chat code (no need to wait for a visitor). */
export async function checkInstall(tenant, url) {
  const site = String(url || tenant.settings.business?.website || '').trim();
  if (!site) return { ok: false, reason: 'no_website', message: 'Add your website address first (Settings → Business).' };
  let r;
  try { r = await safeFetch(/^https?:\/\//.test(site) ? site : `https://${site}`, { maxBytes: 1500000 }); } catch (e) { return { ok: false, reason: 'unreachable', message: `We couldn't open ${site}: ${e.message}` }; }
  const html = String(r.body || '');
  const mine = html.includes(`/chat-widget/${tenant.id}.js`) || html.includes(`/chat-widget/${encodeURIComponent(tenant.id)}.js`);
  const other = !mine && /\/chat-widget\/[\w-]+\.js/.test(html);
  const gtm = /googletagmanager\.com\/gtm\.js/.test(html);
  const wp = /wp-content\/plugins\/ai-chat-assistant/.test(html);
  let origin = site;
  try { origin = new URL(r.url).origin; } catch {}
  if (mine) {
    getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`widget_seen:${tenant.id}`, JSON.stringify({ origin, at: new Date().toISOString() }));
    return { ok: true, message: `✅ Found it – your chat is on ${origin.replace(/^https?:\/\//, '')}.` };
  }
  if (other) return { ok: false, reason: 'other_shop', message: "There's a chat code on your site, but it belongs to a different account. Copy the code from this page again and replace it." };
  if (wp) return { ok: false, reason: 'plugin_cached', message: 'Our WordPress plugin is installed. If you can\'t see the chat, clear your caching plugin (e.g. WP Rocket, LiteSpeed) and check again.' };
  if (gtm) return { ok: false, reason: 'gtm', message: "We can't see the code in the page itself, but your site uses Google Tag Manager – if you added it there, check it is Published, then open your site: the chat loads through Tag Manager." };
  return { ok: false, reason: 'not_found', message: `We can't see the chat code on ${origin.replace(/^https?:\/\//, '')} yet. Did you save and publish the change? Some builders need "Publish" after editing.` };
}
