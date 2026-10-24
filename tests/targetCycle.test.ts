/**
 * P04.1 polish: NEXT TARGET (C / the touch button) and the lock's release and
 * eligibility edges, on the real sector simulation (combat/shipLock.ts):
 * - C moves an existing lock to the next eligible ship in a clockwise sweep
 *   from the current target, wraps, and visits every eligible ship once per
 *   round whichever way the nose points; it never locks without a lock;
 * - candidates follow the acquisition rules (range, hostility, line of sight,
 *   inside the sector);
 * - cycling never fires, spends or moves anything;
 * - a lock that ends is never moved to another ship by itself;
 * - X releases at once and hands the nose back to the manual rule, exactly.
 */
import { describe, expect, it } from 'vitest';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import type { FamilyId } from '../src/modes/freeroam/combat/families.ts';
import { nextShipLockTarget, pickShipLockTarget, SHIP_LOCK, shipLockLine } from '../src/modes/freeroam/combat/shipLock.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import { damageAgent } from '../src/modes/freeroam/combat/world.ts';
import { sectorCue } from '../src/modes/freeroam/audio/frCues.ts';
import { EMPTY_SECTOR_SAVE } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { arena } from './helpers/combatProbe.ts';

const NONE: SectorInput = { moveX: 0, moveY: 0 };
const X: SectorInput = { moveX: 0, moveY: 0, lockToggle: true };
const C: SectorInput = { moveX: 0, moveY: 0, targetCycle: true };
const LOADOUT = { compatible: ['plasma', 'lock-missile'], rotation: ['plasma', 'lock-missile'], start: 'plasma' } as const;

function setup(seed = 1, layout = arena(1)): SectorRun {
  const r = createSectorRun(layout, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed, loadout: LOADOUT });
  r.grace = 100_000; // no enemy fire: these tests are about the lock
  const cx = layout.width / 2;
  const cy = layout.height / 2;
  Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0, heading: 0, pheading: 0 });
  return r;
}
function foe(r: SectorRun, dx: number, dy: number, faction: Parameters<typeof spawnAgent>[2] = 'red-tally', family: FamilyId = 'raider'): Agent {
  return spawnAgent(r, family, faction, 'test', 'guard', r.ship.x + dx, r.ship.y + dy)!;
}
const pin = (a: Agent, x: number, y: number): void => {
  Object.assign(a, { x, y, px: x, py: y, vx: 0, vy: 0 });
};
/** Step n ticks with every live agent pinned where it is (geometry tests); the first tick may carry a one-shot input. */
function steps(r: SectorRun, n: number, first: SectorInput = NONE, then: SectorInput = NONE): SectorEvent[] {
  const at = r.hostiles.map((a) => ({ a, x: a.x, y: a.y }));
  const out: SectorEvent[] = [];
  for (let i = 0; i < n; i++) {
    for (const p of at) if (p.a.state !== 'destroyed') pin(p.a, p.x, p.y);
    out.push(...stepSector(r, i === 0 ? first : then));
  }
  return out;
}
const CUE_CTX = { shieldBefore: 0, shieldAfter: 0 };
const of = (ev: readonly SectorEvent[], type: SectorEvent['type']): SectorEvent[] => ev.filter((e) => e.type === type);
/** Up, right, down, left of the ship: on screen (y down) that is a clockwise round starting at the top. */
function compass(r: SectorRun, d = 300): { up: Agent; right: Agent; down: Agent; left: Agent } {
  return { up: foe(r, 0, -d), right: foe(r, d, 0), down: foe(r, 0, d), left: foe(r, -d, 0) };
}

