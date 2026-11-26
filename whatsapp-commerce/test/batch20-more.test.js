// Batch 20, part 2: the rest of the round-3 test report (part 1 is batch20-findings.test.js, from the tester)
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant } = await import('./helpers.js');
const { guardContacts, guardRanges } = await import('../src/verified.js');
const { siteServices } = await import('../src/instantDemo.js');
const { nameFromTitle } = await import('../src/knowledge.js');
const { buildPrompt } = await import('../src/dify/provision.js');

const TSE = [{ text: '12a Leys Road, Cambridge CB4 2AT\nCall 01223 516767 or mobile 07730066219 for a free quotation.' }];

test('an invented email is cut from "call … or email us at …" (TSE Electrical)', () => {
  const g = guardContacts('To book or order, you can call us at 01223 516767 or email us at info@tseelectrical.co.uk. What service are you interested in?', TSE);
  assert.deepEqual(g.blocked, ['info@tseelectrical.co.uk']);
  assert.equal(g.answer, 'To book or order, you can call us at 01223 516767. What service are you interested in?');
});

test('a sentence with only an invented contact detail goes, with a note; real ones stay', () => {
  const g = guardContacts('Email us at hello@made-up.co.uk any time! Anything else? 😊', TSE);
  assert.doesNotMatch(g.answer, /made-up/);
  assert.match(g.answer, /can't see that contact detail/);
  const ok = 'Call 01223 516767 or 07730 066219.';
  assert.deepEqual(guardContacts(ok, TSE), { answer: ok, blocked: [] });
  assert.deepEqual(guardContacts('Call +44 1223 516767.', TSE).blocked, [], '+44 form of a known number');
  assert.deepEqual(guardContacts('Ring 07961 169 681.', [{ text: 'Ring us 07961169681' }]).blocked, [], 'spacing differs');
  assert.deepEqual(guardContacts('Email bob@x.co.uk', [{ text: '' }], { customerText: 'my email is bob@x.co.uk' }).blocked, [], 'the customer gave it');
});

test('a "from £X to £Y" range the menu does not state is removed (Jalsa Conwy); a stated one stays', () => {
  const menu = [{ text: 'Popadom £1.00\nChapati £2.00\nKing Prawn Bhuna £16.00\nMixed Grill £17.00\nTandoori King Prawns £17.00' }];
  const a = guardRanges("Could you let me know what you're interested in? We have a variety of dishes with prices ranging from £2.00 for a Chapati to £16.00 for a King Prawn dish. What type of dish are you looking for? 😊\n[CHOICES: Chapati | King Prawn]", menu);
  assert.deepEqual(a.blocked, ['£2.00–£16.00']);
  assert.doesNotMatch(a.answer, /ranging/);
  assert.match(a.answer, /\n\[CHOICES: Chapati \| King Prawn\]$/);
  assert.deepEqual(guardRanges('We offer dishes starting from £1.00 for popadoms up to £16.00 for king prawn dishes.', menu).blocked, ['£1.00–£16.00']);
  const stated = 'Cleans cost from £70 to £150.';
  assert.deepEqual(guardRanges(stated, [{ text: 'Cleans from £70 to £150 depending on size' }]), { answer: stated, blocked: [] });
  assert.deepEqual(guardRanges('Lessons from £38 per hour.', menu).blocked, []);
});

test("demo booking services: only the trade's sample services the site mentions (no gym \"Personal training taster\")", () => {
  const gym = [{ name: 'Free trial session', minutes: 60 }, { name: 'Personal training taster', minutes: 45 }];
  assert.deepEqual(siteServices(gym, 'Free 2 week gym trial. Boxing classes.').map((s) => s.name), ['Free trial session']);
  assert.deepEqual(siteServices(gym, 'Boxing classes only.'), [{ name: 'Appointment', minutes: 30 }]);
  assert.deepEqual(siteServices([{ name: 'Gas safety check (CP12)', minutes: 45 }], 'Landlord gas safety check from £70').map((s) => s.name), ['Gas safety check (CP12)']);
});

test('a title that is a question or a slogan is not used as the business name', () => {
  assert.equal(nameFromTitle('Looking for things to do in York?', 'www.yorktour.com'), 'Yorktour');
  assert.equal(nameFromTitle('Welcome to Viva Hair 134 | Exeter', 'vivahair134.co.uk'), 'Viva Hair 134');
  assert.equal(nameFromTitle('Heating & Plumbing Stourbridge', 'www.maparkes.co.uk'), 'Heating & Plumbing Stourbridge');
  assert.equal(nameFromTitle('Book a table | Jalsa Conwy', 'jalsaconwy.co.uk'), 'Jalsa Conwy');
  assert.equal(nameFromTitle('YORKTOUR can help.', 'www.yorktour.com'), 'Yorktour');
  assert.equal(nameFromTitle('PCs & Components', 'www.overclockers.co.uk'), 'PCs & Components');
});

test('blog pages with an extension (blog.php, blogpost.php) are read last too', async () => {
  const { lastResortPaths } = await import('../src/knowledge.js');
  assert.deepEqual(lastResortPaths(['/', '/bookings.php', '/blog.php', '/blogpost.php', '/gallery.php', '/disabled.php']), ['/blog.php', '/blogpost.php', '/gallery.php']);
});

test('prompt: example prices instead of "see our website", no made-up ranges, contact methods only with details', () => {
  const p = buildPrompt(makeTenant({ store: { type: 'none' } }));
  assert.match(p, /give 2–3 real examples with their prices/);
  assert.match(p, /Never make up a "from £X to £Y"/);
  assert.match(p, /If the information has no email, never write one/);
});
