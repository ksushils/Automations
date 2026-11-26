// Try the assistant on any public website, the way a prospect's instant demo does, and print the conversation.
//   node --disable-warning=ExperimentalWarning src/cli/trySite.js <url> ["question" ...] [--json]
// Works on the server (uses the platform's AI settings) or on any computer with AI_API_KEY set (an OpenRouter key;
// AI_MODEL defaults to openai/gpt-4o-mini, the production model). Everything runs in an in-memory database: the
// throwaway business, its chats and customers exist only for this run. Nothing is sent to anyone (no WhatsApp
// number; the email key and alert settings are blanked). Without questions it asks the AI-suggested ones plus a
// standard set. Costs about a penny of AI usage per site. Many sites: src/cli/trySites.js.
// Exit codes: 0 ok · 1 site could not be read · 2 usage · 3 the AI key does not work (results would be meaningless).
import { initDb, getDb } from '../db.js';
import { loadPlatformSetup } from '../platformSetup.js';

initDb();
loadPlatformSetup();
initDb(':memory:');
// nothing may leave the server: no emails, no alert webhooks (the AI stays on – that's what is being tried)
const { config } = await import('../config.js');
Object.assign(config, { resendApiKey: '', alertWebhookUrl: '', alertEmail: '' });
const [url, ...asked] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const json = process.argv.includes('--json');
if (!url) { console.error('usage: trySite.js <url> ["question" ...] [--json]'); process.exit(2); }
const fail = (code, error, extra = {}) => { if (json) console.log(JSON.stringify({ url, ok: false, error, ...extra })); else console.log(`✖ ${url}: ${error}`); process.exit(code); };

// A wrong or missing key doesn't stop the bot – it quietly falls back to keyword answers. Check it first.
const { chatCompletion } = await import('../ai/direct.js');
if (!config.aiApiKey) fail(3, 'No AI key: set AI_API_KEY (OpenRouter) or the key in Setup.');
try { const r = await chatCompletion({ messages: [{ role: 'user', content: 'Reply with OK' }], maxTokens: 5 }); if (!r?.choices?.length) throw new Error('empty reply'); } catch (e) { fail(3, `The AI key does not work: ${String(e.message).slice(0, 160)}`); }

const { startDemo } = await import('../instantDemo.js');
const { getTenant } = await import('../tenants.js');
const { listDocs } = await import('../knowledge.js');
const { handleInbound } = await import('../bot/engine.js');

const t0 = Date.now();
let token;
try { ({ token } = await startDemo(url)); } catch (e) { fail(1, e.message); }
let st;
for (;;) { try { st = JSON.parse(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(`idemo_state:${token}`)?.value || '{}'); } catch { st = {}; } if (st.status === 'ready' || st.status === 'failed' || Date.now() - t0 > 120000) break; await new Promise((r) => setTimeout(r, 500)); }
if (st.status !== 'ready') fail(1, `${st.error || 'timed out'} (${st.step || ''})`, { pagesRead: st.pages || 0 });
const tenant = getTenant(st.tenantId);
const docs = listDocs(tenant.id);
const out = { url, ok: true, name: tenant.settings.business.name, trade: tenant.settings.trade || null, model: config.aiModel, pages: docs.map((d) => d.url || d.name), setupSeconds: Math.round((Date.now() - t0) / 1000), menu: (tenant.settings.welcomeMenu?.options || []).map((o) => o.label), chat: [] };

const STANDARD = ['hi', 'What are your opening hours?', 'How much does it cost?', 'Where are you based and how do I contact you?', 'How do I book or order?', 'Do you offer a student discount of 50% on Sundays?', 'and how long does that take?', 'wat r ur prices for delivry'];
const questions = asked.length ? asked : [...(st.suggestions || []), ...STANDARD];
const text = (m) => [m.text, m.body, m.caption, m.buttons && `[${m.buttons.map((b) => b.title).join(' | ')}]`, m.sections && `[list: ${m.sections.flatMap((s) => s.rows.map((r) => r.title)).join(' | ')}]`, m.url && `(${m.buttonText || 'link'}: ${m.url})`].filter(Boolean).join(' ');
const waId = 'web:trysite' + Math.random().toString(36).slice(2, 10);
const answersSoFar = () => getDb().prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS last FROM answer_evidence WHERE tenant_id = ?').get(tenant.id);
for (const q of questions) {
  const got = [];
  const s = Date.now();
  const before = answersSoFar().n;
  await handleInbound(getTenant(tenant.id), { waId, kind: 'text', text: q, profileName: null }, async (_to, m) => { got.push(m); return { id: 'x' }; });
  const after = answersSoFar();
  // by: "ai" = the AI wrote it (checked against the sources); "bot" = menus, greetings, booking and handover steps
  const ev = after.n > before ? getDb().prepare('SELECT flags, unsupported, sources FROM answer_evidence WHERE id = ?').get(after.last) : null;
  out.chat.push({ q, ms: Date.now() - s, by: ev ? 'ai' : 'bot', ...(ev ? { flags: JSON.parse(ev.flags || '[]'), unsupported: JSON.parse(ev.unsupported || '[]'), sources: JSON.parse(ev.sources || '[]').slice(0, 3).map((x) => x.url || x.doc) } : {}), a: got.map(text).join('\n   ') });
}
if (json) console.log(JSON.stringify(out));
else {
  console.log(`== ${out.name} (${url}) · trade: ${out.trade || '-'} · ${out.pages.length} pages · set up in ${out.setupSeconds}s · model ${out.model}`);
  console.log(`   pages: ${out.pages.map((p) => { try { return new URL(p).pathname; } catch { return p; } }).join(' ')}`);
  console.log(`   menu: ${out.menu.join(' | ')}`);
  for (const c of out.chat) console.log(`\n> ${c.q}   (${(c.ms / 1000).toFixed(1)}s, ${c.by}${c.flags?.length ? ', flags: ' + c.flags.join(' ') : ''})\n   ${c.a || '(no reply)'}`);
}
process.exit(0);
