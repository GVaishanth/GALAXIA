/**
 * FR Prompt 16: the production-build verifier (scripts/lib/distCheck.ts).
 * Synthetic dist folders in a temp dir; no Vite build, no network.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { CHUNK_BUDGETS, checkDist, chunkImports, chunkName, DIST_BUDGET, GRAVITY_LAB_MARKER, resolveHtmlUrl } from '../scripts/lib/distCheck.ts';
import { LAB_MARKER } from '../src/modes/freeroam/gravity/labShell.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Files = Record<string, string>;

function goodBuild(base: string): Files {
  const p = base === './' ? './' : base;
  return {
    'index.html': `<!doctype html><link rel="icon" href="${p}favicon.svg"><link rel="icon" href="${p}favicon-32.png"><link rel="apple-touch-icon" href="${p}apple-touch-icon.png"><script type="module" crossorigin src="${p}assets/index-AAA.js"></script><link rel="stylesheet" crossorigin href="${p}assets/index-BBB.css">`,
    '404.html': base === './' ? '<p>not found</p>' : `<script>location.replace(${JSON.stringify(base)});</script>`,
    'favicon.svg': '<svg/>',
    'favicon-32.png': 'png',
    'apple-touch-icon.png': 'png',
    'THIRD_PARTY_NOTICES.txt': 'Copyright (c) 2019-present, VoidZero Inc. and Vite contributors',
    'assets/index-AAA.js': 'const m={freeroam:()=>p(()=>import(`./freeRoamMode-CCC.js`).then(e=>e.createFreeRoamMode),[])};',
    'assets/index-BBB.css': 'body{background:#000}',
    // P10.1: Free Roam loads its two lazy chunks by dynamic import; each carries its inventory marker
    'assets/freeRoamMode-CCC.js': 'export function createFreeRoamMode(){}const t=()=>p(()=>import(`./tow-T0w_0w-1.js`),[]),s=()=>p(()=>import(`./shipyard-SHPyrd01.js`),[]);export{a};',
    'assets/tow-T0w_0w-1.js': `import{a as e}from"./freeRoamMode-CCC.js";const l=[\`${TOW_MARKER}\`];`,
    'assets/shipyard-SHPyrd01.js': `import{a as e}from"./freeRoamMode-CCC.js";const l=\`${BAY_MARKER}\`;`,
  };
}

const TOW_MARKER = CHUNK_BUDGETS.find((c) => c.name === 'tow')!.marker!;
const BAY_MARKER = CHUNK_BUDGETS.find((c) => c.name === 'shipyard')!.marker!;
const gz = (t: string): number => gzipSync(Buffer.from(t), { level: 9 }).length;
/** Incompressible filler: a deterministic SHA-256 chain, hex-encoded. */
const hex = (chars: number): string => Array.from({ length: Math.ceil(chars / 64) }, (_, i) => createHash('sha256').update(`pad${i}`).digest('hex')).join('').slice(0, chars);
/** `head` + filler + `tail` whose gzip (level 9, as the verifier measures) is exactly `target` bytes (binary search on the filler length). */
let pool = '';
function gzipExactly(head: string, tail: string, target: number): string {
  pool ||= hex(520_000);
  const at = (n: number): string => `${head}${pool.slice(0, n)}${tail}`;
  let lo = 0;
  let hi = pool.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (gz(at(mid)) < target) lo = mid + 1;
    else hi = mid;
  }
  for (let n = lo; n < lo + 64; n++) {
    const g = gz(at(n));
    if (g === target) return at(n);
    if (g > target) break;
  }
  throw new Error(`no filler gives exactly ${target} gzip bytes`);
}

function makeDist(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), 'galaxia-dist-'));
  dirs.push(dir);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

describe('resolveHtmlUrl', () => {
  it('accepts base-prefixed and relative URLs', () => {
    expect(resolveHtmlUrl('/space-game/assets/a.js', '/space-game/')).toEqual({ path: 'assets/a.js' });
    expect(resolveHtmlUrl('./assets/a.js', './')).toEqual({ path: 'assets/a.js' });
    expect(resolveHtmlUrl('/favicon.svg', '/')).toEqual({ path: 'favicon.svg' });
    expect(resolveHtmlUrl('/g/a.js?v=1#x', '/g/')).toEqual({ path: 'a.js' });
  });
  it('rejects root-relative paths without the base, and off-site URLs', () => {
    expect(resolveHtmlUrl('/assets/a.js', '/galaxia/')).toHaveProperty('error');
    expect(resolveHtmlUrl('/assets/a.js', './')).toHaveProperty('error');
    expect(resolveHtmlUrl('https://cdn.example.com/a.js', '/galaxia/')).toHaveProperty('error');
    expect(resolveHtmlUrl('//cdn.example.com/a.js', '/galaxia/')).toHaveProperty('error');
  });
});

