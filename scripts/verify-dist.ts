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
import { checkDist, DIST_BUDGET } from './lib/distCheck.ts';

const dir = resolve(process.argv[2] ?? 'dist');
const base = resolveBase('build', process.argv[3] ?? process.env['BASE_PATH']);
const report = checkDist(dir, base);
const kb = (n: number): string => `${(n / 1000).toFixed(1)} kB`;

console.log(`GALAXIA dist check: ${dir} (base ${base})`);
for (const f of report.files) console.log(`  ${f.path.padEnd(36)} ${kb(f.bytes).padStart(10)}  gzip ${kb(f.gzip).padStart(9)}`);
if (report.entry) console.log(`  entry JS gzip ${kb(report.entry.gzip)} / budget ${kb(DIST_BUDGET.entryJsGzip)}`);
if (report.freeRoam) console.log(`  Free Roam JS gzip ${kb(report.freeRoam.gzip)} / budget ${kb(DIST_BUDGET.freeRoamJsGzip)} (loaded only when Free Roam is chosen)`);
if (report.problems.length) {
  for (const p of report.problems) console.log(process.env['GITHUB_ACTIONS'] ? `::error::${p}` : `  FAIL ${p}`);
  console.log(`${report.problems.length} problem(s); do not publish this build.`);
  process.exit(1);
}
console.log('OK: every asset resolves under the base, no developer tools, Free Roam is lazy, sizes within budget.');
