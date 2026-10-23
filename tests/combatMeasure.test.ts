/**
 * Combat P03 before / after measurements (simulation only; gated: COMBAT_MEASURE=1).
 * Prints one summary row per scenario; asserts only that every run finished.
 * The numbers recorded in docs/freeroam/COMBAT_P03.md come from this file.
 */
import { describe, expect, it } from 'vitest';
import type { FamilyId } from '../src/modes/freeroam/combat/families.ts';
import { duel, summarise, type Pilot } from './helpers/combatProbe.ts';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const ON = env['COMBAT_MEASURE'] === '1';
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const MISSILE = env['COMBAT_MEASURE_MISSILE'] !== '0';

const SCENARIOS: readonly [string, number, FamilyId[]][] = [
  ['weak d1 raider', 1, ['raider']],
  ['weak d1 picket', 1, ['picket']],
  ['weak d1 recon', 1, ['recon']],
  ['weak d1 hauler', 1, ['hauler']],
  ['weak d2 lancer', 2, ['lancer']],
  ['strong d3 heavy', 3, ['heavy']],
  ['strong d3 elite', 3, ['elite']],
  ['crowd d1 picket+raider+raider', 1, ['picket', 'raider', 'raider']],
  ['crowd d2 picket+lancer+recon', 2, ['picket', 'lancer', 'recon']],
  ['crowd d3 heavy+picket+lancer', 3, ['heavy', 'picket', 'lancer']],
  ['crowd d3 elite+lancer+lancer+picket', 3, ['elite', 'lancer', 'lancer', 'picket']],
];

describe.skipIf(!ON)('combat P03 measurements (simulated pilots)', () => {
  for (const pilot of (env['COMBAT_MEASURE_PILOTS'] ?? 'lead,jitter,skirmish').split(',') as Pilot[]) {
    for (const missile of env['COMBAT_MEASURE_MISSILE'] === 'only' ? [true] : MISSILE ? [false, true] : [false]) {
      it(`${pilot} pilot, ${missile ? 'guns + missile' : 'guns only'}`, () => {
        const rows: string[] = [];
        for (const [label, d, fams] of SCENARIOS) {
          const res = SEEDS.map((s) => duel(d, fams, s, { pilot, missile }));
          rows.push(summarise(label, res));
          expect(res.length).toBe(SEEDS.length);
        }
        console.log(`\nCOMBAT ${pilot} ${missile ? 'guns+missile' : 'guns'}\n${rows.join('\n')}`);
      }, 600_000);
    }
  }
});