describe('checkDist', () => {
  it.each(['/galaxia/', '/any-repository-name/', '/', './'])('passes a correct build for base %s', (base) => {
    const r = checkDist(makeDist(goodBuild(base)), base);
    expect(r.problems).toEqual([]);
    expect(r.entry?.path).toBe('assets/index-AAA.js');
    expect(r.freeRoam?.path).toBe('assets/freeRoamMode-CCC.js');
  });

  it('fails a build made for another repository name', () => {
    const r = checkDist(makeDist(goodBuild('/galaxia/')), '/renamed/');
    expect(r.problems.some((p) => p.includes('missing the base /renamed/'))).toBe(true);
    expect(r.problems.some((p) => p.includes('404.html should redirect to /renamed/'))).toBe(true);
  });

  it('fails missing assets, required files and dynamic-import targets', () => {
    const f = goodBuild('/galaxia/');
    delete f['assets/index-BBB.css'];
    delete f['favicon-32.png'];
    f['assets/index-AAA.js'] += 'const deps=["assets/gone-XYZ.js"];import(`./missing-1.js`);';
    const r = checkDist(makeDist(f), '/galaxia/');
    expect(r.problems).toEqual(expect.arrayContaining([
      'required file missing: favicon-32.png',
      'index.html: /galaxia/assets/index-BBB.css -> assets/index-BBB.css does not exist',
      'assets/index-AAA.js: references assets/gone-XYZ.js, which does not exist',
      'assets/index-AAA.js: imports ./missing-1.js, which does not exist',
    ]));
  });

  it('fails CSS urls that ignore the base or point off-site', () => {
    const f = goodBuild('/galaxia/');
    f['assets/index-BBB.css'] = 'a{background:url(/img/a.png)}b{background:url(https://x.test/b.png)}c{background:url(data:image/png;base64,AA)}';
    const r = checkDist(makeDist(f), '/galaxia/');
    expect(r.problems).toEqual(expect.arrayContaining([
      'assets/index-BBB.css: url(/img/a.png) is missing the base /galaxia/',
      'assets/index-BBB.css: url(https://x.test/b.png) points off-site',
    ]));
    expect(r.problems.some((p) => p.includes('data:'))).toBe(false);
  });

  it('fails developer-only output: Hangar, source maps, loopback hosts, unreplaced flags, orphans', () => {
    const f = goodBuild('/galaxia/');
    f['assets/hangar-H1.js'] = '"GALAXIA · Hangar"';
    f['assets/index-AAA.js'] += 'fetch("http://localhost:5173/x");if(__GALAXIA_DEV_TOOLS__){}\n//# sourceMappingURL=index.js.map';
    f['assets/index-AAA.js.map'] = '{}';
    const r = checkDist(makeDist(f), '/galaxia/');
    const all = r.problems.join('\n');
    expect(all).toContain('developer Hangar chunk shipped: assets/hangar-H1.js');
    expect(all).toContain('contains a loopback host');
    expect(all).toContain('links a source map');
    expect(all).toContain('source map shipped');
    expect(all).toContain('__GALAXIA_DEV_TOOLS__ was not replaced');
    expect(all).toContain('unreferenced asset (dead download weight): assets/hangar-H1.js');
  });

  it('fails a build that ships the automation hooks (TD-78); the boot watchdog flag is not a hook', () => {
    const ok = goodBuild('/galaxia/');
    ok['assets/index-AAA.js'] += 'window.__galaxiaBooted=!0;';
    expect(checkDist(makeDist(ok), '/galaxia/').problems.filter((p) => p.includes('hook'))).toEqual([]);
    const f = goodBuild('/galaxia/');
    f['assets/index-AAA.js'] += 'window.__galaxia=h;window.__galaxiaGame=s;if(__GALAXIA_TEST_HOOKS__){}';
    f['assets/freeRoamMode-CCC.js'] += 'window.__galaxiaFreeRoam=r;';
    const all = checkDist(makeDist(f), '/galaxia/').problems.join('\n');
    expect(all).toContain('assets/index-AAA.js: test hook __galaxia shipped');
    expect(all).toContain('assets/index-AAA.js: test hook __galaxiaGame shipped');
    expect(all).toContain('assets/freeRoamMode-CCC.js: test hook __galaxiaFreeRoam shipped');
    expect(all).toContain('__GALAXIA_TEST_HOOKS__ was not replaced');
  });

  it('fails a release build that contains the Gravity Flight lab or its unreplaced flag (FR-TD-83)', () => {
    expect(GRAVITY_LAB_MARKER).toBe(LAB_MARKER);
    const f = goodBuild('/galaxia/');
    f['assets/freeRoamMode-CCC.js'] += `const m="${LAB_MARKER}";if(__GALAXIA_GRAVITY_LAB__){}`;
    const all = checkDist(makeDist(f), '/galaxia/').problems.join('\n');
    expect(all).toContain('assets/freeRoamMode-CCC.js: contains the experimental Gravity Flight lab');
    expect(all).toContain('__GALAXIA_GRAVITY_LAB__ was not replaced');
  });

  it('fails when Free Roam is bundled into the entry instead of lazy-loaded', () => {
    const f = goodBuild('/galaxia/');
    delete f['assets/freeRoamMode-CCC.js'];
    f['assets/index-AAA.js'] = 'function createFreeRoamMode(){}';
    const r = checkDist(makeDist(f), '/galaxia/');
    expect(r.problems).toContain('no separate Free Roam chunk (assets/freeRoamMode-*.js): Free Roam would load with the title screen');
    expect(r.problems).toContain('Free Roam code is bundled into the entry chunk');
  });

  it('a relative build must not redirect its 404 page; an absolute build must', () => {
    const rel = goodBuild('./');
    rel['404.html'] = '<script>location.replace("/");</script>';
    expect(checkDist(makeDist(rel), './').problems).toContain('404.html redirects in a relative build (the base is unknown there)');
    const abs = goodBuild('/galaxia/');
    abs['404.html'] = '<p>gone</p>';
    expect(checkDist(makeDist(abs), '/galaxia/').problems).toContain('404.html should redirect to /galaxia/ (found no redirect)');
  });

  it('enforces the gzip budget on the entry chunk', () => {
    const f = goodBuild('/galaxia/');
    // incompressible filler: a deterministic SHA-256 chain, hex-encoded
    const filler = Array.from({ length: Math.ceil((DIST_BUDGET.entryJsGzip * 2.5) / 64) }, (_, i) => createHash('sha256').update(`pad${i}`).digest('hex')).join('');
    f['assets/index-AAA.js'] += `const pad=\`${filler}\`;`;
    const r = checkDist(makeDist(f), '/galaxia/');
    expect(r.problems.some((p) => /^entry JS .* gzip exceeds/.test(p))).toBe(true);
  });

  it('reports a missing build instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'galaxia-empty-'));
    dirs.push(dir);
    expect(checkDist(dir, '/galaxia/').problems[0]).toMatch(/index\.html does not exist/);
  });
});

