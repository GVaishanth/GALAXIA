/**
 * Free Roam Prompt 8: ships, equipment, hangar and their effect on flight.
 * Deterministic (seeded) and offline.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPRITES } from '../src/assets/sprites/index.ts';
import { FLEET_FLAME_ROWS, FLEET_SPRITES } from '../src/assets/sprites/fleet.ts';
import { expandFrame } from '../src/assets/sprites/format/grid.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import type { UnlockRequirement } from '../src/modes/freeroam/catalogue/types.ts';
import { DEFAULT_BINDINGS, sanitizeBindings } from '../src/modes/freeroam/bindings.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { deriveView, progressFromSaved } from '../src/modes/freeroam/galaxy/progress.ts';
import { EMPTY_PROFILE, FREEROAM_SPEC, loadProfile, saveProfile, STARTER_SHIP_ID, withCargo, withFleet } from '../src/modes/freeroam/profile.ts';
import { loadFreeRoamPrefs } from '../src/modes/freeroam/saveSlots.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE, type Poi, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { noseOf } from '../src/modes/freeroam/sim.ts';
import { applyShip, canSwitchShip, createSectorRun, inCombat, interact, RUN, shipTuning, stepSector, type SectorEvent, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import type { EncounterRuntime } from '../src/modes/freeroam/combat/state.ts';

/** A live outpost encounter (combat engaged) for the docking rules. */
const liveEncounter = (): EncounterRuntime => ({ id: 'installation-1', kind: 'outpost', state: 'active', ticks: 0, waves: 1, spawned: 2, holdLeft: 100, integrity: 0, engaged: false, awake: true });
import {
  canFit,
  deriveShip,
  deriveStats,
  EQUIPMENT,
  EQUIPMENT_BY_ID,
  FALLBACK_WEAPON,
  fitItem,
  isValidLoadout,
  loadoutIssues,
  modifiersValid,
  MODULE_MUL_RANGE,
  STAT_BOUNDS,
} from '../src/modes/freeroam/ships/equipment.ts';
import { acquireShip, cargoUsed, compareStats, fleetFromSaved, fleetToSaved, loadoutOf, missingFor, selectShip, shipStatus, STARTER_FLEET } from '../src/modes/freeroam/ships/hangar.ts';
import { SHIP_BY_ID, SHIPS, STARTER_SHIP } from '../src/modes/freeroam/ships/roster.ts';
import { SHIP_IDS, SLOT_TYPES, STAT_KEYS, type EquipmentItem, type Loadout, type ShipId, type ShipStats } from '../src/modes/freeroam/ships/types.ts';
import { createRng } from '../src/core/rng.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const catalogue = getCatalogue();
const graph = buildNavGraph();
const sys = (id: string) => catalogue.systems.find((s) => s.id === id)!;
const gen = (id: string): SectorLayout => generateSector(sys(id), sectorContext(graph, id));
const SOL = gen('milky-way/sol');

/** An empty copy of a sector: no landmarks, regions, rocks or patrols; only the given POIs. */
function open(L: SectorLayout, pois: readonly Poi[] = [], rocks: SectorLayout['rocks'] = []): SectorLayout {
  return { ...L, landmarks: [], regions: [], rocks, patrols: [], pois };
}
const poiLike = (kind: Poi['kind'], over: Partial<Poi>): Poi => ({ ...SOL.pois.find((p) => p.kind === kind)!, ...over }) as Poi;
/** A run in a test layout. The save is "surveyed": a sector with no marks left would complete at once and stop stepping. */
const runFor = (ship: ShipId, L: SectorLayout = open(SOL), extra: Partial<Parameters<typeof createSectorRun>[2]> = {}): SectorRun =>
  createSectorRun(L, { done: [], surveyed: true }, { seed: 3, ship: deriveShip(ship), ...extra });
const mid = (L: SectorLayout) => ({ x: L.width / 2, y: L.height / 2 });
const place = (r: SectorRun, x: number, y: number): void => {
  r.ship.x = r.ship.px = x;
  r.ship.y = r.ship.py = y;
  r.ship.vx = r.ship.vy = 0;
};
const speed = (r: SectorRun): number => Math.hypot(r.ship.vx, r.ship.vy);
const allMet = (): boolean => true;

/* ------------------------------------------------------------------ roster */

