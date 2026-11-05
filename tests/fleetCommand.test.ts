/**
 * P11.1 Fleet Command (docs/freeroam/FLEET_COMMAND.md): the fleet-vessel record and its clean-up,
 * persistence (profile field, save audit), pricing and the authoritative purchase, captains,
 * orders and the fleet wing on the real sector simulation (sector/run.ts stepping the lazily
 * loaded fleet kit), plus the architecture boundaries (lazy chunk, captains vs advisors, no
 * player input, no pilot-ship writes).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import { HEAT, heatOf } from '../src/modes/freeroam/combat/factionHeat.ts';
import type { FamilyId } from '../src/modes/freeroam/combat/families.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import { STEALTH } from '../src/modes/freeroam/combat/stealth.ts';
import { seatRefusalText } from '../src/modes/freeroam/crew/bridgeView.ts';
import { assign, assignRefusal, dismiss, EMPTY_CREW } from '../src/modes/freeroam/crew/state.ts';
import type { CrewState, CrewWorld } from '../src/modes/freeroam/crew/types.ts';
import * as Kit from '../src/modes/freeroam/fleet/fleetKit.ts';
import { captainsOf, cleanVessels, deployable, FLEET_COMMAND, fleetHull, NO_VESSELS, serviceAtDock, vesselsToSaved, type Vessels, type VesselSpec } from '../src/modes/freeroam/fleet/vessels.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { record, EMPTY_LEDGER } from '../src/modes/freeroam/progression/ledger.ts';
import { EMPTY_PROFILE, FREEROAM_VERSION, loadProfile, saveProfile, withVessels, type SavedVessels } from '../src/modes/freeroam/profile.ts';
import { auditProfile } from '../src/modes/freeroam/saveAudit.ts';
import { SLOT_NUMBERS } from '../src/modes/freeroam/saveSlots.ts';
import { EMPTY_SECTOR_SAVE, type Landmark, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { forceCritical } from '../src/modes/freeroam/combat/critical.ts';
import { createSectorRun, disposeSectorRun, pauseSector, restartSector, resumeSector, RUN, shipTuning, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { deriveShip } from '../src/modes/freeroam/ships/equipment.ts';
import { missingFor } from '../src/modes/freeroam/ships/hangar.ts';
import { SHIP_BY_ID, SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import type { ResourceCost, ShipId } from '../src/modes/freeroam/ships/types.ts';
import { upgradedShip } from '../src/modes/freeroam/ships/upgrades.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import { arena } from './helpers/combatProbe.ts';

const NONE: SectorInput = { moveX: 0, moveY: 0 };
const EAST: SectorInput = { moveX: 1, moveY: 0 };
const MAREN = 'maren-sato';
const TOBIAH = 'tobiah-renn';
const ODILE = 'odile-marchetti';
const ILAN = 'ilan-sefton';

/* ------------------------------------------------------------------ helpers */

const roster = (hired: string[], seats: Record<string, string[]> = {}): CrewState => ({ hired, paid: hired, seats });
const RICH: Record<string, number> = { scrap: 99, fuel: 99, alloy: 99, ice: 99, crystal: 99 };
const world = (o: Partial<Kit.PurchaseWorld> & { cargo?: Record<string, number> } = {}): Kit.PurchaseWorld => {
  const cargo = o.cargo ?? RICH;
  return {
    docked: 'milky-way/sol',
    safe: true,
    admin: false,
    crew: roster([MAREN, TOBIAH, ODILE, ILAN]),
    knownCrew: (id) => [MAREN, TOBIAH, ODILE, ILAN, 'brask-ottley'].includes(id),
    marks: 5000,
    short: (c: readonly ResourceCost[]) => missingFor(c, cargo),
    licenceMet: () => true,
    ...o,
  };
};
const buy = (v: Vessels, ship: string, captain: string, w = world()): Vessels => {
  const r = Kit.purchase(v, ship, captain, w);
  if (!r.ok) throw new Error(`purchase refused: ${r.reason}`);
  return r.vessels;
};
const crewWorld = (captains: string[] = []): CrewWorld => ({ docked: 'milky-way/sol', safe: true, owned: ['petrel', 'condor'], requirementMet: () => true, missionDone: () => false, rescues: 0, captains });

/** The archetype spec exactly as the shell builds it (catalogue stats, stock loadout, no upgrades). */
const spec = (vessel: string, ship: ShipId, captain: string): VesselSpec => {
  const d = upgradedShip(ship, undefined, {});
  return { vessel, ship, captain, stats: d.stats, weapon: d.weapon, radius: d.radius, sprite: d.sprite, tune: shipTuning(d) };
};

const body = (x: number, y: number, r: number): Landmark => ({ id: 'body-t', kind: 'body', style: 'gas', x, y, r, hazardR: 0, label: 'Test body' });
/** A cleared difficulty-3 arena (optionally with bodies, offset to a point far from the arrival sanctuary). */
function arenaAt(bodies: readonly Landmark[] = []): { L: SectorLayout; cx: number; cy: number } {
  const base = arena(3);
  const cx = base.arrival.x < base.width / 2 ? base.width - 1500 : 1500;
  const cy = base.arrival.y < base.height / 2 ? base.height - 1500 : 1500;
  return { L: { ...base, landmarks: bodies.map((b) => ({ ...b, x: b.x + cx, y: b.y + cy })) }, cx, cy };
}
/** A run past its arrival grace with the pilot at (cx, cy), invulnerable (these tests are about the wing). */
function flight(L: SectorLayout, cx: number, cy: number, specs: VesselSpec[] = [spec('fv-1', 'shrike', MAREN), spec('fv-2', 'condor', TOBIAH)]): SectorRun {
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 5, ship: deriveShip('petrel') });
  r.grace = 0;
  r.invuln = 1e9;
  Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0 });
  Kit.deploy(r, Kit, specs, RUN.heat);
  return r;
}
const run = (r: SectorRun, n: number, input: SectorInput = NONE): SectorEvent[] => {
  const out: SectorEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...stepSector(r, input));
  return out;
};
const foe = (r: SectorRun, family: FamilyId, x: number, y: number, faction: 'red-tally' | 'gleaners' = 'red-tally'): Agent => {
  const a = spawnAgent(r, family, faction, 'test', 'guard', x, y);
  if (!a) throw new Error('spawn refused');
  return a;
};
const pin = (a: Agent, x: number, y: number): void => void Object.assign(a, { x, y, px: x, py: y, vx: 0, vy: 0 });
const unit = (r: SectorRun, vessel = 'fv-1') => r.wing!.units.find((u) => u.spec.vessel === vessel)!;