describe('C = next target: only while locked, by the pilot, deterministic', () => {
  it('with no lock it locks nothing and says so (X locks)', () => {
    const r = setup();
    foe(r, 0, -300);
    const ev = steps(r, 1, C);
    expect(r.shipLock.target).toBeNull();
    expect(of(ev, 'shipLockRefused')).toEqual([{ type: 'shipLockRefused', why: 'noLock' }]);
    expect(r.shipLock.notice).toBe('noLock');
    expect(shipLockLine(of(ev, 'shipLockRefused')[0]!)).toEqual({ text: 'NO TARGET LOCKED', tone: 'warn' });
    expect(sectorCue({ type: 'shipLockRefused', why: 'noLock' }, CUE_CTX)).toBe('fr.deny');
  });

  it('sweeps clockwise from the current target and wraps: up -> right -> down -> left -> up', () => {
    const r = setup();
    const f = compass(r);
    steps(r, 1, X);
    expect(r.shipLock.target).toBe(f.up.id); // the nose points up
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const ev = steps(r, 1, C);
      seen.push(r.shipLock.target!);
      const locked = of(ev, 'shipLocked');
      expect(locked).toHaveLength(1);
      expect(locked[0]).toMatchObject({ type: 'shipLocked', hostile: r.shipLock.target });
      expect((locked[0] as { from?: number }).from).toBe(i === 0 ? f.up.id : seen[i - 1]);
    }
    expect(seen).toEqual([f.right.id, f.down.id, f.left.id, f.up.id]);
    expect(r.shipLock.switched).toBe(4);
    expect(r.shipLock.acquired).toBe(1); // X acquired once; C only moved the lock
    expect(r.shipLock.notice).toBe('switched');
    expect(shipLockLine({ type: 'shipLocked', hostile: f.right.id, family: 'raider', x: 0, y: 0, from: f.up.id })).toEqual({ text: 'NEXT TARGET · RAIDER', tone: 'info' });
    expect(sectorCue({ type: 'shipLocked', hostile: 1, family: 'raider', x: 0, y: 0, from: 2 }, CUE_CTX)).toBe('fr.chip');
  });

  it('visits every eligible ship once per round while the nose turns to each one (the order does not depend on the nose)', () => {
    const r = setup();
    const ring = [foe(r, 40, -500), foe(r, 420, -260), foe(r, 380, 330), foe(r, -60, 480), foe(r, -450, 120), foe(r, -300, -400)];
    steps(r, 1, X);
    const first = r.shipLock.target!;
    const round: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      steps(r, 1, C);
      round.push(r.shipLock.target!);
      steps(r, 45); // the nose turns to face the new target before the next press
    }
    expect(new Set(round).size).toBe(ring.length); // each ship once
    expect(round[round.length - 1]).toBe(first); // and back to the start
    // the same scene, pressed without pauses, gives the same order: the nose plays no part
    const r2 = setup();
    for (const a of ring) foe(r2, a.x - r.ship.x, a.y - r.ship.y);
    steps(r2, 1, X);
    const quick: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      steps(r2, 1, C);
      quick.push(r2.shipLock.target!);
    }
    expect(quick).toEqual(round);
  });

  it('ships on the same bearing: the farther one comes next, the nearer one waits for the wrap', () => {
    const r = setup();
    const near = foe(r, 0, -200);
    const far = foe(r, 0, -400);
    const right = foe(r, 300, 0);
    steps(r, 1, X);
    expect(r.shipLock.target).toBe(near.id);
    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      steps(r, 1, C);
      order.push(r.shipLock.target!);
    }
    expect(order).toEqual([far.id, right.id, near.id]);
  });

  it('with no other eligible ship the lock stays where it is ("ONLY TARGET")', () => {
    const r = setup();
    const a = foe(r, 0, -300);
    steps(r, 1, X);
    const ev = steps(r, 1, C);
    expect(r.shipLock.target).toBe(a.id);
    expect(of(ev, 'shipLockRefused')).toEqual([{ type: 'shipLockRefused', why: 'onlyTarget' }]);
    expect(of(ev, 'shipLockEnded')).toEqual([]);
    expect(shipLockLine(of(ev, 'shipLockRefused')[0]!)).toEqual({ text: 'ONLY TARGET IN RANGE', tone: 'info' });
  });

  it('skips ships X could not lock: out of range, wary and unprovoked, behind a rock, outside the sector', () => {
    const L = arena(1);
    const cx = L.width / 2;
    const cy = L.height / 2;
    // a rock between the ship and the ship on the left
    const r = setup(1, { ...L, rocks: [{ x: cx - 150, y: cy, r: 40 } as never] });
    const locked = foe(r, 0, -300);
    foe(r, SHIP_LOCK.range + 60, 0); // out of range
    foe(r, 0, 300, 'gleaners'); // wary, not provoked
    foe(r, -300, 0); // behind the rock
    steps(r, 1, X);
    expect(r.shipLock.target).toBe(locked.id);
    expect(nextShipLockTarget(r)).toBeNull();
    steps(r, 1, C);
    expect(r.shipLock.target).toBe(locked.id);
    expect(r.shipLock.notice).toBe('onlyTarget');
    // provoked, the Gleaners qualify and C reaches them
    r.provoked.add('gleaners');
    steps(r, 1, C);
    expect(r.hostiles.find((a) => a.id === r.shipLock.target)?.faction).toBe('gleaners');
    // the sector edge: a ship beyond it is never acquired, by X or by C
    const e = setup();
    Object.assign(e.ship, { x: 150, px: 150 });
    // spawning clamps to the sector, so place it beyond the left edge by hand: within range, in sight
    pin(foe(e, -100, 0), -110, e.ship.y);
    expect(pickShipLockTarget(e)).toBeNull();
    steps(e, 1, X);
    expect(e.shipLock.target).toBeNull();
    expect(e.shipLock.notice).toBe('noTarget');
  });

  it('cycling never fires, spends, moves or slows anything', () => {
    const r = setup();
    compass(r);
    Object.assign(r.ship, { vx: 120, vy: -40 });
    const twin = setup();
    compass(twin);
    Object.assign(twin.ship, { vx: 120, vy: -40 });
    steps(r, 1, X);
    steps(twin, 1, X);
    const energy = r.energy;
    const ammo = { ...r.ammo };
    const cool = { ...r.arsenal.cooldown };
    const ev: SectorEvent[] = [];
    for (let i = 0; i < 9; i++) ev.push(...steps(r, 1, C), ...steps(r, 3));
    for (let i = 0; i < 9; i++) steps(twin, 4);
    expect(ev.filter((e) => e.type === 'missileLaunched' || e.type === 'weaponSwitched' || e.type === 'ordnanceSpent')).toEqual([]);
    expect(r.energy).toBe(energy);
    expect(r.ammo).toEqual(ammo);
    expect(r.arsenal.cooldown).toEqual(cool);
    expect(r.arsenal.selected).toBe('plasma');
    expect(r.missile.state).toBe('ready');
    expect(r.missiles).toHaveLength(0);
    // position and velocity are the same as the twin that never pressed C (the lock only aims the nose)
    expect({ x: r.ship.x, y: r.ship.y, vx: r.ship.vx, vy: r.ship.vy }).toEqual({ x: twin.ship.x, y: twin.ship.y, vx: twin.ship.vx, vy: twin.ship.vy });
  });
});

