/**
 * Release source archive (scripts/lib/releaseZip.ts): `.claude/` is never
 * packaged, at any depth or letter case, and the verifier rejects any archive
 * that contains it. Archives here are built in memory from synthetic files;
 * no release ZIP is written.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildArchive,
  buildReleaseArchive,
  checkArchiveNames,
  CLAUDE_SEGMENT_RE,
  excludedReason,
  FALLBACK_TIMESTAMP,
  gitCandidates,
  isInside,
  normalizePath,
  readArchiveData,
  readArchiveEntries,
  RELEASE_ROOT,
  releaseFiles,
  releaseTimestamp,
  REQUIRED_FILES,
  verifyArchive,
  type ArchiveInput,
} from '../scripts/lib/releaseZip.ts';

const REPO = new URL('..', import.meta.url).pathname;
const T = new Date(2026, 9, 23, 12, 0, 0);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const entry = (rel: string, text = `// ${rel}\n`): ArchiveInput => ({ name: `${RELEASE_ROOT}/${rel}`, data: enc(text), mtime: T });
/** A minimal archive that passes every check. */
const goodEntries = (): ArchiveInput[] => [...REQUIRED_FILES.map((f) => entry(f, f === 'README.md' ? '# GALAXIA\n' : `${f}\n`)), entry('src/main.ts'), entry('tests/a.test.ts')];

const CLAUDE_PATHS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/skills/impeccable/SKILL.md',
  '.claude/skills/impeccable/scripts/.hidden',
  '.claude/agents/deep/nested/agent.md',
  '.CLAUDE/upper.md',
  '.Claude/mixed.md',
  'src/.claude/copied.ts',
  'src/modes/.claude/skills/x.md',
  'tests/fixtures/.claude/settings.json',
  'scripts/.Claude/hook.sh',
  'public/.claude/icon.png',
  'docs/.claude/notes.md',
  'src/.claude',
];

