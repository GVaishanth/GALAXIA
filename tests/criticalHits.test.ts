/**
 * Finale P1: critical hits (docs/freeroam/CRITICAL_HITS.md) on the real sector simulation.
 *
 * The 10 % rate is proven by the decision boundary (isCritical on exact draws) and by the
 * one-draw-per-firing-event rule; the fixed-seed frequency check is supplemental only.
 * Outcome tests force the decision through the documented seam (forceCritical), which keeps
 * drawing from the stream, so everything else in the run is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { WEAPON_IDS, type WeaponId } from '../src/config/weapons.ts';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import { CRIT_CHANCE, critShip, forceCritical, freshCrit, isCritical, rollCritical, useCritical, type CritMode, type CritToken } from '../src/modes/freeroam/combat/critical.ts';
import { heatOf, HEAT } from '../src/modes/freeroam/combat/factionHeat.ts';
import type { FamilyId } from '../src/modes/freeroam/combat/families.ts';
import { spawnShot, stepBeam } from '../src/modes/freeroam/combat/projectiles.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import { WEAPONS } from '../src/modes/freeroam/combat/weapons.ts';
import { damageAgent, damagePlayer } from '../src/modes/freeroam/combat/world.ts';
import * as Kit from '../src/modes/freeroam/fleet/fleetKit.ts';
import type { VesselSpec } from '../src/modes/freeroam/fleet/vessels.ts';
import { EMPTY_SECTOR_SAVE } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, RUN, shipTuning, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { deriveShip } from '../src/modes/freeroam/ships/equipment.ts';
import type { ShipId } from '../src/modes/freeroam/ships/types.ts';
import { upgradedShip } from '../src/modes/freeroam/ships/upgrades.ts';
import { arena } from './helpers/combatProbe.ts';
import { attackInput } from './helpers/frPilot.ts';

const NONE: SectorInput = { moveX: 0, moveY: 0 };
const FIRE: SectorInput = { moveX: 0, moveY: 0, fire: true };
const ALL = { compatible: WEAPON_IDS, rotation: WEAPON_IDS, start: 'plasma' as WeaponId };

/** A calm run, the ship still in the middle with its nose up (heading 0); enemy fire held unless `fight`. */
function setup(o: { mode?: CritMode; seed?: number; ship?: ShipId; fight?: boolean; loadout?: typeof ALL } = {}): SectorRun {
  const L = arena(1);
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: o.seed ?? 11, ship: deriveShip(o.ship ?? 'petrel'), ...(o.loadout ? { loadout: o.loadout, ordnance: { 'heavy-missile': 4, nuke: 1, 'lock-missile': 4 } } : {}) });
  r.grace = o.fight ? 0 : 100_000;
  Object.assign(r.ship, { x: L.width / 2, y: L.height / 2, px: L.width / 2, py: L.height / 2, vx: 0, vy: 0, heading: 0 });
  if (o.mode) forceCritical(r, o.mode);
  return r;
}
const foe = (r: SectorRun, family: FamilyId, dx: number, dy: number, faction: 'red-tally' | 'gleaners' | 'haven-guild' = 'red-tally'): Agent => spawnAgent(r, family, faction, 'test', 'guard', r.ship.x + dx, r.ship.y + dy)!;
const pin = (a: Agent, x: number, y: number): void => void Object.assign(a, { x, y, px: x, py: y, vx: 0, vy: 0 });
const quiet = (a: Agent): void => void a.cooldowns.fill(1e9);
function step(r: SectorRun, n: number, input: SectorInput = NONE, pinned: readonly Agent[] = []): SectorEvent[] {
  const at = pinned.map((a) => ({ a, x: a.x, y: a.y }));
  const out: SectorEvent[] = [];
  for (let i = 0; i < n; i++) {
    for (const p of at) pin(p.a, p.x, p.y);
    for (const p of at) quiet(p.a);
    r.ship.vx = 0;
    r.ship.vy = 0;
    out.push(...stepSector(r, input));
  }
  return out;
}
const of = <T extends SectorEvent['type']>(ev: readonly SectorEvent[], type: T): Extract<SectorEvent, { type: T }>[] => ev.filter((e): e is Extract<SectorEvent, { type: T }> => e.type === type);
const ehp = (a: Agent): number => a.hull + a.shield;
/** One trigger pull (a release then FIRE for one tick), then `after` quiet ticks for the bolt to land. */
const shoot = (r: SectorRun, pinned: readonly Agent[], after = 40): SectorEvent[] => [...step(r, 1, NONE, pinned), ...step(r, 1, FIRE, pinned), ...step(r, after, NONE, pinned)];
const spec = (vessel: string, ship: ShipId, captain: string): VesselSpec => {
  const d = upgradedShip(ship, undefined, {});
  return { vessel, ship, captain, stats: d.stats, weapon: d.weapon, radius: d.radius, sprite: d.sprite, tune: shipTuning(d) };
};

