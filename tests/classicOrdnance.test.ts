/**
 * Combat P03C: Classic after Wave 20 — the ordnance adapter (core/systems/
 * ordnance.ts), time zones, the input that drives it and the HUD view.
 * Deterministic: fixed ticks, seeded engine, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { WEAPON_BY_ID, type WeaponId } from '../src/config/weapons.ts';
import { NO_INPUT, type InputFrame } from '../src/core/game/input.ts';
import type { GameEvent } from '../src/core/game/events.ts';
import type { Enemy } from '../src/core/game/types.ts';
import { classicHits, gunSelected, type ClassicLoadout } from '../src/core/systems/ordnance.ts';
import { zoneScale } from '../src/core/systems/timeZones.ts';
import { InputHub } from '../src/input/inputHub.ts';
import { KeyboardInput, type KeyLike } from '../src/input/keyboard.ts';
import { compatibleWeapons } from '../src/modes/freeroam/ships/armory.ts';
import { ordnanceView } from '../src/ui/ordnanceView.ts';
import { makeEngine, run, runUntil, startPlaying, type Harness } from './helpers/engine.ts';

const TICK_MS = 1000 / 60;
const FIRE: InputFrame = { ...NO_INPUT, fire: true };
const HOLD: InputFrame = { ...NO_INPUT, fire: true, fireHeld: true };
const NEXT: InputFrame = { ...NO_INPUT, cycle: 1 };
const PREV: InputFrame = { ...NO_INPUT, cycle: -1 };

const PETREL: ClassicLoadout = { ship: 'petrel', compatible: compatibleWeapons('petrel'), rotation: ['plasma', 'heavy-missile', 'lock-missile'], start: 'plasma' };
const SWIFT: ClassicLoadout = { ship: 'swift', compatible: compatibleWeapons('swift'), rotation: ['plasma', 'lock-missile'], start: 'plasma' };
const CONDOR: ClassicLoadout = { ship: 'condor', compatible: compatibleWeapons('condor'), rotation: ['plasma', 'heavy-missile', 'lock-missile', 'nuke'], start: 'plasma' };

function game(loadout: ClassicLoadout | null, seed = 7): { h: Harness; log: GameEvent[]; step: (n: number, f?: InputFrame) => void } {
  const h = makeEngine({ seed, loadout });
  startPlaying(h, { quiet: true });
  h.engine.drainEvents();
  const log: GameEvent[] = [];
  const step = (n: number, f: InputFrame = NO_INPUT): void => {
    run(h.engine, n, f);
    log.push(...h.engine.drainEvents());
  };
  return { h, log, step };
}

/** Quit the game in progress to the title and start a new one (as the menus do). */
function newGame(e: Harness['engine']): void {
  expect(e.pause()).toBe(true);
  expect(e.quitToTitle()).toBe(true);
  expect(e.startGame()).toBe(true);
}

const count = (log: readonly GameEvent[], type: GameEvent['type']): number => log.filter((e) => e.type === type).length;
const select = (g: ReturnType<typeof game>, id: WeaponId): void => {
  for (let i = 0; i < 6 && g.h.engine.world.ordnance!.arsenal.selected !== id; i++) g.step(1, NEXT);
  expect(g.h.engine.world.ordnance!.arsenal.selected).toBe(id);
};
const alive = (g: ReturnType<typeof game>): Enemy[] => g.h.engine.world.enemies.filter((e) => e.state !== 'destroyed');
/** Put the fighter under an enemy (lowest one in the formation, so nothing is in between). */
function under(g: ReturnType<typeof game>): Enemy {
  const w = g.h.engine.world;
  const target = [...alive(g)].sort((a, b) => b.y - a.y)[0]!;
  w.player.x = w.player.prevX = target.x;
  return target;
}
/**
 * Nothing ahead of the fighter: it moves to the far left edge and only the
 * right-hand enemies stay (outside any missile path and the lock cone). The
 * field is never emptied, so the stage does not end.
 */
