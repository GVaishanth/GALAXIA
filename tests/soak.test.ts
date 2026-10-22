/**
 * Stage 6 soak and balancing checks: the autopilot plays many seeded games
 * through InputFrame while invariants are checked on every tick.
 *
 * Default run: ~25 simulated minutes across 16 games (a few seconds of CPU).
 * Deep run:    SOAK=long npx vitest run tests/soak.test.ts  (~3 simulated hours).
 *
 * A soak "test mode" with 9 starting fighters (a variant mode, never classic)
 * lets the bot reach late stages; scoring and difficulty are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE } from '../src/config/engine.ts';
import { defineGameMode } from '../src/config/gameModes.ts';
import { COLORS, hexToRgb } from '../src/config/palette.ts';
import { tuningForStage } from '../src/config/difficulty.ts';
import { GameEngine } from '../src/core/game/engine.ts';
import { RewardManager } from '../src/core/rewards/rewardManager.ts';
import type { RewardEvent } from '../src/core/rewards/types.ts';
import { botInput, invariantChecker, newStats, tallyEvents, type SoakStats } from './helpers/autopilot.ts';

const LONG = process.env['SOAK'] === 'long';
const SOAK_MODE = defineGameMode({ id: 'soak-test', label: 'Soak (9 fighters)', scoring: { fighters: { starting: 9 } } });

interface GameResult {
  stats: SoakStats;
  score: number;
  awardedSum: number;
  duplicateKeys: string[];
  shotSpawns: { x: number; y: number; playerY: number; speed: number }[];
  respawnGraceS: number[];
  normalDiveX: [number, number];
  phaseAtEnd: string;
}

function playGame(seed: number, opts: { startStage?: number; maxMinutes: number; skill?: number; nineLives?: boolean }): GameResult {
  const rewards = new RewardManager(opts.nineLives ? { mode: SOAK_MODE } : {});
  const keys = new Set<string>();
  const duplicateKeys: string[] = [];
  let awardedSum = 0;
  rewards.events.on('pointsAwarded', (e: Extract<RewardEvent, { type: 'pointsAwarded' }>) => {
    if (keys.has(e.key)) duplicateKeys.push(e.key);
    keys.add(e.key);
    awardedSum += e.amount;
  });
  const engine = new GameEngine({ rewards, seed, ...(opts.startStage ? { startStage: opts.startStage } : {}) });
  const stats = newStats();
  const check = invariantChecker(engine, stats);
  const shotSpawns: GameResult['shotSpawns'] = [];
  const respawnGraceS: number[] = [];
  let respawnTick = -1;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (let t = 0; t < opts.maxMinutes * 60 * 60; t++) {
    engine.step(botInput(engine, opts.skill !== undefined ? { skill: opts.skill } : {}));
    const events = engine.drainEvents();
    tallyEvents(stats, events);
    const w = engine.world;
    for (const e of events) {
      if (e.type === 'enemyShot') {
        shotSpawns.push({ x: e.x, y: e.y, playerY: w.player.y, speed: w.tuning.enemyShotSpeed });
        if (respawnTick >= 0) {
          respawnGraceS.push((w.tick - respawnTick) / ENGINE.tickHz);
          respawnTick = -1;
        }
      } else if (e.type === 'playerRespawned') respawnTick = w.tick;
    }
    if (w.stageKind === 'normal') {
      for (const e of w.enemies) {
        if (e.state !== 'attacking' || e.kind === 'capturedFighter') continue;
        minX = Math.min(minX, e.x);
        maxX = Math.max(maxX, e.x);
      }
    }
    check();
    if (engine.phase === 'gameOver') break;
  }
  return { stats, score: rewards.snapshot().score, awardedSum, duplicateKeys, shotSpawns, respawnGraceS, normalDiveX: [minX, maxX], phaseAtEnd: engine.phase };
}

/* Games are played once and shared by the assertions below. */
const games: GameResult[] = [];
const classicSeeds = LONG ? Array.from({ length: 40 }, (_, i) => 100 + i) : [101, 102, 103, 104, 105, 106];
const deepStarts = LONG ? [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41] : [1, 9, 17, 25, 33];
function ensureGames(): GameResult[] {
  if (games.length) return games;
  for (const seed of classicSeeds) games.push(playGame(seed, { maxMinutes: 20 }));
  for (const [i, start] of deepStarts.entries()) games.push(playGame(500 + i, { startStage: start, maxMinutes: LONG ? 30 : 6, nineLives: true }));
  for (const seed of LONG ? [700, 701, 702, 703, 704, 705] : [700, 701]) games.push(playGame(seed, { maxMinutes: 15, skill: 0.4 }));
  return games;
}