describe('the lock ends cleanly and is never moved by itself', () => {
  it('a destroyed target ends the lock; other eligible ships are not locked until the pilot asks', () => {
    const r = setup();
    const f = compass(r);
    steps(r, 1, X);
    expect(r.shipLock.target).toBe(f.up.id);
    damageAgent(r, f.up, 999, 'player', []);
    const ev = steps(r, 1);
    expect(of(ev, 'shipLockEnded')).toEqual([{ type: 'shipLockEnded', hostile: f.up.id, why: 'destroyed' }]);
    steps(r, 180);
    expect(r.shipLock.target).toBeNull();
    // C after the kill: there is no lock to move, so nothing is locked
    steps(r, 1, C);
    expect(r.shipLock.target).toBeNull();
    expect(r.shipLock.notice).toBe('noLock');
    // X picks again, on request
    steps(r, 1, X);
    expect([f.right.id, f.down.id, f.left.id]).toContain(r.shipLock.target);
  });

  it('a locked ship that leaves the sector is no longer a valid target (reason invalid)', () => {
    const r = setup();
    Object.assign(r.ship, { x: 300, px: 300 });
    const a = foe(r, -150, 0); // x = 150: inside
    steps(r, 1, X);
    expect(r.shipLock.target).toBe(a.id);
    pin(a, -40, r.ship.y); // across the left edge, still within keepRange
    const ev = steps(r, 1);
    expect(of(ev, 'shipLockEnded')).toEqual([{ type: 'shipLockEnded', hostile: a.id, why: 'invalid' }]);
    expect(r.shipLock.target).toBeNull();
  });

  it('X releases at once and the nose goes back to the manual rule exactly (no snap, no leftover aim)', () => {
    const r = setup();
    const a = foe(r, 300, 0); // to the right: the nose turns to heading pi/2
    steps(r, 1, X);
    steps(r, 40);
    expect(Math.abs(r.ship.heading - Math.PI / 2)).toBeLessThan(0.02);
    const LEFT: SectorInput = { moveX: -1, moveY: 0 };
    const ev = steps(r, 1, { ...LEFT, lockToggle: true });
    expect(of(ev, 'shipLockEnded')).toEqual([{ type: 'shipLockEnded', hostile: a.id, why: 'cancelled' }]);
    expect(r.shipLock.target).toBeNull();
    // a twin that never locked, put in the same flight state, flies the same input: identical from here on
    const twin = setup();
    foe(twin, 300, 0);
    const keys = ['x', 'y', 'px', 'py', 'vx', 'vy', 'heading', 'pheading'] as const;
    for (const k of keys) (twin.ship as unknown as Record<string, number>)[k] = r.ship[k];
    let maxStep = 0;
    for (let i = 0; i < 90; i++) {
      const h0 = r.ship.heading;
      steps(r, 1, LEFT, LEFT);
      steps(twin, 1, LEFT, LEFT);
      maxStep = Math.max(maxStep, Math.abs(Math.atan2(Math.sin(r.ship.heading - h0), Math.cos(r.ship.heading - h0))));
      for (const k of keys) expect(r.ship[k]).toBe(twin.ship[k]);
    }
    // the turn back is the capped manual turn, never a jump (16 rad/s is the fastest any rule turns)
    expect(maxStep).toBeLessThanOrEqual(16 / 60 + 1e-9);
  });

  it('X and C in the same tick: the toggle is applied first, so a release is never followed by a hidden re-lock', () => {
    const r = setup();
    compass(r);
    steps(r, 1, X);
    const ev = steps(r, 1, { ...NONE, lockToggle: true, targetCycle: true });
    expect(r.shipLock.target).toBeNull();
    expect(of(ev, 'shipLockEnded')).toHaveLength(1);
    expect(of(ev, 'shipLocked')).toHaveLength(0);
  });
});
