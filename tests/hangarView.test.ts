/**
 * P03A production hangar (FR-TD-87): the pure view model (ships/hangarView.ts)
 * and the selection / persistence contract the hangar page relies on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { UnlockRequirement } from '../src/modes/freeroam/catalogue/types.ts';
import { MISSILE } from '../src/modes/freeroam/combat/playerMissile.ts';
import { EMPTY_PROFILE, loadProfile, saveProfile, withFleet } from '../src/modes/freeroam/profile.ts';
import { deriveStats, EQUIPMENT_BY_ID } from '../src/modes/freeroam/ships/equipment.ts';
import { acquireShip, barFill, fleetFromSaved, fleetToSaved, loadoutOf, selectShip, STARTER_FLEET, type FleetState } from '../src/modes/freeroam/ships/hangar.ts';
import {
  catalogue,
  compareTargets,
  defaultCompare,
  filterCounts,
  HANGAR_FILTERS,
  HANGAR_SORTS,
  isOwnedStatus,
  matchesFilter,
  nextCompare,
  nextSort,
  pilotSkill,
  resolveCompare,
  shipAsFlown,
  statRows,
  statusOf,
  weaponSummary,
  yardHighlights,
  type HangarContext,
  type HangarSort,
} from '../src/modes/freeroam/ships/hangarView.ts';
import { SHIP_BY_ID, SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import { SHIP_IDS, type ShipId } from '../src/modes/freeroam/ships/types.ts';
import { upgradedShip, type UpgradeLevels } from '../src/modes/freeroam/ships/upgrades.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

/** The pilot of the browser harness: one survey done (Swift and Magpie licensed), a small hold. */
const oneSurvey = (req: UnlockRequirement): boolean => req.kind === 'surveys' && req.count <= 1;
const ctxOf = (fleet: FleetState = STARTER_FLEET, cargo: Record<string, number> = { scrap: 14, fuel: 6, ice: 3 }, levels: Partial<Record<ShipId, UpgradeLevels>> = {}): HangarContext => ({
  fleet,
  cargo,
  licenceMet: oneSurvey,
  levels: (id) => levels[id] ?? {},
});
const two: FleetState = { active: 'petrel', owned: ['petrel', 'swift'], loadouts: {} };
const three: FleetState = { active: 'swift', owned: ['petrel', 'swift', 'magpie'], loadouts: {} };

