/**
 * Stage 6 integration tests: complete game sequences driven through the
 * public input interface (InputFrame), with the real reward manager and save
 * system. The autopilot (tests/helpers/autopilot.ts) plays like a player: it
 * only reads the world and returns move/fire/start.
 *
 * Test hooks are used only to *trigger* a specific attack pattern
 * (debugLaunch: scheduling, not outcomes) or as explicitly labelled fixtures.
 * Every score, capture, rescue and stage change comes from the engine.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE } from '../src/config/engine.ts';
import { CLASSIC_SCORING } from '../src/config/scoring.ts';
import { GameEngine } from '../src/core/game/engine.ts';
import { NO_INPUT, type InputFrame } from '../src/core/game/input.ts';
import type { Enemy } from '../src/core/game/types.ts';
import { RewardManager } from '../src/core/rewards/rewardManager.ts';
import type { RewardEvent } from '../src/core/rewards/types.ts';
import { attackersInFlight } from '../src/core/systems/attacks.ts';
import { activeCaptive } from '../src/core/systems/capture.ts';
import { parseSave, SaveManager } from '../src/persistence/saveData.ts';
import { openStore, type StorageLike } from '../src/persistence/storage.ts';
import { botInput, invariantChecker, newStats } from './helpers/autopilot.ts';
import { makeEngine, PAUSE, run, runUntil, shootPlayer, START, startPlaying, type Harness } from './helpers/engine.ts';

const ofType = <T extends RewardEvent['type']>(h: Harness, type: T): Extract<RewardEvent, { type: T }>[] => h.rewardEvents.filter((e): e is Extract<RewardEvent, { type: T }> => e.type === type);

/** Steps with the autopilot, checking the soak invariants on every tick. */
function autoplay(h: Harness, until: () => boolean, maxTicks: number, opts: { skill?: number } = {}): ReturnType<typeof newStats> {
  const stats = newStats();
  const check = invariantChecker(h.engine, stats);
  runUntil(h.engine, until, maxTicks, () => {
    check();
    return botInput(h.engine, opts);
  });
  expect(stats.violations).toEqual([]);
  return stats;
}

/** Move toward x and fire when lined up (a player aiming at one target). */
function aimAt(h: Harness, x: number, fire: boolean): InputFrame {
  const dx = x - h.engine.world.player.x;
  return { ...NO_INPUT, moveX: Math.abs(dx) < 2 ? 0 : dx < 0 ? -1 : 1, fire: fire && Math.abs(dx) < 6 && h.engine.world.tick % 2 === 0 };
}

