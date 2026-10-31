/**
 * Hangar rules (pure, Free Roam Prompt 8): fleet ownership, acquisition,
 * switching and stat comparison. No DOM; the hangar panel (hangarPanel.ts)
 * and the shell call these and write the results to the profile.
 *
 *  - The starter (Petrel) is always owned; the active ship is always owned.
 *  - acquireShip: the licence must be met (callback = ProgressView.requirementMet),
 *    the ship not owned yet, and the cargo hold must hold the whole price.
 *    The price is removed and the ship added in one result, so a purchase
 *    can never be paid twice or granted without payment.
 *  - selectShip: only an owned ship, only at a safe place (docked at a
 *    station, with no hostile engaged). Switching mid-combat is impossible.
 */
import type { UnlockRequirement } from '../catalogue/types.ts';
import type { SavedFleet } from '../profile.ts';
import { cleanSetup, setupsForSave, type WeaponSetup } from './armory.ts';
import { deriveStats, isValidLoadout } from './equipment.ts';
import { SHIP_BY_ID, SHIPS, STARTER_SHIP } from './roster.ts';
import { SHIP_IDS, SLOT_TYPES, type Loadout, type ResourceCost, type ShipId, type StatKey } from './types.ts';

export interface FleetState {
  readonly active: ShipId;
  /** Owned ships in roster order (always includes the starter). */
  readonly owned: readonly ShipId[];
  /** Fitted modules per owned ship; absent = the stock loadout. */
  readonly loadouts: Readonly<Partial<Record<ShipId, Loadout>>>;
  /** Combat P03B: weapon preferences per owned ship (armory.ts); absent = the ship's default setup. */
  readonly weapons?: Readonly<Partial<Record<ShipId, WeaponSetup>>>;
}

/** The profile's stored shape (ids are only shape-checked there). */
export type { SavedFleet };

export const STARTER_FLEET: FleetState = Object.freeze({ active: STARTER_SHIP, owned: Object.freeze([STARTER_SHIP]), loadouts: Object.freeze({}) });

const isShipId = (x: unknown): x is ShipId => typeof x === 'string' && (SHIP_IDS as readonly string[]).includes(x);
const rosterOrder = (ids: Iterable<ShipId>): ShipId[] => {
  const set = new Set(ids);
  return SHIP_IDS.filter((id) => set.has(id));
};

/** Fleet from the profile: unknown ships and invalid loadouts dropped, the starter always owned, the active ship owned. */
export function fleetFromSaved(saved: SavedFleet | undefined): FleetState {
  if (!saved) return STARTER_FLEET;
  const owned = rosterOrder([STARTER_SHIP, ...saved.owned.filter(isShipId)]);
  const active = isShipId(saved.active) && owned.includes(saved.active) ? saved.active : STARTER_SHIP;
  const loadouts: Partial<Record<ShipId, Loadout>> = {};
  for (const [id, raw] of Object.entries(saved.loadouts ?? {})) {
    if (!isShipId(id) || !owned.includes(id)) continue;
    const l = {} as Record<(typeof SLOT_TYPES)[number], readonly string[]>;
    for (const s of SLOT_TYPES) l[s] = Array.isArray(raw[s]) ? [...raw[s]!] : [];
    if (isValidLoadout(SHIP_BY_ID.get(id)!, l)) loadouts[id] = l;
  }
  // P03B: weapon setups of owned ships, re-validated against each ship's mounts (an unmountable weapon leaves the rotation)
  const weapons: Partial<Record<ShipId, WeaponSetup>> = {};
  for (const [id, raw] of Object.entries(saved.weapons ?? {})) if (isShipId(id) && owned.includes(id)) weapons[id] = cleanSetup(id, raw);
  return Object.keys(weapons).length ? { active, owned, loadouts, weapons } : { active, owned, loadouts };
}

export function fleetToSaved(f: FleetState): SavedFleet {
  const loadouts: Record<string, Record<string, readonly string[]>> = {};
  for (const [id, l] of Object.entries(f.loadouts)) if (l) loadouts[id] = { ...l };
  const weapons = setupsForSave(f);
  return Object.keys(weapons).length ? { active: f.active, owned: [...f.owned], loadouts, weapons } : { active: f.active, owned: [...f.owned], loadouts };
}