describe('ship roster (ships/roster.ts)', () => {
  it('has at least six ships with six distinct archetypes, unique ids and sprites, and a starter', () => {
    expect(SHIPS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(SHIPS.map((s) => s.archetype)).size).toBe(6);
    expect(new Set(SHIPS.map((s) => s.id)).size).toBe(SHIPS.length);
    expect(new Set(SHIPS.map((s) => s.sprite)).size).toBe(SHIPS.length);
    expect(SHIPS.map((s) => s.id).sort()).toEqual([...SHIP_IDS].sort());
    expect(STARTER_SHIP).toBe('petrel');
    expect(STARTER_SHIP_ID).toBe(STARTER_SHIP); // the profile's copy (main bundle) matches the roster
    const starter = SHIP_BY_ID.get(STARTER_SHIP)!;
    expect(starter.licence).toEqual([]);
    expect(starter.cost).toEqual([]);
    for (const s of SHIPS) if (s.id !== STARTER_SHIP) {
      expect(s.licence.length).toBeGreaterThan(0);
      expect(s.cost.length).toBeGreaterThan(0);
    }
  });

  it('every stock loadout is valid and every derived stat is finite and inside its bounds', () => {
    for (const s of SHIPS) {
      expect(loadoutIssues(s, s.stock)).toEqual([]);
      const st = deriveStats(s, s.stock);
      for (const k of STAT_KEYS) {
        expect(Number.isFinite(st[k])).toBe(true);
        expect(st[k]).toBeGreaterThanOrEqual(STAT_BOUNDS[k][0]);
        expect(st[k]).toBeLessThanOrEqual(STAT_BOUNDS[k][1]);
      }
      // base stats are already sane (no stat relies on the clamp)
      for (const k of STAT_KEYS) expect(s.base[k]).toBeGreaterThanOrEqual(STAT_BOUNDS[k][0]);
    }
  });

  it('roles show in the numbers, not only in names (stock loadouts)', () => {
    const st = new Map(SHIPS.map((s) => [s.id, deriveStats(s, s.stock)] as const));
    const best = (k: keyof ShipStats, hi = true): ShipId => [...st.entries()].sort((a, b) => (hi ? b[1][k] - a[1][k] : a[1][k] - b[1][k]))[0]![0];
    expect(best('maxSpeed')).toBe('swift');
    expect(best('turnRate')).toBe('swift');
    expect(best('accel')).toBe('swift');
    expect(best('hull')).toBe('condor');
    expect(best('shield')).toBe('condor');
    expect(best('cargo')).toBe('magpie');
    expect(best('sensor')).toBe('albatross');
    expect(best('travel', false)).toBe('albatross');
    expect(best('energy')).toBe('albatross');
    // the interceptor has the highest sustained damage (twin bolts)
    const dps = (id: ShipId): number => {
      const w = deriveShip(id).weapon;
      return (w.damage * w.bolts) / w.cooldownTicks;
    };
    for (const s of SHIPS) if (s.id !== 'shrike') expect(dps('shrike')).toBeGreaterThan(dps(s.id));
    // the explorer is balanced: never the best or the worst at anything compared
    const petrel = st.get('petrel')!;
    for (const k of ['hull', 'shield', 'maxSpeed', 'accel', 'turnRate', 'energy', 'sensor', 'travel'] as const) {
      const vals = [...st.values()].map((x) => x[k]);
      expect(petrel[k]).toBeGreaterThan(Math.min(...vals));
      expect(petrel[k]).toBeLessThan(Math.max(...vals));
    }
  });

  it('the condor is the only ship with a heavy hardpoint; weapon classes match the stock weapons', () => {
    for (const s of SHIPS) {
      const w = EQUIPMENT_BY_ID.get(s.stock.weapon[0]!)!;
      expect(w.slot).toBe('weapon');
      if (w.slot === 'weapon') expect(s.weaponClasses).toContain(w.weaponClass);
    }
    expect(SHIPS.filter((s) => s.weaponClasses.includes('heavy')).map((s) => s.id)).toEqual(['condor']);
  });
});

/* ---------------------------------------------------------------- sprites */

/** Hull pixels of a ship sprite (idle frame without the flame rows) as a set of "x,y" after centring. */
function hullMask(id: string): { w: number; h: number; px: Set<string> } {
  const def = SPRITES[id as keyof typeof SPRITES] as unknown as { states: { idle: readonly { rows: readonly string[]; symmetry: 'none' | 'mirror-x' }[] } };
  const f = expandFrame(def.states.idle[0]! as Parameters<typeof expandFrame>[0]);
  const rows = f.rows.slice(FLEET_FLAME_ROWS, f.rows.length - FLEET_FLAME_ROWS);
  let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
  rows.forEach((r, y) => [...r].forEach((c, x) => {
    if (c !== '.') {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }));
  const px = new Set<string>();
  rows.forEach((r, y) => [...r].forEach((c, x) => {
    if (c !== '.') px.add(`${x - (x0 + x1) / 2},${y - (y0 + y1) / 2}`);
  }));
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, px };
}

describe('ship art (assets/sprites/fleet.ts)', () => {
  it('every ship sprite has idle, engine and boost states and a hull no larger than 32x32', () => {
    for (const s of SHIPS) {
      const def = SPRITES[s.sprite];
      expect(Object.keys(def.states).sort()).toEqual(['boost', 'idle', 'thrust']);
      const m = hullMask(s.sprite);
      expect(m.w).toBeLessThanOrEqual(32);
      expect(m.h).toBeLessThanOrEqual(32);
    }
    expect(FLEET_SPRITES.length).toBe(SHIPS.length);
    expect(SPRITES['fx.shield.impact']).toBeDefined();
    expect(SPRITES['fx.shield.impact'].states.flare.length).toBe(3);
  });

  it('silhouettes differ in shape, not only colour: every pair differs in over 25% of hull pixels', () => {
    const masks = SHIPS.map((s) => [s.id, hullMask(s.sprite)] as const);
    for (let i = 0; i < masks.length; i++) for (let j = i + 1; j < masks.length; j++) {
      const a = masks[i]![1].px;
      const b = masks[j]![1].px;
      let same = 0;
      for (const p of a) if (b.has(p)) same++;
      const union = a.size + b.size - same;
      expect(1 - same / union, `${masks[i]![0]} vs ${masks[j]![0]}`).toBeGreaterThan(0.25);
    }
  });

  it('collision radius fits the drawn hull (between 40% and 65% of its long side, at least 40% of the short side)', () => {
    for (const s of SHIPS) {
      const m = hullMask(s.sprite);
      expect(s.radius, s.id).toBeGreaterThanOrEqual(0.4 * Math.max(m.w, m.h));
      expect(s.radius, s.id).toBeLessThanOrEqual(0.65 * Math.max(m.w, m.h));
      expect(s.radius, s.id).toBeGreaterThanOrEqual(0.4 * Math.min(m.w, m.h));
      expect(deriveShip(s.id).radius).toBe(s.radius);
    }
  });
});