/* ------------------------------------------------------------ the record */

describe('P11.1 fleet-vessel record and clean-up', () => {
  it('the cap is three, centralised; Heron and Raven are never fleet hulls; every sold archetype is', () => {
    expect(FLEET_COMMAND.maxVessels).toBe(3);
    expect(fleetHull('heron')).toBeNull();
    expect(fleetHull('raven')).toBeNull();
    expect(fleetHull('nope')).toBeNull();
    for (const s of SHIPS.filter((x) => !x.salvage)) expect(fleetHull(s.id)).toBe(s.id);
    expect(SHIPS).toHaveLength(10); // all ten ships kept
  });

  it('a legacy save (no field) loads an empty fleet and grants nothing', () => {
    expect(cleanVessels(undefined, roster([MAREN]))).toEqual({ state: NO_VESSELS, changes: 0 });
    expect(vesselsToSaved(NO_VESSELS)).toBeUndefined();
  });

  it('malformed records are cleaned: unknown / unique archetypes, bad or duplicate ids, past the cap, bad captains', () => {
    const raw: SavedVessels = {
      seq: 2,
      list: [
        { id: 'fv-1', ship: 'shrike', captain: MAREN, status: 'active' },
        { id: 'fv-1', ship: 'condor', status: 'active' }, // duplicate id
        { id: 'fv-3', ship: 'heron', status: 'active' }, // recovered unique hull
        { id: 'fv-4', ship: 'starfury', status: 'active' }, // unknown archetype
        { id: 'x-5', ship: 'swift', status: 'active' }, // bad id
        { id: 'fv-6', ship: 'swift', captain: MAREN, status: 'reserve' }, // duplicate captain
        { id: 'fv-7', ship: 'magpie', captain: 'brask-ottley', status: 'active' }, // not hired
        { id: 'fv-8', ship: 'crane', status: 'active' }, // past the cap
      ],
    };
    const r = cleanVessels(raw, roster([MAREN]));
    expect(r.state.list).toEqual([
      { id: 'fv-1', ship: 'shrike', captain: MAREN, status: 'active' },
      { id: 'fv-6', ship: 'swift', captain: null, status: 'reserve' },
      { id: 'fv-7', ship: 'magpie', captain: null, status: 'active' },
    ]);
    expect(r.state.seq).toBe(7); // never below an issued id: numbers are not reused
    expect(r.changes).toBeGreaterThan(0);
    // idempotent: a clean state cleans to itself with no changes
    expect(cleanVessels(vesselsToSaved(r.state), roster([MAREN]))).toEqual({ state: r.state, changes: 0 });
  });

  it('a captain seated aboard a ship is cleared (seats win; the vessel stays, uncrewed)', () => {
    const r = cleanVessels({ seq: 1, list: [{ id: 'fv-1', ship: 'swift', captain: MAREN, status: 'active' }] }, roster([MAREN], { petrel: [MAREN] }));
    expect(r.state.list[0]!.captain).toBeNull();
    expect(deployable(r.state.list[0]!)).toBe(false);
  });

  it('only id, archetype, captain and status are stored (no stats, positions, orders or hull points)', () => {
    const v = buy(NO_VESSELS, 'condor', MAREN);
    const saved = vesselsToSaved(v)!;
    expect(saved).toEqual({ seq: 1, list: [{ id: 'fv-1', ship: 'condor', captain: MAREN, status: 'active' }] });
    expect(Object.keys(saved.list[0]!).sort()).toEqual(['captain', 'id', 'ship', 'status']);
  });

  it('docking services the fleet: disabled vessels are back in service, nothing else changes', () => {
    const v: Vessels = { seq: 2, list: [{ id: 'fv-1', ship: 'swift', captain: MAREN, status: 'disabled' }, { id: 'fv-2', ship: 'crane', captain: null, status: 'reserve' }], holds: {} };
    expect(serviceAtDock(v).list.map((x) => x.status)).toEqual(['active', 'reserve']);
    expect(serviceAtDock(NO_VESSELS)).toBe(NO_VESSELS);
  });
});

/* ------------------------------------------------------------ persistence */

