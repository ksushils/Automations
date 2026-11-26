import { test } from 'node:test';
import assert from 'node:assert/strict';
const { figures, guardTimes } = await import('../src/verified.js');
const { SKIP } = await import('../src/instantDemo.js');

test('"8.30 till 3pm" counts 8.30 as a time, so real hours are not removed (bakery)', () => {
  const site = [{ text: 'Visit Us Here | 9 Bath place, Taunton TA1 4ER | Tuesday to Saturday 8.30 till 3pm' }];
  assert.ok(figures(site[0].text).has('8:30'));
  const g = guardTimes('We are open Tuesday to Saturday, 8:30am – 3pm.', site);
  assert.deepEqual(g.blocked, []);
  assert.match(g.answer, /8:30am – 3pm/);
  assert.ok(figures('open 9.30 until 5pm').has('9:30'));
});

test('a lone price like "8.20" is still not read as a time', () => {
  assert.ok(!figures('Haddock 8.20 and chips').has('8:20'));
  assert.ok(!figures('Cod 8.95, till receipt available').has('8:95'));
});

test('privacy / cookie pages with .html or .php, and basket pages, are skipped', () => {
  for (const p of ['/privacy.html', '/privacy-policy.php', '/cookies.htm', '/basket/', '/basket']) assert.ok(SKIP.test(p), p);
  for (const p of ['/menu.html', '/about.html', '/gallery.html', '/blog.php', '/contact']) assert.ok(!SKIP.test(p), p);
});
