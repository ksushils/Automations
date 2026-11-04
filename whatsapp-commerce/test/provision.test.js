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
