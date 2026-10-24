/**
 * Combat P03C (FR-TD-89): the full pilot weapon runtime on the fixed step.
 * Switching through the rotation, the heavy AoE missile, the nuke and its
 * local time dilation, ammunition and cooldowns across switches and ship
 * changes, and cleanup. The lock-on's own lifecycle is in missile.test.ts.
 * No DOM, no storage writes.
 */
import { describe, expect, it } from 'vitest';
import { WEAPON_BY_ID, WEAPON_IDS, type WeaponId } from '../src/config/weapons.ts';
import { createArsenal, cycleWeapon, fireGate, tickArsenal } from '../src/core/weapons/arsenal.ts';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import { agentAlpha, dilationAt, openZone } from '../src/modes/freeroam/combat/dilation.ts';
import { FAMILIES, type FamilyId } from '../src/modes/freeroam/combat/families.ts';
import { gateOf } from '../src/modes/freeroam/combat/playerMissile.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import { armedLoadout, compatibleWeapons, defaultSetup } from '../src/modes/freeroam/ships/armory.ts';
import { EMPTY_SECTOR_SAVE } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, disposeSectorRun, pauseSector, restartSector, resumeSector, setRunLoadout, setRunOrdnance, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { arena } from './helpers/combatProbe.ts';

const NONE: SectorInput = { moveX: 0, moveY: 0 };
const FIRE: SectorInput = { moveX: 0, moveY: 0, fire: true };
const NEXT: SectorInput = { moveX: 0, moveY: 0, cycle: 1 };
const PREV: SectorInput = { moveX: 0, moveY: 0, cycle: -1 };

const ord = (id: WeaponId) => {
  const w = WEAPON_BY_ID.get(id)!;
  if (w.fire !== 'ordnance') throw new Error(`${id} is not ordnance`);
  return w;
};
const HEAVY = ord('heavy-missile');
const NUKE = ord('nuke');
const LOCK = ord('lock-missile');

type Spec = { compatible: readonly WeaponId[]; rotation: readonly WeaponId[]; start: WeaponId };
/** Every weapon fitted (a nuke-capable ship), plasma selected. */
const ALL: Spec = { compatible: WEAPON_IDS, rotation: WEAPON_IDS, start: 'plasma' };
/** A ship without the nuke mount (and without heavy hardpoints). */
const LIGHT: Spec = { compatible: ['plasma', 'lock-missile'], rotation: ['plasma', 'lock-missile'], start: 'plasma' };

/** A calm run with the ship still in the middle, nose up (heading 0). */
function setup(spec: Spec = ALL, seed = 1, ordnance: Record<string, number> = { 'heavy-missile': 4, nuke: 1 }): SectorRun {
  const L = arena(1);
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed, loadout: spec, ordnance });
  r.grace = 100_000; // no enemy fire unless a test wants it
  const cx = L.width / 2;
  const cy = L.height / 2;
  Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0, heading: 0 });
  return r;
}
const foe = (r: SectorRun, family: FamilyId, dx: number, dy: number): Agent => spawnAgent(r, family, 'red-tally', 'test', 'guard', r.ship.x + dx, r.ship.y + dy)!;
const pin = (a: Agent, x: number, y: number): void => {
  Object.assign(a, { x, y, px: x, py: y, vx: 0, vy: 0 });
};
function step(r: SectorRun, n: number, input: SectorInput = NONE, pinned: readonly Agent[] = []): SectorEvent[] {
  const out: SectorEvent[] = [];
  const at = pinned.map((a) => ({ a, x: a.x, y: a.y }));
  for (let i = 0; i < n; i++) {
    for (const p of at) pin(p.a, p.x, p.y);
    r.ship.vx = 0;
    r.ship.vy = 0;
    out.push(...stepSector(r, input));
  }
  return out;
}
const count = (ev: readonly SectorEvent[], type: SectorEvent['type']): number => ev.filter((e) => e.type === type).length;
const ehp = (a: Agent): number => a.hull + a.shield;
/** Select `id` with NEXT presses (one step each). */
function select(r: SectorRun, id: WeaponId): void {
  for (let i = 0; i < 4 && r.arsenal.selected !== id; i++) step(r, 1, NEXT);
  expect(r.arsenal.selected).toBe(id);
}
/** Release then press FIRE (one press edge). */
function press(r: SectorRun, pinned: readonly Agent[] = []): SectorEvent[] {
  return [...step(r, 1, NONE, pinned), ...step(r, 1, FIRE, pinned)];
}

