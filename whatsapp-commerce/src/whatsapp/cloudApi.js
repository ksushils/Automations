import { config } from '../config.js';
import { getDb } from '../db.js';
import { bumpUsage } from '../tenants.js';

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

/**
 * Normalised outbound message shapes (what the bot engine produces):
 *  { type:'text', text }
 *  { type:'buttons', text, buttons:[{id,title}] (max 3), header?, footer? }
 *  { type:'list', text, button, sections:[{title, rows:[{id,title,description}]}], header?, footer? }
 *  { type:'image', url, caption }
 *  { type:'cta', text, buttonText, url }
 *  { type:'template', name, language, components }
 */
export function toGraphPayload(to, msg) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  switch (msg.type) {
    case 'text':
      return { ...base, type: 'text', text: { preview_url: true, body: clip(msg.text, 4096) } };
    case 'image':
      return { ...base, type: 'image', image: { link: msg.url, caption: clip(msg.caption, 1024) } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(msg.header ? { header: { type: 'text', text: clip(msg.header, 60) } } : {}),
          body: { text: clip(msg.text, 1024) },
          ...(msg.footer ? { footer: { text: clip(msg.footer, 60) } } : {}),
          action: { buttons: msg.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: clip(b.id, 256), title: clip(b.title, 20) } })) },
        },
      };
    case 'list': {
      let budget = 10; // WhatsApp allows max 10 rows across all sections
      const sections = msg.sections
        .map((s) => {
          const rows = s.rows.slice(0, budget);
          budget -= rows.length;
          return {
            title: clip(s.title || 'Options', 24),
            rows: rows.map((r) => ({ id: clip(r.id, 200), title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}) })),
          };
        })
        .filter((s) => s.rows.length);
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(msg.header ? { header: { type: 'text', text: clip(msg.header, 60) } } : {}),
          body: { text: clip(msg.text, 4096) },
          ...(msg.footer ? { footer: { text: clip(msg.footer, 60) } } : {}),
          action: { button: clip(msg.button || 'View', 20), sections },
        },
      };
    }
    case 'cta':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: clip(msg.text, 1024) },
          action: { name: 'cta_url', parameters: { display_text: clip(msg.buttonText || 'Open', 20), url: msg.url } },
        },
      };
    case 'template':
      return { ...base, type: 'template', template: { name: msg.name, language: { code: msg.language || 'en_GB' }, ...(msg.components ? { components: msg.components } : {}) } };
    default:
      throw new Error(`Unknown message type ${msg.type}`);
  }
}

/** Plain-text rendering of a normalised message (used for logs, the simulator and fallbacks). */
export function toPlainText(msg) {
  switch (msg.type) {
    case 'text': return msg.text;
    case 'image': return `[image] ${msg.url}\n${msg.caption || ''}`.trim();
    case 'buttons': return `${msg.text}\n${msg.buttons.map((b) => `[ ${b.title} ]`).join(' ')}`;
    case 'list': return `${msg.text}\n${msg.sections.flatMap((s) => s.rows.map((r) => `• ${r.title}${r.description ? ' — ' + r.description : ''}`)).join('\n')}`;
    case 'cta': return `${msg.text}\n${msg.buttonText}: ${msg.url}`;
    case 'template': return `[template ${msg.name}]`;
    default: return JSON.stringify(msg);
  }
}

export function logMessage(tenantId, waId, direction, msg, waMessageId = null) {
  try {
    getDb()
      .prepare('INSERT INTO messages (tenant_id, wa_id, direction, type, body, wa_message_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tenantId, waId, direction, msg.type, JSON.stringify(msg), waMessageId);
    return true;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return false; // duplicate inbound webhook delivery
    throw e;
  }
}

async function graphPost(tenant, pathPart, body) {
  const { accessToken } = tenant.settings.whatsapp;
  const res = await fetch(`https://graph.facebook.com/${config.graphVersion}/${pathPart}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`WhatsApp API ${res.status}: ${data?.error?.message || 'unknown error'}`);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Create a sender for a tenant. In simulator mode (sink provided) messages are captured instead of sent.
 */
export function createSender(tenant, { sink } = {}) {
  return async function send(to, msg) {
    logMessage(tenant.id, to, 'out', msg);
    bumpUsage(tenant.id, 'outbound');
    if (sink) {
      sink.push(msg);
      return { simulated: true };
    }
    const { phoneNumberId, accessToken } = tenant.settings.whatsapp;
    if (!phoneNumberId || !accessToken) throw new Error('WhatsApp is not configured for this tenant');
    try {
      return await graphPost(tenant, `${phoneNumberId}/messages`, toGraphPayload(to, msg));
    } catch (e) {
      // Some accounts don't support cta_url / images from certain hosts – fall back to plain text.
      if (msg.type !== 'text' && msg.type !== 'template' && e.status === 400) {
        return graphPost(tenant, `${phoneNumberId}/messages`, toGraphPayload(to, { type: 'text', text: toPlainText(msg) }));
      }
      throw e;
    }
  };
}

export async function markRead(tenant, messageId) {
  const { phoneNumberId, accessToken } = tenant.settings.whatsapp;
  if (!phoneNumberId || !accessToken || !messageId) return;
  await graphPost(tenant, `${phoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }).catch(() => {});
}

/** Convert a Cloud API inbound message into a normalised event the engine understands. */
export function parseInbound(m) {
  const base = { waId: m.from, messageId: m.id, timestamp: Number(m.timestamp) };
  switch (m.type) {
    case 'text':
      return { ...base, kind: 'text', text: m.text?.body || '' };
    case 'interactive': {
      const r = m.interactive?.button_reply || m.interactive?.list_reply;
      if (m.interactive?.type === 'nfm_reply') return { ...base, kind: 'text', text: m.interactive.nfm_reply?.response_json || '' };
      return { ...base, kind: 'action', id: r?.id || '', text: r?.title || '' };
    }
    case 'button': // quick-reply button on a template
      return { ...base, kind: 'action', id: m.button?.payload || '', text: m.button?.text || '' };
    case 'location':
      return { ...base, kind: 'location', location: m.location, text: [m.location?.name, m.location?.address].filter(Boolean).join(', ') || `${m.location?.latitude},${m.location?.longitude}` };
    case 'order': // native WhatsApp catalog cart (if the tenant uses a Meta catalog)
      return { ...base, kind: 'native_order', order: m.order };
    default:
      return { ...base, kind: 'unsupported', type: m.type };
  }
}
