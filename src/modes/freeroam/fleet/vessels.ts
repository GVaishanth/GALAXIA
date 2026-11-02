/**
 * P11.1 Fleet Command: the persistent fleet-vessel record (docs/freeroam/FLEET_COMMAND.md).
 *
 * Naming: the player's owned ships are the Hangar (`FleetState`, `profile.fleet`). A
 * *fleet vessel* is a separate hull of an existing archetype (ships/roster.ts, never a stats
 * copy) commanded by a recruited captain, flying beside the pilot. This file is the small,
 * eager half: the record, the cap, the clean-up that makes any saved shape safe, and the
 * runtime types the sector reads. Purchase, captains, orders and the simulation live in the
 * lazy fleet chunk (fleet/fleetKit.ts), which the shell imports only when a vessel exists or a
 * purchase is asked for.
 *
 * Captains vs advisors: a captain commands a vessel and never sits in a seat aboard the ship
 * the pilot flies, so the onboard advisors (crew/advisor.ts, which read only seated crew) never
 * see them. Crew are passed in as plain ids (`CrewRoster`); this folder imports nothing from crew/.
 */
import type { CritToken } from '../combat/critical.ts';
import type { SavedVessels } from '../profile.ts';
import { SHIP_BY_ID } from '../ships/roster.ts';
import type { ShipDef, ShipId, ShipStats, WeaponProfile } from '../ships/types.ts';
import type { ShipState, ShipTuning } from '../sim.ts';
import type * as Kit from './fleetKit.ts';
import type { OrderRequest } from './wing.ts';

/** The one cap on fleet vessels (purchase refuses past it; a save holding more is trimmed). */
export const FLEET_COMMAND = Object.freeze({ maxVessels: 3 });

export const VESSEL_STATUSES = Object.freeze(['active', 'reserve', 'disabled'] as const);
/** active: deploys when crewed · reserve: removed from service by the pilot · disabled: knocked out (back in service at the next dock). */
export type VesselStatus = (typeof VESSEL_STATUSES)[number];

/** One owned fleet vessel (persistent). Orders, positions and hull points are runtime only (FleetUnit). */
export interface FleetVessel {
  /** Stable unique id, `fv-<n>`; numbers are never reused (Vessels.seq). */
  readonly id: string;
  /** Archetype from the ship catalogue (stats come from there, never from the save). */
  readonly ship: ShipId;
  /** Crew id of the captain, or null (uncrewed: it cannot deploy). */
  readonly captain: string | null;
  readonly status: VesselStatus;
}

export interface Vessels {
  /** Last vessel number issued. */
  readonly seq: number;
  readonly list: readonly FleetVessel[];
}

export const NO_VESSELS: Vessels = Object.freeze({ seq: 0, list: Object.freeze([]) });

export const VESSEL_ID = /^fv-[1-9][0-9]{0,5}$/;

/** Crew as plain ids (the shell passes CrewState; fleet code never imports crew/). */
export interface CrewRoster {
  readonly hired: readonly string[];
  readonly seats: Readonly<Record<string, readonly string[] | undefined>>;
}

/** The archetype if it may be a fleet vessel: a catalogue ship that is sold (Heron and Raven are unique recovered hulls: never). */
export function fleetHull(id: string): ShipId | null {
  const d = SHIP_BY_ID.get(id as ShipId);
  return d && !d.salvage ? d.id : null;
}

export const captainsOf = (v: Vessels): string[] => v.list.flatMap((x) => (x.captain ? [x.captain] : []));
export const seatedCrew = (c: CrewRoster): string[] => Object.values(c.seats).flatMap((s) => s ?? []);
/** Deploys into a sector: in service and crewed. */
export const deployable = (x: FleetVessel): boolean => x.status === 'active' && x.captain !== null;

/**
 * Make any saved shape safe: known sold archetypes only, unique valid ids, at most
 * FLEET_COMMAND.maxVessels, a captain only if hired, not seated aboard a ship and
 * not already commanding another vessel (otherwise the vessel stays, uncrewed).
 * Never adds a vessel or a captain. Idempotent.
 */
export function cleanVessels(raw: SavedVessels | undefined, crew: CrewRoster): { readonly state: Vessels; readonly changes: number } {
  if (!raw) return { state: NO_VESSELS, changes: 0 };
  let changes = 0;
  const seated = seatedCrew(crew);
  const list: FleetVessel[] = [];
  let seq = Number.isSafeInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0;
  for (const r of raw.list) {
    const ship = fleetHull(r.ship);
    if (!ship || !VESSEL_ID.test(r.id) || list.some((x) => x.id === r.id) || list.length >= FLEET_COMMAND.maxVessels || !VESSEL_STATUSES.includes(r.status)) {
      changes += 1;
      continue;
    }
    let captain = r.captain ?? null;
    if (captain !== null && (!crew.hired.includes(captain) || seated.includes(captain) || list.some((x) => x.captain === captain))) {
      captain = null;
      changes += 1;
    }
    list.push({ id: r.id, ship, captain, status: r.status });
    seq = Math.max(seq, Number(r.id.slice(3)));
  }
  if (seq !== raw.seq) changes += 1;
  return { state: list.length || seq ? { seq, list } : NO_VESSELS, changes };
}

