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
