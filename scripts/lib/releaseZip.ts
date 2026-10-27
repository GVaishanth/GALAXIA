/**
 * Release source archive (GALAXIA.zip): which files go in, how the archive is
 * written, and how a finished archive is checked (P04.2 packaging cleanup).
 *
 *   node scripts/release-zip.ts --out <file.zip>     build (refuses to write a bad archive)
 *   node scripts/verify-release-zip.ts <file.zip>    check an existing archive
 *
 * Contents are unchanged from the earlier shell script (release-tools/make-zip.sh):
 * git-tracked plus untracked-but-not-ignored files, filtered by INCLUDE_RE, under
 * one top folder `GALAXIA/`. What is new:
 *
 *  - Hard exclusions apply to every path segment, at any depth and in any letter
 *    case, before and after the include filter: AI-assistant folders (`.claude/`),
 *    dependency / build output, VCS and editor folders, logs, env files, lock files
 *    of other package managers and nested archives. `.claude/` stays in the
 *    repository (it is the project's assistant configuration); it is never
 *    packaged.
 *  - The verifier reads the archive itself (central directory, local headers,
 *    CRC of every entry), so a stray `.claude/` path fails the check whatever
 *    produced the file.
 *  - Reproducible: every entry carries one fixed timestamp (SOURCE_DATE_EPOCH,
 *    else the HEAD commit time), written in UTC, and files are in byte order,
 *    so the same tree always gives the same bytes whatever the file mtimes,
 *    the clock or the time zone (final cleanup).
 *
 * Node built-ins only (zlib deflate + crc32); no archive dependency.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/** The single top-level folder inside the archive. */
export const RELEASE_ROOT = 'GALAXIA';

/** What a release carries (relative to the repository). Same list as the earlier shell script. */
export const INCLUDE_RE =
  /^(src\/|public\/|tests\/|scripts\/|index\.html$|package\.json$|package-lock\.json$|vite\.config\.ts$|tsconfig\.json$|\.nvmrc$|\.gitignore$|LICENSE$|README\.md$|docs\/PLAYER_GUIDE\.md$|docs\/media\/[a-z0-9-]+\.png$|\.github\/workflows\/deploy\.yml$|docs\/freeroam\/CONTENT_AND_ASSET_LICENSES\.md$|docs\/freeroam\/ASTRONOMY_SOURCES\.md$|docs\/development\/playtest\/(release-smoke|release-p16|pause-resume|controller-sim|arcade-display|crew-bridge-p05|crew-advisor-p05|signal-p06)\.mjs$)/;

/** The only files allowed under docs/ (player guide, player-facing licences / sources, release harnesses, README images). */
export const ALLOWED_DOCS_RE = /^docs\/(PLAYER_GUIDE\.md|freeroam\/(CONTENT_AND_ASSET_LICENSES|ASTRONOMY_SOURCES)\.md|development\/playtest\/[a-z0-9-]+\.mjs|media\/[a-z0-9-]+\.png)$/;

/** Files every release must contain. */
export const REQUIRED_FILES: readonly string[] = [
  'README.md',
  'docs/PLAYER_GUIDE.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  '.nvmrc',
  '.github/workflows/deploy.yml',
  'public/THIRD_PARTY_NOTICES.txt',
  'docs/freeroam/CONTENT_AND_ASSET_LICENSES.md',
];

