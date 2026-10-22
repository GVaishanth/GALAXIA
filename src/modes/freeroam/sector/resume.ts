/**
 * Resume points (Free Roam Prompt 13). Pure.
 *
 * A save keeps where the pilot was at the last safe autosave (profile.ts
 * ResumePoint), as plain logical coordinates. Before a sector uses it, the
 * point is checked against this build's layout of that sector, with the same
 * clearances as the generated spawn points (sector/validate.ts): inside the
 * bounds, clear of every solid, outside hazard glows, nebula effects, hazard
 * zones, installation alert rings and encounter trigger rings, and reachable
 * from the arrival. Anything else (a changed layout, an edited save) returns
 * null and the run starts at the arrival as usual.
 */
import { buildGrid, canReach, dist, reachable, solidsOf } from './grid.ts';
import type { SectorLayout } from './model.ts';

export interface ResumeAt {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

/** Keep this far inside the sector bounds. */
const EDGE = 60;
/** Ship radius 12 + margin, as for spawn points. */
const SOLID_MARGIN = 20;

export function safeResumePoint(L: SectorLayout, at: ResumeAt): ResumeAt | null {
  if (![at.x, at.y, at.heading].every(Number.isFinite)) return null;
  if (at.x < EDGE || at.y < EDGE || at.x > L.width - EDGE || at.y > L.height - EDGE) return null;
  const solids = solidsOf(L);
  if (solids.some((s) => dist(at, s) < s.r + SOLID_MARGIN)) return null;
  if (L.landmarks.some((l) => l.hazardR > 0 && dist(at, l) < l.hazardR)) return null;
  if (L.regions.some((g) => g.kind === 'nebula' && g.effect !== 'none' && dist(at, g) < g.r)) return null;
  if (L.hazards.some((h) => dist(at, h) < h.r)) return null;
  if (L.pois.some((p) => p.kind === 'installation' && dist(at, p) < p.alertR)) return null;
  if (L.sites.some((s) => dist(at, s) < s.r)) return null;
  const grid = buildGrid(L.width, L.height, solids);
  const seen = reachable(grid, L.spawns[0] ?? L.arrival);
  if (!canReach(grid, seen, at, 8)) return null;
  const tau = Math.PI * 2;
  return { x: at.x, y: at.y, heading: ((at.heading % tau) + tau) % tau };
}