describe('integration: complete sequences through player input', () => {
  it('start a game, shoot down the entire formation with real entry and attacks, and enter stage 2', () => {
    const h = makeEngine({ seed: 4, instantFormation: false });
    h.engine.step(START);
    autoplay(h, () => h.engine.world.stage === 2 && h.engine.phase === 'ready', 60 * 60 * 4);
    const kills = ofType(h, 'pointsAwarded').filter((e) => e.source === 'enemy');
    expect(kills).toHaveLength(40); // every enemy, each paid once
    expect(new Set(kills.map((k) => k.key)).size).toBe(40);
    expect(kills.some((k) => k.phase === 'attacking')).toBe(true); // divers shot too
    expect(h.rewards.snapshot().score).toBe(kills.reduce((a, k) => a + k.amount, 0));
    expect(ofType(h, 'stageChanged').map((e) => e.stage)).toEqual([1, 2]);
  });

  it('lose a fighter, continue with the next one, and keep scoring', () => {
    const h = makeEngine({ seed: 6 });
    startPlaying(h);
    autoplay(h, () => h.rewards.snapshot().score >= 500, 60 * 60);
    const reserves = h.rewards.snapshot().reserves;
    runUntil(h.engine, () => h.engine.world.player.state === 'alive' && h.engine.phase === 'playing', 60 * 20);
    shootPlayer(h.engine); // fixture: an enemy shot already on target
    run(h.engine, 2);
    expect(h.engine.phase).toBe('playerHit');
    expect(h.rewards.snapshot().reserves).toBe(reserves - 1);
    runUntil(h.engine, () => h.engine.phase === 'playing', 60 * 15);
    expect(h.engine.world.player.state).toBe('alive');
    const scoreAfterRespawn = h.rewards.snapshot().score;
    const x0 = h.engine.world.player.x;
    run(h.engine, 20, { ...NO_INPUT, moveX: x0 > 224 ? -1 : 1 });
    expect(h.engine.world.player.x).not.toBe(x0); // the new fighter is controllable
    autoplay(h, () => h.rewards.snapshot().score > scoreAfterRespawn + 300, 60 * 60);
    expect(h.rewards.snapshot().status).toBe('running');
  });

  it('get captured by moving under a tractor beam, then rescue the fighter by shooting its captor in flight', () => {
    const h = makeEngine({ seed: 2 });
    startPlaying(h, { quiet: true });
    const clearFire = (): void => {
      h.engine.world.enemyShots = []; // fixture: no stray enemy fire in this scripted scene
    };
    const cmd = h.engine.world.enemies.find((e) => e.slot?.id === '0:4')!;
    expect(h.engine.debugLaunch('commanderBeam', cmd.id)).toEqual([cmd.id]); // trigger only
    // the player walks into the beam
    runUntil(h.engine, () => h.engine.world.player.state === 'gone', 60 * 25, () => {
      clearFire();
      return cmd.beam ? aimAt(h, cmd.x, false) : NO_INPUT;
    });
    expect(ofType(h, 'fighterCaptured')).toHaveLength(1);
    const captive = activeCaptive(h.engine.context)!;
    expect(captive.captiveMode).toBe('attached');
    // next fighter; the captor takes the captive home
    runUntil(h.engine, () => h.engine.phase === 'playing' && cmd.state === 'inFormation', 60 * 25, () => {
      clearFire();
      return NO_INPUT;
    });
    // the captor dives; aim at it (shots hit the lowest enemy first, so the captor above is shielded by nothing)
    const ids = h.engine.debugLaunch('commanderEscort', cmd.id); // trigger only
    expect(ids[0]).toBe(cmd.id);
    runUntil(h.engine, () => h.engine.world.player.dual || h.engine.world.player.state !== 'alive', 60 * 30, () => {
      clearFire();
      const escorts = h.engine.world.enemies.filter((e) => ids.includes(e.id) && e.id !== cmd.id && e.state === 'attacking');
      // dodge escorts that come low, otherwise hunt the captor
      const low = escorts.find((e) => e.y > h.engine.world.player.y - 120 && Math.abs(e.x - h.engine.world.player.x) < 40);
      if (low) return { ...NO_INPUT, moveX: low.x < h.engine.world.player.x ? 1 : -1 };
      if (cmd.state === 'attacking' && cmd.y < h.engine.world.player.y - 70) return aimAt(h, cmd.x, true);
      return NO_INPUT;
    });
    expect(h.engine.world.player.state).toBe('alive');
    expect(h.engine.world.player.dual).toBe(true);
    const rescue = ofType(h, 'rescue').map((r) => r.outcome.status);
    expect(rescue).toEqual(['freed', 'rescued']);
    expect(ofType(h, 'dualFighterChanged').at(-1)).toMatchObject({ active: true });
    expect(cmd.state).toBe('destroyed');
  });

  it('Dual Fighter: each press fires a pair from both ships; at most two pairs in flight', () => {
    const h = makeEngine({ seed: 2 });
    startPlaying(h, { quiet: true });
    h.engine.world.player.dual = true; // state set directly here; the full rescue path is the previous test
    h.engine.debugSetPlayerX(ENGINE.player.dualMinX);
    h.engine.drainEvents();
    h.engine.step({ ...NO_INPUT, fire: true });
    const shots = h.engine.world.playerShots;
    expect(shots).toHaveLength(2);
    const px = h.engine.world.player.x;
    expect(shots.map((s) => s.x).sort((a, b) => a - b)).toEqual([px - ENGINE.player.dualHalfOffset, px + ENGINE.player.dualHalfOffset]);
    let max = 0;
    for (let t = 0; t < 120; t++) {
      h.engine.step({ ...NO_INPUT, fire: true });
      max = Math.max(max, h.engine.world.playerShots.length);
      expect(h.engine.world.playerShots.length % 2 === 0 || h.engine.world.playerShots.length <= ENGINE.shots.maxDual).toBe(true);
    }
    expect(max).toBe(ENGINE.shots.maxDual);
  });

  it('play a Challenging Stage imperfectly: bonus = 100 x hits plus only fully cleared waves', () => {
    const h = makeEngine({ seed: 8, startStage: 3 });
    h.engine.step(START);
    const before = (): number => h.rewards.snapshot().score;
    const s0 = before();
    const waveOf = new Map<string, number>();
    autoplay(h, () => {
      for (const e of h.engine.world.enemies) if (e.wave !== undefined) waveOf.set(e.id, e.wave);
      return h.engine.phase === 'stageCleared';
    }, 60 * 120);
    const result = ofType(h, 'challengeStageResult')[0]!;
    expect(result.perfect).toBe(false);
    expect(result.hits).toBeGreaterThan(0);
    expect(result.hits).toBeLessThan(40);
    expect(result.bonus).toBe(result.hits * CLASSIC_SCORING.challenge.perHitBonus);
    const waveBonuses = ofType(h, 'challengeWaveCleared');
    // a wave bonus only for waves where all 8 were hit
    const killsByWave = new Map<number, number>();
    for (const e of ofType(h, 'pointsAwarded').filter((p) => p.source === 'enemy')) {
      const wave = waveOf.get(e.key.split(':')[2]!); // key = kill:<stage>:<enemyId>
      expect(wave, e.key).toBeDefined();
      killsByWave.set(wave!, (killsByWave.get(wave!) ?? 0) + 1);
    }
    const fullWaves = [...killsByWave].filter(([, n]) => n === 8).map(([w]) => w).sort();
    expect(waveBonuses.map((w) => w.wave).sort()).toEqual(fullWaves);
    expect([...killsByWave.values()].reduce((a, n) => a + n, 0)).toBe(result.hits);
    for (const w of waveBonuses) expect(w.bonus).toBe(CLASSIC_SCORING.challenge.waveBonusByChallenge[0]);
    const paid = ofType(h, 'pointsAwarded').reduce((a, p) => a + p.amount, 0);
    expect(before() - s0).toBe(paid);
    expect(waveBonuses.length).toBeLessThanOrEqual(5);
    runUntil(h.engine, () => h.engine.phase === 'playing', 60 * 10);
    expect(h.engine.world.stage).toBe(4);
  });

  it('play a Challenging Stage perfectly: 40 hits, five wave bonuses and the perfect bonus instead of per-hit', () => {
    const h = makeEngine({ seed: 8, startStage: 3 });
    startPlaying(h);
    // fixture: a "perfect marksman" places a real player shot just under each visible enemy;
    // hits still go through collision, damage and the reward manager
    runUntil(h.engine, () => h.engine.phase === 'stageCleared', 60 * 120, () => {
      const w = h.engine.world;
      for (const e of w.enemies) {
        if (e.state === 'destroyed' || e.y < 10 || e.y > 480 || e.x < 4 || e.x > 444) continue;
        if (w.playerShots.some((s) => Math.abs(s.x - e.x) < 1 && s.y > e.y)) continue;
        w.playerShots.push({ id: -1000 - w.tick, x: e.x, y: e.y + 10, prevX: e.x, prevY: e.y + 10, vx: 0, vy: -ENGINE.shots.playerSpeed });
      }
      return NO_INPUT;
    });
    const result = ofType(h, 'challengeStageResult')[0]!;
    expect(result).toMatchObject({ hits: 40, total: 40, perfect: true, bonus: CLASSIC_SCORING.challenge.perfectBonus });
    expect(ofType(h, 'challengeWaveCleared').map((w) => w.wave)).toEqual([0, 1, 2, 3, 4]);
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('reach game over, restart from the game-over screen, and play again cleanly', () => {
    const h = makeEngine({ seed: 5 });
    h.engine.step(START);
    autoplay(h, () => h.engine.phase === 'gameOver', 60 * 60 * 20, { skill: 0.6 });
    const first = ofType(h, 'gameOver')[0]!;
    expect(first.finalScore).toBeGreaterThan(0);
    run(h.engine, Math.ceil(ENGINE.tickHz * 1.1));
    h.engine.step(START);
    expect(h.engine.phase).toBe('ready');
    expect(h.rewards.snapshot()).toMatchObject({ score: 0, stage: 1, status: 'running', highScore: first.finalScore });
    expect(h.engine.world.enemies.length).toBeGreaterThan(0);
    autoplay(h, () => h.rewards.snapshot().score >= 1000, 60 * 60 * 2);
    expect(h.rewards.snapshot().highScore).toBe(Math.max(first.finalScore, h.rewards.snapshot().score));
  });

  it('pause during an attack, resume, and nothing has teleported (per-tick displacement stays physical)', () => {
    const h = makeEngine({ seed: 9 });
    startPlaying(h);
    runUntil(h.engine, () => attackersInFlight(h.engine.context) > 0 && h.engine.world.enemyShots.length > 0, 60 * 60, () => NO_INPUT);
    const pos = (): Map<string, [number, number]> => new Map([...h.engine.world.enemies.map((e): [string, [number, number]] => [e.id, [e.x, e.y]]), ...h.engine.world.enemyShots.map((s): [string, [number, number]] => [`s${s.id}`, [s.x, s.y]])]);
    const a = pos();
    h.engine.step(PAUSE);
    run(h.engine, 60 * 30, { ...NO_INPUT, fire: true, moveX: 1 });
    h.engine.step(PAUSE);
    const b = pos();
    const maxStep = Math.max(ENGINE.shots.playerSpeed, 400) / ENGINE.tickHz; // fastest mover per tick, generous
    for (const [id, [x, y]] of b) {
      const old = a.get(id);
      if (!old) continue;
      expect(Math.hypot(x - old[0], y - old[1]), id).toBeLessThanOrEqual(maxStep);
    }
  });

  it('save a high score, "reload" (new managers on the same storage), and recover it; corrupt data recovers safely', () => {
    const backing = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (k) => backing.get(k) ?? null,
      setItem: (k, v) => void backing.set(k, v),
      removeItem: (k) => void backing.delete(k),
    };
    // session 1: same wiring as src/game/app.ts
    const save1 = new SaveManager(openStore(() => storage));
    const rewards1 = new RewardManager({ highScore: save1.get().highScore });
    rewards1.events.on('gameOver', (e) => save1.recordGameResult({ score: e.finalScore, stage: e.stage }));
    const engine1 = new GameEngine({ rewards: rewards1, seed: 3 });
    engine1.step(START);
    runUntil(engine1, () => engine1.phase === 'gameOver', 60 * 60 * 20, () => botInput(engine1, { skill: 0.6 }));
    const final = rewards1.snapshot().score;
    expect(final).toBeGreaterThan(0);
    // session 2 ("page reload")
    const save2 = new SaveManager(openStore(() => storage));
    expect(save2.loadStatus).toBe('ok');
    expect(save2.get().highScore).toBe(final);
    const rewards2 = new RewardManager({ highScore: save2.get().highScore });
    expect(rewards2.snapshot().highScore).toBe(final);
    // a worse game does not overwrite it
    save2.recordGameResult({ score: Math.max(0, final - 10), stage: 1 });
    expect(new SaveManager(openStore(() => storage)).get().highScore).toBe(final);
    // corrupt the stored document: defaults, no throw, and the game still starts
    for (const key of backing.keys()) backing.set(key, '{"version":1,"highScore":"lots"');
    const save3 = new SaveManager(openStore(() => storage));
    expect(save3.get().highScore).toBe(0);
    expect(parseSave('not json').data.highScore).toBe(0);
    const e3 = new GameEngine({ rewards: new RewardManager({ highScore: save3.get().highScore }), seed: 1 });
    e3.step(START);
    expect(e3.phase).toBe('ready');
  });
});

/** Re-exported for the soak test. */
export type { Enemy };
