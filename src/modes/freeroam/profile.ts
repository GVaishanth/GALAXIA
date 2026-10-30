/**
 * Free Roam profile and progression, stored under its own namespace
 * (`galaxia:freeroam`), never inside the Classic record. Pure (no DOM, no wall
 * clock: timestamps are passed in by the shell).
 *
 * v1 (Prompt 2): sessions, flight time, beacons charted and the flight-test
 * survey record. v2 (Prompt 4) adds galaxy navigation progress: the current
 * galaxy, visited galaxies, systems charted by survey runs and survey runs per
 * galaxy. Ids are only checked for shape here (this module ships in the main
 * bundle and must not pull in the catalogue); the Free Roam chunk drops ids
 * the catalogue does not know (galaxy/progress.ts progressFromSaved).
 * v3 (Prompt 5) adds the system the pilot is at inside the current galaxy and
 * the systems they have visited (system map). '' = the galaxy's gateway.
 * v4 (Prompt 6) adds local sectors: per system, the completed interactions
 * (local POI ids such as `derelict-2`) and whether its survey is done, plus
 * the cargo hold. Only gameplay changes are stored; the sector layout itself
 * is regenerated from the catalogue seed.
 * v5 (Prompt 7) adds flight control settings: key bindings, mouse aim and the
 * camera zoom. They live here (not in the shared `galaxia:prefs`) because
 * they are Free Roam only; Classic's controls are fixed.
 * v6 (Prompt 8) adds the fleet: the ships owned, the one flown and any
 * non-stock loadouts (module ids per slot). Only the shape is checked here
 * (this module is in the main bundle and must not import the ship roster);
 * ships/hangar.ts `fleetFromSaved` drops unknown ships and invalid loadouts
 * when Free Roam loads. Earlier saves migrate to the starter fleet; the cargo
 * hold is kept even when it exceeds the starter's capacity (nothing is lost,
 * collection simply waits until there is room).
 * v7 (Prompt 9) adds the cargo wreck: when the ship is destroyed, half of
 * every common cargo stack (rounded down) is left in a wreck at the place of
 * death (`lostCargo`); rare resources are kept. Flying through the wreck
 * recovers it; dying again first replaces it (the old wreck is lost). One
 * wreck at most, so a death can never duplicate cargo.
 * v8 (Prompt 10) adds the inventory: station module storage (`modules`,
 * module id -> count), claimed exploration milestones (`milestones`) and,
 * per sector, loot left in partly taken containers (`left`, local id ->
 * resource counts; an id with loot left is not done yet). Collection state
 * stays in `sectors[...].done`. inventory/persistence.ts exposes all of it
 * through a storage-independent snapshot interface for the later save system.
 * v9 (Prompt 11) adds progression (`progression`): Guild marks, missions
 * (active with progress and resolved targets, completed, claimed, failed,
 * contract specs waiting to be turned in, the jump counter used for
 * deadlines), installed upgrades per ship, upgrade licences, the exploration
 * record and the fuel bookkeeping (starter cells granted once, arrivals and
 * the arrival of the last free emergency top-up). Shapes only here;
 * progression/persistence.ts drops unknown missions, tracks and resources.
 * Economy pass (additive, still v10): `progression.ledger` (a bounded history
 * of marks changes and recent claim ids; the balance stays `progression.marks`)
 * and `progression.bounty` (per-system bounty windows). Absent = empty, so
 * older saves keep their exact balance and gain no starting bonus.
 * P05.1 crew (additive, still v10): `crew` (who signed on, whose berth fee is
 * paid, who sits in which ship's seats). Absent = no crew: an older save
 * loads with an empty roster and no crew member is ever granted by loading.
 * Shapes only here; crew/persistence.ts checks the ids against the crew
 * roster and the fleet, and the empty state is never written (no field).
 */
import type { KeyValueStore } from '../../persistence/storage.ts';
import { STORAGE_KEYS } from '../../shared/persistence/namespaces.ts';
import { intField, isObj, loadRecord, writeRecord, type Fix, type RecordLoad, type RecordSpec } from '../../shared/persistence/record.ts';
import { cleanOrdnance, initialOrdnance } from '../../config/weapons.ts';
import { DEFAULT_BINDINGS, sanitizeBindings, type Bindings } from './bindings.ts';

export interface FreeRoamProfile {
  /** ms since epoch when the profile was created (0 = unknown). */
  readonly createdAt: number;
  readonly sessions: number;
  /** Whole seconds flown in total. */
  readonly flightSeconds: number;
  /** Beacons charted over all flights. */
  readonly beaconsCharted: number;
  readonly surveysCompleted: number;
  /** Fastest completed survey in simulation ticks (60 per second); 0 = none yet. */
  readonly bestSurveyTicks: number;
  /* v2: galaxy navigation */
  readonly currentGalaxy: string;
  readonly visitedGalaxies: readonly string[];
  readonly chartedSystems: readonly string[];
  readonly galaxySurveys: Readonly<Record<string, number>>;
  /* v3: system map */
  /** System id inside `currentGalaxy`; '' = that galaxy's gateway (resolved by the Free Roam chunk). */
  readonly currentSystem: string;
  readonly visitedSystems: readonly string[];
  /* v4: local sectors */
  /** Per system id: completed one-time interactions and the survey flag. Absent = untouched. */
  readonly sectors: Readonly<Record<string, SectorRecord>>;
  /** Resources collected (resource id -> amount). */
  readonly cargo: Readonly<Record<string, number>>;
  /* v5-v9: flight controls lived here; since v10 they are in `galaxia:freeroam:prefs`
     (shared by every slot, saveSlots.ts) */
  /* v6: the fleet */
  readonly fleet: SavedFleet;
  /* v7: the cargo wreck (null = none) */
  readonly lostCargo: LostCargo | null;
  /* v8: inventory */
  /** Spare equipment modules stored at stations (module id -> count). */
  readonly modules: Readonly<Record<string, number>>;
  /** Exploration milestones whose reward has been claimed. */
  readonly milestones: readonly string[];
  /* v9: progression */
  readonly progression: SavedProgression;
  /**
   * Combat P03B (additive, still v10): saved ammunition per stocked weapon
   * (config/weapons.ts STOCKED_WEAPONS), always whole numbers in 0..capacity.
   * A save without it starts at the initial stock; docking refills it.
   */
  readonly ordnance: Readonly<Record<string, number>>;
  /** P05.1 (additive, still v10): the crew. Absent = no crew signed on. */
  readonly crew?: SavedCrew;
  /* v10: save management */
  /** ms since epoch of the last successful save (0 = never saved by v10+). */
  readonly savedAt: number;
  /** Where the pilot was at the last safe autosave inside `currentSystem` (null = arrival). */
  readonly resume: ResumePoint | null;
}

/** A logical position inside a sector (v10). The Free Roam chunk checks it against the
 *  sector layout before using it; an unsafe or stale point falls back to the arrival. */
