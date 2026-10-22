/**
 * Engine core: phase machine, fixed-step loop, player movement, projectiles,
 * enemy destruction and scoring facts, pause, determinism.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE } from '../src/config/engine.ts';
import { CLASSIC_SCORING } from '../src/config/scoring.ts';
import { FixedStepClock } from '../src/core/clock.ts';
import { NO_INPUT } from '../src/core/game/input.ts';
import { PhaseMachine, TRANSITIONS, type GamePhase } from '../src/core/game/stateMachine.ts';
import { destroyEnemy } from '../src/core/systems/damage.ts';
import { buildPath, pointAt } from '../src/core/systems/paths.ts';
import { spawnEnemyShot } from '../src/core/systems/projectiles.ts';
import { enemiesOf, FIRE, LEFT, makeEngine, PAUSE, RIGHT, run, runUntil, score, START, startPlaying } from './helpers/engine.ts';

const S = CLASSIC_SCORING.enemies;

describe('phase state machine', () => {
  it('allows only table transitions and counts refusals', () => {
    const m = new PhaseMachine();
    expect(m.phase).toBe('boot');
    expect(m.transition('playing')).toBe(false);
    expect(m.refused).toBe(1);
    expect(m.transition('title')).toBe(true);
    expect(m.transition('ready')).toBe(true);
    expect(m.transition('gameOver')).toBe(false);
    expect(m.phase).toBe('ready');
  });

  it('every phase is reachable from boot', () => {
    const seen = new Set<GamePhase>(['boot']);
    const queue: GamePhase[] = ['boot'];
    while (queue.length) for (const n of TRANSITIONS[queue.shift()!]) if (!seen.has(n)) (seen.add(n), queue.push(n));
    seen.add('paused');
    expect([...seen].sort()).toEqual(Object.keys(TRANSITIONS).sort());
  });

  it('pause remembers and resumes the interrupted phase; title and game over cannot pause', () => {
    const m = new PhaseMachine();
    expect(m.pause()).toBe(false); // boot
    m.transition('title');
    expect(m.pause()).toBe(false);
    m.transition('ready');
    m.transition('playing');
    expect(m.pause()).toBe(true);
    expect(m.phase).toBe('paused');
    expect(m.activePhase).toBe('playing');
    expect(m.transition('stageCleared')).toBe(false);
    expect(m.resume()).toBe(true);
    expect(m.phase).toBe('playing');
  });

  it('a new game runs boot > title > ready > playing', () => {
    const h = makeEngine();
    expect(h.engine.phase).toBe('title');
    startPlaying(h);
    expect(h.engine.machine.history.slice(0, 4)).toEqual(['boot', 'title', 'ready', 'playing']);
    expect(h.engine.machine.refused).toBe(0);
  });
});

describe('fixed-step loop', () => {
  function runAtHz(hz: number, totalMs: number): { ticks: number; digest: string } {
    const h = makeEngine({ instantFormation: false, seed: 9 });
    const clock = new FixedStepClock({ hz: ENGINE.tickHz, maxFrameMs: ENGINE.maxFrameMs });
    let i = 0;
    const tick = (): void => {
      h.engine.step(i === 0 ? START : i % 7 === 0 ? FIRE : i % 50 < 25 ? LEFT : RIGHT);
      i++;
    };
    // frames at the display rate, then one shared final timestamp (mid-tick, away from float boundaries)
    for (let k = 0; (k * 1000) / hz < totalMs - 8; k++) clock.advance((k * 1000) / hz, tick);
    clock.advance(totalMs, tick);
    return { ticks: i, digest: h.engine.digest() };
  }

  it('the same simulated time gives the same state at 30, 60 and 144 Hz displays', () => {
    const a = runAtHz(30, 5008);
    const b = runAtHz(60, 5008);
    const c = runAtHz(144, 5008);
    expect(b.ticks).toBe(Math.floor(5008 / (1000 / ENGINE.tickHz)));
    expect(a.ticks).toBe(b.ticks);
    expect(c.ticks).toBe(b.ticks);
    expect(a.digest).toBe(b.digest);
    expect(c.digest).toBe(b.digest);
  });

  it('a long stall is clamped instead of fast-forwarding', () => {
    const clock = new FixedStepClock({ hz: ENGINE.tickHz, maxFrameMs: ENGINE.maxFrameMs });
    let ticks = 0;
    clock.advance(0, () => ticks++);
    clock.advance(10_000, () => ticks++);
    expect(ticks).toBeLessThanOrEqual(Math.ceil(ENGINE.maxFrameMs / (1000 / ENGINE.tickHz)));
  });

  it('paths are walked at constant speed by arc length', () => {
    const path = buildPath([[0, 0], [100, 0], [100, 100], [0, 100]]);
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    const steps: number[] = [];
    for (let s = 0; s + 10 <= path.length; s += 10) {
      pointAt(path, s, a);
      pointAt(path, s + 10, b);
      steps.push(Math.hypot(b.x - a.x, b.y - a.y));
    }
    for (const d of steps) expect(d).toBeGreaterThan(9.5);
    for (const d of steps) expect(d).toBeLessThanOrEqual(10.0001);
  });
});

describe('player movement', () => {
  it('direct movement covers speed x time and stops at the bounds', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const x0 = h.engine.world.player.x;
    run(h.engine, 30, RIGHT);
    expect(h.engine.world.player.x - x0).toBeCloseTo(ENGINE.player.speed * 0.5, 6);
    run(h.engine, 300, RIGHT);
    expect(h.engine.world.player.x).toBe(ENGINE.player.maxX);
    run(h.engine, 600, LEFT);
    expect(h.engine.world.player.x).toBe(ENGINE.player.minX);
  });

  it('acceleration mode ramps up and eases out', () => {
    const cfg = { ...ENGINE, player: { ...ENGINE.player, movement: 'accel' as const } };
    const h = makeEngine({ config: cfg });
    startPlaying(h, { quiet: true });
    run(h.engine, 3, RIGHT);
    const early = h.engine.world.player.vx;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(ENGINE.player.speed);
    run(h.engine, 30, RIGHT);
    expect(h.engine.world.player.vx).toBe(ENGINE.player.speed);
    run(h.engine, 60, NO_INPUT);
    expect(h.engine.world.player.vx).toBe(0);
  });

  it('cannot move or fire outside playing (ready phase)', () => {
    const h = makeEngine();
    h.engine.step(START);
    expect(h.engine.phase).toBe('ready');
    const x0 = h.engine.world.player.x;
    run(h.engine, 30, (i) => (i % 2 ? FIRE : RIGHT));
    expect(h.engine.world.player.x).toBe(x0);
    expect(h.engine.world.playerShots).toHaveLength(0);
  });
});

describe('projectiles', () => {
  it('a single fighter keeps at most two shots on screen', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.debugSetPlayerX(ENGINE.player.minX); // empty column: shots fly to the top
    let max = 0;
    run(h.engine, 20, (i) => {
      max = Math.max(max, h.engine.world.playerShots.length);
      return i % 2 === 0 ? FIRE : NO_INPUT;
    });
    expect(max).toBe(ENGINE.shots.maxSingle);
    expect(h.engine.drainEvents().filter((e) => e.type === 'playerShot')).toHaveLength(2);
  });

  it('shots travel at the configured speed and are removed off screen', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.debugSetPlayerX(ENGINE.player.minX);
    h.engine.step(FIRE);
    const y0 = h.engine.world.playerShots[0]!.y;
    run(h.engine, 30);
    expect(y0 - h.engine.world.playerShots[0]!.y).toBeCloseTo(ENGINE.shots.playerSpeed * 0.5, 6);
    run(h.engine, 60);
    expect(h.engine.world.playerShots).toHaveLength(0);
  });

  it('enemy shots are aimed but never steeper than the slope cap', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.debugSetPlayerX(ENGINE.player.maxX);
    const scout = enemiesOf(h.engine, 'scout').find((e) => e.slot!.col === 0)!;
    h.engine.world.enemyShots = [];
    spawnEnemyShot(h.engine.context, scout.x, scout.y);
    const s = h.engine.world.enemyShots[0]!;
    expect(Math.abs(s.vx)).toBeLessThanOrEqual(s.vy * ENGINE.shots.enemyMaxSlope + 1e-9);
    expect(s.vx).toBeGreaterThan(0);
  });
});

describe('enemy destruction and scoring facts', () => {
  it('shooting a scout in formation destroys it and pays the formation value via the reward manager', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const target = enemiesOf(h.engine, 'scout').find((e) => e.slot!.id === '4:0')!;
    h.engine.debugSetPlayerX(target.x);
    h.engine.step(FIRE);
    runUntil(h.engine, () => target.state === 'destroyed' || !h.engine.world.enemies.includes(target), 120);
    expect(score(h)).toBe(S.scout.formation);
    expect(h.engine.world.enemies).toHaveLength(39);
    expect(h.rewardEvents.some((e) => e.type === 'pointsAwarded' && e.enemyKind === 'scout' && e.phase === 'formation')).toBe(true);
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('a shot hits only one enemy (the nearest in its path)', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const lower = h.engine.world.enemies.find((e) => e.slot?.id === '4:4')!;
    h.engine.debugSetPlayerX(lower.x);
    h.engine.step(FIRE);
    runUntil(h.engine, () => h.engine.world.playerShots.length === 0, 120);
    expect(h.engine.world.enemies).toHaveLength(39);
    expect(h.engine.world.enemies.includes(lower)).toBe(false);
  });

  it('commanders take two hits; only the kill scores', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    // clear the column below commander 0:3 so shots can reach it
    for (const e of [...h.engine.world.enemies]) if (e.slot && e.slot.col === 3 && e.kind !== 'commander') destroyEnemy(h.engine.context, e);
    run(h.engine, 1);
    const before = score(h);
    const cmd = h.engine.world.enemies.find((e) => e.slot?.id === '0:3')!;
    h.engine.debugSetPlayerX(cmd.x);
    h.engine.step(FIRE);
    runUntil(h.engine, () => cmd.hp === 1, 120);
    expect(score(h)).toBe(before);
    expect(cmd.state).toBe('inFormation');
    runUntil(h.engine, () => h.engine.world.playerShots.length === 0, 120);
    h.engine.step(FIRE);
    runUntil(h.engine, () => cmd.state === 'destroyed' || !h.engine.world.enemies.includes(cmd), 120);
    expect(score(h) - before).toBe(S.commander.formation);
  });

  it('a diving scout pays the attack value', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const s = enemiesOf(h.engine, 'scout')[0]!;
    h.engine.debugLaunch('scoutSolo', s.id);
    run(h.engine, 10);
    expect(s.state).toBe('attacking');
    destroyEnemy(h.engine.context, s);
    expect(score(h)).toBe(S.scout.attack);
  });

  it('a commander diving with two escorts pays the two-escort value even if the escorts die first', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const cmd = h.engine.world.enemies.find((e) => e.slot?.id === '0:4')!;
    const ids = h.engine.debugLaunch('commanderEscort', cmd.id);
    expect(ids).toHaveLength(3);
    expect(cmd.escortsAtDiveStart).toBe(2);
    run(h.engine, 20);
    for (const id of ids.slice(1)) destroyEnemy(h.engine.context, h.engine.world.enemies.find((e) => e.id === id)!);
    const before = score(h);
    destroyEnemy(h.engine.context, cmd);
    expect(score(h) - before).toBe(S.commander.attackByEscorts[2]);
  });

  it('the same enemy can never be scored twice', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const s = enemiesOf(h.engine, 'scout')[0]!;
    destroyEnemy(h.engine.context, s);
    destroyEnemy(h.engine.context, s);
    expect(score(h)).toBe(S.scout.formation);
    expect(h.engine.rejectedFacts).toEqual([]);
  });
});

describe('pause', () => {
  it('ignores movement and fire while paused, and start/fire do not resume', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    h.engine.step(PAUSE);
    expect(h.engine.phase).toBe('paused');
    const tick = h.engine.world.tick;
    const x = h.engine.world.player.x;
    run(h.engine, 120, (i) => (i % 3 === 0 ? FIRE : i % 3 === 1 ? START : RIGHT));
    expect(h.engine.phase).toBe('paused');
    expect(h.engine.world.tick).toBe(tick);
    expect(h.engine.world.player.x).toBe(x);
    expect(h.engine.world.playerShots).toHaveLength(0);
    h.engine.step(PAUSE);
    expect(h.engine.phase).toBe('playing');
  });

  it('auto-pause API pauses only pausable phases', () => {
    const h = makeEngine();
    expect(h.engine.pause()).toBe(false); // title
    startPlaying(h);
    expect(h.engine.pause()).toBe(true);
    expect(h.engine.resume()).toBe(true);
  });
});

describe('determinism', () => {
  const script = (i: number) => (i === 0 ? START : i % 9 === 0 ? FIRE : i % 120 < 60 ? LEFT : RIGHT);

  it('the same seed and input give the same state hash', () => {
    const a = makeEngine({ seed: 1234, instantFormation: false });
    const b = makeEngine({ seed: 1234, instantFormation: false });
    run(a.engine, 60 * 40, script);
    run(b.engine, 60 * 40, script);
    expect(a.engine.digest()).toBe(b.engine.digest());
    expect(score(a)).toBe(score(b));
    expect(a.engine.rejectedFacts).toEqual([]);
  });

  it('a different seed changes attack choices', () => {
    const a = makeEngine({ seed: 1, instantFormation: true });
    const b = makeEngine({ seed: 2, instantFormation: true });
    run(a.engine, 60 * 20, (i) => (i === 0 ? START : NO_INPUT));
    run(b.engine, 60 * 20, (i) => (i === 0 ? START : NO_INPUT));
    expect(a.engine.digest()).not.toBe(b.engine.digest());
  });
});
