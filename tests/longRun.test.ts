/**
 * Long-run progression (Stage 7): the game has no last stage. A seeded game is
 * driven to stage 300 by clearing every stage, then the fighter is left to die.
 * Guards: stage counter never wraps or stops, Challenging Stages stay on
 * 3, 7, 11, ..., wave bonuses hold at 3000 after the 8th challenge, difficulty
 * stays constant from stage 19, the ending is an ordinary game over, and the
 * best stage beyond 255 is saved (it was silently capped at 255 before).
 */
import { describe, expect, it } from 'vitest';
import { CLASSIC_SCORING } from '../src/config/scoring.ts';
import { tuningForStage } from '../src/config/difficulty.ts';
import { NO_INPUT } from '../src/core/game/input.ts';
import { SaveManager } from '../src/persistence/saveData.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import { makeEngine, runUntil, startPlaying } from './helpers/engine.ts';

describe('long-run progression', () => {
  it('reaches stage 300 without wrapping, keeps the schedule, and ends with a normal game over', () => {
    const h = makeEngine({ seed: 7 });
    startPlaying(h);
    runUntil(h.engine, () => h.engine.world.stage >= 300, 60 * 60 * 60 * 20, () => {
      h.engine.world.enemyShots = [];
      if ((h.engine.phase === 'playing' || h.engine.phase === 'challenge') && h.engine.world.enemies.length > 0) h.engine.debugDestroyAll();
      return NO_INPUT;
    });

    const stages = h.rewardEvents.flatMap((e) => (e.type === 'stageChanged' ? [e] : []));
    expect(stages.map((e) => e.stage)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    const challenges = stages.filter((e) => e.kind === 'challenge');
    expect(challenges.map((e) => e.stage)).toEqual(Array.from({ length: 75 }, (_, i) => 3 + 4 * i));
    expect(challenges.at(-1)?.challengeNumber).toBe(75);

    const bonusByStage = new Map<number, Set<number>>();
    for (const e of h.rewardEvents) if (e.type === 'challengeWaveCleared') (bonusByStage.get(e.stage) ?? bonusByStage.set(e.stage, new Set()).get(e.stage)!).add(e.bonus);
    const table = CLASSIC_SCORING.challenge.waveBonusByChallenge;
    challenges.forEach((c, i) => expect([...(bonusByStage.get(c.stage) ?? [])]).toEqual([table[Math.min(i, table.length - 1)]]));

    expect(tuningForStage(300)).toEqual(tuningForStage(19));
    expect(tuningForStage(18)).not.toEqual(tuningForStage(19));

    const score = h.rewards.snapshot().score;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(CLASSIC_SCORING.score.max);

    // stop clearing: the enemies win and the game ends as usual
    runUntil(h.engine, () => h.engine.phase === 'gameOver', 60 * 60 * 120, NO_INPUT);
    const over = h.rewardEvents.find((e) => e.type === 'gameOver');
    expect(over).toMatchObject({ type: 'gameOver', stage: 300, finalScore: score });
  });

  it('saves a best stage above 255', () => {
    const save = new SaveManager(new MemoryStore());
    save.recordGameResult({ score: 10, stage: 255 });
    expect(save.recordGameResult({ score: 20, stage: 300 })).toMatchObject({ newBestStage: true, saved: true });
    expect(save.get().bestStage).toBe(300);
  });
});
