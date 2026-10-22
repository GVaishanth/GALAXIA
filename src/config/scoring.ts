/**
 * GALAXIA central scoring configuration.
 *
 * Every point value and reward threshold lives here. Gameplay code reports
 * facts (what happened); the reward manager looks values up in this table.
 * No enemy script contains a score.
 *
 * Defaults reproduce the 1981 arcade original ("classic" mode). Each value is
 * tagged in docs/design/SCORING_AND_REWARDS.md as Verified (several
 * independent sources agree), Likely (one good source / partial agreement) or
 * Design (GALAXIA choice where the original is unknown or not applicable).
 *
 * GALAXIA archetype mapping: scout = Mite (bee-type), interceptor = Razorwing
 * (butterfly-type), commander = Warden (boss-type), transforms:
 * stinger = Barbtail (scorpion-type), phantom = Wisp (spy-ship-type),
 * sovereign = Regent (flagship-type).
 */
import { deepFreeze, deepMerge, type DeepPartial } from './freeze.ts';

export type BasicEnemyKind = 'scout' | 'interceptor';
export type EnemyKind = BasicEnemyKind | 'commander' | 'capturedFighter' | 'transform' | 'challengeSpecial';
export type TransformKind = 'stinger' | 'phantom' | 'sovereign';
export const TRANSFORM_KINDS: readonly TransformKind[] = ['stinger', 'phantom', 'sovereign'];

export interface FormationAttackValue {
  /** Destroyed while parked in the formation. */
  readonly formation: number;
  /** Destroyed while attacking (diving), or while entering if rules say so. */
  readonly attack: number;
}

export interface ScoringConfig {
  readonly enemies: {
    readonly scout: FormationAttackValue;
    readonly interceptor: FormationAttackValue;
    readonly commander: {
      readonly formation: number;
      /** Attack value indexed by escort count: [alone, 1 escort, 2 escorts]. */
      readonly attackByEscorts: readonly [number, number, number];
    };
    /** A player ship held by the enemy, shot by the player (a lost rescue). */
    readonly capturedFighter: FormationAttackValue;
    /** Targets that only appear in Challenging Stages. */
    readonly challengeSpecial: number;
  };
  readonly rules: {
    /** Enemies flying their entry path pay the attack value. */
    readonly enteringCountsAsAttack: boolean;
    /** Whether a commander's escort bonus applies during the entry flight. */
    readonly escortBonusWhileEntering: boolean;
    /**
     * Which escort count sets the commander bonus:
     * 'at-dive-start' = escorts that launched with it (shooting them first keeps the bonus);
     * 'alive-at-kill' = escorts still alive when the commander dies.
     */
    readonly escortCountRule: 'at-dive-start' | 'alive-at-kill';
  };
  readonly transforms: {
    /** Members per transform group (all must be destroyed for the group bonus). */
    readonly groupSize: number;
    readonly kinds: Readonly<Record<TransformKind, { readonly each: number; readonly groupBonus: number }>>;
  };
  readonly challenge: {
    readonly waves: number;
    readonly waveSize: number;
    /** Wave-clear bonus by Challenging Stage number (1st, 2nd, ...). */
    readonly waveBonusByChallenge: readonly number[];
    /** What happens after the table runs out. */
    readonly afterTable: 'hold-last' | 'cycle';
    /** End-of-stage bonus per enemy destroyed. */
    readonly perHitBonus: number;
    /** End-of-stage bonus for destroying every enemy. */
    readonly perfectBonus: number;
    /** true: perfect bonus replaces the per-hit bonus (classic); false: added to it. */
    readonly perfectReplacesPerHit: boolean;
  };
  readonly rescue: {
    /** Points for completing a rescue (the freed fighter docking). Classic: 0; the reward is the Dual Fighter. */
    readonly bonus: number;
  };
  readonly extraLives: {
    /** First threshold, or null for no extra lives. */
    readonly first: number | null;
    /** Second threshold, or null for "first only". */
    readonly second: number | null;
    /** Repeat interval after the second threshold, or null for none. */
    readonly every: number | null;
    /** No extra lives are awarded for thresholds above this score (null = no limit). */
    readonly stopAboveScore: number | null;
  };
  readonly fighters: {
    /** Ships per game including the one in play (classic factory setting: 3). */
    readonly starting: number;
  };
  readonly score: {
    /** Score saturates here instead of rolling over. */
    readonly max: number;
  };
}

export const CLASSIC_SCORING: ScoringConfig = deepFreeze({
  enemies: {
    scout: { formation: 50, attack: 100 },
    interceptor: { formation: 80, attack: 160 },
    commander: { formation: 150, attackByEscorts: [400, 800, 1600] },
    capturedFighter: { formation: 500, attack: 1000 },
    challengeSpecial: 160,
  },
  rules: {
    enteringCountsAsAttack: true,
    escortBonusWhileEntering: false,
    escortCountRule: 'at-dive-start',
  },
  transforms: {
    groupSize: 3,
    kinds: {
      stinger: { each: 160, groupBonus: 1000 },
      phantom: { each: 160, groupBonus: 2000 },
      sovereign: { each: 160, groupBonus: 3000 },
    },
  },
  challenge: {
    waves: 5,
    waveSize: 8,
    waveBonusByChallenge: [1000, 1000, 1500, 1500, 2000, 2000, 3000, 3000],
    afterTable: 'hold-last',
    perHitBonus: 100,
    perfectBonus: 10000,
    perfectReplacesPerHit: true,
  },
  rescue: { bonus: 0 },
  extraLives: { first: 20000, second: 70000, every: 70000, stopAboveScore: null },
  fighters: { starting: 3 },
  score: { max: 9_999_990 },
} satisfies ScoringConfig);

