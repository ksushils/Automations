import { getDb, json } from '../db.js';

/**
 * No-code automations ("flows"): keyword-triggered sequences of steps.
 *
 * triggers: { keywords: ["price list", "offer"], match: "exact" | "contains", welcome: false, adIds: ["120…"] }
 * Flows are a graph drawn on the canvas builder: every step has an `id`, an optional `next` (id of the following
 * step) and canvas position `x`/`y`. If `next` is missing the following array item runs (simple lists still work).
 * Button / list-row `goto` and goto `step` take a step id (or a legacy 1-based number).
 * steps:
 *   { type: "message", text, image?, buttons?: [{ title, goto? }] }   – buttons wait for a tap
 *   { type: "question", text, save: "email", validate?: "any|email|number|phone" } – waits for a typed answer
 *   { type: "tag", add?: [], remove?: [] }
 *   { type: "delay", minutes }                                       – continues later (inside the 24h window)
 *   { type: "webhook", url }                                         – POSTs the contact + answers (CRM, Sheets, n8n…)
 *   { type: "handover", text? }                                      – passes to a human
 *   { type: "action", action: "menu|browse|cart|checkout|status" }   – hands over to the shop bot
 *   { type: "list", text, button, rows: [{ title, description?, goto? }] }   – list menu, waits for a tap
 *   { type: "product", productId }                                   – product card from the store (hands over to shop bot)
 *   { type: "products", productIds?: [], category?, text? }          – multi-product list from the store
 *   { type: "template", name, language? }                            – approved template (works outside 24h)
 *   { type: "form", text, flowId, cta?, screen? }                    – WhatsApp Flows form; answers saved to the contact
 *   { type: "goto", step: "s3" }  { type: "end" }
 * Text supports {{name}}, {{phone}} and {{attr.key}}.
 */

const MAX_STEPS_PER_RUN = 25;

const mapFlow = (r) => r && { id: r.id, tenantId: r.tenant_id, name: r.name, active: !!r.active, triggers: json(r.triggers, {}), steps: json(r.steps, []), runs: r.runs, updatedAt: r.updated_at };

export const listFlows = (tenantId) => getDb().prepare('SELECT * FROM flows WHERE tenant_id = ? ORDER BY id').all(tenantId).map(mapFlow);
export const getFlow = (tenantId, id) => mapFlow(getDb().prepare('SELECT * FROM flows WHERE tenant_id = ? AND id = ?').get(tenantId, Number(id)));
export const deleteFlow = (tenantId, id) => getDb().prepare('DELETE FROM flows WHERE tenant_id = ? AND id = ?').run(tenantId, Number(id));

const STEP_TYPES = new Set(['form', 'message', 'question', 'tag', 'delay', 'webhook', 'handover', 'action', 'goto', 'end', 'list', 'product', 'products', 'template']);

/** Resolve a step reference (id, or legacy 1-based number) to an array index; -1 if missing. */
export function stepIndex(steps, ref) {
  if (ref === undefined || ref === null || ref === '') return -1;
  const byId = steps.findIndex((s) => s.id !== undefined && String(s.id) === String(ref));
  if (byId >= 0) return byId;
  const n = Number(ref);
  return Number.isInteger(n) && n >= 1 && n <= steps.length ? n - 1 : -1;
}

const nextIndex = (steps, i) => (steps[i].next !== undefined && steps[i].next !== null && steps[i].next !== '' ? stepIndex(steps, steps[i].next) : i + 1 < steps.length ? i + 1 : -1);