export interface ResumePoint {
  readonly systemId: string;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

/** A station contract as accepted (v9; progression/missionTypes.ts ContractSpec). */
export interface SavedContract {
  readonly type: string;
  readonly station: string;
  readonly target: string;
  readonly count: number;
  readonly resource: string;
  readonly marks: number;
  readonly deadline: number;
  readonly difficulty: number;
}

export interface SavedActiveMission {
  readonly id: string;
  readonly at: number;
  readonly progress: readonly number[];
  readonly targets: readonly string[];
  readonly contract?: SavedContract | undefined;
}

export interface SavedMissions {
  readonly jumps: number;
  readonly active: readonly SavedActiveMission[];
  readonly completed: readonly string[];
  readonly claimed: readonly string[];
  readonly failed: readonly string[];
  readonly ready: Readonly<Record<string, SavedContract>>;
}

export interface SavedLog {
  readonly anomalies: readonly string[];
  readonly wrecks: readonly string[];
  readonly factions: readonly string[];
  readonly facts: readonly string[];
  readonly kills: number;
  readonly acquired: Readonly<Record<string, number>>;
}

export interface SavedFuel {
  /** The starter reactor cells were granted (once per profile). */
  readonly starter: boolean;
  /** System arrivals counted (any jump or route). */
  readonly arrivals: number;
  /** Arrival number of the last free emergency top-up (-1 = never). */
  readonly aidAt: number;
}

/** Economy pass: one marks change in the bounded history (shapes only; progression/ledger.ts re-checks). */
export interface SavedLedgerEntry {
  readonly seq: number;
  readonly kind: string;
  readonly label: string;
  readonly delta: number;
  readonly balance: number;
  readonly refunded?: boolean;
}

export interface SavedLedger {
  readonly seq: number;
  readonly history: readonly SavedLedgerEntry[];
  readonly recent: readonly string[];
}

export interface SavedProgression {
  readonly marks: number;
  readonly missions: SavedMissions;
  /** ship id -> upgrade track -> level 1..3. */
  readonly upgrades: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly licences: readonly string[];
  readonly log: SavedLog;
  readonly fuel: SavedFuel;
  /** Economy pass (additive): marks history. Absent = none yet. */
  readonly ledger?: SavedLedger;
  /** Economy pass (additive): system id -> bounty paid in the current period and the jump count it opened at. */
  readonly bounty?: Readonly<Record<string, { readonly paid: number; readonly since: number }>>;
  /** P09.1 (additive): faction id -> heat 1..100 (quiet factions omitted; absent = all quiet). */
  readonly heat?: Readonly<Record<string, number>>;
}

export const EMPTY_PROGRESSION: SavedProgression = Object.freeze({
  marks: 0,
  missions: Object.freeze({ jumps: 0, active: Object.freeze([]), completed: Object.freeze([]), claimed: Object.freeze([]), failed: Object.freeze([]), ready: Object.freeze({}) }),
  upgrades: Object.freeze({}),
  licences: Object.freeze([]),
  log: Object.freeze({ anomalies: Object.freeze([]), wrecks: Object.freeze([]), factions: Object.freeze([]), facts: Object.freeze([]), kills: 0, acquired: Object.freeze({}) }),
  fuel: Object.freeze({ starter: false, arrivals: 0, aidAt: -1 }),
});

/** Cargo left in a wreck where the ship was destroyed (v7). */
export interface LostCargo {
  readonly systemId: string;
  readonly x: number;
  readonly y: number;
  readonly cargo: Readonly<Record<string, number>>;
}

/** Saved fleet (shape only; ships/hangar.ts validates it against the roster). */
export interface SavedFleet {
  readonly active: string;
  readonly owned: readonly string[];
  /** Non-stock loadouts: ship id -> slot type -> module ids. */
  readonly loadouts: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  /**
   * Combat P03B (additive, still v10): weapon preferences per owned ship, ship id ->
   * start weapon and switching cycle. Shapes only here; ships/armory.ts cleanSetup
   * re-checks every weapon against the ship's mounts on load. Absent = defaults.
   */
  readonly weapons?: Readonly<Record<string, { readonly start: string; readonly rotation: readonly string[] }>>;
}

/** The starter ship's id (tests check it matches ships/roster.ts STARTER_SHIP). */
export const STARTER_SHIP_ID = 'petrel';
/** P05.1: crew ids only (definitions live in crew/data.ts, never in a save). */
export interface SavedCrew {
  /** Signed on, in hire order. */
  readonly hired: readonly string[];
  /** Berth fee already paid once. */
  readonly paid: readonly string[];
  /** Per ship id: crew ids in seat order. */
  readonly seats: Readonly<Record<string, readonly string[]>>;
  /** P05.2: Navigator doctrine; written only when 'safety' (absent = 'balanced'). */
  readonly doctrine?: 'safety';
}

export const STARTER_SAVED_FLEET: SavedFleet = Object.freeze({ active: STARTER_SHIP_ID, owned: Object.freeze([STARTER_SHIP_ID]), loadouts: Object.freeze({}) });

/** Free Roam control settings (v5). */
export interface FlightControls {
  readonly bindings: Bindings;
  /** Desktop: the nose and shots follow the mouse cursor (WASD still moves). Off by default. */
  readonly mouseAim: boolean;
  /** Player camera zoom multiplier (the camera clamps it to its own bounds). */
  readonly zoom: number;
  /**
   * P04.3: the flight model. 'normal' = GALAXIA's standard controls (the
   * default); 'realistic' = momentum flight with STOP (sector/realisticFlight.ts).
   * A missing (older save) or unknown value means 'normal'.
   */
  readonly flightMode: 'normal' | 'realistic';
  /**
   * P05.2: Ship Mind and crew advice. Absent = all advice (the default);
   * 'critical' = only critical warnings (low hull, an imminent collision).
   * Critical warnings cannot be switched off.
   */
  readonly advice?: 'critical';
  /**
   * P06.1 accessibility: Simple Signals. One valid bearing resolves an anomaly
   * signal (range, steady observation and line of sight still apply). Absent =
   * off (the default); only `true` is stored. No settings UI yet (P06.2).
   */
  readonly simpleSignals?: true;
}

export const DEFAULT_CONTROLS: FlightControls = Object.freeze({ bindings: DEFAULT_BINDINGS, mouseAim: false, zoom: 1, flightMode: 'normal' });

/** P06.1: Simple Signals on or off (for the settings UI of P06.2); every other control is kept. */
export function withSimpleSignals(c: FlightControls, on: boolean): FlightControls {
  const out: FlightControls = { bindings: c.bindings, mouseAim: c.mouseAim, zoom: c.zoom, flightMode: c.flightMode, ...(c.advice === 'critical' ? { advice: 'critical' as const } : {}) };
  return on ? { ...out, simpleSignals: true } : out;
}

/** Persistent gameplay changes of one sector (same shape as sector/model.ts SectorSave). */
export interface SectorRecord {
  readonly done: readonly string[];
  readonly surveyed: boolean;
  /** v8: loot still inside partly taken containers (local id -> resource counts). */
  readonly left?: Readonly<Record<string, Readonly<Record<string, number>>>> | undefined;
}

export const FREEROAM_VERSION = 10;
/** Where a profile without navigation data starts (the catalogue's start galaxy; checked by a test). */
export const START_GALAXY = 'milky-way';
const GALAXY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SYSTEM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_GALAXIES = 64;
const MAX_SYSTEMS = 4096;
const MAX_COUNT = 1_000_000_000;
const MAX_TIME = 8_640_000_000_000_000; // Date range limit
/** Local POI ids (mirrors sector/model.ts POI_ID; this module must not import the sector code). */
const POI_ID = /^[a-z]+(?:-[0-9]+(?:\.[0-9]+)?)?$|^gate:[a-z0-9-]+\/[a-z0-9-]+$/;
const RESOURCE_ID = /^[a-z]+(?:-[a-z]+)*$/;
const MAX_DONE = 256;
const MAX_RESOURCES = 32;
const MAX_STACK = 999_999;
const SHIP_ID = /^[a-z]+(?:-[a-z]+)*$/;
const MODULE_ID = /^[a-z]+(?:-[a-z]+)*$/;
const SLOT_ID = /^[a-z]+$/;
const MAX_SHIPS = 32;
const MAX_SLOTS = 8;
const MAX_MODULES = 8;
const MAX_LEFT = 32;
const MAX_STORED_KINDS = 32;
const MAX_STORED_COUNT = 99;
const MILESTONE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_MILESTONES = 64;

export const EMPTY_PROFILE: FreeRoamProfile = Object.freeze({
  createdAt: 0,
  sessions: 0,
  flightSeconds: 0,
  beaconsCharted: 0,
  surveysCompleted: 0,
  bestSurveyTicks: 0,
  currentGalaxy: START_GALAXY,
  visitedGalaxies: Object.freeze([START_GALAXY]),
  chartedSystems: Object.freeze([]),
  galaxySurveys: Object.freeze({}),
  currentSystem: '',
  visitedSystems: Object.freeze([]),
  sectors: Object.freeze({}),
  cargo: Object.freeze({}),
  fleet: STARTER_SAVED_FLEET,
  lostCargo: null,
  modules: Object.freeze({}),
  milestones: Object.freeze([]),
  progression: EMPTY_PROGRESSION,
  savedAt: 0,
  resume: null,
  ordnance: initialOrdnance(),
});

/** A system id, or '' (= the current galaxy's gateway). */
function systemRef(f: Fix, v: unknown): string {
  if (v === undefined || v === '') return '';
  if (typeof v === 'string' && SYSTEM_ID.test(v)) return v;
  f.repaired = true;
  return '';
}

function idList(f: Fix, v: unknown, pattern: RegExp, max: number, fallback: readonly string[]): readonly string[] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v)) {
    f.repaired = true;
    return fallback;
  }
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string' && pattern.test(x) && !out.includes(x) && out.length < max) out.push(x);
    else f.repaired = true;
  }
  return out;
}

