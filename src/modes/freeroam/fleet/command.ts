/**
 * P11.1 Fleet Command rules (lazy fleet chunk; FLEET_COMMAND.md): the authoritative purchase,
 * captain and service changes. Pure: every function takes the current state and returns a new
 * one or a refusal, and a refusal changes nothing. The shell commits a purchase atomically (marks
 * through the ledger with the transaction id, the hold through the Hangar's own payment, the new
 * vessel, one save).
 *
 * A fleet hull is never the pilot's Hangar: buying one does not add a ship to `FleetState`, change
 * the selected ship or touch its loadout.
 */
import type { ResourceId, UnlockRequirement } from '../catalogue/types.ts';
import { addLoot, holdUnits, removeLoot, validQty, type Hold } from '../inventory/inventory.ts';
import { isResourceId } from '../inventory/resources.ts';
import type { LootEntry } from '../sector/model.ts';
import { SHIP_BY_ID } from '../ships/roster.ts';
import type { ResourceCost, ShipId } from '../ships/types.ts';
import { FLEET_COMMAND, fleetHull, seatedCrew, VESSEL_ID, vesselCapacity, vesselHold, type CrewRoster, type FleetVessel, type Vessels } from './vessels.ts';

/**
 * Price of a fleet hull = the catalogue's own price for that archetype (its material cost and its
 * licence, read from ships/roster.ts, never copied) plus a Guild commission in marks for crewing
 * and fitting a second hull: 100 marks (the cheapest stored module, progression/economy.ts) plus
 * 4 marks per unit of hull material, rounded to 10. The Petrel's catalogue cost is empty (it is
 * the free starter), so its fleet hull costs the base commission only: no hull is free.
 */
export const FLEET_PRICING = Object.freeze({ base: 100, perUnit: 4, round: 10 });

export interface HullPrice {
  readonly ship: ShipId;
  /** Hull materials (the catalogue cost; the same resource types as buying the ship). */
  readonly cargo: readonly ResourceCost[];
  /** Guild commission in marks. */
  readonly marks: number;
  readonly licence: readonly UnlockRequirement[];
}

/** The price of a fleet hull of archetype `id`; null when it cannot be a fleet vessel (unknown, or a recovered unique hull). */
export function hullPrice(id: string): HullPrice | null {
  const ship = fleetHull(id);
  if (!ship) return null;
  const d = SHIP_BY_ID.get(ship)!;
  const units = d.cost.reduce((n, c) => n + c.amount, 0);
  const R = FLEET_PRICING.round;
  return { ship, cargo: d.cost, marks: Math.round((FLEET_PRICING.base + FLEET_PRICING.perUnit * units) / R) * R, licence: d.licence };
}

/** What every fleet command reads. Changes happen only docked with no hostile engaged (the crew seat rule). */
export interface CommandWorld {
  readonly docked: string | null;
  readonly safe: boolean;
  /** An Admin Access session: fleet changes are refused (its fleet is a sandbox, never ownership). */
  readonly admin: boolean;
  readonly crew: CrewRoster;
  readonly knownCrew: (id: string) => boolean;
}

export interface PurchaseWorld extends CommandWorld {
  readonly marks: number;
  /** Hull materials still missing (the Hangar's own check, ships/hangar.ts missingFor, against the hold). */
  readonly short: (cost: readonly ResourceCost[]) => readonly ResourceCost[];
  readonly licenceMet: (req: UnlockRequirement) => boolean;
}

export type CommandRefusal =
  | 'admin'
  | 'not-docked'
  | 'unsafe'
  | 'unknown-ship'
  | 'ineligible'
  | 'locked'
  | 'materials'
  | 'marks'
  | 'full'
  | 'unknown-crew'
  | 'not-hired'
  | 'captain'
  | 'seated'
  | 'unknown-vessel'
  | 'no-captain'
  | 'disabled'
  | 'same';

const where = (w: CommandWorld): CommandRefusal | null => (w.admin ? 'admin' : w.docked === null ? 'not-docked' : !w.safe ? 'unsafe' : null);

