/**
 * Combat P03C: cross-mode ship progression (one registry, `galaxia:fleet`).
 *
 * The gate: Classic Wave 20 COMPLETED. Detected two ways:
 *  - live: Classic reports `stageCleared` for stage >= CLASSIC_GATE_STAGE
 *    (markClassicComplete), which persists at once;
 *  - migration: an existing Classic record with bestStage > CLASSIC_GATE_STAGE.
 *    Classic records the stage a game ENDED on (`recordGameResult`), and a
 *    release build always starts at stage 1, so reaching stage 21 is only
 *    possible by clearing stage 20. Entering stage 20 (bestStage 20) is not
 *    enough.
 * The flag is monotonic: once set it is never cleared (deleting a Free Roam
 * slot or resetting nothing else touches it).
 *
 * Before the gate: nothing is read into or written to the registry, Free Roam
 * slots stay fully independent, Classic shows the original title and fighter.
 *
 * After the gate (FR-TD-89 / docs/freeroam/TECHNICAL_DECISIONS.md):
 *  - the registry's `ships` is the union of every Free Roam slot's owned
 *    ships, the registry itself and the starter (owned by every pilot);
 *    merge only (a ship is never removed), roster ids only, roster order, no
 *    duplicates;
 *  - every Free Roam slot gets the merged set when it loads (mergeOwned) and
 *    writes back each new acquisition (recordOwned);
 *  - Classic lists those ships in its title SHIP selector and flies the chosen
 *    one with its saved weapon setup from the active slot (or the ship's
 *    default setup); the legacy fighter stays the default.
 * Neither the Hangar nor the Armory nor Classic ever grants a ship: the only
 * way a ship enters the registry is a real Free Roam acquisition (or one that
 * already happened in some slot).
 *
 * Fail-safe: an unreadable registry is rebuilt from the slots (the gate is
 * re-detected from the Classic record); unknown ids are dropped; a newer
 * build's registry is read but never overwritten; storage failures leave
 * play unaffected (the merge is recomputed at the next load).
 */
import { CLASSIC_ORDNANCE, WEAPON_BY_ID, type WeaponId } from '../config/weapons.ts';
import { parseSave } from '../persistence/saveData.ts';
import type { KeyValueStore } from '../persistence/storage.ts';
import { STORAGE_KEYS } from '../shared/persistence/namespaces.ts';
import { isObj, loadRecord, parseRecord, writeRecord, type RecordSpec } from '../shared/persistence/record.ts';
import { activeSlot, SLOT_NUMBERS, slotKey, slotSpec } from './freeroam/saveSlots.ts';
import { cleanSetup, compatibleWeapons } from './freeroam/ships/armory.ts';
import { SHIP_BY_ID, STARTER_SHIP } from './freeroam/ships/roster.ts';
import { SHIP_IDS, type ShipId } from './freeroam/ships/types.ts';

/** Classic stage whose completion opens the gate (from the catalogue's Classic rules). */
export const CLASSIC_GATE_STAGE = CLASSIC_ORDNANCE.gateStage;

export interface FleetRegistry {
  /** Classic Wave 20 was completed (monotonic). */
  readonly classicComplete: boolean;
  /** Unlocked roster ships shared by every mode (empty before the gate). */
  readonly ships: readonly ShipId[];
  /** Ship chosen on Classic's title (null = the legacy fighter). */
  readonly classicShip: ShipId | null;
}

const isShip = (v: unknown): v is ShipId => typeof v === 'string' && (SHIP_IDS as readonly string[]).includes(v);
const rosterOrder = (ids: Iterable<unknown>): ShipId[] => {
  const set = new Set<string>();
  for (const id of ids) if (isShip(id)) set.add(id);
  return SHIP_IDS.filter((id) => set.has(id));
};

const EMPTY: FleetRegistry = Object.freeze({ classicComplete: false, ships: Object.freeze([]) as readonly ShipId[], classicShip: null });

export const FLEET_SPEC: RecordSpec<FleetRegistry> = Object.freeze({
  key: STORAGE_KEYS.fleet,
  version: 1,
  defaults: EMPTY,
  sanitize(doc: Record<string, unknown>) {
    const rawShips = Array.isArray(doc['ships']) ? (doc['ships'] as unknown[]) : [];
    const ships = rosterOrder(rawShips);
    const complete = doc['classicComplete'] === true;
    const cs = doc['classicShip'];
    const classicShip = isShip(cs) && ships.includes(cs) ? cs : null;
    const repaired = !Array.isArray(doc['ships']) || ships.length !== rawShips.length || typeof doc['classicComplete'] !== 'boolean' || (cs !== null && cs !== undefined && classicShip === null);
    return { data: { classicComplete: complete, ships, classicShip }, repaired };
  },
});

interface Read {
  readonly reg: FleetRegistry;
  readonly writable: boolean;
}

/** The registry (an unreadable one is copied to `galaxia:fleet:backup` first and then rebuilt; a newer one is read-only). */
function read(store: KeyValueStore): Read {
  const r = loadRecord(store, FLEET_SPEC);
  return { reg: r.data, writable: r.writable };
}

/** The Classic record's evidence that Wave 20 was completed (see the header). */
export function classicRecordShowsGate(store: KeyValueStore): boolean {
  const c = parseSave(store.read(STORAGE_KEYS.classic));
  return c.status !== 'corrupt' && c.data.bestStage > CLASSIC_GATE_STAGE;
}

