import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTenant, tenants } from './helpers.js';
import { DifyConsole } from '../src/dify/console.js';
import { provisionDifyBot, buildPrompt } from '../src/dify/provision.js';

/** Minimal fake of the Dify 1.17 console API. */
function fakeDify({ requireCsrf = true } = {}) {
  const state = { apps: {}, keys: {}, configs: {}, logins: 0, calls: [] };
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      const send = (code, data, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
      const url = req.url.replace('/console/api', '');
      state.calls.push(`${req.method} ${url}`);
      if (url === '/login') {
        state.logins++;
        if (body.email !== 'owner@shop.com' || Buffer.from(body.password, 'base64').toString() !== 'pa55') return send(401, { message: 'Invalid email or password' });
        return send(200, { result: 'success' }, { 'Set-Cookie': ['access_token=AT; Path=/; HttpOnly', 'csrf_token=CSRF1; Path=/', 'refresh_token=RT; Path=/; HttpOnly'] });
      }
      const admin = req.headers.authorization === 'Bearer ADMINKEY' && req.headers['x-workspace-id'] === 'ws1';
      const cookieOk = (req.headers.cookie || '').includes('access_token=AT');
      if (!admin && !cookieOk) return send(401, { message: 'Unauthorized' });
      if (!admin && requireCsrf && req.method !== 'GET' && req.headers['x-csrf-token'] !== 'CSRF1') return send(401, { message: 'CSRF token is missing or invalid.' });
      let m;
      if (url.startsWith('/workspaces/current/default-model')) return send(200, { data: { model: 'gpt-4o-mini', provider: { provider: 'langgenius/openai/openai' } } });
      if (url === '/workspaces/current/models/model-types/llm') return send(200, { data: [{ provider: 'langgenius/openai/openai', label: { en_US: 'OpenAI' }, models: [{ model: 'gpt-4o-mini', label: { en_US: 'gpt-4o-mini' }, status: 'active' }] }] });
      if (url === '/apps' && req.method === 'POST') { const id = 'app-' + (Object.keys(state.apps).length + 1); state.apps[id] = body; return send(201, { id, ...body }); }
      if ((m = url.match(/^\/apps\/([^/]+)$/))) {
        if (!state.apps[m[1]]) return send(404, { message: 'App not found' });
        if (req.method === 'PUT') state.apps[m[1]] = { ...state.apps[m[1]], ...body };
        return send(200, { id: m[1], ...state.apps[m[1]] });
      }
      if ((m = url.match(/^\/apps\/([^/]+)\/model-config$/))) { state.configs[m[1]] = body; return send(200, { result: 'success' }); }
      if ((m = url.match(/^\/apps\/([^/]+)\/api-keys$/))) {
        if (req.method === 'GET') return send(200, { data: state.keys[m[1]] ? [{ token: state.keys[m[1]] }] : [] });
        state.keys[m[1]] = 'app-KEY-' + m[1];
        return send(201, { token: state.keys[m[1]] });
      }
      send(404, { message: 'not found ' + url });
    });
  });
  return { server, state };
}

const listen = (server) => new Promise((r) => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)));

test('creates the chatbot in Dify with email/password login, then updates it in place', async () => {
  const { server, state } = fakeDify();
  const base = await listen(server);
  const t = makeTenant({ ai: { assistantName: 'Mia', tone: 'professional', faq: 'Returns accepted within 30 days.', about: 'Organic cotton clothing' } });
  const client = Object.assign(new DifyConsole({ baseUrl: base, email: 'owner@shop.com', password: 'pa55' }), { injected: true });

  const r1 = await provisionDifyBot(t.id, { client });
  assert.equal(r1.created, true);
  assert.deepEqual(r1.model, { provider: 'langgenius/openai/openai', name: 'gpt-4o-mini' });
  const cfg = state.configs[r1.appId];
  assert.equal(cfg.model.name, 'gpt-4o-mini');
  assert.match(cfg.pre_prompt, /You are Mia for \{\{store_name\}\}/);
  assert.match(cfg.pre_prompt, /Returns accepted within 30 days/);
  assert.match(cfg.pre_prompt, /no emojis/);
  assert.deepEqual(cfg.user_input_form.map((f) => f['text-input'].variable), ['store_name', 'customer_name', 'currency', 'session_token']);

  let s = tenants.getTenant(t.id).settings.dify;
  assert.equal(s.enabled, true);
  assert.equal(s.managed, true);
  assert.equal(s.apiKey, 'app-KEY-' + r1.appId);
  assert.equal(s.appId, r1.appId);

  // Second run updates the same app and keeps the key
  tenants.updateTenantSettings(t.id, { ai: { faq: 'Free returns.' } });
  const r2 = await provisionDifyBot(t.id, { client });
  assert.equal(r2.created, false);
  assert.equal(r2.appId, r1.appId);
  assert.equal(Object.keys(state.apps).length, 1);
  assert.match(state.configs[r1.appId].pre_prompt, /Free returns/);
  assert.equal(state.logins, 1);
  server.close();
});

