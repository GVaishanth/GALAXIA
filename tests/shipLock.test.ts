/**
 * P04.1 ship target lock (combat/shipLock.ts) on the real sector simulation:
 * X toggles a lock on a real hostile; the nose turns toward it through the one
 * orientation rule (sim.ts stepShip, capped aimTurnRate); position, velocity
 * and thrust are never touched; nothing is fired; the lock ends cleanly; the
 * lock-on missile keeps its own rules and only prefers the locked ship.
 */
import { describe, expect, it } from 'vitest';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import type { FamilyId } from '../src/modes/freeroam/combat/families.ts';
import { MISSILE, pickTarget } from '../src/modes/freeroam/combat/playerMissile.ts';
import { pickShipLockTarget, SHIP_LOCK, shipLockLine } from '../src/modes/freeroam/combat/shipLock.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import { damageAgent } from '../src/modes/freeroam/combat/world.ts';
import { sectorCue } from '../src/modes/freeroam/audio/frCues.ts';
import { EMPTY_SECTOR_SAVE } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, disposeSectorRun, restartSector, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { arena } from './helpers/combatProbe.ts';

const NONE: SectorInput = { moveX: 0, moveY: 0 };
const X: SectorInput = { moveX: 0, moveY: 0, lockToggle: true };
const LOADOUT = { compatible: ['plasma', 'lock-missile'], rotation: ['plasma', 'lock-missile'], start: 'plasma' } as const;
const TAU = Math.PI * 2;
const wrap = (a: number): number => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
/** The heading (0 = nose up, clockwise) that faces (dx, dy). */
const headingTo = (dx: number, dy: number): number => Math.atan2(dx, -dy);

function setup(seed = 1): SectorRun {
  const L = arena(1);
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed, loadout: LOADOUT });
  r.grace = 100_000; // no enemy fire: these tests are about the lock
  const cx = L.width / 2;
  const cy = L.height / 2;
  Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0, heading: 0, pheading: 0 });
  return r;
}
function foe(r: SectorRun, family: FamilyId, dx: number, dy: number, faction: Parameters<typeof spawnAgent>[2] = 'red-tally'): Agent {
  return spawnAgent(r, family, faction, 'test', 'guard', r.ship.x + dx, r.ship.y + dy)!;
}
const pin = (a: Agent, x: number, y: number): void => {
  Object.assign(a, { x, y, px: x, py: y, vx: 0, vy: 0 });
};
/** Step n ticks, pinning agents in place (geometry tests); the first tick may carry a one-shot input. */
function steps(r: SectorRun, n: number, first: SectorInput = NONE, then: SectorInput = NONE, pinned: readonly Agent[] = []): SectorEvent[] {
  const at = pinned.map((a) => ({ a, x: a.x, y: a.y }));
  const out: SectorEvent[] = [];
  for (let i = 0; i < n; i++) {
    for (const p of at) pin(p.a, p.x, p.y);
    out.push(...stepSector(r, i === 0 ? first : then));
  }
  return out;
}
const of = (ev: readonly SectorEvent[], type: SectorEvent['type']): SectorEvent[] => ev.filter((e) => e.type === type);

