/**
 * Stage 6 QA: unit-level gaps found by the audit of the Stage 1-5 suites.
 * Everything is seeded and tick-driven (no wall clock, no network).
 * Timing values are read from config, never hard-coded.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE, type EngineConfig } from '../src/config/engine.ts';
import { CLASSIC_SCORING } from '../src/config/scoring.ts';
import { NO_INPUT } from '../src/core/game/input.ts';
import type { RewardEvent } from '../src/core/rewards/types.ts';
import { attackersInFlight } from '../src/core/systems/attacks.ts';
import { destroyEnemy } from '../src/core/systems/damage.ts';
import { enemiesOf, FIRE, LEFT, makeEngine, PAUSE, RIGHT, run, runUntil, shootPlayer, startPlaying, type Harness } from './helpers/engine.ts';

const TICK_MS = 1000 / ENGINE.tickHz;
const ofType = <T extends RewardEvent['type']>(h: Harness, type: T): Extract<RewardEvent, { type: T }>[] => h.rewardEvents.filter((e): e is Extract<RewardEvent, { type: T }> => e.type === type);

/* ------------------------------ player movement ------------------------------ */

describe('player movement boundaries', () => {
  it('a single fighter stops exactly at minX / maxX and never leaves them', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    run(h.engine, 60 * 4, LEFT);
    expect(h.engine.world.player.x).toBe(ENGINE.player.minX);
    run(h.engine, 60 * 5, RIGHT);
    expect(h.engine.world.player.x).toBe(ENGINE.player.maxX);
  });

  it('a Dual Fighter uses the narrower dual bounds, so both halves stay on screen', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.world.player.dual = true;
    run(h.engine, 60 * 4, LEFT);
    expect(h.engine.world.player.x).toBe(ENGINE.player.dualMinX);
    expect(h.engine.world.player.x - ENGINE.player.dualHalfOffset - ENGINE.player.hitbox.w / 2).toBeGreaterThanOrEqual(0);
    run(h.engine, 60 * 5, RIGHT);
    expect(h.engine.world.player.x).toBe(ENGINE.player.dualMaxX);
    expect(h.engine.world.player.x + ENGINE.player.dualHalfOffset + ENGINE.player.hitbox.w / 2).toBeLessThanOrEqual(ENGINE.world.width);
  });

  it('losing one Dual Fighter half at the edge leaves the survivor inside the single bounds', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.world.player.dual = true;
    run(h.engine, 60 * 5, RIGHT);
    shootPlayer(h.engine, -ENGINE.player.dualHalfOffset); // hit the left half
    run(h.engine, 2);
    const p = h.engine.world.player;
    expect(p.dual).toBe(false);
    expect(p.state).toBe('alive');
    expect(p.x).toBeGreaterThanOrEqual(ENGINE.player.minX);
    expect(p.x).toBeLessThanOrEqual(ENGINE.player.maxX);
  });
});

/* -------------------------------- firing rules ------------------------------- */

describe('player firing interval and shot limit', () => {
  it('fire pressed every tick: a shot whenever fewer than two are in flight, never more (no extra cooldown)', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.drainEvents();
    let shots = 0;
    for (let t = 0; t < 60 * 5; t++) {
      const inFlight = h.engine.world.playerShots.length;
      h.engine.step(FIRE);
      const fired = h.engine.drainEvents().filter((e) => e.type === 'playerShot').length;
      // exactly the original rule: one shot per press while below the on-screen limit
      expect(fired, `tick ${t}`).toBe(inFlight < ENGINE.shots.maxSingle ? 1 : 0);
      expect(h.engine.world.playerShots.length).toBeLessThanOrEqual(ENGINE.shots.maxSingle);
      shots += fired;
    }
    expect(shots).toBeGreaterThan(5);
  });

  it('with no target, the sustained fire rate is set by shot travel time', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.debugSetPlayerX(ENGINE.player.minX); // outside the formation columns: shots fly off the top
    for (const e of h.engine.world.enemies) expect(Math.abs(e.x - ENGINE.player.minX)).toBeGreaterThan(12);
    h.engine.drainEvents();
    const ticks: number[] = [];
    for (let t = 0; t < 60 * 3; t++) {
      h.engine.step(FIRE);
      if (h.engine.drainEvents().some((e) => e.type === 'playerShot')) ticks.push(t);
    }
    const travelTicks = ((ENGINE.player.y + ENGINE.shots.spawnOffsetY + 20) / ENGINE.shots.playerSpeed) * ENGINE.tickHz;
    expect(ticks.slice(0, 2)).toEqual([0, 1]);
    expect(Math.abs(ticks[2]! - ticks[0]! - travelTicks)).toBeLessThanOrEqual(2);
  });

  it('no fire input means no shots, and fire is ignored while the fighter is exploding', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    run(h.engine, 60);
    expect(h.engine.world.playerShots).toHaveLength(0);
    shootPlayer(h.engine);
    run(h.engine, 2);
    expect(h.engine.world.player.state).not.toBe('alive');
    run(h.engine, 30, FIRE);
    expect(h.engine.world.playerShots).toHaveLength(0);
  });
});