describe('file selection', () => {
  it('drops every .claude path, at any depth and in any letter case', () => {
    const sel = releaseFiles([...CLAUDE_PATHS, 'src/main.ts', 'README.md', 'tests/a.test.ts']);
    expect(sel.files).toEqual(['README.md', 'src/main.ts', 'tests/a.test.ts']);
    for (const p of CLAUDE_PATHS) expect(sel.excluded.map((e) => e.path)).toContain(p);
    for (const f of sel.files) expect(f).not.toMatch(CLAUDE_SEGMENT_RE);
  });

  it('normalises Windows separators and ./ before matching', () => {
    const sel = releaseFiles(['src\\.claude\\x.ts', './src/.claude/y.ts', '.\\README.md']);
    expect(sel.files).toEqual(['README.md']);
    expect(sel.excluded).toHaveLength(2);
  });

  it('other hard exclusions apply inside included folders too', () => {
    for (const p of ['src/node_modules/a.js', 'src/dist/x.js', 'tests/.git/config', 'src/debug.log', 'public/.env', 'public/.env.production', 'public/bundle.zip', 'scripts/old.tar.gz', 'src/.DS_Store', 'src/.vscode/settings.json']) {
      expect(excludedReason(p), p).not.toBeNull();
      expect(releaseFiles([p]).files, p).toEqual([]);
    }
    for (const p of ['src/main.ts', 'src/claude.ts', 'src/claudeNotes/x.ts', 'public/icons/icon-192.png']) expect(excludedReason(p), p).toBeNull();
  });

  it('never packages credentials, caches, scratch files, other assistant folders or an older release ZIP', () => {
    const bad = [
      'public/.npmrc', '.netrc', 'scripts/.git-credentials', 'src/id_rsa', 'src/id_ed25519.pub', 'public/server.pem', 'scripts/deploy.key', 'tests/fixtures/cert.p12',
      'public/credentials.json', 'scripts/secrets.yaml', 'src/.ssh/config', 'src/.aws/credentials',
      'src/.cache/x.json', 'src/.vite/deps.json', 'scripts/__pycache__/a.pyc', 'src/.eslintcache', 'tests/.nyc_output/out.json',
      'src/main.ts.tmp', 'src/main.ts.swp', 'src/main.ts~', 'src/main.ts.bak', 'src/main.ts.orig', 'public/Thumbs.db', 'src/desktop.ini',
      'src/.cursor/rules.md', 'scripts/.windsurf/x', 'src/.gemini/settings.json', 'src/.codex/config.toml', 'src/CLAUDE.md', 'tests/AGENTS.md', 'scripts/CLAUDE.local.md',
      'GALAXIA-Game-Release.zip', 'scripts/GALAXIA-Game-Release-P03.zip', 'public/old/GALAXIA-Game-Release.ZIP',
    ];
    for (const p of bad) {
      expect(excludedReason(p), p).not.toBeNull();
      expect(releaseFiles([p]).files, p).toEqual([]);
    }
    // ordinary game files with similar names stay in
    const good = ['src/input/keyboard.ts', 'src/input/keys.ts', 'src/config/secretsOfTheGalaxy.ts', 'tests/fixtures/sector-layout-v2.json', 'src/modes/freeroam/progression/ledger.ts', 'public/THIRD_PARTY_NOTICES.txt', 'docs/PLAYER_GUIDE.md', 'scripts/lib/releaseZip.ts'];
    for (const p of good) expect(excludedReason(p), p).toBeNull();
    expect(releaseFiles(good).files).toEqual([...good].sort());
  });

  it('keeps the established include list plus the player guide (no internal or admin docs, only the release harnesses)', () => {
    const sel = releaseFiles([
      'docs/freeroam/TECHNICAL_DECISIONS.md', 'docs/development/ADMIN_ACCESS.md', 'docs/development/playtest/admin-access-p04.mjs', 'docs/development/playtest/guide-p042.mjs',
      'docs/development/playtest/release-smoke.mjs', 'docs/freeroam/CONTENT_AND_ASSET_LICENSES.md', 'docs/PLAYER_GUIDE.md', 'docs/RELEASE_CHECKLIST.md', 'skills-lock.json', 'notes.txt',
      // P05.3: the crew harnesses ship (crew is a player feature); other development harnesses stay out
      'docs/development/playtest/crew-bridge-p05.mjs', 'docs/development/playtest/crew-advisor-p05.mjs', 'docs/development/playtest/freeroam-armory-p03b.mjs',
      // P06.2: the signal harness ships too (faint signals are a player feature); its design notes stay out
      'docs/development/playtest/signal-p06.mjs', 'docs/freeroam/SIGNALS.md',
    ]);
    expect(sel.files).toEqual(['docs/PLAYER_GUIDE.md', 'docs/development/playtest/crew-advisor-p05.mjs', 'docs/development/playtest/crew-bridge-p05.mjs', 'docs/development/playtest/release-smoke.mjs', 'docs/development/playtest/signal-p06.mjs', 'docs/freeroam/CONTENT_AND_ASSET_LICENSES.md']);
  });

  it('rejects unsafe paths', () => {
    expect(normalizePath('../outside.ts')).toBeNull();
    expect(normalizePath('/etc/passwd')).toBeNull();
    expect(normalizePath('C:/x.ts')).toBeNull();
    expect(normalizePath('src//x.ts')).toBeNull();
    expect(normalizePath('./src/x.ts')).toBe('src/x.ts');
  });
});

describe.skipIf(!existsSync(join(REPO, '.git')))('this repository', () => {
  it('git lists the .claude/ folder, and the release selection contains none of it', () => {
    const candidates = gitCandidates(REPO);
    const sel = releaseFiles(candidates);
    expect(sel.files.length).toBeGreaterThan(100);
    expect(sel.files.filter((f) => CLAUDE_SEGMENT_RE.test(f))).toEqual([]);
    const claude = candidates.filter((c) => CLAUDE_SEGMENT_RE.test(c));
    expect(sel.excluded.filter((e) => CLAUDE_SEGMENT_RE.test(e.path))).toHaveLength(new Set(claude).size);
    for (const f of REQUIRED_FILES) if (existsSync(join(REPO, f))) expect(sel.files).toContain(f);
    // the names the archive would carry pass the archive check
    const present = sel.files.filter((f) => existsSync(join(REPO, f)));
    expect(checkArchiveNames(present.map((f) => `${RELEASE_ROOT}/${f}`))).toEqual([]);
  });
});