describe('the rule: 10 % per eligible firing event, decided once', () => {
  it('1 · the decision boundary is exactly 10 %: a draw below 0.1 is critical, 0.1 and above is ordinary', () => {
    expect(CRIT_CHANCE).toBe(0.1);
    for (const u of [0, 0.05, 0.0999999]) expect(isCritical(u), String(u)).toBe(true);
    for (const u of [0.1, 0.1000001, 0.5, 0.9999999]) expect(isCritical(u), String(u)).toBe(false);
  });

  it('2 · one draw per trigger pull (never per frame, per tick or per bolt); twin bolts share one decision', () => {
    const r = setup({ ship: 'shrike' }); // stock Twin Pulse Battery: two bolts per pull
    expect(r.craft.weapon.bolts).toBe(2);
    const before = r.crit.rolls;
    step(r, 1, FIRE);
    expect(r.crit.rolls - before).toBe(1);
    expect(r.shots).toHaveLength(2);
    expect('crit' in r.shots[0]!).toBe(true);
    expect(r.shots[0]!.crit).toBe(r.shots[1]!.crit); // the same token (or both null): one decision for the pull
    step(r, 120, FIRE); // held fire: one draw per bolt pair the gun actually fires
    expect(r.crit.rolls - before).toBe(r.shotsFired);
    step(r, 60, NONE); // flight without firing draws nothing
    expect(r.crit.rolls - before).toBe(r.shotsFired);
  });

  it('3 · deterministic: the same seed and inputs give the same decisions; another seed gives others; forcing never moves the stream', () => {
    const seq = (seed: number, mode: CritMode = 'auto'): boolean[] => {
      const s = freshCrit(seed);
      s.mode = mode;
      return Array.from({ length: 200 }, () => rollCritical({ crit: s }) !== null);
    };
    expect(seq(7)).toEqual(seq(7));
    expect(seq(7)).not.toEqual(seq(8));
    // forced modes still draw once per event: switching back to AUTO continues the same stream
    const a = freshCrit(7);
    const b = freshCrit(7);
    b.mode = 'crit';
    for (let i = 0; i < 50; i++) {
      rollCritical({ crit: a });
      rollCritical({ crit: b });
    }
    b.mode = 'auto';
    expect(Array.from({ length: 50 }, () => rollCritical({ crit: a }) !== null)).toEqual(Array.from({ length: 50 }, () => rollCritical({ crit: b }) !== null));
  });

  it('4 · a stream of its own: critical decisions never shift the run rng (spawn jitter, traits, aim, evasion)', () => {
    const a = setup({ mode: 'crit', seed: 3 });
    const b = setup({ mode: 'normal', seed: 3 });
    step(a, 90, FIRE);
    step(b, 90, FIRE);
    expect(a.crit.rolls).toBe(b.crit.rolls);
    expect(Array.from({ length: 5 }, () => a.rng.next())).toEqual(Array.from({ length: 5 }, () => b.rng.next()));
  });

  it('5 · supplemental only: a fixed-seed run of 20,000 decisions lands near 10 %', () => {
    const s = freshCrit(20261102);
    let n = 0;
    for (let i = 0; i < 20_000; i++) if (rollCritical({ crit: s })) n++;
    expect(n / 20_000).toBeGreaterThan(0.09);
    expect(n / 20_000).toBeLessThan(0.11);
    expect(s.rolled).toBe(n);
  });
});