describe('hangar catalogue (ships/hangarView.ts)', () => {
  it('lists exactly the real roster in yard order: no invented or missing ships', () => {
    expect(catalogue(ctxOf(), 'all', 'roster')).toEqual([...SHIP_IDS]);
    expect(SHIPS.map((s) => s.id)).toEqual([...SHIP_IDS]);
  });

  it('filters by real ownership and licence state; every ship lands in exactly one of owned / for sale / locked', () => {
    const c = ctxOf();
    expect(filterCounts(c)).toEqual({ all: 6, owned: 1, forSale: 2, locked: 3 });
    expect(catalogue(c, 'owned', 'roster')).toEqual(['petrel']);
    expect(catalogue(c, 'forSale', 'roster')).toEqual(['swift', 'magpie']); // Swift affordable, Magpie needs cargo
    expect(catalogue(c, 'locked', 'roster')).toEqual(['shrike', 'condor', 'albatross']);
    for (const s of SHIPS) {
      const st = statusOf(c, s.id);
      expect(HANGAR_FILTERS.filter((f) => f !== 'all' && matchesFilter(st, f))).toHaveLength(1);
    }
    expect(filterCounts(ctxOf(three)).owned).toBe(3);
  });

  it('sorts only by data that exists; sorting never adds, drops or duplicates a ship', () => {
    const c = ctxOf();
    for (const s of HANGAR_SORTS) expect([...catalogue(c, 'all', s)].sort()).toEqual([...SHIP_IDS].sort());
    const speed = catalogue(c, 'all', 'maxSpeed');
    expect(speed[0]).toBe('swift');
    const speeds = speed.map((id) => shipAsFlown(c, id).stats.maxSpeed);
    expect([...speeds].sort((a, b) => b - a)).toEqual(speeds);
    expect(catalogue(c, 'all', 'hull')[0]).toBe('condor');
    expect(catalogue(c, 'all', 'cargo')[0]).toBe('magpie');
    expect(catalogue(c, 'all', 'sensor')[0]).toBe('albatross');
    const roles = catalogue(c, 'all', 'class').map((id) => SHIP_BY_ID.get(id)!.role);
    expect([...roles].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(roles);
    // the sort cycle visits every option and comes back
    let s: HangarSort = HANGAR_SORTS[0];
    for (let i = 0; i < HANGAR_SORTS.length; i++) s = nextSort(s);
    expect(s).toBe(HANGAR_SORTS[0]);
  });
});

describe('hangar stats are the stats the ship flies with', () => {
  it('owned ships include their fitted loadout and installed upgrades (the same derivation as the flown craft)', () => {
    const levels: UpgradeLevels = { hull: 2, engines: 1 };
    const fitted: FleetState = { ...two, loadouts: { petrel: { weapon: ['twin-pulse'], shield: ['deflector'], engine: ['ion-drive'], sensor: ['survey-scanner'], cargo: ['cargo-pod'] } } };
    const c = ctxOf(fitted, {}, { petrel: levels });
    expect(shipAsFlown(c, 'petrel')).toEqual(upgradedShip('petrel', loadoutOf(fitted, 'petrel'), levels));
    // upgrades change the shown numbers (the old hangar ignored them)
    const plain = deriveStats(SHIP_BY_ID.get('petrel')!, loadoutOf(fitted, 'petrel'));
    expect(shipAsFlown(c, 'petrel').stats.hull).toBeGreaterThan(plain.hull);
    expect(statRows(c, 'petrel', null).find((r) => r.key === 'hull')!.value).toBe(shipAsFlown(c, 'petrel').stats.hull);
    // the fitted weapon drives the armament numbers
    expect(shipAsFlown(c, 'petrel').weapon.bolts).toBe(2);
  });

  it('unowned ships show their stock fit', () => {
    const c = ctxOf();
    expect(shipAsFlown(c, 'condor').stats).toEqual(deriveStats(SHIP_BY_ID.get('condor')!, SHIP_BY_ID.get('condor')!.stock));
  });

  it('weapon numbers are derived from the weapon profile, not written by hand', () => {
    const pulse = EQUIPMENT_BY_ID.get('pulse-cannon')!;
    const twin = EQUIPMENT_BY_ID.get('twin-pulse')!;
    if (pulse.slot !== 'weapon' || twin.slot !== 'weapon') throw new Error('weapons expected');
    const p = weaponSummary(pulse.weapon);
    expect(p.volleysPerSecond).toBeCloseTo(60 / 9);
    expect(p.output).toBeCloseTo(60 / 9);
    expect(p.reach).toBeCloseTo((640 * 54) / 60);
    expect(weaponSummary(twin.weapon).output).toBeCloseTo((60 / 10) * 2);
  });

  it('the pilot missile line uses the P03 constants (same on every ship); launches per bar follow the energy capacity', () => {
    const m = pilotSkill(MISSILE, 100);
    expect(m).toEqual({ damage: MISSILE.damage, lockSeconds: MISSILE.lockTicks / 60, cooldownSeconds: MISSILE.cooldownTicks / 60, energyCost: MISSILE.energy, range: MISSILE.range, perFullEnergy: Math.floor(100 / MISSILE.energy) });
    expect(m.lockSeconds).toBeCloseTo(0.3);
    expect(pilotSkill(MISSILE, 140).perFullEnergy).toBe(Math.floor(140 / MISSILE.energy));
  });
});

describe('hangar highlights come from the roster', () => {
  it('each highlight names the single best stock value in the yard (recomputed here independently)', () => {
    const stock = SHIPS.map((s) => ({ id: s.id, st: deriveStats(s, s.stock) }));
    const bestBy = (k: 'maxSpeed' | 'hull' | 'cargo' | 'sensor') => stock.reduce((a, b) => (b.st[k] > a.st[k] ? b : a)).id;
    expect(yardHighlights(bestBy('maxSpeed')).map((h) => h.key)).toContain('maxSpeed');
    expect(yardHighlights(bestBy('hull')).map((h) => h.key)).toContain('hull');
    expect(yardHighlights(bestBy('cargo')).map((h) => h.key)).toContain('cargo');
    expect(yardHighlights(bestBy('sensor')).map((h) => h.key)).toContain('sensor');
    // a stat best is claimed by one ship only
    for (const k of ['maxSpeed', 'hull', 'cargo', 'sensor', 'travel', 'turnRate'] as const) expect(SHIPS.filter((s) => yardHighlights(s.id).some((h) => h.key === k)).length).toBeLessThanOrEqual(1);
  });

  it('every ship has at least one true highlight (current roster)', () => {
    expect(yardHighlights('petrel')[0]!.key).toBe('starter');
    expect(yardHighlights('swift').map((h) => h.short)).toContain('FASTEST');
    expect(yardHighlights('shrike').map((h) => h.key)).toContain('output');
    expect(yardHighlights('condor').map((h) => h.key)).toEqual(expect.arrayContaining(['hull', 'class-heavy']));
    expect(yardHighlights('magpie').map((h) => h.key)).toContain('cargo');
    expect(yardHighlights('albatross').map((h) => h.key)).toEqual(expect.arrayContaining(['sensor', 'travel']));
    for (const s of SHIPS) expect(yardHighlights(s.id).length).toBeGreaterThan(0);
  });
});

describe('hangar comparison', () => {
  it('compares with owned ships only: the flown ship by default, none when inspecting it', () => {
    const c = ctxOf(three);
    expect(defaultCompare(c, 'petrel')).toBe('swift');
    expect(defaultCompare(c, 'swift')).toBeNull();
    expect(compareTargets(c, 'magpie')).toEqual(['swift', 'petrel']);
    expect(compareTargets(c, 'condor')).not.toContain('condor');
    for (const id of SHIP_IDS) for (const t of compareTargets(c, id)) expect(three.owned).toContain(t);
  });

  it('a chosen comparison stays while valid; an unowned or self choice falls back; cycling ends at none and wraps', () => {
    const c = ctxOf(three);
    expect(resolveCompare(c, 'magpie', 'petrel')).toBe('petrel');
    expect(resolveCompare(c, 'magpie', 'condor')).toBe('swift'); // not owned -> default
    expect(resolveCompare(c, 'magpie', 'magpie')).toBe('swift');
    expect(resolveCompare(c, 'magpie', null)).toBeNull();
    expect(nextCompare(c, 'magpie', 'swift')).toBe('petrel');
    expect(nextCompare(c, 'magpie', 'petrel')).toBeNull();
    expect(nextCompare(c, 'magpie', null)).toBe('swift');
  });

  it('rows put both ships on the same scale and mark better / worse (drive charge: lower is better)', () => {
    const c = ctxOf(two);
    const rows = statRows(c, 'swift', 'petrel');
    expect(rows).toHaveLength(9);
    const row = (k: string) => rows.find((r) => r.key === k)!;
    expect(row('maxSpeed').delta).toBe(1);
    expect(row('hull').delta).toBe(-1);
    expect(row('travel').delta).toBe(1); // 0.9 x drive charge vs 1.0
    for (const r of rows) {
      expect(r.fill).toBe(barFill(r.key, r.value));
      expect(r.otherFill).toBe(barFill(r.key, r.other!));
      expect(r.fill).toBeGreaterThan(0);
      expect(r.fill).toBeLessThanOrEqual(1);
    }
    for (const r of statRows(c, 'swift', null)) expect([r.delta, r.other, r.otherFill]).toEqual([0, null, null]);
  });
});

describe('hangar selection rules (unchanged, checked against every catalogue state)', () => {
  it('no locked or unowned ship can be selected, whatever the panel shows; acquiring never selects', () => {
    const c = ctxOf(STARTER_FLEET, { scrap: 100, fuel: 100, ice: 100, alloy: 100, crystal: 100 });
    for (const id of SHIP_IDS) {
      const st = statusOf(c, id);
      if (isOwnedStatus(st)) continue;
      expect(selectShip(c.fleet, id, true)).toEqual({ ok: false, reason: 'not-owned' });
      if (st === 'locked') expect(acquireShip(c.fleet, c.cargo, id, c.licenceMet)).toEqual({ ok: false, reason: 'locked' });
    }
    const bought = acquireShip(c.fleet, c.cargo, 'swift', c.licenceMet);
    expect(bought.ok && bought.fleet.active).toBe('petrel');
  });

  it('a confirmed selection persists through the profile and is restored; a tampered selection falls back safely', () => {
    const store = new MemoryStore();
    const sel = selectShip(two, 'swift', true);
    expect(sel.ok).toBe(true);
    if (!sel.ok) return;
    saveProfile(store, withFleet(EMPTY_PROFILE, fleetToSaved(sel.fleet)));
    const back = loadProfile(store);
    expect(back.status).toBe('ok');
    expect(fleetFromSaved(back.data.fleet).active).toBe('swift');
    // an edited save naming a ship the pilot does not own (or no ship at all) flies the starter
    expect(fleetFromSaved({ active: 'condor', owned: ['petrel', 'swift'], loadouts: {} }).active).toBe('petrel');
    expect(fleetFromSaved({ active: 'nonexistent', owned: ['petrel'], loadouts: {} }).active).toBe('petrel');
  });
});

describe('hangar module boundaries', () => {
  const src = (f: string) => readFileSync(new URL(`../src/modes/freeroam/ships/${f}`, import.meta.url), 'utf8');

  it('the view model is pure: no DOM, clock, randomness, storage or network', () => {
    expect(src('hangarView.ts')).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|sessionStorage|fetch|requestAnimationFrame)\b/);
  });

  it('the panel owns no loop or timer and no global listener (the shell frame loop drives the preview; nothing to leak)', () => {
    const panel = src('hangarPanel.ts');
    expect(panel).not.toMatch(/\b(requestAnimationFrame|setInterval|setTimeout|ResizeObserver|localStorage|sessionStorage)\b/);
    expect(panel).not.toMatch(/\b(window|document)\.addEventListener/);
    // it never writes the fleet itself: every change goes through the shell's commit callbacks
    expect(panel).not.toMatch(/withFleet|saveProfile/);
  });

  it('the shell drives the preview only while the hangar is the open panel', () => {
    const shell = readFileSync(new URL('../src/modes/freeroam/freeRoamMode.ts', import.meta.url), 'utf8');
    expect(shell).toMatch(/if \(panel === 'hangar'\) hangar\.frame\(ts\)/);
    expect(shell).toMatch(/levels: \(id\) => levelsOf\(id\)/);
  });
});
