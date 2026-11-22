import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenants } from './helpers.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { figures, checkAnswer, recordAnswer, listAnswers, answerStats, purgeAnswers } from '../src/verified.js';
import { resultsBreakdown } from '../src/results.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

// ---------------- verified answers ----------------
test('figures: prices, times, durations and percentages are normalised so they can be compared', () => {
  assert.deepEqual([...figures('A hygiene visit is £45.00 and takes 30 mins')].sort(), ['30 minute', '£45'].sort());
  assert.ok(figures('Open 9am to 5:30pm').has('9:00'));
  assert.ok(figures('Open 9am to 5:30pm').has('17:30'));
  assert.ok(figures('Open 09:00-17:30').has('17:30'));
  assert.ok(figures('It costs 45 pounds').has('£45'));
  assert.ok(figures('£1,200 for the refit').has('£1200'));
});

const SRC = [
  { id: 1, doc: 'Price list', url: 'https://dentist.example/prices', docId: 7, docUpdated: new Date().toISOString().replace('T', ' ').slice(0, 19), text: 'Hygienist appointment £45. Check-up £30. Whitening from £250.' },
  { id: 2, doc: 'Opening hours', url: 'https://dentist.example/contact', docId: 8, docUpdated: '2025-01-01 10:00:00', text: 'We are open Monday to Friday 09:00-17:30 and Saturday 10:00-14:00.' },
];

test('verified answers: the supporting source is identified and figures are checked against the sources', () => {
  const good = checkAnswer('A hygienist appointment costs £45 – would you like to book?', SRC);
  assert.equal(good.sources[0].doc, 'Price list');
  assert.ok(good.sources[0].figures.includes('£45'));
  assert.deepEqual(good.unsupported, []);
  assert.equal(good.confidence, 'high');
  const bad = checkAnswer('A hygienist appointment costs £39 and a check-up is £30.', SRC);
  assert.deepEqual(bad.unsupported, ['£39'], 'an invented price is flagged');
  assert.ok(bad.flags.includes('unsupported_figures'));
  assert.equal(bad.confidence, 'low');
  const stale = checkAnswer('We are open Monday to Friday until 17:30.', SRC);
  assert.ok(stale.flags.includes('stale_source'), 'source last checked over 90 days ago');
  const none = checkAnswer('Yes, we can help with that.', []);
  assert.deepEqual(none.flags, ['no_source']);
  const fromProducts = checkAnswer('The Classic Tee is £15.', [], { productText: 'Classic Tee £15.00' });
  assert.deepEqual(fromProducts.unsupported, [], 'figures from the product list count as supported');
});

test('verified answers: recorded per business, listed with flags, purged after 90 days', () => withServer(async (base) => {
  const a = tenants.createTenant({ name: 'Smile Dental' }), b = tenants.createTenant({ name: 'Other Dental' });
  recordAnswer(a.tenant.id, { waId: '447700900401', question: 'How much is the hygienist?', answer: 'It is £39.', sources: SRC });
  recordAnswer(a.tenant.id, { waId: '447700900402', question: 'Hygienist price?', answer: 'The hygienist appointment is £45.', sources: SRC });
  assert.equal(listAnswers(a.tenant.id).length, 2);
  assert.equal(listAnswers(a.tenant.id, { flagged: true }).length, 1);
  assert.equal(answerStats(a.tenant.id).unsupportedFigures, 1);
  const h = (k) => ({ Authorization: 'Bearer ' + k });
  const r = await (await fetch(`${base}/api/tenants/${a.tenant.id}/answers?flagged=1`, { headers: h(a.adminKey) })).json();
  assert.deepEqual(r.answers[0].unsupported, ['£39']);
  assert.equal(r.answers[0].sources[0].url, 'https://dentist.example/prices');
  assert.equal((await fetch(`${base}/api/tenants/${a.tenant.id}/answers`, { headers: h(b.adminKey) })).status, 401);
  assert.equal(listAnswers(b.tenant.id).length, 0);
  getDb().prepare("UPDATE answer_evidence SET created_at = datetime('now', '-100 days') WHERE tenant_id = ?").run(a.tenant.id);
  assert.ok(purgeAnswers() >= 2);
  assert.equal(listAnswers(a.tenant.id).length, 0);
}));

