import { test } from 'node:test';
import assert from 'node:assert/strict';
const { htmlToText, footerFacts } = await import('../src/knowledge.js');
const { guardTimes } = await import('../src/verified.js');
const { TRADES } = await import('../src/trades.js');

test('footer hours split over <dt>/<dd> are kept with their day (florist footer)', () => {
  const html = '<html><body><main><p>Hand-tied bouquets.</p></main><footer><p>Shop open and phones answered</p><dl class="hours"><dt>Monday</dt><dd>10am - 4pm</dd><dt>Tue - Sat</dt><dd>9am - 4pm</dd><dt>Sunday</dt><dd>11am - 2pm</dd></dl></footer></body></html>';
  const { text } = htmlToText(html);
  assert.match(text, /Monday: 10am - 4pm/);
  assert.match(text, /Tue - Sat: 9am - 4pm/);
  assert.match(text, /Sunday: 11am - 2pm/);
});

test('footer hours split by <br> and separate paragraphs are kept (vet footer)', () => {
  const facts = footerFacts('<footer><h4>Hours</h4><p>Monday — Friday<br>8:30 am — 6:30 pm</p><p>Saturday</p><p>10:00 am — 12:00 pm</p><p><a href="tel:01572800001">Telephone 01572800001</a></p></footer>');
  assert.ok(facts.includes('Monday — Friday: 8:30 am — 6:30 pm'), facts.join(' / '));
  assert.ok(facts.includes('Saturday: 10:00 am — 12:00 pm'), facts.join(' / '));
  assert.ok(facts.some((f) => f.includes('01572800001')));
});

test('a day line is not glued to an unrelated line without a time', () => {
  const facts = footerFacts('<footer><p>Open Sunday</p><p>Call 01234 567890</p></footer>');
  assert.ok(!facts.some((f) => /Sunday: Call/.test(f)), facts.join(' / '));
});

test('&middot; and &starf; are decoded in page text', () => {
  const { text } = htmlToText('<main><p>Skin fades £21 &middot; kids £16</p><p>5.0 &starf;&starf;&starf;&starf;&starf;</p></main>');
  assert.match(text, /£21 · kids £16/);
  assert.match(text, /★★★★★/);
  assert.doesNotMatch(text, /&middot;|&starf;/);
});

test('shop rules no longer carry a "14 days" figure that whitelists an invented returns period', () => {
  assert.doesNotMatch(TRADES.shop.instructions, /\b14 days?\b/);
  // with the old rule text in the "extra" context the guard let "14 days" through; with the new text it is removed
  const answer = 'Our return policy allows most online purchases to be returned within 14 days of delivery.';
  const sources = [{ text: 'Same day delivery for orders placed before 12pm. Free collection in store.' }];
  const g = guardTimes(answer, sources, { extra: TRADES.shop.instructions });
  assert.deepEqual(g.blocked, ['14 day']);
  assert.doesNotMatch(g.answer, /14 days/);
});
