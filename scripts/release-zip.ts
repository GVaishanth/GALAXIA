/**
 * Builds the release source archive (scripts/lib/releaseZip.ts).
 *
 *   node scripts/release-zip.ts --out ../GALAXIA-Game-Release.zip [--repo .]
 *   node scripts/release-zip.ts --list            (print the file list; writes nothing)
 *
 * Files: git tracked + untracked-but-not-ignored, filtered by the release include
 * list, with `.claude/` and the other hard exclusions removed at any depth. The
 * archive is built in memory and checked; nothing is written if a check fails.
 * After writing, the file is read back and verified as a whole.
 *
 * Reproducible: one timestamp for every entry (SOURCE_DATE_EPOCH, else the HEAD
 * commit time), so the same tree gives the same bytes (the SHA-256 is printed).
 * The output must be outside the repository, and an existing file is never
 * overwritten (pick a new name, or delete the old archive yourself).
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildReleaseArchive, checkArchiveNames, CLAUDE_SEGMENT_RE, gitCandidates, isInside, RELEASE_ROOT, releaseFiles, releaseTimestamp, verifyArchive } from './lib/releaseZip.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repo = resolve(opt('--repo') ?? '.');
const out = opt('--out');
const listOnly = args.includes('--list');
if (!out && !listOnly) {
  console.error('usage: node scripts/release-zip.ts --out <file.zip> [--repo <dir>] | --list');
  process.exit(2);
}
if (out && isInside(repo, out)) {
  console.error(`refusing to write the archive inside the repository (${resolve(out)}); write it next to the repository instead`);
  process.exit(2);
}
if (out && existsSync(resolve(out))) {
  console.error(`${resolve(out)} already exists; choose a new name or remove the old archive first`);
  process.exit(2);
}

let candidates: string[];
try {
  candidates = gitCandidates(repo);
} catch {
  // the file list comes from git: an extracted release folder cannot build another archive
  console.error(`${repo} is not a git checkout; the release archive is built from the source repository (its file list comes from git)`);
  process.exit(2);
}
const selection = releaseFiles(candidates);
// files git lists but that were deleted (or are not regular files) in the working tree are skipped
const files = selection.files.filter((f) => {
  try {
    return lstatSync(join(repo, f)).isFile();
  } catch {
    return false;
  }
});
if (selection.excluded.length) {
  const claude = selection.excluded.filter((e) => CLAUDE_SEGMENT_RE.test(e.path)).length;
  console.log(`excluded ${selection.excluded.length} path(s) (${claude} under .claude/)`);
}
if (listOnly) {
  for (const f of files) console.log(f);
  process.exit(0);
}

const nameProblems = checkArchiveNames(files.map((f) => `${RELEASE_ROOT}/${f}`));
if (nameProblems.length) {
  for (const p of nameProblems) console.log(`  FAIL ${p}`);
  console.log('no archive written');
  process.exit(1);
}
const stamp = releaseTimestamp(repo);
const zip = buildReleaseArchive(repo, files, stamp);
const pre = verifyArchive(zip);
if (pre.problems.length) {
  for (const p of pre.problems) console.log(`  FAIL ${p}`);
  console.log('no archive written');
  process.exit(1);
}
const target = resolve(out!);
writeFileSync(target, zip);
const post = verifyArchive(readFileSync(target));
if (post.problems.length) {
  for (const p of post.problems) console.log(`  FAIL ${p}`);
  rmSync(target, { force: true });
  console.log('the written archive failed verification and was removed');
  process.exit(1);
}
const sha = createHash('sha256').update(readFileSync(target)).digest('hex');
console.log(`wrote ${target}: ${post.entries} files, ${post.bytes} bytes (${(post.bytes / 1e6).toFixed(2)} MB); verified (no .claude/ paths)`);
console.log(`entry timestamp ${stamp.toISOString()} · sha256 ${sha}`);
