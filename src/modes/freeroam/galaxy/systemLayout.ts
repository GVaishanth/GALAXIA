/**
 * System map layout (pure, deterministic). Every galaxy's 15-20 systems are
 * placed on a coarse lattice derived only from the catalogue: system ids and
 * lanes. Nothing is stored, nothing is random, and nothing depends on what the
 * pilot has discovered, so a system sits in the same cell every time the map
 * opens (hidden systems keep their cell; they are simply not drawn).
 *
 * 1. Start positions come from a hash of each system id.
 * 2. A stress layout (SMACOF) pulls lane-connected systems together, so the map
 *    reads as local neighbourhoods. Only + - * / and sqrt are used, so every
 *    JS engine produces the same numbers.
 * 3. The result is rotated onto its principal axis (gateway on the left) and
 *    snapped onto a 7x4 lattice (6x4 for small galaxies), greedily, busiest
 *    systems first.
 * 4. A local search moves and swaps systems while that removes lane crossings,
 *    lanes passing over other systems, and long lanes.
 *
 * The tall (portrait) lattice is the exact transpose of the wide one: rotating
 * a phone mirrors the map across its diagonal instead of reshuffling it.
 * Cells are large (>= 44 CSS px when the map box allows) and the whole cell is
 * the touch target, so nothing needs a precision tap and no zoom/pan is needed.
 */
import { fnv1a32 } from '../catalogue/build.ts';
import type { Orientation, Point } from './layout.ts';
import type { SystemGraph } from './systems.ts';

export interface GridCell {
  readonly col: number;
  readonly row: number;
}

export interface SystemGrid {
  /** Wide-lattice size; the tall lattice is rows x cols. */
  readonly cols: number;
  readonly rows: number;
  /** Wide-lattice cell per system id. */
  readonly cells: Readonly<Record<string, GridCell>>;
  /** Final layout penalty terms (tests and docs). */
  readonly crossings: number;
  readonly nearMisses: number;
}

export const SYSTEM_GRID_SIZES = Object.freeze({ small: { cols: 6, rows: 4, maxSystems: 16 }, large: { cols: 7, rows: 4, maxSystems: 28 } });

const PENALTY = { crossing: 1000, nearNode: 300 };
const LAYOUT_STARTS = 4;
/** Local search only tries cells this many steps away (keeps the first open fast on phones). */
const MOVE_REACH = 2;
const NEAR = 0.32; // cell units: a lane closer than this to a system centre "passes over" it

/* ------------------------------------------------------------- geometry */

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
};

const onSegment = (ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean =>
  Math.min(ax, bx) - 1e-9 <= px && px <= Math.max(ax, bx) + 1e-9 && Math.min(ay, by) - 1e-9 <= py && py <= Math.max(ay, by) + 1e-9;

/** True when segments AB and CD cross or overlap (shared endpoints do not count). */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a.x, a.y, b.x, b.y, c.x, c.y);
  const o2 = orient(a.x, a.y, b.x, b.y, d.x, d.y);
  const o3 = orient(c.x, c.y, d.x, d.y, a.x, a.y);
  const o4 = orient(c.x, c.y, d.x, d.y, b.x, b.y);
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true;
  // collinear overlap
  if (o1 === 0 && o2 === 0) return onSegment(a.x, a.y, b.x, b.y, c.x, c.y) || onSegment(a.x, a.y, b.x, b.y, d.x, d.y) || onSegment(c.x, c.y, d.x, d.y, a.x, a.y);
  return false;
}

/** Squared distance from P to segment AB. */
export function segmentDistance2(a: Point, b: Point, p: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx - p.x;
  const qy = a.y + t * dy - p.y;
  return qx * qx + qy * qy;
}

/* ------------------------------------------------------------ grid build */

interface Work {
  readonly ids: string[];
  readonly edges: [number, number][];
  readonly pos: { x: number; y: number }[];
}

