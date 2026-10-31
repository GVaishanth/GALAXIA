/**
 * Hangar view model (P03A, FR-TD-87). Pure: no DOM, no storage, no clock.
 * The hangar panel (hangarPanel.ts) renders what this returns; every rule
 * still lives in hangar.ts (ownership, licence, price, safe switching) and
 * every number in roster.ts / equipment.ts / upgrades.ts.
 *
 *  - Stats are the ones the ship really flies with: its fitted loadout plus
 *    its installed upgrades (upgradedShip, the same call the shell uses to
 *    build the flown craft), so the hangar never shows a number the flight
 *    does not use.
 *  - Filters and sorting only use data that exists (ownership state, the
 *    roster's stats, the role name). Each roster class has one ship, so a
 *    per-class filter would only ever show one entry: the class is shown on
 *    every card and offered as a sort instead.
 *  - Highlights ("best in the yard") are computed from the stock roster,
 *    never written by hand, so they stay true when balance changes.
 *  - Comparison: any other owned ship, on the same bar scale (barFill).
 *  - Nothing here is persisted: filter, sort, comparison and the inspected
 *    ship are panel state. The selected (flown) ship is FleetState.active.
 */
import { deriveStats, EQUIPMENT_BY_ID } from './equipment.ts';
import { barFill, COMPARE_KEYS, loadoutOf, shipStatus, STAT_INFO, type FleetState, type LicenceCheck, type ShipStatus } from './hangar.ts';
import { SHIP_BY_ID, SHIPS, STARTER_SHIP } from './roster.ts';
import { WEAPON_CLASSES, type DerivedShip, type ShipId, type ShipStats, type StatKey, type WeaponClass, type WeaponProfile } from './types.ts';
import { upgradedShip, type UpgradeLevels } from './upgrades.ts';

/** Everything the view model reads (the shell supplies it; tests build it by hand). */
export interface HangarContext {
  readonly fleet: FleetState;
  readonly cargo: Readonly<Record<string, number>>;
  readonly licenceMet: LicenceCheck;
  /** Installed upgrade levels of a ship (cleaned against its caps). */
  readonly levels: (id: ShipId) => UpgradeLevels;
}

/* --------------------------------------------------------------- derived */

/** The ship as it would fly: fitted loadout (stock when not owned) plus installed upgrades. */
export function shipAsFlown(ctx: HangarContext, id: ShipId): DerivedShip {
  return upgradedShip(id, loadoutOf(ctx.fleet, id), ctx.levels(id));
}

export function statusOf(ctx: HangarContext, id: ShipId): ShipStatus {
  return shipStatus(ctx.fleet, id, ctx.licenceMet, ctx.cargo);
}

/** Ownership states never come from UI state: only owned ships (FLYING / OWNED) can be selected. */
export const isOwnedStatus = (s: ShipStatus): boolean => s === 'active' || s === 'owned';

/* --------------------------------------------------------------- filters */

export const HANGAR_FILTERS = Object.freeze(['all', 'owned', 'forSale', 'locked'] as const);
export type HangarFilter = (typeof HANGAR_FILTERS)[number];

export const FILTER_LABEL: Readonly<Record<HangarFilter, string>> = Object.freeze({ all: 'ALL', owned: 'OWNED', forSale: 'FOR SALE', locked: 'LOCKED' });

/** for sale = licence met, not owned yet (affordable or not). */
export function matchesFilter(status: ShipStatus, f: HangarFilter): boolean {
  if (f === 'all') return true;
  if (f === 'owned') return isOwnedStatus(status);
  if (f === 'locked') return status === 'locked';
  return status === 'available' || status === 'unaffordable';
}

export function filterCounts(ctx: HangarContext): Record<HangarFilter, number> {
  const out = { all: 0, owned: 0, forSale: 0, locked: 0 };
  for (const s of SHIPS) {
    const st = statusOf(ctx, s.id);
    for (const f of HANGAR_FILTERS) if (matchesFilter(st, f)) out[f] += 1;
  }
  return out;
}

/* --------------------------------------------------------------- sorting */

export const HANGAR_SORTS = Object.freeze(['roster', 'class', 'hull', 'maxSpeed', 'turnRate', 'cargo', 'sensor'] as const);
export type HangarSort = (typeof HANGAR_SORTS)[number];

export const SORT_LABEL: Readonly<Record<HangarSort, string>> = Object.freeze({
  roster: 'YARD ORDER',
  class: 'CLASS A–Z',
  hull: 'HULL',
  maxSpeed: 'TOP SPEED',
  turnRate: 'HANDLING',
  cargo: 'CARGO HOLD',
  sensor: 'SENSOR RANGE',
});

export const nextSort = (s: HangarSort): HangarSort => HANGAR_SORTS[(HANGAR_SORTS.indexOf(s) + 1) % HANGAR_SORTS.length]!;

