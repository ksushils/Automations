export function toCsv(rows, columns) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // prevent spreadsheet formula injection
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.map((c) => cell(c.label || c.key)).join(','), ...rows.map((r) => columns.map((c) => cell(c.get ? c.get(r) : r[c.key])).join(','))].join('\r\n') + '\r\n';
}

/** RFC-4180-ish parser: quotes, escaped quotes, CRLF. Returns array of objects keyed by header (lower-cased). */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/**
 * Catalogue import. Columns: id,title,price,compare_at_price,category,description,image,stock,options
 * options = "Small:15:10|Large:16:4"  (title:price:stock – price/stock optional)
 */
export function productsFromCsv(text) {
  const rows = parseCsv(text);
  const errors = [];
  const products = [];
  rows.forEach((r, n) => {
    const line = n + 2;
    if (!r.title) return errors.push(`line ${line}: title is required`);
    const price = Number(r.price);
    if (!Number.isFinite(price) || price < 0) return errors.push(`line ${line}: invalid price "${r.price}"`);
    const id = r.id || r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const p = { id, title: r.title, price, category: r.category || 'general', description: r.description || '', image: r.image || '' };
    if (r.compare_at_price) p.compareAtPrice = Number(r.compare_at_price) || undefined;
    if (r.stock !== undefined && r.stock !== '') p.stock = Math.max(0, Math.floor(Number(r.stock) || 0));
    if (r.options) {
      p.variants = r.options.split('|').map((o, i) => {
        const [title, vp, vs] = o.split(':').map((x) => x.trim());
        const v = { id: `${id}-${i + 1}`, title, price: vp ? Number(vp) : price };
        if (vs !== undefined && vs !== '') v.stock = Math.max(0, Math.floor(Number(vs) || 0));
        return v;
      }).filter((v) => v.title);
    }
    products.push(p);
  });
  const seen = new Set();
  for (const p of products) {
    if (seen.has(p.id)) errors.push(`duplicate id "${p.id}"`);
    seen.add(p.id);
  }
  return { products, errors };
}
