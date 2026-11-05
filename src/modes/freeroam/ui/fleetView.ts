/**
 * P11.2 Fleet Command view model (docs/freeroam/FLEET_COMMAND.md "Fleet panel"). Pure: no DOM,
 * no state, unit-tested (tests/fleetPanel.test.ts). It lives in the lazy Fleet panel chunk with
 * ui/fleetPanel.ts and decides nothing itself: every price comes from the kit's hullPrice, every
 * refusal from the kit's own checks (hullRefusal, captainRefusal, assignCaptain run as a dry run,
 * attackRefusal through the shell), every word for a refusal from refusalText / orderRefusalText.
 * The kit arrives in the context (a type import here), so this chunk never pulls fleet rules in.
 */
import type { UnlockRequirement } from '../catalogue/types.ts';
import type { CommandRefusal, PurchaseWorld } from '../fleet/command.ts';
import { unitWord, vesselCapacity, vesselHold, vesselNo, type FleetKit, type FleetUnit, type FleetVessel, type Vessels } from '../fleet/vessels.ts';
import type { OrderRefusal } from '../fleet/wing.ts';
import type { RequirementInfo } from '../galaxy/progress.ts';
import { collectiveCargo, holdUnits, inventoryRows, type CollectiveCargo, type Hold } from '../inventory/inventory.ts';
import { resourceName } from '../inventory/resources.ts';
import { formatMarks } from '../progression/ledger.ts';
import { SHIP_BY_ID, SHIPS } from '../ships/roster.ts';
import type { ShipId } from '../ships/types.ts';

/** The sector's side of the panel: the flying units and the pilot's own lock (null docked or between sectors). */
export interface FleetFlight {
  readonly units: readonly FleetUnit[];
  /** The pilot's locked target (combat/shipLock), or null. */
  readonly target: number | null;
  readonly targetName: string | null;
  /** The kit's attackRefusal for that target (null: it may be attacked). */
  readonly attack: OrderRefusal | null;
}

export interface FleetContext {
  readonly kit: FleetKit;
  readonly vessels: Vessels;
  /** The same world the shell's fleetAct checks against (docked, safe, admin, crew, wallet, hold, licences). */
  readonly world: PurchaseWorld;
  readonly flight: FleetFlight | null;
  readonly crewName: (id: string) => string;
  readonly crewRole: (id: string) => string;
  readonly describe: (req: UnlockRequirement) => RequirementInfo;
}

/** Operational states the model has (FleetVessel.status, FleetUnit.state, captain): nothing else is shown. */
export type VesselState = 'flying' | 'disabled' | 'ready' | 'uncrewed' | 'reserve' | 'away';

export interface VesselRow {
  readonly id: string;
  readonly no: string;
  readonly ship: ShipId;
  /** "SHRIKE · ESCORT 1" (the number is the vessel id's, never the list position). */
  readonly name: string;
  readonly role: string;
  readonly captain: string | null;
  readonly captainText: string;
  readonly state: VesselState;
  readonly stateText: string;
  /** Hull and shield of the flying unit; null when the vessel is not in the sector. */
  readonly hull: string | null;
  /** Cargo aboard: \"CARGO 12 / 30\" (the vessel's hold against its stock archetype capacity). */
  readonly cargo: string;
  readonly order: string;
  readonly status: FleetVessel['status'];
}

const shipName = (id: ShipId): string => SHIP_BY_ID.get(id)?.name ?? id;
export const vesselName = (v: Pick<FleetVessel, 'id' | 'ship'>): string => `${shipName(v.ship).toUpperCase()} · ESCORT ${vesselNo(v.id)}`;

const STATE_TEXT: Readonly<Record<VesselState, string>> = {
  flying: 'DEPLOYED · FLYING WITH YOU',
  disabled: 'DISABLED · OUT OF THE FIGHT UNTIL YOU DOCK',
  ready: 'AVAILABLE · LAUNCHES WITH YOU',
  uncrewed: 'UNCREWED · NEEDS A CAPTAIN TO LAUNCH',
  reserve: 'OUT OF SERVICE · STAYS AT THE STATION',
  away: 'NOT IN THIS SECTOR',
};

