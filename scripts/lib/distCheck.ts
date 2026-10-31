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
 *   - gzip sizes stay inside the release budget;
 *   - P10.1: every other JavaScript chunk is in CHUNK_BUDGETS (role, load
 *     type, gzip limit), read from the real import graph of the build: the
 *     lazy chunks are reached by dynamic import only and their code is in no
 *     eager chunk, and Free Roam's eager closure (its chunk plus every chunk
 *     only it imports statically) stays inside the Free Roam budget too, so
 *     no eager code can hide in a side chunk. The full Free Roam payload
 *     (eager, shared and lazy) is reported, not budgeted against 225 kB.
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

/**
 * P10.1: the inventory of every first-party JavaScript chunk other than the entry
 * and Free Roam, by the name Vite gives it (`assets/<name>-<hash>.js`). Measured
 * 2026-10-25; limits are about 1.2x (the lazy recovery chunk about 1.7x of a
 * small number). A chunk that is not listed fails the check, so a new split is
 * always measured and budgeted on purpose.
 *   - `lazy`: reached only by dynamic import from Free Roam code; `marker` is a
 *     string only that chunk's code carries, and no eager chunk may contain it.
 *   - `eager`: statically imported by Free Roam only; it counts toward Free
 *     Roam's eager closure (FREE_ROAM_EAGER check).
 *   - `shared`: also loaded on its own by the entry (the title screen), so it
 *     is reported with Free Roam's download but not charged to its closure.
 *   - `required`: the build must emit it (the split exists).
 */
export interface ChunkBudget {
  readonly name: string;
  readonly role: string;
  readonly load: 'lazy' | 'eager' | 'shared';
  readonly gzip: number;
  readonly required: boolean;
  readonly marker?: string;
}
export const CHUNK_BUDGETS: readonly ChunkBudget[] = Object.freeze([
  { name: 'tow', role: 'ship recovery: towing (a sector with an unrecovered hull)', load: 'lazy', gzip: 2_500, required: true, marker: 'TOW LINE ON' }, // measured 1.5 kB
  { name: 'shipyard', role: 'Hangar panel (first dock)', load: 'lazy', gzip: 13_000, required: true, marker: 'LOCKED · RECOVERED, NEVER SOLD' }, // measured 11.0 kB
  { name: 'world', role: 'Free Roam modules shared with the recovery chunk', load: 'eager', gzip: 10_000, required: false }, // measured 8.3 kB
  { name: 'guideDialog', role: 'guide (title screen; Free Roam imports its content)', load: 'shared', gzip: 14_000, required: false }, // measured 11.8 kB
]);

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
  /** P10.1: every JS chunk with its role, load type and limit (null role: not in the inventory). */
  readonly chunks: ChunkReport[];
  /** Free Roam's chunk plus every chunk only it loads statically (gzip, limited like the Free Roam chunk). */
  readonly freeRoamEager: number;
  /** Everything Free Roam can download: eager closure, shared chunks and lazy chunks (reported only). */
  readonly freeRoamTotal: number;
}

export interface ChunkReport extends DistFile {
  readonly name: string;
  readonly kind: 'entry' | 'freeRoam' | 'lazy' | 'eager' | 'shared' | 'unlisted';
  readonly limit: number | null;
}

/** The `<name>` of `assets/<name>-<hash>.js` (Vite's default names: an 8-character hash that may itself contain `-` or `_`). */
export const chunkName = (path: string): string => posix.basename(path).replace(/-[A-Za-z0-9_-]{8}\.js$/, '');