describe('X: acquire, toggle, deterministic choice', () => {
  it('locks a real hostile on X and releases it on the next X; nothing is fired or spent', () => {
    const r = setup();
    const a = foe(r, 'raider', 0, -300);
    const energy = r.energy;
    const ammo = { ...r.ammo };
    const cool = { ...r.arsenal.cooldown };
    const ev = steps(r, 1, X, NONE, [a]);
    expect(r.shipLock.target).toBe(a.id);
    expect(of(ev, 'shipLocked')).toEqual([{ type: 'shipLocked', hostile: a.id, family: 'raider', x: a.x, y: a.y }]);
    expect(r.arsenal.selected).toBe('plasma');
    expect(r.energy).toBe(energy);
    expect(r.ammo).toEqual(ammo);
    expect(r.arsenal.cooldown).toEqual(cool);
    expect(r.missile.state).toBe('ready');
    const ev2 = steps(r, 1, X, NONE, [a]);
    expect(r.shipLock.target).toBeNull();
    expect(of(ev2, 'shipLockEnded')).toEqual([{ type: 'shipLockEnded', hostile: a.id, why: 'cancelled' }]);
  });

  it('with nothing eligible it stays unlocked and says why', () => {
    const r = setup();
    const ev = steps(r, 1, X);
    expect(r.shipLock.target).toBeNull();
    expect(of(ev, 'shipLockRefused')).toEqual([{ type: 'shipLockRefused', why: 'noTarget' }]);
    expect(r.shipLock.notice).toBe('noTarget');
    // the notice fades on its own
    steps(r, SHIP_LOCK.noticeTicks);
    expect(r.shipLock.notice).toBeNull();
  });

  it('prefers ships ahead of the nose, then nearer ones; exact ties go to the lower id', () => {
    const r = setup();
    const behindNear = foe(r, 'raider', 0, 150); // directly behind, close
    const aheadFar = foe(r, 'raider', 0, -700); // dead ahead, far
    expect(pickShipLockTarget(r)?.id).toBe(aheadFar.id);
    const side = foe(r, 'raider', 120, -120); // 45 deg off, near: closer to the nose line than "behind", nearer than "ahead far"
    expect(pickShipLockTarget(r)?.id).toBe(side.id);
    expect(behindNear.id).toBeLessThan(side.id);
    // mirror twins: same score, the lower id wins
    const r2 = setup();
    const left = foe(r2, 'raider', -200, -200);
    const right = foe(r2, 'raider', 200, -200);
    expect(pickShipLockTarget(r2)?.id).toBe(Math.min(left.id, right.id));
  });

  it('respects eligibility: range, wary factions and line of sight', () => {
    const r = setup();
    foe(r, 'raider', 0, -(SHIP_LOCK.range + 40)); // out of range
    foe(r, 'raider', 0, -200, 'gleaners'); // wary, not provoked
    expect(pickShipLockTarget(r)).toBeNull();
    r.provoked.add('gleaners');
    expect(pickShipLockTarget(r)?.faction).toBe('gleaners');
    // a rock between the ship and the only hostile blocks the acquisition
    const L = arena(1);
    const blocked = createSectorRun({ ...L, rocks: [{ x: L.width / 2, y: L.height / 2 - 150, r: 40 } as never] }, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 1, loadout: LOADOUT });
    blocked.grace = 100_000;
    Object.assign(blocked.ship, { x: L.width / 2, y: L.height / 2, px: L.width / 2, py: L.height / 2, vx: 0, vy: 0, heading: 0 });
    foe(blocked, 'raider', 0, -300);
    expect(pickShipLockTarget(blocked)).toBeNull();
  });

  it("reuses the lock-on missile's current acquisition target when it may be locked", () => {
    const r = setup();
    const near = foe(r, 'raider', 0, -120);
    const other = foe(r, 'raider', 30, -400);
    r.missile.state = 'acquiring';
    r.missile.target = other.id;
    expect(pickShipLockTarget(r)?.id).toBe(other.id);
    r.missile.state = 'ready';
    r.missile.target = null;
    expect(pickShipLockTarget(r)?.id).toBe(near.id);
  });

  it('is unavailable while docked (no combat lock at a station)', () => {
    const r = setup();
    foe(r, 'raider', 0, -300);
    r.docked = 'station-x';
    const ev = steps(r, 1, X);
    expect(r.shipLock.target).toBeNull();
    expect(of(ev, 'shipLockRefused')).toEqual([{ type: 'shipLockRefused', why: 'unavailable' }]);
  });
});

