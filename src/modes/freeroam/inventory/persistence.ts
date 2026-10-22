/**
 * Inventory persistence interface (Free Roam Prompt 10). Pure.
 *
 * The later save system needs inventory and collection state without knowing
 * how the Free Roam profile stores it. This module gives it:
 *
 *  - InventorySnapshot: a plain, versioned, JSON-safe record of the hold, the
 *    module storage, the claimed milestones, the cargo wreck and, per sector,
 *    the collected ids (`done`) and loot left in partly taken containers;
 *  - snapshotOf / applySnapshot: profile <-> snapshot (the snapshot never
 *    carries navigation, controls or the fleet);
 *  - parseSnapshot: validates untrusted input with the profile's own sanitizer
 *    (one set of rules: ids, positive integer quantities, size caps);
 *  - InventoryRepository: load / save. profileRepository stores through the
 *    local slot record (slot 1 = `galaxia:freeroam` by default); memoryRepository
 *    keeps it in memory (tests). No network, no remote DB.
 */
import type { KeyValueStore } from '../../../persistence/storage.ts';
import { loadRecord, writeRecord, type RecordSpec } from '../../../shared/persistence/record.ts';
import { addCargo, EMPTY_PROFILE, FREEROAM_SPEC, recoverCargo, recoverSome, withLeftLoot, withSectorProgress, type FreeRoamProfile, type LostCargo, type SectorRecord } from '../profile.ts';

export const SNAPSHOT_FORMAT = 1;

export interface SectorCollection {
  /** Collected or completed ids (POIs, encounter sites, ore chips). */
  readonly done: readonly string[];
  readonly surveyed: boolean;
  /** Loot still inside partly taken containers (local id -> resource counts). */
  readonly left: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface InventorySnapshot {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly cargo: Readonly<Record<string, number>>;
  readonly modules: Readonly<Record<string, number>>;
  readonly milestones: readonly string[];
  readonly lostCargo: LostCargo | null;
  readonly sectors: Readonly<Record<string, SectorCollection>>;
}

export interface InventoryRepository {
  load(): InventorySnapshot;
  /** false when the write failed (storage full or unavailable); the game keeps running. */
  save(snapshot: InventorySnapshot): boolean;
}

export function snapshotOf(p: FreeRoamProfile): InventorySnapshot {
  const sectors: Record<string, SectorCollection> = {};
  for (const [id, r] of Object.entries(p.sectors)) sectors[id] = { done: [...r.done], surveyed: r.surveyed, left: { ...(r.left ?? {}) } };
  return { format: SNAPSHOT_FORMAT, cargo: { ...p.cargo }, modules: { ...p.modules }, milestones: [...p.milestones], lostCargo: p.lostCargo ? { ...p.lostCargo, cargo: { ...p.lostCargo.cargo } } : null, sectors };
}

/** The profile with the snapshot's inventory and collection state (everything else untouched). */
export function applySnapshot(p: FreeRoamProfile, s: InventorySnapshot): FreeRoamProfile {
  const sectors: Record<string, SectorRecord> = {};
  for (const [id, r] of Object.entries(s.sectors)) sectors[id] = Object.keys(r.left).length ? { done: r.done, surveyed: r.surveyed, left: r.left } : { done: r.done, surveyed: r.surveyed };
  return { ...p, cargo: s.cargo, modules: s.modules, milestones: s.milestones, lostCargo: s.lostCargo, sectors };
}

/** Validate untrusted input (a parsed JSON value). Invalid parts are dropped and reported as `repaired`. */
export function parseSnapshot(raw: unknown): { readonly snapshot: InventorySnapshot; readonly repaired: boolean } {
  const doc = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!doc || doc['format'] !== SNAPSHOT_FORMAT) return { snapshot: snapshotOf(EMPTY_PROFILE), repaired: raw !== undefined };
  const { data, repaired } = FREEROAM_SPEC.sanitize({ cargo: doc['cargo'], modules: doc['modules'], milestones: doc['milestones'], lostCargo: doc['lostCargo'], sectors: doc['sectors'] });
  return { snapshot: snapshotOf(data), repaired };
}

export const serializeSnapshot = (s: InventorySnapshot): string => JSON.stringify(s);

