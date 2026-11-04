import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, say, ids, tenants } from './helpers.js';
import { createApp } from '../src/server.js';
import { listOrders } from '../src/bot/orders.js';

test('agent mode end-to-end: Dify agent searches, adds to cart and checks out via our tools', async () => {
  const app = createApp().listen(0);
  await new Promise((r) => app.once('listening', r));
  const toolsBase = `http://127.0.0.1:${app.address().port}/tools`;
  const t = makeTenant({ ordering: { paymentMethods: ['cod'], fulfilment: ['pickup'] } });
  const toolKey = tenants.rotateToolKey(t.id);

  // Fake Dify agent: behaves like the LLM would, calling the tools with the session token it was given.
  let turn = 0;
  const dify = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', async () => {
      const { inputs } = JSON.parse(b);
      const call = (name, body) => fetch(`${toolsBase}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tool-Key': toolKey }, body: JSON.stringify({ session_token: inputs.session_token, ...body }) }).then((r) => r.json());
      let answer;
      turn++;
      if (turn === 1) {
        const r = await call('search_products', { query: 'mug' });
        answer = `We have the **${r.products[0].title}** for ${r.products[0].price}. Want one?`;
      } else {
        await call('add_to_cart', { product_id: 'mug', quantity: 2 });
        const c = await call('checkout', { fulfilment: 'pickup', payment_method: 'cod', customer_name: 'Sam' });
        answer = `Done! Your order ${c.order} is placed.`;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ event: 'agent_message', answer, conversation_id: 'conv-a' })}\n\ndata: ${JSON.stringify({ event: 'message_end', conversation_id: 'conv-a' })}\n\n`);
    });
  });
  await new Promise((r) => dify.listen(0, r));
  tenants.updateTenantSettings(t.id, { dify: { enabled: true, mode: 'agent', apiKey: 'app-agent', baseUrl: `http://127.0.0.1:${dify.address().port}/v1` } });

  try {
    const wa = '447700900401';
    let r = await say(t, wa, 'got any mugs?');
    assert.equal(r[0].type, 'list', 'agent search results become a tappable list');
    assert.match(r[0].text, /\*White Mug\* for £8\.50/);
    assert.deepEqual(ids(r), ['p:mug']);

    r = await say(t, wa, 'yes two please, I will collect');
    assert.match(r.at(-1).text, /Done! Your order WA-\d+ is placed/);
    const [o] = listOrders(t.id, { waId: wa });
    assert.equal(o.subtotal, 17);
    assert.equal(o.customer_name, 'Sam');
  } finally {
    app.close();
    dify.close();
  }
});