function countMap(f: Fix, v: unknown): Readonly<Record<string, number>> {
  if (v === undefined) return {};
  if (!isObj(v)) {
    f.repaired = true;
    return {};
  }
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (GALAXY_ID.test(k) && Object.keys(out).length < MAX_GALAXIES && typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_COUNT) out[k] = n;
    else f.repaired = true;
  }
  return out;
}

function sectorMap(f: Fix, v: unknown): Readonly<Record<string, SectorRecord>> {
  if (v === undefined) return {};
  if (!isObj(v)) {
    f.repaired = true;
    return {};
  }
  const out: Record<string, SectorRecord> = {};
  for (const [id, rec] of Object.entries(v)) {
    if (!SYSTEM_ID.test(id) || !isObj(rec) || Object.keys(out).length >= MAX_SYSTEMS) {
      f.repaired = true;
      continue;
    }
    const done = idList(f, rec['done'], POI_ID, MAX_DONE, []);
    const surveyed = rec['surveyed'] === true;
    if (rec['surveyed'] !== undefined && typeof rec['surveyed'] !== 'boolean') f.repaired = true;
    const left = leftMap(f, rec['left'], done);
    if (done.length > 0 || surveyed || left) out[id] = left ? { done, surveyed, left } : { done, surveyed };
  }
  return out;
}

/** Loot left in partly taken containers; ids already done cannot also hold loot. Undefined = none. */
function leftMap(f: Fix, v: unknown, done: readonly string[]): Readonly<Record<string, Readonly<Record<string, number>>>> | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) {
    f.repaired = true;
    return undefined;
  }
  const out: Record<string, Readonly<Record<string, number>>> = {};
  for (const [id, loot] of Object.entries(v)) {
    const cargo = POI_ID.test(id) && !done.includes(id) && Object.keys(out).length < MAX_LEFT ? cargoMap(f, loot) : {};
    if (Object.keys(cargo).length > 0) out[id] = cargo;
    else f.repaired = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Stored modules: module ids with counts 1..99. */
function moduleStore(f: Fix, v: unknown): Readonly<Record<string, number>> {
  if (v === undefined) return {};
  if (!isObj(v)) {
    f.repaired = true;
    return {};
  }
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (MODULE_ID.test(k) && Object.keys(out).length < MAX_STORED_KINDS && typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_STORED_COUNT) out[k] = n;
    else f.repaired = true;
  }
  return out;
}

function cargoMap(f: Fix, v: unknown): Readonly<Record<string, number>> {
  if (v === undefined) return {};
  if (!isObj(v)) {
    f.repaired = true;
    return {};
  }
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (RESOURCE_ID.test(k) && Object.keys(out).length < MAX_RESOURCES && typeof n === 'number' && Number.isInteger(n) && n > 0) out[k] = Math.min(n, MAX_STACK);
    else f.repaired = true;
  }
  return out;
}

const MAX_COORD = 100_000;

function lostCargoField(f: Fix, v: unknown): LostCargo | null {
  if (v === undefined || v === null) return null;
  const ok = isObj(v) && typeof v['systemId'] === 'string' && SYSTEM_ID.test(v['systemId']) && typeof v['x'] === 'number' && typeof v['y'] === 'number' && Number.isFinite(v['x']) && Number.isFinite(v['y']) && Math.abs(v['x']) <= MAX_COORD && Math.abs(v['y']) <= MAX_COORD;
  if (!ok) {
    f.repaired = true;
    return null;
  }
  const cargo = cargoMap(f, v['cargo']);
  if (Object.keys(cargo).length === 0) {
    f.repaired = true;
    return null;
  }
  return { systemId: v['systemId'] as string, x: v['x'] as number, y: v['y'] as number, cargo };
}

