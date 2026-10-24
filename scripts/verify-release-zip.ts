/**
 * Verifies a release source archive (scripts/lib/releaseZip.ts).
 *
 *   node scripts/verify-release-zip.ts GALAXIA-Game-Release.zip
 *
 * Reads the archive itself: central directory, every local header and CRC,
 * entry names (one GALAXIA/ folder, no `.claude/` at any depth or letter case,
 * no build output, caches, logs, env or credential files, temporary files or
 * nested archives such as an older release ZIP, only release files, required
 * files present), secret-like strings and README links.
 * Exits 1 and lists every problem.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyArchive } from './lib/releaseZip.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/verify-release-zip.ts <file.zip>');
  process.exit(2);
}
const path = resolve(file);
let buf: Buffer;
try {
  buf = readFileSync(path);
} catch (err) {
  console.error(`cannot read ${path}: ${(err as Error).message}`);
  process.exit(1);
}
const report = verifyArchive(buf);
console.log(`GALAXIA release archive check: ${path} (${report.entries} entries, ${report.bytes} bytes, sha256 ${createHash('sha256').update(buf).digest('hex')})`);
if (report.problems.length) {
  for (const p of report.problems) console.log(`  FAIL ${p}`);
  console.log(`${report.problems.length} problem(s); do not distribute this archive.`);
  process.exit(1);
}
console.log('OK: readable, CRCs match, one GALAXIA/ folder, no .claude/ paths, no excluded files, required files present.');