describe('switching (rotation order, wrap, skip, never fires)', () => {
  it('NEXT and PREVIOUS walk the armory order both ways and wrap; one command = one step', () => {
    const r = setup();
    expect(r.arsenal.rotation).toEqual(WEAPON_IDS); // armory order
    const seen: string[] = [r.arsenal.selected];
    for (let i = 0; i < WEAPON_IDS.length; i++) {
      step(r, 1, NEXT);
      seen.push(r.arsenal.selected);
    }
    expect(seen).toEqual([...WEAPON_IDS, WEAPON_IDS[0]]);
    const back: string[] = [];
    for (let i = 0; i < WEAPON_IDS.length; i++) {
      step(r, 1, PREV);
      back.push(r.arsenal.selected);
    }
    expect(back).toEqual([...WEAPON_IDS].reverse().slice(0, WEAPON_IDS.length - 1).concat(WEAPON_IDS[0]!));
  });

  it('weapons outside the rotation or not fitted are skipped and can never be selected or fired', () => {
    const r = setup({ compatible: WEAPON_IDS, rotation: ['plasma', 'nuke'], start: 'plasma' });
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add((step(r, 1, NEXT), r.arsenal.selected));
    expect([...seen].sort()).toEqual(['nuke', 'plasma']);
    expect(gateOf(r, 'heavy-missile')).toBe('unavailable');
    const light = setup(LIGHT);
    for (let i = 0; i < 6; i++) {
      step(light, 1, i % 2 ? PREV : NEXT);
      expect(['plasma', 'lock-missile']).toContain(light.arsenal.selected);
    }
    expect(gateOf(light, 'nuke')).toBe('unavailable');
    expect(gateOf(light, 'heavy-missile')).toBe('unavailable');
  });

  it('switching never fires, never spends ammunition and never touches a cooldown', () => {
    const r = setup();
    const a = foe(r, 'heavy', 0, -400);
    const ammo = { ...r.ammo };
    r.arsenal.cooldown['heavy-missile'] = 100;
    const e0 = r.energy;
    const ev = step(r, 8, NEXT, [a]);
    expect(count(ev, 'weaponSwitched')).toBe(8);
    expect(count(ev, 'missileLaunched') + count(ev, 'missileLock')).toBe(0);
    expect(r.shots).toHaveLength(0);
    expect(r.missiles).toHaveLength(0);
    expect(r.ammo).toEqual(ammo);
    expect(r.arsenal.cooldown['heavy-missile']).toBe(92); // ran down normally, not reset
    expect(r.energy).toBeGreaterThanOrEqual(e0 - 1e-6);
  });

  it('FIRE held through a switch does not fire the new weapon: it needs a new press', () => {
    const r = setup();
    step(r, 5, FIRE); // plasma held
    step(r, 1, { ...FIRE, cycle: 1 }); // now HEAVY, FIRE still held
    expect(r.arsenal.selected).toBe('heavy-missile');
    step(r, 10, FIRE);
    expect(r.missiles).toHaveLength(0);
    expect(r.ammo['heavy-missile']).toBe(4);
    step(r, 1, NONE);
    step(r, 1, FIRE);
    expect(r.missiles).toHaveLength(1);
  });

  it('switching away during a lock cancels it without consuming anything', () => {
    const r = setup();
    const a = foe(r, 'heavy', 0, -300);
    select(r, 'lock-missile');
    press(r, [a]);
    expect(r.missile.state).toBe('acquiring');
    const e0 = r.energy;
    step(r, 1, NEXT, [a]);
    expect(r.missile.state).toBe('ready');
    step(r, LOCK.guidance.kind === 'lock' ? LOCK.guidance.acquire.lockTicks + 2 : 20, NONE, [a]);
    expect(r.missiles).toHaveLength(0);
    expect(r.arsenal.cooldown['lock-missile']).toBe(0);
    expect(r.energy).toBeGreaterThanOrEqual(e0 - 1e-6);
  });

  it('the core arsenal: wrap, skip of unfitted weapons, a nuke never starts selected, invalid ids fall back', () => {
    const a = createArsenal({ compatible: ['plasma', 'heavy-missile'], rotation: ['plasma', 'heavy-missile', 'nuke', 'bogus' as WeaponId], start: 'nuke' });
    expect(a.rotation).toEqual(['plasma', 'heavy-missile']);
    expect(a.selected).toBe('plasma');
    expect(cycleWeapon(a, 1)).toBe(true);
    expect(cycleWeapon(a, 1)).toBe(true);
    expect(a.selected).toBe('plasma');
    const solo = createArsenal({ compatible: [], rotation: [], start: 'heavy-missile' });
    expect(solo.rotation).toEqual(['plasma']); // plasma always stays
    expect(cycleWeapon(solo, 1)).toBe(false);
    expect(fireGate(solo, 'heavy-missile', { stock: () => 4, energy: 100, live: 0 })).toBe('unavailable');
    const n = createArsenal(ALL);
    n.cooldown.nuke = 2;
    expect(tickArsenal(n)).toEqual([]);
    expect(tickArsenal(n)).toEqual(['nuke']);
  });
});

