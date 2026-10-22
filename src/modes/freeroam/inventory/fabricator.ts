/**
 * Station fabricator and module fitting (Free Roam Prompt 10). Pure.
 *
 *  - Recipes (central, below) turn cargo resources into equipment modules.
 *    A build removes the whole cost from the hold and adds the module to the
 *    station storage in one result, so it can never be paid twice or granted
 *    without payment; storage limits are checked first.
 *  - Spare modules wait in storage (they do not use hold space). Fitting one
 *    into a slot of the flown ship moves the module that was there (if any)
 *    back into storage, and only ever produces a valid loadout
 *    (ships/equipment.ts rules: slot type, weapon class, slot count).
 *  - A fitting that would shrink the hold below the cargo already carried is
 *    refused (the hold is never trimmed); so is one with storage full.
 *  - Both run only while docked with no hostile engaged (the shell checks).
 */
import { canFit, deriveStats, EQUIPMENT_BY_ID, fitItem } from '../ships/equipment.ts';
import type { Loadout, ShipDef, SlotType } from '../ships/types.ts';
import type { LootEntry } from '../sector/model.ts';
import { holdUnits, MAX_MODULE_COUNT, MAX_STORED_MODULES, removeLoot, storedTotal, storeModule, takeModule, validQty, type Hold, type ModuleStore } from './inventory.ts';

export interface Recipe {
  readonly module: string;
  readonly cost: readonly LootEntry[];
}

/** Every module that can be fabricated, cheapest first. Stock-only modules (the standard fit) are not built. */
export const RECIPES: readonly Recipe[] = Object.freeze([
  { module: 'cargo-pod', cost: [{ resource: 'scrap', amount: 10 }, { resource: 'alloy', amount: 4 }, { resource: 'components', amount: 2 }] },
  { module: 'needle-repeater', cost: [{ resource: 'alloy', amount: 6 }, { resource: 'circuits', amount: 4 }, { resource: 'components', amount: 2 }] },
  { module: 'sprint-thrusters', cost: [{ resource: 'fuel', amount: 8 }, { resource: 'alloy', amount: 6 }, { resource: 'components', amount: 3 }] },
  { module: 'twin-pulse', cost: [{ resource: 'alloy', amount: 8 }, { resource: 'circuits', amount: 6 }, { resource: 'crystal', amount: 3 }, { resource: 'components', amount: 3 }] },
  { module: 'salvage-rig', cost: [{ resource: 'scrap', amount: 16 }, { resource: 'alloy', amount: 8 }, { resource: 'ice', amount: 6 }, { resource: 'components', amount: 4 }] },
  { module: 'cruise-drive', cost: [{ resource: 'fuel', amount: 10 }, { resource: 'nav-data', amount: 6 }, { resource: 'components', amount: 3 }] },
  { module: 'bastion-array', cost: [{ resource: 'alloy', amount: 10 }, { resource: 'crystal', amount: 6 }, { resource: 'components', amount: 4 }, { resource: 'core-shard', amount: 1 }] },
  { module: 'lance-driver', cost: [{ resource: 'alloy', amount: 12 }, { resource: 'circuits', amount: 6 }, { resource: 'crystal', amount: 4 }, { resource: 'components', amount: 4 }, { resource: 'core-shard', amount: 1 }] },
  { module: 'deep-array', cost: [{ resource: 'circuits', amount: 8 }, { resource: 'nav-data', amount: 4 }, { resource: 'samples', amount: 4 }, { resource: 'relic', amount: 1 }] },
] as Recipe[]).map((r) => Object.freeze({ module: r.module, cost: Object.freeze(r.cost.map((c) => Object.freeze({ ...c }))) }));

export const RECIPE_BY_MODULE: ReadonlyMap<string, Recipe> = new Map(RECIPES.map((r) => [r.module, r]));

/** What is still missing to pay a cost (empty = affordable). */
export function missingResources(cost: readonly LootEntry[], hold: Hold): LootEntry[] {
  return cost.filter((c) => (validQty(hold[c.resource]) ? hold[c.resource]! : 0) < c.amount).map((c) => ({ resource: c.resource, amount: c.amount - (validQty(hold[c.resource]) ? hold[c.resource]! : 0) }));
}

export type FabricateResult =
  | { readonly ok: true; readonly hold: Hold; readonly modules: ModuleStore }
  | { readonly ok: false; readonly reason: 'unknown' | 'unaffordable' | 'storage-full' };

export function fabricate(hold: Hold, modules: ModuleStore, moduleId: string): FabricateResult {
  const r = RECIPE_BY_MODULE.get(moduleId);
  if (!r) return { ok: false, reason: 'unknown' };
  const stored = storeModule(modules, moduleId);
  if (!stored) return { ok: false, reason: 'storage-full' };
  const paid = removeLoot(hold, r.cost);
  if (!paid) return { ok: false, reason: 'unaffordable' };
  return { ok: true, hold: paid, modules: stored };
}

export type FitResult =
  | { readonly ok: true; readonly loadout: Loadout; readonly modules: ModuleStore; readonly removed: string | null }
  | { readonly ok: false; readonly reason: 'not-stored' | 'incompatible' | 'same' | 'cargo-overflow' | 'storage-full' };

/**
 * Fit a stored module into `slot[index]` of `ship` (index may be the next
 * empty slot). The module that was there goes back into storage.
 */
export function fitFromStorage(ship: ShipDef, loadout: Loadout, modules: ModuleStore, hold: Hold, slot: SlotType, index: number, moduleId: string): FitResult {
  if (!validQty(modules[moduleId])) return { ok: false, reason: 'not-stored' };
  const item = EQUIPMENT_BY_ID.get(moduleId);
  if (!item || item.slot !== slot || !Number.isInteger(index) || index < 0 || index >= ship.slots[slot] || index > loadout[slot].length) return { ok: false, reason: 'incompatible' };
  const current = loadout[slot][index] ?? null;
  if (current === moduleId) return { ok: false, reason: 'same' };
  if (!canFit(ship, loadout, moduleId, index)) return { ok: false, reason: 'incompatible' };
  const next = fitItem(loadout, slot, index, moduleId);
  if (deriveStats(ship, next).cargo < holdUnits(hold)) return { ok: false, reason: 'cargo-overflow' };
  let store = takeModule(modules, moduleId)!;
  if (current) {
    const back = storeModule(store, current);
    if (!back) return { ok: false, reason: 'storage-full' };
    store = back;
  }
  return { ok: true, loadout: next, modules: store, removed: current };
}

/** Free storage places (total and for one module). */
export function storageRoom(modules: ModuleStore, id: string): number {
  return Math.max(0, Math.min(MAX_STORED_MODULES - storedTotal(modules), MAX_MODULE_COUNT - (validQty(modules[id]) ? modules[id]! : 0)));
}