/** May `crewId` take command of a vessel? (hired, not seated aboard a ship, not commanding another one unless `except`) */
export function captainRefusal(v: Vessels, crewId: string, w: CommandWorld, except: string | null = null): CommandRefusal | null {
  if (!w.knownCrew(crewId)) return 'unknown-crew';
  if (!w.crew.hired.includes(crewId)) return 'not-hired';
  if (v.list.some((x) => x.captain === crewId && x.id !== except)) return 'captain';
  if (seatedCrew(w.crew).includes(crewId)) return 'seated';
  return null;
}

/** Why no hull of archetype `ship` can be commissioned now, whoever captains it (the purchase checks before the captain's), or null. */
export function hullRefusal(v: Vessels, ship: string, w: PurchaseWorld): CommandRefusal | null {
  const at = where(w);
  if (at) return at;
  if (!SHIP_BY_ID.has(ship as ShipId)) return 'unknown-ship';
  const price = hullPrice(ship);
  if (!price) return 'ineligible';
  if (!price.licence.every(w.licenceMet)) return 'locked';
  if (w.short(price.cargo).length > 0) return 'materials';
  if (w.marks < price.marks) return 'marks';
  if (v.list.length >= FLEET_COMMAND.maxVessels) return 'full';
  return null;
}

/** Why a purchase of archetype `ship` captained by `captain` is refused, or null when it may go ahead (checked in this order). */
export function purchaseRefusal(v: Vessels, ship: string, captain: string, w: PurchaseWorld): CommandRefusal | null {
  return hullRefusal(v, ship, w) ?? captainRefusal(v, captain, w);
}

export type PurchaseResult =
  | { readonly ok: true; readonly vessels: Vessels; readonly vessel: FleetVessel; readonly price: HullPrice; readonly marks: number; readonly txId: string }
  | { readonly ok: false; readonly reason: CommandRefusal };

/**
 * Commission a fleet hull: the next vessel id, in service, with its captain. Returns the new
 * vessel list, the balance after the commission and the ledger transaction id (unique per vessel
 * number, so the same purchase can never be recorded twice). The hold is paid by the caller.
 */
export function purchase(v: Vessels, ship: string, captain: string, w: PurchaseWorld): PurchaseResult {
  const reason = purchaseRefusal(v, ship, captain, w);
  if (reason) return { ok: false, reason };
  const price = hullPrice(ship)!;
  const seq = v.seq + 1;
  const vessel: FleetVessel = { id: `fv-${seq}`, ship: price.ship, captain, status: 'active' };
  return { ok: true, vessels: { seq, list: [...v.list, vessel], holds: v.holds }, vessel, price, marks: w.marks - price.marks, txId: `fleet:hull:${vessel.id}` };
}

export type CaptainResult =
  | { readonly ok: true; readonly vessels: Vessels; readonly moved: string | null; readonly released: string | null }
  | { readonly ok: false; readonly reason: CommandRefusal };

/**
 * Put `crewId` in command of `vesselId`. A captain of another vessel moves (that vessel is left
 * uncrewed: no automatic replacement); this vessel's previous captain returns to the roster.
 */
export function assignCaptain(v: Vessels, vesselId: string, crewId: string, w: CommandWorld): CaptainResult {
  const at = where(w);
  if (at) return { ok: false, reason: at };
  const target = v.list.find((x) => x.id === vesselId);
  if (!target) return { ok: false, reason: 'unknown-vessel' };
  if (target.captain === crewId) return { ok: false, reason: 'same' };
  const r = captainRefusal(v, crewId, w, null);
  if (r && r !== 'captain') return { ok: false, reason: r };
  const from = v.list.find((x) => x.captain === crewId) ?? null;
  const list = v.list.map((x) => (x.id === vesselId ? { ...x, captain: crewId } : x.id === from?.id ? { ...x, captain: null } : x));
  return { ok: true, vessels: { ...v, list }, moved: from?.id ?? null, released: target.captain };
}