/** The saved form; undefined when no vessel was ever issued (the field is then not written). */
export function vesselsToSaved(v: Vessels): SavedVessels | undefined {
  if (!v.list.length && !v.seq) return undefined;
  return { seq: v.seq, list: v.list.map((x) => (x.captain ? { id: x.id, ship: x.ship, captain: x.captain, status: x.status } : { id: x.id, ship: x.ship, status: x.status })) };
}

/** Docking services the fleet like the pilot's ship: a disabled vessel is back in service (FLEET_COMMAND.md "Disabled"). */
export function serviceAtDock(v: Vessels): Vessels {
  return v.list.some((x) => x.status === 'disabled') ? { ...v, list: v.list.map((x) => (x.status === 'disabled' ? { ...x, status: 'active' as const } : x)) } : v;
}

/* ------------------------------------------------------------ runtime types */

/** A typed order (one vessel or all). Orders are runtime only: every sector entry and load starts at Follow. */
export type FleetOrder = { readonly kind: 'follow' } | { readonly kind: 'hold'; readonly x: number; readonly y: number } | { readonly kind: 'defend' } | { readonly kind: 'attack'; readonly target: number };

/** What the shell hands the kit per deployable vessel: the archetype as the catalogue derives it (stock loadout, no upgrades). */
export interface VesselSpec {
  readonly vessel: string;
  readonly ship: ShipId;
  readonly captain: string;
  readonly stats: ShipStats;
  readonly weapon: WeaponProfile;
  readonly radius: number;
  readonly sprite: ShipDef['sprite'];
  readonly tune: ShipTuning;
}

/** One fleet vessel in the sector (temporary entity; dropped with the run). */
export interface FleetUnit {
  /** Combat id: negative (-1, -2, -3), so it can never be an enemy ship's id. */
  readonly id: number;
  readonly spec: VesselSpec;
  readonly slot: number;
  readonly ship: ShipState;
  hull: number;
  shield: number;
  sinceHit: number;
  cooldown: number;
  heat: number;
  overheated: boolean;
  /** 'disabled' at 0 hull: out of the fight, still owned and crewed. */
  state: 'active' | 'disabled';
  order: FleetOrder;
  /** Enemy ship engaged now (id), or null. */
  target: number | null;
  /** Last place the engaged ship was seen, and how long ago (contact memory). */
  seenX: number;
  seenY: number;
  lost: number;
  /** Signature the hostiles see (Silent Running is matched while the escort holds fire). */
  sig: number;
  /** Ticks since this unit last fired. */
  quiet: number;
}

/** A fleet bolt (own bounded pool: never the pilot's 24 shots). */
export interface FleetBolt {
  x: number;
  y: number;
  px: number;
  py: number;
  readonly vx: number;
  readonly vy: number;
  life: number;
  readonly damage: number;
  /** The firing unit's id. */
  readonly from: number;
  /** Finale P1: this firing event's critical (shared by twin bolts; null = ordinary). Never saved. */
  readonly crit?: CritToken | null;
}

export type FleetKit = typeof Kit;

/** The fleet wing of one sector run: the loaded kit, its units and bolts. Never saved. */
export interface Wing {
  readonly kit: FleetKit;
  readonly units: FleetUnit[];
  readonly bolts: FleetBolt[];
  /** Formation facing (eased, so slots never swing with the aim). */
  facing: number;
  /** Weapon heat model (the pilot's numbers, run.ts RUN.heat). */
  readonly heatModel: { readonly fullTicks: number; readonly coolTicks: number; readonly resumeAt: number };
}

/** One Fleet Command action (the shell's fleetAct: the Fleet panel, the Admin test fleet and QA all call it). */
export type FleetAct =
  | { readonly kind: 'buy'; readonly ship: string; readonly captain: string }
  | { readonly kind: 'captain'; readonly vessel: string; readonly crew: string }
  | { readonly kind: 'release'; readonly vessel: string }
  | { readonly kind: 'service'; readonly vessel: string; readonly status: 'active' | 'reserve' }
  | { readonly kind: 'order'; readonly who: string; readonly order: OrderRequest };

/** The number players see for a vessel (`fv-3` -> "3"): from its id, never its list position. */
export const vesselNo = (id: string): string => id.slice(3);

/** One order or state word per flying unit: disabled wins over the order it held. */
export const unitWord = (u: Pick<FleetUnit, 'state' | 'order'>): string => (u.state === 'disabled' ? 'DISABLED' : u.order.kind.toUpperCase());

/**
 * P11.2 flight HUD line (ship card): "ESCORTS 2 · FOLLOW" when every unit says the same, else
 * each vessel number with its word ("ESCORTS · 1 ATTACK · 2 DISABLED"). Empty without units.
 */
export function wingSummary(units: readonly Pick<FleetUnit, 'state' | 'order' | 'spec'>[]): string {
  if (!units.length) return '';
  const first = unitWord(units[0]!);
  return units.every((u) => unitWord(u) === first) ? `ESCORTS ${units.length} · ${first}` : `ESCORTS · ${units.map((u) => `${vesselNo(u.spec.vessel)} ${unitWord(u)}`).join(' · ')}`;
}

/** Typed wing events (SectorEvent 'fleet'). */
export type FleetChange = 'disabled' | 'fallback';
/** Why the wing re-forms on the pilot: a recall (damage kept), a restart (active vessels restored), a dock (everything serviced). */
export type RegroupMode = 'recall' | 'restart' | 'dock';
