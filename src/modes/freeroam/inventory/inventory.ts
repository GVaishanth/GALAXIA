/**
 * Inventory rules (Free Roam Prompt 10). Pure functions over the cargo hold
 * (resource id -> units) and the station module storage (module id -> count).
 *
 *  - Every unit takes one hold unit; the hold limit is the flown ship's cargo
 *    stat (ships/equipment.ts deriveStats). Stacks (RESOURCES[id].stack) group
 *    units for display and jettison only.
 *  - Quantities are always positive integers: invalid, negative, fractional
 *    or non-finite amounts and unknown resource ids are dropped, never stored.
 *  - Adding never exceeds the capacity: what does not fit is returned as
 *    `left` (the caller keeps it in the world), so nothing silently vanishes.
 *    A hold already above capacity (an older save, or a smaller ship) keeps
 *    everything; it just takes nothing new until there is room.
 *  - TAKE WHAT FITS keeps the most valuable units first; SWAP throws out the
 *    cheapest cargo, unit for unit, only for something worth more.
 */
import { RESOURCE_IDS, type ResourceId } from '../catalogue/types.ts';
import type { LootEntry } from '../sector/model.ts';
import { CATEGORY_INFO, isResourceId, RESOURCES, type ResourceCategory, type ResourceDef } from './resources.ts';

export type Hold = Readonly<Record<string, number>>;
export type ModuleStore = Readonly<Record<string, number>>;

/** Largest amount of one resource a hold may record (profile.ts MAX_STACK mirrors it). */
export const MAX_UNITS = 999_999;
/** Station module storage: at most this many of one module, and in total. */
export const MAX_MODULE_COUNT = 9;
export const MAX_STORED_MODULES = 24;

export const validQty = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_UNITS;

/** Clean loot: known resources, positive integer amounts, merged per resource, catalogue order. */
export function normalizeLoot(loot: readonly { readonly resource: string; readonly amount: number }[]): LootEntry[] {
  const out = new Map<ResourceId, number>();
  for (const e of loot) {
    if (!e || !isResourceId(e.resource) || !validQty(e.amount)) continue;
    out.set(e.resource, Math.min(MAX_UNITS, (out.get(e.resource) ?? 0) + e.amount));
  }
  return RESOURCE_IDS.filter((id) => out.has(id)).map((id) => ({ resource: id, amount: out.get(id)! }));
}

export const lootUnits = (loot: readonly { readonly amount: number }[]): number => loot.reduce((n, e) => n + (validQty(e.amount) ? e.amount : 0), 0);

export function holdUnits(h: Hold): number {
  let n = 0;
  for (const v of Object.values(h)) if (validQty(v)) n += v;
  return n;
}

/** Free hold units (never negative). */
export const freeSpace = (h: Hold, capacity: number): number => Math.max(0, Math.floor(capacity) - holdUnits(h));

const valueOf = (id: ResourceId): number => RESOURCES[id].value;
/** Most valuable first; ties in catalogue order (stable and deterministic). */
const byValueDesc = (a: LootEntry, b: LootEntry): number => valueOf(b.resource) - valueOf(a.resource) || RESOURCE_IDS.indexOf(a.resource) - RESOURCE_IDS.indexOf(b.resource);

export interface TakePlan {
  readonly take: LootEntry[];
  readonly left: LootEntry[];
}

/** Split `loot` into what fits in `space` units (most valuable first) and what stays behind. */
export function planTake(loot: readonly LootEntry[], space: number): TakePlan {
  const clean = normalizeLoot(loot);
  let room = Math.max(0, Math.floor(Number.isFinite(space) ? space : space > 0 ? MAX_UNITS : 0));
  const take = new Map<ResourceId, number>();
  const left = new Map<ResourceId, number>();
  for (const e of [...clean].sort(byValueDesc)) {
    const n = Math.min(room, e.amount);
    room -= n;
    if (n > 0) take.set(e.resource, n);
    if (e.amount - n > 0) left.set(e.resource, e.amount - n);
  }
  const order = (m: Map<ResourceId, number>): LootEntry[] => RESOURCE_IDS.filter((id) => m.has(id)).map((id) => ({ resource: id, amount: m.get(id)! }));
  return { take: order(take), left: order(left) };
}