describe('the pilot hits a hostile ship', () => {
  it('6 · a critical destroys an eligible hostile through the ordinary path: one destroyed event, one kill, heat once, one critical record', () => {
    const r = setup({ mode: 'crit' });
    const a = foe(r, 'heavy', 0, -140);
    const heat0 = heatOf(r.factionHeat, 'red-tally');
    const ev = shoot(r, [a]);
    expect(a.state).toBe('destroyed');
    expect(of(ev, 'destroyed')).toHaveLength(1);
    expect(of(ev, 'destroyed')[0]).toMatchObject({ hostile: a.id, by: 'player' });
    expect(r.kills).toBe(1);
    expect(heatOf(r.factionHeat, 'red-tally') - heat0).toBe(HEAT.hit + HEAT.kill); // one hit, one kill: never doubled
    const crit = of(ev, 'critical');
    expect(crit).toHaveLength(1);
    expect(crit[0]).toMatchObject({ victim: 'hostile', by: 'player', what: 'heavy' });
    expect(r.crit).toMatchObject({ rolled: 1, landed: 1 });
    expect(r.crit.last).toHaveLength(1);
    // the event order keeps the ordinary pipeline first (kill credit, loot and the lock end key off 'destroyed')
    expect(ev.findIndex((e) => e.type === 'destroyed')).toBeLessThan(ev.findIndex((e) => e.type === 'critical'));
  });

  it('7 · an ordinary hit removes exactly the weapon damage and records nothing', () => {
    const r = setup({ mode: 'normal' });
    const a = foe(r, 'heavy', 0, -140);
    const h0 = ehp(a);
    const ev = shoot(r, [a]);
    expect(h0 - ehp(a)).toBeCloseTo(r.craft.weapon.damage, 6);
    expect(of(ev, 'critical')).toHaveLength(0);
    expect(r.crit.landed).toBe(0);
  });

  it('8 · a critical shot that misses does nothing: no damage, no record, nothing carried to a later shot', () => {
    const r = setup({ mode: 'crit' });
    const a = foe(r, 'heavy', 300, 0); // beside the ship, off the nose
    const h0 = ehp(a);
    const ev = shoot(r, [a], 70);
    expect(r.crit.rolled).toBe(1);
    expect(ehp(a)).toBe(h0);
    expect(of(ev, 'critical')).toHaveLength(0);
    expect(r.crit.landed).toBe(0);
    expect(r.shots).toHaveLength(0); // the bolt expired with its token
    forceCritical(r, 'normal');
    const b = foe(r, 'heavy', 0, -140);
    const hb = ehp(b);
    shoot(r, [a, b]);
    expect(hb - ehp(b)).toBeCloseTo(r.craft.weapon.damage, 6); // the earlier critical did not carry over
  });

  it('9 · the token is spent once: twin bolts on two ships destroy at most one; the sibling bolt hits ordinarily', () => {
    const r = setup({ mode: 'crit', ship: 'shrike' });
    const left = foe(r, 'heavy', -5, -120);
    const right = foe(r, 'heavy', 5, -120);
    const h = [ehp(left), ehp(right)];
    const ev = shoot(r, [left, right]);
    const destroyed = [left, right].filter((a) => a.state === 'destroyed');
    expect(destroyed).toHaveLength(1);
    expect(of(ev, 'critical')).toHaveLength(1);
    const other = destroyed[0] === left ? right : left;
    expect((other === left ? h[0]! : h[1]!) - ehp(other)).toBeCloseTo(r.craft.weapon.damage, 6);
  });

  it('10 · faction safety: a wary ship takes an ordinary hit (then turns hostile); the critical is not spent on it', () => {
    const r = setup({ mode: 'crit' });
    const g = foe(r, 'heavy', 0, -140, 'gleaners');
    const h0 = ehp(g);
    const ev = shoot(r, [g]);
    expect(g.state).not.toBe('destroyed');
    expect(h0 - ehp(g)).toBeCloseTo(r.craft.weapon.damage, 6);
    expect(of(ev, 'critical')).toHaveLength(0);
    expect(r.provoked).toContain('gleaners'); // the ordinary provocation still happens
  });

  it('11 · protection: a capital ship (boss class) takes an ordinary hit; criticals never delete it', () => {
    const r = setup({ mode: 'crit' });
    const c = foe(r, 'capital', 0, -200);
    expect(critShip(c)).toBe(false);
    const h0 = ehp(c);
    const ev = shoot(r, [c]);
    expect(c.state).not.toBe('destroyed');
    expect(h0 - ehp(c)).toBeCloseTo(r.craft.weapon.damage, 6);
    expect(of(ev, 'critical')).toHaveLength(0);
    expect(useCritical({ spent: false }, c)).toBe(false);
  });
});

