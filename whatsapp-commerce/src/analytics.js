import { getDb, json } from './db.js';

/** Sales analytics for the dashboard (last N days, UTC). */
export function analytics(tenantId, days = 30) {
  const d = getDb();
  const since = `-${Math.max(1, Math.min(365, Number(days) || 30))} days`;
  const live = "status != 'cancelled'";
  const totals = d.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal),0) AS revenue, COALESCE(SUM(CASE WHEN payment_status='paid' THEN subtotal END),0) AS paid_revenue, COALESCE(SUM(discount),0) AS discounts, COUNT(DISTINCT wa_id) AS buyers FROM orders WHERE tenant_id = ? AND ${live} AND created_at > datetime('now', ?)`).get(tenantId, since);
  const byDay = d.prepare(`SELECT date(created_at) AS day, COUNT(*) AS orders, ROUND(SUM(subtotal),2) AS revenue FROM orders WHERE tenant_id = ? AND ${live} AND created_at > datetime('now', ?) GROUP BY day ORDER BY day`).all(tenantId, since);
  const chats = Math.max(totals.buyers, d.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND updated_at > datetime('now', ?)`).get(tenantId, since).n);
  const newCustomers = d.prepare(`SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND created_at > datetime('now', ?)`).get(tenantId, since).n;
  const repeat = d.prepare(`SELECT COUNT(*) AS n FROM (SELECT wa_id FROM orders WHERE tenant_id = ? AND ${live} GROUP BY wa_id HAVING COUNT(*) > 1)`).get(tenantId).n;
  const items = {};
  for (const o of d.prepare(`SELECT items FROM orders WHERE tenant_id = ? AND ${live} AND created_at > datetime('now', ?)`).all(tenantId, since)) {
    for (const i of json(o.items, [])) {
      const k = i.title;
      items[k] ||= { title: k, quantity: 0, revenue: 0 };
      items[k].quantity += i.quantity;
      items[k].revenue += i.price * i.quantity;
    }
  }
  const topProducts = Object.values(items).sort((a, b) => b.revenue - a.revenue).slice(0, 10).map((x) => ({ ...x, revenue: Math.round(x.revenue * 100) / 100 }));
  const promos = d.prepare(`SELECT promo_code AS code, COUNT(*) AS orders, ROUND(SUM(discount),2) AS discount FROM orders WHERE tenant_id = ? AND promo_code IS NOT NULL AND ${live} AND created_at > datetime('now', ?) GROUP BY promo_code ORDER BY orders DESC`).all(tenantId, since);
  return {
    days: Number(days) || 30,
    ...totals,
    revenue: Math.round(totals.revenue * 100) / 100,
    paid_revenue: Math.round(totals.paid_revenue * 100) / 100,
    aov: totals.orders ? Math.round((totals.revenue / totals.orders) * 100) / 100 : 0,
    chats,
    conversion: chats ? Math.round((totals.buyers / chats) * 1000) / 10 : 0,
    newCustomers,
    repeatCustomers: repeat,
    byDay,
    topProducts,
    promos,
  };
}