export interface AddResult {
  readonly hold: Hold;
  readonly taken: LootEntry[];
  readonly left: LootEntry[];
}

/** Add what fits under `capacity`; the rest comes back in `left`. */
export function addLoot(h: Hold, loot: readonly LootEntry[], capacity: number): AddResult {
  const plan = planTake(loot, freeSpace(h, capacity));
  if (plan.take.length === 0) return { hold: h, taken: [], left: plan.left };
  const out: Record<string, number> = { ...h };
  for (const e of plan.take) out[e.resource] = Math.min(MAX_UNITS, (validQty(out[e.resource]) ? out[e.resource]! : 0) + e.amount);
  return { hold: out, taken: plan.take, left: plan.left };
}

/** Remove `cost` from the hold; null when anything is missing or invalid (nothing is removed then). */
export function removeLoot(h: Hold, cost: readonly { readonly resource: string; readonly amount: number }[]): Hold | null {
  const out: Record<string, number> = { ...h };
  for (const c of cost) {
    if (!validQty(c.amount)) return null;
    const have = validQty(out[c.resource]) ? out[c.resource]! : 0;
    if (have < c.amount) return null;
    if (have - c.amount > 0) out[c.resource] = have - c.amount;
    else delete out[c.resource];
  }
  return out;
}

export interface SwapPlan {
  /** Cargo to throw out (it floats in space as a jettison pod). */
  readonly jettison: LootEntry[];
  /** What the freed room plus the free space then takes. */
  readonly take: LootEntry[];
  /** What still stays behind. */
  readonly left: LootEntry[];
}

/**
 * SWAP: make room for `incoming` by throwing out cheaper cargo, unit for
 * unit (each incoming unit that does not fit replaces the cheapest hold unit
 * worth strictly less, never one of the incoming kind). Null when nothing in
 * the hold is cheaper, i.e. a swap would gain nothing.
 */
export function planSwap(h: Hold, incoming: readonly LootEntry[], capacity: number): SwapPlan | null {
  const clean = normalizeLoot(incoming);
  const free = freeSpace(h, capacity);
  const over = Math.max(0, holdUnits(h) - Math.floor(capacity)); // an over-full hold must shed this first
  const kinds = new Set(clean.map((e) => e.resource));
  // hold units available to throw out, cheapest first
  const pool: { id: ResourceId; n: number }[] = RESOURCE_IDS.filter((id) => validQty(h[id]) && !kinds.has(id))
    .sort((a, b) => valueOf(a) - valueOf(b) || RESOURCE_IDS.indexOf(a) - RESOURCE_IDS.indexOf(b))
    .map((id) => ({ id, n: h[id]! }));
  const units: ResourceId[] = [];
  for (const e of [...clean].sort(byValueDesc)) for (let i = 0; i < e.amount; i++) units.push(e.resource);
  const jet = new Map<ResourceId, number>();
  const take = new Map<ResourceId, number>();
  const left = new Map<ResourceId, number>();
  let room = free;
  let debt = over;
  for (const u of units) {
    if (room > 0) {
      room -= 1;
      take.set(u, (take.get(u) ?? 0) + 1);
      continue;
    }
    // need one hold unit cheaper than u (plus any over-capacity debt first)
    const cheaper = pool.filter((p) => p.n > 0 && valueOf(p.id) < valueOf(u));
    if (cheaper.reduce((n, p) => n + p.n, 0) < debt + 1) {
      left.set(u, (left.get(u) ?? 0) + 1); // nothing cheaper to give up: it stays behind
      continue;
    }
    for (let k = 0; k <= debt; k++) {
      const c = cheaper.find((p) => p.n > 0)!;
      c.n -= 1;
      jet.set(c.id, (jet.get(c.id) ?? 0) + 1);
    }
    debt = 0;
    take.set(u, (take.get(u) ?? 0) + 1);
  }
  if (jet.size === 0) return null;
  const order = (m: Map<ResourceId, number>): LootEntry[] => RESOURCE_IDS.filter((id) => m.has(id)).map((id) => ({ resource: id, amount: m.get(id)! }));
  return { jettison: order(jet), take: order(take), left: order(left) };
}

