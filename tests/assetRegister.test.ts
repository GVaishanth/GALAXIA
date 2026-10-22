/**
 * Free Roam Prompt 15: keeps docs/freeroam/CONTENT_AND_ASSET_LICENSES.md in
 * step with the repository, and guards Classic/Free Roam asset separation.
 * These are technical checks only: they prove an asset is *listed*, not that
 * its use is legally cleared (see docs/freeroam/IP_AND_ASSET_AUDIT.md).
 * Pure file inspection (offline).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const REGISTER = 'docs/freeroam/CONTENT_AND_ASSET_LICENSES.md';
const NOTICES = 'public/THIRD_PARTY_NOTICES.txt';
const register = read(REGISTER);
/** Internal review files kept in the source repository but not in the release archive (OD-19, ZIP README). */
const AUDIT = 'docs/freeroam/IP_AND_ASSET_AUDIT.md';
const hasAudit = existsSync(join(root, AUDIT));
const hasClaude = existsSync(join(root, '.claude'));

function filesUnder(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(root, rel)).isDirectory() ? filesUnder(rel) : [rel];
  });
}

describe('asset register (CONTENT_AND_ASSET_LICENSES.md)', () => {
  it('does not claim legal clearance', () => {
    expect(register).toMatch(/not (legal advice and not )?a? ?legal clearance|is not legal clearance/i);
  });

  it.skipIf(!hasAudit)('the IP audit exists beside it and does not claim legal clearance either (source repository only)', () => {
    expect(read(AUDIT)).toMatch(/not (legal advice and not )?a? ?legal clearance|is not legal clearance/i);
  });

  it('lists every file the site ships from public/', () => {
    const files = filesUnder('public').map((f) => f.slice('public/'.length));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(register, `public/${f} missing from the register`).toContain(`\`${f}\``);
  });

  it('the project has no runtime dependencies, and every devDependency is registered', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    for (const name of Object.keys(pkg.devDependencies ?? {})) expect(register, `${name} missing from the register`).toContain(`| \`${name}\` |`);
  });

  it('every package in the lockfile has a row in the dependency table', () => {
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, unknown> };
    const names = Object.keys(lock.packages).filter((k) => k.startsWith('node_modules/')).map((k) => k.slice(k.lastIndexOf('node_modules/') + 13));
    for (const name of new Set(names)) expect(register, `${name} missing from the dependency table`).toContain(`| \`${name}\` |`);
  });

  it.skipIf(!hasClaude)('every .claude skill folder and agent file is registered (source repository only)', () => {
    for (const dir of ['.claude/skills', '.claude/agents']) {
      if (!existsSync(join(root, dir))) continue;
      for (const name of readdirSync(join(root, dir))) {
        const stem = name.replace(/\.md$/, '');
        expect(register, `${dir}/${name} missing from the register`).toContain(`\`${stem}\``);
      }
    }
  });
});

describe('no unregistered media in the source tree', () => {
  it('src/ contains no image, audio or font files (all art and sound are code-defined)', () => {
    const media = filesUnder('src').filter((f) => /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|mp3|ogg|wav|flac|m4a|aac|opus|woff2?|ttf|otf|eot)$/i.test(f));
    expect(media).toEqual([]);
  });

  it('no stylesheet or document loads a font file', () => {
    expect(read('src/styles.css')).not.toMatch(/@font-face|url\([^)]*\.(woff2?|ttf|otf)/i);
    expect(read('index.html')).not.toMatch(/@font-face|\.(woff2?|ttf|otf)\b/i);
  });
});

describe('shipped licence notices (public/THIRD_PARTY_NOTICES.txt)', () => {
  const notices = read(NOTICES);
  it('preserves the Vite MIT notice for the module-preload helper in the bundle', () => {
    const viteCopyright = 'Copyright (c) 2019-present, VoidZero Inc. and Vite contributors';
    expect(notices).toContain(viteCopyright);
    expect(notices).toContain('Permission is hereby granted, free of charge');
    expect(notices).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    const viteLicence = join(root, 'node_modules/vite/LICENSE.md');
    if (existsSync(viteLicence)) expect(readFileSync(viteLicence, 'utf8')).toContain(viteCopyright);
  });
  it('credits the astronomy publishers, states no endorsement and the no-affiliation homage status', () => {
    for (const name of ['NASA', 'ESA/Webb', 'ESA/Hubble', 'ESO', 'NOIRLab', 'CC BY 4.0']) expect(notices).toContain(name);
    expect(notices).toMatch(/endorse/i);
    expect(notices).toMatch(/not affiliated/i);
  });
  it('the deploy workflow verifies the notices are in the published build', () => {
    // FR-TD-80: the workflow runs scripts/verify-dist.ts, which fails without the Vite notice
    expect(read('.github/workflows/deploy.yml')).toContain('npm run verify:dist');
    const check = read('scripts/lib/distCheck.ts');
    expect(check).toContain("'THIRD_PARTY_NOTICES.txt'");
    expect(check).toContain("includes('Vite contributors')");
  });
});

describe('Classic / Free Roam asset separation', () => {
  /** Classic-specific art (formation enemies, transforms, beam, dual fighter, badges) stays Classic-only. */
  const CLASSIC_ONLY = /'(enemy\.(scout|interceptor|commander)|special\.[a-z]+|fx\.beam\.tractor|player\.dual)'|from '[./]*\/assets\/(insignia|sprites\/(enemies|specials))\.ts'/;
  it('Free Roam code references no Classic-only sprite, transform, beam or insignia', () => {
    const offenders = filesUnder('src/modes/freeroam').filter((f) => f.endsWith('.ts') && CLASSIC_ONLY.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
