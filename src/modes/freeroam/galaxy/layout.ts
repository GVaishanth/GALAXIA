/**
 * Galaxy map layout (pure). A stylised navigation chart, not astronomy: the
 * ten destinations sit on an authored lattice that keeps routes from crossing
 * and labels readable. Two lattices exist (wide 5x3 and tall 3x5); the one that
 * gives each destination the roomier cell for the *current* map box is used,
 * so the map fits portrait and landscape screens without scaling text.
 *
 * Positions are keyed by GalaxyId and typed as a complete Record, so the
 * compiler rejects a missing or extra destination; tests check that every
 * catalogue galaxy has exactly one distinct cell in both lattices.
 */
import type { GalaxyId } from '../catalogue/types.ts';

export type Orientation = 'wide' | 'tall';

interface Cell {
  readonly col: number;
  readonly row: number;
  /** Vertical nudge as a fraction of the cell height (keeps the lattice from looking like a table). */
  readonly dy: number;
}

export const MAP_GRID: Readonly<Record<Orientation, { readonly cols: number; readonly rows: number }>> = {
  wide: { cols: 5, rows: 3 },
  tall: { cols: 3, rows: 5 },
};

const c = (col: number, row: number, dy = 0): Cell => ({ col, row, dy });

/** Wide: the Local Group on the left, the far galaxies to the right. Tall: the same story top to bottom. */
export const MAP_CELLS: Readonly<Record<Orientation, Readonly<Record<GalaxyId, Cell>>>> = {
  wide: {
    'milky-way': c(0, 1),
    lmc: c(0, 2, 0.05),
    smc: c(1, 2, -0.05),
    andromeda: c(1, 0, 0.12),
    triangulum: c(2, 0, -0.08),
    'centaurus-a': c(2, 1, 0.12),
    pinwheel: c(3, 0, 0.08),
    whirlpool: c(4, 0, -0.06),
    sombrero: c(3, 1, 0.1),
    cartwheel: c(4, 2, 0),
  },
  tall: {
    'milky-way': c(1, 0),
    lmc: c(2, 0, 0.06),
    smc: c(2, 1, 0),
    andromeda: c(0, 1, 0.05),
    triangulum: c(0, 2, 0),
    'centaurus-a': c(1, 2, 0.06),
    pinwheel: c(0, 3, 0),
    sombrero: c(1, 3, 0.06),
    whirlpool: c(0, 4, 0),
    cartwheel: c(2, 4, 0),
  },
};

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface MapLayout {
  readonly orientation: Orientation;
  /** CSS px of the map box the layout was computed for. */
  readonly width: number;
  readonly height: number;
  readonly cellW: number;
  readonly cellH: number;
  /** Icon radius in CSS px. */
  readonly radius: number;
  /** Width available to a label (CSS px). */
  readonly labelWidth: number;
  /** Small cells: one label line only. */
  readonly compact: boolean;
  /** Icon centre per galaxy, CSS px from the map box's top-left corner. */
  readonly nodes: Readonly<Record<GalaxyId, Point>>;
}

/** Comfortable cell for an icon + two label lines; a cell this size scores 1. */
const COMFORT = { w: 104, h: 76 };
const LABEL_H = { full: 30, compact: 16 };

function fitScore(w: number, h: number, o: Orientation): number {
  const g = MAP_GRID[o];
  return Math.min(w / g.cols / COMFORT.w, h / g.rows / COMFORT.h);
}

export function chooseOrientation(width: number, height: number): Orientation {
  const wide = fitScore(width, height, 'wide');
  const tall = fitScore(width, height, 'tall');
  if (Math.abs(wide - tall) < 1e-9) return width >= height ? 'wide' : 'tall';
  return wide > tall ? 'wide' : 'tall';
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function computeMapLayout(width: number, height: number, pad = 6): MapLayout {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const orientation = chooseOrientation(w - pad * 2, h - pad * 2);
  const g = MAP_GRID[orientation];
  const cellW = (w - pad * 2) / g.cols;
  const cellH = (h - pad * 2) / g.rows;
  const compact = cellH < 66;
  const labelH = compact ? LABEL_H.compact : LABEL_H.full;
  const radius = clamp(Math.min(cellW * 0.22, (cellH - labelH) * 0.4), 10, 34);
  const nodes = {} as Record<GalaxyId, Point>;
  for (const [id, cell] of Object.entries(MAP_CELLS[orientation]) as [GalaxyId, Cell][]) {
    const cx = pad + (cell.col + 0.5) * cellW;
    // icon + label block centred in the cell, then nudged
    const content = radius * 2 + 4 + labelH;
    const blockTop = pad + cell.row * cellH + (cellH - content) / 2;
    // the nudge only uses spare room, so a tight cell never pushes a target into its neighbour
    const spare = Math.max(0, (cellH - Math.max(44, content)) / 2);
    const cy = blockTop + radius + clamp(cell.dy * cellH, -spare, spare);
    nodes[id] = { x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10 };
  }
  return { orientation, width: w, height: h, cellW, cellH, radius, labelWidth: Math.max(48, Math.floor(cellW - 6)), compact, nodes };
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The tap / click target of a destination: icon plus label, at least 44 x 44 CSS px. */
export function nodeBox(layout: MapLayout, id: GalaxyId): Box {
  const p = layout.nodes[id];
  const labelH = layout.compact ? LABEL_H.compact : LABEL_H.full;
  const content = layout.radius * 2 + 4 + labelH;
  const height = Math.max(44, content);
  const width = Math.max(44, Math.min(layout.labelWidth, 132));
  return { left: p.x - width / 2, top: p.y - layout.radius - (height - content) / 2, width, height };
}

/* ------------------------------------------------------ keyboard movement */

export type Direction = 'up' | 'down' | 'left' | 'right';
const DIR: Readonly<Record<Direction, Point>> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/**
 * Spatial focus movement: the nearest destination in the pressed direction,
 * inside a 70 degree cone, preferring targets close to the axis. Returns null
 * when nothing lies that way (focus stays put).
 */
export function spatialNext(nodes: Readonly<Record<string, Point>>, from: string, dir: Direction): string | null {
  const o = nodes[from];
  if (!o) return null;
  const d = DIR[dir];
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [id, p] of Object.entries(nodes)) {
    if (id === from) continue;
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    const along = dx * d.x + dy * d.y;
    if (along <= 1) continue;
    const perp = Math.abs(dx * d.y - dy * d.x);
    if (perp > along * 2.75) continue; // outside the ~70 degree cone
    const score = along + perp * 2;
    if (score < bestScore - 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && best !== null && id < best)) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}
