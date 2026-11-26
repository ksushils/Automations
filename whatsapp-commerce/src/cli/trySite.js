// Try the assistant on any public website, the way a prospect's instant demo does, and print the conversation.
//   docker exec whatsapp-commerce node --disable-warning=ExperimentalWarning src/cli/trySite.js <url> ["question" ...]
// Uses the platform's AI settings, then an in-memory database: the throwaway business, its chats and customers exist
// only for this run. Nothing is sent to anyone (no WhatsApp number; the email key and alert settings are blanked for the run).
// Without questions it asks the AI-suggested ones plus a standard set (hours, prices, contact, booking, a question the
// site can't answer, a follow-up that needs the previous answer, a typo). Costs about a penny of AI usage per site.
import { initDb } from '../db.js';
import { loadPlatformSetup } from '../platformSetup.js';
import { getDb } from '../db.js';

initDb();
loadPlatformSetup();
initDb(':memory:');
// nothing may leave the server: no emails, no alert webhooks (the AI stays on – that's what is being tried)
const { config } = await import('../config.js');
Object.assign(config, { resendApiKey: '', alertWebhookUrl: '', alertEmail: '' });
const [url, ...asked] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const json = process.argv.includes('--json');
if (!url) { console.error('usage: trySite.js <url> ["question" ...]'); process.exit(2); }
const { startDemo } = await import('../instantDemo.js');
const { getTenant } = await import('../tenants.js');
const { listDocs } = await import('../knowledge.js');
const { handleInbound } = await import('../bot/engine.js');

const t0 = Date.now();
const { token } = await startDemo(url);
let st;
for (;;) { try { st = JSON.parse(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(`idemo_state:${token}`)?.value || '{}'); } catch { st = {}; } if (st.status === 'ready' || st.status === 'failed' || Date.now() - t0 > 120000) break; await new Promise((r) => setTimeout(r, 500)); }
if (st.status !== 'ready') { console.log(`✖ ${url}: ${st.error || 'timed out'} (${st.step || ''})`); process.exit(1); }
const tenant = getTenant(st.tenantId);
const docs = listDocs(tenant.id);
const out = { url, name: tenant.settings.business.name, trade: tenant.settings.trade || null, pages: docs.map((d) => d.url || d.name), setupSeconds: Math.round((Date.now() - t0) / 1000), menu: (tenant.settings.welcomeMenu?.options || []).map((o) => o.label), chat: [] };

const STANDARD = ['hi', 'What are your opening hours?', 'How much does it cost?', 'Where are you based and how do I contact you?', 'How do I book or order?', 'Do you offer a student discount of 50% on Sundays?', 'and how long does that take?', 'wat r ur prices for delivry'];
const questions = asked.length ? asked : [...(st.suggestions || []), ...STANDARD];
const text = (m) => [m.text, m.body, m.caption, m.buttons && `[${m.buttons.map((b) => b.title).join(' | ')}]`, m.sections && `[list: ${m.sections.flatMap((s) => s.rows.map((r) => r.title)).join(' | ')}]`, m.url && `(${m.buttonText || 'link'}: ${m.url})`].filter(Boolean).join(' ');
const waId = 'web:trysite' + Math.random().toString(36).slice(2, 10);
{
  for (const q of questions) {
    const got = [];
    const s = Date.now();
    await handleInbound(getTenant(tenant.id), { waId, kind: 'text', text: q, profileName: null }, async (_to, m) => { got.push(m); return { id: 'x' }; });
    out.chat.push({ q, ms: Date.now() - s, a: got.map(text).join('\n   ') });
  }
}
if (json) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`== ${out.name} (${url}) · trade: ${out.trade || '-'} · ${out.pages.length} pages · set up in ${out.setupSeconds}s`);
  console.log(`   pages: ${out.pages.map((p) => { try { return new URL(p).pathname; } catch { return p; } }).join(' ')}`);
  console.log(`   menu: ${out.menu.join(' | ')}`);
  for (const c of out.chat) console.log(`\n> ${c.q}   (${(c.ms / 1000).toFixed(1)}s)\n   ${c.a || '(no reply)'}`);
}
process.exit(0);
