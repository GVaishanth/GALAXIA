/**
 * Occupancy grid and reachability for local sectors (pure). Used by the
 * generator (to repair a layout) and, independently, by the validator.
 *
 * A cell is blocked when a solid circle, inflated by the ship clearance,
 * covers its centre. Reachability is a 4-neighbour flood fill from a start
 * point, so a reachable target always has a ship-wide corridor to it.
 */
import { SECTOR_GEN, type Point, type SectorLayout } from './model.ts';

export interface Circle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

export interface OccupancyGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly blocked: Uint8Array;
}

/** Every solid in a layout: star cores, bodies, rocks and POI hulls. */
export function solidsOf(L: Pick<SectorLayout, 'landmarks' | 'rocks' | 'pois'>): Circle[] {
  const out: Circle[] = [];
  for (const l of L.landmarks) out.push({ x: l.x, y: l.y, r: l.r });
  for (const r of L.rocks) out.push({ x: r.x, y: r.y, r: r.r });
  for (const p of L.pois) if (p.solidR > 0) out.push({ x: p.x, y: p.y, r: p.solidR });
  return out;
}

export function buildGrid(width: number, height: number, solids: readonly Circle[], clearance: number = SECTOR_GEN.shipClearance, cell: number = SECTOR_GEN.cell): OccupancyGrid {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const blocked = new Uint8Array(cols * rows);
  for (const s of solids) {
    const R = s.r + clearance;
    const c0 = Math.max(0, Math.floor((s.x - R) / cell));
    const c1 = Math.min(cols - 1, Math.floor((s.x + R) / cell));
    const r0 = Math.max(0, Math.floor((s.y - R) / cell));
    const r1 = Math.min(rows - 1, Math.floor((s.y + R) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cx = (c + 0.5) * cell;
        const cy = (r + 0.5) * cell;
        if ((cx - s.x) ** 2 + (cy - s.y) ** 2 <= R * R) blocked[r * cols + c] = 1;
      }
    }
  }
  return { cols, rows, cell, blocked };
}

export const cellOf = (g: OccupancyGrid, p: Point): number => {
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor(p.x / g.cell)));
  const r = Math.min(g.rows - 1, Math.max(0, Math.floor(p.y / g.cell)));
  return r * g.cols + c;
};

/** Flood fill from `start` over free cells; returns a reached-mask (empty when the start is blocked). */
export function reachable(g: OccupancyGrid, start: Point): Uint8Array {
  const seen = new Uint8Array(g.cols * g.rows);
  const s = cellOf(g, start);
  if (g.blocked[s]) return seen;
  const q = new Int32Array(g.cols * g.rows);
  let head = 0;
  let tail = 0;
  q[tail++] = s;
  seen[s] = 1;
  while (head < tail) {
    const i = q[head++]!;
    const c = i % g.cols;
    const r = (i - c) / g.cols;
    const visit = (j: number): void => {
      if (!seen[j] && !g.blocked[j]) {
        seen[j] = 1;
        q[tail++] = j;
      }
    };
    if (c > 0) visit(i - 1);
    if (c < g.cols - 1) visit(i + 1);
    if (r > 0) visit(i - g.cols);
    if (r < g.rows - 1) visit(i + g.cols);
  }
  return seen;
}

/** True when some reached cell centre lies within `radius` of `p` (the ship can get that close). */
export function canReach(g: OccupancyGrid, seen: Uint8Array, p: Point, radius: number): boolean {
  const R = radius + g.cell * 0.71; // a cell whose centre is within reach of the target circle
  const c0 = Math.max(0, Math.floor((p.x - R) / g.cell));
  const c1 = Math.min(g.cols - 1, Math.floor((p.x + R) / g.cell));
  const r0 = Math.max(0, Math.floor((p.y - R) / g.cell));
  const r1 = Math.min(g.rows - 1, Math.floor((p.y + R) / g.cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!seen[r * g.cols + c]) continue;
      const cx = (c + 0.5) * g.cell;
      const cy = (r + 0.5) * g.cell;
      if ((cx - p.x) ** 2 + (cy - p.y) ** 2 <= R * R) return true;
    }
  }
  return false;
}

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Shortest distance from `p` to the segment a-b. */
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
