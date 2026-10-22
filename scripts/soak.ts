/**
 * Deep soak run (Stage 6): 57 seeded autopilot games with per-tick invariants.
 * Cross-platform wrapper for `SOAK=long SOAK_REPORT=1 vitest run tests/soak.test.ts`.
 * Run: npm run test:soak
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync('npx', ['vitest', 'run', 'tests/soak.test.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, SOAK: 'long', SOAK_REPORT: '1' },
});
process.exit(result.status ?? 1);