export function loadoutOf(f: FleetState, id: ShipId): Loadout {
  return f.loadouts[id] ?? SHIP_BY_ID.get(id)!.stock;
}

/* ----------------------------------------------------------------- cargo */

export function cargoUsed(cargo: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const v of Object.values(cargo)) n += Math.max(0, v);
  return n;
}

/** What is still missing to pay `cost` (empty = affordable). */
export function missingFor(cost: readonly ResourceCost[], cargo: Readonly<Record<string, number>>): ResourceCost[] {
  return cost.filter((c) => (cargo[c.resource] ?? 0) < c.amount).map((c) => ({ resource: c.resource, amount: c.amount - (cargo[c.resource] ?? 0) }));
}

function pay(cost: readonly ResourceCost[], cargo: Readonly<Record<string, number>>): Record<string, number> {
  const out = { ...cargo };
  for (const c of cost) {
    const left = (out[c.resource] ?? 0) - c.amount;
    if (left > 0) out[c.resource] = left;
    else delete out[c.resource];
  }
  return out;
}

/* ---------------------------------------------------------------- status */

export type ShipStatus = 'active' | 'owned' | 'available' | 'unaffordable' | 'locked';
export type LicenceCheck = (req: UnlockRequirement) => boolean;

export function shipStatus(f: FleetState, id: ShipId, licenceMet: LicenceCheck, cargo: Readonly<Record<string, number>>): ShipStatus {
  if (f.active === id) return 'active';
  if (f.owned.includes(id)) return 'owned';
  const ship = SHIP_BY_ID.get(id)!;
  // P10.1: a recovery hull is never for sale; it stays locked until its hull is delivered (recoverShip)
  if (ship.salvage || !ship.licence.every(licenceMet)) return 'locked';
  return missingFor(ship.cost, cargo).length === 0 ? 'available' : 'unaffordable';
}

export type AcquireResult =
  | { readonly ok: true; readonly fleet: FleetState; readonly cargo: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly reason: 'unknown' | 'owned' | 'locked' | 'unaffordable' };

export function acquireShip(f: FleetState, cargo: Readonly<Record<string, number>>, id: string, licenceMet: LicenceCheck): AcquireResult {
  if (!isShipId(id)) return { ok: false, reason: 'unknown' };
  if (f.owned.includes(id)) return { ok: false, reason: 'owned' };
  const ship = SHIP_BY_ID.get(id)!;
  if (ship.salvage || !ship.licence.every(licenceMet)) return { ok: false, reason: 'locked' };
  if (missingFor(ship.cost, cargo).length > 0) return { ok: false, reason: 'unaffordable' };
  return { ok: true, fleet: { ...f, owned: rosterOrder([...f.owned, id]) }, cargo: pay(ship.cost, cargo) };
}

/**
 * P10.1: the one way to own a recovery hull: its disabled hull was towed to a
 * station dock (the run's `hullDelivered`). Adds it to the fleet for free
 * (never the active ship); null for an unknown id, a ship that is sold in the
 * Hangar, or one already owned, so a repeat can never grant it twice.
 */
export function recoverShip(f: FleetState, id: string): FleetState | null {
  if (!isShipId(id) || !SHIP_BY_ID.get(id)!.salvage || f.owned.includes(id)) return null;
  return { ...f, owned: rosterOrder([...f.owned, id]) };
}

export type SelectResult = { readonly ok: true; readonly fleet: FleetState } | { readonly ok: false; readonly reason: 'unknown' | 'not-owned' | 'active' | 'unsafe' };

/** Switch the active ship. `safe` = docked at a station with no hostile engaged (the shell and sector/run.ts decide). */
export function selectShip(f: FleetState, id: string, safe: boolean): SelectResult {
  if (!isShipId(id)) return { ok: false, reason: 'unknown' };
  if (!f.owned.includes(id)) return { ok: false, reason: 'not-owned' };
  if (f.active === id) return { ok: false, reason: 'active' };
  if (!safe) return { ok: false, reason: 'unsafe' };
  return { ok: true, fleet: { ...f, active: id } };
}