describe('P11.1 persistence: profile field and save audit', () => {
  const graph = buildNavGraph();
  it('round-trips through the real profile store, still FREEROAM version 10; three save slots unchanged', () => {
    expect(FREEROAM_VERSION).toBe(10);
    expect(SLOT_NUMBERS).toEqual([1, 2, 3]);
    const store = new MemoryStore();
    const v = buy(buy(NO_VESSELS, 'condor', MAREN), 'swift', TOBIAH);
    expect(saveProfile(store, withVessels(EMPTY_PROFILE, vesselsToSaved(v)))).toBe(true);
    const back = loadProfile(store);
    expect(back.data.vessels).toEqual(vesselsToSaved(v));
    expect(cleanVessels(back.data.vessels, roster([MAREN, TOBIAH])).state).toEqual(v);
  });

  it('a profile without the field loads without one; a malformed field is repaired, never granting a vessel', () => {
    const store = new MemoryStore();
    saveProfile(store, EMPTY_PROFILE);
    expect(loadProfile(store).data.vessels).toBeUndefined();
    for (const junk of [7, 'x', { seq: -1, list: 'no' }, { seq: 1, list: [{ id: 'fv-1', ship: 'swift', status: 'flying' }] }, { seq: 0, list: [] }]) {
      const s2 = new MemoryStore();
      saveProfile(s2, { ...EMPTY_PROFILE, vessels: junk as unknown as SavedVessels });
      const got = loadProfile(s2).data.vessels;
      expect(got === undefined || got.list.length === 0, JSON.stringify(junk)).toBe(true);
    }
  });

  it('the save audit cleans fleet vessels (area "vessels") against the audited crew, and grants nothing', () => {
    const p = withVessels({ ...EMPTY_PROFILE, crew: { hired: [MAREN], paid: [MAREN], seats: {} } }, {
      seq: 3,
      list: [
        { id: 'fv-1', ship: 'raven', status: 'active' },
        { id: 'fv-2', ship: 'swift', captain: 'ghost-captain', status: 'active' },
        { id: 'fv-3', ship: 'crane', captain: MAREN, status: 'active' },
      ],
    });
    const r = auditProfile(graph, p);
    expect(r.issues.some((i) => i.area === 'vessels')).toBe(true);
    expect(r.profile.vessels!.list).toEqual([
      { id: 'fv-2', ship: 'swift', status: 'active' },
      { id: 'fv-3', ship: 'crane', captain: MAREN, status: 'active' },
    ]);
    const clean = auditProfile(graph, r.profile);
    expect(clean.issues.filter((i) => i.area === 'vessels')).toEqual([]);
  });
});

/* ------------------------------------------------------------ purchase */

