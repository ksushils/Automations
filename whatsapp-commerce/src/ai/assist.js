import { getDb, json } from '../db.js';
import { chatCompletion, directConfigured } from './direct.js';
import { retrieve } from './rag.js';
import { toPlainText } from '../whatsapp/cloudApi.js';
import { bumpUsage } from '../tenants.js';

/*
 * Help for the team in the Inbox (not sent to anyone by itself):
 *  - suggestReply: a draft reply to the customer's latest message, from the shop's own information, for a person to
 *    check and send;
 *  - translateText: a message in another language, translated for the team (or the team's reply for the customer).
 */
const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

export async function suggestReply(tenant, waId) {
  if (!directConfigured()) throw fail('The AI is not set up on this server');
  const rows = getDb().prepare('SELECT direction, body FROM messages WHERE tenant_id = ? AND wa_id = ? ORDER BY id DESC LIMIT 14').all(tenant.id, waId).reverse();
  const chat = rows.map((r) => { const b = json(r.body, {}); const t = r.direction === 'in' ? String(b.text || '') : toPlainText(b); return t && !/^\[/.test(t) ? `${r.direction === 'in' ? 'Customer' : b.staff ? 'Team' : 'Assistant'}: ${t.slice(0, 600)}` : ''; }).filter(Boolean);
  const lastIn = [...rows].reverse().filter((r) => r.direction === 'in').map((r) => String(json(r.body, {}).text || '')).find((t) => t && !/^\[/.test(t));
  if (!lastIn) throw fail('There is no customer message to reply to yet');
  const kb = await retrieve(tenant.id, lastIn, { k: 5 }).catch(() => []);
  const S = tenant.settings;
  const res = await chatCompletion({
    temperature: 0.3, maxTokens: 300,
    messages: [
      { role: 'system', content: `You draft a reply for a team member at ${S.business.name} to send to a customer. Use only the shop information below; if it doesn't answer the question, write a short reply saying you'll check and get back to them. Friendly, plain, at most 3 short sentences, in the customer's language. No sign-off. Reply with the message text only.\n\n<shop_data>\n${kb.map((c) => `(${c.doc}) ${String(c.text).slice(0, 1200)}`).join('\n\n') || '(nothing relevant found)'}\n</shop_data>` },
      { role: 'user', content: `The chat so far:\n${chat.join('\n')}\n\nDraft the team's next reply.` },
    ],
  });
  bumpUsage(tenant.id, 'ai_calls');
  const text = String(res.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
  if (!text) throw fail('The AI did not return a suggestion – try again');
  return { text: text.slice(0, 1000), sources: [...new Set(kb.map((c) => c.doc))].slice(0, 3) };
}

export async function translateText(tenant, text, to = 'English') {
  if (!directConfigured()) throw fail('The AI is not set up on this server');
  const src = String(text).trim().slice(0, 2000);
  if (!src) throw fail('Nothing to translate');
  const lang = String(to).replace(/[^\p{L} ]/gu, '').slice(0, 30) || 'English';
  const res = await chatCompletion({ temperature: 0, maxTokens: 500, messages: [{ role: 'system', content: `Translate the user's text into ${lang}. Reply with the translation only. If it is already in ${lang}, return it unchanged. Then on a last line write LANG: and the name of the original language in English.` }, { role: 'user', content: src }] });
  bumpUsage(tenant.id, 'ai_calls');
  const out = String(res.choices?.[0]?.message?.content || '').trim();
  const m = out.match(/\n?LANG:\s*([^\n]+)\s*$/i);
  return { text: (m ? out.slice(0, m.index) : out).trim(), from: m ? m[1].trim() : '' };
}