describe('plasma (unchanged gun)', () => {
  it('fires with no ordnance at all, at the gun cadence; ordnance selected means no bolts', () => {
    const r = setup(ALL, 1, { 'heavy-missile': 0, nuke: 0 });
    let made = 0;
    let last = 0;
    for (let t = 0; t < 60; t++) {
      step(r, 1, FIRE);
      if (r.shots.length > last) made += r.shots.length - last;
      last = r.shots.length;
    }
    // the starter's pulse gun: one bolt every 9 ticks (cooldown 9) -> 7 in a second, ammunition irrelevant
    expect(made).toBe(7);
    const r2 = setup();
    select(r2, 'heavy-missile');
    r2.ammo['heavy-missile'] = 0;
    step(r2, 1, NONE);
    step(r2, 60, FIRE);
    expect(r2.shots).toHaveLength(0);
    expect(r2.heat).toBe(0);
  });

  it('the same seed and inputs give the same bolts as a run with no ordnance fitted (no second gun loop)', () => {
    const a = setup(ALL);
    const b = setup(LIGHT);
    const trace = (r: SectorRun): string => {
      const out: string[] = [];
      for (let t = 0; t < 120; t++) {
        step(r, 1, t % 50 < 30 ? FIRE : NONE);
        out.push(`${r.shots.length}:${r.heat.toFixed(4)}`);
      }
      return out.join(',');
    };
    expect(trace(a)).toBe(trace(b));
  });
});

