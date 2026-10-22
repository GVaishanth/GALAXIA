/**
 * Jump fuel and safe recovery (Free Roam Prompt 11; resolves FR-OD-16).
 *
 * Jumps burn reactor cells (cargo resource `fuel`):
 *  - a lane hop costs its charge (1..5) times the ship's travel stat, rounded
 *    up, at least 1 cell; a route is the sum of its hops; a sector gate jump
 *    costs its lane's hop;
 *  - a galaxy jump costs GALAXY_FACTOR x the route charge x travel.
 *
 * Recovery (the player can never be stranded; tested):
 *  R1 docked at a station: free emergency cells up to the most expensive hop
 *     out of that system, once per arrival in the system;
 *  R2 too few cells for any hop out of a system without a station: a free
 *     emergency jump to the nearest station system the map can route to;
 *  R3 outside the Milky Way with too few cells for any open galaxy route: a
 *     free return to the Milky Way gateway (its station then applies R1).
 * Stations never buy reactor cells (economy.ts), so free cells are no income.
 *
 * Pure.
 */
import type { NavEdge } from '../galaxy/graph.ts';
import type { Lane, SystemGraph, SystemView } from '../galaxy/systems.ts';

export const FUEL = Object.freeze({
  resource: 'fuel',
  /** Cells a new pilot (or a Prompt 10 save, once) starts with. */
  starterCells: 12,
  galaxyFactor: 2,
});

const cells = (charge: number, travel: number): number => Math.max(1, Math.ceil(Math.max(0, charge) * (Number.isFinite(travel) && travel > 0 ? travel : 1) - 1e-9));

export const hopCells = (laneCost: number, travel: number): number => cells(laneCost, travel);
export const routeCells = (lanes: readonly Lane[], travel: number): number => lanes.reduce((n, l) => n + hopCells(l.cost, travel), 0);
export const galaxyJumpCells = (edge: NavEdge, travel: number): number => cells(edge.route.cost * FUEL.galaxyFactor, travel);

export const cellsHeld = (hold: Readonly<Record<string, number>>): number => hold[FUEL.resource] ?? 0;

/** Burn cells from a hold (null = not enough). */
export function burnCells(hold: Readonly<Record<string, number>>, n: number): Readonly<Record<string, number>> | null {
  const have = cellsHeld(hold);
  if (n <= 0) return hold;
  if (have < n) return null;
  const out = { ...hold };
  if (have === n) delete out[FUEL.resource];
  else out[FUEL.resource] = have - n;
  return out;
}

/** Cheapest and dearest single hop out of a system (cells). */
export function hopRange(sg: SystemGraph, systemId: string, travel: number): { readonly min: number; readonly max: number } {
  const costs = sg.lanesOf(systemId).map((l) => hopCells(l.cost, travel));
  return costs.length ? { min: Math.min(...costs), max: Math.max(...costs) } : { min: 0, max: 0 };
}

/** R1: free cells granted when docking (0 = none due or already granted this arrival). */
export function emergencyCells(held: number, sg: SystemGraph, systemId: string, travel: number, alreadyGranted: boolean): number {
  if (alreadyGranted) return 0;
  return Math.max(0, hopRange(sg, systemId, travel).max - held);
}

/** R2: nearest station system the map can route to (null = none needed or none found). Free of cells. */
export function emergencyJumpTarget(sv: SystemView, held: number, travel: number, isStation: (id: string) => boolean): string | null {
  const here = sv.current;
  if (!here || isStation(here)) return null; // dock here instead (R1)
  if (held >= hopRange(sv.graph, here, travel).min) return null; // a hop is affordable
  let best: { id: string; cost: number } | null = null;
  for (const id of sv.graph.systems.map((s) => s.id)) {
    if (id === here || !isStation(id)) continue;
    const plan = sv.plan(id);
    if (plan.ok && (!best || plan.cost < best.cost)) best = { id, cost: plan.cost };
  }
  return best?.id ?? null;
}

/** R3: is a free return to the start galaxy due? */
export function homeJumpDue(current: string, start: string, held: number, openEdges: readonly NavEdge[], travel: number): boolean {
  if (current === start) return false;
  if (openEdges.length === 0) return true;
  return held < Math.min(...openEdges.map((e) => galaxyJumpCells(e, travel)));
}
