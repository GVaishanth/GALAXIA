/**
 * Static checks for a production build folder (FR Prompt 16, FR-TD-80).
 *
 * Pure file inspection: no network, no browser. Used by scripts/verify-dist.ts
 * (run in CI between `vite build` and the Pages upload) and by
 * tests/distCheck.test.ts with synthetic fixtures.
 *
 * What it proves about a build made for `base`:
 *   - every URL in index.html / 404.html resolves to a file in the folder and
 *     carries the base prefix (or is relative), and none points off-site;
 *   - every `assets/...` file named in JS or CSS (dynamic imports, preload
 *     maps, CSS url()) exists, and every emitted asset is referenced;
 *   - nothing developer-only shipped: no Hangar, no source maps, no
 *     loopback hosts, no unreplaced build flags, no automation hooks;
 *   - the Free Roam code is a separate lazy chunk, not part of the entry;
 *   - gzip sizes stay inside the release budget.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

/** gzip budgets in bytes. About 1.4x the sizes measured on 2026-10-21. */
export const DIST_BUDGET = Object.freeze({
  entryJsGzip: 110_000, // measured 77.5 kB
  freeRoamJsGzip: 225_000, // measured 159.7 kB
  cssGzip: 25_000, // measured 15.6 kB
  totalBytes: 1_500_000, // measured 0.85 MB uncompressed
});

/** Automation hook names (window.__galaxia, __galaxiaGame, __galaxiaFreeRoam, __galaxiaHangar); \b keeps __galaxiaBooted out. */
/** FR-TD-83: marker carried by the Gravity Flight lab chunk (src/modes/freeroam/gravity/labShell.ts). */
export const GRAVITY_LAB_MARKER = 'GALAXIA · Gravity Lab';
export const TEST_HOOK_PATTERN = /\b__galaxia(?:Game|FreeRoam|Hangar)?\b/g;

export const REQUIRED_FILES = Object.freeze(['index.html', '404.html', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'THIRD_PARTY_NOTICES.txt']);

export interface DistFile {
  readonly path: string; // POSIX path relative to the dist folder
  readonly bytes: number;
  readonly gzip: number;
}

export interface DistReport {
  readonly base: string;
  readonly problems: string[];
  readonly files: DistFile[];
  readonly entry: DistFile | null;
  readonly freeRoam: DistFile | null;
  readonly css: DistFile[];
}

function walk(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, root) : [relative(root, full).split('\\').join('/')];
  });
}

/**
 * Resolves a URL written in an HTML file at the dist root to a dist-relative
 * path, or explains why it is not acceptable for this base.
 */