export function deserializeSnapshot(text: string): { readonly snapshot: InventorySnapshot; readonly repaired: boolean } {
  try {
    return parseSnapshot(JSON.parse(text) as unknown);
  } catch {
    return { snapshot: snapshotOf(EMPTY_PROFILE), repaired: true };
  }
}

/** The local adapter: the inventory lives inside a Free Roam slot record (default slot 1,
 *  `galaxia:freeroam`; saveSlots.ts slotSpec(n) for the others). */
export function profileRepository(store: KeyValueStore, spec: RecordSpec<FreeRoamProfile> = FREEROAM_SPEC): InventoryRepository {
  return {
    load: () => snapshotOf(loadRecord(store, spec).data),
    save: (s) => {
      const cur = loadRecord(store, spec);
      return cur.writable && writeRecord(store, spec, applySnapshot(cur.data, s));
    },
  };
}

/** In-memory adapter (tests; a future save-slot system can wrap it). */
export function memoryRepository(initial: InventorySnapshot = snapshotOf(EMPTY_PROFILE)): InventoryRepository & { readonly writes: number } {
  let text = serializeSnapshot(initial);
  let writes = 0;
  return {
    load: () => deserializeSnapshot(text).snapshot,
    save: (s) => {
      text = serializeSnapshot(s);
      writes += 1;
      return true;
    },
    get writes() {
      return writes;
    },
  };
}

/* ------------------------------------------------------------ collection */

type Entries = readonly { readonly resource: string; readonly amount: number }[];

/**
 * The collection events the shell persists (structurally the sector run's
 * events, so this module does not depend on the runtime).
 */
export type CollectionEvent =
  | { readonly type: 'collected' | 'looted'; readonly id: string; readonly loot: Entries; readonly left: Entries }
  | { readonly type: 'picked'; readonly id: string; readonly loot: Entries; readonly left: Entries; readonly persistent: boolean }
  | { readonly type: 'encounter'; readonly id: string; readonly state: string; readonly loot: Entries; readonly left: Entries }
  | { readonly type: 'recovered'; readonly loot: Entries; readonly left: Entries };

/** Where an encounter's overflowing reward is kept (matches the sector runtime's reward cache id). */
export const rewardCacheId = (encounterId: string): string => `${encounterId}.1`;

function totals(...lists: Entries[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lists) for (const e of l) if (Number.isInteger(e.amount) && e.amount > 0) m.set(e.resource, (m.get(e.resource) ?? 0) + e.amount);
  return m;
}
const sameTotals = (a: Map<string, number>, b: Map<string, number>): boolean => a.size === b.size && [...a].every(([k, n]) => b.get(k) === n);

/**
 * Persist one collection into the profile: the cargo taken goes into the hold
 * and, for persistent finds, the id is completed (nothing left) or keeps
 * exactly what is left. Duplicate or stale events pay nothing:
 *  - a completed id never pays again;
 *  - a partly taken find only pays when `loot + left` equals what the save
 *    says is still there (so a replayed event cannot pay twice).
 * Temporary pickups (salvage pods, jettisoned cargo) only add cargo; the
 * runtime awards each of them once. Returns the same profile when nothing is paid.
 */
export function applyCollection(p: FreeRoamProfile, systemId: string, e: CollectionEvent): FreeRoamProfile {
  if (e.type === 'recovered') {
    if (!p.lostCargo) return p;
    return e.left.length === 0 ? recoverCargo(p) : recoverSome(p, e.loot);
  }
  if (e.type === 'picked' && !e.persistent) return addCargo(p, e.loot);
  if (e.type === 'encounter') {
    if (e.state !== 'cleared' || p.sectors[systemId]?.done.includes(e.id)) return p;
    const q = addCargo(withSectorProgress(p, systemId, [e.id]), e.loot);
    return e.left.length ? withLeftLoot(q, systemId, rewardCacheId(e.id), e.left) : q;
  }
  const rec = p.sectors[systemId];
  if (rec?.done.includes(e.id)) return p;
  const saved = rec?.left?.[e.id];
  if (saved && !sameTotals(totals(e.loot, e.left), totals(Object.entries(saved).map(([resource, amount]) => ({ resource, amount }))))) return p;
  const q = addCargo(p, e.loot);
  return e.left.length ? withLeftLoot(q, systemId, e.id, e.left) : withSectorProgress(q, systemId, [e.id]);
}