export function vesselRows(c: FleetContext): VesselRow[] {
  return c.vessels.list.map((v) => {
    const u = c.flight?.units.find((x) => x.spec.vessel === v.id) ?? null;
    const state: VesselState = u ? (u.state === 'disabled' ? 'disabled' : 'flying') : v.status === 'disabled' ? 'disabled' : v.status === 'reserve' ? 'reserve' : !v.captain ? 'uncrewed' : c.flight ? 'away' : 'ready';
    let order = 'FOLLOW (EVERY LAUNCH STARTS IN FORMATION)';
    if (u) {
      const w = unitWord(u);
      order = u.order.kind === 'attack' && u.state === 'active' ? `${w} · ${u.order.target === c.flight!.target && c.flight!.targetName ? c.flight!.targetName : 'ORDERED TARGET'}` : w;
    } else if (state !== 'ready') order = '—';
    return {
      id: v.id,
      no: vesselNo(v.id),
      ship: v.ship,
      name: vesselName(v),
      role: SHIP_BY_ID.get(v.ship)?.role ?? '',
      captain: v.captain,
      captainText: v.captain ? `CAPTAIN ${c.crewName(v.captain).toUpperCase()}` : 'NO CAPTAIN',
      state,
      stateText: STATE_TEXT[state],
      hull: u ? `HULL ${Math.ceil(u.hull)} / ${u.spec.stats.hull} · SHIELD ${Math.ceil(u.shield)} / ${u.spec.stats.shield}` : null,
      cargo: `CARGO ${holdUnits(vesselHold(c.vessels, v.id))} / ${vesselCapacity(v.ship)}`,
      order,
      status: v.status,
    };
  });
}

export interface HullRow {
  readonly ship: ShipId;
  readonly name: string;
  readonly role: string;
  readonly description: string;
  /** Hull materials + Guild commission, from the kit's hullPrice. */
  readonly cost: string;
  readonly marks: number;
  readonly licence: string;
  readonly refusal: CommandRefusal | null;
  readonly why: string | null;
}

const materials = (cargo: readonly { readonly resource: string; readonly amount: number }[]): string => (cargo.length ? cargo.map((m) => `${m.amount} ${resourceName(m.resource).toUpperCase()}`).join(' + ') : 'NO HULL MATERIALS');

/** Every archetype the Guild builds as a fleet hull (recovered unique hulls have no price and are listed by hullsNotBuilt). */
export function hullRows(c: FleetContext): HullRow[] {
  const out: HullRow[] = [];
  for (const d of SHIPS) {
    const p = c.kit.hullPrice(d.id);
    if (!p) continue;
    const r = c.kit.hullRefusal(c.vessels, d.id, c.world);
    const lic = p.licence.map((q) => c.describe(q));
    out.push({
      ship: d.id,
      name: d.name.toUpperCase(),
      role: d.role,
      description: d.description,
      cost: `${materials(p.cargo)} · COMMISSION ${formatMarks(p.marks)}`,
      marks: p.marks,
      licence: lic.length ? `LICENCE: ${lic.map((l) => `${l.title}${l.met ? ' ✓' : ' (NOT YET)'}`).join(', ')}` : 'NO LICENCE NEEDED',
      refusal: r,
      why: r ? c.kit.refusalText(r) : null,
    });
  }
  return out;
}

/** Names of the archetypes that are never built as fleet hulls (the kit's hullPrice says null). */
export const hullsNotBuilt = (c: FleetContext): string[] => SHIPS.filter((d) => !c.kit.hullPrice(d.id)).map((d) => d.name);

export interface CrewRow {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly refusal: CommandRefusal | null;
  readonly why: string | null;
  /** The vessel this captain would leave (left uncrewed): the choice needs a confirmation. */
  readonly moveFrom: string | null;
  /** The captain this choice sends back to the roster. */
  readonly replaces: string | null;
}

/** Where a crew member sits aboard one of the pilot's ships, if anywhere. */
const seatOf = (c: FleetContext, id: string): string | null => {
  for (const [ship, ids] of Object.entries(c.world.crew.seats)) if (ids?.includes(id)) return shipName(ship as ShipId);
  return null;
};

/**
 * The recruited crew as captain candidates: for a new hull (`vessel` null: the kit's
 * captainRefusal) or for an owned vessel (the kit's assignCaptain as a dry run, so a move from
 * another vessel and a replaced captain are known before anything changes).
 */
export function crewRows(c: FleetContext, vessel: string | null): CrewRow[] {
  return c.world.crew.hired.map((id) => {
    let refusal: CommandRefusal | null;
    let moveFrom: string | null = null;
    let replaces: string | null = null;
    if (vessel === null) refusal = c.kit.captainRefusal(c.vessels, id, c.world);
    else {
      const r = c.kit.assignCaptain(c.vessels, vessel, id, c.world);
      refusal = r.ok ? null : r.reason;
      if (r.ok) {
        const from = r.moved ? c.vessels.list.find((x) => x.id === r.moved) : undefined;
        moveFrom = from ? vesselName(from) : null;
        replaces = r.released ? c.crewName(r.released) : null;
      }
    }
    let why = refusal ? c.kit.refusalText(refusal) : null;
    if (refusal === 'seated') why = `${why} Seated aboard the ${seatOf(c, id) ?? 'ship'} (Hangar · BRIDGE).`;
    else if (refusal === 'captain') {
      const at = c.vessels.list.find((x) => x.captain === id);
      if (at) why = `${why} (${vesselName(at)})`;
    } else if (refusal === 'same') why = 'Already captains this vessel.';
    return { id, name: c.crewName(id), role: c.crewRole(id), refusal, why, moveFrom, replaces };
  });
}