/* ------------------------------------------------------------ comparison */

export const STAT_INFO: Readonly<Record<StatKey, { readonly label: string; readonly unit: string; readonly higherIsBetter: boolean; readonly digits: number }>> = Object.freeze({
  hull: { label: 'Hull', unit: '', higherIsBetter: true, digits: 0 },
  shield: { label: 'Shield', unit: '', higherIsBetter: true, digits: 0 },
  shieldRegen: { label: 'Shield recharge', unit: '/s', higherIsBetter: true, digits: 0 },
  accel: { label: 'Acceleration', unit: '', higherIsBetter: true, digits: 0 },
  maxSpeed: { label: 'Top speed', unit: '', higherIsBetter: true, digits: 0 },
  turnRate: { label: 'Handling', unit: '', higherIsBetter: true, digits: 1 },
  energy: { label: 'Boost energy', unit: '', higherIsBetter: true, digits: 0 },
  energyRegen: { label: 'Energy recharge', unit: '/s', higherIsBetter: true, digits: 0 },
  cargo: { label: 'Cargo hold', unit: '', higherIsBetter: true, digits: 0 },
  sensor: { label: 'Sensor range', unit: '', higherIsBetter: true, digits: 0 },
  travel: { label: 'Drive charge', unit: '%', higherIsBetter: false, digits: 0 },
});

/** Stats shown in the hangar comparison, in order. */
export const COMPARE_KEYS: readonly StatKey[] = ['hull', 'shield', 'maxSpeed', 'accel', 'turnRate', 'energy', 'cargo', 'sensor', 'travel'];

export function formatStat(k: StatKey, v: number): string {
  if (k === 'travel') return `${Math.round(v * 100)}%`;
  const d = STAT_INFO[k].digits;
  return `${d ? v.toFixed(d) : Math.round(v)}${STAT_INFO[k].unit}`;
}

export interface StatRow {
  readonly key: StatKey;
  readonly label: string;
  readonly value: number;
  readonly current: number;
  /** +1 = better than the current ship, -1 = worse, 0 = same. */
  readonly delta: -1 | 0 | 1;
  /** 0..1 bar length across the roster's range (fuller = better; for drive charge, fuller = cheaper). */
  readonly fill: number;
}

/** Display ranges for the comparison bars (the roster's span, not the hard bounds). */
const BAR_RANGE: Readonly<Record<StatKey, readonly [number, number]>> = (() => {
  const r = {} as Record<StatKey, [number, number]>;
  for (const k of Object.keys(STAT_INFO) as StatKey[]) {
    const vals = SHIPS.map((s) => deriveStats(s, s.stock)[k]);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    // a little headroom below the weakest value so its bar is never empty
    r[k] = STAT_INFO[k].higherIsBetter ? [lo - (hi - lo) * 0.25, hi] : [lo, hi + (hi - lo) * 0.25];
  }
  return r;
})();

/** 0..1 bar length of `v` on the roster's display range (fuller = better; for drive charge, fuller = cheaper). */
export function barFill(k: StatKey, v: number): number {
  const [lo, hi] = BAR_RANGE[k];
  const t = hi > lo ? (STAT_INFO[k].higherIsBetter ? v - lo : hi - v) / (hi - lo) : 1;
  return Math.min(1, Math.max(0.04, t));
}

/** Compare `id` (stock or fitted) with the ship currently flown. */
export function compareStats(f: FleetState, id: ShipId): StatRow[] {
  const a = deriveStats(SHIP_BY_ID.get(id)!, loadoutOf(f, id));
  const b = deriveStats(SHIP_BY_ID.get(f.active)!, loadoutOf(f, f.active));
  return COMPARE_KEYS.map((k) => {
    const info = STAT_INFO[k];
    const diff = a[k] - b[k];
    const eps = Math.abs(b[k]) * 1e-6 + 1e-9;
    const better = Math.abs(diff) <= eps ? 0 : (diff > 0) === info.higherIsBetter ? 1 : -1;
    return { key: k, label: info.label, value: a[k], current: b[k], delta: better as -1 | 0 | 1, fill: barFill(k, a[k]) };
  });
}