/* ------------------------------------------------------------- the view */

export const SORT_KEYS = ['category', 'value', 'amount', 'name'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type CategoryFilter = ResourceCategory | 'all';

export const SORT_LABEL: Readonly<Record<SortKey, string>> = Object.freeze({ category: 'CATEGORY', value: 'VALUE', amount: 'AMOUNT', name: 'NAME' });

export interface InventoryRow {
  readonly def: ResourceDef;
  readonly amount: number;
  /** Stacks it fills (the last one may be partial). */
  readonly stacks: number;
  /** Units in the last stack. */
  readonly lastStack: number;
  /** Share of the hold capacity (0..1). */
  readonly share: number;
}

/** Hold rows for the cargo panel: known resources only, filtered by category and sorted. */
export function inventoryRows(h: Hold, capacity: number, sort: SortKey = 'category', filter: CategoryFilter = 'all'): InventoryRow[] {
  const rows: InventoryRow[] = [];
  for (const id of RESOURCE_IDS) {
    const n = h[id];
    if (!validQty(n)) continue;
    const def = RESOURCES[id];
    if (filter !== 'all' && def.category !== filter) continue;
    const stacks = Math.ceil(n / def.stack);
    rows.push({ def, amount: n, stacks, lastStack: n - (stacks - 1) * def.stack, share: capacity > 0 ? Math.min(1, n / capacity) : 0 });
  }
  const cat = (r: InventoryRow): number => Object.keys(CATEGORY_INFO).indexOf(r.def.category);
  const idx = (r: InventoryRow): number => RESOURCE_IDS.indexOf(r.def.id);
  const cmp: Record<SortKey, (a: InventoryRow, b: InventoryRow) => number> = {
    category: (a, b) => cat(a) - cat(b) || idx(a) - idx(b),
    value: (a, b) => b.def.value - a.def.value || idx(a) - idx(b),
    amount: (a, b) => b.amount - a.amount || idx(a) - idx(b),
    name: (a, b) => a.def.name.localeCompare(b.def.name),
  };
  return rows.sort(cmp[sort]);
}

/** Units per category (for the filter chips). */
export function categoryCounts(h: Hold): Readonly<Record<ResourceCategory, number>> {
  const out = Object.fromEntries(Object.keys(CATEGORY_INFO).map((k) => [k, 0])) as Record<ResourceCategory, number>;
  for (const id of RESOURCE_IDS) if (validQty(h[id])) out[RESOURCES[id].category] += h[id]!;
  return out;
}

/** Ids in the hold the catalogue does not know (kept, shown as unknown, never counted as loot). */
export const unknownCargo = (h: Hold): string[] => Object.keys(h).filter((k) => !isResourceId(k) && validQty(h[k]));

/* --------------------------------------------------------- module storage */

export const storedTotal = (m: ModuleStore): number => Object.values(m).reduce((n, v) => n + (validQty(v) ? v : 0), 0);

/** Store one more module; null when storage is full or the count cap is reached. */
export function storeModule(m: ModuleStore, id: string): ModuleStore | null {
  const have = validQty(m[id]) ? m[id]! : 0;
  if (have >= MAX_MODULE_COUNT || storedTotal(m) >= MAX_STORED_MODULES) return null;
  return { ...m, [id]: have + 1 };
}

/** Take one module out of storage; null when none is stored. */
export function takeModule(m: ModuleStore, id: string): ModuleStore | null {
  const have = validQty(m[id]) ? m[id]! : 0;
  if (have <= 0) return null;
  const out: Record<string, number> = { ...m };
  if (have > 1) out[id] = have - 1;
  else delete out[id];
  return out;
}
