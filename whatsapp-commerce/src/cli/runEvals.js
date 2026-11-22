// AI evaluation run against the configured model.
//   docker exec whatsapp-commerce node --disable-warning=ExperimentalWarning src/cli/runEvals.js [--guard-only] [case-id ...]
// Uses the platform's AI settings (read from the database the app uses, exactly as at start-up), then switches to an
// in-memory database: every case creates its own throwaway test business, so no live business, chat or customer is
// touched and nothing is sent to anyone. Costs a few pence of AI usage per full run.
// Writes data/evals/<time>.json and prints a table. Exit code 1 if any case fails.
import fs from 'node:fs';
import path from 'node:path';
import { initDb } from '../db.js';
import { loadPlatformSetup } from '../platformSetup.js';
import { config } from '../config.js';

initDb();
loadPlatformSetup();
initDb(':memory:'); // from here on: a fresh, empty database just for the evaluation
const args = process.argv.slice(2);
const guardOnly = args.includes('--guard-only');
const only = args.filter((a) => !a.startsWith('--'));
if (!config.aiApiKey && !guardOnly) { console.error('No AI key configured – run with --guard-only, or set the AI key in Setup first.'); process.exit(2); }
const { runEvals } = await import('../evals.js');
const report = await runEvals({ modes: guardOnly ? ['guard'] : ['guard', 'model'], only: only.length ? only : undefined });
for (const r of report.results) console.log(`${r.pass ? '✔' : '✖'} ${r.id.padEnd(18)} ${r.category.padEnd(30)} ${String(r.latencyMs).padStart(6)} ms  $${r.costUsd.toFixed(4)}  ${r.pass ? '' : `– expected: ${r.expected}; failed: ${r.failedChecks.join(', ') || r.error}\n      said: ${r.actual.replace(/\s+/g, ' ').slice(0, 200)}`}`);
const total = report.results.reduce((s, r) => s + r.costUsd, 0);
console.log(`\n${report.passed}/${report.total} passed · model ${report.model} · total AI cost $${total.toFixed(4)}`);
const dir = path.resolve(path.dirname(config.databasePath === ':memory:' ? './data/x' : config.databasePath), 'evals');
try { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, `${report.at.replace(/[:.]/g, '-')}.json`); fs.writeFileSync(f, JSON.stringify(report, null, 2)); console.log(`Report: ${f}`); } catch (e) { console.warn('Could not save the report:', e.message); }
process.exit(report.passed === report.total ? 0 : 1);