/* -------------------------------------------------------------- equipment */

describe('equipment foundations (ships/equipment.ts)', () => {
  it('every module has valid modifiers (finite, multipliers in range) and weapons a sane profile', () => {
    for (const e of EQUIPMENT) {
      expect(modifiersValid(e), e.id).toBe(true);
      if (e.slot === 'weapon') {
        expect(e.weapon.cooldownTicks).toBeGreaterThan(0);
        expect(e.weapon.damage).toBeGreaterThan(0);
        expect([1, 2]).toContain(e.weapon.bolts);
      }
    }
    const bad = (mods: EquipmentItem['mods']): EquipmentItem => ({ id: 'bad', name: 'Bad', description: '', slot: 'engine', mods });
    expect(modifiersValid(bad({ mul: { maxSpeed: MODULE_MUL_RANGE[1] + 0.01 } }))).toBe(false);
    expect(modifiersValid(bad({ mul: { maxSpeed: 0 } }))).toBe(false);
    expect(modifiersValid(bad({ add: { hull: Number.NaN } }))).toBe(false);
    expect(modifiersValid(bad({ add: { hull: Infinity } }))).toBe(false);
  });

  it('compatibility: slot type, slot count and weapon class are enforced', () => {
    const swift = SHIP_BY_ID.get('swift')!;
    const condor = SHIP_BY_ID.get('condor')!;
    expect(canFit(condor, condor.stock, 'lance-driver', 0)).toBe(true);
    expect(canFit(swift, swift.stock, 'lance-driver', 0)).toBe(false); // heavy on a light-only hardpoint
    expect(canFit(swift, swift.stock, 'twin-pulse', 0)).toBe(false); // medium
    expect(canFit(swift, swift.stock, 'cargo-pod', 0)).toBe(false); // the Swift has no cargo slot
    expect(canFit(swift, swift.stock, 'needle-repeater', 1)).toBe(false); // only one weapon slot
    expect(canFit(swift, swift.stock, 'no-such-module', 0)).toBe(false);
    const issues = (l: Partial<Loadout>) => loadoutIssues(swift, { ...swift.stock, ...l }).map((x) => x.code).sort();
    expect(issues({ weapon: [] })).toContain('no-weapon');
    expect(issues({ weapon: ['lance-driver'] })).toContain('weapon-class');
    expect(issues({ cargo: ['cargo-pod'] })).toContain('too-many');
    expect(issues({ engine: ['ghost-drive'] })).toContain('unknown-item');
    expect(issues({ shield: ['ion-drive'] })).toContain('wrong-slot');
    expect(isValidLoadout(swift, fitItem(swift.stock, 'weapon', 0, 'lance-driver'))).toBe(false);
  });

  it('an invalid loadout can never reach flight: deriveShip falls back to the stock loadout', () => {
    const swift = SHIP_BY_ID.get('swift')!;
    const bad: Loadout = { ...swift.stock, weapon: ['lance-driver'], cargo: ['cargo-pod', 'cargo-pod'] };
    expect(deriveShip('swift', bad)).toEqual(deriveShip('swift'));
    const noWeapon: Loadout = { ...swift.stock, weapon: [] };
    expect(deriveShip('swift', noWeapon).weapon).toEqual(deriveShip('swift').weapon);
    expect(FALLBACK_WEAPON).toEqual(EQUIPMENT_BY_ID.get('pulse-cannon')!.slot === 'weapon' ? (EQUIPMENT_BY_ID.get('pulse-cannon') as Extract<EquipmentItem, { slot: 'weapon' }>).weapon : null);
  });

  it('no combination of compatible modules produces an invalid stat (2,400 seeded random loadouts + every single fit)', () => {
    const rng = createRng(0x5eed);
    const bySlot = new Map(SLOT_TYPES.map((t) => [t, EQUIPMENT.filter((e) => e.slot === t)] as const));
    const check = (id: ShipId, l: Loadout): void => {
      const d = deriveShip(id, l);
      for (const k of STAT_KEYS) {
        expect(Number.isFinite(d.stats[k])).toBe(true);
        expect(d.stats[k]).toBeGreaterThanOrEqual(STAT_BOUNDS[k][0]);
        expect(d.stats[k]).toBeLessThanOrEqual(STAT_BOUNDS[k][1]);
      }
      expect(d.weapon.cooldownTicks).toBeGreaterThan(0);
    };
    for (const s of SHIPS) {
      // every single module in every slot index (valid or not)
      for (const t of SLOT_TYPES) for (let i = 0; i < 3; i++) for (const e of EQUIPMENT) check(s.id, fitItem(s.stock, t, i, e.id));
      for (let n = 0; n < 400; n++) {
        const l = {} as Record<(typeof SLOT_TYPES)[number], string[]>;
        for (const t of SLOT_TYPES) {
          const items = bySlot.get(t)!;
          const count = Math.floor(rng.next() * (s.slots[t] + 2)); // sometimes too many
          l[t] = Array.from({ length: count }, () => items[Math.floor(rng.next() * items.length)]!.id);
        }
        check(s.id, l);
      }
    }
  });

  it('stacking modules is clamped to the hard bounds (deriveStats never exceeds them)', () => {
    const magpie = SHIP_BY_ID.get('magpie')!;
    const stacked: Loadout = { ...magpie.stock, cargo: ['salvage-rig', 'salvage-rig', 'salvage-rig'] };
    expect(isValidLoadout(magpie, stacked)).toBe(true);
    const st = deriveStats(magpie, stacked);
    expect(st.cargo).toBeLessThanOrEqual(STAT_BOUNDS.cargo[1]);
    expect(st.maxSpeed).toBeGreaterThanOrEqual(STAT_BOUNDS.maxSpeed[0]);
  });
});

