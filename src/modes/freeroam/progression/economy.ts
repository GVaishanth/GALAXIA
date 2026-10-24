/**
 * Station exchange (Free Roam Prompt 11): a local, offline economy.
 *
 * Currency: Guild marks, earned by selling salvage, missions, bounties,
 * encounters and discoveries (marksRewards.ts); the balance and its history
 * are handled by ledger.ts, and this module only quotes trades. Every
 * transaction is two steps: a quote (cost, gain and the resulting balances,
 * shown before confirming) and a commit that re-validates and applies the
 * same quote. Quotes never mutate; a commit returns a new wallet or null.
 *
 *  - sell:   selected cargo for marks at the station's rates. Reactor cells
 *            are not bought (stations hand out free emergency cells, so
 *            selling them would turn the safety net into income);
 *  - buy:    reactor cells; equipment modules compatible with the flown ship
 *            (to station storage, fitted at the fabricator);
 *  - ships:  the hangar's licence + cargo price (ships/hangar.ts);
 *  - upgrades: ships/upgrades.ts (marks + materials);
 *  - repair: free, shown as a line item.
 *
 * Admin Access (P04, Economy pass): a buy quote can be made `free` (the marks
 * price resolves to 0 and the balance line stays unchanged, marked ADMIN ACCESS
 * — FREE). The wallet is never raised to pay for it, and selling is refused by
 * the shell during a session, so a sandbox never changes the balance.
 *
 * Pure (no DOM, no storage, no network).
 */
import { EQUIPMENT_BY_ID } from '../ships/equipment.ts';
import type { ResourceCost, ShipDef } from '../ships/types.ts';
import { addLoot, freeSpace, removeLoot, storeModule, storedTotal, MAX_STORED_MODULES, type Hold, type ModuleStore } from '../inventory/inventory.ts';
import { RESOURCES, isResourceId, resourceName, resourceValue } from '../inventory/resources.ts';
import type { LootEntry } from '../sector/model.ts';
import { hashId } from './contracts.ts';
import { formatMarks, groupDigits, insufficientText, MARKS } from './ledger.ts';

export const ECONOMY = Object.freeze({
  /** Marks cap (the wallet never overflows; ledger.ts MARKS.max). */
  marksMax: MARKS.max,
  /** Marks per unit of resource value at a neutral station. */
  sellRate: 3,
  /** Price of one reactor cell. */
  cellPrice: 8,
  /** Demand multipliers: one category in demand, one in surplus per station. */
  demand: 1.25,
  surplus: 0.8,
});

/** Resources stations never buy. */
export const UNSELLABLE: readonly string[] = Object.freeze(['fuel']);

/** Marks (and materials) for equipment bought at an exchange. Stock modules are not sold (every ship comes with them). */
export const MODULE_PRICES: Readonly<Record<string, { readonly marks: number; readonly materials: readonly ResourceCost[] }>> = Object.freeze({
  'needle-repeater': { marks: 120, materials: [] },
  'twin-pulse': { marks: 220, materials: [{ resource: 'circuits', amount: 2 }] },
  'lance-driver': { marks: 320, materials: [{ resource: 'components', amount: 2 }] },
  'bastion-array': { marks: 240, materials: [{ resource: 'crystal', amount: 3 }] },
  'sprint-thrusters': { marks: 180, materials: [] },
  'cruise-drive': { marks: 200, materials: [{ resource: 'nav-data', amount: 2 }] },
  'deep-array': { marks: 160, materials: [] },
  'cargo-pod': { marks: 100, materials: [] },
  'salvage-rig': { marks: 220, materials: [{ resource: 'alloy', amount: 4 }] },
});

export interface Wallet {
  readonly marks: number;
  readonly hold: Hold;
  readonly holdCap: number;
  readonly modules: ModuleStore;
}

