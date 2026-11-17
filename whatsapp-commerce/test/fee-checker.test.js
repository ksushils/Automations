import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { FREE_SERVICE_PER_MONTH, getRates } from '../src/metaPricing.js';
import { computeFees, feeInputs, ukRates } from '../src/feeChecker.js';

const R = { marketing: 0.05, utility: 0.017, authentication: 0.017, service: 0.017 };
const FREE = 1000;
const only = (o) => feeInputs({ marketing: 0, utility: 0, authentication: 0, service: 0, markupPct: 20, perMessageFee: 0, users: 0, perUserFee: 0, numbers: 1, ...o });
const line = (out, key) => out.lines.find((l) => l.key === key);

test("Meta's rates come from one file, src/meta-rates.json", () => {
  const file = JSON.parse(readFileSync(new URL('../src/meta-rates.json', import.meta.url), 'utf8'));
  assert.deepEqual(getRates().GB, file.rates.GB);
  assert.deepEqual(ukRates(), file.rates.GB);
  assert.equal(FREE_SERVICE_PER_MONTH, file.freeServicePerNumber);
  assert.equal(FREE_SERVICE_PER_MONTH, 1000);
});

test('service messages: the first 1,000 per number are free, so no Meta charge and no markup on them', () => {
  let out = computeFees(only({ service: 1000 }), R, FREE);
  assert.deepEqual([line(out, 'service').free, line(out, 'service').paid, line(out, 'service').meta, line(out, 'service').markup], [1000, 0, 0, 0]);
  assert.equal(out.monthlyMarkup, 0);

  out = computeFees(only({ service: 1500 }), R, FREE);
  assert.equal(line(out, 'service').paid, 500);
  assert.equal(line(out, 'service').meta, 8.5); // 500 × 1.7p
  assert.equal(line(out, 'service').markup, 1.7); // 20% of £8.50
  assert.equal(out.yearlyMarkup, 20.4);

  // two numbers: 2,000 free
  out = computeFees(only({ service: 1500, numbers: 2 }), R, FREE);
  assert.equal(line(out, 'service').paid, 0);
  assert.equal(line(out, 'service').free, 1500);
  assert.equal(out.monthlyMarkup, 0);
  out = computeFees(only({ service: 3000, numbers: 2 }), R, FREE);
  assert.equal(line(out, 'service').paid, 1000);
  assert.equal(line(out, 'service').markup, 3.4);

  // a per-message fee applies only to the paid ones
  out = computeFees(only({ service: 1500, perMessageFee: 1 }), R, FREE);
  assert.equal(line(out, 'service').markup, 6.7); // £1.70 markup + 500 × 1p
});

test('the free allowance is for service messages only; other categories are all paid', () => {
  const out = computeFees(only({ marketing: 1000, utility: 1000, authentication: 1000, numbers: 5 }), R, FREE);
  assert.equal(line(out, 'marketing').paid, 1000);
  assert.equal(line(out, 'marketing').meta, 50);
  assert.equal(line(out, 'marketing').markup, 10);
  assert.equal(line(out, 'utility').meta, 17);
  assert.equal(line(out, 'authentication').meta, 17);
  assert.equal(out.monthlyMarkup, 16.8);
});

test('full example: markup %, per-user fees, monthly and yearly totals', () => {
  const out = computeFees(feeInputs({ marketing: 1000, utility: 500, authentication: 0, service: 2500, numbers: 1, markupPct: 20, perMessageFee: 0, users: 3, perUserFee: 10 }), R, FREE);
  assert.equal(out.metaCost, 84); // 50 + 8.50 + 0 + 1,500 × 1.7p
  assert.equal(line(out, 'users').markup, 30);
  assert.equal(out.monthlyMarkup, 46.8); // 20% of £84 + £30
  assert.equal(out.providerCost, 130.8);
  assert.equal(out.yearlyMarkup, 561.6);
  // at cost, no per-user fees: nothing added
  assert.equal(computeFees(feeInputs({ markupPct: 0, perMessageFee: 0, perUserFee: 0 }), R, FREE).monthlyMarkup, 0);
});

test('inputs: junk and negatives fall back to defaults, numbers at least 1, values capped', () => {
  const i = feeInputs({ marketing: '-5', utility: 'abc', service: '1e12', numbers: '0', markupPct: '12.345', users: '2.9', provider: 'Wati<script>' });
  assert.equal(i.marketing, 1000);
  assert.equal(i.utility, 500);
  assert.equal(i.service, 10000000);
  assert.equal(i.numbers, 1);
  assert.equal(i.markupPct, 12.35);
  assert.equal(i.users, 2);
  assert.ok(!/[<>]/.test(i.provider));
});