/* ------------------------------------------------------------------ hangar */

describe('hangar rules (ships/hangar.ts)', () => {
  const rich = { scrap: 100, fuel: 100, ice: 100, alloy: 100, crystal: 100 };

  it('acquiring needs the licence and the whole price; payment and ownership happen together, once', () => {
    expect(acquireShip(STARTER_FLEET, rich, 'swift', () => false)).toEqual({ ok: false, reason: 'locked' });
    expect(acquireShip(STARTER_FLEET, { scrap: 10, fuel: 3 }, 'swift', allMet)).toEqual({ ok: false, reason: 'unaffordable' });
    expect(acquireShip(STARTER_FLEET, rich, 'petrel', allMet)).toEqual({ ok: false, reason: 'owned' });
    expect(acquireShip(STARTER_FLEET, rich, 'viper', allMet)).toEqual({ ok: false, reason: 'unknown' });
    const r = acquireShip(STARTER_FLEET, { scrap: 12, fuel: 4, ice: 1 }, 'swift', allMet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fleet.owned).toEqual(['petrel', 'swift']);
    expect(r.fleet.active).toBe('petrel'); // acquiring does not switch
    expect(r.cargo).toEqual({ scrap: 2, ice: 1 }); // fuel 4 - 4 = 0 is dropped
    expect(acquireShip(r.fleet, r.cargo, 'swift', allMet)).toEqual({ ok: false, reason: 'owned' });
  });

  it('only owned ships can be selected, and only at a safe place', () => {
    expect(selectShip(STARTER_FLEET, 'swift', true)).toEqual({ ok: false, reason: 'not-owned' });
    const owned = { ...STARTER_FLEET, owned: ['petrel', 'swift'] as ShipId[] };
    expect(selectShip(owned, 'swift', false)).toEqual({ ok: false, reason: 'unsafe' });
    expect(selectShip(owned, 'petrel', true)).toEqual({ ok: false, reason: 'active' });
    const r = selectShip(owned, 'swift', true);
    expect(r).toEqual({ ok: true, fleet: { ...owned, active: 'swift' } });
  });

  it('ship status follows ownership, licence and cargo', () => {
    const met = (req: UnlockRequirement) => req.kind === 'surveys' && req.count <= 1;
    expect(shipStatus(STARTER_FLEET, 'petrel', met, {})).toBe('active');
    expect(shipStatus(STARTER_FLEET, 'swift', met, {})).toBe('unaffordable');
    expect(shipStatus(STARTER_FLEET, 'swift', met, rich)).toBe('available');
    expect(shipStatus(STARTER_FLEET, 'shrike', met, rich)).toBe('locked');
    expect(shipStatus({ ...STARTER_FLEET, owned: ['petrel', 'swift'] }, 'swift', met, {})).toBe('owned');
    expect(missingFor(SHIP_BY_ID.get('swift')!.cost, { scrap: 4 })).toEqual([{ resource: 'scrap', amount: 6 }, { resource: 'fuel', amount: 4 }]);
    expect(cargoUsed({ scrap: 4, fuel: 3 })).toBe(7);
  });

  it('comparison rows mark better and worse against the ship flown (drive charge: lower is better)', () => {
    const rows = compareStats(STARTER_FLEET, 'albatross');
    const row = (k: string) => rows.find((r) => r.key === k)!;
    expect(row('travel').delta).toBe(1);
    expect(row('sensor').delta).toBe(1);
    expect(row('hull').delta).toBe(-1);
    expect(compareStats(STARTER_FLEET, 'petrel').every((r) => r.delta === 0)).toBe(true);
    for (const s of SHIPS) for (const r of compareStats(STARTER_FLEET, s.id)) {
      expect(r.fill).toBeGreaterThan(0);
      expect(r.fill).toBeLessThanOrEqual(1);
    }
  });

  it('a saved fleet is validated against the roster: unknown ships, unowned actives and bad loadouts fall back', () => {
    const f = fleetFromSaved({ active: 'viper', owned: ['condor', 'viper', 'swift', 'swift'], loadouts: { swift: { weapon: ['lance-driver'] }, condor: { weapon: ['twin-pulse', 'lance-driver'], shield: ['bastion-array'], engine: ['ion-drive'], sensor: ['survey-scanner'], cargo: [] }, magpie: { weapon: [] } } });
    expect(f.owned).toEqual(['petrel', 'swift', 'condor']); // the starter is always owned; roster order; no duplicates
    expect(f.active).toBe('petrel');
    expect(f.loadouts.swift).toBeUndefined(); // invalid: heavy weapon on the Swift
    expect(f.loadouts.magpie).toBeUndefined(); // not owned
    expect(loadoutOf(f, 'condor').weapon).toEqual(['twin-pulse', 'lance-driver']);
    expect(fleetFromSaved(fleetToSaved(f))).toEqual(f);
    expect(fleetFromSaved(undefined)).toEqual(STARTER_FLEET);
  });
});