/* ---------------------------- projectiles / collision ---------------------------- */

describe('projectile collision', () => {
  const edge = (ENGINE.player.hitbox.w + ENGINE.shots.enemyBox.w) / 2;

  it('an enemy shot hits just inside the hitbox edge and misses just outside it', () => {
    for (const [dx, hit] of [[edge - 0.2, true], [-(edge - 0.2), true], [edge + 0.2, false], [-(edge + 0.2), false]] as const) {
      const h = makeEngine();
      startPlaying(h, { quiet: true });
      shootPlayer(h.engine, dx);
      run(h.engine, 3);
      expect(h.engine.world.player.state === 'alive', `dx ${dx}`).toBe(!hit);
    }
  });

  it('a very fast player shot cannot tunnel through an enemy (swept collision)', () => {
    const fast: EngineConfig = { ...ENGINE, shots: { ...ENGINE.shots, playerSpeed: 6000 } }; // 100 px per tick
    const h = makeEngine({ config: fast });
    startPlaying(h, { quiet: true });
    const target = enemiesOf(h.engine, 'scout').sort((a, b) => b.y - a.y)[0]!;
    h.engine.debugSetPlayerX(target.x);
    h.engine.step(FIRE);
    run(h.engine, 10);
    expect(target.state).toBe('destroyed');
  });

  it('a diving enemy that rams the fighter destroys both and pays the attack value once', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const scout = enemiesOf(h.engine, 'scout')[0]!;
    h.engine.debugLaunch('scoutSolo', scout.id);
    runUntil(h.engine, () => h.engine.world.player.state !== 'alive' || scout.state === 'destroyed' || scout.state === 'returning', 60 * 20, () => {
      h.engine.world.enemyShots = [];
      h.engine.debugSetPlayerX(scout.x); // stand in its path
      return NO_INPUT;
    });
    expect(scout.state).toBe('destroyed');
    expect(h.engine.world.player.state).not.toBe('alive');
    const pts = ofType(h, 'pointsAwarded').filter((e) => e.source === 'enemy');
    expect(pts).toHaveLength(1);
    expect(pts[0]!.amount).toBe(CLASSIC_SCORING.enemies.scout.attack);
  });

  it('enemy shots are removed once they leave the playfield', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.debugSetPlayerX(ENGINE.player.minX);
    h.engine.world.enemyShots.push({ id: -9, x: 400, y: 300, prevX: 400, prevY: 300, vx: 0, vy: 300 });
    run(h.engine, 60 * 2);
    expect(h.engine.world.enemyShots).toHaveLength(0);
  });
});

/* ---------------------------- extra-life thresholds ---------------------------- */