describe('facing only: smooth turn, no velocity change, no auto-fire', () => {
  it('turns the nose toward a target behind at the capped aim rate, the short way, and settles without overshoot', () => {
    const r = setup();
    const a = foe(r, 'raider', 40, 400); // behind and slightly right
    const want = headingTo(40, 400);
    const maxStep = r.tune.aimTurnRate / 60 + 1e-9;
    steps(r, 1, X, NONE, [a]);
    let prev = Math.abs(wrap(want - r.ship.heading));
    let ticks = 1;
    while (Math.abs(wrap(want - r.ship.heading)) > 1e-6 && ticks < 120) {
      const h0 = r.ship.heading;
      steps(r, 1, NONE, NONE, [a]);
      ticks += 1;
      const d = Math.abs(wrap(want - r.ship.heading));
      expect(Math.abs(wrap(r.ship.heading - h0))).toBeLessThanOrEqual(maxStep); // never snaps
      expect(d).toBeLessThanOrEqual(prev + 1e-9); // monotonic: no oscillation
      prev = d;
    }
    expect(prev).toBeLessThan(1e-6);
    expect(ticks).toBeGreaterThan(3); // a 170 deg turn takes several ticks
    // and it stays on target
    steps(r, 30, NONE, NONE, [a]);
    expect(Math.abs(wrap(want - r.ship.heading))).toBeLessThan(1e-6);
  });

  it('never changes position or velocity: the same inputs fly the same path with and without a lock', () => {
    const scripted = (i: number): SectorInput => ({ moveX: Math.sin(i / 17), moveY: Math.cos(i / 23) * 0.8, boost: i % 90 < 30 });
    const fly = (lock: boolean): { path: number[][]; headings: number[] } => {
      const r = setup(7);
      const a = foe(r, 'picket', 260, 120);
      const path: number[][] = [];
      const headings: number[] = [];
      for (let i = 0; i < 240; i++) {
        pin(a, r.ship.x + 260, r.ship.y + 120); // the target rides along at a fixed offset
        const input = { ...scripted(i), ...(lock && i === 0 ? { lockToggle: true } : {}) };
        stepSector(r, input);
        path.push([r.ship.x, r.ship.y, r.ship.vx, r.ship.vy]);
        headings.push(r.ship.heading);
      }
      if (lock) expect(r.shipLock.target).toBe(a.id);
      return { path, headings };
    };
    const free = fly(false);
    const locked = fly(true);
    expect(locked.path).toEqual(free.path); // thrust, boost, drag: identical, tick by tick
    expect(locked.headings).not.toEqual(free.headings); // only the nose differs
    // thrust still works while locked: the ship really moved
    expect(Math.hypot(locked.path[239]![0]! - locked.path[0]![0]!, locked.path[239]![1]! - locked.path[0]![1]!)).toBeGreaterThan(100);
  });

  it('overrides mouse aim while held; the aim takes over again when released (still at the capped rate)', () => {
    const r = setup();
    const a = foe(r, 'raider', 300, 0); // to the right
    const aimLeft: SectorInput = { moveX: 0, moveY: 0, aimX: -100, aimY: 0 };
    steps(r, 40, { ...aimLeft, lockToggle: true }, aimLeft, [a]);
    expect(Math.abs(wrap(headingTo(300, 0) - r.ship.heading))).toBeLessThan(1e-6);
    steps(r, 1, { ...aimLeft, lockToggle: true }, aimLeft, [a]);
    expect(r.shipLock.target).toBeNull();
    const h = r.ship.heading;
    steps(r, 1, aimLeft, aimLeft, [a]);
    expect(Math.abs(wrap(r.ship.heading - h))).toBeLessThanOrEqual(r.tune.aimTurnRate / 60 + 1e-9); // no snap on release
    steps(r, 40, aimLeft, aimLeft, [a]);
    expect(Math.abs(wrap(headingTo(-100, 0) - r.ship.heading))).toBeLessThan(1e-6);
  });

  it('never fires, launches, pursues or evades by itself', () => {
    const r = setup();
    const a = foe(r, 'raider', 0, -250);
    const x0 = r.ship.x;
    const y0 = r.ship.y;
    const ev = steps(r, 180, X, NONE, [a]);
    expect(r.shipLock.target).toBe(a.id);
    for (const t of ['fired', 'missileLock', 'missileLaunched', 'weaponSwitched'] as const) expect(of(ev, t), t).toEqual([]);
    expect(r.shots.length).toBe(0);
    expect(r.missiles.length).toBe(0);
    expect(r.ship.x).toBe(x0); // no input: it stays where it is
    expect(r.ship.y).toBe(y0);
  });
});