function resumeField(f: Fix, v: unknown): ResumePoint | null {
  if (v === undefined || v === null) return null;
  const ok =
    isObj(v) &&
    typeof v['systemId'] === 'string' &&
    SYSTEM_ID.test(v['systemId']) &&
    [v['x'], v['y'], v['heading']].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD);
  if (!ok) {
    f.repaired = true;
    return null;
  }
  return { systemId: v['systemId'] as string, x: v['x'] as number, y: v['y'] as number, heading: v['heading'] as number };
}

/** Sanitize saved flight controls (also used by the shared Free Roam prefs record, saveSlots.ts). */
export function sanitizeControls(v: unknown): { controls: FlightControls; repaired: boolean } {
  const f: Fix = { repaired: false };
  const controls = controlsField(f, v);
  return { controls, repaired: f.repaired };
}

function controlsField(f: Fix, v: unknown): FlightControls {
  if (v === undefined) return DEFAULT_CONTROLS;
  if (!isObj(v)) {
    f.repaired = true;
    return DEFAULT_CONTROLS;
  }
  const b = sanitizeBindings(v['bindings']);
  if (b.repaired) f.repaired = true;
  const mouseAim = v['mouseAim'] === true;
  if (v['mouseAim'] !== undefined && typeof v['mouseAim'] !== 'boolean') f.repaired = true;
  const z = v['zoom'];
  const zoomOk = typeof z === 'number' && Number.isFinite(z) && z >= 0.5 && z <= 2;
  if (z !== undefined && !zoomOk) f.repaired = true;
  // P04.3: anything but exactly 'realistic' flies NORMAL (a missing field is an older save, not a repair)
  const m = v['flightMode'];
  if (m !== undefined && m !== 'normal' && m !== 'realistic') f.repaired = true;
  const out: FlightControls = { bindings: b.bindings, mouseAim, zoom: zoomOk ? (z as number) : 1, flightMode: m === 'realistic' ? 'realistic' : 'normal' };
  // P05.2: only 'critical' is stored (absent = all advice, so older saves read unchanged)
  const adv = v['advice'];
  if (adv !== undefined && adv !== 'critical') f.repaired = true;
  // P06.1: only `true` is stored (absent = off)
  const simple = v['simpleSignals'];
  if (simple !== undefined && simple !== true) f.repaired = true;
  const withAdvice: FlightControls = adv === 'critical' ? { ...out, advice: 'critical' } : out;
  return simple === true ? { ...withAdvice, simpleSignals: true } : withAdvice;
}

function fleetField(f: Fix, v: unknown): SavedFleet {
  if (v === undefined) return STARTER_SAVED_FLEET;
  if (!isObj(v)) {
    f.repaired = true;
    return STARTER_SAVED_FLEET;
  }
  const owned = idList(f, v['owned'], SHIP_ID, MAX_SHIPS, [STARTER_SHIP_ID]);
  const ownedAll = owned.includes(STARTER_SHIP_ID) ? owned : [STARTER_SHIP_ID, ...owned];
  if (ownedAll !== owned) f.repaired = true;
  const a = v['active'];
  const active = typeof a === 'string' && ownedAll.includes(a) ? a : ((f.repaired = true), STARTER_SHIP_ID);
  const loadouts: Record<string, Record<string, readonly string[]>> = {};
  const raw = v['loadouts'];
  if (raw !== undefined && !isObj(raw)) f.repaired = true;
  if (isObj(raw)) {
    for (const [ship, l] of Object.entries(raw)) {
      if (!ownedAll.includes(ship) || !isObj(l) || Object.keys(l).length > MAX_SLOTS) {
        f.repaired = true;
        continue;
      }
      const slots: Record<string, readonly string[]> = {};
      for (const [slot, ids] of Object.entries(l)) {
        if (SLOT_ID.test(slot) && Array.isArray(ids) && ids.length <= MAX_MODULES && ids.every((x) => typeof x === 'string' && MODULE_ID.test(x))) slots[slot] = [...(ids as string[])];
        else f.repaired = true;
      }
      loadouts[ship] = slots;
    }
  }
  // P03B: weapon setups (shape only; the Free Roam chunk validates the weapons per ship)
  const weapons: Record<string, { start: string; rotation: string[] }> = {};
  const rw = v['weapons'];
  if (rw !== undefined && !isObj(rw)) f.repaired = true;
  if (isObj(rw)) {
    for (const [ship, w] of Object.entries(rw)) {
      const rot = isObj(w) ? w['rotation'] : undefined;
      const ok = ownedAll.includes(ship) && isObj(w) && typeof w['start'] === 'string' && WEAPON_REF.test(w['start']) && Array.isArray(rot) && rot.length <= MAX_WEAPONS && rot.every((x) => typeof x === 'string' && WEAPON_REF.test(x));
      if (ok) weapons[ship] = { start: w['start'] as string, rotation: [...(rot as string[])] };
      else f.repaired = true;
    }
  }
  return Object.keys(weapons).length ? { active, owned: ownedAll, loadouts, weapons } : { active, owned: ownedAll, loadouts };
}

const WEAPON_REF = /^[a-z]+(?:-[a-z]+)*$/;
const MAX_WEAPONS = 8;

/* P05.1 crew (shapes and bounds only; crew/persistence.ts checks ids, ownership and seats) */
const CREW_ID = /^[a-z]+(?:-[a-z]+)*$/;
const MAX_CREW_IDS = 32;
const MAX_CREW_SHIPS = 16;
const MAX_SEATS_PER_SHIP = 8;

function crewField(f: Fix, v: unknown): SavedCrew | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) return ((f.repaired = true), undefined);
  const hired = idList(f, v['hired'], CREW_ID, MAX_CREW_IDS, []);
  const paid = idList(f, v['paid'], CREW_ID, MAX_CREW_IDS, []);
  const seats: Record<string, readonly string[]> = {};
  const raw = v['seats'];
  if (raw !== undefined && !isObj(raw)) f.repaired = true;
  if (isObj(raw)) {
    for (const [ship, list] of Object.entries(raw)) {
      if (!SHIP_ID.test(ship) || Object.keys(seats).length >= MAX_CREW_SHIPS) {
        f.repaired = true;
        continue;
      }
      const ids = idList(f, list, CREW_ID, MAX_SEATS_PER_SHIP, []);
      if (ids.length) seats[ship] = ids;
      else if (Array.isArray(list) && list.length === 0) f.repaired = true; // empty seat lists are never written
    }
  }
  // the empty crew is no field at all (an old save and a save that never hired look the same)
  if (!hired.length && !paid.length && !Object.keys(seats).length) return ((f.repaired = true), undefined);
  const d = v['doctrine'];
  if (d !== undefined && d !== 'safety') f.repaired = true; // 'balanced' is never written; anything else is junk
  return d === 'safety' ? { hired, paid, seats, doctrine: 'safety' } : { hired, paid, seats };
}

