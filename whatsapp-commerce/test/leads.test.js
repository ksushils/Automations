import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, tenants, say, ids } from './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { addTextDoc } from '../src/knowledge.js';
import { getConversation } from '../src/bot/state.js';
import { cleanUtm } from '../src/routes/webchat.js';
import { cleanPhone, listChatLeads } from '../src/leads.js';

function fakeLlm(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      calls.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.endsWith('/embeddings')) return res.end(JSON.stringify({ data: [].concat(body.input).map((t, index) => ({ index, embedding: [1, 0, 0] })) }));
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: handler(body, calls) } }], usage: { total_tokens: 10 } }));
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}/v1` })));
}
const lastUser = (body) => String(body.messages.filter((m) => m.role === 'user').at(-1)?.content || '');
const AI = (body) => {
  const q = lastUser(body);
  if (/A customer tapped "Visa help"/.test(q)) return 'We make visas simple! ✈️\n• *India e-visa* applications checked and filed for you\n• Tourist and business visas';
  if (/Summarise for/.test(q)) return 'Family of 4 wants an India e-visa for March.';
  if (/just asked a customer/.test(q)) return '[]';
  if (/how much is a visa/i.test(q)) return 'An India tourist e-visa is handled by our team – prices depend on the visa type. Would you like help?\n[CHOICES: 📞 Call me back | 📩 Email me details | 💬 Ask more]';
  return 'Happy to help.';
};
function captureEmail() {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith('https://api.resend.com/')) { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: 'em' }), { status: 200 }); }
    return real(url, opts);
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}
async function withAll(fn) {
  const llm = await fakeLlm(AI);
  const prev = { ...config };
  Object.assign(config, { aiBaseUrl: llm.url, aiApiKey: 'sk-test', aiModel: 'test-model', embeddingsModel: '', resendApiKey: 're_test', emailFrom: 'Alerts <a@example.test>' });
  const cap = captureEmail();
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn({ base: `http://127.0.0.1:${server.address().port}`, llm, mail: cap.sent }); } finally { cap.restore(); Object.assign(config, prev); server.close(); llm.srv.close(); }
}
const post = (base, id, body) => fetch(`${base}/chat/${id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const SID = () => 'sess' + Math.random().toString(36).slice(2).padEnd(20, 'x');
const travelShop = () => {
  const t = makeTenant({ store: { type: 'none' }, business: { name: 'Travel Rise' }, welcomeMenu: { enabled: true, intro: 'Where would you like to go?', options: [{ label: '🛂 Visa help', action: 'link', value: 'https://travel.test/visa' }, { label: '🙋 Talk to a person', action: 'human' }] } });
  getDb().prepare('UPDATE tenants SET owner_email = ? WHERE id = ?').run('owner@travel.test', t.id);
  addTextDoc(t.id, { name: 'Visas', url: 'https://travel.test/visa', text: 'Visa help: we check and file India e-visa applications for tourists and business travellers. Visa help for the UK too.' });
  return t;
};

test('menu topic: answers in the chat from the website, links to the page, then offers email / call back / ask', () => withAll(async ({ base }) => {
  const t = travelShop();
  await new Promise((r) => setTimeout(r, 30));
  const r = await post(base, t.id, { sessionId: SID(), actionId: 'wm:0', page: { url: 'https://travel.test/', title: 'Travel Rise' } });
  const cta = r.replies.find((m) => m.type === 'cta');
  assert.match(cta.text, /India e-visa/);
  assert.equal(cta.buttonText, 'Know more');
  assert.equal(new URL(cta.url).pathname.startsWith('/go/') || cta.url.startsWith('https://travel.test/visa'), true);
  const offer = r.replies.find((m) => m.type === 'buttons');
  assert.match(offer.text, /Would you like our team to help you with this?/);
  assert.deepEqual(offer.buttons.map((b) => b.id), ['lead:email:Visa help', 'lead:call:Visa help', 'ask']);
}));

test('email me details (website): email, optional phone, name, requirement – saved, team alerted, separate marketing opt-in', () => withAll(async ({ base, mail }) => {
  const t = travelShop();
  tenants.updateTenantSettings(t.id, { leads: { privacyUrl: 'https://travel.test/privacy', requirementPrompt: 'Tell us about the trip – where, when, how many travelling?' } });
  const sid = SID(); const ask = (body) => post(base, t.id, { sessionId: sid, page: { url: 'https://travel.test/visa?utm_source=x', title: 'Visas' }, utm: { utm_source: 'facebook', utm_campaign: 'india-visa' }, ...body });
  let r = await ask({ actionId: 'lead:email:Visa help' });
  assert.match(r.replies[0].text, /email address\? \(so our team can send you details about Visa help\)/);
  assert.match(r.replies[0].text, /travel\.test\/privacy/);
  r = await ask({ text: 'not-an-email' });
  assert.match(r.replies[0].text, /doesn't look like an email/);
  r = await ask({ text: 'Jo@Example.co.uk' });
  assert.match(r.replies[0].text, /call back too\?/);
  r = await ask({ text: '07700 900123' });
  assert.match(r.replies[0].text, /who should we ask for/);
  r = await ask({ text: "I'm Jo" });
  assert.match(r.replies[0].text, /where, when, how many travelling/);
  r = await ask({ text: 'Family of 4, India e-visa for March' });
  assert.match(r.replies[0].text, /Thanks, Jo! We'll email you at jo@example\.co\.uk/);
  assert.match(r.replies[0].text, /offers and news from Travel Rise by email\?/);
  assert.deepEqual(r.replies[0].buttons.map((b) => b.id), ['lead:optin', 'lead:nooptin']);
  await new Promise((x) => setTimeout(x, 60));
  const [lead] = listChatLeads(t.id);
  assert.deepEqual([lead.kind, lead.topic, lead.name, lead.email, lead.phone, lead.message, lead.channel, lead.marketing_opt_in], ['email', 'Visa help', 'Jo', 'jo@example.co.uk', '07700900123', 'Family of 4, India e-visa for March', 'web', 0]);
  assert.equal(lead.page, 'https://travel.test/visa');
  assert.equal(lead.source.utm_campaign, 'india-visa');
  assert.equal(lead.summary, 'Family of 4 wants an India e-visa for March.');
  assert.ok(mail.some((m) => m.to.includes('owner@travel.test') && /New lead/.test(m.subject) && /07700900123/.test(m.text)), 'the team is emailed at once');
  r = await ask({ actionId: 'lead:optin' });
  assert.match(r.replies[0].text, /on the list/);
  const after = listChatLeads(t.id)[0];
  assert.equal(after.marketing_opt_in, 1);
  assert.match(after.opt_in_text, /unsubscribe at any time/);
}));

test('call me back on WhatsApp: uses their number, asks the best time and what to discuss; email is optional', async () => {
  const t = travelShop();
  const wa = '447700900771';
  await say(t, wa, 'hi'); // WhatsApp gives us their profile name
  let r = await say(t, wa, { action: 'lead:call:Holidays abroad' });
  assert.match(r[0].text, /we'll call you on \+447700900771/);
  assert.deepEqual(ids(r), ['lead:when:Morning', 'lead:when:Afternoon', 'lead:when:Evening']);
  r = await say(t, wa, { action: 'lead:when:Evening' });
  assert.match(r[0].text, /anything in particular/i, 'name known from WhatsApp, so straight to the requirement');
  r = await say(t, wa, 'Thailand in May, 2 adults, about £1500 each');
  assert.match(r[0].text, /What's your email address\?/);
  r = await say(t, wa, { action: 'lead:skip' });
  assert.match(r[0].text, /We'll call you on \+447700900771 \(evening\)/);
  const [lead] = listChatLeads(t.id);
  assert.deepEqual([lead.kind, lead.phone, lead.call_time, lead.message, lead.email, lead.channel], ['call', '+447700900771', 'Evening', 'Thailand in May, 2 adults, about £1500 each', null, 'whatsapp']);
});

test('never stuck in a form: a question mid-way is answered, "menu" leaves; the AI\'s "Call me back" starts the call-back', () => withAll(async ({ base }) => {
  const t = travelShop();
  const sid = SID();
  await post(base, t.id, { sessionId: sid, actionId: 'lead:email:Visa help' });
  let r = await post(base, t.id, { sessionId: sid, text: 'how much is a visa for India?' });
  assert.match(JSON.stringify(r.replies), /prices depend on the visa type/);
  assert.equal(getConversation(t.id, `web:${sid}`).state, 'idle');
  const q = r.replies.find((m) => m.type === 'buttons');
  assert.ok(q.buttons[0].id.startsWith('lead:call:'), 'Call me back → lead flow');
  assert.ok(q.buttons[1].id.startsWith('lead:email:'));
  r = await post(base, t.id, { sessionId: sid, actionId: q.buttons[0].id });
  assert.match(r.replies[0].text, /best number to call you on/);
  r = await post(base, t.id, { sessionId: sid, text: 'menu' });
  assert.equal(getConversation(t.id, `web:${sid}`).state, 'idle');
  assert.equal(listChatLeads(t.id).length, 0, 'nothing saved without contact details');
}));

test('phone numbers and campaign tags are cleaned', () => {
  assert.equal(cleanPhone('07700 900123'), '07700900123');
  assert.equal(cleanPhone('+91 98765-43210'), '+919876543210');
  assert.equal(cleanPhone('call me'), null);
  assert.equal(cleanPhone('12'), null);
  assert.deepEqual(cleanUtm({ utm_source: 'google<script>', utm_medium: 'cpc', evil: 'x' }), { utm_source: 'googlescript', utm_medium: 'cpc' });
  assert.equal(cleanUtm({}), null);
});