/** Do two lanes conflict? Lanes sharing a system only conflict when they overlap along one line. */
function lanesConflict(pos: readonly { x: number; y: number }[], e: readonly [number, number], f: readonly [number, number]): boolean {
  const [a, b] = e;
  const [c, d] = f;
  if (c === a || c === b || d === a || d === b) {
    const shared = c === a || c === b ? c : d;
    const x = shared === a ? b : a;
    const y = shared === c ? d : c;
    const ps = pos[shared]!;
    return orient(ps.x, ps.y, pos[x]!.x, pos[x]!.y, pos[y]!.x, pos[y]!.y) === 0 && (pos[x]!.x - ps.x) * (pos[y]!.x - ps.x) + (pos[x]!.y - ps.y) * (pos[y]!.y - ps.y) > 0;
  }
  return segmentsCross(pos[a]!, pos[b]!, pos[c]!, pos[d]!);
}

const laneNear = (pos: readonly { x: number; y: number }[], e: readonly [number, number], k: number): boolean => k !== e[0] && k !== e[1] && segmentDistance2(pos[e[0]]!, pos[e[1]]!, pos[k]!) < NEAR * NEAR;

function penaltyOf(w: Work): { total: number; crossings: number; near: number } {
  let crossings = 0;
  let near = 0;
  let length = 0;
  const { edges, pos } = w;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const dx = pos[e[0]]!.x - pos[e[1]]!.x;
    const dy = pos[e[0]]!.y - pos[e[1]]!.y;
    length += dx * dx + dy * dy;
    for (let j = i + 1; j < edges.length; j++) if (lanesConflict(pos, e, edges[j]!)) crossings++;
    for (let k = 0; k < pos.length; k++) if (laneNear(pos, e, k)) near++;
  }
  return { total: PENALTY.crossing * crossings + PENALTY.nearNode * near + length, crossings, near };
}

/**
 * The part of the penalty that can change when only systems `m1`/`m2` move:
 * terms involving a lane that touches them, or a lane passing them. The
 * difference of two local penalties equals the difference of the totals.
 */
function localPenalty(w: Work, incident: readonly boolean[], m1: number, m2: number): number {
  const { edges, pos } = w;
  let total = 0;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (incident[i]) {
      const dx = pos[e[0]]!.x - pos[e[1]]!.x;
      const dy = pos[e[0]]!.y - pos[e[1]]!.y;
      total += dx * dx + dy * dy;
      for (let j = 0; j < edges.length; j++) {
        if (j === i || (incident[j] && j < i)) continue; // count incident pairs once
        if (lanesConflict(pos, e, edges[j]!)) total += PENALTY.crossing;
      }
      for (let k = 0; k < pos.length; k++) if (laneNear(pos, e, k)) total += PENALTY.nearNode;
    } else {
      if (laneNear(pos, e, m1)) total += PENALTY.nearNode;
      if (m2 >= 0 && laneNear(pos, e, m2)) total += PENALTY.nearNode;
    }
  }
  return total;
}

/** Deterministic hash in [0, 1). */
const unit = (text: string): number => fnv1a32(text) / 4294967296;

function stressLayout(ids: readonly string[], edges: readonly [number, number][], salt: number): { x: number; y: number }[] {
  const n = ids.length;
  // all-pairs hop distances (BFS); disconnected pairs get n
  const adj: number[][] = ids.map(() => []);
  for (const [a, b] of edges) {
    adj[a]!.push(b);
    adj[b]!.push(a);
  }
  const d: number[][] = [];
  for (let s = 0; s < n; s++) {
    const row = new Array<number>(n).fill(n);
    row[s] = 0;
    const q = [s];
    for (let i = 0; i < q.length; i++) for (const y of adj[q[i]!]!) if (row[y] === n && y !== s) {
      row[y] = row[q[i]!]! + 1;
      q.push(y);
    }
    d.push(row);
  }
  const x = ids.map((id) => unit(`galaxia:sysmap:${salt}:x:${id}`) * n);
  const y = ids.map((id) => unit(`galaxia:sysmap:${salt}:y:${id}`) * n);
  // SMACOF with weights d^-2 (Gansner, Koren & North 2004)
  for (let iter = 0; iter < 300; iter++) {
    const nx = new Array<number>(n).fill(0);
    const ny = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let wsum = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dij = d[i]![j]!;
        const wij = 1 / (dij * dij);
        const dx = x[i]! - x[j]!;
        const dy = y[i]! - y[j]!;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        nx[i]! += wij * (x[j]! + (dij * dx) / dist);
        ny[i]! += wij * (y[j]! + (dij * dy) / dist);
        wsum += wij;
      }
      nx[i] = nx[i]! / wsum;
      ny[i] = ny[i]! / wsum;
    }
    for (let i = 0; i < n; i++) {
      x[i] = nx[i]!;
      y[i] = ny[i]!;
    }
  }
  return ids.map((_, i) => ({ x: x[i]!, y: y[i]! }));
}