function clearField(g: ReturnType<typeof game>): void {
  const w = g.h.engine.world;
  w.enemies = w.enemies.filter((e) => e.x >= 300);
  expect(w.enemies.length).toBeGreaterThan(0);
  w.player.x = w.player.prevX = 12;
}

/* ------------------------------------------------ legacy is untouched */

describe('Classic before the milestone (legacy fighter)', () => {
  it('has no ordnance, ignores the switch input, and its digest is the original one', () => {
    const script = (i: number): InputFrame => (i % 9 === 0 ? { ...HOLD, cycle: 1 } : i % 5 === 0 ? { ...NO_INPUT, moveX: 1 } : HOLD);
    const plain = (i: number): InputFrame => (i % 9 === 0 ? HOLD : i % 5 === 0 ? { ...NO_INPUT, moveX: 1 } : HOLD);
    const a = makeEngine({ seed: 11 });
    const b = makeEngine({ seed: 11, loadout: null });
    for (const h of [a, b]) startPlaying(h);
    run(a.engine, 900, script);
    run(b.engine, 900, plain);
    expect(a.engine.world.ordnance).toBeNull();
    expect(gunSelected(a.engine.world)).toBe(true);
    expect(a.engine.digest()).toBe(b.engine.digest());
    expect(a.rewards.snapshot().score).toBe(b.rewards.snapshot().score);
  });

  it('a roster ship with the gun selected fights exactly like the legacy gun (same shots, score, enemies)', () => {
    const legacy = makeEngine({ seed: 5 });
    const roster = makeEngine({ seed: 5, loadout: PETREL });
    for (const h of [legacy, roster]) startPlaying(h);
    const script = (i: number): InputFrame => (i % 40 < 20 ? { ...HOLD, moveX: 1 } : { ...HOLD, moveX: -1 });
    run(legacy.engine, 1200, script);
    run(roster.engine, 1200, script);
    expect(roster.rewards.snapshot().score).toBe(legacy.rewards.snapshot().score);
    expect(roster.engine.world.enemies.map((e) => [e.id, Math.round(e.x), Math.round(e.y)])).toEqual(legacy.engine.world.enemies.map((e) => [e.id, Math.round(e.x), Math.round(e.y)]));
    expect(roster.engine.world.ordnance!.missiles).toEqual([]);
  });
});

/* ------------------------------------------------ switching */

describe('weapon switching (rotation, wrap, exclusion)', () => {
  it('next / previous follow the Armory order and wrap; a switch never fires', () => {
    const g = game(PETREL);
    const o = g.h.engine.world.ordnance!;
    const seq: string[] = [];
    for (let i = 0; i < 4; i++) {
      g.step(1, NEXT);
      seq.push(o.arsenal.selected);
    }
    expect(seq).toEqual(['heavy-missile', 'lock-missile', 'plasma', 'heavy-missile']);
    g.step(1, PREV);
    g.step(1, PREV);
    expect(o.arsenal.selected).toBe('lock-missile');
    expect(count(g.log, 'weaponSwitched')).toBe(6);
    expect(count(g.log, 'ordnanceLaunched')).toBe(0);
    expect(count(g.log, 'playerShot')).toBe(0);
  });

  it('weapons outside the rotation or not mountable are unreachable (the nuke on a Petrel, heavy on a Swift)', () => {
    const sneaky: ClassicLoadout = { ...PETREL, rotation: ['plasma', 'heavy-missile', 'nuke'] };
    const g = game(sneaky);
    const o = g.h.engine.world.ordnance!;
    expect(o.arsenal.rotation).not.toContain('nuke');
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      g.step(1, NEXT);
      seen.add(o.arsenal.selected);
    }
    expect([...seen].sort()).toEqual(['heavy-missile', 'plasma']);
    const s = game({ ...SWIFT, rotation: ['plasma', 'heavy-missile', 'lock-missile'] });
    expect(s.h.engine.world.ordnance!.arsenal.rotation).toEqual(['plasma', 'lock-missile']);
  });

  it('an invalid start weapon falls back to the gun', () => {
    const g = game({ ...SWIFT, start: 'nuke' });
    expect(g.h.engine.world.ordnance!.arsenal.selected).toBe('plasma');
  });

  it('the gun rests while a missile weapon is selected (FIRE belongs to the missile)', () => {
    const g = game(PETREL);
    select(g, 'heavy-missile');
    g.step(120, HOLD);
    expect(count(g.log, 'playerShot')).toBe(0);
    expect(g.h.engine.world.heat.level).toBe(0);
  });
});