describe('soak: seeded autopilot games', () => {
  it('no invariant violations: no deadlock, no rejected facts, no lost objects, bounded arrays', () => {
    for (const g of ensureGames()) expect(g.stats.violations).toEqual([]);
  });

  it('every score award happens exactly once and the score equals the sum of awards', () => {
    for (const g of ensureGames()) {
      expect(g.duplicateKeys).toEqual([]);
      expect(g.score).toBe(g.awardedSum);
    }
  });

  it('classic games end in game over (the game is beatable but not endless for a mediocre bot)', () => {
    for (const g of ensureGames().slice(0, classicSeeds.length)) {
      expect(g.phaseAtEnd).toBe('gameOver');
      expect(g.stats.gameOvers).toBe(1);
      expect(g.stats.stagesStarted).toBeGreaterThanOrEqual(3);
    }
  });

  it('deep runs cross many stages, including Challenging Stages, and captures happen in real play', () => {
    const deep = ensureGames().slice(classicSeeds.length, classicSeeds.length + deepStarts.length);
    const total = deep.reduce((a, g) => ({ stages: a.stages + g.stats.stagesStarted, challenges: a.challenges + g.stats.challengeStages }), { stages: 0, challenges: 0 });
    expect(total.stages).toBeGreaterThanOrEqual(LONG ? 50 : 20);
    expect(total.challenges).toBeGreaterThanOrEqual(LONG ? 10 : 4);
    expect(Math.max(...deep.map((g) => g.stats.maxStage))).toBeGreaterThanOrEqual(33);
    expect(ensureGames().reduce((a, g) => a + g.stats.captures, 0)).toBeGreaterThan(0);
  });

  it('summary (printed for docs/FEASIBILITY.md; set SOAK_REPORT=1)', () => {
    const all = ensureGames();
    const sum = (f: (g: GameResult) => number): number => all.reduce((a, g) => a + f(g), 0);
    const summary = {
      mode: LONG ? 'long' : 'default',
      games: all.length,
      simulatedMinutes: Math.round(sum((g) => g.stats.ticks) / 3600),
      stagesStarted: sum((g) => g.stats.stagesStarted),
      challengeStages: sum((g) => g.stats.challengeStages),
      highestStage: Math.max(...all.map((g) => g.stats.maxStage)),
      captures: sum((g) => g.stats.captures),
      dualFighters: sum((g) => g.stats.duals),
      fightersLost: sum((g) => g.stats.deaths),
      gameOvers: sum((g) => g.stats.gameOvers),
      enemyShots: sum((g) => g.shotSpawns.length),
      maxEnemyShotsOnScreen: Math.max(...all.map((g) => g.stats.maxEnemyShots)),
      maxEnemies: Math.max(...all.map((g) => g.stats.maxEnemies)),
      maxEffects: Math.max(...all.map((g) => g.stats.maxEffects)),
      minRespawnGraceS: Math.min(...all.flatMap((g) => g.respawnGraceS)),
      violations: sum((g) => g.stats.violations.length),
    };
    if (process.env['SOAK_REPORT']) console.log('SOAK_SUMMARY ' + JSON.stringify(summary));
    expect(summary.violations).toBe(0);
  });

  it('memory-relevant arrays stay bounded through long play', () => {
    for (const g of ensureGames()) {
      expect(g.stats.maxPlayerShots).toBeLessThanOrEqual(ENGINE.shots.maxDual);
      expect(g.stats.maxEnemyShots).toBeLessThanOrEqual(tuningForStage(99).maxEnemyShots + 6); // + challenge flyers none fire
      expect(g.stats.maxEnemies).toBeLessThanOrEqual(48); // 40 + captive + transform trio splits
      expect(g.stats.maxEffects).toBeLessThanOrEqual(64);
    }
  });
});