export function resolveHtmlUrl(url: string, base: string): { path: string } | { error: string } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) {
    if (/^https?:\/\//i.test(base) && url.startsWith(base)) return { path: url.slice(base.length).split(/[?#]/)[0]! };
    return { error: `points off-site (${url})` };
  }
  const clean = url.split(/[?#]/)[0]!;
  if (clean.startsWith('/')) {
    if (base === './') return { error: `is root-relative in a relative build (${url})` };
    if (!clean.startsWith(base)) return { error: `is missing the base ${base} (${url})` };
    return { path: clean.slice(base.length) };
  }
  return { path: posix.normalize(clean.replace(/^\.\//, '')) };
}

export function checkDist(dir: string, base: string): DistReport {
  const problems: string[] = [];
  const empty: DistReport = { base, problems, files: [], entry: null, freeRoam: null, css: [] };
  if (!existsSync(join(dir, 'index.html'))) {
    problems.push(`${dir}/index.html does not exist (run the build first)`);
    return empty;
  }
  const paths = walk(dir).sort();
  const present = new Set(paths);
  const text = new Map<string, string>();
  const read = (p: string): string => {
    let t = text.get(p);
    if (t === undefined) {
      t = readFileSync(join(dir, p), 'utf8');
      text.set(p, t);
    }
    return t;
  };
  const files: DistFile[] = paths.map((p) => {
    const buf = readFileSync(join(dir, p));
    return { path: p, bytes: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
  });

  for (const f of REQUIRED_FILES) if (!present.has(f)) problems.push(`required file missing: ${f}`);
  if (present.has('THIRD_PARTY_NOTICES.txt') && !read('THIRD_PARTY_NOTICES.txt').includes('Vite contributors')) {
    problems.push('THIRD_PARTY_NOTICES.txt no longer carries the Vite licence notice');
  }

  // 1. HTML: every src/href resolves inside the folder, under the base.
  const referenced = new Set<string>();
  const html = read('index.html');
  for (const m of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
    const r = resolveHtmlUrl(m[1]!, base);
    if ('error' in r) problems.push(`index.html: ${m[1]} ${r.error}`);
    else if (!present.has(r.path)) problems.push(`index.html: ${m[1]} -> ${r.path} does not exist`);
    else referenced.add(r.path);
  }
  const entryScripts = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => resolveHtmlUrl(m[1]!, base));
  const entryPath = entryScripts.length === 1 && 'path' in entryScripts[0]! ? entryScripts[0].path : null;
  if (entryScripts.length !== 1) problems.push(`index.html must load exactly one module entry (found ${entryScripts.length})`);

  if (present.has('404.html')) {
    const nf = read('404.html');
    const target = /location\.replace\("([^"]*)"\)/.exec(nf)?.[1];
    if (base === './') {
      if (target !== undefined) problems.push('404.html redirects in a relative build (the base is unknown there)');
    } else if (target !== base) problems.push(`404.html should redirect to ${base} (found ${target ?? 'no redirect'})`);
  }

  // 2. JS and CSS: every assets/... name exists; every asset is referenced.
  const assetRef = /assets\/([A-Za-z0-9._-]+\.(?:js|css|png|svg|webp|jpg|woff2?|ogg|mp3|wav|json))/g;
  const relImport = /import\(\s*[`'"]\.\/([A-Za-z0-9._-]+\.js)[`'"]\s*\)/g;
  const code = paths.filter((p) => /\.(?:js|css)$/.test(p));
  for (const p of code) {
    const t = read(p);
    for (const m of t.matchAll(assetRef)) {
      const target = `assets/${m[1]}`;
      if (!present.has(target)) problems.push(`${p}: references ${target}, which does not exist`);
      else referenced.add(target);
    }
    for (const m of t.matchAll(relImport)) {
      const target = posix.join(posix.dirname(p), m[1]!);
      if (!present.has(target)) problems.push(`${p}: imports ./${m[1]}, which does not exist`);
      else referenced.add(target);
    }
    if (p.endsWith('.css')) {
      for (const m of t.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const u = m[1]!;
        if (u.startsWith('data:') || u.startsWith('#')) continue;
        if (/^[a-z]+:|^\/\//i.test(u)) problems.push(`${p}: url(${u}) points off-site`);
        else if (u.startsWith('/') && !u.startsWith(base)) problems.push(`${p}: url(${u}) is missing the base ${base}`);
        else if (!u.startsWith('/') && !present.has(posix.normalize(posix.join(posix.dirname(p), u)))) problems.push(`${p}: url(${u}) does not exist`);
      }
    }
    if (/localhost|127\.0\.0\.1/.test(t)) problems.push(`${p}: contains a loopback host`);
    if (/sourceMappingURL=/.test(t)) problems.push(`${p}: links a source map`);
    if (/__GALAXIA_DEV_TOOLS__/.test(t)) problems.push(`${p}: build flag __GALAXIA_DEV_TOOLS__ was not replaced`);
    if (/__GALAXIA_TEST_HOOKS__/.test(t)) problems.push(`${p}: build flag __GALAXIA_TEST_HOOKS__ was not replaced`);
    if (/__GALAXIA_GRAVITY_LAB__/.test(t)) problems.push(`${p}: build flag __GALAXIA_GRAVITY_LAB__ was not replaced`);
    // FR-TD-83: the experimental Gravity Flight lab is a dev / QA tool only (its chunk carries this marker)
    if (t.includes(GRAVITY_LAB_MARKER)) problems.push(`${p}: contains the experimental Gravity Flight lab (build with \`npm run build\`, not --mode qa)`);
    // TD-78: the automation hooks stay out of release builds (__galaxiaBooted, the boot watchdog flag, is not a hook)
    for (const m of new Set(t.match(TEST_HOOK_PATTERN) ?? [])) problems.push(`${p}: test hook ${m} shipped (build with \`npm run build\`, not --mode e2e / qa)`);
  }
  for (const p of paths) {
    if (p.endsWith('.map')) problems.push(`source map shipped: ${p}`);
    if (/hangar/i.test(p)) problems.push(`developer Hangar chunk shipped: ${p}`);
    if (p.startsWith('assets/') && !referenced.has(p)) problems.push(`unreferenced asset (dead download weight): ${p}`);
    if (/\.(?:js|css|html)$/.test(p) && read(p).includes('GALAXIA · Hangar')) problems.push(`${p}: contains the developer Hangar`);
  }

  // 3. Chunking: Free Roam stays out of the entry and loads on demand.
  const entry = files.find((f) => f.path === entryPath) ?? null;
  const freeRoam = files.find((f) => /^assets\/freeRoamMode-[^/]+\.js$/.test(f.path)) ?? null;
  const css = files.filter((f) => f.path.endsWith('.css'));
  if (!freeRoam) problems.push('no separate Free Roam chunk (assets/freeRoamMode-*.js): Free Roam would load with the title screen');
  if (entry) {
    const e = read(entry.path);
    // Catalogue citations survive minification and exist only in Free Roam code.
    if (/createFreeRoamMode\s*=|function createFreeRoamMode|science\.nasa\.gov/.test(e)) problems.push('Free Roam code is bundled into the entry chunk');
  }
  if (entry && freeRoam) {
    const e = read(entry.path);
    if (!new RegExp(`import\\(\\s*[\`'"]\\./${posix.basename(freeRoam.path).replace(/[.]/g, '\\.')}`).test(e)) {
      problems.push('the entry does not load the Free Roam chunk with a dynamic import');
    }
  }

  // 4. Budgets.
  const kb = (n: number): string => `${(n / 1000).toFixed(1)} kB`;
  if (entry && entry.gzip > DIST_BUDGET.entryJsGzip) problems.push(`entry JS ${kb(entry.gzip)} gzip exceeds the ${kb(DIST_BUDGET.entryJsGzip)} budget`);
  if (freeRoam && freeRoam.gzip > DIST_BUDGET.freeRoamJsGzip) problems.push(`Free Roam JS ${kb(freeRoam.gzip)} gzip exceeds the ${kb(DIST_BUDGET.freeRoamJsGzip)} budget`);
  const cssGzip = css.reduce((s, f) => s + f.gzip, 0);
  if (cssGzip > DIST_BUDGET.cssGzip) problems.push(`CSS ${kb(cssGzip)} gzip exceeds the ${kb(DIST_BUDGET.cssGzip)} budget`);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  if (total > DIST_BUDGET.totalBytes) problems.push(`build is ${kb(total)}, over the ${kb(DIST_BUDGET.totalBytes)} budget`);

  return { base, problems, files, entry, freeRoam, css };
}