/** Return a vessel's captain to the crew roster (the vessel stays owned, uncrewed: it cannot deploy). */
export function releaseCaptain(v: Vessels, vesselId: string, w: CommandWorld): CaptainResult {
  const at = where(w);
  if (at) return { ok: false, reason: at };
  const target = v.list.find((x) => x.id === vesselId);
  if (!target) return { ok: false, reason: 'unknown-vessel' };
  if (!target.captain) return { ok: false, reason: 'no-captain' };
  return { ok: true, vessels: { ...v, list: v.list.map((x) => (x.id === vesselId ? { ...x, captain: null } : x)) }, moved: null, released: target.captain };
}

/** Remove a vessel from service ('reserve': owned, stays at the station) or return it ('active'). */
export function setService(v: Vessels, vesselId: string, status: 'active' | 'reserve', w: CommandWorld): { readonly ok: true; readonly vessels: Vessels } | { readonly ok: false; readonly reason: CommandRefusal } {
  const at = where(w);
  if (at) return { ok: false, reason: at };
  const target = v.list.find((x) => x.id === vesselId);
  if (!target) return { ok: false, reason: 'unknown-vessel' };
  if (target.status === status) return { ok: false, reason: 'same' };
  // a disabled vessel returns to service only through the dock rule (serviceAtDock), never by a status switch
  if (target.status === 'disabled') return { ok: false, reason: 'disabled' };
  return { ok: true, vessels: { ...v, list: v.list.map((x) => (x.id === vesselId ? { ...x, status } : x)) } };
}

/** Plain words for a refusal (the P11.2 Fleet panel shows these; the marker string below is the lazy chunk's verifier mark). */
export function refusalText(r: CommandRefusal): string {
  switch (r) {
    case 'admin':
      return 'Fleet Command is closed during Admin Access.';
    case 'not-docked':
      return 'Fleet hulls are commissioned and crewed only at a station.';
    case 'unsafe':
      return 'Fleet changes wait until no hostiles are engaged.';
    case 'unknown-ship':
      return 'Unknown hull.';
    case 'ineligible':
      return 'Recovered hulls are unique: the Guild never builds a second one.';
    case 'locked':
      return 'This hull needs its licence first.';
    case 'materials':
      return 'Not enough hull materials in the hold.';
    case 'marks':
      return 'Not enough marks for the Guild commission.';
    case 'full':
      return `The Guild commissions at most ${FLEET_COMMAND.maxVessels} fleet vessels per pilot.`;
    case 'unknown-crew':
      return 'Unknown crew member.';
    case 'not-hired':
      return 'Sign this crew member on first.';
    case 'captain':
      return 'Already captains a fleet vessel.';
    case 'seated':
      return 'Sits aboard one of your ships. Unassign them first.';
    case 'unknown-vessel':
      return 'Unknown fleet vessel.';
    case 'disabled':
      return 'That vessel is disabled. Docking at a station returns it to service.';
    case 'no-captain':
      return 'This vessel has no captain.';
    case 'same':
      return 'Nothing to change.';
  }
}

/** Notice for a completed purchase (also the verifier marker of this chunk: never in eager code). */
export const commissionedText = (name: string): string => `FLEET HULL COMMISSIONED · ${name.toUpperCase()}`;

/* -------------------------------------------------------- cargo transfer */

/**
 * Post-release fleet cargo: moving cargo between the pilot's hold and a fleet vessel's hold while
 * docked. Pure and atomic, like purchase(): the caller gets the next vessels and the next hold and
 * commits both in one save; a refusal changes nothing. Capacity is each end's real figure (the
 * flown ship's derived hold, a vessel's stock archetype capacity) and the destination takes only
 * what fits (addLoot's established rule): the rest stays with the source, so nothing is lost.
 */

/** One end of a cargo transfer: the pilot's own hold ('hold') or a vessel id. */
export type TransferEnd = 'hold' | (string & {});

export type TransferRefusal = CommandRefusal | 'unknown-resource' | 'bad-amount' | 'short' | 'no-room' | 'same-end';

export interface TransferResult {
  readonly ok: true;
  readonly vessels: Vessels;
  /** The pilot's hold after the transfer (identical when the ship was not an end). */
  readonly hold: Hold;
  /** What actually moved. */
  readonly moved: LootEntry[];
  /** What could not move because the destination had no room (stays with the source). */
  readonly left: LootEntry[];
}