describe('ordnance: one decision per launch, direct impact only', () => {
  const select = (r: SectorRun, id: WeaponId): void => {
    for (let i = 0; i < 6 && r.arsenal.selected !== id; i++) step(r, 1, { moveX: 0, moveY: 0, cycle: 1 });
    expect(r.arsenal.selected).toBe(id);
  };
  const launch = (mode: CritMode, weapon: WeaponId) => {
    const r = setup({ mode, loadout: ALL });
    const direct = foe(r, 'heavy', 0, -300);
    const near = foe(r, 'heavy', 50, -300);
    const pinned = [direct, near];
    const h = pinned.map(ehp);
    select(r, weapon);
    const rolls = r.crit.rolls;
    const ev = [...step(r, 1, NONE, pinned), ...step(r, 1, FIRE, pinned), ...step(r, 150, NONE, pinned)];
    return { r, ev, direct, near, h, rolls: r.crit.rolls - rolls };
  };

  it('12 · a critical heavy missile destroys the struck ship only; the blast on its neighbour is the ordinary falloff', () => {
    const crit = launch('crit', 'heavy-missile');
    const normal = launch('normal', 'heavy-missile');
    expect(crit.rolls).toBe(1);
    expect(crit.direct.state).toBe('destroyed');
    expect(of(crit.ev, 'critical')).toHaveLength(1);
    expect(of(crit.ev, 'missileHit')).toHaveLength(1);
    expect(of(crit.ev, 'missileHit')[0]).toMatchObject({ killed: true });
    // AoE policy: no chained criticals and no mass deletion: the neighbour loses exactly what it loses ordinarily
    expect(crit.near.state).not.toBe('destroyed');
    expect(crit.h[1]! - ehp(crit.near)).toBeCloseTo(normal.h[1]! - ehp(normal.near), 6);
    expect(of(crit.ev, 'detonation')).toHaveLength(1);
  });

  it('13 · a nuke keeps its radius, damage and dilation: a critical removes only the directly struck ship', () => {
    const crit = launch('crit', 'nuke');
    const normal = launch('normal', 'nuke');
    expect(crit.rolls).toBe(1);
    expect(of(crit.ev, 'critical').length).toBeLessThanOrEqual(1);
    expect(crit.near.state).toBe(normal.near.state);
    expect(crit.h[1]! - ehp(crit.near)).toBeCloseTo(normal.h[1]! - ehp(normal.near), 6);
    expect(crit.r.dilation.length).toBe(normal.r.dilation.length);
    expect(of(crit.ev, 'detonation').map((d) => d.r)).toEqual(of(normal.ev, 'detonation').map((d) => d.r));
  });
});

