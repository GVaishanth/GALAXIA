/**
 * Admin Access session rules (P04). Pure: no DOM, no storage, no clock.
 *
 * An admin session is a runtime privilege of one Free Roam instance; it is
 * never written anywhere. The mode (freeRoamMode.ts) holds `AdminSession |
 * null` and asks these narrow operations at the points where the normal
 * rules apply:
 *
 *   isAdmin            does the session have admin privileges?
 *   mayPersist         may the mode write the save slot / shared registry?
 *                      (never while a session is active: the sandbox)
 *   adminFleet         the fleet the sandbox flies: every roster ship usable,
 *                      loadouts / weapon setups and the flown ship unchanged
 *   adminOnlyShips     ships usable only through admin access (not owned)
 *   adminSelectShip    switch to any roster ship (the normal safe-place rule
 *                      still applies; ship characteristics are untouched)
 *   travelCost         a cost in reactor cells under the session (0 = bypassed)
 *   resolveDestination any catalogue galaxy / system, no unlock, discovery,
 *                      route or fuel requirement; unknown ids are refused
 *   adminArrive        the exploration state at a resolved destination
 *   stationApproach    a validated point beside a sector's station
 *   ADMIN_HOME         where a login arrives: Sol's station, hangar tab
 *   unlimitedAmmo      launches spend no ammunition while the session lasts
 *
 * Isolation (the important part): the session never edits the normal
 * profile. While it is active the mode's single save gateway writes nothing,
 * so everything the sandbox changes (ship, location, cells, discoveries,
 * mission or log entries) exists only in memory; exiting restarts Free Roam
 * from the untouched slot. Payment checks are bypassed by resolving the cost
 * to 0, never by granting currency, and no price, licence or economy table
 * is changed.
 */
import type { GalaxyId, SystemRecord } from '../catalogue/types.ts';
import type { NavGraph } from '../galaxy/graph.ts';
import type { ExplorationProgress } from '../galaxy/progress.ts';
import type { SectorLayout } from '../sector/model.ts';
import { safeResumePoint, type ResumeAt } from '../sector/resume.ts';
import { selectShip, type FleetState, type SelectResult } from '../ships/hangar.ts';
import { SHIP_IDS, type ShipId } from '../ships/types.ts';

export interface AdminSession {
  readonly active: true;
  /** Where the session was opened ('title' = the title-screen gesture / sequence). */
  readonly from: 'title' | 'map' | 'systems' | 'station';
  /** Ships the pilot really owns (read when the session began; the save is not touched). */
  readonly owned: readonly ShipId[];
  /** The ship and place the pilot had when the session began (shown in the panel). */
  readonly origin: { readonly ship: ShipId; readonly galaxy: GalaxyId; readonly system: string };
  /** The normal exploration progress when the session began (the navigator describes normal access from it). */
  readonly normalProgress: ExplorationProgress;
}

export function beginAdmin(fleet: FleetState, progress: ExplorationProgress, from: AdminSession['from']): AdminSession {
  return Object.freeze({ active: true as const, from, owned: Object.freeze([...fleet.owned]), origin: Object.freeze({ ship: fleet.active, galaxy: progress.current, system: progress.system }), normalProgress: progress });
}

export const isAdmin = (s: AdminSession | null): s is AdminSession => s !== null && s.active === true;

/** The single persistence rule: nothing is written while a session is active. */
export const mayPersist = (s: AdminSession | null): boolean => !isAdmin(s);

/** Every roster ship usable in the sandbox; the flown ship, loadouts and weapon setups are kept as they are. */
export function adminFleet(f: FleetState): FleetState {
  return { ...f, owned: [...SHIP_IDS] };
}

/** Roster ships the pilot does not own: usable only while the session lasts. */
export function adminOnlyShips(s: AdminSession | null): ReadonlySet<ShipId> {
  if (!isAdmin(s)) return new Set();
  return new Set(SHIP_IDS.filter((id) => !s.owned.includes(id)));
}

/**
 * Switch to any roster ship. Admin access only removes the ownership and
 * price requirement: the switch still needs a safe place (docked with no
 * hostile engaged, or no sector running), exactly as in the normal hangar.
 */
export function adminSelectShip(s: AdminSession | null, f: FleetState, id: string, safe: boolean): SelectResult {
  if (!isAdmin(s)) return selectShip(f, id, safe); // the normal rule, unchanged
  return selectShip(adminFleet(f), id, safe);
}

/** Admin sandbox ammunition: unlimited while the session lasts (mounts, cooldowns and recovery unchanged). */
export const unlimitedAmmo = (s: AdminSession | null): boolean => isAdmin(s);

/** Reactor cells a trip costs under the session: bypassed (0) while admin, the normal amount otherwise. */
export const travelCost = (s: AdminSession | null, cells: number): number => (isAdmin(s) ? 0 : cells);