describe('the lock ends cleanly and is never re-acquired by itself', () => {
  it('a destroyed target ends the lock (reason destroyed) and no other ship is picked', () => {
    const r = setup();
    const a = foe(r, 'raider', 0, -200);
    const b = foe(r, 'raider', 0, -260);
    steps(r, 1, X, NONE, [a, b]);
    expect(r.shipLock.target).toBe(a.id);
    damageAgent(r, a, 999, 'player', []);
    const ev = steps(r, 2, NONE, NONE, [b]);
    expect(of(ev, 'shipLockEnded')).toEqual([{ type: 'shipLockEnded', hostile: a.id, why: 'destroyed' }]);
    expect(r.shipLock.target).toBeNull();
    steps(r, 60, NONE, NONE, [b]);
    expect(r.shipLock.target).toBeNull(); // b is right there, but X was not pressed
  });

  it('out of range ends it (reason range); off screen but in range keeps it', () => {
    const r = setup();
    const a = foe(r, 'raider', 0, -300);
    steps(r, 1, X, NONE, [a]);
    pin(a, r.ship.x, r.ship.y - (SHIP_LOCK.keepRange - 20)); // far off screen at any zoom, still in range
    steps(r, 10, NONE, NONE, [a]);
    expect(r.shipLock.target).toBe(a.id);
    pin(a, r.ship.x, r.ship.y - (SHIP_LOCK.keepRange + 20));
    const ev = steps(r, 1, NONE, NONE, [a]);
    expect(of(ev, 'shipLockEnded')).toEqual([{ type: 'shipLockEnded', hostile: a.id, why: 'range' }]);
    expect(r.shipLock.notice).toBe('range');
  });

  it('a ship removed from the sector ends it (reason gone); a ship no longer hostile ends it (reason invalid)', () => {
    const r = setup();
    const a = foe(r, 'raider', 0, -300);
    steps(r, 1, X, NONE, [a]);
    r.hostiles.splice(r.hostiles.indexOf(a), 1);
    expect(of(steps(r, 1), 'shipLockEnded')).toEqual([{ type: 'shipLockEnded', hostile: a.id, why: 'gone' }]);
    const g = foe(r, 'raider', 0, -300, 'gleaners');
    r.provoked.add('gleaners');
    steps(r, 1, X, NONE, [g]);
    expect(r.shipLock.target).toBe(g.id);
    r.provoked.delete('gleaners');
    expect(of(steps(r, 1, NONE, NONE, [g]), 'shipLockEnded')).toEqual([{ type: 'shipLockEnded', hostile: g.id, why: 'invalid' }]);
  });

  it('restart, death (recall), docking and unloading the sector clear it', () => {
    const lockOn = (): { r: SectorRun; a: Agent } => {
      const r = setup();
      const a = foe(r, 'raider', 0, -300);
      steps(r, 1, X, NONE, [a]);
      expect(r.shipLock.target).toBe(a.id);
      return { r, a };
    };
    let { r } = lockOn();
    restartSector(r);
    expect(r.shipLock.target).toBeNull();
    ({ r } = lockOn());
    r.hull = 0;
    const ev = steps(r, 1);
    expect(of(ev, 'recalled').length).toBe(1);
    expect(r.shipLock.target).toBeNull();
    ({ r } = lockOn());
    disposeSectorRun(r);
    expect(r.shipLock.target).toBeNull();
  });

  it('switching weapons (Q) keeps the lock, and the lock never changes the selection', () => {
    const r = setup();
    const a = foe(r, 'raider', 0, -300);
    steps(r, 1, X, NONE, [a]);
    const ev = steps(r, 1, { moveX: 0, moveY: 0, cycle: 1 }, NONE, [a]);
    expect(of(ev, 'weaponSwitched').length).toBe(1);
    expect(r.arsenal.selected).toBe('lock-missile');
    expect(r.shipLock.target).toBe(a.id);
    steps(r, 1, { moveX: 0, moveY: 0, cycle: 1 }, NONE, [a]);
    expect(r.arsenal.selected).toBe('plasma');
    expect(r.shipLock.target).toBe(a.id);
  });
});