describe('P11.1 pricing and the authoritative purchase', () => {
  it('the price reads the catalogue (same cost object, same licence) plus the documented commission; no free hull', () => {
    for (const s of SHIPS) {
      const p = Kit.hullPrice(s.id);
      if (s.salvage) {
        expect(p).toBeNull();
        continue;
      }
      expect(p!.cargo).toBe(s.cost); // read, never copied
      expect(p!.licence).toBe(s.licence);
      const units = s.cost.reduce((n, c) => n + c.amount, 0);
      expect(p!.marks).toBe(Math.round((100 + 4 * units) / 10) * 10);
      expect(p!.marks).toBeGreaterThan(0);
    }
    expect(Kit.hullPrice('petrel')).toMatchObject({ cargo: [], marks: 100 });
    // Harrier and Crane keep their survey licences and materials
    expect(Kit.hullPrice('harrier')!.licence).toEqual([{ kind: 'surveys', count: 3 }]);
    expect(Kit.hullPrice('harrier')!.cargo).toEqual([{ resource: 'alloy', amount: 10 }, { resource: 'fuel', amount: 8 }]);
    expect(Kit.hullPrice('crane')!.licence).toEqual([{ kind: 'surveys', count: 2 }]);
    expect(Kit.FLEET_PRICING).toEqual({ base: 100, perUnit: 4, round: 10 });
  });

  it('a purchase issues the next id, in service, with its captain; the commission and the transaction id come back', () => {
    const r = Kit.purchase(NO_VESSELS, 'shrike', MAREN, world());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vessel).toEqual({ id: 'fv-1', ship: 'shrike', captain: MAREN, status: 'active' });
    expect(r.marks).toBe(5000 - Kit.hullPrice('shrike')!.marks);
    expect(r.txId).toBe('fleet:hull:fv-1');
    expect(r.price.cargo).toBe(SHIP_BY_ID.get('shrike')!.cost);
  });

  it('refuses in order, changing nothing: station, archetype, licence, materials, marks, capacity, captain', () => {
    const v = Object.freeze(buy(NO_VESSELS, 'swift', ILAN));
    const cases: [string, string, Kit.PurchaseWorld, Kit.CommandRefusal][] = [
      ['swift', MAREN, world({ admin: true }), 'admin'],
      ['swift', MAREN, world({ docked: null }), 'not-docked'],
      ['swift', MAREN, world({ safe: false }), 'unsafe'],
      ['starfury', MAREN, world(), 'unknown-ship'],
      ['heron', MAREN, world(), 'ineligible'],
      ['raven', MAREN, world(), 'ineligible'],
      ['harrier', MAREN, world({ licenceMet: () => false }), 'locked'],
      ['harrier', MAREN, world({ cargo: { alloy: 10, fuel: 7 } }), 'materials'],
      ['swift', MAREN, world({ marks: 159 }), 'marks'],
      ['swift', 'zed-nobody', world(), 'unknown-crew'],
      ['swift', 'brask-ottley', world(), 'not-hired'],
      ['swift', ILAN, world(), 'captain'],
      ['swift', MAREN, world({ crew: roster([MAREN, TOBIAH, ODILE, ILAN], { petrel: [MAREN] }) }), 'seated'],
    ];
    for (const [ship, cap, w, reason] of cases) {
      expect(Kit.purchaseRefusal(v, ship, cap, w), `${ship}/${cap}`).toBe(reason);
      const r = Kit.purchase(v, ship, cap, w);
      expect(r).toEqual({ ok: false, reason });
    }
    expect(Kit.purchaseRefusal(v, 'swift', MAREN, world({ marks: 160 }))).toBeNull(); // exactly affordable
    const full = buy(buy(v, 'crane', MAREN), 'magpie', TOBIAH);
    expect(full.list).toHaveLength(3);
    expect(Kit.purchase(full, 'swift', ODILE, world())).toEqual({ ok: false, reason: 'full' });
  });

  it('no double purchase: the same captain cannot buy twice, and the ledger refuses the same transaction id', () => {
    const r1 = Kit.purchase(NO_VESSELS, 'swift', MAREN, world());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(Kit.purchase(r1.vessels, 'swift', MAREN, world())).toEqual({ ok: false, reason: 'captain' });
    const l1 = record(EMPTY_LEDGER, EMPTY_LEDGER.balance + 500, 'mission', 'seed');
    if (!l1.ok) throw new Error('ledger seed');
    const once = record(l1.ledger, l1.ledger.balance - r1.price.marks, 'ship', 'Fleet hull · Swift', r1.txId);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(record(once.ledger, once.ledger.balance - r1.price.marks, 'ship', 'Fleet hull · Swift', r1.txId)).toMatchObject({ ok: false, reason: 'duplicate' });
  });

  it('the purchase module never sees or returns the pilot\'s Hangar (no FleetState in, none out)', () => {
    // code only (the doc comment explains the rule by naming FleetState)
    const src = readFileSync(join(__dirname, '../src/modes/freeroam/fleet/command.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/from '[^']*ships\/hangar|\bFleetState\b|\bselectShip\b|\bacquireShip\b|\.owned\b|\bfleet\.active\b/);
  });
});

/* ------------------------------------------------------------ captains */

describe('P11.1 captains: one per vessel, never seated, never advisors', () => {
  const cw = (o: Partial<Kit.CommandWorld> = {}): Kit.CommandWorld => ({ docked: 'milky-way/sol', safe: true, admin: false, crew: roster([MAREN, TOBIAH, ODILE]), knownCrew: () => true, ...o });
  const two = (): Vessels => {
    let v = buy(NO_VESSELS, 'swift', MAREN);
    v = buy(v, 'crane', TOBIAH);
    return Kit.releaseCaptain(v, 'fv-2', cw()).ok ? (Kit.releaseCaptain(v, 'fv-2', cw()) as { vessels: Vessels }).vessels : v;
  };

  it('assign, reassign (no automatic replacement), return to roster, remove from / return to service', () => {
    let v = two();
    expect(captainsOf(v)).toEqual([MAREN]);
    // assign to the uncrewed vessel
    let r = Kit.assignCaptain(v, 'fv-2', ODILE, cw());
    expect(r).toMatchObject({ ok: true, moved: null, released: null });
    v = (r as { vessels: Vessels }).vessels;
    // reassign Maren from fv-1 to fv-2: fv-1 is left uncrewed, Odile returns to the roster
    r = Kit.assignCaptain(v, 'fv-2', MAREN, cw());
    expect(r).toMatchObject({ ok: true, moved: 'fv-1', released: ODILE });
    v = (r as { vessels: Vessels }).vessels;
    expect(v.list.map((x) => x.captain)).toEqual([null, MAREN]);
    expect(deployable(v.list[0]!)).toBe(false);
    // return to roster
    const rel = Kit.releaseCaptain(v, 'fv-2', cw());
    expect(rel).toMatchObject({ ok: true, released: MAREN });
    v = (rel as { vessels: Vessels }).vessels;
    expect(captainsOf(v)).toEqual([]);
    expect(Kit.releaseCaptain(v, 'fv-2', cw())).toEqual({ ok: false, reason: 'no-captain' });
    // remove from service and back
    const off = Kit.setService(v, 'fv-1', 'reserve', cw());
    expect(off.ok && off.vessels.list[0]!.status).toBe('reserve');
    expect(Kit.setService((off as { vessels: Vessels }).vessels, 'fv-1', 'reserve', cw())).toEqual({ ok: false, reason: 'same' });
    expect(Kit.setService(v, 'fv-9', 'active', cw())).toEqual({ ok: false, reason: 'unknown-vessel' });
    // a disabled vessel returns to service only through the dock rule, never by a status switch
    const down: Vessels = { ...v, list: v.list.map((x, i) => (i === 0 ? { ...x, status: 'disabled' as const } : x)) };
    expect(Kit.setService(down, 'fv-1', 'active', cw())).toEqual({ ok: false, reason: 'disabled' });
    expect(Kit.setService(down, 'fv-1', 'reserve', cw())).toEqual({ ok: false, reason: 'disabled' });
    expect(serviceAtDock(down).list[0]!.status).toBe('active');
  });

  it('every refusal has plain player-facing words', () => {
    const all: Kit.CommandRefusal[] = ['admin', 'not-docked', 'unsafe', 'unknown-ship', 'ineligible', 'locked', 'materials', 'marks', 'full', 'unknown-crew', 'not-hired', 'captain', 'seated', 'unknown-vessel', 'no-captain', 'disabled', 'same'];
    for (const r of all) expect(Kit.refusalText(r), r).toMatch(/^[A-Z].{8,}\.$/);
    expect(new Set(all.map(Kit.refusalText)).size).toBe(all.length);
  });

  it('refusals: seated, not hired, unknown vessel, same, away from a station, during Admin Access', () => {
    const v = two();
    expect(Kit.assignCaptain(v, 'fv-2', ODILE, cw({ crew: roster([MAREN, TOBIAH, ODILE], { petrel: [ODILE] }) }))).toEqual({ ok: false, reason: 'seated' });
    expect(Kit.assignCaptain(v, 'fv-2', 'brask-ottley', cw())).toEqual({ ok: false, reason: 'not-hired' });
    expect(Kit.assignCaptain(v, 'fv-7', ODILE, cw())).toEqual({ ok: false, reason: 'unknown-vessel' });
    expect(Kit.assignCaptain(v, 'fv-1', MAREN, cw())).toEqual({ ok: false, reason: 'same' });
    expect(Kit.assignCaptain(v, 'fv-2', ODILE, cw({ docked: null }))).toEqual({ ok: false, reason: 'not-docked' });
    expect(Kit.assignCaptain(v, 'fv-2', ODILE, cw({ safe: false }))).toEqual({ ok: false, reason: 'unsafe' });
    expect(Kit.assignCaptain(v, 'fv-2', ODILE, cw({ admin: true }))).toEqual({ ok: false, reason: 'admin' });
  });

  it('crew rules: a captain cannot take a seat (so never advises) or be dismissed, and stays on the roster', () => {
    const s = roster([MAREN, TOBIAH]);
    expect(assignRefusal(s, MAREN, 'petrel', crewWorld([MAREN]))).toBe('captain');
    expect(assign(s, MAREN, 'petrel', crewWorld([MAREN]))).toEqual({ ok: false, reason: 'captain' });
    expect(dismiss(s, MAREN, crewWorld([MAREN]))).toEqual({ ok: false, reason: 'captain' });
    expect(s.hired).toContain(MAREN);
    expect(seatRefusalText('captain', 'petrel')).toMatch(/fleet vessel/);
    // without the captains list the P05 rules are exactly as before
    expect(assignRefusal(s, MAREN, 'petrel', crewWorld())).toBeNull();
    expect(assignRefusal(EMPTY_CREW, MAREN, 'petrel', crewWorld([MAREN]))).toBe('not-hired');
  });
});

/* ------------------------------------------------------------ simulation */

describe('P11.1 fleet wing on the real sector simulation', () => {
  it('deploys separate entities with negative ids and the archetype\'s catalogue stats, never in the enemy list', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx, cy);
    const us = r.wing!.units;
    expect(us.map((u) => u.id)).toEqual([-1, -2]);
    // the catalogue's own derivation of the archetype (stock loadout), never a copy and never the pilot's upgrades
    expect(us.map((u) => u.hull)).toEqual([deriveShip('shrike').stats.hull, deriveShip('condor').stats.hull]);
    expect(us[1]!.spec.tune.maxSpeed).toBe(deriveShip('condor').stats.maxSpeed);
    expect(us[1]!.spec.weapon).toEqual(deriveShip('condor').weapon);
    expect(r.hostiles).toHaveLength(0);
    expect(new Set(us.map((u) => u.ship)).size).toBe(2);
    expect(us.every((u) => u.ship !== r.ship)).toBe(true);
    // deploying twice never duplicates (sector re-entry builds a fresh run; a second attach is refused)
    Kit.deploy(r, Kit, [spec('fv-1', 'shrike', MAREN), spec('fv-2', 'condor', TOBIAH), spec('fv-3', 'swift', ODILE)], RUN.heat);
    expect(r.wing!.units).toHaveLength(2);
    Kit.syncWing(r, [spec('fv-1', 'shrike', MAREN), spec('fv-2', 'condor', TOBIAH)]);
    expect(r.wing!.units).toHaveLength(2);
  });

  it('Follow Formation: distinct slots, smooth (never faster than the hull allows), inside the bounds, no teleport', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx - 600, cy);
    let maxStep = 0;
    for (let i = 0; i < 420; i++) {
      const before = r.wing!.units.map((u) => ({ x: u.ship.x, y: u.ship.y }));
      stepSector(r, i < 240 ? EAST : NONE);
      r.wing!.units.forEach((u, k) => (maxStep = Math.max(maxStep, Math.hypot(u.ship.x - before[k]!.x, u.ship.y - before[k]!.y) - (u.spec.tune.maxSpeed / 60 + 8))));
    }
    expect(maxStep).toBeLessThanOrEqual(0.5); // separation nudges only: never a jump
    const s = Kit.wingStatus(r)!;
    for (const u of r.wing!.units) {
      expect(Math.hypot(u.ship.x - r.ship.x, u.ship.y - r.ship.y)).toBeLessThan(140);
      expect(u.ship.x).toBeGreaterThanOrEqual(0);
      expect(u.ship.x).toBeLessThanOrEqual(L.width);
    }
    const [a, b] = r.wing!.units;
    expect(Math.hypot(a!.ship.x - b!.ship.x, a!.ship.y - b!.ship.y)).toBeGreaterThan(a!.spec.radius + b!.spec.radius);
    expect(s.units.every((u) => (u['order'] as { kind: string }).kind === 'follow')).toBe(true);
  });

  it('Hold Position: reaches the stored point within tolerance and stays there without oscillating', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx, cy, [spec('fv-1', 'condor', MAREN)]);
    expect(Kit.issueOrder(r, 'fv-1', { kind: 'hold', x: cx + 400, y: cy - 200 })).toEqual({ ok: true, vessels: ['fv-1'] });
    const hp = unit(r).order as { kind: 'hold'; x: number; y: number };
    run(r, 480, NONE);
    const track: number[] = [];
    for (let i = 0; i < 120; i++) {
      stepSector(r, i % 40 < 20 ? EAST : NONE); // the pilot moving around does not drag a holding vessel
      track.push(Math.hypot(unit(r).ship.x - hp.x, unit(r).ship.y - hp.y));
    }
    expect(Math.max(...track)).toBeLessThanOrEqual(Kit.WING.holdTolerance + 2);
    expect(Math.hypot(unit(r).ship.vx, unit(r).ship.vy)).toBeLessThan(5);
  });

  it('Defend Me engages a known threat only: line of sight past a body (Gravity Shadow) is respected', () => {
    // a body between the escort side and the enemy: the escort does not see it, so it does not engage
    const { L, cx, cy } = arenaAt([body(0, -260, 120)]);
    const r = flight(L, cx, cy, [spec('fv-1', 'shrike', MAREN)]);
    r.silent = false;
    forceCritical(r, 'normal'); // Finale P1: targeting under test, on the ordinary damage path
    expect(Kit.issueOrder(r, 'all', { kind: 'defend' }).ok).toBe(true);
    const a = foe(r, 'raider', cx, cy - 520);
    for (let i = 0; i < 30; i++) {
      pin(a, cx, cy - 520);
      Object.assign(unit(r).ship, { x: cx, y: cy - 20, vx: 0, vy: 0 });
      stepSector(r, NONE);
    }
    expect(unit(r).target).toBeNull();
    expect(r.wing!.bolts).toHaveLength(0);
    // the same threat in the open is engaged and fired on
    const o = arenaAt();
    const r2 = flight(o.L, o.cx, o.cy, [spec('fv-1', 'shrike', MAREN)]);
    forceCritical(r2, 'normal'); // the engaged target must still be there at the check (a critical would destroy it)
    Kit.issueOrder(r2, 'all', { kind: 'defend' });
    const b = foe(r2, 'raider', o.cx, o.cy - 330);
    let fired = 0;
    for (let i = 0; i < 120; i++) {
      pin(b, o.cx, o.cy - 330);
      stepSector(r2, NONE);
      fired = Math.max(fired, r2.wing!.bolts.length);
    }
    expect(unit(r2).target).toBe(b.id);
    expect(fired).toBeGreaterThan(0);
  });

  it('Attack Target: refuses the pilot, a fleet vessel, a station, unknown, destroyed and non-hostile targets', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx, cy);
    const g = foe(r, 'hauler', cx + 300, cy, 'gleaners'); // wary: not hostile until provoked
    const dead = foe(r, 'raider', cx - 300, cy);
    dead.state = 'destroyed';
    const station = L.pois.find((p) => p.kind === 'station')?.id ?? 'station-x';
    expect(Kit.attackRefusal(r, 'player')).toBe('player');
    expect(Kit.attackRefusal(r, -1)).toBe('friendly');
    expect(['station', 'invalid-target']).toContain(Kit.attackRefusal(r, station));
    expect(Kit.attackRefusal(r, 999)).toBe('invalid-target');
    expect(Kit.attackRefusal(r, 1.5)).toBe('invalid-target');
    expect(Kit.attackRefusal(r, dead.id)).toBe('destroyed');
    expect(Kit.attackRefusal(r, g.id)).toBe('not-hostile');
    expect(Kit.issueOrder(r, 'all', { kind: 'attack', target: g.id })).toEqual({ ok: false, reason: 'not-hostile' });
    expect(r.wing!.units.every((u) => u.order.kind === 'follow')).toBe(true); // a refusal changes nothing
    expect(Kit.issueOrder(r, 'fv-9', { kind: 'follow' })).toEqual({ ok: false, reason: 'unknown-vessel' });
  });

  it('Attack Target fires with the normal weapon range and cooldown, and falls back to Follow when the target is destroyed', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx, cy, [spec('fv-1', 'shrike', MAREN)]);
    const a = foe(r, 'raider', cx + 260, cy);
    expect(Kit.issueOrder(r, 'fv-1', { kind: 'attack', target: a.id }).ok).toBe(true);
    const cd = unit(r).spec.weapon.cooldownTicks;
    let shots = 0;
    let last = -Infinity;
    let minGap = Infinity;
    const ev: SectorEvent[] = [];
    for (let i = 0; i < 600 && a.state !== 'destroyed'; i++) {
      pin(a, cx + 260, cy);
      const before = r.wing!.bolts.length;
      ev.push(...stepSector(r, NONE));
      if (r.wing!.bolts.length > before) {
        shots += 1;
        minGap = Math.min(minGap, i - last);
        last = i;
      }
    }
    expect(shots).toBeGreaterThan(0);
    expect(minGap).toBeGreaterThanOrEqual(cd);
    expect(a.state).toBe('destroyed');
    ev.push(...run(r, 3, NONE));
    expect(ev.filter((e) => e.type === 'fleet' && e.change === 'fallback')).toEqual([{ type: 'fleet', change: 'fallback', vessel: 'fv-1' }]);
    expect(unit(r).order.kind).toBe('follow');
    expect(ev.some((e) => e.type === 'destroyed' && e.by === 'player')).toBe(true); // the one attribution: credited to the pilot's side
  });

  it('fleet hits use the existing attribution exactly once per hit (faction heat), and reveal the escort, never the pilot', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx, cy, [spec('fv-1', 'condor', MAREN)]);
    const a = foe(r, 'heavy', cx + 700, cy); // far from the pilot (no sight of the pilot)
    a.state = 'idle';
    a.target = null;
    const u = unit(r);
    Object.assign(u.ship, { x: cx + 520, y: cy, vx: 0, vy: 0, heading: Math.PI / 2 });
    u.cooldown = 1e9; // this test isolates one bolt (the escort would otherwise return fire)
    const before = heatOf(r.factionHeat, 'red-tally');
    // one bolt, aimed straight at it
    r.wing!.bolts.push({ x: cx + 600, y: cy, px: cx + 600, py: cy, vx: 600, vy: 0, life: 30, damage: 5, from: u.id });
    const ev: SectorEvent[] = [];
    for (let i = 0; i < 12 && r.wing!.bolts.length; i++) {
      pin(a, cx + 700, cy);
      ev.push(...stepSector(r, NONE));
    }
    expect(ev.filter((e) => e.type === 'struck' && e.by === 'player')).toHaveLength(1);
    expect(heatOf(r.factionHeat, 'red-tally') - before).toBe(HEAT.hit);
    expect(a.lastSeen && Math.hypot(a.lastSeen.x - r.ship.x, a.lastSeen.y - r.ship.y)).toBeGreaterThan(300);
  });

  it('fleet bolts never strike or provoke a neutral faction (no heat bypass through the fleet)', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx, cy, [spec('fv-1', 'condor', MAREN)]);
    const g = foe(r, 'hauler', cx + 300, cy, 'gleaners');
    const hull = g.hull;
    r.wing!.bolts.push({ x: cx + 250, y: cy, px: cx + 250, py: cy, vx: 600, vy: 0, life: 20, damage: 50, from: -1 });
    for (let i = 0; i < 10; i++) {
      pin(g, cx + 300, cy);
      stepSector(r, NONE);
    }
    expect(g.hull).toBe(hull);
    expect(r.provoked.has('gleaners')).toBe(false);
    expect(heatOf(r.factionHeat, 'gleaners')).toBe(0);
  });

  it('enemies see escorts (not the pilot through them) and their fire disables an escort at 0 hull: owned, crewed, out of the fight', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx, cy, [spec('fv-1', 'swift', MAREN)]);
    const u = unit(r);
    // the pilot out of every detect range; the escort parked near an enemy
    Object.assign(r.ship, { x: cx - 1200, y: cy });
    const a = foe(r, 'lancer', cx + 300, cy);
    let ev: SectorEvent[] = [];
    for (let i = 0; i < 20; i++) {
      Object.assign(u.ship, { x: cx, y: cy, vx: 0, vy: 0 });
      ev = ev.concat(stepSector(r, NONE));
    }
    expect(a.target).toBe(u.id);
    // the real blast path takes it to 0
    const out: SectorEvent[] = [];
    Kit.blastHit(r, 'red-tally', u.ship.x, u.ship.y, 1, 1e6, out);
    expect(u.state).toBe('disabled');
    expect(out).toEqual([{ type: 'fleet', change: 'disabled', vessel: 'fv-1' }]);
    // disabled: never targeted again, no fire, never damaged further
    const hullAfter = u.hull;
    run(r, 40, NONE);
    expect(a.target).not.toBe(u.id);
    expect(r.wing!.bolts).toHaveLength(0);
    expect(u.hull).toBe(hullAfter);
    expect(r.wing!.units).toHaveLength(1); // still there (owned)
    // a restart keeps it disabled; a dock services it
    restartSector(r);
    expect(unit(r).state).toBe('disabled');
    Kit.regroup(r, 'dock');
    expect(unit(r)).toMatchObject({ state: 'active', hull: SHIP_BY_ID.get('swift')!.base.hull });
    expect(ev.length).toBeGreaterThanOrEqual(0);
  });

  it('Silent Running: escorts hold fire in Follow, match the pilot\'s signature, and never end Silent Running', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx, cy, [spec('fv-1', 'shrike', MAREN)]);
    stepSector(r, { moveX: 0, moveY: 0, silentToggle: true });
    expect(r.silent).toBe(true);
    const a = foe(r, 'raider', cx + 260, cy);
    a.target = 'player';
    for (let i = 0; i < 150; i++) {
      pin(a, cx + 260, cy);
      a.target = 'player';
      stepSector(r, NONE);
    }
    expect(r.wing!.bolts).toHaveLength(0);
    expect(unit(r).sig).toBe(STEALTH.silent);
    // an explicit Attack order is the pilot's choice: it fires, and Silent Running stays on
    Kit.issueOrder(r, 'fv-1', { kind: 'attack', target: a.id });
    let fired = false;
    for (let i = 0; i < 120 && !fired; i++) {
      pin(a, cx + 260, cy);
      stepSector(r, NONE);
      fired = r.wing!.bolts.length > 0;
    }
    expect(fired).toBe(true);
    expect(r.silent).toBe(true);
    expect(unit(r).sig).toBe(STEALTH.normal); // a firing escort is seen normally (only the escort)
  });

  it('pause freezes the wing; a recall re-forms it at the arrival with orders back to Follow; dispose drops everything', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx, cy);
    Kit.issueOrder(r, 'all', { kind: 'hold' });
    run(r, 10, EAST);
    pauseSector(r);
    const snap = JSON.stringify(r.wing!.units.map((u) => [u.ship.x, u.ship.y, u.hull]));
    expect(run(r, 60, EAST)).toEqual([]);
    expect(JSON.stringify(r.wing!.units.map((u) => [u.ship.x, u.ship.y, u.hull]))).toBe(snap);
    resumeSector(r);
    restartSector(r);
    for (const u of r.wing!.units) {
      expect(u.order.kind).toBe('follow');
      expect(Math.hypot(u.ship.x - r.ship.x, u.ship.y - r.ship.y)).toBeLessThan(160);
    }
    const w = r.wing!;
    disposeSectorRun(r);
    expect(r.wing).toBeNull();
    expect(w.units).toHaveLength(0);
    expect(stepSector(r, EAST)).toEqual([]);
    Kit.deploy(r, Kit, [spec('fv-1', 'swift', MAREN)], RUN.heat); // a disposed run never gets a wing again
    expect(r.wing).toBeNull();
  });

  it('a run with no fleet has no wing and steps exactly as before (no fleet code runs)', () => {
    const { L, cx, cy } = arenaAt();
    const a = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 9 });
    const b = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 9 });
    Kit.deploy(b, Kit, [], RUN.heat); // nothing deployable: the wing exists but is empty
    for (let i = 0; i < 300; i++) {
      stepSector(a, i % 50 < 25 ? EAST : NONE);
      stepSector(b, i % 50 < 25 ? EAST : NONE);
    }
    expect(a.wing).toBeNull();
    expect([b.ship.x, b.ship.y, b.hull]).toEqual([a.ship.x, a.ship.y, a.hull]);
    void cx;
    void cy;
  });

  it('the bolt pool is bounded and separate from the pilot\'s 24 shots', () => {
    const { L, cx, cy } = arenaAt();
    const r = flight(L, cx, cy, [spec('fv-1', 'shrike', MAREN), spec('fv-2', 'condor', TOBIAH), spec('fv-3', 'swift', ODILE)]);
    const a = foe(r, 'capital', cx + 300, cy);
    a.target = 'player';
    Kit.issueOrder(r, 'all', { kind: 'attack', target: a.id });
    let peak = 0;
    for (let i = 0; i < 300; i++) {
      pin(a, cx + 300, cy);
      stepSector(r, NONE);
      peak = Math.max(peak, r.wing!.bolts.length);
      expect(r.shots.length).toBe(0);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(Kit.WING.maxBolts);
  });
});