/** Original cabinet DIP-switch options (3 starting ships), for operator-style settings. */
export const EXTRA_LIFE_PRESETS: Readonly<Record<string, ScoringConfig['extraLives']>> = Object.freeze({
  '20K-70K-every70K': { first: 20000, second: 70000, every: 70000, stopAboveScore: null },
  '20K-60K-every60K': { first: 20000, second: 60000, every: 60000, stopAboveScore: null },
  '20K-80K-every80K': { first: 20000, second: 80000, every: 80000, stopAboveScore: null },
  '30K-100K-every100K': { first: 30000, second: 100000, every: 100000, stopAboveScore: null },
  '30K-120K-every120K': { first: 30000, second: 120000, every: 120000, stopAboveScore: null },
  '20K-60K': { first: 20000, second: 60000, every: null, stopAboveScore: null },
  '30K-80K': { first: 30000, second: 80000, every: null, stopAboveScore: null },
  none: { first: null, second: null, every: null, stopAboveScore: null },
});

/* -------------------------------------------------------------------------- */
/* Validation and overrides                                                    */
/* -------------------------------------------------------------------------- */

function isPoints(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v);
}

/** Returns a list of human-readable problems; empty means valid. */
export function validateScoringConfig(c: ScoringConfig): string[] {
  const errors: string[] = [];
  const points = (path: string, v: unknown): void => {
    if (!isPoints(v)) errors.push(`${path} must be a non-negative integer (got ${String(v)})`);
  };
  points('enemies.scout.formation', c.enemies.scout.formation);
  points('enemies.scout.attack', c.enemies.scout.attack);
  points('enemies.interceptor.formation', c.enemies.interceptor.formation);
  points('enemies.interceptor.attack', c.enemies.interceptor.attack);
  points('enemies.commander.formation', c.enemies.commander.formation);
  if (!Array.isArray(c.enemies.commander.attackByEscorts) || c.enemies.commander.attackByEscorts.length !== 3) {
    errors.push('enemies.commander.attackByEscorts must have exactly 3 entries [alone, 1 escort, 2 escorts]');
  } else {
    c.enemies.commander.attackByEscorts.forEach((v, i) => points(`enemies.commander.attackByEscorts[${i}]`, v));
  }
  points('enemies.capturedFighter.formation', c.enemies.capturedFighter.formation);
  points('enemies.capturedFighter.attack', c.enemies.capturedFighter.attack);
  points('enemies.challengeSpecial', c.enemies.challengeSpecial);
  if (!['at-dive-start', 'alive-at-kill'].includes(c.rules.escortCountRule)) errors.push('rules.escortCountRule is invalid');

  if (!Number.isInteger(c.transforms.groupSize) || c.transforms.groupSize < 1) errors.push('transforms.groupSize must be an integer >= 1');
  for (const kind of ['stinger', 'phantom', 'sovereign'] as const) {
    const t = c.transforms.kinds[kind];
    if (!t) {
      errors.push(`transforms.kinds.${kind} is missing`);
      continue;
    }
    points(`transforms.kinds.${kind}.each`, t.each);
    points(`transforms.kinds.${kind}.groupBonus`, t.groupBonus);
  }

  if (!Number.isInteger(c.challenge.waves) || c.challenge.waves < 1) errors.push('challenge.waves must be an integer >= 1');
  if (!Number.isInteger(c.challenge.waveSize) || c.challenge.waveSize < 1) errors.push('challenge.waveSize must be an integer >= 1');
  if (!Array.isArray(c.challenge.waveBonusByChallenge) || c.challenge.waveBonusByChallenge.length === 0) {
    errors.push('challenge.waveBonusByChallenge needs at least one entry');
  } else {
    c.challenge.waveBonusByChallenge.forEach((v, i) => points(`challenge.waveBonusByChallenge[${i}]`, v));
  }
  if (!['hold-last', 'cycle'].includes(c.challenge.afterTable)) errors.push('challenge.afterTable is invalid');
  points('challenge.perHitBonus', c.challenge.perHitBonus);
  points('challenge.perfectBonus', c.challenge.perfectBonus);
  points('rescue.bonus', c.rescue.bonus);

  const { first, second, every, stopAboveScore } = c.extraLives;
  const threshold = (path: string, v: number | null): void => {
    if (v !== null && (!isPoints(v) || v === 0)) errors.push(`${path} must be a positive integer or null`);
  };
  threshold('extraLives.first', first);
  threshold('extraLives.second', second);
  threshold('extraLives.every', every);
  threshold('extraLives.stopAboveScore', stopAboveScore);
  if (first === null && (second !== null || every !== null)) errors.push('extraLives.second/every require extraLives.first');
  if (second === null && every !== null) errors.push('extraLives.every requires extraLives.second');
  if (first !== null && second !== null && second <= first) errors.push('extraLives.second must be greater than extraLives.first');

  if (!Number.isInteger(c.fighters.starting) || c.fighters.starting < 1 || c.fighters.starting > 9) errors.push('fighters.starting must be an integer 1..9');
  if (!isPoints(c.score.max) || c.score.max === 0) errors.push('score.max must be a positive integer');
  return errors;
}

export class ScoringConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid scoring configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ScoringConfigError';
    this.problems = problems;
  }
}

/**
 * Build a validated, frozen scoring table from overrides on top of a base
 * (classic by default). This is the balancing entry point: tune values here or
 * from data, never in engine code.
 */
export function createScoringConfig(overrides?: DeepPartial<ScoringConfig>, base: ScoringConfig = CLASSIC_SCORING): ScoringConfig {
  const merged = deepMerge<ScoringConfig>(base, overrides);
  const problems = validateScoringConfig(merged);
  if (problems.length > 0) throw new ScoringConfigError(problems);
  return deepFreeze(structuredClone(merged));
}