/* ----------------------------------------------------------------- profile */

describe('profile v6: the fleet in galaxia:freeroam', () => {
  it('round-trips the fleet and the hold through storage', () => {
    const store = new MemoryStore();
    const fleet = { active: 'swift', owned: ['petrel', 'swift'], loadouts: { swift: { weapon: ['needle-repeater'], shield: ['deflector'], engine: ['sprint-thrusters', 'ion-drive'], sensor: ['survey-scanner'], cargo: [] } } };
    const p = withCargo(withFleet(EMPTY_PROFILE, fleet), { scrap: 3, fuel: 0, 'Bad Id': 2 });
    expect(p.cargo).toEqual({ scrap: 3 });
    saveProfile(store, p);
    const back = loadProfile(store);
    expect(back.status).toBe('ok');
    expect(back.data.fleet).toEqual(fleet);
    expect(JSON.parse(store.read('galaxia:freeroam')!).version).toBe(10);
  });

  it('migrates a v5 save to the starter fleet, keeps an over-capacity hold and adds boost to custom bindings', () => {
    const store = new MemoryStore();
    const custom = { ...DEFAULT_BINDINGS, fire: ['KeyK', null] } as Record<string, unknown>;
    delete custom['boost'];
    const { fleet: _drop, ...v5 } = EMPTY_PROFILE;
    store.write('galaxia:freeroam', JSON.stringify({ ...v5, version: 5, cargo: { scrap: 500 }, controls: { bindings: custom, mouseAim: true, zoom: 1.15 } }));
    const r = loadProfile(store);
    expect(r.status).toBe('migrated');
    expect(r.data.fleet).toEqual({ active: 'petrel', owned: ['petrel'], loadouts: {} });
    expect(r.data.cargo).toEqual({ scrap: 500 }); // above the Petrel's 80: kept, nothing lost
    // since v10 the controls live in the shared Free Roam prefs, carried over from the old record
    const c = loadFreeRoamPrefs(store).data.controls;
    expect(c.bindings.fire).toEqual(['KeyK', null]); // custom keys survive
    expect(c.bindings.boost).toEqual(['ShiftLeft', 'ShiftRight']);
    expect(c.mouseAim).toBe(true);
  });

  it('a missing boost action is filled with its free default keys and is not a repair; taken keys are skipped', () => {
    const b = { ...DEFAULT_BINDINGS, fire: ['ShiftLeft', null] } as Record<string, unknown>;
    delete b['boost'];
    const s = sanitizeBindings(b);
    expect(s.repaired).toBe(false);
    expect(s.bindings.fire).toEqual(['ShiftLeft', null]);
    expect(s.bindings.boost).toEqual(['ShiftRight', null]);
  });

  it('damaged fleet records are repaired to something valid', () => {
    const fix = (fleet: unknown) => FREEROAM_SPEC.sanitize({ ...EMPTY_PROFILE, fleet } as unknown as Record<string, unknown>);
    expect(fix('junk')).toMatchObject({ repaired: true, data: { fleet: { active: 'petrel', owned: ['petrel'] } } });
    const r = fix({ active: 'swift', owned: ['swift', 'BAD ID', 7], loadouts: { swift: { weapon: ['Bad Module'], engine: ['ion-drive'] }, condor: {} } });
    expect(r.repaired).toBe(true);
    expect(r.data.fleet.owned).toEqual(['petrel', 'swift']);
    expect(r.data.fleet.active).toBe('swift');
    expect(r.data.fleet.loadouts).toEqual({ swift: { engine: ['ion-drive'] } });
  });

  it('profile.ts (main bundle) never imports the ship modules', () => {
    const src = readFileSync(new URL('../src/modes/freeroam/profile.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '\.\/ships\//);
  });
});

/* --------------------------------------------------------- flight effects */

describe('ship stats in flight (sector/run.ts)', () => {
  it('the run flies the derived ship: tuning, shield, hull, energy and radius come from its stats', () => {
    for (const s of SHIPS) {
      const d = deriveShip(s.id);
      const r = runFor(s.id);
      expect(r.tune).toEqual(shipTuning(d));
      expect(r.tune.maxSpeed).toBe(d.stats.maxSpeed);
      expect(r.tune.radius).toBe(s.radius);
      expect(r.shield).toBe(d.stats.shield);
      expect(r.hull).toBe(d.stats.hull);
      expect(r.energy).toBe(d.stats.energy);
    }
    expect(runFor('petrel').craft.ship).toBe('petrel');
    expect(createSectorRun(open(SOL), EMPTY_SECTOR_SAVE).craft).toEqual(deriveShip('petrel')); // default = starter
  });

  it('handling differs: the Swift is faster and turns quicker than the Condor under the same input', () => {
    const fly = (id: ShipId) => {
      const L = open(SOL);
      const r = runFor(id, L);
      const m = mid(L);
      place(r, m.x - 1500, m.y);
      r.ship.heading = r.ship.pheading = -Math.PI / 2;
      let top = 0;
      let aligned = -1;
      for (let i = 0; i < 240; i++) {
        stepSector(r, { moveX: 1, moveY: 0 });
        top = Math.max(top, speed(r));
        const n = noseOf(r.ship.heading);
        const cos = (n.x * r.ship.vx + n.y * r.ship.vy) / (speed(r) || 1);
        if (aligned < 0 && speed(r) > 30 && cos > Math.cos(0.05)) aligned = i;
      }
      return { top, aligned };
    };
    const swift = fly('swift');
    const condor = fly('condor');
    expect(swift.top).toBeGreaterThan(condor.top * 1.4);
    expect(swift.top).toBeLessThanOrEqual(deriveShip('swift').stats.maxSpeed + 1e-6);
    expect(condor.top).toBeLessThanOrEqual(deriveShip('condor').stats.maxSpeed + 1e-6);
    expect(swift.aligned).toBeGreaterThanOrEqual(0);
    expect(condor.aligned).toBeGreaterThan(swift.aligned);
  });

  it('collision bounds use each ship\'s radius: a wider hull stops further from a rock', () => {
    const rest = (id: ShipId): number => {
      const L0 = open(SOL);
      const m = mid(L0);
      const rock = { x: m.x, y: m.y, r: 30, field: 'test', shape: 1 };
      const L = open(SOL, [], [rock]);
      const r = runFor(id, L);
      place(r, m.x - 200, m.y);
      for (let i = 0; i < 180; i++) stepSector(r, { moveX: 0.35, moveY: 0 });
      const d = Math.hypot(r.ship.x - rock.x, r.ship.y - rock.y);
      expect(d, id).toBeGreaterThanOrEqual(rock.r + r.tune.radius - 1e-6);
      return d;
    };
    const swift = rest('swift');
    const condor = rest('condor');
    expect(condor - swift).toBeGreaterThan(SHIP_BY_ID.get('condor')!.radius - SHIP_BY_ID.get('swift')!.radius - 2);
  });

  it('weapon modules set the volley: twin bolts for the Shrike, heavy bolts for the Condor', () => {
    const volley = (id: ShipId) => {
      const r = runFor(id);
      const m = mid(r.layout);
      place(r, m.x, m.y);
      const ev = stepSector(r, { moveX: 0, moveY: 0, fire: true });
      return { r, fired: ev.filter((e) => e.type === 'fired').length };
    };
    const shrike = volley('shrike');
    expect(shrike.r.shots).toHaveLength(2);
    const [a, b] = shrike.r.shots;
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeCloseTo(deriveShip('shrike').weapon.spread, 5);
    expect(a!.vx).toBeCloseTo(b!.vx, 9); // parallel to the nose
    const condor = volley('condor');
    expect(condor.r.shots).toHaveLength(1);
    expect(condor.r.shots[0]!.damage).toBe(3);
    expect(condor.r.fireCooldown).toBe(deriveShip('condor').weapon.cooldownTicks);
    expect(volley('swift').r.fireCooldown).toBe(deriveShip('swift').weapon.cooldownTicks);
  });

  it('damage drains the shield first, then the hull; the hull does not regenerate in flight', () => {
    const r = runFor('petrel');
    const m = mid(r.layout);
    place(r, m.x, m.y);
    // a heavy ship rams the pilot (contact damage)
    expect(spawnAgent(r, 'heavy', 'cordon', 'test', 'patrol', m.x + 5, m.y)).not.toBeNull();
    r.shield = 5;
    r.invuln = 0;
    stepSector(r, { moveX: 0, moveY: 0 });
    expect(r.shield).toBe(0);
    expect(r.hull).toBeLessThan(r.craft.stats.hull);
    expect(r.shieldHit).not.toBeNull(); // the flare faces the hostile
    const hull = r.hull;
    r.hostiles.length = 0;
    for (let i = 0; i < 600; i++) stepSector(r, { moveX: 0, moveY: 0 });
    expect(r.hull).toBe(hull);
    expect(r.shield).toBeGreaterThan(0); // the shield does regenerate
  });

  it('boost spends energy for more speed (eased, capped at ×1.45), needs a minimum charge and recharges after a delay', () => {
    const L = open(SOL);
    const r = runFor('petrel', L);
    const m = mid(L);
    place(r, m.x - 2500, m.y);
    const cap = r.tune.maxSpeed;
    let top = 0;
    for (let i = 0; i < 120; i++) {
      stepSector(r, { moveX: 1, moveY: 0, boost: true });
      top = Math.max(top, speed(r));
    }
    expect(top).toBeGreaterThan(cap * 1.3);
    expect(top).toBeLessThanOrEqual(cap * RUN.boostSpeedMul + 1e-6);
    expect(r.energy).toBeLessThan(r.craft.stats.energy);
    // run dry: boosting stops at zero, and does not restart below the minimum
    for (let i = 0; i < 400 && r.boosting; i++) stepSector(r, { moveX: 1, moveY: 0, boost: true });
    expect(r.boosting).toBe(false);
    r.energy = RUN.boostMinStart - 1;
    r.sinceBoost = 0;
    stepSector(r, { moveX: 1, moveY: 0, boost: true });
    expect(r.boosting).toBe(false);
    // no thrust, no boost
    r.energy = 80;
    stepSector(r, { moveX: 0, moveY: 0, boost: true });
    expect(r.boosting).toBe(false);
    // the top speed eases back down instead of snapping
    place(r, m.x - 2500, m.y);
    r.energy = r.craft.stats.energy;
    for (let i = 0; i < 90; i++) stepSector(r, { moveX: 1, moveY: 0, boost: true });
    const fast = speed(r);
    stepSector(r, { moveX: 1, moveY: 0 });
    expect(speed(r)).toBeGreaterThan(fast * 0.95);
    // recharge waits for the delay
    const e0 = r.energy;
    for (let i = 0; i < RUN.energyDelayTicks - 2; i++) stepSector(r, { moveX: 0, moveY: 0 });
    expect(r.energy).toBe(e0);
    for (let i = 0; i < 60; i++) stepSector(r, { moveX: 0, moveY: 0 });
    expect(r.energy).toBeGreaterThan(e0);
  });
});

/* ------------------------------------------------- docking, cargo, sensors */

describe('docking safety, cargo capacity and sensors', () => {
  const stationAt = (L: SectorLayout) => {
    const m = mid(L);
    return poiLike('station', { id: 'station', x: m.x, y: m.y });
  };

  it('docking restores the ship and allows switching; it is refused while hostiles are engaged', () => {
    const L0 = open(SOL);
    const st = stationAt(L0);
    const L = open(SOL, [st]);
    const dockedRun = (): SectorRun => {
      const r = runFor('petrel', L);
      place(r, st.x + st.solidR + r.tune.radius + 4, st.y);
      stepSector(r, { moveX: 0, moveY: 0 });
      return r;
    };
    const r = dockedRun();
    expect(r.focus).toBe('station');
    expect(canSwitchShip(r)).toBe(false); // not docked yet
    r.hull = 10;
    r.energy = 0;
    expect(interact(r)).toEqual([{ type: 'docked', id: 'station', first: true }]);
    expect(r.hull).toBe(r.craft.stats.hull);
    expect(r.energy).toBe(r.craft.stats.energy);
    expect(r.docked).toBe('station');
    expect(canSwitchShip(r)).toBe(true);
    // engaged: an installation encounter, or a chasing hostile nearby
    const e = dockedRun();
    e.encounters.push(liveEncounter());
    expect(inCombat(e)).toBe(true);
    expect(interact(e)).toEqual([{ type: 'dockRefused' }]);
    expect(e.docked).toBeNull();
    expect(canSwitchShip(e)).toBe(false);
    const c = dockedRun();
    const hunter = spawnAgent(c, 'raider', 'red-tally', 'test', 'patrol', st.x + 600, st.y)!;
    hunter.target = 'player';
    expect(interact(c)).toEqual([{ type: 'dockRefused' }]);
    // a docked ship that becomes engaged cannot switch either
    r.encounters.push(liveEncounter());
    expect(canSwitchShip(r)).toBe(false);
  });

  it('switching ships in a run applies the new stats with a full hull, shield and energy', () => {
    const r = runFor('petrel');
    r.hull = 3;
    applyShip(r, deriveShip('condor'));
    expect(r.craft.ship).toBe('condor');
    expect(r.hull).toBe(deriveShip('condor').stats.hull);
    expect(r.shield).toBe(deriveShip('condor').stats.shield);
    expect(r.tune.radius).toBe(15);
  });

  it('salvage is only collected when the whole find fits; a full hold notifies once per approach and keeps the salvage', () => {
    const L0 = open(SOL);
    const m = mid(L0);
    const salvage = poiLike('salvage', { id: 'salvage-1', x: m.x, y: m.y, loot: [{ resource: 'scrap', amount: 6 }] });
    const L = open(SOL, [salvage]);
    const r = runFor('petrel', L, { cargoSpace: 5 });
    place(r, m.x, m.y);
    let ev = stepSector(r, { moveX: 0, moveY: 0 });
    expect(ev).toContainEqual({ type: 'holdFull', id: 'salvage-1', need: 6, space: 5 });
    ev = stepSector(r, { moveX: 0, moveY: 0 });
    expect(ev.some((e) => e.type === 'holdFull')).toBe(false); // once per approach
    expect(r.done.has('salvage-1')).toBe(false);
    place(r, m.x + 600, m.y);
    stepSector(r, { moveX: 0, moveY: 0 });
    place(r, m.x, m.y);
    ev = stepSector(r, { moveX: 0, moveY: 0 });
    expect(ev.some((e) => e.type === 'holdFull')).toBe(true); // a new approach
    r.cargoSpace = 6;
    ev = stepSector(r, { moveX: 0, moveY: 0 });
    expect(ev).toContainEqual({ type: 'collected', id: 'salvage-1', loot: salvage.loot, left: [] });
    expect(r.cargoSpace).toBe(0);
  });

  it('containers wait for room too; the default run (no capacity given) is unlimited', () => {
    const L0 = open(SOL);
    const m = mid(L0);
    const cache = poiLike('cache', { id: 'cache-1', x: m.x, y: m.y, loot: [{ resource: 'alloy', amount: 4 }] });
    const L = open(SOL, [cache]);
    const r = runFor('petrel', L, { cargoSpace: 3 });
    place(r, m.x + cache.solidR + r.tune.radius + 2, m.y);
    stepSector(r, { moveX: 0, moveY: 0 });
    expect(r.focus).toBe('cache-1');
    expect(interact(r)).toEqual([{ type: 'holdFull', id: 'cache-1', need: 4, space: 3 }]);
    expect(r.done.has('cache-1')).toBe(false);
    r.cargoSpace = 10;
    expect(interact(r).some((e: SectorEvent) => e.type === 'looted')).toBe(true);
    expect(r.cargoSpace).toBe(6);
    expect(runFor('petrel').cargoSpace).toBe(Infinity);
  });

  it('sensors reveal POIs within range; beacons are known on arrival; a surveyed sector is fully charted', () => {
    const L = gen('milky-way/alpha-centauri');
    const beacons = L.pois.filter((p) => ['station', 'gate', 'exit'].includes(p.kind)).map((p) => p.id);
    const near = createSectorRun(L, EMPTY_SECTOR_SAVE, { ship: deriveShip('condor') });
    const far = createSectorRun(L, EMPTY_SECTOR_SAVE, { ship: deriveShip('albatross') });
    for (const id of beacons) expect(near.revealed.has(id)).toBe(true);
    expect(far.revealed.size).toBeGreaterThanOrEqual(near.revealed.size);
    for (const p of L.pois) if (near.revealed.has(p.id) && !beacons.includes(p.id)) expect(Math.hypot(p.x - near.ship.x, p.y - near.ship.y)).toBeLessThanOrEqual(deriveShip('condor').stats.sensor + p.r);
    expect(near.revealed.size).toBeLessThan(L.pois.length);
    const surveyed = createSectorRun(L, { done: [], surveyed: true });
    expect(surveyed.revealed.size).toBe(L.pois.length);
    // flying around reveals more
    const before = near.revealed.size;
    const target = L.pois.find((p) => !near.revealed.has(p.id))!;
    place(near, target.x + 50, target.y);
    for (let i = 0; i < 6; i++) stepSector(near, { moveX: 0, moveY: 0 });
    expect(near.revealed.has(target.id)).toBe(true);
    expect(near.revealed.size).toBeGreaterThan(before);
  });
});

/* -------------------------------------------------------------- progression */

describe('progression: the starter needs no grind and the first ship is reachable', () => {
  it('the starter flies with no licence; the first licences open after one survey and are priced within the first sectors\' finds', () => {
    // a fresh pilot owns and flies the Petrel
    expect(fleetFromSaved(EMPTY_PROFILE.fleet)).toEqual(STARTER_FLEET);
    const fresh = deriveView(graph, progressFromSaved(graph, EMPTY_PROFILE));
    const firstTier = SHIPS.filter((s) => s.licence.length > 0 && s.licence.every((r) => r.kind === 'surveys' && r.count <= 1));
    expect(firstTier.map((s) => s.id).sort()).toEqual(['magpie', 'swift']);
    for (const s of firstTier) expect(s.licence.every((r) => fresh.requirementMet(r))).toBe(false); // earned, not free
    // after one survey in the Milky Way, they are met
    const surveyed = deriveView(graph, progressFromSaved(graph, { ...EMPTY_PROFILE, galaxySurveys: { 'milky-way': 1 }, chartedSystems: ['milky-way/sol'] }));
    for (const s of firstTier) expect(s.licence.every((r) => surveyed.requirementMet(r)), s.id).toBe(true);
    // Sol plus its first neighbour hold enough finds (containers, salvage and ore veins; Prompt 10
    // loot tables) for at least one first-tier ship, and its price fits the starter's hold
    const loot: Record<string, number> = {};
    for (const id of ['milky-way/sol', 'milky-way/alpha-centauri']) {
      const L = gen(id);
      for (const p of L.pois) for (const e of p.loot) loot[e.resource] = (loot[e.resource] ?? 0) + e.amount;
      for (const v of L.veins) for (const c of v.chips) for (const e of c) loot[e.resource] = (loot[e.resource] ?? 0) + e.amount;
    }
    const affordable = firstTier.filter((s) => missingFor(s.cost, loot).length === 0);
    expect(affordable.length).toBeGreaterThan(0);
    for (const s of affordable) expect(cargoUsed(Object.fromEntries(s.cost.map((c) => [c.resource, c.amount])))).toBeLessThanOrEqual(deriveShip(STARTER_SHIP).stats.cargo);
  });
});