function ordnanceField(f: Fix, v: unknown): Readonly<Record<string, number>> {
  const r = cleanOrdnance(v);
  if (r.repaired) f.repaired = true;
  return r.counts;
}

/* v9 progression (shapes only) */
const MISSION_ID = /^(?:story|chain)-[a-z]+(?:-[a-z]+)*$|^c:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*:[0-9]:[0-9]$/;
const TARGET_REF = /^$|^-$|^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*(?:#[a-z]+(?:-[0-9]+(?:\.[0-9]+)?)?)?$/;
const WORD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOG_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*(?:#[a-z]+(?:-[0-9]+(?:\.[0-9]+)?)?)?)?$/;
const MAX_ACTIVE_MISSIONS = 8;
const MAX_MISSION_IDS = 512;
const MAX_OBJECTIVES = 4;
const MAX_MARKS = 9_999_999;
const MAX_LOG = 512;

const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/* Economy pass: the marks history and bounty windows (bounded; shapes only) */
const LEDGER_HISTORY = 24;
const LEDGER_RECENT = 48;
const LEDGER_KIND = /^[a-z]+$/;
const LEDGER_ID = /^[a-z]+:[a-z0-9:#/.-]{1,90}$/;
const MAX_BOUNTY_SYSTEMS = 128;
const MAX_SEQ = 2 ** 52;

function ledgerField(f: Fix, v: unknown): SavedLedger | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) return ((f.repaired = true), undefined);
  const seq = int(v['seq'], 0, MAX_SEQ) ?? ((f.repaired = true), 0);
  const history: SavedLedgerEntry[] = [];
  const rawH = Array.isArray(v['history']) ? v['history'] : ((f.repaired ||= v['history'] !== undefined), []);
  for (const e of rawH.slice(-LEDGER_HISTORY)) {
    const ok = isObj(e) && int(e['seq'], 1, MAX_SEQ) !== null && typeof e['kind'] === 'string' && LEDGER_KIND.test(e['kind']) && typeof e['label'] === 'string' && e['label'].length <= 64 && int(e['delta'], -MAX_MARKS, MAX_MARKS) !== null && int(e['balance'], 0, MAX_MARKS) !== null && (e['refunded'] === undefined || typeof e['refunded'] === 'boolean');
    if (!ok) {
      f.repaired = true;
      continue;
    }
    const entry = { seq: e['seq'] as number, kind: e['kind'] as string, label: e['label'] as string, delta: e['delta'] as number, balance: e['balance'] as number };
    history.push(e['refunded'] === true ? { ...entry, refunded: true } : entry);
  }
  if (rawH.length > LEDGER_HISTORY) f.repaired = true;
  const rawR = Array.isArray(v['recent']) ? v['recent'] : ((f.repaired ||= v['recent'] !== undefined), []);
  const recent = rawR.filter((x): x is string => typeof x === 'string' && LEDGER_ID.test(x)).slice(-LEDGER_RECENT);
  if (recent.length !== rawR.length) f.repaired = true;
  return { seq: Math.max(seq, ...history.map((e) => e.seq)), history, recent };
}

function bountyField(f: Fix, v: unknown, jumps: number): Readonly<Record<string, { readonly paid: number; readonly since: number }>> | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) return ((f.repaired = true), undefined);
  const out: Record<string, { paid: number; since: number }> = {};
  for (const [id, w] of Object.entries(v)) {
    const ok = SYSTEM_ID.test(id) && isObj(w) && int(w['paid'], 0, MAX_MARKS) !== null && int(w['since'], 0, jumps) !== null && Object.keys(out).length < MAX_BOUNTY_SYSTEMS;
    if (ok) out[id] = { paid: w['paid'] as number, since: w['since'] as number };
    else f.repaired = true;
  }
  return out;
}

function contractField(f: Fix, v: unknown): SavedContract | null {
  if (!isObj(v)) return ((f.repaired = true), null);
  const type = v['type'];
  const station = v['station'];
  const target = v['target'];
  const resource = v['resource'];
  const count = int(v['count'], 1, 999);
  const marks = int(v['marks'], 0, MAX_MARKS);
  const deadline = int(v['deadline'], 0, 999);
  const difficulty = int(v['difficulty'], 1, 5);
  const ok = typeof type === 'string' && WORD_ID.test(type) && typeof station === 'string' && SYSTEM_ID.test(station) && typeof target === 'string' && TARGET_REF.test(target) && typeof resource === 'string' && (resource === '' || RESOURCE_ID.test(resource)) && count !== null && marks !== null && deadline !== null && difficulty !== null;
  if (!ok) return ((f.repaired = true), null);
  return { type: type as string, station: station as string, target: target as string, count: count!, resource: resource as string, marks: marks!, deadline: deadline!, difficulty: difficulty! };
}

function missionsField(f: Fix, v: unknown): SavedMissions {
  const D = EMPTY_PROGRESSION.missions;
  if (v === undefined) return D;
  if (!isObj(v)) return ((f.repaired = true), D);
  const jumps = int(v['jumps'], 0, MAX_COUNT) ?? ((f.repaired ||= v['jumps'] !== undefined), 0);
  const completed = idList(f, v['completed'], MISSION_ID, MAX_MISSION_IDS, []);
  const claimed = idList(f, v['claimed'], MISSION_ID, MAX_MISSION_IDS, []).filter((id) => completed.includes(id) || ((f.repaired = true), false));
  const failed = idList(f, v['failed'], MISSION_ID, MAX_MISSION_IDS, []).filter((id) => !completed.includes(id) || ((f.repaired = true), false));
  const active: SavedActiveMission[] = [];
  const rawActive = v['active'];
  if (rawActive !== undefined && !Array.isArray(rawActive)) f.repaired = true;
  for (const m of Array.isArray(rawActive) ? rawActive : []) {
    const ok = isObj(m) && typeof m['id'] === 'string' && MISSION_ID.test(m['id']) && !completed.includes(m['id']) && !active.some((a) => a.id === m['id']) && active.length < MAX_ACTIVE_MISSIONS;
    const progress = ok && Array.isArray(m['progress']) && m['progress'].length <= MAX_OBJECTIVES && m['progress'].every((x) => int(x, 0, 999_999) !== null) ? (m['progress'] as number[]) : null;
    const targets = ok && Array.isArray(m['targets']) && m['targets'].length <= MAX_OBJECTIVES && m['targets'].every((x) => typeof x === 'string' && TARGET_REF.test(x)) ? (m['targets'] as string[]) : null;
    const at = ok ? int(m['at'], 0, jumps) : null;
    if (!ok || !progress || !targets || at === null || progress.length !== targets.length) {
      f.repaired = true;
      continue;
    }
    const isContract = (m['id'] as string).startsWith('c:');
    const contract = isContract ? contractField(f, m['contract']) : null;
    if (isContract && !contract) continue;
    if (!isContract && m['contract'] !== undefined) f.repaired = true;
    active.push(contract ? { id: m['id'] as string, at, progress: [...progress], targets: [...targets], contract } : { id: m['id'] as string, at, progress: [...progress], targets: [...targets] });
  }
  const ready: Record<string, SavedContract> = {};
  const rawReady = v['ready'];
  if (rawReady !== undefined && !isObj(rawReady)) f.repaired = true;
  if (isObj(rawReady)) {
    for (const [id, spec] of Object.entries(rawReady)) {
      const c = MISSION_ID.test(id) && id.startsWith('c:') && completed.includes(id) && !claimed.includes(id) ? contractField(f, spec) : ((f.repaired = true), null);
      if (c) ready[id] = c;
    }
  }
  return { jumps, active, completed, claimed, failed, ready };
}

