/**
 * Formation, entry, enemy FSM, attack limits, stage completion, Challenging
 * Stages, transforms, lives and game over.
 */
import { describe, expect, it } from 'vitest';
import { tuningForStage, transformKindForStage } from '../src/config/difficulty.ts';
import { ENGINE } from '../src/config/engine.ts';
import { CLASSIC_SCORING } from '../src/config/scoring.ts';
import { NO_INPUT } from '../src/core/game/input.ts';
import type { EnemyState } from '../src/core/game/types.ts';
import { attackersInFlight } from '../src/core/systems/attacks.ts';
import { destroyEnemy } from '../src/core/systems/damage.ts';
import { buildEntryQueue } from '../src/core/systems/entry.ts';
import { buildSlots, slotPosition } from '../src/core/systems/formation.ts';
import { enemiesOf, FIRE, makeEngine, run, runUntil, score, shootPlayer, START, startPlaying } from './helpers/engine.ts';

describe('formation', () => {
  it('has 40 slots: 4 commanders, 16 interceptors, 20 scouts, symmetric about the centre', () => {
    const slots = buildSlots();
    expect(slots).toHaveLength(40);
    const count = (k: string) => slots.filter((s) => s.kind === k).length;
    expect([count('commander'), count('interceptor'), count('scout')]).toEqual([4, 16, 20]);
    expect(new Set(slots.map((s) => s.id)).size).toBe(40);
    const xs = slots.map((s) => s.baseX).sort((a, b) => a - b);
    expect(xs[0]! + xs[xs.length - 1]!).toBe(ENGINE.world.width);
  });

  it('the entry sequence fills every slot exactly once, in a fixed order', () => {
    const q = buildEntryQueue();
    expect(q.map((s) => s.slotId).sort()).toEqual(buildSlots().map((s) => s.id).sort());
    expect(buildEntryQueue()).toEqual(q);
  });

  it('after the entry flights all 40 enemies sit exactly on their slots (no scatter)', () => {
    const h = makeEngine({ instantFormation: false });
    startPlaying(h);
    h.engine.world.attackTimerMs = Number.POSITIVE_INFINITY;
    runUntil(h.engine, () => h.engine.world.formation.entryComplete, 60 * 30, () => {
      h.engine.world.attackTimerMs = Number.POSITIVE_INFINITY;
      h.engine.world.enemyShots = [];
      return NO_INPUT;
    });
    const w = h.engine.world;
    expect(w.enemies).toHaveLength(40);
    const p = { x: 0, y: 0 };
    for (const e of w.enemies) {
      expect(e.state).toBe('inFormation');
      slotPosition(w.formation, e.slot!, p);
      expect(e.x).toBeCloseTo(p.x, 6);
      expect(e.y).toBeCloseTo(p.y, 6);
    }
    run(h.engine, 60 * 4, () => {
      h.engine.world.attackTimerMs = Number.POSITIVE_INFINITY;
      return NO_INPUT;
    });
    expect(w.formation.mode).toBe('breathe');
    expect(h.engine.rejectedFacts).toEqual([]);
  });
});

describe('enemy state machine', () => {
  it('a diver goes inFormation > attacking > returning > formingUp > inFormation', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.debugSetPlayerX(20);
    const s = enemiesOf(h.engine, 'scout').find((e) => e.slot!.id === '3:5')!;
    const seen: EnemyState[] = [s.state];
    h.engine.debugLaunch('scoutSolo', s.id);
    runUntil(h.engine, () => {
      if (seen[seen.length - 1] !== s.state) seen.push(s.state);
      return seen.length > 1 && s.state === 'inFormation';
    }, 60 * 30, () => {
      h.engine.world.enemyShots = [];
      // stay clear of the diver (dives stay inside the playfield since Stage 6, so no corner is safe)
      h.engine.debugSetPlayerX(s.x < 224 ? 420 : 28);
      return NO_INPUT;
    });
    expect(seen).toEqual(['inFormation', 'attacking', 'returning', 'formingUp', 'inFormation']);
  });

  it('the attack scheduler respects the per-stage attacker limit', () => {
    const h = makeEngine({ seed: 5 });
    startPlaying(h);
    let max = 0;
    run(h.engine, 60 * 60, () => {
      // keep the player alive so the scheduler stays active
      h.engine.world.enemyShots = [];
      if (h.engine.phase === 'playing') max = Math.max(max, attackersInFlight(h.engine.context));
      return NO_INPUT;
    });
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(tuningForStage(1).maxAttackers);
  });

  it('difficulty ramps by stage and saturates at its limits', () => {
    const a = tuningForStage(1);
    const b = tuningForStage(10);
    const c = tuningForStage(200);
    expect(b.attackIntervalMs).toBeLessThan(a.attackIntervalMs);
    expect(b.diveSpeed).toBeGreaterThan(a.diveSpeed);
    expect(c).toEqual(tuningForStage(300));
    expect(a.entryFire).toBe(false);
    expect(tuningForStage(5).entryFire).toBe(true);
  });
});