/** Folder names that are never packaged, at any depth (compared case-insensitively). */
const FORBIDDEN_DIRS: Readonly<Record<string, string>> = {
  '.claude': 'AI assistant configuration (.claude/)',
  node_modules: 'dependencies',
  dist: 'build output',
  'dist-e2e': 'build output',
  coverage: 'test output',
  '.git': 'version control data',
  '.vscode': 'editor settings',
  '.idea': 'editor settings',
  'test-results': 'test output',
  'playwright-report': 'test output',
  '.nyc_output': 'test output',
  // local caches
  '.cache': 'local cache',
  '.vite': 'local cache',
  '.turbo': 'local cache',
  '.parcel-cache': 'local cache',
  '.npm': 'local cache',
  '.pnpm-store': 'local cache',
  '.yarn': 'local cache',
  __pycache__: 'local cache',
  '.pytest_cache': 'local cache',
  '.mypy_cache': 'local cache',
  // other AI assistant / editor configuration
  '.cursor': 'AI assistant configuration',
  '.windsurf': 'AI assistant configuration',
  '.continue': 'AI assistant configuration',
  '.codex': 'AI assistant configuration',
  '.gemini': 'AI assistant configuration',
  // credential stores
  '.ssh': 'credentials',
  '.aws': 'credentials',
  '.gnupg': 'credentials',
};

/** Single files that are never packaged (by name, case-insensitive). */
const FORBIDDEN_FILES: readonly [RegExp, string][] = [
  [/\.log$/i, 'log file'],
  [/^\.ds_store$/i, 'OS metadata'],
  [/^skills-lock\.json$/i, 'assistant skills lock file'],
  [/^\.env(\..*)?$/i, 'environment file'],
  [/^(yarn\.lock|pnpm-lock\.yaml)$/i, 'another package manager'],
  [/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i, 'nested archive'],
  [/\.tsbuildinfo$/i, 'build cache'],
  [/^\.eslintcache$/i, 'build cache'],
  [/\.pyc$/i, 'build cache'],
  // credentials and personal configuration
  [/^\.(npmrc|netrc|git-credentials|pypirc)$/i, 'credentials'],
  [/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, 'credentials'],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, 'credentials'],
  [/^(credentials|secrets?)\.(json|ya?ml|txt|env)$/i, 'credentials'],
  // scratch and editor leftovers
  [/\.(tmp|temp|swp|swo|bak|orig|rej)$/i, 'temporary file'],
  [/~$/, 'temporary file'],
  [/^(thumbs\.db|desktop\.ini)$/i, 'OS metadata'],
  // AI assistant instruction files
  [/^(claude|claude\.local|agents|gemini)\.md$/i, 'AI assistant instructions'],
];

/** Credentials that must never ship (private keys, common token formats). */
export const SECRET_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{32,}/;

/** A `.claude` folder anywhere in a path, in any letter case, with / or \\ separators. */
export const CLAUDE_SEGMENT_RE = /(^|[\\/])\.claude([\\/]|$)/i;

/** Forward slashes, no leading `./`. Returns null for absolute paths or `..` segments. */
export function normalizePath(p: string): string | null {
  const s = p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (s === '' || s.startsWith('/') || /^[a-z]:\//i.test(s)) return null;
  if (s.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return s;
}

/** Why a repository path may never be packaged, or null. Applies to every segment. */
export function excludedReason(path: string): string | null {
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i]!;
    const lower = seg.toLowerCase();
    const isDir = i < segs.length - 1;
    if (isDir && Object.hasOwn(FORBIDDEN_DIRS, lower)) return FORBIDDEN_DIRS[lower]!;
    // a file literally named `.claude` (or a dir listed without a trailing child) is excluded too
    if (!isDir && lower === '.claude') return FORBIDDEN_DIRS['.claude']!;
    if (!isDir) for (const [re, why] of FORBIDDEN_FILES) if (re.test(seg)) return why;
  }
  return null;
}

export interface FileSelection {
  /** Repository-relative paths to package, sorted (C locale), unique. */
  readonly files: readonly string[];
  /** Candidates the include filter would have taken but a hard exclusion removed. */
  readonly excluded: readonly { readonly path: string; readonly reason: string }[];
}

