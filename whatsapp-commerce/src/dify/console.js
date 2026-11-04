import { config } from '../config.js';

/**
 * Client for the Dify *console* API (the API the Dify web UI uses), so this service can create and
 * update chatbot apps in your Dify automatically. Verified against Dify 1.17.x.
 *
 * Two ways to authenticate (set in .env):
 *  A) Admin API key (recommended, server-to-server):
 *     In Dify's .env set ADMIN_API_KEY_ENABLE=true and ADMIN_API_KEY=<long random>, restart Dify.
 *     Here set DIFY_ADMIN_API_KEY=<same> and DIFY_WORKSPACE_ID=<workspace id>.
 *  B) Email + password of a Dify account that is owner/admin of the workspace:
 *     DIFY_CONSOLE_EMAIL / DIFY_CONSOLE_PASSWORD.
 */
export function consoleConfigured() {
  return !!(config.difyConsoleUrl && ((config.difyAdminApiKey && config.difyWorkspaceId) || (config.difyConsoleEmail && config.difyConsolePassword)));
}

export class DifyConsole {
  constructor({ baseUrl = config.difyConsoleUrl, adminApiKey = config.difyAdminApiKey, workspaceId = config.difyWorkspaceId, email = config.difyConsoleEmail, password = config.difyConsolePassword } = {}) {
    this.base = String(baseUrl || '').replace(/\/$/, '') + '/console/api';
    this.adminApiKey = adminApiKey;
    this.workspaceId = workspaceId;
    this.email = email;
    this.password = password;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  csrf() {
    for (const [k, v] of this.cookies) if (k === 'csrf_token' || k === '__Host-csrf_token') return v;
    return '';
  }

  storeCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async login() {
    if (this.adminApiKey) return;
    if (!this.email || !this.password) throw new Error('Dify console credentials are not configured');
    const res = await fetch(`${this.base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Dify 1.1x expects the password base64-encoded (FieldEncryption.decrypt_field)
      body: JSON.stringify({ email: this.email, password: Buffer.from(this.password, 'utf8').toString('base64'), remember_me: true }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.result !== 'success') throw new Error(`Dify login failed: ${body.message || body.data || res.status}`);
    this.storeCookies(res);
    // Older Dify versions returned tokens in the body instead of cookies
    if (body.data?.access_token) this.bearer = body.data.access_token;
    this.loggedIn = true;
  }

  async request(method, path, body, { retry = true } = {}) {
    if (!this.adminApiKey && !this.loggedIn) await this.login();
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.adminApiKey) {
      headers.Authorization = `Bearer ${this.adminApiKey}`;
      if (this.workspaceId) headers['X-WORKSPACE-ID'] = this.workspaceId;
    } else {
      if (this.cookies.size) headers.Cookie = this.cookieHeader();
      if (this.csrf()) headers['X-CSRF-Token'] = this.csrf();
      if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    }
    const res = await fetch(this.base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (res.status === 401 && retry && !this.adminApiKey) {
      this.loggedIn = false;
      this.cookies.clear();
      return this.request(method, path, body, { retry: false });
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`Dify console ${method} ${path} → ${res.status}: ${data.message || data.error || data.code || text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---- models ----
  async defaultLlm() {
    const d = await this.request('GET', '/workspaces/current/default-model?model_type=llm');
    const m = d?.data;
    return m?.model ? { provider: m.provider?.provider || m.provider, name: m.model } : null;
  }

  async listLlms() {
    const d = await this.request('GET', '/workspaces/current/models/model-types/llm');
    return (d.data || []).flatMap((p) =>
      (p.models || [])
        .filter((m) => !m.status || m.status === 'active')
        .map((m) => ({ provider: p.provider, providerLabel: p.label?.en_US || p.provider, name: m.model, label: m.label?.en_US || m.model })),
    );
  }

  // ---- apps ----
  getApp(id) { return this.request('GET', `/apps/${id}`); }
  createApp({ name, description, mode = 'chat', icon = '🛍️', iconBackground = '#D5F5E3' }) {
    return this.request('POST', '/apps', { name, description: description?.slice(0, 400), mode, icon_type: 'emoji', icon, icon_background: iconBackground });
  }
  updateApp(id, { name, description, icon = '🛍️', iconBackground = '#D5F5E3' }) {
    return this.request('PUT', `/apps/${id}`, { name, description: description?.slice(0, 400), icon_type: 'emoji', icon, icon_background: iconBackground });
  }
  deleteApp(id) { return this.request('DELETE', `/apps/${id}`); }
  saveModelConfig(id, modelConfig) { return this.request('POST', `/apps/${id}/model-config`, modelConfig); }
  async listApiKeys(id) { return (await this.request('GET', `/apps/${id}/api-keys`)).data || []; }
  createApiKey(id) { return this.request('POST', `/apps/${id}/api-keys`); }
}