test('verified answers: a real AI turn is recorded with the retrieved sources (fake AI server)', async () => {
  const http = await import('node:http');
  const { config } = await import('../src/config.js');
  const { makeTenant, say } = await import('./helpers.js');
  const { addTextDoc } = await import('../src/knowledge.js');
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A hygienist appointment is £45, and a scale and polish is £60.' } }], usage: { total_tokens: 12 } })); }); });
  await new Promise((r) => srv.listen(0, r));
  const prev = { ...config };
  Object.assign(config, { aiBaseUrl: `http://127.0.0.1:${srv.address().port}/v1`, aiApiKey: 'sk-test', aiModel: 'test-model', embeddingsModel: '' });
  try {
    const t = makeTenant();
    addTextDoc(t.id, { name: 'Price list', text: 'Hygienist appointment £45. Check-up £30. Whitening from £250 per course.' });
    await new Promise((r) => setTimeout(r, 30));
    await say(t, '447700900499', 'how much is a hygienist appointment?');
    const rows = listAnswers(t.id);
    assert.equal(rows.length, 1, 'the AI answer was recorded');
    assert.equal(rows[0].question, 'how much is a hygienist appointment?');
    assert.equal(rows[0].sources[0].doc, 'Price list');
    assert.ok(rows[0].sources[0].figures.includes('£45'));
    assert.deepEqual(rows[0].unsupported, ['£60'], 'the price the AI made up is flagged');
    assert.equal(rows[0].model, 'default');
  } finally { srv.close(); Object.assign(config, prev); }
});

// ---------------- results ----------------
test('results: verified, assisted, estimated and potential are kept apart and traceable', () => {
  const { tenant } = tenants.createTenant({ name: 'Results Ltd', plan: 'growth' });
  const id = tenant.id, d = getDb();
  const paid = Number(d.prepare("INSERT INTO orders (tenant_id, wa_id, store_order_name, status, payment_status, payment_method, items, subtotal, paid_at) VALUES (?, '1', 'R-1', 'confirmed', 'paid', 'payment_link', '[]', 50, datetime('now'))").run(id).lastInsertRowid);
  d.prepare("INSERT INTO orders (tenant_id, wa_id, store_order_name, status, payment_status, payment_method, items, subtotal) VALUES (?, '2', 'R-2', 'pending', 'unpaid', 'payment_link', '[]', 80)").run(id);
  d.prepare("INSERT INTO orders (tenant_id, wa_id, store_order_name, status, payment_status, payment_method, items, subtotal) VALUES (?, '3', 'R-3', 'cancelled', 'paid', 'payment_link', '[]', 999)").run(id);
  d.prepare("INSERT INTO quotes (tenant_id, number, token, request, items, total, status, accepted_at) VALUES (?, 1, ?, 'x', '[]', 300, 'accepted', datetime('now'))").run(id, 'rt-' + id + '-1');
  d.prepare("INSERT INTO quotes (tenant_id, number, token, request, items, total, status) VALUES (?, 2, ?, 'y', ?, 120, 'sent')").run(id, 'rt-' + id + '-2', JSON.stringify([{ item: 'a', qty: 1, price: 120 }]));
  d.prepare("INSERT INTO quotes (tenant_id, number, token, request, items, total, status) VALUES (?, 3, ?, 'z', ?, 0, 'draft')").run(id, 'rt-' + id + '-3', JSON.stringify([{ item: 'b', qty: 1, price: null }]));
  d.prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind) VALUES (?, 'w', 'call')").run(id);
  let r = resultsBreakdown(tenants.getTenant(id));
  const v = (g, label) => r[g].figures.find((f) => f.label === label);
  assert.equal(v('verified', 'Paid orders').value, 50, 'cancelled paid orders excluded');
  assert.deepEqual(v('verified', 'Paid orders').records, [paid]);
  assert.equal(v('verified', 'Accepted quotes').value, 300);
  assert.equal(r.verified.total, 350);
  assert.equal(v('assisted', 'Orders not yet paid or completed').value, 80, 'unpaid orders are assisted, not earned');
  assert.equal(r.estimated.figures.length, 0, 'no estimate unless the owner gives an average job value');
  assert.equal(v('potential', 'Open quotes with full prices').value, 120);
  assert.equal(v('potential', 'Open quotes still missing prices').value, null);
  assert.ok([...r.verified.figures, ...r.assisted.figures, ...r.potential.figures].every((f) => f.how), 'every figure explains itself');
  tenants.updateTenantSettings(id, { results: { averageJobValue: 200 } });
  r = resultsBreakdown(tenants.getTenant(id));
  assert.equal(r.estimated.figures[0].value, 200);
  assert.match(r.estimated.figures[0].how, /^ESTIMATE/);
  assert.equal(r.verified.total, 350, 'estimates never change verified earnings');
});