export interface QuoteLine {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export type Quote =
  | { readonly ok: true; readonly lines: readonly QuoteLine[]; readonly result: Wallet; readonly summary: string }
  | { readonly ok: false; readonly lines: readonly QuoteLine[]; readonly reason: string };

const clampMarks = (n: number): number => Math.max(0, Math.min(ECONOMY.marksMax, Math.floor(n)));
const holdUnits = (h: Hold): number => Object.values(h).reduce((a, b) => a + b, 0);
const holdLine = (before: Wallet, after: Hold): QuoteLine => ({ label: 'Hold', before: `${holdUnits(before.hold)}/${before.holdCap}`, after: `${holdUnits(after)}/${before.holdCap}` });
const marksLine = (before: number, after: number, free = false): QuoteLine => ({ label: 'Marks', before: formatMarks(before), after: free ? `${formatMarks(after)} · ADMIN ACCESS — FREE` : formatMarks(after) });

/* ------------------------------------------------------------------ prices */

/** Demand of a station: the category it pays more for and the one it has too much of (seeded by the system id). */
export function stationDemand(station: string): { readonly demand: string; readonly surplus: string } {
  const cats = ['alloys', 'reactor', 'circuitry', 'crystals', 'samples', 'navdata', 'artefacts', 'components'].filter((c) => c !== 'reactor');
  const h = hashId(`market:${station}`);
  const demand = cats[h % cats.length]!;
  const rest = cats.filter((c) => c !== demand);
  return { demand, surplus: rest[(h >>> 8) % rest.length]! };
}

/** Marks paid per unit at a station (0 = not bought there). */
export function sellPrice(resource: string, station: string): number {
  if (!isResourceId(resource) || UNSELLABLE.includes(resource)) return 0;
  const cat = RESOURCES[resource].category;
  const d = stationDemand(station);
  const mul = cat === d.demand ? ECONOMY.demand : cat === d.surplus ? ECONOMY.surplus : 1;
  return Math.max(1, Math.round(resourceValue(resource) * ECONOMY.sellRate * mul));
}

/* -------------------------------------------------------------------- sell */

export function quoteSell(w: Wallet, station: string, resource: string, qty: number): Quote {
  const have = w.hold[resource] ?? 0;
  const price = sellPrice(resource, station);
  const n = Math.floor(qty);
  if (price <= 0) return { ok: false, lines: [], reason: UNSELLABLE.includes(resource) ? 'Stations do not buy reactor cells.' : 'Not traded here.' };
  if (!(n > 0) || n > have) return { ok: false, lines: [], reason: have <= 0 ? 'None in the hold.' : `Only ${have} in the hold.` };
  const hold = removeLoot(w.hold, [{ resource, amount: n }]);
  if (!hold) return { ok: false, lines: [], reason: 'None in the hold.' };
  const marks = clampMarks(w.marks + price * n);
  const lines = [marksLine(w.marks, marks), { label: resourceName(resource), before: String(have), after: String(have - n) }, holdLine(w, hold)];
  return { ok: true, lines, result: { ...w, marks, hold }, summary: `Sell ${n} ${resourceName(resource)} for ${formatMarks(price * n)} (${groupDigits(price)} each).` };
}

/* --------------------------------------------------------------------- buy */

export function quoteBuyCells(w: Wallet, qty: number, free = false): Quote {
  const n = Math.floor(qty);
  if (!(n > 0) || !Number.isSafeInteger(n)) return { ok: false, lines: [], reason: 'Nothing to buy.' };
  const cost = free ? 0 : ECONOMY.cellPrice * n;
  if (cost > w.marks) return { ok: false, lines: [marksLine(w.marks, w.marks)], reason: insufficientText(cost, w.marks) };
  const space = freeSpace(w.hold, w.holdCap);
  if (space < n) return { ok: false, lines: [], reason: `Hold full: ${space} free, ${n} needed.` };
  const add = addLoot(w.hold, [{ resource: 'fuel', amount: n }], w.holdCap);
  const have = w.hold['fuel'] ?? 0;
  const lines = [marksLine(w.marks, w.marks - cost, free), { label: resourceName('fuel'), before: String(have), after: String(have + n) }, holdLine(w, add.hold)];
  return { ok: true, lines, result: { ...w, marks: w.marks - cost, hold: add.hold }, summary: `Buy ${n} reactor cell${n === 1 ? '' : 's'} for ${free ? 'nothing (admin access)' : formatMarks(cost)}.` };
}

/** Can a ship fit this module type at all (slot present, weapon class accepted)? */
export function moduleFits(ship: ShipDef, moduleId: string): boolean {
  const item = EQUIPMENT_BY_ID.get(moduleId);
  if (!item || ship.slots[item.slot] <= 0) return false;
  return item.slot !== 'weapon' || ship.weaponClasses.includes(item.weaponClass);
}

/** Modules this station sells to the flown ship (compatible ones only, price order). */
export function moduleStock(ship: ShipDef): string[] {
  return Object.keys(MODULE_PRICES)
    .filter((id) => moduleFits(ship, id))
    .sort((a, b) => MODULE_PRICES[a]!.marks - MODULE_PRICES[b]!.marks || a.localeCompare(b));
}

export function quoteBuyModule(w: Wallet, ship: ShipDef, moduleId: string, free = false): Quote {
  const price = MODULE_PRICES[moduleId];
  const item = EQUIPMENT_BY_ID.get(moduleId);
  if (!price || !item) return { ok: false, lines: [], reason: 'Not sold here.' };
  if (!moduleFits(ship, moduleId)) return { ok: false, lines: [], reason: `${ship.name} cannot fit it.` };
  const cost = free ? 0 : price.marks;
  if (cost > w.marks) return { ok: false, lines: [marksLine(w.marks, w.marks)], reason: insufficientText(cost, w.marks) };
  const hold = price.materials.length ? removeLoot(w.hold, price.materials) : w.hold;
  if (!hold) {
    const miss = price.materials.filter((m) => (w.hold[m.resource] ?? 0) < m.amount).map((m) => `${m.amount - (w.hold[m.resource] ?? 0)} ${resourceName(m.resource)}`);
    return { ok: false, lines: [], reason: `Missing ${miss.join(', ')}.` };
  }
  const modules = storeModule(w.modules, moduleId);
  if (!modules) return { ok: false, lines: [], reason: storedTotal(w.modules) >= MAX_STORED_MODULES ? 'Module storage is full.' : `Storage holds no more ${item.name}.` };
  const lines = [marksLine(w.marks, w.marks - cost, free), ...price.materials.map((m) => ({ label: resourceName(m.resource), before: String(w.hold[m.resource] ?? 0), after: String((w.hold[m.resource] ?? 0) - m.amount) })), { label: 'Stored modules', before: String(storedTotal(w.modules)), after: String(storedTotal(modules)) }];
  return { ok: true, lines, result: { ...w, marks: w.marks - cost, hold, modules }, summary: `Buy ${item.name} for ${free ? 'nothing (admin access)' : formatMarks(cost)}: it goes to station storage; fit it at the fabricator.` };
}

/** Commit a quote (callers re-quote right before committing; this only returns the quoted wallet). */
export const commitQuote = (q: Quote): Wallet | null => (q.ok ? q.result : null);

/* ----------------------------------------------------------------- rewards */

/** Add marks (rewards); never negative, capped. */
export const addMarks = (marks: number, gain: number): number => clampMarks(marks + Math.max(0, Math.floor(gain)));

/** Does a resource reward fit the hold? */
export function rewardFits(w: Wallet, loot: readonly LootEntry[]): { readonly fits: boolean; readonly need: number; readonly space: number } {
  const need = loot.reduce((n, e) => n + e.amount, 0);
  const space = freeSpace(w.hold, w.holdCap);
  return { fits: need <= space, need, space };
}

/* ------------------------------------------------------------------ repair */

/** Docked repairs stay free: what they restore, for the exchange's line item. */
export function repairLine(hull: number, hullMax: number, shield: number, shieldMax: number): QuoteLine & { readonly free: true } {
  const restored = Math.max(0, Math.round(hullMax - hull)) + Math.max(0, Math.round(shieldMax - shield));
  return { label: 'Repairs', before: `Hull ${Math.round(hull)}/${hullMax} · Shield ${Math.round(shield)}/${shieldMax}`, after: restored > 0 ? `Hull ${hullMax}/${hullMax} · Shield ${shieldMax}/${shieldMax}` : 'Nothing to repair', free: true };
}