/** Static (`from"./x.js"`, `import"./x.js"`) and dynamic (`import("./x.js")`) chunk imports of a minified ES chunk, as dist paths. */
export function chunkImports(path: string, code: string): { readonly static: string[]; readonly dynamic: string[] } {
  const dir = posix.dirname(path);
  const at = (m: string): string => posix.join(dir, m);
  const stat = [...code.matchAll(/(?:\bfrom|\bimport)\s*[`'"]\.\/([A-Za-z0-9._-]+\.js)[`'"]/g)].map((m) => at(m[1]!));
  const dyn = [...code.matchAll(/import\(\s*[`'"]\.\/([A-Za-z0-9._-]+\.js)[`'"]\s*\)/g)].map((m) => at(m[1]!));
  return { static: [...new Set(stat)], dynamic: [...new Set(dyn)] };
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
  const empty: DistReport = { base, problems, files: [], entry: null, freeRoam: null, css: [], chunks: [], freeRoamEager: 0, freeRoamTotal: 0 };
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
    // P10.1: a static chunk import (`from"./x.js"`, `import"./x.js"`) is a reference too
    if (p.endsWith('.js')) {
      for (const target of chunkImports(p, t).static) {
        if (!present.has(target)) problems.push(`${p}: imports ./${posix.basename(target)}, which does not exist`);
        else referenced.add(target);
      }
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

  // 4a. P10.1: the chunk inventory, read from the import graph.
  const js = files.filter((f) => f.path.startsWith('assets/') && f.path.endsWith('.js'));
  // edges to files that do not exist are reported above; the graph keeps real chunks only
  const graph = new Map(js.map((f) => {
    const g = chunkImports(f.path, read(f.path));
    return [f.path, { static: g.static.filter((q) => present.has(q)), dynamic: g.dynamic.filter((q) => present.has(q)) }];
  }));
  const staticClosure = (from: string): Set<string> => {
    const seen = new Set<string>();
    const walkTo = (p: string): void => {
      if (seen.has(p)) return;
      seen.add(p);
      for (const q of graph.get(p)?.static ?? []) walkTo(q);
    };
    walkTo(from);
    return seen;
  };
  const titleLoads = entry ? new Set([...staticClosure(entry.path), ...(graph.get(entry.path)?.dynamic ?? []).flatMap((d) => (d === freeRoam?.path ? [] : [...staticClosure(d)]))]) : new Set<string>();
  const frEager = freeRoam ? staticClosure(freeRoam.path) : new Set<string>();
  if (entry) frEager.delete(entry.path);
  const frAll = new Set(frEager);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of [...frAll]) {
      for (const d of graph.get(p)?.dynamic ?? []) {
        for (const q of staticClosure(d)) {
          if (q !== entry?.path && !frAll.has(q)) {
            frAll.add(q);
            grew = true;
          }
        }
      }
    }
  }
  const chunks: ChunkReport[] = js.map((f) => {
    const name = chunkName(f.path);
    if (f === entry) return { ...f, name, kind: 'entry', limit: DIST_BUDGET.entryJsGzip };
    if (f === freeRoam) return { ...f, name, kind: 'freeRoam', limit: DIST_BUDGET.freeRoamJsGzip };
    const b = CHUNK_BUDGETS.find((c) => c.name === name);
    return { ...f, name, kind: b ? b.load : 'unlisted', limit: b ? b.gzip : null };
  });
  for (const c of chunks) {
    if (c.kind === 'unlisted') problems.push(`${c.path}: JS chunk not in the chunk inventory (CHUNK_BUDGETS): measure it and give it a role and a gzip limit`);
    else if (c.limit !== null && c.gzip > c.limit) problems.push(`${c.path} ${kb(c.gzip)} gzip exceeds its ${kb(c.limit)} budget`);
  }
  for (const b of CHUNK_BUDGETS) {
    const found = chunks.filter((c) => c.name === b.name);
    if (found.length > 1) problems.push(`more than one ${b.name}-*.js chunk (${found.map((c) => c.path).join(', ')})`);
    if (found.length === 0) {
      if (b.required) problems.push(`required chunk ${b.name}-*.js missing (${b.role}): its code is no longer split from Free Roam`);
      continue;
    }
    const c = found[0]!;
    if (!freeRoam) continue;
    if (b.load === 'lazy') {
      if (frEager.has(c.path) || titleLoads.has(c.path)) problems.push(`${c.path}: the ${b.role} chunk is loaded eagerly (it must load by dynamic import only)`);
      else if (!frAll.has(c.path)) problems.push(`${c.path}: no Free Roam chunk imports it dynamically`);
      if (b.marker) {
        for (const p of [...frEager, ...titleLoads]) if (p !== c.path && read(p).includes(b.marker)) problems.push(`${p}: carries code of the lazy ${b.name} chunk (marker "${b.marker}")`);
        if (!read(c.path).includes(b.marker)) problems.push(`${c.path}: marker "${b.marker}" not found (the inventory no longer describes this chunk)`);
      }
    } else if (b.load === 'eager' && (!frEager.has(c.path) || titleLoads.has(c.path))) {
      problems.push(`${c.path}: listed as eager Free Roam code, but the build loads it ${titleLoads.has(c.path) ? 'with the title screen' : 'lazily or not at all'}`);
    } else if (b.load === 'shared' && !titleLoads.has(c.path)) {
      problems.push(`${c.path}: listed as shared with the title screen, but the entry never loads it`);
    }
  }
  const gz = (set: Iterable<string>): number => [...set].reduce((s, p) => s + (files.find((f) => f.path === p)?.gzip ?? 0), 0);
  const freeRoamEager = gz([...frEager].filter((p) => !titleLoads.has(p)));
  const freeRoamTotal = gz(frAll);
  if (freeRoam && freeRoamEager > DIST_BUDGET.freeRoamJsGzip) {
    problems.push(`Free Roam eager JS ${kb(freeRoamEager)} gzip (its chunk and the chunks only it loads statically) exceeds the ${kb(DIST_BUDGET.freeRoamJsGzip)} budget`);
  }

  if (entry && entry.gzip > DIST_BUDGET.entryJsGzip) problems.push(`entry JS ${kb(entry.gzip)} gzip exceeds the ${kb(DIST_BUDGET.entryJsGzip)} budget`);
  if (freeRoam && freeRoam.gzip > DIST_BUDGET.freeRoamJsGzip) problems.push(`Free Roam JS ${kb(freeRoam.gzip)} gzip exceeds the ${kb(DIST_BUDGET.freeRoamJsGzip)} budget`);
  const cssGzip = css.reduce((s, f) => s + f.gzip, 0);
  if (cssGzip > DIST_BUDGET.cssGzip) problems.push(`CSS ${kb(cssGzip)} gzip exceeds the ${kb(DIST_BUDGET.cssGzip)} budget`);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  if (total > DIST_BUDGET.totalBytes) problems.push(`build is ${kb(total)}, over the ${kb(DIST_BUDGET.totalBytes)} budget`);

  return { base, problems, files, entry, freeRoam, css, chunks, freeRoamEager, freeRoamTotal };
}
