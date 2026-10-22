/**
 * FR Prompt 16: the production-build verifier (scripts/lib/distCheck.ts).
 * Synthetic dist folders in a temp dir; no Vite build, no network.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDist, DIST_BUDGET, resolveHtmlUrl } from '../scripts/lib/distCheck.ts';

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
    'assets/freeRoamMode-CCC.js': 'export function createFreeRoamMode(){}',
  };
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
