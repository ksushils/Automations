import { test } from 'node:test';
import assert from 'node:assert/strict';
const { makeTenant, say, ids } = await import('./helpers.js');

const menu = (options, extra = {}) => ({ welcomeMenu: { enabled: true, intro: 'Thanks, are you looking to:', options, ...extra } });

test('welcome menu: 4–10 options show as a list after the welcome, each option does its job', async () => {
  const t = makeTenant(menu([
    { label: '🛍️ Browse products', action: 'browse' },
    { label: '📦 Track my order', action: 'status' },
    { label: '🕒 Opening hours', action: 'answer', value: 'We are open Mon–Sat, 9am to 5pm.' },
    { label: '🌐 Size guide', action: 'link', value: 'https://shop.test/size-guide' },
    { label: '🙋 Talk to a person', action: 'human' },
    { label: 'Broken – no answer', action: 'answer', value: '' }, // invalid: dropped
    { label: 'Bad link', action: 'link', value: 'javascript:alert(1)' }, // invalid: dropped
  ]));
  const wa = '447700914001';
  let r = await say(t, wa, 'hi');
  const list = r.find((m) => m.type === 'list');
  assert.ok(list, JSON.stringify(r));
  assert.match(list.text, /Thanks, are you looking to:/);
  assert.deepEqual(ids([list]), ['wm:0', 'wm:1', 'wm:2', 'wm:3', 'wm:4']);
  r = await say(t, wa, { action: 'wm:2' });
  assert.equal(r[0].text, 'We are open Mon–Sat, 9am to 5pm.');
  r = await say(t, wa, { action: 'wm:3' });
  assert.equal(r[0].type, 'cta');
  assert.equal(r[0].url, 'https://shop.test/size-guide');
  r = await say(t, wa, { action: 'wm:0' });
  assert.ok(ids(r).some((id) => id.startsWith('cat:')), 'browse shows categories');
  r = await say(t, wa, 'menu');
  assert.ok(r.some((m) => m.type === 'list' && /looking to/.test(m.text)));
  r = await say(t, wa, { action: 'wm:4' });
  assert.match(r.map((m) => m.text).join(' '), /member of our team/);
});

test('welcome menu: up to 3 options are buttons; switched off = the standard menu', async () => {
  const t = makeTenant(menu([{ label: '📦 Track my order', action: 'status' }, { label: '🙋 Talk to a person', action: 'human' }]));
  let r = await say(t, '447700914002', 'hi');
  const b = r.find((m) => m.type === 'buttons' && /looking to/.test(m.text));
  assert.deepEqual(b.buttons.map((x) => x.id), ['wm:0', 'wm:1']);
  const off = makeTenant(menu([{ label: 'X', action: 'human' }], { enabled: false }));
  r = await say(off, '447700914003', 'hi');
  assert.ok(ids(r).includes('browse'), 'standard menu');
});