/** The release file list from candidate paths (normally git tracked + untracked-not-ignored). */
export function releaseFiles(candidates: Iterable<string>): FileSelection {
  const files = new Set<string>();
  const excluded: { path: string; reason: string }[] = [];
  for (const raw of candidates) {
    const p = normalizePath(raw);
    if (!p) continue;
    const reason = excludedReason(p);
    if (reason) {
      if (INCLUDE_RE.test(p) || CLAUDE_SEGMENT_RE.test(p)) excluded.push({ path: p, reason });
      continue;
    }
    if (INCLUDE_RE.test(p)) files.add(p);
  }
  return { files: [...files].sort(byteOrder), excluded: excluded.sort((a, b) => byteOrder(a.path, b.path)) };
}

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** git tracked + untracked-but-not-ignored files of a repository (paths as git reports them). */
export function gitCandidates(repo: string): string[] {
  const run = (args: string[]): string[] => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean);
  return [...run(['ls-files', '-z']), ...run(['ls-files', '-z', '--others', '--exclude-standard'])];
}

/* ------------------------------------------------------------- archive I/O */

export interface ArchiveInput {
  /** Name inside the archive (already prefixed with the top folder). */
  readonly name: string;
  readonly data: Uint8Array;
  /** Modification time (stored from its UTC fields). */
  readonly mtime: Date;
}

