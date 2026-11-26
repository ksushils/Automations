// Batch 19, part 2: the rest of the round-2 test report (part 1 is batch19-findings.test.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant } = await import('./helpers.js');
const { htmlToText, tidyPriceRows, lastResortPaths } = await import('../src/knowledge.js');
const { guardPlaces, guardTimes, checkAnswer, keepVat } = await import('../src/verified.js');
const { groundedChoices } = await import('../src/bot/engine.js');
const { shopFactsOnly } = await import('../src/ai/direct.js');
const { buildPrompt } = await import('../src/dify/provision.js');
const { guessTrade } = await import('../src/trades.js');

const SHOPIFY_CARD = (name, price) => `<li><div class="card__information"><h3 class="card__heading"><a href="/p">${name}</a></h3><div class="price"><div class="price__container"><div class="price__regular"><span class="visually-hidden">Regular price</span><span class="price-item">${price} GBP</span></div><div class="price__sale"><span class="visually-hidden">Regular price</span><span><s>£0.00 GBP</s></span><span class="visually-hidden">Sale price</span><span class="price-item">${price} GBP</span></div><small class="unit-price caption hidden"><span class="visually-hidden">Unit price</span><span><span></span><span>/</span><span>&nbsp;per&nbsp;</span><span></span></span></small></div></div></div></li>`;

test('Shopify listing prices sit on the product line, once, without "Regular price £0.00 GBP" (Elsie & Tom wax melts)', () => {
  const { text } = htmlToText(`<main><h1>Wax Melts</h1><ul>${SHOPIFY_CARD('Wax Melt Mini Gift Box', 'From £10.00')}${SHOPIFY_CARD('Ceramic Wax Burner', '£12.00')}</ul></main>`);
  assert.match(text, /Wax Melt Mini Gift Box – From £10\.00/);
  assert.match(text, /Ceramic Wax Burner – £12\.00/);
  assert.doesNotMatch(text, /Regular price|Sale price|£0\.00|GBP|Unit price/);
  // ordinary price lists are left as they were
  assert.equal(tidyPriceRows('Skin fade £21\nKids cut £16'), 'Skin fade £21\nKids cut £16');
  assert.equal(tidyPriceRows('Standard haircut\n£19'), 'Standard haircut – £19');
});

test('near-identical area pages (after the first 2) and blog pages are read last', () => {
  const later = lastResortPaths(['/', '/pricing.php', '/kingswinford-heating-plumbing', '/lye-heating-plumbing', '/pedmore-heating-plumbing', '/stourbridge-heating-plumbing', '/boiler-servicing', '/boiler-repair', '/contact', '/blog']);
  assert.deepEqual(later, ['/pedmore-heating-plumbing', '/stourbridge-heating-plumbing', '/blog']);
  assert.deepEqual(lastResortPaths(['/driving-lessons-benton', '/driving-lessons-gosforth', '/driving-lessons-newcastle-upon-tyne', '/prices.html']), ['/driving-lessons-newcastle-upon-tyne']);
  assert.deepEqual(lastResortPaths(['/services/gas-safety-certificate', '/services/boiler', '/about']), []);
});