/* ------------------------------------------------ heavy missile */

describe('heavy missile', () => {
  it('launches once per press, travels visibly (no teleport), spends ammo and starts its cooldown', () => {
    const g = game(PETREL);
    clearField(g);
    select(g, 'heavy-missile');
    const o = g.h.engine.world.ordnance!;
    g.step(1, FIRE);
    expect(count(g.log, 'ordnanceLaunched')).toBe(1);
    expect(o.ammo['heavy-missile']).toBe(3);
    expect(o.arsenal.cooldown['heavy-missile']).toBeGreaterThan(0);
    const w = WEAPON_BY_ID.get('heavy-missile')!;
    const maxStep = w.fire === 'ordnance' ? (w.projectile.speed * 0.8) / 60 + 0.01 : 0;
    let lastY = o.missiles[0]!.y;
    for (let i = 0; i < 30; i++) {
      g.step(1, HOLD); // holding never launches a second one
      const m = o.missiles[0]!;
      expect(lastY - m.y).toBeGreaterThan(0);
      expect(lastY - m.y).toBeLessThanOrEqual(maxStep);
      lastY = m.y;
    }
    expect(count(g.log, 'ordnanceLaunched')).toBe(1);
    expect(o.ammo['heavy-missile']).toBe(3);
  });

  it('a press during the cooldown is refused without spending; switching keeps the cooldown', () => {
    const g = game(PETREL);
    clearField(g);
    select(g, 'heavy-missile');
    const o = g.h.engine.world.ordnance!;
    g.step(1, FIRE);
    g.step(2);
    g.step(1, FIRE);
    expect(g.log.filter((e) => e.type === 'ordnanceRefused').map((e) => (e as { reason: string }).reason)).toEqual(['cooling']);
    expect(o.ammo['heavy-missile']).toBe(3);
    const before = o.arsenal.cooldown['heavy-missile'];
    g.step(1, NEXT);
    g.step(1, PREV);
    expect(o.arsenal.selected).toBe('heavy-missile');
    expect(o.arsenal.cooldown['heavy-missile']).toBeCloseTo(before - 2, 5); // ticking, never reset or restored
  });

  it('hits the enemy in its path, damages enemies in the blast once each, and is removed', () => {
    const g = game(PETREL);
    select(g, 'heavy-missile');
    const target = under(g);
    g.step(1, FIRE);
    runUntil(g.h.engine, () => g.h.engine.world.ordnance!.missiles.length === 0, 300);
    g.log.push(...g.h.engine.drainEvents());
    const det = g.log.find((e) => e.type === 'detonation') as Extract<GameEvent, { type: 'detonation' }> | undefined;
    expect(det).toBeDefined();
    expect(det!.hits).toBeGreaterThanOrEqual(1);
    const touched = g.log.filter((e) => (e.type === 'enemyHit' || e.type === 'enemyDestroyed') && e.id === target.id);
    expect(touched.length).toBeGreaterThanOrEqual(1);
    // no enemy takes more hits than one share of the impact or blast damage
    const w = WEAPON_BY_ID.get('heavy-missile')!;
    const cap = w.fire === 'ordnance' ? Math.max(classicHits(w.impactDamage), classicHits(w.blast!.damage)) : 0;
    const per = new Map<string, number>();
    for (const e of g.log) if (e.type === 'enemyHit' || e.type === 'enemyDestroyed') per.set(e.id, (per.get(e.id) ?? 0) + 1);
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(cap);
  });

  it('with nothing in its path it detonates on expiry or leaves the field, and is cleaned up', () => {
    const g = game(PETREL);
    clearField(g);
    select(g, 'heavy-missile');
    g.step(1, FIRE);
    const w = WEAPON_BY_ID.get('heavy-missile')!;
    const lifeTicks = w.fire === 'ordnance' ? w.projectile.lifeTicks : 0;
    g.step(lifeTicks + 2);
    expect(g.h.engine.world.ordnance!.missiles).toEqual([]);
  });

  it('runs dry after its stock, refuses EMPTY, and refills at the next stage start only', () => {
    const g = game(PETREL);
    clearField(g);
    select(g, 'heavy-missile');
    const o = g.h.engine.world.ordnance!;
    const cd = (WEAPON_BY_ID.get('heavy-missile') as { cooldownTicks: number }).cooldownTicks;
    for (let i = 0; i < 4; i++) {
      g.step(1, FIRE);
      g.step(cd + 1);
    }
    expect(o.ammo['heavy-missile']).toBe(0);
    g.step(1, FIRE);
    expect(g.log.some((e) => e.type === 'ordnanceRefused' && e.reason === 'empty')).toBe(true);
    expect(count(g.log, 'ordnanceLaunched')).toBe(4);
    expect(ordnanceView(o)!.state).toBe('EMPTY');
  });
});