function logField(f: Fix, v: unknown): SavedLog {
  const D = EMPTY_PROGRESSION.log;
  if (v === undefined) return D;
  if (!isObj(v)) return ((f.repaired = true), D);
  return {
    anomalies: idList(f, v['anomalies'], LOG_KEY, MAX_LOG, []),
    wrecks: idList(f, v['wrecks'], LOG_KEY, MAX_LOG, []),
    factions: idList(f, v['factions'], WORD_ID, 32, []),
    facts: idList(f, v['facts'], LOG_KEY, MAX_LOG, []),
    kills: int(v['kills'], 0, MAX_COUNT) ?? ((f.repaired ||= v['kills'] !== undefined), 0),
    acquired: cargoMap(f, v['acquired']),
  };
}

function upgradesField(f: Fix, v: unknown): Readonly<Record<string, Readonly<Record<string, number>>>> {
  if (v === undefined) return {};
  if (!isObj(v)) return ((f.repaired = true), {});
  const out: Record<string, Record<string, number>> = {};
  for (const [ship, tracks] of Object.entries(v)) {
    if (!SHIP_ID.test(ship) || !isObj(tracks) || Object.keys(out).length >= MAX_SHIPS) {
      f.repaired = true;
      continue;
    }
    const t: Record<string, number> = {};
    for (const [k, n] of Object.entries(tracks)) {
      if (WORD_ID.test(k) && Object.keys(t).length < 16 && int(n, 1, 3) !== null) t[k] = n as number;
      else f.repaired = true;
    }
    if (Object.keys(t).length) out[ship] = t;
  }
  return out;
}

/** P09.1 faction heat (shapes only: Free Roam drops unknown factions on load). */
function heatField(f: Fix, v: unknown): Record<string, number> | null {
  if (v === undefined) return null;
  const out: Record<string, number> = {};
  const es = isObj(v) ? Object.entries(v) : [];
  if (!isObj(v) || es.length > 8) f.repaired = true;
  for (const [k, n] of es.slice(0, 8)) {
    const x = int(n, 0, 100);
    if (x === null || !WORD_ID.test(k)) f.repaired = true;
    else if (x) out[k] = x;
  }
  return Object.keys(out).length ? out : null;
}

function progressionField(f: Fix, v: unknown): SavedProgression {
  const D = EMPTY_PROGRESSION;
  if (v === undefined) return D;
  if (!isObj(v)) return ((f.repaired = true), D);
  const fuel = v['fuel'];
  const fuelOk = isObj(fuel) && typeof fuel['starter'] === 'boolean' && int(fuel['arrivals'], 0, MAX_COUNT) !== null && int(fuel['aidAt'], -1, MAX_COUNT) !== null;
  if (fuel !== undefined && !fuelOk) f.repaired = true;
  const missions = missionsField(f, v['missions']);
  const ledger = ledgerField(f, v['ledger']);
  const bounty = bountyField(f, v['bounty'], missions.jumps);
  const heat = heatField(f, v['heat']);
  return {
    marks: int(v['marks'], 0, MAX_MARKS) ?? ((f.repaired ||= v['marks'] !== undefined), 0),
    missions,
    upgrades: upgradesField(f, v['upgrades']),
    licences: idList(f, v['licences'], WORD_ID, 16, []),
    log: logField(f, v['log']),
    fuel: fuelOk ? { starter: fuel['starter'] as boolean, arrivals: fuel['arrivals'] as number, aidAt: Math.min(fuel['aidAt'] as number, fuel['arrivals'] as number) } : D.fuel,
    ...(ledger ? { ledger } : {}),
    ...(bounty ? { bounty } : {}),
    ...(heat ? { heat } : {}),
  };
}

