import express from 'express';
import { authenticateToolKey, getTenant } from '../tenants.js';
import { verifySessionToken } from '../session.js';
import { createSender } from '../whatsapp/cloudApi.js';
import { runTool, TOOL_DEFS } from '../ai/storeTools.js';

/**
 * Store tools for a Dify *Agent* app (import dify/store-tools.openapi.json as a Custom Tool).
 * Auth: header X-Tool-Key (per tenant) + session_token (per customer, injected by us as a Dify input).
 * The tool logic lives in src/ai/storeTools.js and is shared with direct AI mode.
 */
export function toolsRouter() {
  const r = express.Router();
  const names = new Set(TOOL_DEFS.map((t) => t.function.name));

  r.post('/:tool', async (req, res) => {
    const session = verifySessionToken(req.body?.session_token || req.query.session_token);
    if (!session) return res.status(401).json({ error: 'invalid session_token – pass the {{session_token}} input unchanged' });
    if (!authenticateToolKey(session.tenantId, req.get('x-tool-key'))) return res.status(401).json({ error: 'invalid X-Tool-Key' });
    if (!names.has(req.params.tool)) return res.status(404).json({ error: 'unknown tool' });
    const tenant = getTenant(session.tenantId);
    const send = createSender(tenant);
    try {
      const { session_token: _t, ...args } = req.body || {};
      res.json(await runTool({ tenant, waId: session.waId, deliver: (m) => send(session.waId, m).catch(() => {}) }, req.params.tool, args));
    } catch (e) {
      console.error('[tools]', e.message);
      res.status(200).json({ error: e.message });
    }
  });
  return r;
}