describe('hostile NPC fire', () => {
  /** A hostile ship of `family` firing `weapon` at the pilot through spawnShot with this firing's decision. */
  const fireAtPilot = (r: SectorRun, family: FamilyId, weapon: Parameters<typeof spawnShot>[2], dy = -160): { a: Agent; crit: CritToken | null } => {
    const a = foe(r, family, 0, dy);
    quiet(a);
    const crit = rollCritical(r);
    expect(spawnShot(r, a, weapon, Math.atan2(r.ship.y - a.y, r.ship.x - a.x), 0, null, crit)).toBe(true);
    return { a, crit };
  };

  it('14 · a critical on the pilot uses the ordinary loss: hull 0, one critical record, then the normal recall exactly once', () => {
    const r = setup({ mode: 'crit', fight: true });
    r.invuln = 0;
    const { a } = fireAtPilot(r, 'raider', 'spark');
    const ev = step(r, 60, NONE, [a]);
    const crit = of(ev, 'critical');
    expect(crit).toHaveLength(1);
    expect(crit[0]).toMatchObject({ victim: 'player', by: 'npc', what: 'pilot' });
    expect(of(ev, 'recalled')).toHaveLength(1);
    expect(r.recalls).toBe(1);
    expect(r.hull).toBe(r.craft.stats.hull); // the recall repaired the ship at the arrival zone, as ever
  });

  it('15 · invulnerability still absorbs a critical (the token is used up; no loss, no record)', () => {
    const r = setup({ mode: 'crit', fight: true });
    r.invuln = 1e9;
    const hull = r.hull;
    const { a, crit } = fireAtPilot(r, 'raider', 'spark');
    const ev = step(r, 60, NONE, [a]);
    expect(crit!.spent).toBe(true);
    expect(r.hull).toBe(hull);
    expect(of(ev, 'critical')).toHaveLength(0);
    expect(of(ev, 'recalled')).toHaveLength(0);
  });

  it('16 · one decision per volley: flak pellets share one token; burst follow-ups are firing events of their own', () => {
    const r = setup({ fight: true, seed: 4 });
    const heavy = foe(r, 'heavy', 0, -120); // held inside flak range (it would back off to its preferred cannon range)
    heavy.target = 'player';
    const hx = heavy.x;
    const hy = heavy.y;
    let fired = 0;
    let volleyChecked = false;
    for (let t = 0; t < 900 && !volleyChecked; t++) {
      const rolls = r.crit.rolls;
      pin(heavy, hx, hy);
      const ev = step(r, 1);
      const flak = of(ev, 'enemyFired').filter((e) => e.weapon === 'flak');
      if (flak.length) {
        fired++;
        expect(r.crit.rolls - rolls).toBe(1);
        const pellets = r.enemyShots.filter((s) => s.owner === heavy.id && s.weapon === 'flak');
        expect(pellets.length).toBeGreaterThan(1);
        expect(new Set(pellets.map((s) => s.crit)).size).toBe(1);
        volleyChecked = true;
      }
      r.invuln = 1e9;
    }
    expect(fired).toBe(1);
    // burst: the picket's spark burst is three firing events (three draws)
    const r2 = setup({ fight: true, seed: 4 });
    const p = foe(r2, 'picket', 0, -200);
    p.target = 'player';
    let volleys = 0;
    for (let t = 0; t < 900; t++) {
      volleys += of(step(r2, 1), 'enemyFired').length;
      r2.invuln = 1e9;
    }
    expect(volleys).toBeGreaterThan(0);
    const burst = WEAPONS['spark-burst'].burst;
    expect(burst).toBeGreaterThan(1);
    expect(r2.crit.rolls).toBeGreaterThanOrEqual(volleys * burst - (burst - 1)); // the last burst may still be under way
    expect(r2.crit.rolls).toBeLessThanOrEqual(volleys * burst);
  });

  it('17 · mines and launch bays never draw: they are not weapon shots', () => {
    const r = setup({ fight: true });
    const h = foe(r, 'hauler', 0, -200);
    h.target = 'player';
    let sparks = 0;
    let mines = 0;
    for (let t = 0; t < 1500; t++) {
      const ev = step(r, 1);
      for (const e of of(ev, 'enemyFired')) {
        if (e.weapon === 'spark') sparks++;
        if (e.weapon === 'mine') mines++;
      }
      r.invuln = 1e9;
    }
    expect(mines).toBeGreaterThan(0);
    expect(r.crit.rolls).toBe(sparks); // one draw per spark shot, none for the mines
  });

  it('18 · NPC against NPC: a critical destroys the struck ship, credits nobody (no pilot kill, no heat)', () => {
    const r = setup({ mode: 'crit' });
    const red = foe(r, 'raider', 600, -600);
    const gl = foe(r, 'heavy', 600, -760, 'gleaners');
    quiet(red);
    const heat = heatOf(r.factionHeat, 'gleaners');
    expect(spawnShot(r, red, 'spark', Math.atan2(gl.y - red.y, gl.x - red.x), 0, null, rollCritical(r))).toBe(true);
    const ev = step(r, 60, NONE, [red, gl]);
    expect(gl.state).toBe('destroyed');
    expect(of(ev, 'critical')).toHaveLength(1);
    expect(of(ev, 'critical')[0]).toMatchObject({ victim: 'hostile', by: 'npc' });
    expect(r.kills).toBe(0);
    expect(heatOf(r.factionHeat, 'gleaners')).toBe(heat);
  });

  it('19 · a beam firing makes one decision: the first eligible ship it touches spends it, later ships and ticks are ordinary', () => {
    const r = setup({ mode: 'crit' });
    const owner = foe(r, 'raider', 600, -600);
    const first = foe(r, 'heavy', 700, -600, 'gleaners');
    const second = foe(r, 'heavy', 800, -600, 'gleaners');
    const h2 = ehp(second);
    owner.beam = { start: 0, sweep: 0, ticks: 0, total: 30, angle: 0, hit: new Set(), crit: rollCritical(r) };
    const ev: SectorEvent[] = [];
    for (let i = 0; i < 30; i++) stepBeam(r, owner, ev);
    expect(first.state).toBe('destroyed');
    expect(second.state).not.toBe('destroyed');
    expect(of(ev, 'critical')).toHaveLength(1);
    expect(h2 - ehp(second)).toBeGreaterThan(0); // ordinary beam damage, once (the beam's hit set)
    expect(of(ev, 'struck').filter((e) => e.hostile === second.id)).toHaveLength(1);
  });
});