describe('stage transitions', () => {
  it('the next stage starts with full stock and no missiles, zones or lock (cooldowns keep running)', () => {
    const g = game(PETREL);
    clearField(g);
    select(g, 'heavy-missile');
    g.step(1, FIRE);
    const e = g.h.engine;
    expect(e.world.ordnance!.ammo['heavy-missile']).toBe(3);
    e.world.enemies.length = 0; // stage cleared
    runUntil(e, () => e.world.stage === 2 && (e.phase === 'playing' || e.phase === 'challenge'), 60 * 30);
    const o = e.world.ordnance!;
    expect(o.ammo['heavy-missile']).toBe(4);
    expect(o.missiles).toEqual([]);
    expect(o.zones).toEqual([]);
    expect(o.lock).toBeNull();
    expect(o.arsenal.selected).toBe('heavy-missile'); // the pilot's choice survives the stage
  });
});

/* ------------------------------------------------ lock-on */

describe('lock-on missile', () => {
  it('with no target ahead it is refused and nothing is spent (no cooldown)', () => {
    const g = game(PETREL);
    clearField(g);
    select(g, 'lock-missile');
    g.step(1, FIRE);
    expect(g.log.some((e) => e.type === 'ordnanceRefused' && e.reason === 'noTarget')).toBe(true);
    expect(g.h.engine.world.ordnance!.arsenal.cooldown['lock-missile']).toBe(0);
    expect(g.h.engine.world.ordnance!.notice).toBe('noTarget');
  });

  it('acquires a target, launches after the lock time, and steers at a bounded rate', () => {
    const g = game(PETREL);
    select(g, 'lock-missile');
    under(g);
    g.step(1, FIRE);
    const o = g.h.engine.world.ordnance!;
    expect(count(g.log, 'lockStarted')).toBe(1);
    expect(o.lock).not.toBeNull();
    const w = WEAPON_BY_ID.get('lock-missile')!;
    if (w.fire !== 'ordnance' || w.guidance.kind !== 'lock') throw new Error('lock catalogue');
    g.step(w.guidance.acquire.lockTicks + 1);
    expect(count(g.log, 'ordnanceLaunched')).toBe(1);
    expect(o.missiles[0]!.target).not.toBeNull();
    let prev = Math.atan2(o.missiles[0]!.vy, o.missiles[0]!.vx);
    for (let i = 0; i < 20 && o.missiles.length > 0; i++) {
      g.step(1);
      const m = o.missiles[0];
      if (!m) break;
      const a = Math.atan2(m.vy, m.vx);
      const d = Math.abs(Math.atan2(Math.sin(a - prev), Math.cos(a - prev)));
      expect(d).toBeLessThanOrEqual(w.guidance.turn / 60 + 1e-6);
      prev = a;
    }
  });

  it('a lock whose target disappears is lost: no launch, nothing spent', () => {
    const g = game(PETREL);
    select(g, 'lock-missile');
    const t = under(g);
    g.step(1, FIRE);
    const o = g.h.engine.world.ordnance!;
    expect(o.lock?.target).toBe(t.id);
    g.h.engine.world.enemies.splice(g.h.engine.world.enemies.indexOf(t), 1);
    g.step(2);
    expect(count(g.log, 'lockLost')).toBe(1);
    expect(count(g.log, 'ordnanceLaunched')).toBe(0);
    expect(o.arsenal.cooldown['lock-missile']).toBe(0);
  });

  it('switching away drops a lock in progress', () => {
    const g = game(PETREL);
    select(g, 'lock-missile');
    under(g);
    g.step(1, FIRE);
    expect(g.h.engine.world.ordnance!.lock).not.toBeNull();
    g.step(1, NEXT);
    expect(g.h.engine.world.ordnance!.lock).toBeNull();
    expect(count(g.log, 'ordnanceLaunched')).toBe(0);
  });
});