/** Rotate onto the principal axis; flip so the gateway is left and harder systems lower. */
function align(pos: { x: number; y: number }[], gatewayIndex: number, weight: readonly number[]): void {
  const n = pos.length;
  let mx = 0;
  let my = 0;
  for (const p of pos) {
    mx += p.x / n;
    my += p.y / n;
  }
  let a = 0;
  let b = 0;
  let c = 0;
  for (const p of pos) {
    const dx = p.x - mx;
    const dy = p.y - my;
    a += dx * dx;
    b += dx * dy;
    c += dy * dy;
  }
  const lambda = (a + c) / 2 + Math.sqrt(((a - c) / 2) * ((a - c) / 2) + b * b);
  let ux = b;
  let uy = lambda - a;
  if (Math.abs(ux) + Math.abs(uy) < 1e-9) {
    ux = 1;
    uy = 0;
  }
  const len = Math.sqrt(ux * ux + uy * uy);
  ux /= len;
  uy /= len;
  for (const p of pos) {
    const dx = p.x - mx;
    const dy = p.y - my;
    p.x = dx * ux + dy * uy;
    p.y = -dx * uy + dy * ux;
  }
  if (gatewayIndex >= 0 && pos[gatewayIndex]!.x > 0) for (const p of pos) p.x = -p.x;
  let wy = 0;
  pos.forEach((p, i) => (wy += p.y * weight[i]!));
  if (wy < 0) for (const p of pos) p.y = -p.y;
}

function snap(pos: { x: number; y: number }[], ids: readonly string[], degree: readonly number[], cols: number, rows: number): { x: number; y: number }[] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pos) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const sx = (cols - 1) / Math.max(1e-6, x1 - x0);
  const sy = (rows - 1) / Math.max(1e-6, y1 - y0);
  const want = pos.map((p) => ({ x: (p.x - x0) * sx, y: (p.y - y0) * sy }));
  const order = ids.map((_, i) => i).sort((i, j) => degree[j]! - degree[i]! || (ids[i]! < ids[j]! ? -1 : 1));
  const taken = new Set<number>();
  const out = pos.map(() => ({ x: 0, y: 0 }));
  for (const i of order) {
    let best = -1;
    let bestD = Infinity;
    for (let cell = 0; cell < cols * rows; cell++) {
      if (taken.has(cell)) continue;
      const dx = (cell % cols) - want[i]!.x;
      const dy = Math.floor(cell / cols) - want[i]!.y;
      const dd = dx * dx + dy * dy;
      if (dd < bestD - 1e-9) {
        bestD = dd;
        best = cell;
      }
    }
    taken.add(best);
    out[i] = { x: best % cols, y: Math.floor(best / cols) };
  }
  return out;
}

