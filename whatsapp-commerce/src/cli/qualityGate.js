// Deploy gate: re-run the answer check for live shops and fail if answers got worse.
//   docker exec whatsapp-commerce node --disable-warning=ExperimentalWarning src/cli/qualityGate.js [tenantId ...]
// Exit code 1 when a shop scores below MIN_SCORE or more than MAX_DROP points below its previous check.
import { initDb, getDb } from '../db.js';
import { loadPlatformSetup } from '../platformSetup.js';
import { listTenants } from '../tenants.js';
import { runQualityCheck, lastQuality } from '../quality.js';

const MIN_SCORE = Number(process.env.QUALITY_MIN || 60);
const MAX_DROP = Number(process.env.QUALITY_MAX_DROP || 12);

initDb();
loadPlatformSetup();
const ids = process.argv.slice(2);
const shops = listTenants().filter((t) => (ids.length ? ids.includes(t.id) : t.active && !t.settings.demo?.expiresAt && t.settings.ai?.enabled !== false
  && getDb().prepare("SELECT 1 FROM knowledge_docs WHERE tenant_id = ? AND status != 'deleted' LIMIT 1").get(t.id)));
let failed = 0;
for (const t of shops) {
  const before = lastQuality(t.id)?.score ?? null;
  try {
    const r = await runQualityCheck(t.id, { limit: Number(process.env.QUALITY_QUESTIONS || 12) });
    const drop = before == null ? 0 : before - r.score;
    const bad = r.score < MIN_SCORE || drop > MAX_DROP;
    if (bad) failed++;
    console.log(`${bad ? '✖' : '✔'} ${t.id.padEnd(32)} ${String(r.score).padStart(3)}/100  (${r.good} good, ${r.weak} weak, ${r.wrong} wrong)${before == null ? '' : `  was ${before}`}`);
    for (const x of r.results.filter((y) => y.verdict === 'wrong')) console.log(`    ❌ ${x.question} – ${x.reason}`);
  } catch (e) {
    failed++;
    console.log(`✖ ${t.id} – ${e.message}`);
  }
}
console.log(failed ? `\n${failed} shop(s) failed the answer check.` : `\nAll ${shops.length} shop(s) passed.`);
process.exit(failed ? 1 : 0);
