import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/*
 * Simple owner menu (R4). The dashboard's grouping rules live in public/index.html; they are pulled out and run here:
 * every page stays reachable, pages that don't fit the business are hidden, staff only see their pages.
 */
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const src = html.match(/const TABS = [\s\S]*?\n(?=const NAV_GROUPS)/)[0] + html.match(/const NAV_GROUPS = [\s\S]*?\n}\n/)[0];
const { TABS, STAFF_TABS, NAV_GROUPS, navGroups } = new Function(`${src}; return { TABS, STAFF_TABS, NAV_GROUPS, navGroups };`)();
const all = TABS.map(([k]) => k);
const flat = (gs) => gs.flatMap((g) => g.tabs.map(([k]) => k));

test('simple menu: every dashboard page belongs to exactly one group', () => {
  const grouped = NAV_GROUPS.flatMap(([, , tabs]) => tabs.map(([k]) => k));
  assert.deepEqual([...grouped].sort(), [...all].sort());
  assert.equal(new Set(grouped).size, grouped.length);
});

test('simple menu: a plumber sees no orders or catalogue; a shop sees orders first and no bookings unless switched on', () => {
  const plumber = navGroups({ settings: { store: { type: 'none' }, trade: 'plumber' } }, all, 'overview');
  assert.ok(!flat(plumber).includes('orders') && !flat(plumber).includes('catalogue'));
  assert.equal(plumber.find((g) => g.key === 'work').label, 'Bookings & quotes');
  const shop = navGroups({ settings: { store: { type: 'shopify' } } }, all, 'overview');
  const work = shop.find((g) => g.key === 'work');
  assert.equal(work.label, 'Orders & quotes');
  assert.deepEqual(work.tabs.map(([k]) => k), ['orders', 'quotes']);
  assert.ok(flat(shop).includes('catalogue'));
  const both = navGroups({ settings: { store: { type: 'manual' }, bookings: { enabled: true } } }, all, 'overview').find((g) => g.key === 'work');
  assert.equal(both.label, 'Orders & bookings');
  assert.deepEqual(both.tabs.map(([k]) => k), ['orders', 'bookings', 'quotes']);
});

test('simple menu: a hidden page you are already on (e.g. from a guide link) still shows', () => {
  assert.ok(flat(navGroups({ settings: { store: { type: 'none' } } }, all, 'orders')).includes('orders'));
});

test('simple menu: staff only see the pages staff may open; empty groups disappear', () => {
  const staff = navGroups({ settings: { store: { type: 'none' } } }, all.filter((k) => STAFF_TABS.has(k)), 'overview');
  assert.ok(flat(staff).every((k) => STAFF_TABS.has(k)));
  assert.ok(!staff.some((g) => g.key === 'admin' || g.key === 'grow'));
  assert.ok(staff.every((g) => g.tabs.length));
});