function improve(w: Work, cols: number, rows: number): void {
  const n = w.pos.length;
  for (let pass = 0; pass < 12; pass++) {
    let better = false;
    for (let i = 0; i < n; i++) {
      const occupied = new Map<number, number>();
      w.pos.forEach((p, k) => occupied.set(p.y * cols + p.x, k));
      for (let cell = 0; cell < cols * rows; cell++) {
        const here = w.pos[i]!;
        const cx = cell % cols;
        const cy = Math.floor(cell / cols);
        if ((cx === here.x && cy === here.y) || Math.abs(cx - here.x) > MOVE_REACH || Math.abs(cy - here.y) > MOVE_REACH) continue;
        const other = occupied.get(cell);
        const m2 = other ?? -1;
        const incident = w.edges.map(([a, b]) => a === i || b === i || a === m2 || b === m2);
        const before = localPenalty(w, incident, i, m2);
        const old = { x: here.x, y: here.y };
        w.pos[i] = { x: cx, y: cy };
        if (other !== undefined) w.pos[other] = old;
        if (localPenalty(w, incident, i, m2) < before - 1e-9) {
          better = true;
          occupied.delete(old.y * cols + old.x);
          occupied.set(cell, i);
          if (other !== undefined) occupied.set(old.y * cols + old.x, other);
        } else {
          w.pos[i] = old;
          if (other !== undefined) w.pos[other] = { x: cx, y: cy };
        }
      }
    }
    if (!better) break;
  }
}

const gridCache = new WeakMap<SystemGraph, SystemGrid>();

