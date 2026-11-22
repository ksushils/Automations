import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, tenants } = await import('./helpers.js');
const { getDb } = await import('../src/db.js');
const { updateLead, pipeline, listChatLeads } = await import('../src/leads.js');
const { createApp } = await import('../src/server.js');

const add = (t, name, status = 'new') => Number(getDb().prepare("INSERT INTO chat_leads (tenant_id, wa_id, kind, name, status) VALUES (?, 'w', 'call', ?, ?)").run(t.id, name, status).lastInsertRowid);

test('lead pipeline: values and notes entered by the team; open and won-this-month totals from those only', () => {
  const t = makeTenant({ store: { type: 'none' } });
  const a = add(t, 'Ann'), b = add(t, 'Ben'), c = add(t, 'Cal');
  updateLead(t.id, a, { value: 450 });
  updateLead(t.id, b, { value: '1200.5', notes: 'Wants a quote for a new boiler', status: 'contacted' });
  updateLead(t.id, c, { status: 'won', value: 85 });
  let p = pipeline(t.id);
  assert.deepEqual(p.open, { count: 2, value: 1650.5 });
  assert.deepEqual(p.wonThisMonth, { count: 1, value: 85 });
  assert.equal(p.stages.new.valued, 1);
  const row = listChatLeads(t.id).find((l) => l.id === b);
  assert.equal(row.notes, 'Wants a quote for a new boiler');
  assert.ok(row.contacted_at, 'moving on records when they were contacted');
  // reopening clears the won date; winning again sets it
  updateLead(t.id, c, { status: 'contacted' });
  assert.equal(pipeline(t.id).wonThisMonth.count, 0);
  updateLead(t.id, c, { value: null });
  assert.equal(listChatLeads(t.id).find((l) => l.id === c).value, null, 'a value can be cleared');
  assert.throws(() => updateLead(t.id, a, { value: -5 }), /positive/);
  assert.throws(() => updateLead(t.id, a, { status: 'maybe' }), /bad status/);
  const other = makeTenant();
  assert.throws(() => updateLead(other.id, a, { value: 1 }), /not found/, "another business can't touch it");
});

test('API: PATCH sets value/notes/status; CSV includes them', async () => {
  const t = makeTenant({ store: { type: 'none' } });
  const id = add(t, 'Dee');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/tenants/${t.id}`;
  const h = { Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}`, 'Content-Type': 'application/json' };
  try {
    const r = await fetch(`${base}/leads/${id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ value: 300, notes: 'Call after 5', status: 'won' }) }).then((x) => x.json());
    assert.equal(r.lead.value, 300); assert.equal(r.lead.status, 'won');
    assert.equal((await fetch(`${base}/leads/${id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ value: 'lots' }) })).status, 400);
    const list = await fetch(`${base}/leads`, { headers: h }).then((x) => x.json());
    assert.equal(list.pipeline.wonThisMonth.value, 300);
    const csv = await fetch(`${base}/export/leads.csv`, { headers: h }).then((x) => x.text());
    assert.match(csv, /Status,Value,Notes/); assert.match(csv, /won,300,Call after 5/);
  } finally { server.close(); }
});