interface Ends {
  readonly source: Hold;
  readonly dest: Hold;
  readonly destCap: number;
  readonly fromVessel: string | null;
  readonly toVessel: string | null;
}

function ends(v: Vessels, from: string, to: string, hold: Hold, holdCap: number, w: CommandWorld): { readonly ok: true; readonly e: Ends } | { readonly ok: false; readonly reason: TransferRefusal } {
  const at = where(w);
  if (at) return { ok: false, reason: at };
  if (from === to) return { ok: false, reason: 'same-end' };
  const one = (id: string): { readonly h: Hold; readonly cap: number; readonly v: string | null } | null => {
    if (id === 'hold') return { h: hold, cap: holdCap, v: null };
    if (!VESSEL_ID.test(id)) return null;
    const x = v.list.find((q) => q.id === id);
    return x ? { h: vesselHold(v, id), cap: vesselCapacity(x.ship), v: id } : null;
  };
  const f = one(from);
  const t = one(to);
  if (!f || !t) return { ok: false, reason: 'unknown-vessel' };
  return { ok: true, e: { source: f.h, dest: t.h, destCap: t.cap, fromVessel: f.v, toVessel: t.v } };
}

/** Why this transfer cannot happen now, or null when it may (checked in this order). */
export function transferRefusal(v: Vessels, from: string, to: string, resource: string, amount: number, hold: Hold, holdCap: number, w: CommandWorld): TransferRefusal | null {
  const e = ends(v, from, to, hold, holdCap, w);
  if (!e.ok) return e.reason;
  if (!isResourceId(resource)) return 'unknown-resource';
  if (!validQty(amount)) return 'bad-amount';
  const have = validQty(e.e.source[resource]) ? e.e.source[resource]! : 0;
  if (have < amount) return 'short';
  if (holdUnits(e.e.dest) >= Math.floor(e.e.destCap)) return 'no-room';
  return null;
}

/** Move `amount` units of `resource` between the ends; the destination takes what fits, the rest stays with the source. */
export function transfer(v: Vessels, from: string, to: string, resource: string, amount: number, hold: Hold, holdCap: number, w: CommandWorld): TransferResult | { readonly ok: false; readonly reason: TransferRefusal } {
  const r0 = transferRefusal(v, from, to, resource, amount, hold, holdCap, w);
  if (r0) return { ok: false, reason: r0 };
  const { e } = ends(v, from, to, hold, holdCap, w) as { readonly ok: true; readonly e: Ends };
  // both halves are computed from the pre-transfer state: the move is atomic by construction
  const res = resource as ResourceId; // transferRefusal already accepted it
  // only what fits ever leaves the source — nothing is lost to a full hold
  const take = Math.min(amount, Math.max(0, Math.floor(e.destCap) - holdUnits(e.dest)));
  const src = removeLoot(e.source, [{ resource: res, amount: take }])!;
  const add = addLoot(e.dest, [{ resource: res, amount: take }], e.destCap);
  const put = (vs: Vessels, vid: string, next: Hold): Vessels => {
    const holds = { ...vs.holds };
    if (Object.keys(next).length > 0) holds[vid] = next;
    else delete holds[vid];
    return { ...vs, holds };
  };
  let vessels = v;
  let nextHold = hold;
  if (e.fromVessel) vessels = put(vessels, e.fromVessel, src);
  else nextHold = src;
  if (e.toVessel) vessels = put(vessels, e.toVessel, add.hold);
  else nextHold = add.hold;
  const left = amount - take;
  return { ok: true, vessels, hold: nextHold, moved: add.taken, left: left > 0 ? [{ resource: res, amount: left }] : [] };
}

/** Plain words for a transfer refusal (same convention as refusalText). */
export function transferRefusalText(r: TransferRefusal): string {
  switch (r) {
    case 'unknown-resource': return 'Unknown cargo.';
    case 'bad-amount': return 'Give a whole, positive amount to move.';
    case 'short': return 'The source hold no longer has that much (the panel was open while it changed).';
    case 'no-room': return 'The destination hold is full.';
    case 'same-end': return 'Source and destination are the same hold.';
    default: return refusalText(r);
  }
}
