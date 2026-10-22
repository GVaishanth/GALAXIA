/**
 * Stage 4 effect systems: bounded pools, defined durations, cleanup,
 * reduced motion and the read-only contract of the FX director.
 */
import { describe, expect, it } from 'vitest';
import { FX } from '../src/config/effects.ts';
import { HUD_LAYOUT } from '../src/config/hud.ts';
import type { GameEvent } from '../src/core/game/events.ts';
import type { Enemy, World } from '../src/core/game/types.ts';
import type { RewardEvent } from '../src/core/rewards/types.ts';
import { BoundedList, Marks, Shake } from '../src/render/fx/effects.ts';
import { FxDirector } from '../src/render/fx/fxDirector.ts';
import { ParticlePool } from '../src/render/fx/particles.ts';

function enemy(id: string, over: Partial<Enemy> = {}): Enemy {
  return {
    id,
    kind: 'scout',
    state: 'inFormation',
    x: 200,
    y: 200,
    prevX: 200,
    prevY: 200,
    dirX: 0,
    dirY: 1,
    hp: 1,
    stateMs: 0,
    hitFlashMs: 0,
    run: null,
    slot: null,
    ...over,
  } as Enemy;
}

function world(enemies: Enemy[] = []): Pick<World, 'enemies' | 'player' | 'stageKind'> {
  return {
    enemies,
    stageKind: 'normal',
    player: { state: 'alive', x: 224, y: 530, prevX: 224, prevY: 530, vx: 0, dual: false, fighterId: 'f1', fighterSeq: 1, tractorCaptorId: null, lastShipLost: false },
  };
}

const boom = (i: number, kind: Enemy['kind'] = 'commander'): GameEvent => ({ type: 'enemyDestroyed', id: `e${i}`, kind, x: 100 + (i % 200), y: 100 + (i % 300) });

describe('ParticlePool', () => {
  it('never exceeds its capacity and counts refused spawns', () => {
    const pool = new ParticlePool(50);
    for (let i = 0; i < 200; i++) pool.spawn({ x: 0, y: 0, vx: 1, vy: 1, lifeMs: 500, size: 1, color: '#fff' });
    expect(pool.active).toBe(50);
    expect(pool.dropped).toBe(150);
    expect(pool.spawned).toBe(50);
  });

  it('recycles every particle once its life is over (no leak across bursts)', () => {
    const pool = new ParticlePool(64);
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 64; i++) pool.spawn({ x: i, y: i, vx: 10, vy: -10, lifeMs: 100 + i, size: 2, color: '#f00', drag: 0.5, gravity: 30 });
      for (let t = 0; t < 20; t++) pool.update(16);
      expect(pool.active).toBe(0);
    }
    expect(pool.spawned).toBe(64 * 20);
  });

  it('ignores invalid lifetimes and zero time steps', () => {
    const pool = new ParticlePool(4);
    expect(pool.spawn({ x: 0, y: 0, vx: 0, vy: 0, lifeMs: 0, size: 1, color: '#fff' })).toBe(false);
    pool.spawn({ x: 0, y: 0, vx: 0, vy: 0, lifeMs: 100, size: 1, color: '#fff' });
    pool.update(0);
    expect(pool.maxAgeRatio()).toBe(0);
  });
});

describe('effect primitives', () => {
  it('BoundedList evicts the oldest entry at capacity and expires by duration', () => {
    const list = new BoundedList<{ age: number; ms: number; n: number }>(3);
    for (let n = 0; n < 5; n++) list.push({ age: 0, ms: 100 + n * 10, n });
    expect(list.items.map((i) => i.n)).toEqual([2, 3, 4]);
    expect(list.evicted).toBe(2);
    list.update(125);
    expect(list.items.map((i) => i.n)).toEqual([3, 4]);
    list.update(100);
    expect(list.size).toBe(0);
  });

  it('Shake takes the stronger of overlapping shakes (never accumulates) and ends', () => {
    const s = new Shake();
    for (let i = 0; i < 50; i++) s.add(4, 300);
    expect(s.amplitude).toBe(4);
    s.add(2, 100); // weaker: ignored
    expect(s.amplitude).toBe(4);
    s.update(301);
    expect(s.amplitude).toBe(0);
    expect(s.offset(() => 0.9)).toEqual({ x: 0, y: 0 });
  });

  it('Shake offsets are whole art pixels within the amplitude', () => {
    const s = new Shake();
    s.add(3, 1000);
    for (const r of [0, 0.25, 0.5, 0.99]) {
      const o = s.offset(() => r);
      expect(Number.isInteger(o.x) && Number.isInteger(o.y)).toBe(true);
      expect(Math.abs(o.x)).toBeLessThanOrEqual(3);
    }
  });

  it('Marks are bounded and expire', () => {
    const m = new Marks(4);
    for (let i = 0; i < 10; i++) m.set(`e${i}`, 100);
    expect(m.size).toBe(4);
    expect(m.active('e9', 50)).toBe(true);
    expect(m.active('e0', 50)).toBe(false);
    m.prune(100);
    expect(m.size).toBe(0);
  });
});