describe('stage completion', () => {
  it('clearing every enemy advances to the next stage automatically', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.debugDestroyAll();
    run(h.engine, 1);
    expect(h.engine.phase).toBe('stageCleared');
    runUntil(h.engine, () => h.engine.phase === 'playing');
    expect(h.engine.world.stage).toBe(2);
    expect(h.engine.world.enemies).toHaveLength(40);
    expect(h.rewards.snapshot().stage).toBe(2);
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('Challenging Stages fall on stage 3 and then every 4th', () => {
    const kinds: string[] = [];
    for (const stage of [1, 2, 3, 4, 6, 7, 11, 15]) {
      const h = makeEngine({ startStage: stage });
      h.engine.step(START);
      kinds.push(h.engine.world.stageKind);
    }
    expect(kinds).toEqual(['normal', 'normal', 'challenge', 'normal', 'normal', 'challenge', 'challenge', 'challenge']);
  });

  it('a Challenging Stage sends 40 scripted enemies in 5 waves, none fire, and it ends when all are resolved', () => {
    const h = makeEngine({ startStage: 3 });
    startPlaying(h);
    expect(h.engine.phase).toBe('challenge');
    const waves = new Map<number, number>();
    let shots = 0;
    runUntil(h.engine, () => h.engine.phase === 'stageCleared', 60 * 60, () => {
      for (const e of h.engine.world.enemies) if (e.wave !== undefined && e.stateMs === 0) waves.set(e.wave, (waves.get(e.wave) ?? 0) + 1);
      shots = Math.max(shots, h.engine.world.enemyShots.length);
      h.engine.debugSetPlayerX(ENGINE.player.minX); // out of the flight paths
      return NO_INPUT;
    });
    expect(h.engine.world.challenge!.total).toBe(40);
    expect(h.engine.world.challenge!.spawned).toBe(40);
    expect(shots).toBe(0);
    const result = h.rewardEvents.find((e) => e.type === 'challengeStageResult');
    expect(result).toMatchObject({ hits: 0, total: 40, perfect: false });
    runUntil(h.engine, () => h.engine.phase === 'playing');
    expect(h.engine.world.stage).toBe(4);
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('destroying all 40 challenge enemies earns wave bonuses and the perfect bonus', () => {
    const h = makeEngine({ startStage: 3 });
    startPlaying(h);
    runUntil(h.engine, () => h.engine.phase === 'stageCleared', 60 * 60, () => {
      for (const e of [...h.engine.world.enemies]) if (e.state !== 'destroyed' && e.y > 0 && e.y < 500 && e.x > 0 && e.x < 448) destroyEnemy(h.engine.context, e);
      return NO_INPUT;
    });
    const result = h.rewardEvents.find((e) => e.type === 'challengeStageResult');
    expect(result).toMatchObject({ hits: 40, perfect: true, bonus: CLASSIC_SCORING.challenge.perfectBonus });
    expect(h.rewardEvents.filter((e) => e.type === 'challengeWaveCleared')).toHaveLength(5);
  });
});

describe('transforms', () => {
  it('rotate by config: none before stage 4, then stinger, phantom, sovereign', () => {
    expect([3, 4, 6, 8, 10, 12, 16].map((s) => transformKindForStage(s))).toEqual([null, 'stinger', 'stinger', 'phantom', 'phantom', 'sovereign', 'stinger']);
  });

  it('a transform scout splits into a trio; destroying all three pays the group bonus once', () => {
    const h = makeEngine({ startStage: 4 });
    startPlaying(h, { quiet: true });
    h.engine.debugSetPlayerX(20);
    expect(h.engine.debugLaunch('transform')).toHaveLength(1);
    runUntil(h.engine, () => enemiesOf(h.engine, 'transform').length === 3, 60 * 10);
    const trio = enemiesOf(h.engine, 'transform');
    expect(new Set(trio.map((t) => t.groupId)).size).toBe(1);
    expect(trio.every((t) => t.transformKind === 'stinger')).toBe(true);
    expect(enemiesOf(h.engine, 'scout')).toHaveLength(19);
    for (const t of trio) destroyEnemy(h.engine.context, t);
    const cleared = h.rewardEvents.filter((e) => e.type === 'transformGroupCleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ bonus: CLASSIC_SCORING.transforms.kinds.stinger.groupBonus });
    expect(h.engine.debugLaunch('transform')).toEqual([]); // one per stage
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('a trio that escapes ends its group without a bonus', () => {
    const h = makeEngine({ startStage: 4 });
    startPlaying(h, { quiet: true });
    h.engine.debugSetPlayerX(20);
    h.engine.debugLaunch('transform');
    runUntil(h.engine, () => enemiesOf(h.engine, 'transform').length === 3, 60 * 10);
    destroyEnemy(h.engine.context, enemiesOf(h.engine, 'transform')[0]!);
    runUntil(h.engine, () => enemiesOf(h.engine, 'transform').length === 0, 60 * 20, () => {
      h.engine.world.enemyShots = [];
      h.engine.debugSetPlayerX(h.engine.world.enemies.some((e) => e.kind === 'transform' && e.x < 224) ? 420 : 20);
      return NO_INPUT;
    });
    expect(h.rewardEvents.filter((e) => e.type === 'transformGroupCleared')).toHaveLength(0);
    expect(h.engine.rejectedFacts).toEqual([]);
  });
});

describe('lives and game over', () => {
  it('losing a fighter uses a reserve and respawns a fresh single fighter', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    expect(h.rewards.snapshot().reserves).toBe(2);
    shootPlayer(h.engine);
    run(h.engine, 1);
    expect(h.engine.phase).toBe('playerHit');
    expect(h.rewards.snapshot().reserves).toBe(1);
    runUntil(h.engine, () => h.engine.phase === 'playing');
    expect(h.engine.world.player).toMatchObject({ state: 'alive', dual: false, fighterId: 'f2', x: ENGINE.world.width / 2 });
  });

  it('losing the last fighter ends the game; nothing scores afterwards; restart resets', () => {
    const h = makeEngine();
    startPlaying(h);
    for (let i = 0; i < 3; i++) {
      runUntil(h.engine, () => h.engine.phase === 'playing');
      shootPlayer(h.engine);
      run(h.engine, 1);
    }
    runUntil(h.engine, () => h.engine.phase === 'gameOver', 60 * 20);
    expect(h.rewards.snapshot().status).toBe('over');
    expect(h.rewardEvents.filter((e) => e.type === 'gameOver')).toHaveLength(1);
    const final = score(h);
    // spam fire / movement: no shots, no points, no rejected facts. Even a ship forced
    // alive (defence in depth) cannot act: the phase itself refuses control.
    h.engine.world.player.state = 'alive';
    const x = h.engine.world.player.x;
    run(h.engine, 50, (i) => (i % 2 ? FIRE : { ...NO_INPUT, moveX: 1 }));
    expect(h.engine.world.playerShots).toHaveLength(0);
    expect(h.engine.world.player.x).toBe(x);
    expect(score(h)).toBe(final);
    expect(h.engine.rejectedFacts).toEqual([]);
    // start is ignored for the first second, then restarts
    h.engine.step(START);
    expect(h.engine.phase).toBe('gameOver');
    run(h.engine, 60);
    h.engine.step(START);
    expect(h.engine.phase).toBe('ready');
    expect(h.engine.machine.history.slice(-3)).toEqual(['gameOver', 'restarting', 'ready']);
    expect(score(h)).toBe(0);
    expect(h.rewards.snapshot().reserves).toBe(2);
  });

  it('game over returns to the title on its own', () => {
    const h = makeEngine({ config: { ...ENGINE, stage: { ...ENGINE.stage, gameOverMs: 500 } } });
    startPlaying(h);
    for (let i = 0; i < 3; i++) {
      runUntil(h.engine, () => h.engine.phase === 'playing');
      shootPlayer(h.engine);
      run(h.engine, 1);
    }
    runUntil(h.engine, () => h.engine.phase === 'title', 60 * 30);
  });
});