/* ------------------------------------------------ nuke and time zones */

describe('nuke and local time dilation', () => {
  function nuked(): ReturnType<typeof game> {
    const g = game(CONDOR);
    clearField(g);
    select(g, 'nuke');
    g.step(1, FIRE);
    const w = WEAPON_BY_ID.get('nuke')!;
    g.step((w.fire === 'ordnance' ? w.projectile.lifeTicks : 0) + 2);
    return g;
  }

  it('one charge per stage; it detonates and opens a 0.5x zone for 2 s', () => {
    const g = nuked();
    const o = g.h.engine.world.ordnance!;
    expect(o.ammo['nuke']).toBe(0);
    expect(count(g.log, 'detonation')).toBe(1);
    expect(o.zones).toHaveLength(1);
    expect(o.zones[0]!.scale).toBe(0.5);
    expect(o.zones[0]!.durationMs).toBeCloseTo(2000, 5);
    g.step(1, FIRE); // cooling first (shared fireGate order), and the stock is spent either way
    expect(g.log.some((e) => e.type === 'ordnanceRefused')).toBe(true);
    expect(count(g.log, 'ordnanceLaunched')).toBe(1);
    expect(o.ammo['nuke']).toBe(0);
  });

  it('enemy shots inside the zone move at half speed, outside at full speed; the zone expires after 2 s of play', () => {
    const g = nuked();
    const w = g.h.engine.world;
    const z = w.ordnance!.zones[0]!;
    w.enemyShots.push({ id: -7, x: z.x, y: z.y, prevX: z.x, prevY: z.y, vx: 0, vy: 240 });
    w.enemyShots.push({ id: -8, x: 8, y: 8, prevX: 8, prevY: 8, vx: 0, vy: 240 });
    expect(zoneScale(w, z.x, z.y)).toBe(0.5);
    expect(zoneScale(w, 8, 8)).toBe(1);
    g.step(1);
    const inside = w.enemyShots.find((s) => s.id === -7)!;
    const outside = w.enemyShots.find((s) => s.id === -8)!;
    expect(inside.y - inside.prevY).toBeCloseTo((240 * TICK_MS) / 2000, 4);
    expect(outside.y - outside.prevY).toBeCloseTo((240 * TICK_MS) / 1000, 4);
    g.step(Math.ceil(2000 / TICK_MS));
    expect(w.ordnance!.zones).toEqual([]);
    expect(zoneScale(w, z.x, z.y)).toBe(1);
  });

  it('pause freezes the zone (sim time), the fighter is never slowed, and death or a new game clears it', () => {
    const g = nuked();
    const e = g.h.engine;
    const left = e.world.ordnance!.zones[0]!.msLeft;
    e.pause();
    g.step(120);
    expect(e.world.ordnance!.zones[0]!.msLeft).toBe(left);
    e.resume();
    // the fighter moves at full speed inside the zone
    const p = e.world.player;
    const z = e.world.ordnance!.zones[0]!;
    p.x = p.prevX = z.x;
    const x0 = p.x;
    g.step(1, { ...NO_INPUT, moveX: 1 });
    const legacy = game(null);
    const lp = legacy.h.engine.world.player;
    const lx0 = lp.x;
    legacy.step(1, { ...NO_INPUT, moveX: 1 });
    expect(p.x - x0).toBeCloseTo(lp.x - lx0, 6);
    // death clears it
    p.state = 'exploding';
    g.step(1);
    expect(e.world.ordnance!.zones).toEqual([]);
  });

  it('a new game starts with full stock, no missiles, no zones and no lock', () => {
    const g = nuked();
    const e = g.h.engine;
    newGame(e);
    const o = e.world.ordnance!;
    expect(o.missiles).toEqual([]);
    expect(o.zones).toEqual([]);
    expect(o.lock).toBeNull();
    expect(o.ammo['nuke']).toBe(1);
    expect(o.ammo['heavy-missile']).toBe(4);
  });

  it('the next ship set on the title is flown from the next game; null returns to the legacy fighter', () => {
    const g = game(CONDOR);
    const e = g.h.engine;
    e.setLoadout(null);
    expect(e.world.ordnance!.ship).toBe('condor'); // the game in progress keeps its ship
    newGame(e);
    expect(e.world.ordnance).toBeNull();
    e.setLoadout(SWIFT);
    newGame(e);
    expect(e.world.ordnance!.ship).toBe('swift');
  });
});