describe('the AI release path', () => {
  it('19b · a capital ship releasing its sweep beam draws once and the beam carries that one decision', () => {
    const r = setup({ fight: true, seed: 6 });
    const c = foe(r, 'capital', 0, -260);
    c.target = 'player';
    c.shield = 0;
    c.hull = c.maxHull * 0.25; // below its phase-two threshold: the AI turns on the sweep beam itself
    const cx = c.x;
    const cy = c.y;
    let checked = false;
    for (let t = 0; t < 2400 && !checked; t++) {
      pin(c, cx, cy);
      const rolls = r.crit.rolls;
      const ev = step(r, 1);
      r.invuln = 1e9;
      if (of(ev, 'enemyFired').some((e) => e.weapon === 'beam')) {
        expect(c.beam).not.toBeNull();
        expect('crit' in c.beam!).toBe(true);
        expect(r.crit.rolls - rolls).toBe(of(ev, 'enemyFired').filter((e) => e.weapon !== 'launch').length); // one draw per weapon release this tick
        const token = c.beam!.crit;
        step(r, 5);
        if (c.beam) expect(c.beam.crit).toBe(token); // retained for the firing's life, never re-rolled per tick
        checked = true;
      }
    }
    expect(checked).toBe(true);
    expect(c.phase2).toBe(true);
  });
});

describe('fleet escorts', () => {
  function wing(mode: CritMode): SectorRun {
    const r = setup({ mode, fight: true });
    r.invuln = 1e9;
    Kit.deploy(r, Kit, [spec('fv-1', 'shrike', 'maren-sato')], RUN.heat);
    return r;
  }

  it('20 · a critical on an escort disables it (never destroys or frees it): owned, crewed, out until a dock', () => {
    const r = wing('crit');
    const u = r.wing!.units[0]!;
    Object.assign(u.ship, { x: r.ship.x + 120, y: r.ship.y, vx: 0, vy: 0 });
    const a = foe(r, 'raider', 120, -200);
    quiet(a);
    spawnShot(r, a, 'spark', Math.atan2(u.ship.y - a.y, u.ship.x - a.x), 0, null, rollCritical(r));
    const ev: SectorEvent[] = [];
    for (let i = 0; i < 60 && u.state === 'active'; i++) {
      Object.assign(u.ship, { x: r.ship.x + 120, y: r.ship.y, vx: 0, vy: 0 });
      ev.push(...step(r, 1, NONE, [a]));
    }
    expect(u.state).toBe('disabled');
    expect(r.wing!.units).toContain(u);
    expect(u.spec.captain).toBe('maren-sato');
    // (the escort may also land a critical of its own on the raider: forced mode applies to every firing)
    expect(of(ev, 'critical').filter((e) => e.victim === 'escort')).toEqual([expect.objectContaining({ victim: 'escort', by: 'npc', what: 'fv-1' })]);
    expect(of(ev, 'fleet').filter((e) => e.change === 'disabled')).toHaveLength(1);
    expect(ev.findIndex((e) => e.type === 'critical')).toBeLessThan(ev.findIndex((e) => e.type === 'fleet')); // logged before the disabled line
  });

  it('21 · an escort critical on a hostile counts for the pilot exactly once (kill, heat) through damageAgent', () => {
    const r = wing('crit');
    Kit.issueOrder(r, 'all', { kind: 'defend' });
    const a = foe(r, 'heavy', 0, -260);
    quiet(a);
    r.silent = false;
    const heat0 = heatOf(r.factionHeat, 'red-tally');
    const ev: SectorEvent[] = [];
    for (let i = 0; i < 400 && a.state !== 'destroyed'; i++) ev.push(...step(r, 1, NONE, [a]));
    expect(a.state).toBe('destroyed');
    expect(of(ev, 'destroyed').filter((e) => e.hostile === a.id)).toHaveLength(1);
    expect(r.kills).toBe(1);
    expect(of(ev, 'critical')).toEqual([expect.objectContaining({ victim: 'hostile', by: 'player', what: 'heavy' })]);
    expect(heatOf(r.factionHeat, 'red-tally') - heat0).toBe(HEAT.hit + HEAT.kill);
  });
});

