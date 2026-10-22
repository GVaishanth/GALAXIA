import { describe, expect, it } from 'vitest';
import { CLASSIC_MODE, defineGameMode } from '../src/config/gameModes.ts';
import { CLASSIC_SCORING, EXTRA_LIFE_PRESETS, ScoringConfigError, createScoringConfig, validateScoringConfig } from '../src/config/scoring.ts';
import { challengeNumber, stageKind } from '../src/config/stages.ts';
import { extraLifeThreshold, extraLivesEarnedAt, listExtraLifeThresholds } from '../src/core/rewards/extraLives.ts';

describe('classic scoring table (researched defaults)', () => {
  it('matches the verified original values', () => {
    const e = CLASSIC_SCORING.enemies;
    expect(e.scout).toEqual({ formation: 50, attack: 100 });
    expect(e.interceptor).toEqual({ formation: 80, attack: 160 });
    expect(e.commander.formation).toBe(150);
    expect(e.commander.attackByEscorts).toEqual([400, 800, 1600]);
    expect(e.capturedFighter).toEqual({ formation: 500, attack: 1000 });
    expect(e.challengeSpecial).toBe(160);
    expect(CLASSIC_SCORING.transforms.kinds).toEqual({
      stinger: { each: 160, groupBonus: 1000 },
      phantom: { each: 160, groupBonus: 2000 },
      sovereign: { each: 160, groupBonus: 3000 },
    });
    expect(CLASSIC_SCORING.challenge.waveBonusByChallenge).toEqual([1000, 1000, 1500, 1500, 2000, 2000, 3000, 3000]);
    expect(CLASSIC_SCORING.challenge.perHitBonus).toBe(100);
    expect(CLASSIC_SCORING.challenge.perfectBonus).toBe(10000);
    expect(CLASSIC_SCORING.challenge.perfectReplacesPerHit).toBe(true);
    expect(CLASSIC_SCORING.extraLives).toEqual({ first: 20000, second: 70000, every: 70000, stopAboveScore: null });
    expect(CLASSIC_SCORING.fighters.starting).toBe(3);
    expect(CLASSIC_SCORING.rescue.bonus).toBe(0);
  });

  it('is valid and deeply frozen', () => {
    expect(validateScoringConfig(CLASSIC_SCORING)).toEqual([]);
    expect(Object.isFrozen(CLASSIC_SCORING.enemies.commander.attackByEscorts)).toBe(true);
    expect(() => {
      (CLASSIC_SCORING.enemies.scout as { attack: number }).attack = 9999;
    }).toThrow(TypeError);
  });
});

describe('createScoringConfig (balancing without engine edits)', () => {
  it('merges overrides and leaves the classic table untouched', () => {
    const tuned = createScoringConfig({ enemies: { scout: { attack: 120 } }, rescue: { bonus: 500 } });
    expect(tuned.enemies.scout).toEqual({ formation: 50, attack: 120 });
    expect(tuned.rescue.bonus).toBe(500);
    expect(tuned.enemies.interceptor.attack).toBe(160);
    expect(CLASSIC_SCORING.enemies.scout.attack).toBe(100);
    expect(Object.isFrozen(tuned)).toBe(true);
  });

  it.each([
    ['negative points', { enemies: { scout: { attack: -10 } } }],
    ['NaN', { enemies: { interceptor: { formation: Number.NaN } } }],
    ['fractional', { challenge: { perHitBonus: 99.5 } }],
    ['Infinity', { challenge: { perfectBonus: Number.POSITIVE_INFINITY } }],
    ['wrong escort table length', { enemies: { commander: { attackByEscorts: [400, 800] as unknown as [number, number, number] } } }],
    ['empty wave table', { challenge: { waveBonusByChallenge: [] } }],
    ['second <= first', { extraLives: { first: 50000, second: 40000 } }],
    ['every without second', { extraLives: { second: null } }],
    ['zero threshold', { extraLives: { first: 0 } }],
    ['zero starting fighters', { fighters: { starting: 0 } }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => createScoringConfig(overrides as never)).toThrow(ScoringConfigError);
  });
});

describe('stage schedule', () => {
  it('marks stage 3 and every 4th stage as Challenging Stages', () => {
    const challenges = Array.from({ length: 40 }, (_, i) => i + 1).filter((s) => stageKind(s) === 'challenge');
    expect(challenges).toEqual([3, 7, 11, 15, 19, 23, 27, 31, 35, 39]);
    expect(challengeNumber(3)).toBe(1);
    expect(challengeNumber(31)).toBe(8);
    expect(challengeNumber(35)).toBe(9);
    expect(challengeNumber(4)).toBeNull();
  });

  it('rejects invalid stage numbers', () => {
    expect(() => stageKind(0)).toThrow(RangeError);
    expect(() => stageKind(2.5)).toThrow(RangeError);
  });
});

describe('extra-life schedule', () => {
  const classic = CLASSIC_SCORING.extraLives;
  it('produces 20K, 70K, then every 70K', () => {
    expect(listExtraLifeThresholds(classic, 5)).toEqual([20000, 70000, 140000, 210000, 280000]);
    expect(extraLivesEarnedAt(classic, 19990)).toBe(0);
    expect(extraLivesEarnedAt(classic, 20000)).toBe(1);
    expect(extraLivesEarnedAt(classic, 139990)).toBe(2);
    expect(extraLivesEarnedAt(classic, 140000)).toBe(3);
  });

  it('supports the original DIP presets', () => {
    expect(listExtraLifeThresholds(EXTRA_LIFE_PRESETS['20K-60K']!, 5)).toEqual([20000, 60000]);
    expect(listExtraLifeThresholds(EXTRA_LIFE_PRESETS['30K-120K-every120K']!, 3)).toEqual([30000, 120000, 240000]);
    expect(listExtraLifeThresholds(EXTRA_LIFE_PRESETS['none']!, 3)).toEqual([]);
    for (const preset of Object.values(EXTRA_LIFE_PRESETS)) {
      expect(validateScoringConfig({ ...CLASSIC_SCORING, extraLives: preset })).toEqual([]);
    }
  });

  it('honours an optional score ceiling', () => {
    const capped = { ...classic, stopAboveScore: 1_000_000 };
    const all = listExtraLifeThresholds(capped, 100);
    expect(all.at(-1)).toBe(980000);
    expect(extraLifeThreshold(capped, all.length)).toBeNull();
  });
});

describe('game modes', () => {
  it('classic has no power-ups and uses the classic table', () => {
    expect(CLASSIC_MODE.powerUps).toBeNull();
    expect(CLASSIC_MODE.scoring).toBe(CLASSIC_SCORING);
    expect(Object.isFrozen(CLASSIC_MODE)).toBe(true);
  });

  it('variants are explicit, cannot reuse the classic id, and do not alter classic', () => {
    expect(() => defineGameMode({ id: 'classic', label: 'x', powerUps: { enabled: true, kinds: ['shield'] } })).toThrow();
    const variant = defineGameMode({ id: 'arcade-plus', label: 'Arcade+', powerUps: { enabled: true, kinds: ['shield'] }, scoring: { rescue: { bonus: 1000 } } });
    expect(variant.powerUps?.enabled).toBe(true);
    expect(variant.scoring.rescue.bonus).toBe(1000);
    expect(CLASSIC_MODE.scoring.rescue.bonus).toBe(0);
    expect(CLASSIC_MODE.powerUps).toBeNull();
  });
});