/* ------------------------------------------------------------ destinations */

export type ArrivalPoint = 'arrival' | 'station';

export interface DestinationRef {
  readonly galaxy: string;
  /** Omitted: the galaxy's gateway system. */
  readonly system?: string | undefined;
  readonly arrival?: ArrivalPoint | undefined;
}

export type DestinationBlock = 'not-admin' | 'unknown-galaxy' | 'unknown-system' | 'wrong-galaxy' | 'no-station';

export type Destination =
  | { readonly ok: true; readonly galaxy: GalaxyId; readonly system: SystemRecord; readonly arrival: ArrivalPoint }
  | { readonly ok: false; readonly reason: DestinationBlock };

export const DESTINATION_TEXT: Readonly<Record<DestinationBlock, string>> = Object.freeze({
  'not-admin': 'Admin Access is not active.',
  'unknown-galaxy': 'That galaxy does not exist in this build.',
  'unknown-system': 'That system does not exist in this build.',
  'wrong-galaxy': 'That system belongs to another galaxy.',
  'no-station': 'That system has no station.',
});

/**
 * Where a successful admin login arrives: the real Sol system (the Milky Way
 * gateway and home port, catalogue id `milky-way/sol`), beside its Haven
 * Guild station, docked, on the HANGAR tab. Resolved through
 * resolveDestination like any other destination (no second Sol, no
 * synthetic station).
 */
export const ADMIN_HOME: DestinationRef = Object.freeze({ galaxy: 'milky-way', system: 'milky-way/sol', arrival: 'station' });

/**
 * Resolve a destination against the catalogue only (no unlock, discovery,
 * route or fuel requirement). Only ids the game data really has resolve.
 */
export function resolveDestination(s: AdminSession | null, graph: NavGraph, ref: DestinationRef): Destination {
  if (!isAdmin(s)) return { ok: false, reason: 'not-admin' };
  const node = graph.node(ref.galaxy);
  if (!node) return { ok: false, reason: 'unknown-galaxy' };
  const sysId = ref.system ?? node.galaxy.gameplay.gatewaySystemId;
  const system = graph.system(sysId);
  if (!system) return { ok: false, reason: 'unknown-system' };
  if (system.galaxyId !== node.id) return { ok: false, reason: 'wrong-galaxy' };
  const arrival = ref.arrival ?? 'arrival';
  if (arrival === 'station' && !system.sector.station) return { ok: false, reason: 'no-station' };
  return { ok: true, galaxy: node.id, system, arrival };
}

/**
 * The exploration state at a resolved destination. The place joins the
 * visited lists so the maps can show it as the pilot's position (a sandbox
 * value: it is never saved). Nothing is charted and no survey is counted,
 * so no milestone is completed by travelling.
 */
export function adminArrive(progress: ExplorationProgress, dest: Extract<Destination, { ok: true }>): ExplorationProgress {
  const g = dest.galaxy;
  const s = dest.system.id;
  return {
    ...progress,
    current: g,
    system: s,
    visited: progress.visited.includes(g) ? progress.visited : [...progress.visited, g],
    visitedSystems: progress.visitedSystems.includes(s) ? progress.visitedSystems : [...progress.visitedSystems, s],
  };
}

/**
 * A point beside the sector's station, inside its docking range, that passes
 * the same safety checks as a saved resume point (clear of solids, hazards
 * and alert rings, reachable from the arrival). Null when the sector has no
 * station or no such point (the run then starts at the arrival as usual).
 */
export function stationApproach(L: SectorLayout): ResumeAt | null {
  const st = L.pois.find((p) => p.kind === 'station');
  if (!st) return null;
  const solid = st.solidR;
  const radii = [solid + 34, solid + 46, Math.max(solid + 30, st.r - 10)];
  for (const d of radii) {
    if (d >= st.r + 12) continue; // must be within docking range (POI radius + ship radius)
    for (let i = 0; i < 16; i++) {
      // start on the side facing the arrival, then sweep both ways
      const base = Math.atan2(L.spawns[0]!.y - st.y, L.spawns[0]!.x - st.x);
      const k = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2);
      const a = base + (k * Math.PI) / 8;
      const x = Math.round((st.x + Math.cos(a) * d) * 10) / 10;
      const y = Math.round((st.y + Math.sin(a) * d) * 10) / 10;
      const toStation = Math.atan2(st.y - y, st.x - x);
      const heading = Math.atan2(Math.cos(toStation), -Math.sin(toStation)); // ship convention (0 = nose up, clockwise): facing the station
      const ok = safeResumePoint(L, { x, y, heading });
      if (ok) return ok;
    }
  }
  return null;
}