describe('heavy AoE missile', () => {
  it('needs no lock: launches along the nose at once, spends one round, starts its cooldown, travels visibly', () => {
    const r = setup();
    select(r, 'heavy-missile');
    const ev = press(r);
    expect(count(ev, 'missileLock')).toBe(0);
    expect(count(ev, 'missileLaunched')).toBe(1);
    expect(ev.find((e) => e.type === 'ordnanceSpent')).toMatchObject({ weapon: 'heavy-missile', left: 3 });
    expect(r.ammo['heavy-missile']).toBe(3);
    expect(r.arsenal.cooldown['heavy-missile']).toBe(HEAVY.cooldownTicks);
    const m = r.missiles[0]!;
    expect(m.weapon).toBe('heavy-missile');
    expect(m.target).toBeNull();
    expect(m.vx).toBeCloseTo(0, 6);
    expect(m.vy).toBeLessThan(0); // nose up
    let maxStep = 0;
    for (let t = 0; t < 20; t++) {
      const x = m.x;
      const y = m.y;
      step(r, 1);
      maxStep = Math.max(maxStep, Math.hypot(m.x - x, m.y - y));
    }
    expect(maxStep).toBeGreaterThan(0);
    expect(maxStep).toBeLessThanOrEqual(HEAVY.projectile.speed / 60 + 1e-6);
  });

  it('impact: the struck ship takes the impact once; ships in the radius take falloff blast once; outside take nothing', () => {
    const r = setup();
    const direct = foe(r, 'heavy', 0, -300);
    const near = foe(r, 'heavy', 50, -300);
    const out = foe(r, 'heavy', 0, -300 - HEAVY.blast!.radius - FAMILIES.heavy.radius - 120);
    const pinned = [direct, near, out];
    const h = pinned.map(ehp);
    select(r, 'heavy-missile');
    const ev = [...press(r, pinned), ...step(r, 120, NONE, pinned)];
    expect(count(ev, 'missileHit')).toBe(1);
    expect(count(ev, 'detonation')).toBe(1);
    const det = ev.find((e) => e.type === 'detonation')!;
    expect(det).toMatchObject({ weapon: 'heavy-missile', r: HEAVY.blast!.radius });
    expect(h[0]! - ehp(direct)).toBeCloseTo(HEAVY.impactDamage, 5);
    const blast = h[1]! - ehp(near);
    expect(blast).toBeGreaterThan(HEAVY.blast!.damage * HEAVY.blast!.edgeMul - 1e-6);
    expect(blast).toBeLessThanOrEqual(HEAVY.blast!.damage + 1e-6);
    expect(ehp(out)).toBe(h[2]);
    expect(r.missiles).toHaveLength(0);
  });

  it('with nothing in the way it detonates at the end of its life (no endless missile)', () => {
    const r = setup();
    select(r, 'heavy-missile');
    press(r);
    let ev: SectorEvent[] = [];
    for (let t = 0; t <= HEAVY.projectile.lifeTicks + 1 && r.missiles.length; t++) ev = ev.concat(step(r, 1));
    expect(r.missiles).toHaveLength(0);
    expect(count(ev, 'detonation')).toBe(1);
  });

  it('a rock stops it with a detonation; the sector edge removes it', () => {
    const r = setup();
    const rocks = r.layout.rocks as unknown as { x: number; y: number; r: number }[];
    rocks.push({ x: r.ship.x, y: r.ship.y - 160, r: 24 });
    try {
      select(r, 'heavy-missile');
      const ev = [...press(r), ...step(r, 40)];
      expect(r.missiles).toHaveLength(0);
      expect(count(ev, 'detonation')).toBe(1);
      const d = ev.find((e) => e.type === 'detonation') as { y: number };
      expect(d.y).toBeGreaterThan(r.ship.y - 160 - 24 - 12);
    } finally {
      rocks.pop();
    }
    const r2 = setup();
    r2.missiles.push({ id: 1, weapon: 'heavy-missile', x: 3, y: r2.ship.y, px: 4, py: r2.ship.y, vx: -400, vy: 0, speed: 400, life: 100, target: null });
    step(r2, 2);
    expect(r2.missiles).toHaveLength(0);
  });

  it('empty: refused with EMPTY feedback, nothing launched, no cooldown; holding never repeats; presses obey the cooldown', () => {
    const r = setup(ALL, 1, { 'heavy-missile': 0, nuke: 1 });
    select(r, 'heavy-missile');
    const ev = press(r);
    expect(ev.find((e) => e.type === 'missileRefused')).toMatchObject({ reason: 'empty', weapon: 'heavy-missile' });
    expect(r.missiles).toHaveLength(0);
    expect(r.arsenal.cooldown['heavy-missile']).toBe(0);
    const r2 = setup();
    select(r2, 'heavy-missile');
    step(r2, 1, NONE);
    let e2 = step(r2, 1000, FIRE); // held
    expect(count(e2, 'missileLaunched')).toBe(1);
    e2 = [];
    for (let t = 0; t < 1200; t++) e2.push(...step(r2, 1, t % 2 ? FIRE : NONE)); // tapped as fast as possible
    expect(count(e2, 'missileLaunched')).toBeLessThanOrEqual(Math.ceil(1200 / HEAVY.cooldownTicks) + 1);
    expect(r2.ammo['heavy-missile']).toBeGreaterThanOrEqual(0);
    expect(e2.some((e) => e.type === 'missileRefused' && e.reason === 'cooling')).toBe(true);
  });
});

