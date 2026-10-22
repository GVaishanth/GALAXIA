/**
 * Sector context from the navigation graph (pure): one gate per System Map
 * lane, pointing the way the neighbour lies on the (wide) System Map lattice,
 * so a gate on the sector's left leads to the system drawn to the left.
 */
import type { NavGraph } from '../galaxy/graph.ts';
import { systemGrid } from '../galaxy/systemLayout.ts';
import { systemGraph } from '../galaxy/systems.ts';
import type { GateSpec, SectorContext } from './model.ts';

export function sectorContext(graph: NavGraph, systemId: string): SectorContext {
  const sys = graph.system(systemId);
  if (!sys) return { gates: [] };
  const sg = systemGraph(graph, sys.galaxyId);
  const cells = systemGrid(sg).cells;
  const me = cells[systemId];
  const gates: GateSpec[] = sg.lanesOf(systemId).map((l) => {
    const to = sg.other(l, systemId);
    const c = cells[to];
    const angle = me && c && (c.col !== me.col || c.row !== me.row) ? Math.atan2(c.row - me.row, c.col - me.col) : 0;
    return { to, angle };
  });
  return { gates };
}
