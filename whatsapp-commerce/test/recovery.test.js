import { test } from 'node:test';
import assert from 'node:assert/strict';
const { tenants } = await import('./helpers.js');
const { getDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { createApp } = await import('../src/server.js');

/** Email "set up" with a fake Resend that records what would be sent. */
async function withEmail(fn) {
  const prev = { key: config.resendApiKey, from: config.emailFrom, fetch: globalThis.fetch };
  Object.assign(config, { resendApiKey: 're_test_key_123456', emailFrom: 'Test <test@example.com>' });
  const sent = [];
  globalThis.fetch = async (url, o) => (String(url).includes('resend.com') ? (sent.push(JSON.parse(o.body)), new Response(JSON.stringify({ id: 'em_' + sent.length }), { status: 200 })) : prev.fetch(url, o));
  try { return await fn(sent); } finally { Object.assign(config, { resendApiKey: prev.key, emailFrom: prev.from }); globalThis.fetch = prev.fetch; }
}

test('lost key: one-time link to the sign-up email only; same answer for unknown emails; old key stops working', () => withEmail(async (sent) => {
  const { tenant, adminKey, toolKey } = tenants.createTenant({ name: 'Bloom Florist' });
  getDb().prepare('UPDATE tenants SET owner_email = ? WHERE id = ?').run('Owner@Bloom.example', tenant.id);
  tenants.updateTenantSettings(tenant.id, { notifications: { alertEmails: ['staff@bloom.example'] } });
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => { const j = await fetch(base + '/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()); await new Promise((x) => setTimeout(x, 60)); return j; }; // emails go out in the background
  try {
    const unknown = await post({ email: 'nobody@nowhere.example' });
    const staff = await post({ email: 'staff@bloom.example' });
    assert.equal(sent.length, 0, 'unknown and alert-only addresses get nothing');
    const known = await post({ email: 'owner@bloom.example' });
    assert.equal(known.message, unknown.message, "the answer never reveals whether there's an account");
    assert.equal(staff.message, unknown.message);
    assert.equal(sent.length, 1);
    const link = sent[0].text.match(/https?:\/\/\S+\/recover\/(\S+)/);
    assert.ok(link, 'the email has the link');
    const token = link[1];
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM kv WHERE value LIKE ?").get(`%${token}%`).n, 0, 'only a hash of the link is stored');
    // opening the link changes nothing (email scanners), pressing the button does
    const get = await fetch(`${base}/recover/${token}`);
    assert.equal(get.status, 200); assert.match(await get.text(), /Make my new key/);
    assert.ok(tenants.authenticateAdminKey(tenant.id, adminKey), 'old key still works after just opening the link');
    const done = await fetch(`${base}/recover/${token}`, { method: 'POST' });
    const html = await done.text();
    const newKey = html.match(/(adm_[\w-]+)/)[1];
    assert.ok(tenants.authenticateAdminKey(tenant.id, newKey));
    assert.ok(!tenants.authenticateAdminKey(tenant.id, adminKey), 'the old key no longer works');
    assert.ok(tenants.authenticateToolKey(tenant.id, toolKey), 'the Dify tool key is untouched');
    assert.match(sent.at(-1).subject, /key was changed/);
    assert.equal((await fetch(`${base}/recover/${token}`, { method: 'POST' })).status, 410, 'the link works once');
    assert.ok(getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'key.recovered'").get(tenant.id).n >= 1);
    // expired links don't work
    await post({ email: 'owner@bloom.example' });
    const t2 = sent.at(-1).text.match(/\/recover\/(\S+)/)[1];
    getDb().prepare("UPDATE kv SET value = json_set(value, '$.exp', 1) WHERE key LIKE 'recover:%'").run();
    assert.equal((await fetch(`${base}/recover/${t2}`)).status, 410);
  } finally { server.close(); }
}));

test('without email set up, the page says so instead of pretending', async () => {
  const server = createApp().listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.example' }) }).then((x) => x.json());
    assert.equal(r.emailConfigured, false);
    assert.match(r.message, /isn't set up/);
  } finally { server.close(); }
});

test('owners set their account email (needed for recovery); a change tells the old address; staff cannot', () => withEmail(async (sent) => {
  const { tenant } = tenants.createTenant({ name: 'Hand-made Shop' });
  const { createStaff } = await import('../src/staff.js');
  const staffKey = createStaff(tenant.id, { name: 'Sam' }).key;
  const { todayList } = await import('../src/today.js');
  assert.ok(todayList(tenants.getTenant(tenant.id)).items.some((i) => i.key === 'account_email'), 'Today reminds the owner');
  const server = createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/tenants/${tenant.id}/account-email`;
  const sup = { Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...sup, Authorization: `Bearer ${staffKey}` }, body: JSON.stringify({ email: 'evil@x.example' }) })).status, 403);
    assert.equal((await fetch(url, { method: 'PUT', headers: sup, body: JSON.stringify({ email: 'nope' }) })).status, 400);
    await fetch(url, { method: 'PUT', headers: sup, body: JSON.stringify({ email: 'Owner@Shop.example' }) });
    assert.equal((await (await fetch(url, { headers: sup })).json()).email, 'owner@shop.example');
    assert.equal(sent.length, 0, 'first time: nobody to tell');
    await fetch(url, { method: 'PUT', headers: sup, body: JSON.stringify({ email: 'new@shop.example' }) });
    await new Promise((x) => setTimeout(x, 50));
    assert.equal(sent.at(-1).to?.[0] || sent.at(-1).to, 'owner@shop.example');
    assert.match(sent.at(-1).subject, /account email was changed/);
    assert.ok(!todayList(tenants.getTenant(tenant.id)).items.some((i) => i.key === 'account_email'));
  } finally { server.close(); }
}));