/** The (memoised) lattice placement of one galaxy's systems. */
export function systemGrid(sg: SystemGraph): SystemGrid {
  const cached = gridCache.get(sg);
  if (cached) return cached;
  const ids = sg.systems.map((s) => s.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const edges: [number, number][] = sg.lanes.map((l) => [index.get(l.a)!, index.get(l.b)!]);
  const degree = ids.map((id) => sg.lanesOf(id).length);
  const size = ids.length <= SYSTEM_GRID_SIZES.small.maxSystems ? SYSTEM_GRID_SIZES.small : SYSTEM_GRID_SIZES.large;
  // a few fixed starts; the lowest penalty wins (ties: the earliest start)
  let w: Work | null = null;
  let final = { total: Infinity, crossings: 0, near: 0 };
  for (let salt = 0; salt < LAYOUT_STARTS; salt++) {
    const raw = stressLayout(ids, edges, salt);
    align(raw, index.get(sg.gateway) ?? -1, sg.systems.map((s) => s.difficulty));
    const cand: Work = { ids, edges, pos: snap(raw, ids, degree, size.cols, size.rows) };
    improve(cand, size.cols, size.rows);
    const pen = penaltyOf(cand);
    if (pen.total < final.total - 1e-9) {
      w = cand;
      final = pen;
    }
  }
  w = w!;
  const cells: Record<string, GridCell> = {};
  ids.forEach((id, i) => (cells[id] = Object.freeze({ col: w.pos[i]!.x, row: w.pos[i]!.y })));
  const grid: SystemGrid = Object.freeze({ cols: size.cols, rows: size.rows, cells: Object.freeze(cells), crossings: final.crossings, nearMisses: final.near });
  gridCache.set(sg, grid);
  return grid;
}

/* ---------------------------------------------------------- pixel layout */

export interface SystemMapLayout {
  readonly orientation: Orientation;
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellW: number;
  readonly cellH: number;
  /** Marker radius in CSS px. */
  readonly radius: number;
  readonly labelWidth: number;
  /** Short cells: name only, no second label line. */
  readonly compact: boolean;
  /** Marker centre per system id (every system, hidden or not), CSS px from the box's top-left. */
  readonly nodes: Readonly<Record<string, Point>>;
  /** The node's touch target: its whole cell, inset by 1 px. */
  readonly boxes: Readonly<Record<string, { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>>;
}

/** A cell this size scores 1 (two label lines under a marker). */
const COMFORT = { w: 80, h: 56 };
/** Cells at least this big keep every touch target >= 44 CSS px (1 px inset each side). */
const MIN_CELL = 46;

/**
 * Wide or tall lattice for this map box: an orientation whose cells are all
 * >= MIN_CELL wins outright (touch targets first); when both fit, the box's own
 * shape decides (landscape box = wide); when neither fits, the roomier one.
 */
export function chooseSystemOrientation(grid: Pick<SystemGrid, 'cols' | 'rows'>, width: number, height: number): Orientation {
  const cell = (cols: number, rows: number): { w: number; h: number } => ({ w: width / cols, h: height / rows });
  const w = cell(grid.cols, grid.rows);
  const t = cell(grid.rows, grid.cols);
  const wideFits = Math.min(w.w, w.h) >= MIN_CELL;
  const tallFits = Math.min(t.w, t.h) >= MIN_CELL;
  if (wideFits !== tallFits) return wideFits ? 'wide' : 'tall';
  if (wideFits) return width >= height ? 'wide' : 'tall'; // both fit: follow the screen
  const wide = Math.min(w.w / COMFORT.w, w.h / COMFORT.h);
  const tall = Math.min(t.w / COMFORT.w, t.h / COMFORT.h);
  if (Math.abs(wide - tall) < 1e-9) return width >= height ? 'wide' : 'tall';
  return wide > tall ? 'wide' : 'tall';
}

export function computeSystemLayout(grid: SystemGrid, width: number, height: number, pad = 2): SystemMapLayout {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const orientation = chooseSystemOrientation(grid, w - pad * 2, h - pad * 2);
  const cols = orientation === 'wide' ? grid.cols : grid.rows;
  const rows = orientation === 'wide' ? grid.rows : grid.cols;
  const cellW = (w - pad * 2) / cols;
  const cellH = (h - pad * 2) / rows;
  const compact = cellH < 56 || cellW < 60; // short or narrow cells: name only (state stays visible in the marker)
  const labelH = compact ? 14 : 28;
  const radius = Math.min(13, Math.max(6, Math.min(cellW * 0.14, (cellH - labelH) * 0.32)));
  const nodes: Record<string, Point> = {};
  const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const [id, cell] of Object.entries(grid.cells)) {
    const col = orientation === 'wide' ? cell.col : cell.row;
    const row = orientation === 'wide' ? cell.row : cell.col;
    const left = pad + col * cellW;
    const top = pad + row * cellH;
    const content = radius * 2 + 3 + labelH;
    const cy = top + Math.max(radius + 2, (cellH - content) / 2 + radius);
    nodes[id] = { x: Math.round((left + cellW / 2) * 10) / 10, y: Math.round(cy * 10) / 10 };
    boxes[id] = { x: Math.round(left + 1), y: Math.round(top + 1), w: Math.max(1, Math.floor(cellW - 2)), h: Math.max(1, Math.floor(cellH - 2)) };
  }
  return { orientation, width: w, height: h, cols, rows, cellW, cellH, radius, labelWidth: Math.max(40, Math.floor(cellW - 4)), compact, nodes, boxes };
}

/** A lane drawn as a quadratic curve, CSS px (control point = midpoint when straight). */
export interface LaneCurve {
  readonly ax: number;
  readonly ay: number;
  readonly cx: number;
  readonly cy: number;
  readonly bx: number;
  readonly by: number;
  readonly bent: boolean;
}

/**
 * Lane geometry: straight, unless the straight line would pass over another
 * system's marker (every system counts, visible or not, so curves never change
 * as the pilot discovers more). Then it bows away from that system by about
 * 0.45 of a cell, so lanes never seem to connect systems they do not.
 */
export function laneCurve(layout: Pick<SystemMapLayout, 'nodes' | 'cellW' | 'cellH'>, a: string, b: string): LaneCurve {
  const pa = layout.nodes[a]!;
  const pb = layout.nodes[b]!;
  const cell = Math.min(layout.cellW, layout.cellH);
  const straight: LaneCurve = { ax: pa.x, ay: pa.y, cx: (pa.x + pb.x) / 2, cy: (pa.y + pb.y) / 2, bx: pb.x, by: pb.y, bent: false };
  const near = Object.keys(layout.nodes)
    .filter((id) => id !== a && id !== b)
    .sort()
    .find((id) => segmentDistance2(pa, pb, layout.nodes[id]!) < (0.42 * cell) * (0.42 * cell));
  if (near === undefined) return straight;
  const p = layout.nodes[near]!;
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const side = dx * (p.y - pa.y) - dy * (p.x - pa.x) > 0 ? -1 : 1; // away from the system
  const off = 0.9 * cell; // a quadratic's midpoint moves half its control offset
  return { ...straight, cx: straight.cx + (-dy / len) * off * side, cy: straight.cy + (dx / len) * off * side, bent: true };
}
