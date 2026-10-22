/**
 * Galaxy map canvas (presentation only; reads state, never changes it).
 *
 * Draws, in device pixels: a slow seeded starfield (static with reduced
 * motion), the routes, the galaxy portraits and their state rings, selection
 * brackets, the "you are here" ship and the short travel animation. Text is not
 * drawn here: labels are real DOM buttons (galaxyMapScreen.ts), so they stay
 * crisp, readable and accessible.
 *
 * States are told apart by more than colour: current = double ring + ship,
 * available = solid ring, discovered = thin grey ring, locked = dashed ring +
 * padlock + grey portrait; sealed routes carry a gate mark.
 */
import { COLORS } from '../../../config/palette.ts';
import type { GalaxyId, RouteClass } from '../catalogue/types.ts';
import type { GalaxyArtCache } from './galaxyArt.ts';
import type { NavEdge, NavGraph } from './graph.ts';
import type { MapLayout } from './layout.ts';
import type { EdgeState, NodeState } from './progress.ts';

export interface TravelAnim {
  readonly from: GalaxyId;
  readonly to: GalaxyId;
  /** 0..1 */
  readonly t: number;
}

export interface MapScene {
  readonly graph: NavGraph;
  readonly layout: MapLayout;
  readonly nodeStates: Readonly<Record<GalaxyId, NodeState>>;
  readonly edgeStates: ReadonlyMap<string, EdgeState>;
  readonly current: GalaxyId;
  readonly selected: GalaxyId | null;
  readonly hovered: GalaxyId | null;
  /** Edges to emphasise (the course to the selected / hovered destination). */
  readonly highlight: ReadonlySet<string>;
  readonly travel: TravelAnim | null;
  /** Arrival flash at the current galaxy, 0..1 (null = none). */
  readonly arrival: number | null;
}

export interface MapDrawOptions {
  readonly ratio: number;
  readonly timeMs: number;
  readonly reducedMotion: boolean;
}

export const HIGHLIGHT = COLORS['ui.highlight'];
export const ACCENT = COLORS['ui.accent'];
export const DIM = COLORS['ui.text.dim'];
export const COURSE = '#ffe14a';
const STAR_ROLES = [COLORS['star.dim'], COLORS['star.cool'], COLORS['star.mid'], COLORS['star.warm'], COLORS['star.bright']] as const;

export function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const ROUTE_DASH: Readonly<Record<RouteClass, readonly number[]>> = {
  'local-lane': [],
  'gate-jump': [],
  'deep-jump': [9, 6],
  'rift-jump': [2, 5, 10, 5],
};

/** 7 x 6 pixel ship marker (GALAXIA fighter silhouette, original). */
export const SHIP = ['...#...', '...#...', '..###..', '.#####.', '##.#.##', '#..#..#'];
/** 5 x 6 padlock. */
export const LOCK = ['.###.', '#...#', '#####', '##.##', '##.##', '#####'];

export function pixels(ctx: CanvasRenderingContext2D, pattern: readonly string[], cx: number, cy: number, px: number, color: string, angle = 0): void {
  const w = pattern[0]!.length;
  const h = pattern.length;
  ctx.save();
  ctx.translate(Math.round(cx), Math.round(cy));
  if (angle) ctx.rotate(angle);
  // dark outline first for contrast on any background
  ctx.fillStyle = '#05060c';
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pattern[y]![x] === '#') ctx.fillRect((x - w / 2) * px - px * 0.5, (y - h / 2) * px - px * 0.5, px * 2, px * 2);
  ctx.fillStyle = color;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pattern[y]![x] === '#') ctx.fillRect((x - w / 2) * px, (y - h / 2) * px, px, px);
  ctx.restore();
}

