/**
 * Stage 7 release checks: base path, browser metadata, icons, no hardcoded
 * hosts, and the GitHub Pages workflow contract. Pure file inspection (offline).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBase } from '../vite.config.ts';
import { DEV_TOOLS } from '../src/config/buildFlags.ts';

const root = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

function filesUnder(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(root, rel)).isDirectory() ? filesUnder(rel) : [rel];
  });
}

describe('base path (vite.config.ts resolveBase)', () => {
  it('dev server always serves at the root', () => {
    expect(resolveBase('dev', '/galaxia/')).toBe('/');
    expect(resolveBase('dev', undefined)).toBe('/');
  });
  it('preview uses the same base as the build (regression: preview is also command "serve")', () => {
    expect(resolveBase('preview', '/galaxia/')).toBe('/galaxia/');
    expect(resolveBase('preview', undefined)).toBe('./');
  });
  it('project pages, user pages, custom domains and relative builds', () => {
    expect(resolveBase('build', '/galaxia/')).toBe('/galaxia/');
    expect(resolveBase('build', '/galaxia')).toBe('/galaxia/'); // configure-pages gives "/repo"; workflow appends "/"
    expect(resolveBase('build', 'galaxia')).toBe('/galaxia/');
    expect(resolveBase('build', '/')).toBe('/'); // "" + "/" from configure-pages on user/org pages
    expect(resolveBase('build', '//')).toBe('/');
    expect(resolveBase('build', '/a/b//')).toBe('/a/b/');
    expect(resolveBase('build', undefined)).toBe('./');
    expect(resolveBase('build', '  ')).toBe('./');
    expect(resolveBase('build', 'https://cdn.example.com/g')).toBe('https://cdn.example.com/g/');
  });
});

describe('index.html metadata and icons', () => {
  const html = read('index.html');
  it('has the GALAXIA title, description, theme colour and viewport', () => {
    expect(html).toMatch(/<title>GALAXIA[^<]*<\/title>/);
    expect(html).toMatch(/<meta name="description" content="GALAXIA[^"]+"/);
    expect(html).toMatch(/<meta name="theme-color" content="#06070f"/);
    expect(html).toMatch(/<meta name="viewport" content="[^"]*width=device-width/);
  });
  it('icons are public/ files referenced root-relatively (Vite prefixes the base at build time)', () => {
    const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThanOrEqual(3);
    for (const href of hrefs) {
      expect(href.startsWith('/')).toBe(true);
      expect(existsSync(join(root, 'public', href))).toBe(true);
    }
  });
  it('loads no external resources and shows loading / failure states', () => {
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(html).toContain('class="boot"');
    expect(html).toContain('<noscript>');
    expect(html).toContain('__galaxiaBooted'); // boot watchdog
  });
});

describe('source hygiene', () => {
  it('no hardcoded localhost / loopback URLs or absolute asset paths in shipped source', () => {
    for (const f of filesUnder('src')) {
      const text = read(f);
      expect(text, f).not.toMatch(/localhost|127\.0\.0\.1/);
      expect(text, f).not.toMatch(/(?:src|href)\s*=\s*['"]\/(?!\/)/);
    }
  });
  it('developer tools are enabled in tests (and compiled out of release builds, see TD-49)', () => {
    expect(DEV_TOOLS).toBe(true);
    const main = read('src/main.ts');
    expect(main).toMatch(/if \(__GALAXIA_DEV_TOOLS__ && DEV_TOOLS && view/);
    expect(main).toContain("import('./showcase/hangar.ts')"); // dynamic, so it is tree-shaken
    expect(main).not.toMatch(/^import (?!type ).*showcase\/hangar\.ts';$/m); // only a type import (erased)
  });
});

describe('GitHub Pages workflow (.github/workflows/deploy.yml)', () => {
  const wf = read('.github/workflows/deploy.yml');
  it('runs on pushes to main and manually', () => {
    expect(wf).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(wf).toContain('workflow_dispatch:');
  });
  it('uses least-privilege permissions and the github-pages environment', () => {
    expect(wf).toMatch(/^permissions:\s*\n\s*contents: read/m);
    expect(wf).toMatch(/pages: write/);
    expect(wf).toMatch(/id-token: write/);
    expect(wf).toMatch(/environment:\s*\n\s*name: github-pages/);
    expect(wf).not.toMatch(/contents: write/);
  });
  it('pins every action to a full commit SHA from the official actions org', () => {
    const uses = [...wf.matchAll(/uses: ([^\s@]+)@(\S+)/g)];
    expect(uses.map((u) => u[1])).toEqual(['actions/checkout', 'actions/setup-node', 'actions/configure-pages', 'actions/upload-pages-artifact', 'actions/deploy-pages']);
    for (const u of uses) expect(u[2]).toMatch(/^[0-9a-f]{40}$/);
  });
  it('installs from the lockfile, tests before building, uploads only dist/', () => {
    const order = ['npm ci', 'npm run typecheck', 'npm test', 'vite build', 'npm run verify:dist', 'upload-pages-artifact'].map((s) => wf.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(wf).toMatch(/node-version-file: \.nvmrc/);
    expect(wf).toMatch(/BASE_PATH: \$\{\{ steps\.pages\.outputs\.base_path \}\}\//);
    // the verifier checks the SAME base the build used (FR-TD-80)
    expect([...wf.matchAll(/BASE_PATH: \$\{\{ steps\.pages\.outputs\.base_path \}\}\//g)].length).toBe(2);
    expect(wf).toMatch(/with:\s*\n\s*path: dist\s*$/m);
    expect(existsSync(join(root, 'package-lock.json'))).toBe(true);
  });
  it('contains no secrets or tokens', () => {
    expect(wf).not.toMatch(/secrets\.|ghp_|github_pat_|GITHUB_TOKEN/);
  });
});

describe('automation hooks stay out of the release build (TD-78)', () => {
  const read = (p: string): string => readFileSync(join(root, p), 'utf8');
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(`${dir}/${d.name}`) : d.name.endsWith('.ts') ? [`${dir}/${d.name}`] : []));
  it('every window.__galaxia* assignment or delete in src/ is guarded by a build-flag literal', () => {
    const bad: string[] = [];
    let sites = 0;
    for (const f of files('src')) {
      for (const line of read(f).split('\n')) {
        if (!/window\.__galaxia\w*\s*=(?!=)|delete window\.__galaxia/.test(line) || /__galaxiaBooted/.test(line)) continue;
        sites += 1;
        if (!/if \(__GALAXIA_(TEST_HOOKS|DEV_TOOLS)__/.test(line) && !/^\s*window\.__galaxiaHangar = mountHangar/.test(line)) bad.push(`${f}: ${line.trim()}`);
      }
    }
    expect(sites).toBeGreaterThanOrEqual(5); // host, Classic (set / delete), Free Roam (set / delete), Hangar
    expect(bad).toEqual([]);
  });
  it('the hooks exist in dev, tests, qa and e2e builds only; e2e builds into dist-e2e/', () => {
    const cfg = read('vite.config.ts');
    expect(cfg).toMatch(/const testHooks = devTools \|\| mode === 'e2e';/);
    expect(cfg).toMatch(/__GALAXIA_TEST_HOOKS__: JSON\.stringify\(testHooks\)/);
    expect(cfg).toMatch(/outDir: mode === 'e2e' \? 'dist-e2e' : 'dist'/);
    expect(read('.gitignore')).toMatch(/^dist-e2e\/$/m);
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build']).not.toMatch(/--mode/);
    expect(pkg.scripts['build:e2e']).toMatch(/vite build --mode e2e/);
  });
  it('the Hangar hook sits inside the DEV_TOOLS branch (dropped with the Hangar chunk)', () => {
    expect(read('src/main.ts')).toMatch(/if \(__GALAXIA_DEV_TOOLS__ && DEV_TOOLS[\s\S]*window\.__galaxiaHangar = mountHangar/);
  });
});