describe('extra-life thresholds through real play', () => {
  it('awards one reserve at 20,000 and one at 70,000, each exactly once', () => {
    const h = makeEngine();
    startPlaying(h);
    const reservesAt = (score: number): number => {
      runUntil(h.engine, () => h.rewards.snapshot().score >= score, 60 * 60 * 20, () => {
        h.engine.world.enemyShots = [];
        if ((h.engine.phase === 'playing' || h.engine.phase === 'challenge') && h.engine.world.enemies.length > 0) h.engine.debugDestroyAll();
        return NO_INPUT;
      });
      return h.rewards.snapshot().reserves;
    };
    const start = h.rewards.snapshot().reserves;
    reservesAt(20_000);
    reservesAt(75_000);
    const extra = ofType(h, 'extraLifeAwarded');
    expect(extra.map((e) => e.threshold)).toEqual([20_000, 70_000]);
    expect(h.rewards.snapshot().reserves).toBe(start + 2);
    // each award happened on the points event that crossed its threshold
    for (const e of extra) {
      const idx = h.rewardEvents.indexOf(e);
      const before = h.rewardEvents.slice(0, idx).filter((x) => x.type === 'pointsAwarded').at(-1) as Extract<RewardEvent, { type: 'pointsAwarded' }>;
      expect(before.scoreAfter).toBeGreaterThanOrEqual(e.threshold);
      expect(before.scoreAfter - before.amount).toBeLessThan(e.threshold);
    }
  });
});

/* ------------------------- attacks and return to formation ------------------------- */

describe('return to formation after the fighter is lost', () => {
  it('no new attacks launch while the fighter is down; respawn waits until divers are home', () => {
    const h = makeEngine({ seed: 3 });
    startPlaying(h, { quiet: true });
    h.engine.debugSetPlayerX(ENGINE.player.minX);
    const divers = enemiesOf(h.engine, 'scout').slice(0, 2);
    for (const d of divers) h.engine.debugLaunch('scoutSolo', d.id);
    h.engine.world.attackTimerMs = 0; // scheduler armed: it must still stay silent while the player is down
    run(h.engine, 20);
    expect(attackersInFlight(h.engine.context)).toBeGreaterThan(0);
    shootPlayer(h.engine);
    run(h.engine, 2);
    expect(h.engine.phase).toBe('playerHit');
    h.engine.drainEvents();
    let launched = 0;
    runUntil(h.engine, () => h.engine.phase === 'ready', 60 * 12, () => {
      for (const e of h.engine.drainEvents()) if (e.type === 'attackLaunched') launched += 1;
      return NO_INPUT;
    });
    expect(launched).toBe(0);
    expect(attackersInFlight(h.engine.context)).toBe(0);
    expect(h.engine.world.player.state).toBe('alive');
  });

  it('respawn never waits forever: the maxRespawnWait bound releases it', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    shootPlayer(h.engine);
    run(h.engine, 2);
    // pin an enemy in "attacking" so the field never calms down
    const stuck = enemiesOf(h.engine, 'scout')[0]!;
    const ticks = runUntil(h.engine, () => h.engine.phase !== 'playerHit', 60 * 20, () => {
      stuck.state = 'attacking';
      return NO_INPUT;
    });
    expect(ticks * TICK_MS).toBeLessThanOrEqual(ENGINE.player.maxRespawnWaitMs + 2 * TICK_MS);
  });
});

/* ------------------------------ Challenging Stage ------------------------------ */

describe('Challenging Stage results', () => {
  it('a partial result pays 100 per hit and only the waves that were fully destroyed', () => {
    const h = makeEngine({ startStage: 3 });
    startPlaying(h);
    expect(h.engine.world.stageKind).toBe('challenge');
    const hitPerWave = new Map<number, number>();
    const want = (wave: number): number => (wave === 0 ? 8 : wave === 1 ? 3 : 0); // wave 0 complete, wave 1 partial
    runUntil(h.engine, () => h.engine.phase === 'stageCleared', 60 * 90, () => {
      for (const e of [...h.engine.world.enemies]) {
        if (e.state === 'destroyed' || e.wave === undefined) continue;
        if (e.y < 0 || e.y > 500 || e.x < 0 || e.x > 448) continue;
        const done = hitPerWave.get(e.wave) ?? 0;
        if (done < want(e.wave)) {
          destroyEnemy(h.engine.context, e);
          hitPerWave.set(e.wave, done + 1);
        }
      }
      return NO_INPUT;
    });
    const result = ofType(h, 'challengeStageResult')[0]!;
    expect(result).toMatchObject({ hits: 11, total: 40, perfect: false, bonus: 11 * CLASSIC_SCORING.challenge.perHitBonus });
    const waves = ofType(h, 'challengeWaveCleared');
    expect(waves.map((w) => w.wave)).toEqual([0]);
    expect(waves[0]!.bonus).toBe(CLASSIC_SCORING.challenge.waveBonusByChallenge[0]);
    // the stage then advances normally
    runUntil(h.engine, () => h.engine.phase === 'playing', 60 * 10);
    expect(h.engine.world.stage).toBe(4);
  });

  it('a Challenging Stage with zero hits still ends and pays nothing', () => {
    const h = makeEngine({ startStage: 3 });
    startPlaying(h);
    runUntil(h.engine, () => h.engine.phase === 'stageCleared', 60 * 90);
    const result = ofType(h, 'challengeStageResult')[0]!;
    expect(result).toMatchObject({ hits: 0, perfect: false, bonus: 0 });
    expect(h.rewards.snapshot().score).toBe(0);
  });
});

