/**
 * Stage-based difficulty and attack patterns. Every knob is separate so
 * balancing never touches engine code. tuningForStage() is pure.
 */
import { deepFreeze } from './freeze.ts';
import type { ChallengePathId } from './paths.ts';
import type { TransformKind } from './scoring.ts';

export interface StageTuning {
  /** Mean time between attack launches. */
  readonly attackIntervalMs: number;
  /** Enemies allowed in attack at once (all groups together). */
  readonly maxAttackers: number;
  readonly entrySpeed: number;
  readonly diveSpeed: number;
  readonly returnSpeed: number;
  readonly enemyShotSpeed: number;
  readonly maxEnemyShots: number;
  readonly shotsPerDive: number;
  /** Enemies on their entry path may fire (later stages). */
  readonly entryFire: boolean;
  /** When this few enemies remain, they attack continuously. */
  readonly lowCountThreshold: number;
}

interface Ramp {
  readonly base: number;
  readonly perStage: number;
  readonly limit: number;
}

const ramp = (r: Ramp, stage: number): number => {
  const v = r.base + r.perStage * (stage - 1);
  return r.perStage >= 0 ? Math.min(v, r.limit) : Math.max(v, r.limit);
};

export const DIFFICULTY = deepFreeze({
  attackIntervalMs: { base: 2600, perStage: -110, limit: 900 },
  maxAttackers: { base: 3, perStage: 0.4, limit: 8 },
  entrySpeed: { base: 230, perStage: 4, limit: 300 },
  diveSpeed: { base: 165, perStage: 6, limit: 270 },
  returnSpeed: { base: 190, perStage: 4, limit: 260 },
  enemyShotSpeed: { base: 230, perStage: 7, limit: 340 },
  maxEnemyShots: { base: 4, perStage: 0.35, limit: 9 },
  shotsPerDive: { base: 1, perStage: 0.25, limit: 3 },
  entryFireFromStage: 5,
  lowCountThreshold: 5,
  /** ± fraction of randomness applied to each attack interval (seeded). */
  intervalJitter: 0.25,
});

export function tuningForStage(stage: number): StageTuning {
  const d = DIFFICULTY;
  return {
    attackIntervalMs: ramp(d.attackIntervalMs, stage),
    maxAttackers: Math.floor(ramp(d.maxAttackers, stage)),
    entrySpeed: ramp(d.entrySpeed, stage),
    diveSpeed: ramp(d.diveSpeed, stage),
    returnSpeed: ramp(d.returnSpeed, stage),
    enemyShotSpeed: ramp(d.enemyShotSpeed, stage),
    maxEnemyShots: Math.floor(ramp(d.maxEnemyShots, stage)),
    shotsPerDive: Math.floor(ramp(d.shotsPerDive, stage)),
    entryFire: stage >= d.entryFireFromStage,
    lowCountThreshold: d.lowCountThreshold,
  };
}

/* ------------------------------ attack patterns --------------------------- */

export type AttackPatternId = 'scoutSolo' | 'scoutPair' | 'interceptorSolo' | 'commanderEscort' | 'commanderBeam' | 'transform' | 'hostileCaptive';

export interface AttackPattern {
  readonly id: AttackPatternId;
  readonly weight: number;
  readonly minStage: number;
}

export const ATTACK_PATTERNS: readonly AttackPattern[] = deepFreeze([
  { id: 'scoutSolo', weight: 4, minStage: 1 },
  { id: 'scoutPair', weight: 2, minStage: 2 },
  { id: 'interceptorSolo', weight: 3, minStage: 1 },
  { id: 'commanderEscort', weight: 2, minStage: 1 },
  { id: 'commanderBeam', weight: 2, minStage: 1 },
  { id: 'transform', weight: 3, minStage: 4 },
  { id: 'hostileCaptive', weight: 6, minStage: 1 },
]);

/* ---------------------------------- transforms ---------------------------- */

export const TRANSFORMS = deepFreeze({
  firstStage: 4,
  /** Kind rotates after each Challenging Stage: 4-6 stinger, 8-10 phantom, 12-14 sovereign, then repeats. */
  cycle: ['stinger', 'phantom', 'sovereign'] as readonly TransformKind[],
  perStage: 1,
  speed: 210,
});

export function transformKindForStage(stage: number, firstChallenge = 3, interval = 4): TransformKind | null {
  if (stage < TRANSFORMS.firstStage) return null;
  const block = Math.floor((stage - (firstChallenge + 1)) / interval);
  return TRANSFORMS.cycle[((block % TRANSFORMS.cycle.length) + TRANSFORMS.cycle.length) % TRANSFORMS.cycle.length]!;
}

/* ------------------------------ Challenging Stages ------------------------ */

export type ChallengeEnemy = 'scout' | 'interceptor' | 'commander' | TransformKind;

export interface ChallengeWave {
  readonly path: ChallengePathId;
  /** 8 entries: first 4 fly the path, last 4 the mirrored path. */
  readonly kinds: readonly ChallengeEnemy[];
  readonly atMs: number;
}

const w = (atMs: number, path: ChallengePathId, a: ChallengeEnemy, b: ChallengeEnemy = a): ChallengeWave => ({
  atMs,
  path,
  kinds: [a, a, a, a, b, b, b, b],
});

/** Wave sets by Challenging Stage number (cycled). 5 waves x 8 = 40 targets each. */
export const CHALLENGE_SETS: readonly (readonly ChallengeWave[])[] = deepFreeze([
  [w(0, 'arcAcross', 'scout'), w(3600, 'centreDive', 'interceptor', 'commander'), w(7200, 'sideSweep', 'interceptor'), w(10800, 'topLoop', 'scout'), w(14400, 'zigzag', 'interceptor', 'scout')],
  [w(0, 'centreDive', 'stinger'), w(3600, 'arcAcross', 'interceptor'), w(7200, 'topLoop', 'stinger', 'scout'), w(10800, 'zigzag', 'commander', 'interceptor'), w(14400, 'sideSweep', 'stinger')],
  [w(0, 'sideSweep', 'phantom'), w(3600, 'topLoop', 'interceptor', 'phantom'), w(7200, 'zigzag', 'scout'), w(10800, 'centreDive', 'phantom'), w(14400, 'arcAcross', 'commander', 'phantom')],
  [w(0, 'topLoop', 'sovereign'), w(3600, 'zigzag', 'interceptor'), w(7200, 'arcAcross', 'sovereign', 'scout'), w(10800, 'sideSweep', 'commander'), w(14400, 'centreDive', 'sovereign')],
]);

export const CHALLENGE = deepFreeze({
  speed: 240,
  stringSpacingMs: 140,
  /** Original: Challenging Stage enemies do not fire. */
  enemiesFire: false,
  /** Whether flying into a challenge enemy destroys the player (see docs: uncertain). */
  collisions: true,
});