describe('nuke and local time dilation', () => {
  it('only a nuke-capable ship can select or fire it; a ship without the mount never can, whatever the magazine', () => {
    const light = setup(LIGHT, 1, { 'heavy-missile': 4, nuke: 1 });
    for (let i = 0; i < 5; i++) step(light, 1, NEXT);
    expect(light.arsenal.selected).not.toBe('nuke');
    expect(gateOf(light, 'nuke')).toBe('unavailable');
    // the real roster: only the Condor and the Albatross carry it
    for (const ship of ['petrel', 'swift', 'shrike', 'condor', 'magpie', 'albatross'] as const) {
      expect(compatibleWeapons(ship).includes('nuke'), ship).toBe(ship === 'condor' || ship === 'albatross');
      expect(defaultSetup(ship).start).not.toBe('nuke');
    }
  });

  it('fires one charge, travels, detonates with a big blast (bosses take half) and opens one dilation zone', () => {
    const r = setup();
    const boss = foe(r, 'capital', 0, -200);
    const grunt = foe(r, 'heavy', 120, -200);
    const pinned = [boss, grunt];
    const b0 = ehp(boss);
    const g0 = ehp(grunt);
    select(r, 'nuke');
    let ev = press(r, pinned);
    expect(count(ev, 'missileLaunched')).toBe(1);
    expect(r.ammo.nuke).toBe(0);
    expect(r.missiles[0]!.weapon).toBe('nuke');
    ev = step(r, NUKE.projectile.lifeTicks + 2, NONE, pinned);
    const det = ev.find((e) => e.type === 'detonation');
    expect(det).toMatchObject({ weapon: 'nuke', r: NUKE.blast!.radius });
    expect(count(ev, 'dilation')).toBeGreaterThanOrEqual(1);
    expect(ev.find((e) => e.type === 'dilation')).toMatchObject({ state: 'start', r: NUKE.dilation!.radius, ticks: NUKE.dilation!.durationTicks });
    expect(b0 - ehp(boss)).toBeLessThanOrEqual(NUKE.impactDamage * NUKE.damageRules.bossMul + 1e-6); // bosses keep their role
    expect(g0 - ehp(grunt)).toBeGreaterThan(0);
    // empty now: a second press is refused without a launch
    step(r, NUKE.cooldownTicks + 1);
    const again = press(r);
    expect(again.find((e) => e.type === 'missileRefused')).toMatchObject({ reason: 'empty' });
  });

  it('a nuke is never a start weapon and never resets cooldowns or refills by a ship change', () => {
    const r = setup({ compatible: WEAPON_IDS, rotation: WEAPON_IDS, start: 'nuke' });
    expect(r.arsenal.selected).toBe('plasma');
    r.arsenal.cooldown.nuke = 300;
    r.ammo.nuke = 0;
    setRunLoadout(r, LIGHT, true);
    setRunLoadout(r, ALL, true);
    expect(r.arsenal.cooldown.nuke).toBe(300);
    expect(r.ammo.nuke).toBe(0);
  });

  it('dilation: hostile ships inside run at half speed (accumulator, every second step), the pilot and its ordnance do not', () => {
    const mk = (): { r: SectorRun; a: Agent } => {
      const r = setup(ALL, 3);
      const a = foe(r, 'raider', 300, -300);
      Object.assign(a, { vx: 120, vy: 0 });
      return { r, a };
    };
    const free = mk();
    const slow = mk();
    openZone(slow.r, slow.a.x, slow.a.y, { scale: 0.5, radius: 400, durationTicks: 120 }, []);
    const fx: number[] = [];
    const sx: number[] = [];
    for (let t = 0; t < 40; t++) {
      step(free.r, 1);
      step(slow.r, 1);
      fx.push(free.a.x);
      sx.push(slow.a.x);
    }
    // the slowed ship replays the free ship's steps at half the rate: its tick 2k equals the free tick k
    for (let k = 1; k < 20; k++) expect(sx[2 * k - 1]).toBeCloseTo(fx[k - 1]!, 6);
    expect(slow.a.tscale).toBe(0.5);
    expect(agentAlpha(slow.a, 1)).toBeLessThanOrEqual(1);
    // the pilot inside the same zone moves at full speed
    const p = setup(ALL, 3);
    const q = setup(ALL, 3);
    openZone(q, q.ship.x, q.ship.y, { scale: 0.5, radius: 400, durationTicks: 120 }, []);
    for (let t = 0; t < 30; t++) {
      stepSector(p, { moveX: 1, moveY: 0 });
      stepSector(q, { moveX: 1, moveY: 0 });
    }
    expect(q.ship.x).toBeCloseTo(p.ship.x, 6);
    // pilot ordnance is never slowed: the same launch with and without a zone over the pilot flies the same path
    const path = (zone: boolean): string => {
      const r = setup(ALL, 3);
      if (zone) openZone(r, r.ship.x, r.ship.y, { scale: 0.5, radius: 600, durationTicks: 120 }, []);
      select(r, 'heavy-missile');
      press(r);
      const m = r.missiles[0]!;
      const out: string[] = [];
      for (let t = 0; t < 30; t++) {
        step(r, 1);
        out.push(`${m.x.toFixed(4)},${m.y.toFixed(4)}`);
      }
      return out.join(' ');
    };
    expect(path(true)).toBe(path(false));
    expect(path(false).split(' ')[0]).not.toBe(path(false).split(' ')[29]);
  });

  it('enemy shots inside move and age at half rate; a ship that leaves is at full speed next tick; zones never stack', () => {
    const r = setup();
    openZone(r, r.ship.x, r.ship.y - 300, { scale: 0.5, radius: 200, durationTicks: 120 }, []);
    openZone(r, r.ship.x, r.ship.y - 300, { scale: 0.5, radius: 150, durationTicks: 120 }, []);
    expect(dilationAt(r.dilation, r.ship.x, r.ship.y - 300)).toBe(0.5); // min, not 0.25
    const a = foe(r, 'raider', 0, -300);
    step(r, 2, NONE, [a]);
    expect(a.tscale).toBe(0.5);
    pin(a, r.ship.x + 700, r.ship.y - 300);
    step(r, 1);
    expect(a.tscale).toBe(1);
    expect(a.tacc).toBe(0);
    // an enemy bolt inside the zone
    const shots = r.enemyShots as unknown as { x: number; y: number; vx: number; vy: number; life: number; faction: string; kind: string }[];
    const before = r.enemyShots.length;
    const s = { ...(r.enemyShots[0] ?? {}), x: r.ship.x - 600, y: r.ship.y - 300, px: r.ship.x - 600, py: r.ship.y - 300, vx: 0, vy: 240, life: 100, faction: 'red-tally', kind: 'bolt', damage: 1, radius: 3, id: 999 } as unknown as (typeof shots)[number];
    shots.push(s);
    // outside: full speed
    step(r, 1);
    const fast = s.y - (r.ship.y - 300);
    expect(fast).toBeCloseTo(4, 3);
    // move it into the zone
    Object.assign(s, { x: r.ship.x, y: r.ship.y - 300 });
    const y1 = s.y;
    const l1 = s.life;
    step(r, 1);
    expect(s.y - y1).toBeCloseTo(2, 3);
    expect(l1 - s.life).toBeCloseTo(0.5, 6);
    expect(r.enemyShots.length).toBe(before + 1);
  });

  it('expires after 2 s of simulation time, freezes while paused, and restart, recall and unload leave nothing slowed', () => {
    const r = setup();
    const a = foe(r, 'raider', 0, -300);
    openZone(r, a.x, a.y, { scale: NUKE.dilation!.scale, radius: NUKE.dilation!.radius, durationTicks: NUKE.dilation!.durationTicks }, []);
    step(r, 60, NONE, [a]);
    pauseSector(r);
    for (let i = 0; i < 300; i++) stepSector(r, NONE);
    resumeSector(r);
    expect(r.dilation[0]!.ticksLeft).toBe(60);
    const ev = step(r, 60, NONE, [a]);
    expect(r.dilation).toHaveLength(0);
    expect(ev.find((e) => e.type === 'dilation')).toMatchObject({ state: 'end' });
    step(r, 1, NONE, [a]);
    expect(a.tscale).toBe(1);
    const tick0 = r.tick;
    step(r, 10);
    expect(r.tick).toBe(tick0 + 10); // the global step never changes
    for (const end of ['restart', 'dispose'] as const) {
      const q = setup();
      openZone(q, q.ship.x, q.ship.y - 200, { scale: 0.5, radius: 300, durationTicks: 120 }, []);
      foe(q, 'raider', 0, -200);
      step(q, 3);
      if (end === 'restart') restartSector(q);
      else disposeSectorRun(q);
      expect(q.dilation, end).toHaveLength(0);
      expect(q.missiles, end).toHaveLength(0);
      expect(q.hostiles.every((h) => (h.tscale ?? 1) === 1), end).toBe(true);
    }
  });
});