function captureResend() {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sent.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: 'em_' + sent.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return real(url, opts);
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

test('page: monthly markup straight away; yearly and breakdown only after name + business email; lead saved and emailed', async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = [config.resendApiKey, config.emailFrom, config.supportEmail];
  Object.assign(config, { resendApiKey: 're_test_123', emailFrom: 'Us <hello@example.test>', supportEmail: 'team@example.test' });
  const cap = captureResend();
  const q = 'marketing=1000&utility=500&authentication=0&service=2500&numbers=1&markupPct=20&perMessageFee=0&users=3&perUserFee=10&provider=Wati';
  try {
    const page = await (await fetch(`${base}/whatsapp-fee-checker?${q}`)).text();
    assert.match(page, /<title>WhatsApp fee checker/);
    assert.match(page, /id="fc-monthly">£47</); // £46.80 a month
    const visible = page.replace(/<script>[\s\S]*?<\/script>/g, '');
    assert.ok(!visible.includes('id="fc-yearly"'), 'yearly figure is locked');
    assert.ok(!/£562|561\.60/.test(page), 'no yearly figure anywhere in the page');
    assert.ok(!/Your provider adds<\/th>/.test(visible), 'no breakdown table yet');
    assert.match(page, /id="fc-lead"/);
    assert.match(page, /Business email/);
    assert.match(page, /<input type="checkbox" name="marketingOptIn" value="1" style="[^"]*">/, 'opt-in tickbox is unticked by default');
    assert.match(page, /Switch to [^:<]+: Meta fees at cost, no per-user fees, cancel anytime/);
    assert.match(page, /href="\/signup">Start your free trial</);
    // the embedded calculation is valid JavaScript
    const script = page.match(/<script>\n(\(\(\) => \{[\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(script));
    assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), /\/whatsapp-fee-checker</);

    const post = (body, json = true) => fetch(`${base}/whatsapp-fee-checker`, json
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }
      : { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    const inputs = Object.fromEntries(new URLSearchParams(q));

    const bad = await post({ ...inputs, name: 'Sam', email: 'nope' });
    assert.equal(bad.status, 400);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM fee_checker_leads').get().n, 0);

    const ok = await (await post({ ...inputs, name: 'Sam Patel', email: 'sam@bloomflorist.co.uk', marketingOptIn: false })).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.emailed, true);
    assert.match(ok.html, /id="fc-yearly">£562</);
    assert.match(ok.html, /Per-user fees/);
    assert.match(ok.html, /1,000 free/);
    const row = getDb().prepare("SELECT * FROM fee_checker_leads WHERE email = 'sam@bloomflorist.co.uk'").get();
    assert.equal(row.name, 'Sam Patel');
    assert.equal(row.provider, 'Wati');
    assert.deepEqual([row.numbers, row.marketing_msgs, row.utility_msgs, row.authentication_msgs, row.service_msgs, row.markup_pct, row.per_message_fee_p, row.users, row.per_user_fee], [1, 1000, 500, 0, 2500, 20, 0, 3, 10]);
    assert.deepEqual([row.meta_cost, row.provider_cost, row.monthly_markup, row.yearly_markup], [84, 130.8, 46.8, 561.6]);
    assert.equal(JSON.parse(row.breakdown).length, 5);
    assert.equal(row.marketing_opt_in, 0);
    assert.equal(row.opt_in_text, null);
    assert.equal(row.email_sent, 1);
    const toLead = cap.sent.find((m) => m.to.includes('sam@bloomflorist.co.uk'));
    assert.match(toLead.subject, /£561\.60 a year/);
    assert.match(toLead.text, /Meta fees at cost, no per-user fees, cancel anytime/);
    assert.ok(cap.sent.some((m) => m.to.includes('team@example.test') && /Fee checker lead/.test(m.subject)), 'the team hears about the lead');

    // without JavaScript: the form posts and the page comes back unlocked; ticking the box records consent
    const form = await post({ ...inputs, name: 'Jo', email: 'jo@shop.test', marketingOptIn: '1' }, false);
    assert.equal(form.status, 200);
    const unlocked = (await form.text()).replace(/<script>[\s\S]*?<\/script>/g, '');
    assert.match(unlocked, /id="fc-yearly"/);
    assert.ok(!unlocked.includes('id="fc-lead"'));
    const jo = getDb().prepare("SELECT * FROM fee_checker_leads WHERE email = 'jo@shop.test'").get();
    assert.equal(jo.marketing_opt_in, 1);
    assert.match(jo.opt_in_text, /unsubscribe/);
    assert.ok(jo.opt_in_at);

    // bot trap: result shown, nothing saved
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM fee_checker_leads').get().n;
    assert.equal((await post({ ...inputs, name: 'Bot', email: 'bot@x.test', company_website: 'spam' })).status, 200);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM fee_checker_leads').get().n, n);
  } finally {
    cap.restore();
    [config.resendApiKey, config.emailFrom, config.supportEmail] = saved;
    server.close();
  }
});