/* ------------------------------------------------------------ architecture */

describe('P11.1 architecture: lazy fleet chunk, captains vs advisors, no player input', () => {
  const src = join(__dirname, '../src');
  const read = (p: string): string => readFileSync(join(src, p), 'utf8');
  const fleetDir = 'modes/freeroam/fleet';
  const fleetFiles = readdirSync(join(src, fleetDir)).sort();
  const all = (dir: string): string[] => readdirSync(join(src, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? all(`${dir}/${d.name}`) : d.name.endsWith('.ts') ? [`${dir}/${d.name}`] : []));

  it('the fleet folder holds exactly the record (eager), the rules, the wing and the lazy entry', () => {
    expect(fleetFiles).toEqual(['command.ts', 'fleetKit.ts', 'vessels.ts', 'wing.ts']);
  });

  it('eager code imports only types of the lazy kit; the shell loads it with one cached dynamic import', () => {
    for (const f of all('.').filter((x) => !x.startsWith(`./${fleetDir}/`))) {
      const code = read(f);
      for (const m of code.matchAll(/^import\s+(type\s+)?[^;]*from '[./]*(?:fleet\/)?(?:fleetKit|wing|command)\.ts';$/gm)) expect(m[1], `${f}: ${m[0]}`).toBeTruthy();
    }
    const shell = read('modes/freeroam/freeRoamMode.ts');
    expect(shell.match(/import\('\.\/fleet\/fleetKit\.ts'\)/g)).toHaveLength(1);
    expect(shell).toMatch(/fleetLoad \?\?= import\('\.\/fleet\/fleetKit\.ts'\)\.then\(/);
    expect(read(`${fleetDir}/vessels.ts`)).toMatch(/^import type \* as Kit from '\.\/fleetKit\.ts';$/m);
  });

  it('fleet code never touches player input, the DOM, storage, wall clocks or randomness, and never imports crew/', () => {
    for (const f of fleetFiles) {
      const code = read(`${fleetDir}/${f}`);
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|sessionStorage|fetch|setTimeout|setInterval|requestAnimationFrame)\b/);
      for (const m of code.matchAll(/from '([^']+)'/g)) {
        expect(m[1], `${f} imports ${m[1]}`).not.toMatch(/(^|\/)(input|controls|keyboard|pointers|gamepad|bindings|touch)(\.ts|\/)|\/crew\/|\/input\/|^\.\.\/\.\.\/\.\.\/(input|shared\/input)\//);
      }
    }
    // value imports of eager-only modules stay out of the lazy chunk (types only from run.ts, profile.ts)
    for (const f of ['command.ts', 'wing.ts', 'fleetKit.ts']) {
      const code = read(`${fleetDir}/${f}`);
      for (const m of code.matchAll(/^import\s+(type\s+)?[^;]*from '([^']+)';$/gm)) if (/sector\/run\.ts|profile\.ts|ships\/hangar|ships\/equipment|freeRoamMode/.test(m[2]!)) expect(m[1], `${f}: ${m[0]}`).toBeTruthy();
    }
  });

  it('fleet code never writes the pilot\'s ship, shots, weapon, silent state, hull or shield', () => {
    for (const f of fleetFiles) {
      const code = read(`${fleetDir}/${f}`);
      expect(code, f).not.toMatch(/\brun\.(ship|silent|hull|shield|energy|boost|boosting|heat|overheated|fireCooldown|invuln|craft|tune)(\.[\w$]+)*\s*(=(?!=)|\+=|-=|\*=|\+\+|--)/);
      expect(code, f).not.toMatch(/Object\.assign\(\s*run\.ship|run\.shots\.(push|splice)|stepShip\(\s*run\.ship/);
    }
  });

  it('captains and advisors stay distinct: the advisor reads seated crew only and knows nothing of the fleet', () => {
    for (const f of ['crew/advisor.ts', 'crew/traits.ts', 'crew/observation.ts', 'advisor/observe.ts', 'advisor/forecast.ts']) expect(read(`modes/freeroam/${f}`), f).not.toMatch(/captain|fleet\/|vessel/i);
    expect(read('modes/freeroam/crew/types.ts')).toMatch(/readonly captains\?: readonly string\[\];/);
  });

  it('no crew-attribute combat bonus: fleet code reads no crew attributes, traits or roles', () => {
    for (const f of fleetFiles) expect(read(`${fleetDir}/${f}`), f).not.toMatch(/attributes|traits|CREW_BY_ID|\brole\b|doctrine/);
  });
});