describe('ammunition, cooldowns and ship changes', () => {
  it('cooldowns run for every weapon while another is selected and survive switching; ammo never comes back', () => {
    const r = setup();
    select(r, 'heavy-missile');
    press(r);
    const c0 = r.arsenal.cooldown['heavy-missile'];
    step(r, 1, NEXT);
    step(r, 30);
    step(r, 1, PREV);
    expect(r.arsenal.selected).toBe('heavy-missile');
    expect(r.arsenal.cooldown['heavy-missile']).toBe(c0 - 32);
    expect(r.ammo['heavy-missile']).toBe(3);
  });

  it('a ship change removes illegal access at once and keeps the clocks; the same ship keeps its legal selection', () => {
    const r = setup();
    select(r, 'heavy-missile');
    press(r);
    const cd = r.arsenal.cooldown['heavy-missile'];
    setRunLoadout(r, LIGHT, true);
    expect(r.arsenal.selected).toBe('plasma');
    expect(gateOf(r, 'heavy-missile')).toBe('unavailable');
    expect(r.arsenal.cooldown['heavy-missile']).toBe(cd);
    expect(r.ammo['heavy-missile']).toBe(3); // the magazine is the pilot's, not refilled or lost
    step(r, 1, NONE);
    const ev = step(r, 1, FIRE);
    expect(count(ev, 'missileLaunched')).toBe(0);
    // same ship, rotation edit: a still-legal selection stays
    const q = setup();
    select(q, 'lock-missile');
    setRunLoadout(q, { compatible: WEAPON_IDS, rotation: ['plasma', 'lock-missile'], start: 'plasma' }, false);
    expect(q.arsenal.selected).toBe('lock-missile');
    setRunLoadout(q, { compatible: WEAPON_IDS, rotation: ['plasma'], start: 'plasma' }, false);
    expect(q.arsenal.selected).toBe('plasma');
  });

  it('the run fires from the saved counts and reports every spend; restocking is the only rise', () => {
    const r = setup(ALL, 1, { 'heavy-missile': 2, nuke: 0 });
    select(r, 'heavy-missile');
    const spent: number[] = [];
    for (let i = 0; i < 4; i++) {
      for (const e of press(r)) if (e.type === 'ordnanceSpent') spent.push(e.left);
      step(r, HEAVY.cooldownTicks + 1);
    }
    expect(spent).toEqual([1, 0]);
    expect(r.ammo['heavy-missile']).toBe(0);
    setRunOrdnance(r, { 'heavy-missile': 4, nuke: 1, junk: 99 } as Record<string, number>);
    expect(r.ammo).toEqual({ 'heavy-missile': 4, nuke: 1 });
    step(r, 1, NONE);
    expect(count(step(r, 1, FIRE), 'missileLaunched')).toBe(1);
  });

  it('the shell loadout of every roster ship arms the run consistently (rotation from the armory, start weapon legal)', () => {
    for (const ship of ['petrel', 'swift', 'shrike', 'condor', 'magpie', 'albatross'] as const) {
      const spec = armedLoadout({ active: ship, owned: ['petrel', ship], loadouts: {} });
      const r = setup(spec);
      expect(r.arsenal.rotation.every((w) => compatibleWeapons(ship).includes(w)), ship).toBe(true);
      expect(r.arsenal.selected, ship).not.toBe('nuke');
    }
  });

  it('is deterministic: the same seed and inputs give the same outcome with every weapon', () => {
    const play = (): string => {
      const r = setup(ALL, 9);
      foe(r, 'lancer', 40, -300);
      foe(r, 'heavy', -60, -260);
      const ev: string[] = [];
      for (let t = 0; t < 900; t++) {
        const input: SectorInput = t % 150 === 0 ? NEXT : t % 30 === 1 ? FIRE : NONE;
        for (const e of stepSector(r, input)) if (e.type.startsWith('missile') || e.type === 'detonation' || e.type === 'dilation') ev.push(`${t}:${e.type}`);
      }
      return `${ev.join(',')}|${r.hostiles.map((h) => `${h.id}:${h.hull.toFixed(3)}:${h.shield.toFixed(3)}`).join(',')}`;
    };
    expect(play()).toBe(play());
  });
});
