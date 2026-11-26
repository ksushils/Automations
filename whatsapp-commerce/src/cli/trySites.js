// Run src/cli/trySite.js over a list of websites and save one JSON line per site. Safe to stop and start again:
// sites already in the output file are skipped.
//   node --disable-warning=ExperimentalWarning src/cli/trySites.js sites.txt results.jsonl [--parallel 3]
// sites.txt: one address per line (# comments allowed). Each site runs in its own process with its own in-memory
// database. Stops at once if the AI key stops working, so a broken key never produces thousands of bad results.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [list, outFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const pi = process.argv.indexOf('--parallel');
const parallel = Math.max(1, Math.min(6, Number(pi > 0 ? process.argv[pi + 1] : 3) || 3)); // be gentle with the sites
if (!list || !outFile) { console.error('usage: trySites.js sites.txt results.jsonl [--parallel 3]'); process.exit(2); }
const norm = (u) => { try { return new URL(/^https?:\/\//.test(u) ? u : `https://${u}`).origin.toLowerCase(); } catch { return null; } };
const done = new Set(fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return norm(JSON.parse(l).url); } catch { return null; } }) : []);
const sites = [...new Set(fs.readFileSync(list, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map(norm).filter(Boolean))].filter((u) => !done.has(u));
console.log(`${sites.length} sites to try (${done.size} already done), ${parallel} at a time`);
const script = fileURLToPath(new URL('./trySite.js', import.meta.url));
let stop = false, n = 0;
const runOne = (url) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, url, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '';
  p.stdout.on('data', (d) => { so += d; });
  p.stderr.on('data', () => {});
  const timer = setTimeout(() => p.kill('SIGKILL'), 240000);
  p.on('close', (code) => {
    clearTimeout(timer);
    const line = so.split('\n').reverse().find((l) => l.startsWith('{"url"'));
    if (code === 3 || /"error":"(No AI key|The AI key does not work)/.test(line || '')) { stop = true; console.error(`AI key problem – stopping. ${line || ''}`); return resolve(); }
    const rec = line ? JSON.parse(line) : { url, ok: false, error: code === null ? 'killed after 4 minutes' : `exit ${code}` };
    fs.appendFileSync(outFile, JSON.stringify({ ...rec, at: new Date().toISOString() }) + '\n');
    console.log(`[${++n}/${sites.length}] ${rec.ok ? '✔' : '✖'} ${url}${rec.ok ? ` · ${rec.pages.length} pages · ${rec.chat.filter((c) => c.by === 'ai').length} AI answers` : ` · ${rec.error}`}`);
    resolve();
  });
});
const queue = [...sites];
await Promise.all(Array.from({ length: parallel }, async () => { while (queue.length && !stop) await runOne(queue.shift()); }));
process.exit(stop ? 3 : 0);