export function validateFlow(f) {
  const errors = [];
  if (!f.name) errors.push('name is required');
  if (!Array.isArray(f.steps) || !f.steps.length) errors.push('add at least one step');
  if (f.triggers?.start && stepIndex(f.steps || [], f.triggers.start) < 0) errors.push('the Flow start is linked to a missing step');
  const ids = (f.steps || []).map((s) => s.id).filter((x) => x !== undefined);
  if (new Set(ids).size !== ids.length) errors.push('duplicate step ids');
  (f.steps || []).forEach((s, i) => {
    const n = i + 1;
    if (!STEP_TYPES.has(s.type)) errors.push(`step ${n}: unknown type "${s.type}"`);
    if (['message', 'question'].includes(s.type) && !s.text) errors.push(`step ${n}: text is required`);
    if (s.type === 'question' && !s.save) errors.push(`step ${n}: choose where to save the answer`);
    if (s.type === 'message' && (s.buttons || []).length > 3) errors.push(`step ${n}: max 3 buttons`);
    if (s.type === 'list' && !(s.rows || []).length) errors.push(`step ${n}: add at least one list row`);
    if (s.type === 'list' && (s.rows || []).length > 10) errors.push(`step ${n}: max 10 list rows`);
    if (s.type === 'template' && !s.name) errors.push(`step ${n}: template name required`);
    if (s.type === 'form' && !s.flowId) errors.push(`step ${n}: WhatsApp Flow ID required`);
    if (s.type === 'product' && !s.productId) errors.push(`step ${n}: choose a product`);
    if (s.type === 'webhook' && !/^https?:\/\//.test(s.url || '')) errors.push(`step ${n}: webhook URL required`);
    const jumps = [...(s.buttons || []).map((b) => b.goto), ...(s.rows || []).map((r) => r.goto), s.type === 'goto' ? s.step : undefined, s.next].filter((x) => x !== undefined && x !== null && x !== '');
    for (const j of jumps) if (stepIndex(f.steps, j) < 0) errors.push(`step ${n}: links to a missing step (${j})`);
  });
  return errors;
}

export function saveFlow(tenantId, f) {
  const triggers = {
    keywords: (f.triggers?.keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean),
    match: f.triggers?.match === 'contains' ? 'contains' : 'exact',
    welcome: !!f.triggers?.welcome,
    adIds: (f.triggers?.adIds || []).map(String).filter(Boolean),
    start: f.triggers?.start ?? null, // id of the first step (canvas "Flow start" link)
    layout: f.triggers?.layout || null, // canvas position of the start node
  };
  const args = [String(f.name).slice(0, 80), f.active === false ? 0 : 1, JSON.stringify(triggers), JSON.stringify(f.steps || [])];
  if (f.id) {
    getDb().prepare("UPDATE flows SET name = ?, active = ?, triggers = ?, steps = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?").run(...args, tenantId, Number(f.id));
    return getFlow(tenantId, f.id);
  }
  const info = getDb().prepare('INSERT INTO flows (tenant_id, name, active, triggers, steps) VALUES (?, ?, ?, ?, ?)').run(tenantId, ...args);
  return getFlow(tenantId, Number(info.lastInsertRowid));
}

/** Which flow (if any) should start for this inbound message? */
export function findTriggeredFlow(tenantId, { text, isFirstMessage, adId }) {
  const t = String(text || '').trim().toLowerCase().replace(/[!?.]+$/, '');
  const flows = listFlows(tenantId).filter((f) => f.active);
  if (adId) {
    const f = flows.find((x) => x.triggers.adIds?.includes(String(adId)));
    if (f) return f;
  }
  if (t) {
    const exact = flows.find((f) => f.triggers.keywords?.some((k) => (f.triggers.match === 'contains' ? false : t === k)));
    if (exact) return exact;
    const contains = flows.find((f) => f.triggers.match === 'contains' && f.triggers.keywords?.some((k) => k && t.includes(k)));
    if (contains) return contains;
  }
  if (isFirstMessage) return flows.find((f) => f.triggers.welcome) || null;
  return null;
}

// ---------- contact tags & attributes ----------
export function getContact(tenantId, waId) {
  const c = getDb().prepare('SELECT * FROM customers WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId);
  return c ? { ...c, tags: json(c.tags, []), attributes: json(c.attributes, {}) } : null;
}

export function updateContact(tenantId, waId, { addTags = [], removeTags = [], attributes = {} }) {
  const c = getContact(tenantId, waId);
  if (!c) return null;
  const tags = new Set(c.tags);
  addTags.forEach((t) => t && tags.add(String(t).trim().toLowerCase()));
  removeTags.forEach((t) => tags.delete(String(t).trim().toLowerCase()));
  const attrs = { ...c.attributes, ...attributes };
  getDb().prepare('UPDATE customers SET tags = ?, attributes = ? WHERE tenant_id = ? AND wa_id = ?').run(JSON.stringify([...tags]), JSON.stringify(attrs), tenantId, waId);
  return getContact(tenantId, waId);
}

export function fillVars(text, contact) {
  return String(text || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    if (k === 'name') return (contact?.name || '').split(' ')[0] || 'there';
    if (k === 'phone') return contact?.wa_id ? '+' + contact.wa_id : '';
    if (k.startsWith('attr.')) return contact?.attributes?.[k.slice(5)] ?? '';
    return '';
  });
}

const VALIDATORS = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || 'Please send a valid email address.',
  number: (v) => /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, '')) || 'Please send a number.',
  phone: (v) => v.replace(/\D/g, '').length >= 7 || 'Please send a valid phone number.',
  any: () => true,
};