test('a town the information never names is taken out of "based in…" (Elsie & Tom: "Ipswich, Suffolk")', () => {
  const g = guardPlaces("We're based in Ipswich, Suffolk, UK! You can email hello@elsieandtom.co.uk.", [{ text: 'Handmade in Suffolk, UK.' }]);
  assert.deepEqual(g.blocked, ['Ipswich']);
  assert.equal(g.answer, "We're based in Suffolk, UK! You can email hello@elsieandtom.co.uk.");
  const none = guardPlaces("We're based in Leeds! Contact us any time.\n[CHOICES: Email | Phone]", [{ text: 'Contact us by email.' }]);
  assert.match(none.answer, /can't see our exact location/);
  assert.match(none.answer, /\n\[CHOICES: Email \| Phone\]$/);
  assert.doesNotMatch(none.answer, /Leeds/);
  for (const [a, src] of [["We're based at Weyhill, just outside Andover.", 'Weyhill, Andover SP11'], ["We're based in Newcastle upon Tyne.", 'Benton, Newcastle upon Tyne, NE12 9SL'], ["We're located in Oakham, Rutland.", 'Oakham, Rutland LE15']]) {
    assert.deepEqual(guardPlaces(a, [{ text: src }]), { answer: a, blocked: [] }, a);
  }
});

test('buttons must be grounded: no "Yoga class" at a boxing gym, no "Is it £50?" after "it\'s £50"', () => {
  const gym = 'Boxing classes, free 2 week gym trial, teens boxing programme, memberships.';
  assert.deepEqual(groundedChoices(['Free trial', 'Yoga class', 'HIIT class'], { answer: 'Type *book* to pick a time.', known: gym }), []);
  assert.deepEqual(groundedChoices(['Free trial', 'Teens boxing', 'Yoga class'], { answer: 'Which one?', known: gym }), ['Free trial', 'Teens boxing']);
  const oven = 'Yes, we offer oven cleaning! The service is £50 and usually takes around 2.5 hours.';
  assert.deepEqual(groundedChoices(['Yes, book now', 'How long is it?', 'Is it £50?'], { answer: oven, known: oven }), []);
  assert.deepEqual(groundedChoices(['📞 Call me back', '📩 Email me details', '💬 Ask more'], { answer: 'x', known: '' }), ['📞 Call me back', '📩 Email me details', '💬 Ask more']);
  assert.deepEqual(groundedChoices(['Andover', 'Winchester'], { answer: 'Where to?', known: 'We deliver to Andover and Winchester.' }), ['Andover', 'Winchester']);
});

test("the guards only count the shop's own facts from the prompt, not the trade rules' example figures", () => {
  const t = makeTenant({ store: { type: 'none' } });
  t.settings.ai = { ...(t.settings.ai || {}), tradeRules: 'Under UK law most purchases can be returned within 14 days.', about: 'Florist in Sheffield, open 9am–5:30pm.' };
  const facts = shopFactsOnly(buildPrompt(t));
  assert.doesNotMatch(facts, /14 days/);
  assert.match(facts, /Florist in Sheffield/);
  assert.match(facts, /Shop facts:/);
  const g = guardTimes('Most purchases can be returned within 14 days of delivery.', [{ text: 'Free local delivery.' }], { extra: facts });
  assert.deepEqual(g.blocked, ['14 day']);
});

test('prompt: give the real way to book first, phone-line hours, price qualifiers, no added towns', () => {
  const p = buildPrompt(makeTenant({ store: { type: 'none' } }));
  assert.match(p, /give the real way first/);
  assert.match(p, /hours of a phone line or office/);
  assert.match(p, /otherwise just call them our opening hours/);
  assert.match(p, /\+VAT/);
  assert.match(p, /Never add a town/);
});

test('checker: figures the customer typed, "£6.20 or 6.85" and honest "can\'t see" replies are not flagged', () => {
  const trap = checkAnswer("I can't see a 50% student discount. Shall I check with the team?", [{ text: 'Haircuts £19.', doc: 'Prices' }], { customerText: 'Do you offer a student discount of 50% on Sundays?' });
  assert.deepEqual(trap.unsupported, []);
  assert.ok(!trap.flags.includes('weak_support'), trap.flags.join());
  const pair = checkAnswer('Our sandwiches are £6.20 or £6.85.', [{ text: 'Takeaway sandwiches £6.20 or 6.85', doc: 'Sandwiches' }]);
  assert.deepEqual(pair.unsupported, []);
});

test('"+VAT" goes back after a price the site always gives with +VAT (TSE: EV chargers from £704.50+vat)', () => {
  const src = [{ text: 'Sync EV 7.4kw charger + installation from £704.50+vat subject to survey\nEICR 1 & 2 bedroom flat from £120.00\nHive controls from £248.00 + VAT' }];
  const g = keepVat('EICR inspections start from £120.00, and EV chargers start from £704.50. Hive from £248.00 + VAT.', src);
  assert.equal(g.answer, 'EICR inspections start from £120.00, and EV chargers start from £704.50 + VAT. Hive from £248.00 + VAT.');
  assert.deepEqual(g.added, ['£704.50']);
  assert.deepEqual(keepVat('A skin fade is £21.', [{ text: 'Skin fade £21' }]), { answer: 'A skin fade is £21.', added: [] });
});

test('the time-guard note goes before a closing question, not after it', () => {
  const g = guardTimes("We're open 9am to 6pm. Would you like me to check with the team? 😊", [{ text: 'Call 07545 870581.' }]);
  assert.match(g.answer, /won't guess – the team can confirm them for you\. Would you like me to check with the team\? 😊$/);
});

test('florists get the shop trade', () => {
  assert.equal(guessTrade('The Petal Boutique – hand-tied bouquets and wedding flowers in Andover'), 'shop');
  assert.equal(guessTrade('Flourish Florists Sheffield'), 'shop');
});