export function starfield(ctx: CanvasRenderingContext2D, W: number, H: number, o: MapDrawOptions, travel: { readonly t: number } | null, dir: { x: number; y: number }): void {
  const count = Math.min(220, Math.round((W * H) / (o.ratio * o.ratio * 5200)));
  const t = o.reducedMotion ? 0 : o.timeMs / 1000;
  const streak = travel && !o.reducedMotion ? Math.sin(Math.PI * travel.t) : 0;
  for (let i = 0; i < count; i++) {
    const layer = i % 3;
    const speed = (2 + layer * 3) * o.ratio; // device px per second: a slow drift
    const x = (((hash01(i, 11) * W - t * speed) % W) + W) % W;
    const y = hash01(i, 23) * H;
    const size = Math.max(1, Math.round(o.ratio * (layer === 2 ? 1.5 : 1)));
    ctx.fillStyle = STAR_ROLES[Math.floor(hash01(i, 37) * STAR_ROLES.length)]!;
    if (streak > 0.05) {
      const len = streak * (8 + layer * 10) * o.ratio;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x, y, size, size);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = size;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - dir.x * len, y - dir.y * len);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else ctx.fillRect(x, y, size, size);
  }
}

function strokeRoute(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, r: number, cls: RouteClass, state: EdgeState, highlighted: boolean, o: MapDrawOptions): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const gap = r + 7 * o.ratio;
  if (len <= gap * 2) return;
  const x1 = ax + ux * gap;
  const y1 = ay + uy * gap;
  const x2 = bx - ux * gap;
  const y2 = by - uy * gap;
  const lw = (highlighted ? 2.5 : state === 'active' ? 2 : 1.5) * o.ratio;
  const color = highlighted ? COURSE : state === 'active' ? 'rgba(92,239,255,0.78)' : state === 'open' ? 'rgba(92,239,255,0.38)' : state === 'sealed' ? 'rgba(255,59,78,0.6)' : 'rgba(138,144,173,0.24)';
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  const dash = state === 'locked' ? [2, 6] : highlighted ? [10, 6] : ROUTE_DASH[cls];
  ctx.setLineDash(dash.map((d) => d * o.ratio));
  ctx.lineDashOffset = highlighted && !o.reducedMotion ? (-o.timeMs / 40) * o.ratio : 0;
  const lines = cls === 'gate-jump' && state !== 'locked' ? [-1.6, 1.6] : [0];
  for (const off of lines) {
    const ox = -uy * off * o.ratio;
    const oy = ux * off * o.ratio;
    ctx.beginPath();
    ctx.moveTo(x1 + ox, y1 + oy);
    ctx.lineTo(x2 + ox, y2 + oy);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (state === 'sealed') {
    // gate mark: two short bars across the route
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2 * o.ratio;
    for (const s of [-3, 3]) {
      const cx = mx + ux * s * o.ratio;
      const cy = my + uy * s * o.ratio;
      ctx.beginPath();
      ctx.moveTo(cx - uy * 6 * o.ratio, cy + ux * 6 * o.ratio);
      ctx.lineTo(cx + uy * 6 * o.ratio, cy - ux * 6 * o.ratio);
      ctx.stroke();
    }
  }
}

export function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width: number, dash: readonly number[] = []): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash as number[]);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function brackets(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width: number, arm: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const cx = x + sx * r;
    const cy = y + sy * r;
    ctx.beginPath();
    ctx.moveTo(cx, cy - sy * arm);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx - sx * arm, cy);
    ctx.stroke();
  }
}

/** Integer art scale for a node of radius r (device px): crisp pixels, no blur. */
export function artSizeFor(radiusDevice: number): { n: number; scale: number } {
  const target = radiusDevice * 2.3;
  const scale = Math.max(1, Math.round(target / 40));
  return { n: Math.max(16, Math.round(target / scale)), scale };
}