describe('ship lock and the lock-on missile', () => {
  it("the missile prefers the locked ship when it passes the missile's own range, cone and sight", () => {
    const r = setup();
    const best = foe(r, 'raider', 0, -150); // the missile's own pick: dead ahead, near
    const locked = foe(r, 'raider', 90, -420); // inside the missile cone and range, not its first choice
    expect(pickTarget(r)?.id).toBe(best.id);
    r.shipLock.target = locked.id;
    expect(pickTarget(r)?.id).toBe(locked.id);
    // outside the missile's range: the missile ignores the ship lock and keeps its own choice
    pin(locked, r.ship.x, r.ship.y - (MISSILE.range + 50));
    expect(pickTarget(r)?.id).toBe(best.id);
  });

  it('a locked missile still needs its full acquisition time and spends its energy only at launch', () => {
    const r = setup();
    const a = foe(r, 'raider', 0, -300);
    steps(r, 1, X, NONE, [a]);
    steps(r, 1, { moveX: 0, moveY: 0, cycle: 1 }, NONE, [a]); // select the lock-on
    expect(r.arsenal.selected).toBe('lock-missile');
    const e0 = r.energy;
    const ev = steps(r, 1, { moveX: 0, moveY: 0, fire: true }, NONE, [a]);
    expect(of(ev, 'missileLock')).toEqual([{ type: 'missileLock', hostile: a.id, x: a.x, y: a.y }]);
    expect(r.missiles.length).toBe(0);
    let launchedAt = -1;
    for (let i = 1; i <= MISSILE.lockTicks + 2 && launchedAt < 0; i++) {
      if (of(steps(r, 1, NONE, NONE, [a]), 'missileLaunched').length) launchedAt = i;
    }
    expect(launchedAt).toBe(MISSILE.lockTicks);
    expect(r.energy).toBeLessThan(e0); // the usual energy cost, at launch
    expect(r.shipLock.target).toBe(a.id); // the ship lock is unaffected by the launch
  });
});

describe('feedback text and sounds', () => {
  it('one short corner-log line per event, warn only for failures', () => {
    expect(shipLockLine({ type: 'shipLocked', hostile: 1, family: 'raider', x: 0, y: 0 })).toEqual({ text: 'TARGET LOCKED · RAIDER', tone: 'info' });
    expect(shipLockLine({ type: 'shipLockRefused', why: 'noTarget' })).toEqual({ text: 'NO TARGET IN RANGE', tone: 'warn' });
    expect(shipLockLine({ type: 'shipLockEnded', hostile: 1, why: 'cancelled' })?.tone).toBe('info');
    expect(shipLockLine({ type: 'shipLockEnded', hostile: 1, why: 'range' })).toEqual({ text: 'TARGET LOCK LOST · OUT OF RANGE', tone: 'warn' });
    expect(shipLockLine({ type: 'recalled' })).toBeNull();
  });

  it('reuses existing sounds: a soft tick on lock, the refusal tone on failure, silence on release or a kill', () => {
    const ctx = { shieldBefore: 0, shieldAfter: 0 };
    expect(sectorCue({ type: 'shipLocked', hostile: 1, family: 'raider', x: 0, y: 0 }, ctx)).toBe('fr.chip');
    expect(sectorCue({ type: 'shipLockRefused', why: 'noTarget' }, ctx)).toBe('fr.deny');
    expect(sectorCue({ type: 'shipLockEnded', hostile: 1, why: 'cancelled' }, ctx)).toBeNull();
    expect(sectorCue({ type: 'shipLockEnded', hostile: 1, why: 'destroyed' }, ctx)).toBeNull();
    expect(sectorCue({ type: 'shipLockEnded', hostile: 1, why: 'range' }, ctx)).toBe('fr.deny');
  });
});