/* ------------------------------------------------ input + HUD view */

describe('switch input and the HUD view', () => {
  const key = (code: string, extra: Partial<KeyLike> = {}): KeyLike => ({ code, repeat: false, target: null, ctrlKey: false, metaKey: false, altKey: false, preventDefault: () => {}, ...extra }) as KeyLike;

  it('Q is NEXT WEAPON: one press = one step, auto-repeat never steps again, clear() drops pending steps', () => {
    const hub = new InputHub();
    const kb = new KeyboardInput(hub);
    kb.keyDown(key('KeyQ'));
    kb.keyDown(key('KeyQ', { repeat: true }));
    expect(hub.frame().cycle).toBe(1);
    expect(hub.frame().cycle).toBeUndefined();
    hub.press('next', 'touch');
    hub.press('next', 'touch');
    hub.press('prev', 'pointer');
    expect(hub.frame().cycle).toBe(1); // +2 -1 = one step left
    expect(hub.frame().cycle).toBeUndefined();
    hub.press('next', 'touch');
    hub.clear();
    expect(hub.frame().cycle).toBeUndefined();
  });

  it('rapid taps queue (at most 3) and are delivered one step per tick, never merged into a fire', () => {
    const hub = new InputHub();
    for (let i = 0; i < 5; i++) hub.press('next', 'touch');
    const frames = [hub.frame(), hub.frame(), hub.frame(), hub.frame()];
    expect(frames.map((f) => f.cycle)).toEqual([1, 1, 1, undefined]);
    expect(frames.every((f) => !f.fire && !f.fireHeld)).toBe(true);
  });

  it('the view shows the weapon, ammo or ∞, cooldown seconds, LOCK % and notices (null for the legacy fighter)', () => {
    expect(ordnanceView(null)).toBeNull();
    const g = game(PETREL);
    const o = g.h.engine.world.ordnance!;
    expect(ordnanceView(o)).toMatchObject({ name: 'PLASMA', state: '∞', gun: true, count: 3 });
    clearField(g);
    select(g, 'heavy-missile');
    expect(ordnanceView(o)).toMatchObject({ name: 'HEAVY', state: '4 READY', ready: true, gun: false });
    g.step(1, FIRE);
    expect(ordnanceView(o)!.state).toMatch(/^3 · \d+s$/);
    expect(ordnanceView(o)!.ready).toBe(false);
    select(g, 'lock-missile');
    g.step(1, FIRE);
    expect(ordnanceView(o)!.notice).toBe('NO TARGET');
  });
});