/** Owned ships recorded in every Free Roam slot (read only, no migration written). */
export function slotsOwned(store: KeyValueStore): ShipId[] {
  const all: unknown[] = [];
  for (const n of SLOT_NUMBERS) {
    const r = parseRecord(store.read(slotKey(n)), slotSpec(n));
    if (r.status === 'missing' || r.status === 'corrupt') continue;
    const owned = (r.data.fleet as { readonly owned?: unknown }).owned;
    if (Array.isArray(owned)) all.push(...owned);
  }
  return rosterOrder(all);
}

const same = (a: FleetRegistry, b: FleetRegistry): boolean => a.classicComplete === b.classicComplete && a.classicShip === b.classicShip && a.ships.length === b.ships.length && a.ships.every((s, i) => s === b.ships[i]);

function commit(store: KeyValueStore, before: Read, next: FleetRegistry): FleetRegistry {
  if (before.writable && !same(before.reg, next)) writeRecord(store, FLEET_SPEC, { classicComplete: next.classicComplete, ships: [...next.ships], classicShip: next.classicShip });
  return next;
}

/**
 * Reconcile: detect the gate (registry flag or Classic record), and once open
 * merge every slot's ships (+ `extra`, + the starter) into the registry.
 * Before the gate it returns the empty registry and writes nothing.
 */
export function syncFleet(store: KeyValueStore, extra: readonly unknown[] = []): FleetRegistry {
  const before = read(store);
  const open = before.reg.classicComplete || classicRecordShowsGate(store);
  if (!open) return EMPTY;
  const ships = rosterOrder([STARTER_SHIP, ...before.reg.ships, ...slotsOwned(store), ...extra]);
  const classicShip = before.reg.classicShip && ships.includes(before.reg.classicShip) ? before.reg.classicShip : null;
  return commit(store, before, { classicComplete: true, ships, classicShip });
}

/** Classic just completed the gate stage: persist the milestone and merge (idempotent). */
export function markClassicComplete(store: KeyValueStore): FleetRegistry {
  const before = read(store);
  if (!before.reg.classicComplete) commit(store, before, { ...before.reg, classicComplete: true });
  return syncFleet(store);
}

/**
 * Free Roam slot load: the slot's owned ships merged with the registry (after
 * the gate), or `owned` unchanged (before it). Also writes the union back.
 */
export function mergeOwned(store: KeyValueStore, owned: readonly ShipId[]): readonly ShipId[] {
  const reg = syncFleet(store, owned);
  return reg.classicComplete ? rosterOrder([...owned, ...reg.ships]) : owned;
}

/** A Free Roam acquisition: add it to the registry (after the gate only). */
export function recordOwned(store: KeyValueStore, owned: readonly ShipId[]): void {
  syncFleet(store, owned);
}

/** Classic title: remember the chosen ship (null = legacy fighter). Only an unlocked ship, only after the gate. */
export function setClassicShip(store: KeyValueStore, id: string | null): FleetRegistry {
  const reg = syncFleet(store);
  if (!reg.classicComplete) return reg;
  const ship = isShip(id) && reg.ships.includes(id) ? id : null;
  return commit(store, read(store), { ...reg, classicShip: ship });
}

/* --------------------------------------------- Classic ship options (plain data) */

/** One selectable Classic ship: its name, sprite and weapons from the shared catalogue. */
export interface ClassicShipOption {
  readonly id: string;
  readonly name: string;
  readonly sprite: string;
  readonly compatible: readonly WeaponId[];
  readonly rotation: readonly WeaponId[];
  readonly start: WeaponId;
  /** Short weapon names in rotation order (title selector detail). */
  readonly weapons: string;
}

export interface ClassicFleet {
  readonly open: boolean;
  readonly ships: readonly ClassicShipOption[];
  readonly selected: string | null;
}

/** The weapon setup a ship has in the active Free Roam slot (or its default). */
function setupFor(store: KeyValueStore, id: ShipId): { start: WeaponId; rotation: readonly WeaponId[] } {
  const r = parseRecord(store.read(slotKey(activeSlot(store))), slotSpec(activeSlot(store)));
  const weapons = r.status === 'missing' || r.status === 'corrupt' ? undefined : (r.data.fleet as { readonly weapons?: unknown }).weapons;
  const raw = isObj(weapons) && isObj(weapons[id]) ? (weapons[id] as { start?: unknown; rotation?: unknown }) : undefined;
  return cleanSetup(id, raw);
}

export function classicOption(store: KeyValueStore, id: ShipId): ClassicShipOption {
  const ship = SHIP_BY_ID.get(id)!;
  const setup = setupFor(store, id);
  return {
    id,
    name: ship.name,
    sprite: ship.sprite,
    compatible: compatibleWeapons(id),
    rotation: setup.rotation,
    start: setup.start,
    weapons: setup.rotation.map((w) => WEAPON_BY_ID.get(w)?.short ?? w).join(' · '),
  };
}

/** What Classic's title needs: the gate, the unlocked ships and the remembered choice. */
export function classicFleet(store: KeyValueStore): ClassicFleet {
  const reg = syncFleet(store);
  if (!reg.classicComplete) return { open: false, ships: [], selected: null };
  return { open: true, ships: reg.ships.map((id) => classicOption(store, id)), selected: reg.classicShip };
}