export const FREEROAM_SPEC: RecordSpec<FreeRoamProfile> = Object.freeze({
  key: STORAGE_KEYS.freeroam,
  version: FREEROAM_VERSION,
  defaults: EMPTY_PROFILE,
  sanitize(doc: Record<string, unknown>) {
    const f: Fix = { repaired: false };
    const D = EMPTY_PROFILE;
    const data: FreeRoamProfile = {
      createdAt: intField(f, doc['createdAt'], D.createdAt, MAX_TIME),
      sessions: intField(f, doc['sessions'], D.sessions, MAX_COUNT),
      flightSeconds: intField(f, doc['flightSeconds'], D.flightSeconds, MAX_COUNT),
      beaconsCharted: intField(f, doc['beaconsCharted'], D.beaconsCharted, MAX_COUNT),
      surveysCompleted: intField(f, doc['surveysCompleted'], D.surveysCompleted, MAX_COUNT),
      bestSurveyTicks: intField(f, doc['bestSurveyTicks'], D.bestSurveyTicks, MAX_COUNT),
      currentGalaxy: typeof doc['currentGalaxy'] === 'string' && GALAXY_ID.test(doc['currentGalaxy']) ? doc['currentGalaxy'] : ((f.repaired ||= doc['currentGalaxy'] !== undefined), D.currentGalaxy),
      visitedGalaxies: idList(f, doc['visitedGalaxies'], GALAXY_ID, MAX_GALAXIES, D.visitedGalaxies),
      chartedSystems: idList(f, doc['chartedSystems'], SYSTEM_ID, MAX_SYSTEMS, D.chartedSystems),
      galaxySurveys: countMap(f, doc['galaxySurveys']),
      currentSystem: systemRef(f, doc['currentSystem']),
      visitedSystems: idList(f, doc['visitedSystems'], SYSTEM_ID, MAX_SYSTEMS, D.visitedSystems),
      sectors: sectorMap(f, doc['sectors']),
      cargo: cargoMap(f, doc['cargo']),
      fleet: fleetField(f, doc['fleet']),
      lostCargo: lostCargoField(f, doc['lostCargo']),
      modules: moduleStore(f, doc['modules']),
      milestones: idList(f, doc['milestones'], MILESTONE_ID, MAX_MILESTONES, D.milestones),
      progression: progressionField(f, doc['progression']),
      savedAt: intField(f, doc['savedAt'], 0, MAX_TIME),
      resume: resumeField(f, doc['resume']),
      ordnance: ordnanceField(f, doc['ordnance']),
    };
    const crew = crewField(f, doc['crew']);
    return { data: crew ? { ...data, crew } : data, repaired: f.repaired };
  },
  migrations: {
    // v1 -> v2: navigation fields start empty (the sanitizer fills the defaults). Lifetime
    // stats are kept; earlier flight-test surveys had no galaxy, so they chart nothing.
    1: (doc: Record<string, unknown>) => ({ ...doc, version: 2 }),
    // v2 -> v3: the pilot stands at the current galaxy's gateway ('') and has visited
    // no systems yet; charted systems stay charted (they count as known on the system map).
    2: (doc: Record<string, unknown>) => ({ ...doc, version: 3 }),
    // v3 -> v4: systems charted by earlier survey runs count as surveyed, so their sector
    // survey cannot be completed (and credited) a second time. Cargo starts empty.
    3: (doc: Record<string, unknown>) => {
      const charted = Array.isArray(doc['chartedSystems']) ? doc['chartedSystems'].filter((x): x is string => typeof x === 'string' && SYSTEM_ID.test(x)) : [];
      const sectors: Record<string, SectorRecord> = {};
      for (const id of charted) sectors[id] = { done: [], surveyed: true };
      return { ...doc, version: 4, sectors, cargo: {} };
    },
    // v4 -> v5: default controls (the sanitizer fills them); nothing else changes.
    4: (doc: Record<string, unknown>) => ({ ...doc, version: 5 }),
    // v5 -> v6: the starter fleet (the pilot owns and flies the Petrel). Saved bindings gain
    // the new boost action through sanitizeBindings (free default keys, not a repair). The
    // cargo hold is kept as it is, even above the starter's capacity.
    5: (doc: Record<string, unknown>) => ({ ...doc, version: 6, fleet: STARTER_SAVED_FLEET }),
    // v6 -> v7: no cargo wreck yet.
    6: (doc: Record<string, unknown>) => ({ ...doc, version: 7, lostCargo: null }),
    // v7 -> v8: empty module storage, no milestone claimed yet (milestones already reached can
    // be claimed once at a station), no partly taken containers. Cargo and progress are kept.
    7: (doc: Record<string, unknown>) => ({ ...doc, version: 8, modules: {}, milestones: [] }),
    // v8 -> v9: no marks, missions, upgrades or licences yet; an empty exploration record
    // (lifetime counters that already exist, such as systems visited, are derived from the
    // navigation fields). The starter reactor cells are granted once on the next load.
    8: (doc: Record<string, unknown>) => ({ ...doc, version: 9, progression: EMPTY_PROGRESSION }),
    // v9 -> v10: save slots. The record becomes slot 1 (same key). Flight controls move to the
    // shared Free Roam prefs record (saveSlots.ts seeds it from this record's `controls` before
    // the slot is loaded; the v9 original is kept at `<key>:v9`). Never saved by v10, no
    // resume point: the pilot re-enters the current system at its arrival.
    9: (doc: Record<string, unknown>) => {
      const { controls: _moved, ...rest } = doc;
      return { ...rest, version: 10, savedAt: 0, resume: null };
    },
  },
});

export function loadProfile(store: KeyValueStore): RecordLoad<FreeRoamProfile> {
  return loadRecord(store, FREEROAM_SPEC);
}

export function saveProfile(store: KeyValueStore, profile: FreeRoamProfile): boolean {
  return writeRecord(store, FREEROAM_SPEC, profile);
}

/* pure progression updates */

export function startSession(p: FreeRoamProfile, nowMs: number): FreeRoamProfile {
  return { ...p, createdAt: p.createdAt > 0 ? p.createdAt : Math.max(0, Math.floor(nowMs)), sessions: p.sessions + 1 };
}

export function addFlight(p: FreeRoamProfile, seconds: number, beacons: number): FreeRoamProfile {
  return { ...p, flightSeconds: p.flightSeconds + Math.max(0, Math.floor(seconds)), beaconsCharted: p.beaconsCharted + Math.max(0, Math.floor(beacons)) };
}

export function recordSurvey(p: FreeRoamProfile, ticks: number): { profile: FreeRoamProfile; newBest: boolean } {
  const t = Math.max(1, Math.floor(ticks));
  const newBest = p.bestSurveyTicks === 0 || t < p.bestSurveyTicks;
  return { profile: { ...p, surveysCompleted: p.surveysCompleted + 1, bestSurveyTicks: newBest ? t : p.bestSurveyTicks }, newBest };
}

/** Store navigation progress (shape matches galaxy/progress.ts ExplorationProgress). */
export function withNavigation(
  p: FreeRoamProfile,
  nav: { readonly current: string; readonly visited: readonly string[]; readonly charted: readonly string[]; readonly surveys: Readonly<Record<string, number>>; readonly system: string; readonly visitedSystems: readonly string[] },
): FreeRoamProfile {
  return { ...p, currentGalaxy: nav.current, visitedGalaxies: [...nav.visited], chartedSystems: [...nav.charted], galaxySurveys: { ...nav.surveys }, currentSystem: nav.system, visitedSystems: [...nav.visitedSystems] };
}

/** Record completed sector interactions (and optionally the survey) for one system. Idempotent. */
export function withSectorProgress(p: FreeRoamProfile, systemId: string, doneIds: readonly string[], surveyed = false): FreeRoamProfile {
  const prev: SectorRecord = p.sectors[systemId] ?? { done: [], surveyed: false };
  const done = [...prev.done];
  for (const id of doneIds) if (!done.includes(id) && done.length < MAX_DONE) done.push(id);
  if (done.length === prev.done.length && (prev.surveyed || !surveyed)) return p;
  // a completed id never keeps loot behind
  let left = prev.left;
  if (left && doneIds.some((id) => id in left!)) {
    const l = { ...left };
    for (const id of doneIds) delete l[id];
    left = Object.keys(l).length ? l : undefined;
  }
  const rec: SectorRecord = left ? { done, surveyed: prev.surveyed || surveyed, left } : { done, surveyed: prev.surveyed || surveyed };
  return { ...p, sectors: { ...p.sectors, [systemId]: rec } };
}

/**
 * Record what is still inside a partly taken container (or an overflowing
 * reward) at `id`. Empty `left` completes the id (it joins `done`). Idempotent.
 */