export type OrderKind = 'follow' | 'hold' | 'defend' | 'attack';
export const ORDER_KINDS: readonly OrderKind[] = ['follow', 'hold', 'defend', 'attack'];
export const ORDER_LABEL: Readonly<Record<OrderKind, string>> = { follow: 'FOLLOW', hold: 'HOLD', defend: 'DEFEND', attack: 'ATTACK' };
export const ORDER_HELP: Readonly<Record<OrderKind, string>> = {
  follow: 'Fly in formation beside you.',
  hold: 'Hold where they are now.',
  defend: 'Engage hostiles that come near you.',
  attack: 'Attack your locked target.',
};

export interface OrderChoice {
  readonly kind: OrderKind;
  readonly label: string;
  /** Why this order cannot be given now (the kit's words), or null. */
  readonly why: string | null;
}

/** The four orders for one vessel (`who` = its id) or every active vessel ('all'), with the refusal each would get. */
export function orderChoices(c: FleetContext, who: string): OrderChoice[] {
  const f = c.flight;
  const units = f?.units ?? [];
  const picked = who === 'all' ? units.filter((u) => u.state === 'active') : units.filter((u) => u.spec.vessel === who);
  const base: OrderRefusal | null = !units.length ? 'no-wing' : who !== 'all' && !picked.length ? 'unknown-vessel' : !picked.length || picked.some((u) => u.state !== 'active') ? 'disabled' : null;
  return ORDER_KINDS.map((kind) => {
    const r = base ?? (kind === 'attack' ? (f?.attack ?? null) : null);
    return { kind, label: ORDER_LABEL[kind], why: r ? c.kit.orderRefusalText(r) : null };
  });
}

/** The panel head: vessels against the cap, captains, the balance. */
export function fleetHead(c: FleetContext, cap: number): string {
  const n = c.vessels.list.length;
  const crewed = c.vessels.list.filter((v) => v.captain).length;
  return `FLEET ${n} / ${cap} · ${crewed} ${crewed === 1 ? 'CAPTAIN' : 'CAPTAINS'} · ${formatMarks(c.world.marks)}`;
}

/* ------------------------------------------------------- collective cargo */

/** The pilot's own hold as the panel sees it (deps mirror the shell's inventory panel). */
export interface PlayerHold {
  readonly shipName: string;
  readonly hold: Hold;
  readonly capacity: number;
}

/**
 * The aboard-ship cargo of the pilot and every owned fleet vessel: one total, per-hold lines and a
 * grouped types line. Published from the live state every refresh (no cache, no polling): a flying
 * unit is its saved vessel's runtime shape, so its cargo lands under the vessel id exactly once.
 */
export function collectiveView(c: FleetContext, own: PlayerHold): CollectiveCargo {
  return collectiveCargo(own.shipName, own.hold, own.capacity, c.vessels.list.map((v) => ({ name: vesselName(v), hold: vesselHold(c.vessels, v.id), capacity: vesselCapacity(v.ship) })));
}

/** `42 / 85 UNITS · 43 FREE` + per-hold lines + the grouped types line (empty types line omitted). */
export function collectiveLines(cc: CollectiveCargo): string[] {
  const out = [`${cc.used} / ${cc.capacity} UNITS · ${cc.free} FREE`];
  for (const h of cc.holds) out.push(`${h.name.toUpperCase()} · ${h.used} / ${h.capacity}`);
  if (cc.byType.length) out.push(cc.byType.map((e) => `${resourceName(e.resource).toUpperCase()} ${e.amount}`).join(' · '));
  return out;
}

/* --------------------------------------------------------- transfer view */

/** One cargo kind in the transfer step: how much sits at each end (0 where absent). */
export interface TransferRow {
  readonly resource: string;
  readonly name: string;
  readonly from: number;
  readonly to: number;
}

/** The rows the transfer step offers: every known kind present at either end, in the cargo panel's order. */
export function transferRows(fromHold: Hold, toHold: Hold): TransferRow[] {
  return inventoryRows({ ...toHold, ...fromHold }, Number.MAX_SAFE_INTEGER).map((r) => ({ resource: r.def.id as string, name: r.def.name.toUpperCase(), from: fromHold[r.def.id] ?? 0, to: toHold[r.def.id] ?? 0 }));
}

/** The most an end-to-end move may still carry: source amount and destination free space. */
export const transferMax = (rowFrom: number, toHold: Hold, toCap: number): number => Math.min(rowFrom, Math.max(0, Math.floor(toCap) - holdUnits(toHold)));
