import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenants } from './helpers.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { buildTwin } from '../src/businessTwin.js';

const addDoc = (tenantId, name, url, text) => getDb().prepare("INSERT INTO knowledge_docs (tenant_id, name, source, url, text, size, status) VALUES (?, ?, 'url', ?, ?, ?, 'ready')").run(tenantId, name, url, text, text.length);

test('Business Twin: facts found with their page, conflicting contact details flagged, missing facts say what the assistant does', () => {
  const { tenant } = tenants.createTenant({ name: 'Smith Plumbing', plan: 'growth' });
  tenants.updateTenantSettings(tenant.id, { business: { name: 'Smith Plumbing' }, trade: 'plumber' });
  addDoc(tenant.id, 'Home', 'https://smith.example/', 'Smith Plumbing – emergency plumbers. Call us on 020 7946 0123. We cover Croydon, Sutton and Bromley.\nEmail info@smith.example for quotes.');
  addDoc(tenant.id, 'Prices', 'https://smith.example/prices', 'Call-out charge £65. Tap washer replacement from £45.\nPayment by card on completion.');
  addDoc(tenant.id, 'Contact', 'https://smith.example/contact', 'Ring 020 7946 0123 or our mobile +44 7700 900456. Office: 12 High Street, Croydon CR0 1AB. jobs@smith.example. Logo: logo@2x.png');
  const tw = buildTwin(tenant.id);
  const f = Object.fromEntries(tw.facts.map((x) => [x.key, x]));

  assert.equal(f.name.status, 'found');
  assert.equal(f.type.status, 'found');
  assert.match(f.type.values[0].value, /Plumber/i);

  assert.equal(f.phone.status, 'uncertain', 'two different numbers → the owner should say which one');
  assert.deepEqual(f.phone.values.map((v) => v.value).sort(), ['020 7946 0123', '07700 900456']);
  assert.match(f.phone.why, /2 different/);
  assert.equal(f.phone.values.find((v) => v.value === '020 7946 0123').source.url, 'https://smith.example/', 'first page it appears on');

  assert.equal(f.email.status, 'uncertain');
  assert.ok(!f.email.values.some((v) => /png/.test(v.value)), 'image file names are not email addresses');
  assert.equal(f.postcode.status, 'found');
  assert.equal(f.postcode.values[0].value, 'CR0 1AB');

  assert.equal(f.prices.status, 'found');
  assert.ok(f.prices.values.some((v) => /£65/.test(v.value) && v.source.page === 'Prices'));
  assert.equal(f.area.status, 'found');
  assert.match(f.area.values[0].value, /We cover Croydon/);

  assert.equal(f.hours.status, 'missing');
  assert.match(f.hours.ifMissing, /won't make up times/);
  assert.equal(f.returns.status, 'missing');

  assert.equal(tw.summary.pages, 3);
  assert.equal(tw.summary.found + tw.summary.uncertain + tw.summary.missing, tw.facts.length);
  assert.equal(tw.pages.length, 3);
});

test('Business Twin: opening hours found; deleted pages ignored; nothing invented for an empty business', () => {
  const { tenant } = tenants.createTenant({ name: 'Empty', plan: 'free' });
  const empty = buildTwin(tenant.id);
  assert.equal(empty.summary.pages, 0);
  assert.ok(empty.facts.filter((x) => !['name'].includes(x.key)).every((x) => x.status === 'missing' && x.values.length === 0));
  addDoc(tenant.id, 'Visit', null, 'We are open Monday to Friday 9am - 5:30pm and Saturday 10:00-14:00.');
  getDb().prepare("INSERT INTO knowledge_docs (tenant_id, name, source, text, size, status) VALUES (?, 'Old', 'url', 'Call 020 7946 0999', 10, 'deleted')").run(tenant.id);
  const tw = buildTwin(tenant.id);
  const f = Object.fromEntries(tw.facts.map((x) => [x.key, x]));
  assert.equal(f.hours.status, 'found');
  assert.match(f.hours.values[0].value, /Monday to Friday 9am - 5:30pm/);
  assert.equal(f.hours.values[0].source.url, null);
  assert.equal(f.phone.status, 'missing', 'a deleted page is not used');
});

test('Business Twin over HTTP: owner can read it; another business cannot; unknown demo token is 404', async () => {
  const A = tenants.createTenant({ name: 'Twin A', plan: 'growth' });
  const B = tenants.createTenant({ name: 'Twin B', plan: 'growth' });
  addDoc(A.tenant.id, 'Home', 'https://a.example/', 'Call 020 7946 0555 today.');
  const srv = createApp().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await fetch(`${base}/api/tenants/${A.tenant.id}/twin`, { headers: { Authorization: 'Bearer ' + A.adminKey } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).facts.find((x) => x.key === 'phone').values[0].value, '020 7946 0555');
    const no = await fetch(`${base}/api/tenants/${A.tenant.id}/twin`, { headers: { Authorization: 'Bearer ' + B.adminKey } });
    assert.ok([401, 403, 404].includes(no.status));
    assert.equal((await fetch(`${base}/try/notarealtoken1234567890/twin`)).status, 404);
  } finally { srv.close(); }
});