export function withLeftLoot(p: FreeRoamProfile, systemId: string, id: string, left: readonly { readonly resource: string; readonly amount: number }[]): FreeRoamProfile {
  if (!SYSTEM_ID.test(systemId) || !POI_ID.test(id)) return p;
  const prev: SectorRecord = p.sectors[systemId] ?? { done: [], surveyed: false };
  if (prev.done.includes(id)) return p; // already complete: nothing can be put back
  const cargo: Record<string, number> = {};
  for (const e of left) if (RESOURCE_ID.test(e.resource) && Number.isInteger(e.amount) && e.amount > 0) cargo[e.resource] = Math.min(MAX_STACK, (cargo[e.resource] ?? 0) + e.amount);
  if (Object.keys(cargo).length === 0) return withSectorProgress(p, systemId, [id]);
  const l = { ...(prev.left ?? {}) };
  if (!(id in l) && Object.keys(l).length >= MAX_LEFT) return p;
  l[id] = cargo;
  return { ...p, sectors: { ...p.sectors, [systemId]: { done: prev.done, surveyed: prev.surveyed, left: l } } };
}

/** Replace the station module storage (invalid entries dropped). */
export function withModules(p: FreeRoamProfile, modules: Readonly<Record<string, number>>): FreeRoamProfile {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(modules)) if (MODULE_ID.test(k) && Number.isInteger(n) && n > 0 && Object.keys(out).length < MAX_STORED_KINDS) out[k] = Math.min(n, MAX_STORED_COUNT);
  return { ...p, modules: out };
}

/** Mark a milestone reward as claimed. Idempotent. */
export function withMilestone(p: FreeRoamProfile, id: string): FreeRoamProfile {
  if (!MILESTONE_ID.test(id) || p.milestones.includes(id) || p.milestones.length >= MAX_MILESTONES) return p;
  return { ...p, milestones: [...p.milestones, id] };
}

/** Add resources to the cargo hold (non-positive amounts ignored, stacks capped). */
export function addCargo(p: FreeRoamProfile, loot: readonly { readonly resource: string; readonly amount: number }[]): FreeRoamProfile {
  if (loot.length === 0) return p;
  const cargo = { ...p.cargo };
  for (const e of loot) if (Number.isInteger(e.amount) && e.amount > 0) cargo[e.resource] = Math.min(MAX_STACK, (cargo[e.resource] ?? 0) + e.amount);
  return { ...p, cargo };
}

/** Replace the control settings (bindings, mouse aim, zoom). */
export function withFleet(p: FreeRoamProfile, fleet: SavedFleet): FreeRoamProfile {
  return { ...p, fleet };
}

/** Replace the hold (purchases, jettison); empty and invalid stacks are dropped. */
export function withCargo(p: FreeRoamProfile, cargo: Readonly<Record<string, number>>): FreeRoamProfile {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(cargo)) if (RESOURCE_ID.test(k) && Number.isInteger(n) && n > 0) out[k] = Math.min(n, MAX_STACK);
  return { ...p, cargo: out };
}

/**
 * The ship was destroyed at (x, y) in `systemId`: `share` of every common
 * stack (rounded down) leaves the hold for a new wreck; resources listed in
 * `keep` (the rare ones) stay aboard. Any previous wreck is lost. Pure; the
 * caller saves the result once, so one death drops cargo once.
 */
export function dropCargo(p: FreeRoamProfile, systemId: string, x: number, y: number, share: number, keep: readonly string[]): FreeRoamProfile {
  const cargo: Record<string, number> = { ...p.cargo };
  const lost: Record<string, number> = {};
  const k = Math.min(1, Math.max(0, Number.isFinite(share) ? share : 0));
  for (const [id, n] of Object.entries(p.cargo)) {
    if (keep.includes(id)) continue;
    const drop = Math.floor(n * k);
    if (drop <= 0) continue;
    lost[id] = drop;
    if (n - drop > 0) cargo[id] = n - drop;
    else delete cargo[id];
  }
  const ok = SYSTEM_ID.test(systemId) && Number.isFinite(x) && Number.isFinite(y);
  return { ...p, cargo, lostCargo: ok && Object.keys(lost).length > 0 ? { systemId, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, cargo: lost } : null };
}

/** Recover the cargo wreck into the hold (stacks capped); no-op without one. */
export function recoverCargo(p: FreeRoamProfile): FreeRoamProfile {
  if (!p.lostCargo) return p;
  const loot = Object.entries(p.lostCargo.cargo).map(([resource, amount]) => ({ resource, amount }));
  return { ...addCargo(p, loot), lostCargo: null };
}

/**
 * Take part of the cargo wreck (TAKE WHAT FITS): each taken stack moves into
 * the hold, never more than the wreck holds; the wreck goes once it is empty.
 */
export function recoverSome(p: FreeRoamProfile, taken: readonly { readonly resource: string; readonly amount: number }[]): FreeRoamProfile {
  const w = p.lostCargo;
  if (!w) return p;
  const rest: Record<string, number> = { ...w.cargo };
  const moved: { resource: string; amount: number }[] = [];
  for (const e of taken) {
    const n = Math.min(rest[e.resource] ?? 0, Number.isInteger(e.amount) && e.amount > 0 ? e.amount : 0);
    if (n <= 0) continue;
    moved.push({ resource: e.resource, amount: n });
    if (rest[e.resource]! - n > 0) rest[e.resource] = rest[e.resource]! - n;
    else delete rest[e.resource];
  }
  const q = addCargo(p, moved);
  return { ...q, lostCargo: Object.keys(rest).length ? { ...w, cargo: rest } : null };
}

/** Units in the cargo wreck (0 = none). */
export const lostCargoUnits = (p: FreeRoamProfile): number => (p.lostCargo ? Object.values(p.lostCargo.cargo).reduce((n, x) => n + x, 0) : 0);

/** Set (or clear) the resume point (v10). */
export function withResume(p: FreeRoamProfile, resume: ResumePoint | null): FreeRoamProfile {
  return p.resume === resume ? p : { ...p, resume };
}

/** "1:05.3" from simulation ticks (60 Hz). */
export function formatTicks(ticks: number): string {
  const tenths = Math.floor((Math.max(0, ticks) / 60) * 10);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`;
}

/** One-line summary for the title screen card. */
export function profileSummary(p: FreeRoamProfile): string {
  if (p.sessions === 0) return 'NEW PILOT · FLIGHT TEST';
  const best = p.bestSurveyTicks > 0 ? ` · BEST ${formatTicks(p.bestSurveyTicks)}` : '';
  return `SURVEYS ${p.surveysCompleted}${best}`;
}

/** Store the saved ammunition counts (P03B); invalid entries are cleaned, never raised above capacity. */
export function withOrdnance(p: FreeRoamProfile, ordnance: Readonly<Record<string, number>>): FreeRoamProfile {
  return { ...p, ordnance: cleanOrdnance(ordnance).counts };
}

/** P05.1: store the crew (crew/persistence.ts builds it); undefined = no crew, the field is removed. */
export function withCrew(p: FreeRoamProfile, crew: SavedCrew | undefined): FreeRoamProfile {
  const { crew: _old, ...rest } = p;
  return crew ? { ...rest, crew } : rest;
}

/** Store progression (v9; progression/persistence.ts builds it). */
export function withProgression(p: FreeRoamProfile, progression: SavedProgression): FreeRoamProfile {
  return { ...p, progression };
}
