import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants, say, ids } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { saveArticle, searchArticles, renderBody, draftArticles } from '../src/help.js';
import { createTicket, updateTicket, listTickets } from '../src/tickets.js';

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const admin = (base, path, opts = {}) => fetch(`${base}/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}` }, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('help centre: drafts stay private; a published article is public, searchable and teaches the assistant', () => withServer(async (base) => {
  const t = makeTenant({ business: { name: 'Bloom & Co' } });
  const draft = saveArticle(t.id, { title: 'How do I book an appointment?', category: 'Bookings', body: 'Tap **Book now** in the chat.\n\n- Pick a service\n- Pick a time' });
  assert.equal(draft.status, 'draft');
  assert.equal((await fetch(`${base}/help/${t.id}/${draft.slug}`)).status, 404, 'drafts are not public');
  const pub = (await admin(base, `/tenants/${t.id}/help/${draft.id}`, { method: 'PUT', body: { title: draft.title, category: 'Bookings', body: draft.body, status: 'published' } })).body.article;
  assert.equal(pub.status, 'published');
  const doc = getDb().prepare('SELECT name, text, url FROM knowledge_docs WHERE id = ?').get(pub.doc_id);
  assert.match(doc.text, /Pick a service/);
  assert.match(doc.url, new RegExp(`/help/${t.id}/how-do-i-book-an-appointment$`));
  const home = await (await fetch(`${base}/help/${t.id}`)).text();
  assert.match(home, /Bloom &amp; Co · Help centre/);
  assert.match(home, /How do I book an appointment\?/);
  assert.match(home, /chat-widget/);
  const art = await (await fetch(`${base}/help/${t.id}/${pub.slug}`)).text();
  assert.match(art, /<ul><li>Pick a service<\/li><li>Pick a time<\/li><\/ul>/);
  assert.match(art, /"@type":"FAQPage"/);
  assert.equal((await searchArticles(t.id, 'book'))[0].id, pub.id);
  assert.match(await (await fetch(`${base}/help/${t.id}/search?q=appointment`)).text(), /How do I book/);
  await fetch(`${base}/help/${t.id}/${pub.slug}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ helpful: true }) });
  assert.equal(getDb().prepare('SELECT helpful_yes, views FROM help_articles WHERE id = ?').get(pub.id).helpful_yes, 1);
  // unpublish removes it from the assistant's knowledge
  await admin(base, `/tenants/${t.id}/help/${pub.id}`, { method: 'PUT', body: { title: pub.title, category: 'Bookings', body: pub.body, status: 'draft' } });
  assert.equal(getDb().prepare('SELECT doc_id FROM help_articles WHERE id = ?').get(pub.id).doc_id, null);
  assert.equal(renderBody('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
}));

test('help centre: "write articles for me" makes drafts from real questions (AI stubbed)', async () => {
  const t = makeTenant();
  getDb().prepare("INSERT INTO unanswered (tenant_id, wa_id, question, answer, reason) VALUES (?, '1', 'Do you deliver on Sundays?', '', 'unsure')").run(t.id);
  getDb().prepare("INSERT INTO knowledge_docs (tenant_id, name, source, status, text) VALUES (?, 'Delivery', 'text', 'ready', 'We deliver Monday to Saturday, £3.50, free over £40.')").run(t.id);
  const prevCfg = { ...config };
  Object.assign(config, { aiBaseUrl: 'https://ai.test/v1', aiApiKey: 'sk-test', embeddingsModel: '' });
  const prev = globalThis.fetch;
  let prompt = '';
  globalThis.fetch = async (url, o) => { prompt = JSON.parse(o.body).messages[0].content; return new Response(JSON.stringify({ choices: [{ message: { content: '{"articles":[{"title":"Do you deliver on Sundays?","category":"Delivery","body":"We deliver Monday to Saturday, so not on Sundays. Delivery is £3.50 and free over £40."}]}' } }] })); };
  try {
    const made = await draftArticles(tenants.getTenant(t.id));
    assert.equal(made.length, 1);
    assert.equal(made[0].status, 'draft');
    assert.equal(made[0].source, 'ai');
    assert.match(prompt, /Do you deliver on Sundays\?/);
    assert.match(prompt, /never invent/);
  } finally { globalThis.fetch = prev; Object.assign(config, prevCfg); }
});

test('tickets in the chat: describe → email → ticket #1001; status lookups are private; replies reach the customer', () => withServer(async (base) => {
  const t = makeTenant({ tickets: { enabled: true, replyHours: 4 } });
  const web = 'web:ticketSessionABCDEFGH1';
  let r = await say(t, web, { action: 'ticket' });
  assert.match(r[0].text, /open a support ticket/);
  r = await say(t, web, 'My order arrived damaged and the box was wet');
  assert.match(r[0].text, /email address/);
  r = await say(t, web, 'sam@example.test');
  assert.match(r[0].text, /Ticket \*#1001\* is open\. We aim to reply within 4 hours.*by email/s);
  const [tk] = listTickets(t.id);
  assert.deepEqual([tk.number, tk.email, tk.status, tk.subject], [1001, 'sam@example.test', 'open', 'My order arrived damaged and the box was wet']);
  // status in the chat
  r = await say(t, web, 'any news on ticket 1001?');
  assert.match(r[0].text, /Ticket #1001.*Status: open/s);
  r = await say(t, 'web:someoneElseSessionABCD12', 'ticket 1001');
  assert.match(r[0].text, /can't find that ticket/, 'not shown to another chat');
  // the team replies from the dashboard → the customer sees it; their answer goes back on the ticket
  const up = await admin(base, `/tenants/${t.id}/tickets/1001`, { method: 'PATCH', body: { reply: 'Sorry Sam – can you send a photo of the box?' } });
  assert.equal(up.body.ticket.status, 'pending');
  assert.equal(up.body.delivered.chat, true);
  r = await say(t, web, 'yes, sending it now');
  assert.match(r[0].text, /added that to ticket #1001/);
  assert.equal(listTickets(t.id)[0].status, 'open');
  const ev = (await admin(base, `/tenants/${t.id}/tickets/1001`)).body.events.map((e) => e.kind);
  assert.deepEqual(ev, ['created', 'reply', 'customer']);
  // a private note never reaches the customer; solving tells them
  await updateTicket(tenants.getTenant(t.id), 1001, { note: 'Courier claim raised' });
  const solved = await updateTicket(tenants.getTenant(t.id), 1001, { status: 'solved' });
  assert.equal(solved.ticket.status, 'solved');
  const out = getDb().prepare("SELECT body FROM messages WHERE tenant_id = ? AND wa_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(t.id, web).body;
  assert.match(out, /Ticket #1001.*is solved/);
  assert.doesNotMatch(JSON.stringify(getDb().prepare("SELECT body FROM messages WHERE tenant_id = ? AND wa_id = ?").all(t.id, web)), /Courier claim/);
}));

test('tickets: the AI\'s "Open a ticket" choice opens one; off by default; the dashboard can create one', () => withServer(async (base) => {
  const t = makeTenant();
  const r = await say(t, '447700900111', { action: 'ticket' });
  assert.match(JSON.stringify(r), /member of our team/, 'tickets off → the usual hand-over');
  tenants.updateTenantSettings(t.id, { tickets: { enabled: true } });
  const c = await admin(base, `/tenants/${t.id}/tickets`, { method: 'POST', body: { name: 'Jo', email: 'jo@example.test', subject: 'Phone call: router fault', description: 'Router keeps dropping', priority: 'high' } });
  assert.equal(c.status, 201);
  assert.equal(c.body.ticket.priority, 'high');
  const list = (await admin(base, `/tenants/${t.id}/tickets?status=active`)).body;
  assert.equal(list.stats.open, 1);
  const { buildPrompt } = await import('../src/dify/provision.js');
  assert.match(buildPrompt(tenants.getTenant(t.id)), /Open a ticket \| Try something else/);
  const { extractChoices } = await import('../src/bot/engine.js');
  assert.deepEqual(extractChoices('Still not working?\n[CHOICES: Open a ticket | Try something else]').choices, ['Open a ticket', 'Try something else']);
  void ids; void createTicket;
}));