test('admin API key mode, chosen model, and re-creation when app was deleted in Dify', async () => {
  const { server, state } = fakeDify();
  const base = await listen(server);
  const t = makeTenant({ ai: { model: 'langgenius/openrouter/openrouter|anthropic/claude-sonnet' }, dify: { appId: 'app-gone', apiKey: 'old' } });
  const client = Object.assign(new DifyConsole({ baseUrl: base, adminApiKey: 'ADMINKEY', workspaceId: 'ws1' }), { injected: true });
  const r = await provisionDifyBot(t.id, { client });
  assert.equal(r.created, true);
  assert.equal(state.configs[r.appId].model.provider, 'langgenius/openrouter/openrouter');
  assert.equal(tenants.getTenant(t.id).settings.dify.apiKey, 'app-KEY-' + r.appId);
  assert.equal(state.logins, 0);
  server.close();
});

test('wrong Dify password gives a clear error', async () => {
  const { server } = fakeDify();
  const base = await listen(server);
  const t = makeTenant();
  const client = Object.assign(new DifyConsole({ baseUrl: base, email: 'owner@shop.com', password: 'nope' }), { injected: true });
  await assert.rejects(provisionDifyBot(t.id, { client }), /Dify login failed/);
  server.close();
});

test('prompt includes shop facts from ordering settings', () => {
  const t = makeTenant();
  const p = buildPrompt(t);
  assert.match(p, /Delivery fee £3\.50, free over £50\.00/);
  assert.match(p, /\[HANDOVER\]/);
});

test('agent mode: creates custom tool with fresh tool key + agent app with all store tools', async () => {
  const { config } = await import('../src/config.js');
  const prevUrl = config.publicUrl;
  config.publicUrl = 'https://wa.example.com';
  const { server, state } = fakeDify();
  state.providers = {};
  // extend fake with tool-provider endpoints
  const orig = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const url = req.url.replace('/console/api', '');
    if (!url.startsWith('/workspaces/current/tool-provider/api') && url !== '/workspaces/current/tools/api') return orig(req, res);
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      const send = (code, d) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (url.startsWith('/workspaces/current/tool-provider/api/get')) {
        const name = new URL('http://x' + url).searchParams.get('provider');
        return state.providers[name] ? send(200, state.providers[name]) : send(400, { message: `you have not added provider ${name}` });
      }
      if (url.endsWith('/add')) { state.providers[body.provider] = { ...body, id: 'prov-uuid-1' }; return send(200, { result: 'success' }); }
      if (url.endsWith('/update')) { state.providers[body.provider] = { ...body, id: 'prov-uuid-1' }; state.updated = true; return send(200, { result: 'success' }); }
      if (url === '/workspaces/current/tools/api') return send(200, Object.values(state.providers).map((p) => ({ id: p.id, name: p.provider })));
      send(404, {});
    });
  });
  const base = await listen(server);
  const client = Object.assign(new DifyConsole({ baseUrl: base, adminApiKey: 'ADMINKEY', workspaceId: 'ws1' }), { injected: true });
  const t = makeTenant();

  // assist first, then switch to agent → a second (agent-chat) app is created
  const a = await provisionDifyBot(t.id, { client });
  const r = await provisionDifyBot(t.id, { client, mode: 'agent' });
  assert.notEqual(r.appId, a.appId);
  assert.equal(state.apps[r.appId].mode, 'agent-chat');
  const prov = Object.values(state.providers)[0];
  assert.equal(prov.credentials.api_key_header, 'X-Tool-Key');
  assert.equal(JSON.parse(prov.schema).servers[0].url, 'https://wa.example.com/tools');
  // the pushed tool key really authenticates against our tools API
  assert.ok(tenants.authenticateToolKey(t.id, prov.credentials.api_key_value));
  const cfg = state.configs[r.appId];
  assert.equal(cfg.agent_mode.enabled, true);
  assert.equal(cfg.agent_mode.strategy, 'function_call');
  assert.deepEqual(cfg.agent_mode.tools.map((x) => x.tool_name).sort(), ['add_to_cart', 'checkout', 'get_product', 'handover', 'list_categories', 'order_status', 'remove_from_cart', 'search_products', 'view_cart']);
  assert.ok(cfg.agent_mode.tools.every((x) => x.provider_id === 'prov-uuid-1' && x.provider_type === 'api'));
  assert.match(cfg.pre_prompt, /session_token = "\{\{session_token\}\}"/);
  assert.doesNotMatch(cfg.pre_prompt, /STORE CONTEXT/);
  let s = tenants.getTenant(t.id).settings.dify;
  assert.equal(s.mode, 'agent');
  assert.equal(s.appId, r.appId);
  assert.equal(s.apiKey, 'app-KEY-' + r.appId);

  // re-sync updates provider + same agent app; switching back reuses the assist app
  const r2 = await provisionDifyBot(t.id, { client });
  assert.equal(r2.appId, r.appId);
  assert.ok(state.updated);
  const back = await provisionDifyBot(t.id, { client, mode: 'assist' });
  assert.equal(back.appId, a.appId);
  assert.equal(tenants.getTenant(t.id).settings.dify.apiKey, 'app-KEY-' + a.appId);
  server.close();
  config.publicUrl = prevUrl;
});

test('agent mode refuses a non-HTTPS public URL with a clear message', async () => {
  const { server } = fakeDify();
  const base = await listen(server);
  const client = Object.assign(new DifyConsole({ baseUrl: base, adminApiKey: 'ADMINKEY', workspaceId: 'ws1' }), { injected: true });
  const t = makeTenant();
  await assert.rejects(provisionDifyBot(t.id, { client, mode: 'agent' }), /public HTTPS URL/);
  server.close();
});
