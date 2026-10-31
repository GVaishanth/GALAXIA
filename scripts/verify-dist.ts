/**
 * Verifies a production build before it is published (FR-TD-80).
 *
 *   BASE_PATH=/galaxia/ npx vite build && BASE_PATH=/galaxia/ npm run verify:dist
 *   npm run verify:dist -- dist /galaxia/     (folder and base as arguments)
 *
 * The base is resolved exactly as vite.config.ts does for a build, so CI can
 * pass the same BASE_PATH it gave Vite. Exits 1 and lists every problem if the
 * folder is not safe to upload.
 */
import { resolve } from 'node:path';
import { resolveBase } from '../vite.config.ts';
import { CHUNK_BUDGETS, checkDist, DIST_BUDGET } from './lib/distCheck.ts';

const dir = resolve(process.argv[2] ?? 'dist');
const base = resolveBase('build', process.argv[3] ?? process.env['BASE_PATH']);
const report = checkDist(dir, base);
const kb = (n: number): string => `${(n / 1000).toFixed(1)} kB`;
const fails = (path: string): boolean => report.problems.some((p) => p.includes(path));

console.log(`GALAXIA dist check: ${dir} (base ${base})`);
for (const f of report.files) console.log(`  ${f.path.padEnd(36)} ${kb(f.bytes).padStart(10)}  gzip ${kb(f.gzip).padStart(9)}`);
// P10.1: every JavaScript chunk, what loads it, and its own limit (gzip level 9, as above)
console.log('  JavaScript chunks (gzip / limit):');
for (const c of report.chunks) {
  const role = c.kind === 'entry' ? 'entry (title screen)' : c.kind === 'freeRoam' ? 'Free Roam (loaded when Free Roam is chosen)' : (CHUNK_BUDGETS.find((b) => b.name === c.name)?.role ?? 'NOT IN THE INVENTORY');
  const verdict = c.limit === null || fails(c.path) ? 'FAIL' : 'ok';
  console.log(`    ${verdict.padEnd(4)} ${c.path.padEnd(34)} ${c.kind.padEnd(8)} ${kb(c.gzip).padStart(8)} / ${c.limit === null ? '   none' : kb(c.limit).padStart(8)}  ${role}`);
}
const line = (label: string, n: number, limit: number | null, bad: boolean): void => console.log(`  ${(limit === null ? 'info' : bad ? 'FAIL' : 'ok').padEnd(4)} ${label.padEnd(72)} ${String(n).padStart(7)} B${limit === null ? '' : ` / ${limit} B`}`);
const cssGzip = report.css.reduce((s, f) => s + f.gzip, 0);
if (report.entry) line('entry JS gzip', report.entry.gzip, DIST_BUDGET.entryJsGzip, report.entry.gzip > DIST_BUDGET.entryJsGzip);
if (report.freeRoam) line('Free Roam JS gzip (its chunk)', report.freeRoam.gzip, DIST_BUDGET.freeRoamJsGzip, report.freeRoam.gzip > DIST_BUDGET.freeRoamJsGzip);
if (report.freeRoam) line('Free Roam eager JS gzip (its chunk + chunks only it loads statically)', report.freeRoamEager, DIST_BUDGET.freeRoamJsGzip, report.freeRoamEager > DIST_BUDGET.freeRoamJsGzip);
if (report.freeRoam) line('Free Roam total JS gzip (eager + shared + lazy chunks; reported only)', report.freeRoamTotal, null, false);
line('CSS gzip', cssGzip, DIST_BUDGET.cssGzip, cssGzip > DIST_BUDGET.cssGzip);
if (report.problems.length) {
  for (const p of report.problems) console.log(process.env['GITHUB_ACTIONS'] ? `::error::${p}` : `  FAIL ${p}`);
  console.log(`${report.problems.length} problem(s); do not publish this build.`);
  process.exit(1);
}
console.log('OK: every asset resolves under the base, no developer tools, Free Roam and its lazy chunks load on demand, every chunk within its budget.');