/** The visible catalogue: roster ships matching the filter, in the chosen order (ties keep roster order). */
export function catalogue(ctx: HangarContext, filter: HangarFilter, sort: HangarSort): ShipId[] {
  const rows = SHIPS.map((s, i) => ({ id: s.id, i, role: s.role, status: statusOf(ctx, s.id), stats: sort === 'roster' || sort === 'class' ? null : shipAsFlown(ctx, s.id).stats }));
  const shown = rows.filter((r) => matchesFilter(r.status, filter));
  if (sort === 'class') shown.sort((a, b) => a.role.localeCompare(b.role, 'en') || a.i - b.i);
  else if (sort !== 'roster') shown.sort((a, b) => b.stats![sort] - a.stats![sort] || a.i - b.i);
  return shown.map((r) => r.id);
}

/* ------------------------------------------------------------ highlights */

export type HighlightKey = StatKey | 'output' | 'starter' | 'tow' | 'recovered' | `class-${WeaponClass}`;

export interface Highlight {
  readonly key: HighlightKey;
  /** Short card label. */
  readonly short: string;
  /** Sentence for the info panel. */
  readonly text: string;
}

const STAT_HIGHLIGHT: Readonly<Record<StatKey, string>> = Object.freeze({
  hull: 'TOUGHEST HULL',
  shield: 'STRONGEST SHIELD',
  shieldRegen: 'FASTEST SHIELD RECHARGE',
  accel: 'QUICKEST THRUST',
  maxSpeed: 'FASTEST',
  turnRate: 'BEST HANDLING',
  energy: 'MOST BOOST ENERGY',
  energyRegen: 'FASTEST ENERGY RECHARGE',
  cargo: 'BIGGEST HOLD',
  sensor: 'LONGEST SENSORS',
  travel: 'LOWEST DRIVE CHARGE',
});

/** Order highlights appear in (most defining first). */
const HIGHLIGHT_ORDER: readonly StatKey[] = ['maxSpeed', 'hull', 'cargo', 'sensor', 'shield', 'turnRate', 'accel', 'travel', 'energy', 'shieldRegen', 'energyRegen'];

/** Weapon numbers derived from a weapon profile (60 Hz ticks). `output` assumes every bolt hits. */
export interface WeaponSummary {
  readonly volleysPerSecond: number;
  readonly boltsPerVolley: number;
  readonly damagePerBolt: number;
  /** Damage per second if every bolt hits (an upper bound, not a measured average). */
  readonly output: number;
  /** Bolt reach in art px at rest (shot speed × life); the ship's own speed adds to it in flight. */
  readonly reach: number;
  readonly shotSpeed: number;
}

export function weaponSummary(w: WeaponProfile): WeaponSummary {
  const volleys = 60 / w.cooldownTicks;
  return { volleysPerSecond: volleys, boltsPerVolley: w.bolts, damagePerBolt: w.damage, output: volleys * w.bolts * w.damage, reach: (w.shotSpeed * w.lifeTicks) / 60, shotSpeed: w.shotSpeed };
}

const stockWeapon = (id: ShipId): WeaponProfile | null => {
  const item = EQUIPMENT_BY_ID.get(SHIP_BY_ID.get(id)!.stock.weapon[0] ?? '');
  return item && item.slot === 'weapon' ? item.weapon : null;
};

/**
 * What the hull is best at in the yard, from the stock roster (strictly the
 * single best value; ties give no highlight), plus facts that are true by
 * definition: the starter, a weapon class no other hull accepts, the highest
 * stock fire output.
 */
export function yardHighlights(id: ShipId): Highlight[] {
  const out: Highlight[] = [];
  if (id === STARTER_SHIP) out.push({ key: 'starter', short: 'STARTER SHIP', text: 'Issued to every new pilot: always owned.' });
  const stock = new Map(SHIPS.map((s) => [s.id, deriveStats(s, s.stock)] as const));
  const best = (k: StatKey): ShipId | null => {
    const better = STAT_INFO[k].higherIsBetter ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;
    let top: ShipId | null = null;
    let tie = false;
    for (const s of SHIPS) {
      const v = stock.get(s.id)![k];
      if (top === null || better(v, stock.get(top)![k])) {
        top = s.id;
        tie = false;
      } else if (v === stock.get(top)![k]) tie = true;
    }
    return tie ? null : top;
  };
  for (const k of HIGHLIGHT_ORDER) if (best(k) === id) out.push({ key: k, short: STAT_HIGHLIGHT[k], text: `${STAT_HIGHLIGHT[k].charAt(0)}${STAT_HIGHLIGHT[k].slice(1).toLowerCase()} in the yard (stock fit).` });
  const outputs = SHIPS.map((s) => ({ id: s.id, v: weaponSummary(stockWeapon(s.id)!).output }));
  const topOut = Math.max(...outputs.map((o) => o.v));
  if (outputs.filter((o) => o.v === topOut).length === 1 && outputs.find((o) => o.v === topOut)!.id === id) out.push({ key: 'output', short: 'HIGHEST FIRE OUTPUT', text: 'Highest stock fire output in the yard.' });
  // P10.1: what the data says about the recovery roles (never a claimed stat)
  const d = SHIP_BY_ID.get(id)!;
  if (d.towRig) out.push({ key: 'tow', short: 'TOW RIG', text: `Cancels ${Math.round(d.towRig * 100)}% of the towing penalty.` });
  if (d.salvage) out.push({ key: 'recovered', short: 'RECOVERED HULL', text: 'Never sold: recovered from its Raid Box.' });
  for (const c of WEAPON_CLASSES) {
    const takers = SHIPS.filter((s) => s.weaponClasses.includes(c));
    if (takers.length === 1 && takers[0]!.id === id) out.push({ key: `class-${c}`, short: `${c.toUpperCase()} HARDPOINTS`, text: `The only hull that accepts ${c} weapons.` });
  }
  return out;
}