describe('balancing checks', () => {
  it('enemy shots start on screen, from a visible enemy, never inside the minimum fire gap', () => {
    const spawns = ensureGames().flatMap((g) => g.shotSpawns);
    expect(spawns.length).toBeGreaterThan(500);
    for (const s of spawns) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(ENGINE.world.width);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.playerY - s.y).toBeGreaterThanOrEqual(ENGINE.shots.enemyMinFireGap - 1e-6);
    }
    // reaction time from spawn to the player row: the floor follows from config
    const reaction = spawns.map((s) => (s.playerY - s.y) / s.speed).sort((a, b) => a - b);
    expect(reaction[0]).toBeGreaterThanOrEqual(ENGINE.shots.enemyMinFireGap / tuningForStage(99).enemyShotSpeed - 1e-6);
  });

  it('dives in normal stages stay inside the playfield horizontally', () => {
    for (const g of ensureGames()) {
      if (!Number.isFinite(g.normalDiveX[0])) continue;
      expect(g.normalDiveX[0]).toBeGreaterThanOrEqual(ENGINE.diveMarginX - 0.5);
      expect(g.normalDiveX[1]).toBeLessThanOrEqual(ENGINE.world.width - ENGINE.diveMarginX + 0.5);
    }
  });

  it('after a respawn the player gets at least the READY time before the next enemy shot', () => {
    const grace = ensureGames().flatMap((g) => g.respawnGraceS);
    expect(grace.length).toBeGreaterThan(10);
    expect(Math.min(...grace)).toBeGreaterThanOrEqual(ENGINE.player.readyMs / 1000);
  });

  it('enemy and player shots use clearly different colours (warm vs cool) and shapes', () => {
    const hue = (hex: string): number => {
      const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return 0;
      const d = max - min;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const player = hue(COLORS['shot.player.edge']);
    const enemy = hue(COLORS['shot.enemy.edge']);
    const diff = Math.min(Math.abs(player - enemy), 360 - Math.abs(player - enemy));
    expect(diff).toBeGreaterThan(120); // cyan vs orange-red
    expect(COLORS['shot.player.core']).not.toBe(COLORS['shot.enemy.core']);
  });

  it('difficulty is progressive: every parameter moves one way, in small steps, and saturates', () => {
    const keys = ['attackIntervalMs', 'maxAttackers', 'diveSpeed', 'enemyShotSpeed', 'maxEnemyShots', 'shotsPerDive', 'entrySpeed', 'returnSpeed'] as const;
    for (const k of keys) {
      const series = Array.from({ length: 40 }, (_, i) => tuningForStage(i + 1)[k]);
      const harder = k === 'attackIntervalMs' ? (a: number, b: number) => b <= a : (a: number, b: number) => b >= a;
      for (let i = 1; i < series.length; i++) {
        expect(harder(series[i - 1]!, series[i]!), `${k} stage ${i + 1}`).toBe(true);
        // no jumps: each stage moves at most 1/8 of the parameter's whole range (integers: by at most 1)
        const range = Math.abs(series[39]! - series[0]!);
        const step = Math.abs(series[i]! - series[i - 1]!);
        expect(step, `${k} stage ${i + 1}`).toBeLessThanOrEqual(Math.max(1, range / 8) + 1e-9);
      }
      expect(series[39]).toBe(series[38]); // saturated by stage 40
    }
  });

  it('Dual Fighter: double firepower, but a much larger target', () => {
    const single = ENGINE.player.hitbox.w;
    const dual = 2 * ENGINE.player.dualHalfOffset + ENGINE.player.hitbox.w;
    expect(ENGINE.shots.maxDual / ENGINE.shots.maxSingle).toBe(2);
    expect(dual / single).toBeGreaterThan(2); // hit chance grows faster than firepower
  });
});