describe('a fixture tree with hidden and nested .claude copies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'galaxia-pack-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, text: string): void => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  for (const f of REQUIRED_FILES) put(f, f === 'README.md' ? '# GALAXIA\n\n![shot](docs/media/title.png)\n' : `${f}\n`);
  put('docs/media/title.png', 'png');
  put('src/main.ts', 'export {};\n');
  for (const p of CLAUDE_PATHS) if (p !== 'src/.claude') put(p, 'assistant config\n');
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [relative(dir, join(d, e.name))]));

  it('builds and verifies an archive without any .claude entry', () => {
    const all = walk(dir);
    expect(all.filter((p) => CLAUDE_SEGMENT_RE.test(p)).length).toBe(CLAUDE_PATHS.length - 1);
    const sel = releaseFiles(all);
    const zip = buildReleaseArchive(dir, sel.files);
    const names = readArchiveEntries(zip).map((e) => e.name);
    expect(names.length).toBe(sel.files.length);
    expect(names.filter((n) => CLAUDE_SEGMENT_RE.test(n))).toEqual([]);
    expect(names.every((n) => n.startsWith(`${RELEASE_ROOT}/`))).toBe(true);
    expect(verifyArchive(zip).problems).toEqual([]);
  });
});

describe('the archive verifier', () => {
  it('accepts a clean archive and round-trips its bytes (deflated and stored)', () => {
    const big = entry('src/big.ts', 'x'.repeat(5000));
    const tiny = entry('src/t.ts', 'a');
    const zip = buildArchive([...goodEntries(), big, tiny]);
    expect(verifyArchive(zip).problems).toEqual([]);
    const entries = readArchiveEntries(zip);
    const b = entries.find((e) => e.name === big.name)!;
    expect(b.method).toBe(8);
    expect(readArchiveData(zip, b).toString()).toBe('x'.repeat(5000));
    expect(entries.find((e) => e.name === tiny.name)!.method).toBe(0);
  });

  it.each([
    ['GALAXIA/.claude/settings.json'],
    ['GALAXIA/.claude/skills/x/SKILL.md'],
    ['GALAXIA/src/.claude/a.ts'],
    ['GALAXIA/tests/deep/.CLAUDE/b.md'],
    ['GALAXIA/.Claude/'],
    ['.claude/settings.json'],
    ['GALAXIA\\.claude\\settings.json'],
    ['GALAXIA/src\\.claude/x.md'],
  ])('fails when the archive contains %s', (name) => {
    const zip = buildArchive([...goodEntries(), { name, data: enc('x'), mtime: T }]);
    const problems = verifyArchive(zip).problems;
    expect(problems.some((p) => p.startsWith('.claude path in archive'))).toBe(true);
  });

  it('fails on build output, nested archives, internal docs, files outside GALAXIA/ and missing required files', () => {
    const cases: [ArchiveInput[], RegExp][] = [
      [[...goodEntries(), entry('node_modules/x/index.js')], /forbidden \(dependencies\)/],
      [[...goodEntries(), entry('src/dist/main.js')], /forbidden \(build output\)/],
      [[...goodEntries(), entry('public/old.zip')], /nested archive/],
      [[...goodEntries(), entry('GALAXIA-Game-Release.zip')], /nested archive/],
      [[...goodEntries(), entry('public/.npmrc')], /forbidden \(credentials\)/],
      [[...goodEntries(), entry('src/.cache/a.json')], /forbidden \(local cache\)/],
      [[...goodEntries(), entry('src/main.ts.tmp')], /forbidden \(temporary file\)/],
      [[...goodEntries(), entry('src/CLAUDE.md')], /forbidden \(AI assistant instructions\)/],
      [goodEntries().filter((e) => !e.name.endsWith('/docs/PLAYER_GUIDE.md')), /missing required file: GALAXIA\/docs\/PLAYER_GUIDE\.md/],
      [[...goodEntries(), entry('docs/freeroam/TECHNICAL_DECISIONS.md')], /not part of a release/],
      [[...goodEntries(), { name: 'stray.txt', data: enc('x'), mtime: T }], /entry outside GALAXIA\//],
      [[...goodEntries(), { name: 'GALAXIA/../evil.ts', data: enc('x'), mtime: T }], /unsafe entry name/],
      [goodEntries().filter((e) => !e.name.endsWith('/LICENSE')), /missing required file: GALAXIA\/LICENSE/],
      [[...goodEntries(), entry('src/main.ts')], /duplicate entry/],
      [[...goodEntries(), entry('src/k.ts', `const k = "ghp_${'a'.repeat(36)}";`)], /secret-like string/],
    ];
    for (const [entries, re] of cases) expect(verifyArchive(buildArchive(entries)).problems.join('\n'), String(re)).toMatch(re);
  });

  it('fails on a README link the archive does not carry', () => {
    const entries = goodEntries().map((e) => (e.name.endsWith('/README.md') ? entry('README.md', '![x](docs/media/missing.png)\n[lic](LICENSE)\n') : e));
    expect(verifyArchive(buildArchive(entries)).problems).toEqual(['README links to docs/media/missing.png, which is not in the archive']);
  });

  it('fails on a damaged archive (CRC mismatch, truncation, not a ZIP)', () => {
    const zip = buildArchive([...goodEntries(), entry('src/big.ts', 'y'.repeat(4000))]);
    const e = readArchiveEntries(zip).find((x) => x.name.endsWith('src/main.ts'))!;
    const bad = Buffer.from(zip);
    bad[e.offset + 30 + Buffer.byteLength(e.name) + 1]! ^= 0xff; // flip a data byte (stored entry)
    expect(verifyArchive(bad).problems.some((p) => /CRC mismatch|size/.test(p))).toBe(true);
    expect(verifyArchive(zip.subarray(0, zip.length - 30)).problems.length).toBeGreaterThan(0);
    expect(verifyArchive(Buffer.from('not a zip at all')).problems[0]).toMatch(/not a ZIP/);
  });
});

describe('reproducible archives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'galaxia-repro-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const files = [...REQUIRED_FILES, 'src/main.ts', 'src/b.ts'];
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), f === 'README.md' ? '# GALAXIA\n' : `${f}\n${'z'.repeat(300)}\n`);
  }
  const stamp = new Date(Date.UTC(2026, 9, 23, 12, 0, 0));

  it('the same tree gives the same bytes whatever the file times or the list order', () => {
    const a = buildReleaseArchive(dir, files, stamp);
    utimesSync(join(dir, 'src/main.ts'), new Date(2001, 0, 1), new Date(2001, 0, 1));
    utimesSync(join(dir, 'README.md'), new Date(), new Date());
    const b = buildReleaseArchive(dir, [...files].reverse(), stamp);
    expect(b.equals(a)).toBe(true);
    expect(verifyArchive(a).problems).toEqual([]);
    const names = readArchiveEntries(a).map((e) => e.name);
    expect(names).toEqual([...names].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  });

  it('stores the timestamp from its UTC fields (no time-zone dependence)', () => {
    const zip = buildReleaseArchive(dir, files, stamp);
    const e = readArchiveEntries(zip)[0]!;
    // the central directory entry sits after all local data; find it by its offset field
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const time = zip.readUInt16LE(cd + 12);
    const date = zip.readUInt16LE(cd + 14);
    expect(e.offset).toBe(0);
    expect([time >> 11, (time >> 5) & 63, (time & 31) * 2]).toEqual([12, 0, 0]);
    expect([(date >> 9) + 1980, (date >> 5) & 15, date & 31]).toEqual([2026, 10, 23]);
  });

  it('takes the timestamp from SOURCE_DATE_EPOCH, else git, else a fixed date', () => {
    expect(releaseTimestamp(dir, { SOURCE_DATE_EPOCH: '1792411200' }).toISOString()).toBe('2026-10-19T12:00:00.000Z');
    expect(releaseTimestamp(dir, {})).toEqual(FALLBACK_TIMESTAMP); // a temp folder is not a git checkout
    if (existsSync(join(REPO, '.git'))) expect(releaseTimestamp(REPO, {}).getTime()).toBeGreaterThan(FALLBACK_TIMESTAMP.getTime());
  });

  it('knows when an output path is inside the repository', () => {
    expect(isInside('/a/repo', '/a/repo/out.zip')).toBe(true);
    expect(isInside('/a/repo', '/a/repo/dist/x/out.zip')).toBe(true);
    expect(isInside('/a/repo', '/a/out.zip')).toBe(false);
    expect(isInside('/a/repo', '/a/repo-other/out.zip')).toBe(false);
  });
});