/**
 * Runs a flow from step index `from` (0-based). ctx must provide:
 *   tenant, conv, reply(msg), runAction(id) (async), handover(text), schedule(kind, payload, minutes)
 */
export async function runFlow(ctx, flow, from = 0) {
  const { conv } = ctx;
  let i = from;
  for (let guard = 0; guard < MAX_STEPS_PER_RUN && i >= 0 && i < flow.steps.length; guard++) {
    const s = flow.steps[i];
    const contact = getContact(ctx.tenant.id, conv.waId);
    const next = nextIndex(flow.steps, i);
    switch (s.type) {
      case 'message': {
        const text = fillVars(s.text, contact);
        if (s.image) ctx.reply({ type: 'image', url: s.image, caption: s.buttons?.length ? '' : text });
        if (s.buttons?.length) {
          ctx.reply({ type: 'buttons', text, buttons: s.buttons.slice(0, 3).map((b, bi) => ({ id: `flow:${flow.id}:${i}:${bi}`, title: b.title })) });
          conv.data.flow = { id: flow.id, step: i, waiting: 'button' };
          return;
        }
        if (!s.image) ctx.reply({ type: 'text', text });
        i = next;
        break;
      }
      case 'list':
        ctx.reply({ type: 'list', text: fillVars(s.text, contact), button: s.button || 'Options', sections: [{ title: s.sectionTitle || 'Options', rows: (s.rows || []).slice(0, 10).map((r, ri) => ({ id: `flow:${flow.id}:${i}:${ri}`, title: r.title, ...(r.description ? { description: r.description } : {}) })) }] });
        conv.data.flow = { id: flow.id, step: i, waiting: 'button' };
        return;
      case 'form':
        ctx.reply({ type: 'flow', text: fillVars(s.text || 'Please fill in this short form 👇', contact), flowId: s.flowId, cta: s.cta || 'Open form', screen: s.screen || undefined, token: `wc:${flow.id}:${i}` });
        conv.data.flow = { id: flow.id, step: i, waiting: 'form' };
        return;
      case 'template':
        ctx.reply({ type: 'template', name: s.name, language: s.language || 'en_GB' });
        i = next;
        break;
      case 'product':
        delete conv.data.flow;
        return ctx.runAction(`p:${s.productId}`);
      case 'products':
        delete conv.data.flow;
        if (s.category) return ctx.runAction(`cat:${s.category}`);
        return ctx.showProducts ? ctx.showProducts(s.productIds || [], s.text) : ctx.runAction('browse');
      case 'question':
        ctx.reply({ type: 'text', text: fillVars(s.text, contact) });
        conv.data.flow = { id: flow.id, step: i, waiting: 'answer' };
        return;
      case 'tag':
        updateContact(ctx.tenant.id, conv.waId, { addTags: s.add || [], removeTags: s.remove || [] });
        i = next;
        break;
      case 'delay':
        delete conv.data.flow;
        if (next >= 0) ctx.schedule('flow_resume', { flowId: flow.id, step: next, waId: conv.waId }, Math.max(1, Number(s.minutes) || 1));
        return;
      case 'webhook':
        fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'flow.webhook', flow: flow.name, tenant: ctx.tenant.id, contact }), signal: AbortSignal.timeout(10000) }).catch((e) => console.warn('[flow webhook]', e.message));
        i = next;
        break;
      case 'handover':
        delete conv.data.flow;
        return ctx.handover(s.text ? fillVars(s.text, contact) : undefined);
      case 'action':
        delete conv.data.flow;
        return ctx.runAction(s.action || 'menu');
      case 'goto':
        i = stepIndex(flow.steps, s.step);
        break;
      default: // end
        delete conv.data.flow;
        return;
    }
  }
  delete conv.data.flow;
}

export async function startFlow(ctx, flow) {
  getDb().prepare('UPDATE flows SET runs = runs + 1 WHERE id = ?').run(flow.id);
  ctx.conv.state = 'idle';
  const first = flow.triggers.start !== null && flow.triggers.start !== undefined ? stepIndex(flow.steps, flow.triggers.start) : 0;
  return runFlow(ctx, flow, first < 0 ? 0 : first);
}

