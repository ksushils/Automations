import { getDb, json } from './db.js';

/*
 * Business results, kept in four separate groups so an estimate is never shown as money earned:
 *  1. verified   – completed and recorded: paid orders, cash orders marked completed, accepted quotes,
 *                  bookings that happened, deposits paid.
 *  2. assisted   – the assistant took part, the outcome isn't proven: orders still unpaid/open, recovered carts,
 *                  items the chat put in the shop's own basket, leads captured, bookings confirmed for the future.
 *  3. estimated  – only if the owner enters an average job value (settings.results.averageJobValue); always labelled.
 *  4. potential  – open opportunities: quotes sent or waiting, new leads not yet contacted.
 * Every figure carries `how` (the rule used) and `records` (ids it was counted from), so it can be traced.
 */
const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
export function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || '')) ? String(month) : new Date().toISOString().slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  return { month: m, start: `${m}-01 00:00:00`, end: sqlTime(new Date(Date.UTC(y, mo, 1))) };
}
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

export function resultsBreakdown(tenant, month) {
  const { month: m, start, end } = monthRange(month);
  const d = getDb();
  const tid = tenant.id;
  const sym = tenant.settings?.business?.currencySymbol || '£';
  const ids = (rows) => rows.map((r) => r.id).slice(0, 200);
  const sum = (rows, f) => r2(rows.reduce((s, r) => s + Number(r[f] || 0), 0));
  const fig = (label, rows, valueField, how, extra = {}) => ({ label, count: rows.length, value: valueField ? sum(rows, valueField) : null, how, records: ids(rows), ...extra });

  const paid = d.prepare("SELECT id, subtotal FROM orders WHERE tenant_id = ? AND payment_status = 'paid' AND status != 'cancelled' AND COALESCE(paid_at, created_at) >= ? AND COALESCE(paid_at, created_at) < ?").all(tid, start, end);
  const cash = d.prepare("SELECT id, subtotal FROM orders WHERE tenant_id = ? AND payment_status != 'paid' AND status = 'completed' AND payment_method = 'cod' AND updated_at >= ? AND updated_at < ?").all(tid, start, end);
  const accepted = d.prepare("SELECT id, total FROM quotes WHERE tenant_id = ? AND status = 'accepted' AND accepted_at >= ? AND accepted_at < ?").all(tid, start, end);
  const done = d.prepare("SELECT id, deposit, deposit_paid FROM bookings WHERE tenant_id = ? AND status = 'completed' AND starts_at >= ? AND starts_at < ?").all(tid, start, end);
  const deposits = d.prepare("SELECT id, deposit FROM bookings WHERE tenant_id = ? AND deposit_paid = 1 AND updated_at >= ? AND updated_at < ?").all(tid, start, end);

  const openOrders = d.prepare("SELECT id, subtotal FROM orders WHERE tenant_id = ? AND payment_status != 'paid' AND status NOT IN ('cancelled', 'completed') AND created_at >= ? AND created_at < ?").all(tid, start, end);
  const recovered = d.prepare("SELECT id, subtotal FROM orders WHERE tenant_id = ? AND recovered = 1 AND status != 'cancelled' AND created_at >= ? AND created_at < ?").all(tid, start, end);
  const basket = d.prepare('SELECT COALESCE(SUM(site_cart_adds), 0) AS n FROM usage WHERE tenant_id = ? AND period = ?').get(tid, m).n;
  const leads = d.prepare('SELECT id FROM chat_leads WHERE tenant_id = ? AND created_at >= ? AND created_at < ?').all(tid, start, end);
  const future = d.prepare("SELECT id FROM bookings WHERE tenant_id = ? AND status IN ('confirmed', 'requested', 'awaiting_deposit') AND created_at >= ? AND created_at < ?").all(tid, start, end);

  const openQuotes = d.prepare("SELECT id, total, items FROM quotes WHERE tenant_id = ? AND status IN ('draft', 'sent')").all(tid);
  const pricedQuotes = openQuotes.filter((q) => { const it = json(q.items, []); return it.length && it.every((i) => i.price != null); });
  const newLeads = d.prepare("SELECT id FROM chat_leads WHERE tenant_id = ? AND status = 'new'").all(tid);

  const verified = [
    fig('Paid orders', paid, 'subtotal', 'Orders marked paid (by Stripe or by you) this month, excluding cancelled ones.'),
    fig('Cash orders completed', cash, 'subtotal', 'Cash-on-delivery orders you marked completed this month.'),
    fig('Accepted quotes', accepted, 'total', 'Quotes the customer accepted on the quote page this month (quote total as sent).'),
    fig('Bookings that happened', done, null, 'Bookings you marked completed, for appointments this month.'),
    fig('Deposits paid', deposits, 'deposit', 'Booking deposits paid online this month.'),
  ];
  const assisted = [
    fig('Orders not yet paid or completed', openOrders, 'subtotal', 'Orders taken by the assistant this month that are still open – not counted as earned.'),
    fig('Recovered carts', recovered, 'subtotal', 'Orders placed after an abandoned-cart reminder. The reminder helped; the sale may have happened anyway.'),
    { label: 'Items added to your shop\'s basket by the chat', count: Number(basket || 0), value: null, how: 'Products the chat put in your own website basket. We can\'t see whether they were bought.', records: [] },
    fig('Leads captured', leads, null, 'Callback and detail requests left in the chat this month.'),
    fig('Bookings made, not yet happened', future, null, 'Bookings made this month that are requested or confirmed but not completed yet.'),
  ];
  const avg = Number(tenant.settings?.results?.averageJobValue);
  const estimated = avg > 0 ? [{ label: 'Estimated value of leads', count: leads.length, value: r2(leads.length * avg), how: `ESTIMATE: ${leads.length} leads × your average job value of ${sym}${avg}. Not money received – many leads won't become jobs.`, records: ids(leads), estimate: true }] : [];
  const potential = [
    fig('Open quotes with full prices', pricedQuotes, 'total', 'Quotes still waiting (draft or sent) where every line has a price. Shown as potential, not earned.'),
    { label: 'Open quotes still missing prices', count: openQuotes.length - pricedQuotes.length, value: null, how: 'Quotes with at least one price "to confirm" – no value is shown for them.', records: openQuotes.filter((q) => !pricedQuotes.includes(q)).map((q) => q.id) },
    fig('New leads not yet contacted', newLeads, null, 'Leads still marked "new". See Opportunities.'),
  ];
  const total = (list) => r2(list.reduce((s, f) => s + (f.value || 0), 0));
  return {
    month: m, currencySymbol: sym,
    verified: { figures: verified, total: total(verified), note: 'Completed and recorded. This is the only group that counts as money earned.' },
    assisted: { figures: assisted, note: 'The assistant was involved, but the outcome isn\'t proven yet. Not added to earnings.' },
    estimated: { figures: estimated, note: estimated.length ? 'Estimates from the average job value you entered. Not money received.' : 'No estimate shown. Enter your average job value in Settings → Results to see one (always labelled as an estimate).' },
    potential: { figures: potential, total: total(potential), note: 'Open opportunities that could still turn into business.' },
  };
}