describe('idempotence, eligibility and persistence', () => {
  it('22 · a destroyed ship cannot be destroyed again; the environment never lands a critical', () => {
    const r = setup();
    const a = foe(r, 'heavy', 0, -300);
    const ev: SectorEvent[] = [];
    expect(damageAgent(r, a, 1, 'player', ev, r.ship, true)).toBe(true);
    expect(damageAgent(r, a, 1, 'player', ev, r.ship, true)).toBe(false);
    expect(of(ev, 'destroyed')).toHaveLength(1);
    expect(of(ev, 'critical')).toHaveLength(1);
    expect(r.kills).toBe(1);
    const b = foe(r, 'heavy', 0, -500);
    const hb = ehp(b);
    damageAgent(r, b, 2, 'environment', ev, r.ship, true);
    expect(b.state).not.toBe('destroyed');
    expect(hb - ehp(b)).toBeCloseTo(2, 6);
    // a hazard on the pilot is never critical either (only weapon fire reaches damagePlayer with a critical)
    const hull = r.hull;
    r.invuln = 0;
    damagePlayer(r, 1, 'hazard', ev);
    expect(r.hull).toBeGreaterThan(hull - 2);
  });

  it('23 · nothing is saved: a new visit starts AUTO with fresh counters; no critical field reaches the sector save', () => {
    const r = setup({ mode: 'crit' });
    shoot(r, [foe(r, 'heavy', 0, -140)]);
    expect(r.crit.landed).toBe(1);
    const again = setup();
    expect(again.crit).toMatchObject({ mode: 'auto', rolls: 0, rolled: 0, landed: 0, last: [] });
    expect(forceCritical(again, 'always')).toBe(false);
    expect(again.crit.mode).toBe('auto');
    expect(JSON.stringify(EMPTY_SECTOR_SAVE)).not.toContain('crit');
  });

  it('24 · the balance consequence is measured, not hidden: with criticals on, fights end faster and group fights can be lost', () => {
    const duel = (seed: number, mode: CritMode): { won: boolean; secs: number; pilotCrit: boolean } => {
      const L = arena(2);
      const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed });
      forceCritical(r, mode);
      r.grace = 0;
      const cx = L.width / 2;
      const cy = L.height / 2;
      Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0 });
      (['picket', 'lancer', 'recon'] as const).forEach((f, i) => spawnAgent(r, f, 'red-tally', 'balance', 'guard', cx + Math.cos((i / 3) * Math.PI * 2) * 450, cy + Math.sin((i / 3) * Math.PI * 2) * 450));
      let pilotCrit = false;
      let t = 0;
      for (; t < 60 * 90; t++) {
        const live = r.hostiles.filter((h) => h.hull > 0);
        if (!live.length) break;
        const s = r.ship;
        const h = live.reduce((b, x) => (Math.hypot(x.x - s.x, x.y - s.y) < Math.hypot(b.x - s.x, b.y - s.y) ? x : b));
        const ev = stepSector(r, attackInput(r, h));
        if (ev.some((e) => e.type === 'critical' && e.victim === 'player')) pilotCrit = true;
        if (ev.some((e) => e.type === 'recalled')) return { won: false, secs: t / 60, pilotCrit };
      }
      return { won: r.hostiles.every((h) => h.hull <= 0), secs: t / 60, pilotCrit };
    };
    const seeds = Array.from({ length: 16 }, (_, i) => 200 + i);
    const on = seeds.map((s) => duel(s, 'auto'));
    const off = seeds.map((s) => duel(s, 'normal'));
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(off.every((x) => x.won)).toBe(true); // the ordinary envelope (balance.test.ts) still holds
    expect(on.some((x) => !x.won && x.pilotCrit)).toBe(true); // a hostile critical can end the pilot's fight
    expect(on.some((x) => x.won)).toBe(true);
    expect(mean(on.map((x) => x.secs))).toBeLessThan(mean(off.map((x) => x.secs))); // pilot criticals end fights sooner
    for (const x of on) if (!x.won) expect(x.pilotCrit || x.secs >= 89).toBe(true); // every loss is explained by a critical
  });
});