/** Handle a tap on a flow button (id "flow:<flowId>:<step>:<button>"). */
export async function handleFlowButton(ctx, id) {
  const [, flowId, step, btn] = id.split(':');
  const flow = getFlow(ctx.tenant.id, flowId);
  const s = flow?.steps[Number(step)];
  const b = (s?.type === 'list' ? s.rows : s?.buttons)?.[Number(btn)];
  if (!b) return false;
  delete ctx.conv.data.flow;
  const target = b.goto !== undefined && b.goto !== null && b.goto !== '' ? stepIndex(flow.steps, b.goto) : nextIndex(flow.steps, Number(step));
  await runFlow(ctx, flow, target);
  return true;
}

/** If the contact is answering a flow question, save it and continue. Returns true if handled. */
export async function handleFlowAnswer(ctx, text) {
  const st = ctx.conv.data.flow;
  if (!st || st.waiting !== 'answer') return false;
  const flow = getFlow(ctx.tenant.id, st.id);
  const s = flow?.steps[st.step];
  if (!s) { delete ctx.conv.data.flow; return false; }
  const value = String(text || '').trim();
  const ok = (VALIDATORS[s.validate] || VALIDATORS.any)(value);
  if (ok !== true) { ctx.reply({ type: 'text', text: ok }); return true; }
  updateContact(ctx.tenant.id, ctx.conv.waId, { attributes: { [s.save]: value.slice(0, 500) } });
  if (s.save === 'email') getDb().prepare('UPDATE customers SET email = ? WHERE tenant_id = ? AND wa_id = ?').run(value, ctx.tenant.id, ctx.conv.waId);
  if (s.save === 'name') getDb().prepare('UPDATE customers SET name = ? WHERE tenant_id = ? AND wa_id = ?').run(value.slice(0, 120), ctx.tenant.id, ctx.conv.waId);
  delete ctx.conv.data.flow;
  await runFlow(ctx, flow, nextIndex(flow.steps, st.step));
  return true;
}

// ---------- scheduler (delays, campaigns) ----------
export function schedule(tenantId, kind, payload, minutes) {
  getDb().prepare("INSERT INTO scheduled (tenant_id, kind, payload, run_at) VALUES (?, ?, ?, datetime('now', ?))").run(tenantId, kind, JSON.stringify(payload), `+${Math.round(minutes * 60)} seconds`);
}

export function dueJobs(limit = 100) {
  return getDb().prepare("SELECT * FROM scheduled WHERE done = 0 AND run_at <= datetime('now') ORDER BY run_at LIMIT ?").all(limit).map((r) => ({ ...r, payload: json(r.payload, {}) }));
}

export const markJobDone = (id) => getDb().prepare('UPDATE scheduled SET done = 1 WHERE id = ?').run(id);

/** A WhatsApp Flows form was submitted: save its fields to the contact and continue the flow. */
export async function handleFlowForm(ctx, response = {}) {
  const fields = Object.fromEntries(Object.entries(response).filter(([k, v]) => k !== 'flow_token' && v !== null && typeof v !== 'object').map(([k, v]) => [k, String(v).slice(0, 500)]));
  updateContact(ctx.tenant.id, ctx.conv.waId, { attributes: fields });
  if (fields.email) getDb().prepare('UPDATE customers SET email = ? WHERE tenant_id = ? AND wa_id = ?').run(fields.email, ctx.tenant.id, ctx.conv.waId);
  if (fields.name) getDb().prepare('UPDATE customers SET name = ? WHERE tenant_id = ? AND wa_id = ?').run(fields.name.slice(0, 120), ctx.tenant.id, ctx.conv.waId);
  const st = ctx.conv.data.flow;
  const [, fid, step] = String(response.flow_token || '').split(':');
  const flow = getFlow(ctx.tenant.id, st?.waiting === 'form' ? st.id : fid);
  if (!flow) return false;
  const from = st?.waiting === 'form' ? st.step : Number(step);
  delete ctx.conv.data.flow;
  const next = nextIndex(flow.steps, from);
  if (next < 0) { ctx.reply({ type: 'text', text: 'Thanks – we received your details ✅' }); return true; }
  await runFlow(ctx, flow, next);
  return true;
}