/* ------------------------------------------------------------ comparison */

/** Owned ships the inspected one can be compared with (the flown ship first, then roster order). */
export function compareTargets(ctx: HangarContext, inspected: ShipId): ShipId[] {
  const f = ctx.fleet;
  return [f.active, ...f.owned.filter((id) => id !== f.active)].filter((id) => id !== inspected);
}

/** Default comparison: the ship flown (none when it is the one inspected). */
export function defaultCompare(ctx: HangarContext, inspected: ShipId): ShipId | null {
  return ctx.fleet.active !== inspected ? ctx.fleet.active : null;
}

/** A chosen comparison is kept while it is still valid (owned, not the inspected ship); else the default. */
export function resolveCompare(ctx: HangarContext, inspected: ShipId, chosen: ShipId | null | undefined): ShipId | null {
  if (chosen === null) return null;
  if (chosen !== undefined && compareTargets(ctx, inspected).includes(chosen)) return chosen;
  return defaultCompare(ctx, inspected);
}

/** The next comparison when the player cycles: every target, then none, then round again. */
export function nextCompare(ctx: HangarContext, inspected: ShipId, current: ShipId | null): ShipId | null {
  const options: (ShipId | null)[] = [...compareTargets(ctx, inspected), null];
  return options[(options.indexOf(current) + 1) % options.length] ?? null;
}

export interface HangarStatRow {
  readonly key: StatKey;
  readonly label: string;
  readonly value: number;
  /** 0..1 on the roster scale (fuller = better). */
  readonly fill: number;
  /** The comparison ship's value and fill on the same scale (null = no comparison). */
  readonly other: number | null;
  readonly otherFill: number | null;
  /** +1 better than the comparison ship, -1 worse, 0 same or no comparison. */
  readonly delta: -1 | 0 | 1;
}

export function statRows(ctx: HangarContext, id: ShipId, against: ShipId | null): HangarStatRow[] {
  const a = shipAsFlown(ctx, id).stats;
  const b: ShipStats | null = against ? shipAsFlown(ctx, against).stats : null;
  return COMPARE_KEYS.map((k) => {
    const info = STAT_INFO[k];
    let delta: -1 | 0 | 1 = 0;
    if (b) {
      const diff = a[k] - b[k];
      const eps = Math.abs(b[k]) * 1e-6 + 1e-9;
      delta = Math.abs(diff) <= eps ? 0 : (diff > 0) === info.higherIsBetter ? 1 : -1;
    }
    return { key: k, label: info.label, value: a[k], fill: barFill(k, a[k]), other: b ? b[k] : null, otherFill: b ? barFill(k, b[k]) : null, delta };
  });
}

/* ----------------------------------------------------------- pilot skill */

/** The P03 missile is a pilot skill every ship carries: the same numbers for all of them. */
export interface MissileSpecLike {
  readonly damage: number;
  readonly lockTicks: number;
  readonly cooldownTicks: number;
  readonly energy: number;
  readonly range: number;
}

export interface PilotSkillLine {
  readonly damage: number;
  readonly lockSeconds: number;
  readonly cooldownSeconds: number;
  readonly energyCost: number;
  readonly range: number;
  /** Launches a full energy bar pays for (the cooldown still applies between them). */
  readonly perFullEnergy: number;
}

export function pilotSkill(m: MissileSpecLike, energyCapacity: number): PilotSkillLine {
  return { damage: m.damage, lockSeconds: m.lockTicks / 60, cooldownSeconds: m.cooldownTicks / 60, energyCost: m.energy, range: m.range, perFullEnergy: m.energy > 0 ? Math.floor(energyCapacity / m.energy) : 0 };
}
