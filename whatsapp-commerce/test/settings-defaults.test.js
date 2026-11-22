import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// A yes/no setting the server treats as ON when unset must show as "Yes" in the settings form – otherwise pressing
// Save switches it off without the owner choosing to (it did for lead capture and the abandoned-checkout consent rule).
test('settings form shows code-default-on switches as Yes', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const list = JSON.parse(html.match(/const BOOL_DEFAULT_ON = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  const bools = [...html.matchAll(/\['([\w.]+)', '[^']*', 'bool'\]/g)].map((m) => m[1]);
  const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const onInCode = {
    'leads.enabled': /L\.enabled !== false/.test(src('leads.js')),
    'followUps.enabled': /followUps\?\.enabled !== false/.test(src('routes/admin.js')),
    'ordering.askNote': /askNote !== false/.test(src('bot/engine.js')),
    'notifications.storeTemplates.abandonedCheckout.requireMarketingConsent': /requireMarketingConsent !== false/.test(src('routes/storeWebhooks.js')),
    'bookings.chooseStaff': /chooseStaff !== false/.test(src('bookings.js')),
  };
  for (const [p, on] of Object.entries(onInCode)) {
    assert.ok(on, `${p}: expected the code to treat it as on by default`);
    assert.ok(bools.includes(p), `${p} is a yes/no field in the form`);
    assert.ok(list.includes(p), `${p} must be in BOOL_DEFAULT_ON`);
  }
  for (const p of list) assert.ok(bools.includes(p), `${p} in BOOL_DEFAULT_ON is a form field`);
});