describe('chunk inventory and Free Roam budgets (P10.1)', () => {
  const FR = 'assets/freeRoamMode-CCC.js';
  const TOW = 'assets/tow-T0w_0w-1.js';
  const BAY = 'assets/shipyard-SHPyrd01.js';

  it('names chunks by Vite\'s 8-character hash (which may contain - or _) and reads static and dynamic chunk imports', () => {
    expect(chunkName('assets/index--qQzb6v-.js')).toBe('index');
    expect(chunkName('assets/tow-B65Y_qlS.js')).toBe('tow');
    expect(chunkName('assets/guideDialog-CC9g_nd-.js')).toBe('guideDialog');
    expect(chunkImports('assets/a.js', 'import{x}from"./b-1.js";import"./c.js";const d=()=>import(`./d.js`),e=()=>import("./e.js");')).toEqual({ static: ['assets/b-1.js', 'assets/c.js'], dynamic: ['assets/d.js', 'assets/e.js'] });
  });

  it('lists every chunk with its kind and limit; the eager closure and the full payload are reported', () => {
    const f = goodBuild('/galaxia/');
    const r = checkDist(makeDist(f), '/galaxia/');
    expect(r.problems).toEqual([]);
    const kinds = Object.fromEntries(r.chunks.map((c) => [c.path, [c.kind, c.limit]]));
    expect(kinds).toEqual({
      'assets/index-AAA.js': ['entry', DIST_BUDGET.entryJsGzip],
      [FR]: ['freeRoam', DIST_BUDGET.freeRoamJsGzip],
      [TOW]: ['lazy', 2_500],
      [BAY]: ['lazy', 13_000],
    });
    expect(r.freeRoamEager).toBe(gz(f[FR]!));
    expect(r.freeRoamTotal).toBe(gz(f[FR]!) + gz(f[TOW]!) + gz(f[BAY]!));
  });

  it('fails a JavaScript chunk that is not in the inventory, and a duplicated inventory name', () => {
    const f = goodBuild('/galaxia/');
    f[FR] += 'const x=()=>import(`./extra-ABCDEFGH.js`),y=()=>import(`./tow-ZZZZZZZZ.js`);';
    f['assets/extra-ABCDEFGH.js'] = 'export const q=1;';
    f['assets/tow-ZZZZZZZZ.js'] = `const l=\`${TOW_MARKER}\`;`;
    const all = checkDist(makeDist(f), '/galaxia/').problems.join('\n');
    expect(all).toContain('assets/extra-ABCDEFGH.js: JS chunk not in the chunk inventory');
    expect(all).toContain('more than one tow-*.js chunk');
  });

  it('fails when a required lazy chunk is missing (its code was bundled back into Free Roam)', () => {
    const f = goodBuild('/galaxia/');
    delete f[TOW];
    f[FR] = f[FR]!.replace('import(`./tow-T0w_0w-1.js`)', `[\`${TOW_MARKER}\`]`);
    const all = checkDist(makeDist(f), '/galaxia/').problems.join('\n');
    expect(all).toContain('required chunk tow-*.js missing (ship recovery: towing (a sector with an unrecovered hull)): its code is no longer split from Free Roam');
  });

  it('fails a lazy chunk that Free Roam (or the title screen) imports statically, and lazy code inside an eager chunk', () => {
    const f = goodBuild('/galaxia/');
    f[FR] = `import"./tow-T0w_0w-1.js";${f[FR]!}const k=\`${BAY_MARKER}\`;`;
    const all = checkDist(makeDist(f), '/galaxia/').problems.join('\n');
    expect(all).toContain(`${TOW}: the ship recovery: towing (a sector with an unrecovered hull) chunk is loaded eagerly`);
    expect(all).toContain(`${FR}: carries code of the lazy shipyard chunk (marker "${BAY_MARKER}")`);
    const t = goodBuild('/galaxia/');
    t['assets/index-AAA.js'] += 'import"./shipyard-SHPyrd01.js";';
    expect(checkDist(makeDist(t), '/galaxia/').problems.join('\n')).toContain(`${BAY}: the Hangar panel (first dock) chunk is loaded eagerly`);
  });

  it('fails an inventory entry that no longer matches the build: marker gone, nobody imports it, wrong load type', () => {
    const f = goodBuild('/galaxia/');
    f[TOW] = 'export const nothing=1;';
    f[FR] = f[FR]!.replace('import(`./shipyard-SHPyrd01.js`)', '0');
    f['assets/world-W0rld000.js'] = 'export const w=1;';
    f[FR] += 'const w=()=>import(`./world-W0rld000.js`);';
    f['assets/guideDialog-GD000000.js'] = 'export const g=1;';
    f[FR] = `import"./guideDialog-GD000000.js";${f[FR]!}`;
    const all = checkDist(makeDist(f), '/galaxia/').problems.join('\n');
    expect(all).toContain(`${TOW}: marker "${TOW_MARKER}" not found`);
    expect(all).toContain(`${BAY}: no Free Roam chunk imports it dynamically`);
    expect(all).toContain('assets/world-W0rld000.js: listed as eager Free Roam code, but the build loads it lazily or not at all');
    expect(all).toContain('assets/guideDialog-GD000000.js: listed as shared with the title screen, but the entry never loads it');
  });

  it('charges eager side chunks to Free Roam, not shared title chunks; the total includes every Free Roam chunk', () => {
    const f = goodBuild('/galaxia/');
    f['assets/world-W0rld000.js'] = 'export const w=1;';
    f['assets/guideDialog-GD000000.js'] = 'export const g=1;';
    f[FR] = `import"./world-W0rld000.js";import"./guideDialog-GD000000.js";${f[FR]!}`;
    f['assets/index-AAA.js'] += 'const g=()=>import(`./guideDialog-GD000000.js`);';
    const r = checkDist(makeDist(f), '/galaxia/');
    expect(r.problems).toEqual([]);
    const size = (p: string): number => gz(f[p]!);
    expect(r.freeRoamEager).toBe(size(FR) + size('assets/world-W0rld000.js'));
    expect(r.freeRoamTotal).toBe(size(FR) + size('assets/world-W0rld000.js') + size('assets/guideDialog-GD000000.js') + size(TOW) + size(BAY));
  });

  it('fails Free Roam\'s eager closure over 225 kB even when its own chunk is under it', () => {
    const f = goodBuild('/galaxia/');
    f[FR] = gzipExactly(`import"./world-W0rld000.js";${f[FR]!}const pad=\``, '`;', DIST_BUDGET.freeRoamJsGzip - 4_000);
    f['assets/world-W0rld000.js'] = gzipExactly('const pad=`', '`;', 5_000);
    const r = checkDist(makeDist(f), '/galaxia/');
    expect(r.freeRoam!.gzip).toBeLessThanOrEqual(DIST_BUDGET.freeRoamJsGzip);
    expect(r.problems.filter((p) => p.includes('Free Roam JS'))).toEqual([]);
    expect(r.problems.some((p) => p.startsWith('Free Roam eager JS') && p.includes('exceeds the 225.0 kB budget'))).toBe(true);
  });

  it('gzip boundaries: a chunk exactly at its limit passes, one byte over fails (gzip level 9)', () => {
    const tow = CHUNK_BUDGETS.find((c) => c.name === 'tow')!;
    const head = `import{a as e}from"./freeRoamMode-CCC.js";const l=[\`${TOW_MARKER}\`],pad=\``;
    const at = goodBuild('/galaxia/');
    at[TOW] = gzipExactly(head, '`;', tow.gzip);
    const ra = checkDist(makeDist(at), '/galaxia/');
    expect(ra.chunks.find((c) => c.path === TOW)!.gzip).toBe(tow.gzip);
    expect(ra.problems).toEqual([]);
    const over = goodBuild('/galaxia/');
    over[TOW] = gzipExactly(head, '`;', tow.gzip + 1);
    expect(checkDist(makeDist(over), '/galaxia/').problems).toEqual([`${TOW} 2.5 kB gzip exceeds its 2.5 kB budget`]);
    const fr = goodBuild('/galaxia/');
    fr[FR] = gzipExactly(`${fr[FR]!}const pad=\``, '`;', DIST_BUDGET.freeRoamJsGzip);
    expect(checkDist(makeDist(fr), '/galaxia/').problems).toEqual([]);
    fr[FR] = gzipExactly(`${goodBuild('/galaxia/')[FR]!}const pad=\``, '`;', DIST_BUDGET.freeRoamJsGzip + 1);
    const all = checkDist(makeDist(fr), '/galaxia/').problems;
    expect(all.some((p) => p.startsWith('Free Roam JS 225.0 kB gzip exceeds'))).toBe(true);
    expect(all.some((p) => p.startsWith('Free Roam eager JS'))).toBe(true);
  });

  it('the inventory is explicit: every entry has a role, a positive limit, and the lazy ones a marker', () => {
    for (const c of CHUNK_BUDGETS) {
      expect(c.role.length).toBeGreaterThan(5);
      expect(c.gzip).toBeGreaterThan(0);
      if (c.load === 'lazy') expect(c.marker && c.required).toBeTruthy();
    }
    expect(CHUNK_BUDGETS.find((c) => c.name === 'tow')!.gzip).toBeLessThanOrEqual(6_000);
    expect(DIST_BUDGET).toEqual({ entryJsGzip: 110_000, freeRoamJsGzip: 225_000, cssGzip: 25_000, totalBytes: 1_500_000 });
  });
});