/* --------------------------------- pause/resume --------------------------------- */

describe('pause is transparent to the simulation', () => {
  it('pausing mid-attack for 10 s then resuming gives exactly the same game as never pausing', () => {
    const twin = makeEngine({ seed: 9 });
    const paused = makeEngine({ seed: 9 });
    startPlaying(twin);
    startPlaying(paused);
    // play until an attack with enemy shots is in progress
    const pre = runUntil(paused.engine, () => attackersInFlight(paused.engine.context) > 0 && paused.engine.world.enemyShots.length > 0, 60 * 60);
    run(twin.engine, pre);
    expect(paused.engine.digest()).toBe(twin.engine.digest());
    const before = JSON.stringify([paused.engine.world.enemies.map((e) => [e.x, e.y]), paused.engine.world.enemyShots.map((s) => [s.x, s.y]), paused.engine.world.player.x]);
    paused.engine.step(PAUSE);
    expect(paused.engine.phase).toBe('paused');
    // 10 s of mashing while paused: nothing moves, nothing fires
    run(paused.engine, 600, (t) => ({ moveX: t % 2 ? 1 : -1, fire: true, pause: false, start: t % 7 === 0 }));
    const during = JSON.stringify([paused.engine.world.enemies.map((e) => [e.x, e.y]), paused.engine.world.enemyShots.map((s) => [s.x, s.y]), paused.engine.world.player.x]);
    expect(during).toBe(before);
    paused.engine.step(PAUSE); // resume: this tick simulates again with neutral movement
    twin.engine.step(NO_INPUT);
    expect(paused.engine.phase).toBe('playing');
    for (let i = 0; i < 300; i++) {
      paused.engine.step(NO_INPUT);
      twin.engine.step(NO_INPUT);
    }
    expect(paused.engine.digest()).toBe(twin.engine.digest()); // no teleport, no skipped or doubled time
  });
});

/* ---------------------------- game over and restart ---------------------------- */

describe('game over and restart', () => {
  it('start is refused for the first second of game over, then starts a clean game', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    for (let i = 0; i < 3; i++) {
      runUntil(h.engine, () => h.engine.world.player.state === 'alive' && h.engine.phase === 'playing', 60 * 20);
      shootPlayer(h.engine);
      run(h.engine, 2);
    }
    runUntil(h.engine, () => h.engine.phase === 'gameOver', 60 * 20);
    h.engine.step({ ...NO_INPUT, start: true });
    expect(h.engine.phase).toBe('gameOver'); // too early: the final score stays readable
    run(h.engine, Math.ceil(1000 / TICK_MS));
    h.engine.step({ ...NO_INPUT, start: true });
    expect(h.engine.phase).toBe('ready');
    expect(h.rewards.snapshot()).toMatchObject({ score: 0, reserves: CLASSIC_SCORING.fighters.starting - 1, stage: 1, status: 'running' });
    expect(h.engine.world.player).toMatchObject({ state: 'alive', dual: false });
    expect(h.engine.world.enemyShots).toHaveLength(0);
    expect(h.engine.world.playerShots).toHaveLength(0);
  });
});