describe('FxDirector', () => {
  it('stays within every cap under a storm of events', () => {
    const fx = new FxDirector();
    const w = world(Array.from({ length: 40 }, (_, i) => enemy(`e${i}`, { state: 'attacking', dirX: 0.6, dirY: 0.8 })));
    for (let frame = 0; frame < 120; frame++) {
      for (let i = 0; i < 25; i++) fx.handleGameEvent(boom(frame * 25 + i), w);
      fx.handleGameEvent({ type: 'playerDestroyed', x: 224, y: 530, dualHalf: false }, w);
      fx.handleGameEvent({ type: 'stageCleared', stage: 1 }, w);
      fx.handleRewardEvent({ type: 'challengeStageResult', stage: 3, challengeNumber: 1, hits: 40, total: 40, perfect: true, perHitBonus: 100, perfectBonus: 10000, bonus: 10000 });
      fx.handleRewardEvent({ type: 'pointsAwarded', source: 'enemy', amount: 1600, requested: 1600, scoreAfter: 1600, key: `k${frame}`, position: { x: 100, y: 100 } });
      fx.update(16, w);
      const s = fx.stats();
      expect(s.trails).toBeLessThanOrEqual(FX.caps.trails);
      expect(s.debris).toBeLessThanOrEqual(FX.caps.debris);
      expect(s.rings).toBeLessThanOrEqual(FX.caps.rings);
      expect(s.flashes).toBeLessThanOrEqual(FX.caps.flashes);
      expect(s.popups).toBeLessThanOrEqual(FX.caps.popups);
      expect(s.scheduled).toBeLessThanOrEqual(FX.caps.scheduled);
      expect(s.emitters).toBeLessThanOrEqual(FX.caps.emitters);
      expect(s.marks).toBeLessThanOrEqual(FX.caps.marks);
    }
    expect(fx.stats().dropped).toBeGreaterThan(0); // the cap really engaged
  });

  it('every effect ends within FX.maxEffectMs once events stop', () => {
    const fx = new FxDirector();
    const captive = enemy('c1', { kind: 'capturedFighter', captiveMode: 'freed', fighterId: 'f0' });
    const cmd = enemy('k1', { kind: 'commander', beam: { phase: 'holding', t: 0, length: 100, maxLength: 200, grabbed: false } });
    const w = world([captive, cmd]);
    const events: GameEvent[] = [
      boom(1),
      { type: 'playerDestroyed', x: 200, y: 500, dualHalf: false },
      { type: 'attackLaunched', pattern: 'p', ids: ['k1'] },
      { type: 'beamStarted', captorId: 'k1' },
      { type: 'captiveFreed', fighterId: 'f0' },
      { type: 'transformSplit', x: 100, y: 100, ids: [] },
      { type: 'playerRespawned', x: 224, y: 530 },
      { type: 'stageCleared', stage: 2 },
      { type: 'enemyArrived', id: 'e9', kind: 'scout', x: 10, y: 10 },
    ];
    for (const e of events) fx.handleGameEvent(e, w);
    fx.handleRewardEvent({ type: 'challengeStageResult', stage: 3, challengeNumber: 1, hits: 40, total: 40, perfect: true, perHitBonus: 100, perfectBonus: 10000, bonus: 10000 });
    fx.handleRewardEvent({ type: 'extraLifeAwarded', index: 0, threshold: 20000, reserves: 3, nextThreshold: 70000 });
    expect(fx.idle).toBe(false);
    // the world keeps existing (beam held, captive flying) but emitters still time out
    const steps = Math.ceil(FX.maxEffectMs / 16) + 2;
    for (let i = 0; i < steps; i++) fx.update(16, { ...w, enemies: w.enemies.map((e) => ({ ...e, state: 'inFormation' as const })) });
    const s = fx.stats();
    expect({ ...s, dropped: 0 }).toEqual({ trails: 0, debris: 0, rings: 0, flashes: 0, popups: 0, emitters: 0, scheduled: 0, marks: 0, dropped: 0 });
    expect(fx.idle).toBe(true);
  });

  it('beam and rescue emitters stop with their source', () => {
    const fx = new FxDirector();
    const cmd = enemy('k1', { kind: 'commander', beam: { phase: 'holding', t: 0, length: 100, maxLength: 200, grabbed: false } });
    const w = world([cmd]);
    fx.handleGameEvent({ type: 'beamStarted', captorId: 'k1' }, w);
    fx.update(16, w);
    expect(fx.stats().emitters).toBe(1);
    fx.handleGameEvent({ type: 'beamEnded', captorId: 'k1', captured: false }, w);
    expect(fx.stats().emitters).toBe(0);
    // emitter whose target disappears ends on the next update
    fx.handleGameEvent({ type: 'beamStarted', captorId: 'k1' }, w);
    fx.update(16, world([]));
    expect(fx.stats().emitters).toBe(0);
  });

  it('is read-only: handling events and updating never mutates the world', () => {
    const fx = new FxDirector();
    const w = world([enemy('a', { state: 'attacking', dirX: 1, dirY: 0 }), enemy('b', { kind: 'commander', state: 'entering' })]);
    const before = JSON.stringify(w);
    const frozen = deepFreeze(structuredClone(w));
    for (const e of [boom(1), { type: 'attackLaunched', pattern: 'x', ids: ['a', 'b'] } as GameEvent, { type: 'enemyArrived', id: 'a', kind: 'scout', x: 1, y: 1 } as GameEvent]) {
      fx.handleGameEvent(e, frozen);
    }
    for (let i = 0; i < 30; i++) fx.update(16, frozen);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it('flashes launched and arriving enemies briefly (marks), without touching hitFlashMs', () => {
    const fx = new FxDirector();
    const a = enemy('a', { state: 'attacking' });
    const w = world([a]);
    fx.handleGameEvent({ type: 'attackLaunched', pattern: 'x', ids: ['a'] }, w);
    expect(fx.enemyFlash('a')).toBe(true);
    expect(a.hitFlashMs).toBe(0);
    fx.update(FX.launchMarkMs + 1, w);
    expect(fx.enemyFlash('a')).toBe(false);
  });

  it('shows canvas score pop-ups only for awards at or above the HUD threshold', () => {
    const fx = new FxDirector();
    const award = (amount: number): RewardEvent => ({ type: 'pointsAwarded', source: 'enemy', amount, requested: amount, scoreAfter: amount, key: String(amount), position: { x: 50, y: 60 } });
    fx.handleRewardEvent(award(HUD_LAYOUT.popupMinPoints - 1));
    expect(fx.stats().popups).toBe(0);
    fx.handleRewardEvent(award(HUD_LAYOUT.popupMinPoints));
    fx.handleRewardEvent(award(1600));
    expect(fx.popups.items.map((p) => [p.text, p.size])).toEqual([
      [String(HUD_LAYOUT.popupMinPoints), 1],
      ['1600', 2],
    ]);
    fx.update(FX.popup.ms + 1, world());
    expect(fx.stats().popups).toBe(0);
  });

  it('reduced motion: fewer particles, no trails, no shake, gentler flashes', () => {
    const full = new FxDirector({ seed: 3 });
    const calm = new FxDirector({ seed: 3, reducedMotion: true });
    const w = world([enemy('a', { state: 'attacking', dirX: 0, dirY: 1 })]);
    for (const fx of [full, calm]) {
      fx.handleGameEvent({ type: 'playerDestroyed', x: 224, y: 530, dualHalf: false }, w);
      fx.update(120, w);
    }
    expect(calm.stats().debris).toBeLessThan(full.stats().debris);
    expect(calm.stats().trails).toBe(0);
    expect(full.stats().trails).toBeGreaterThan(0);
    expect(calm.shakeOffset()).toEqual({ x: 0, y: 0 });
    expect(calm.shake.amplitude).toBe(0);
    expect(full.shake.amplitude).toBeGreaterThan(0);
    expect(calm.flashes.items[0]!.alpha).toBeLessThan(full.flashes.items[0]!.alpha);
  });

  it('clears everything when the game returns to the title or restarts', () => {
    const fx = new FxDirector();
    const w = world();
    fx.handleGameEvent(boom(1), w);
    fx.handleGameEvent({ type: 'phaseChanged', from: 'gameOver', to: 'restarting' }, w);
    expect(fx.idle).toBe(true);
  });

  it('is deterministic for a given seed and never uses the engine RNG', () => {
    const run = (): string => {
      const fx = new FxDirector({ seed: 11 });
      const w = world();
      fx.handleGameEvent(boom(1), w);
      fx.update(50, w);
      return JSON.stringify(fx.stats()) + JSON.stringify(fx.shakeOffset());
    };
    expect(run()).toBe(run());
  });
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