export function drawGalaxyMap(ctx: CanvasRenderingContext2D, W: number, H: number, scene: MapScene, art: GalaxyArtCache, o: MapDrawOptions): void {
  const { layout, graph } = scene;
  const k = o.ratio;
  const P = (id: GalaxyId): { x: number; y: number } => ({ x: layout.nodes[id].x * k, y: layout.nodes[id].y * k });
  const r = layout.radius * k;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = COLORS['space.void'];
  ctx.fillRect(0, 0, W, H);

  let dir = { x: 1, y: 0 };
  if (scene.travel) {
    const a = P(scene.travel.from);
    const b = P(scene.travel.to);
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    dir = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  }
  starfield(ctx, W, H, o, scene.travel, dir);

  // routes: dim ones first so highlighted courses sit on top
  const order: NavEdge[] = [...graph.edges].sort((e1, e2) => Number(scene.highlight.has(e1.id)) - Number(scene.highlight.has(e2.id)));
  for (const e of order) {
    const a = P(e.from);
    const b = P(e.to);
    strokeRoute(ctx, a.x, a.y, b.x, b.y, r, e.route.routeClass, scene.edgeStates.get(e.id) ?? 'locked', scene.highlight.has(e.id), o);
  }

  const pulse = o.reducedMotion ? 0 : Math.sin(o.timeMs / 420);
  const { n, scale } = artSizeFor(r);
  for (const node of graph.nodes) {
    const id = node.id;
    const { x, y } = P(id);
    const st = scene.nodeStates[id];
    const locked = st === 'locked';
    const img = art.get(node.galaxy, n, locked ? 'mono' : 'color');
    const size = n * scale;
    ctx.globalAlpha = locked ? 0.5 : st === 'discovered' ? 0.85 : 1;
    ctx.drawImage(img, Math.round(x - size / 2), Math.round(y - size / 2), size, size);
    ctx.globalAlpha = 1;
    const rr = r + 4 * k;
    if (st === 'current') {
      ring(ctx, x, y, rr, HIGHLIGHT, 2 * k);
      ring(ctx, x, y, rr + 5 * k, 'rgba(92,239,255,0.35)', 1 * k);
    } else if (st === 'available') ring(ctx, x, y, rr, 'rgba(92,239,255,0.85)', 1.5 * k);
    else if (st === 'discovered') ring(ctx, x, y, rr, 'rgba(138,144,173,0.7)', 1 * k);
    else ring(ctx, x, y, rr, 'rgba(138,144,173,0.5)', 1 * k, [3 * k, 4 * k]);
    if (locked) pixels(ctx, LOCK, x + r * 0.72, y + r * 0.62, Math.max(1, Math.round(1.6 * k)), DIM);
    if (id === scene.hovered && id !== scene.selected) brackets(ctx, x, y, rr + 4 * k, 'rgba(243,239,228,0.55)', 1 * k, 5 * k);
    if (id === scene.selected) brackets(ctx, x, y, rr + (5 + pulse * 1.5) * k, '#f3efe4', 2 * k, 7 * k);
  }

  // you-are-here ship, or the ship in flight during a travel transition
  const px = Math.max(1, Math.round(1.7 * k));
  if (scene.travel) {
    const a = P(scene.travel.from);
    const b = P(scene.travel.to);
    const t = ease(scene.travel.t);
    const sx = a.x + (b.x - a.x) * t;
    const sy = a.y + (b.y - a.y) * t;
    const angle = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
    ctx.strokeStyle = 'rgba(255,225,74,0.5)';
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(a.x + (b.x - a.x) * Math.max(0, t - 0.25), a.y + (b.y - a.y) * Math.max(0, t - 0.25));
    ctx.lineTo(sx, sy);
    ctx.stroke();
    pixels(ctx, SHIP, sx, sy, px, '#f3efe4', angle);
  } else {
    const { x, y } = P(scene.current);
    pixels(ctx, SHIP, x - r - 9 * k, y - r * 0.55, px, '#f3efe4');
  }
  if (scene.arrival !== null) {
    const { x, y } = P(scene.current);
    const t = scene.arrival;
    ctx.globalAlpha = Math.max(0, 1 - t);
    ring(ctx, x, y, r + (4 + t * 22) * k, COURSE, 2 * k);
    ctx.globalAlpha = 1;
  }
}