/** DOS date/time from the UTC fields (so the bytes never depend on the machine's time zone). */
function dosTime(d: Date): { time: number; date: number } {
  const y = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** A standard ZIP (deflate or store, UTF-8 names, no extra fields, no directory entries). */
export function buildArchive(entries: readonly ArchiveInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data);
    const crc = crc32(raw) >>> 0;
    const deflated = deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const { time, date } = dosTime(e.mtime);
    const flags = 0x0800; // UTF-8 names
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((0o100644 << 16) >>> 0) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  if (entries.length > 0xffff || offset > 0xffffffff) throw new Error('archive too large for a plain ZIP');
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export interface ArchiveEntry {
  readonly name: string;
  readonly method: number;
  readonly size: number;
  readonly compressedSize: number;
  readonly crc: number;
  readonly offset: number;
}

/** The central directory of a ZIP. Throws on a file that is not a readable ZIP. */
export function readArchiveEntries(buf: Buffer): ArchiveEntry[] {
  const minEnd = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minEnd; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  if (p + cdSize > eocd) throw new Error('central directory out of range');
  const out: ArchiveEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, size, compressedSize, crc, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The uncompressed bytes of one entry (checks the local header and the CRC). */
export function readArchiveData(buf: Buffer, e: ArchiveEntry): Buffer {
  const p = e.offset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`${e.name}: bad local header`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const localName = buf.toString('utf8', p + 30, p + 30 + nameLen);
  if (localName !== e.name) throw new Error(`${e.name}: local header names ${localName}`);
  const start = p + 30 + nameLen + extraLen;
  const body = buf.subarray(start, start + e.compressedSize);
  let data: Buffer;
  if (e.method === 0) data = Buffer.from(body);
  else if (e.method === 8) data = inflateRawSync(body);
  else throw new Error(`${e.name}: unsupported compression method ${e.method}`);
  if (data.length !== e.size) throw new Error(`${e.name}: size ${data.length}, expected ${e.size}`);
  if ((crc32(data) >>> 0) !== e.crc) throw new Error(`${e.name}: CRC mismatch`);
  return data;
}

/* ------------------------------------------------------------------ checks */

/**
 * Problems with a list of archive entry names (empty when the list is a valid
 * release): one top folder, no `.claude` (any depth, any case), no hard
 * exclusion, only included files, the docs allowlist, required files present.
 */
export function checkArchiveNames(names: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const present = new Set<string>();
  const prefix = `${RELEASE_ROOT}/`;
  for (const name of names) {
    if (seen.has(name)) problems.push(`duplicate entry: ${name}`);
    seen.add(name);
    if (CLAUDE_SEGMENT_RE.test(name)) {
      problems.push(`.claude path in archive: ${name}`);
      continue;
    }
    if (name.endsWith('/')) continue; // directory entries carry no data
    const norm = normalizePath(name);
    if (!norm || norm !== name) {
      problems.push(`unsafe entry name: ${name}`);
      continue;
    }
    if (!name.startsWith(prefix)) {
      problems.push(`entry outside ${prefix}: ${name}`);
      continue;
    }
    const rel = name.slice(prefix.length);
    const reason = excludedReason(rel);
    if (reason) problems.push(`forbidden (${reason}): ${name}`);
    else if (!INCLUDE_RE.test(rel)) problems.push(`not part of a release: ${name}`);
    else if (rel.startsWith('docs/') && !ALLOWED_DOCS_RE.test(rel)) problems.push(`unexpected doc: ${name}`);
    present.add(rel);
  }
  for (const f of REQUIRED_FILES) if (!present.has(f)) problems.push(`missing required file: ${prefix}${f}`);
  return problems;
}

/** Relative links and images in README.md that the archive does not contain. */
export function missingReadmeLinks(readme: string, has: (rel: string) => boolean): string[] {
  const refs = new Set<string>();
  for (const m of readme.matchAll(/(?:\]\(|src=")([^)"#:\s]+)/g)) refs.add(m[1]!);
  return [...refs].filter((r) => !has(r.replace(/^\.\//, ''))).sort(byteOrder);
}

export interface VerifyReport {
  readonly entries: number;
  readonly bytes: number;
  readonly problems: readonly string[];
}

/** Full check of an archive: structure, every entry's CRC, names, secrets, README links. */
export function verifyArchive(buf: Buffer): VerifyReport {
  let entries: ArchiveEntry[];
  try {
    entries = readArchiveEntries(buf);
  } catch (err) {
    return { entries: 0, bytes: buf.length, problems: [String((err as Error).message)] };
  }
  const problems = checkArchiveNames(entries.map((e) => e.name));
  const names = new Set(entries.map((e) => e.name));
  let readme: string | null = null;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    let data: Buffer;
    try {
      data = readArchiveData(buf, e);
    } catch (err) {
      problems.push(String((err as Error).message));
      continue;
    }
    if (isText(data) && SECRET_RE.test(data.toString('utf8'))) problems.push(`secret-like string in ${e.name}`);
    if (e.name === `${RELEASE_ROOT}/README.md`) readme = data.toString('utf8');
  }
  if (readme !== null) for (const r of missingReadmeLinks(readme, (rel) => names.has(`${RELEASE_ROOT}/${rel}`))) problems.push(`README links to ${r}, which is not in the archive`);
  return { entries: entries.length, bytes: buf.length, problems };
}

function isText(b: Buffer): boolean {
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i += 1) if (b[i] === 0) return false;
  return true;
}

/** Used when neither SOURCE_DATE_EPOCH nor git gives a time (not a git checkout). */
export const FALLBACK_TIMESTAMP = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/**
 * The one timestamp every entry carries: SOURCE_DATE_EPOCH (seconds) when set,
 * else the HEAD commit time, else FALLBACK_TIMESTAMP. File mtimes are never
 * used, so a rebuild of the same tree gives the same bytes.
 */
export function releaseTimestamp(repo: string, env: Readonly<Record<string, string | undefined>> = process.env): Date {
  const epoch = env['SOURCE_DATE_EPOCH'];
  if (epoch !== undefined && /^\d+$/.test(epoch.trim())) return new Date(Number(epoch.trim()) * 1000);
  try {
    const ct = execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^\d+$/.test(ct)) return new Date(Number(ct) * 1000);
  } catch {
    // not a git checkout
  }
  return FALLBACK_TIMESTAMP;
}

/** Read the selected files from a repository and build the archive in memory (byte order, one timestamp). */
export function buildReleaseArchive(repo: string, files: readonly string[], mtime: Date = releaseTimestamp(repo)): Buffer {
  const inputs: ArchiveInput[] = [...files].sort(byteOrder).map((rel) => ({ name: `${RELEASE_ROOT}/${rel}`, data: readFileSync(join(repo, rel)), mtime }));
  return buildArchive(inputs);
}

/** True when `target` is inside `dir` (or is `dir`). */
export function isInside(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
