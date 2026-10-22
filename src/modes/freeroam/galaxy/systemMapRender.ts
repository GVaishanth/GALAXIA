/**
 * System map canvas (presentation only; reads state, never changes it).
 *
 * Draws, in device pixels: the shared starfield, the lanes between visible
 * systems (curved where a straight lane would pass over another system), the
 * system markers, small marker glyphs, selection brackets, the planned course
 * with one pip per drive charge on each hop, the "you are here" ship and the
 * short multi-hop travel animation. Names and statuses are DOM buttons
 * (systemMapScreen.ts), never canvas text.
 *
 * States are told apart by shape as well as colour: signal = dotted ring + "?",
 * known = filled star + thin ring, surveyed = filled star + solid cyan ring,
 * locked = grey + dashed ring + padlock, current = double ring + ship.
 */
import type { SystemCategory } from '../catalogue/types.ts';
import { brackets, COURSE, DIM, ease, HIGHLIGHT, LOCK, pixels, ring, SHIP, starfield, type MapDrawOptions } from './mapRender.ts';
import type { LaneCurve, SystemMapLayout } from './systemLayout.ts';
import type { Knowledge, LaneState, MarkerKind, SystemState } from './systems.ts';
import { COLORS } from '../../../config/palette.ts';

export interface SystemNodeDraw {
  readonly id: string;
  readonly knowledge: Knowledge;
  readonly state: SystemState;
  readonly category: SystemCategory | null;
  readonly markers: readonly MarkerKind[];
}

export interface SystemLaneDraw {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly cost: number;
  readonly state: LaneState;
  readonly curve: LaneCurve;
}

export interface SystemMapScene {
  readonly layout: SystemMapLayout;
  readonly nodes: readonly SystemNodeDraw[];
  readonly lanes: readonly SystemLaneDraw[];
  /** Lane ids of the planned course to the selected / hovered system. */
  readonly course: ReadonlySet<string>;
  readonly current: string | null;
  readonly selected: string | null;
  readonly hovered: string | null;
  /** Travel along `path` (lane curves per hop), t 0..1. */
  readonly travel: { readonly path: readonly string[]; readonly curves: readonly LaneCurve[]; readonly t: number } | null;
  readonly arrival: number | null;
}

/** Marker colours by category (original palette; the map is stylised, not a spectrum). */
export const CATEGORY_COLOR: Readonly<Record<SystemCategory, string>> = {
  'yellow-dwarf': '#ffd23f',
  'orange-dwarf': '#ff9440',
  'red-dwarf': '#ff6b5f',
  'blue-giant': '#8fb4ff',
  'red-giant': '#ff7a50',
  'white-dwarf': '#f3efe4',
  'binary-star': '#ffe9a0',
  'multiple-star': '#ffe9a0',
  'neutron-star': '#a6fbff',
  'black-hole': '#b07cff',
  'stellar-nursery': '#ff8ad8',
  'star-cluster': '#fff1a6',
  'supernova-remnant': '#ff8a98',
  'supernova-site': '#ffb0b8',
  'dark-nebula': '#8a90ad',
  'debris-field': '#9aa2b3',
  'asteroid-field': '#c9a77c',
  'relay-station': '#5cefff',
  'deep-void': '#6b75a0',
  'satellite-galaxy': '#c8d0ff',
  'galactic-structure': '#d9d5c9',
  anomaly: '#d07cff',
};

const QUESTION = ['.###.', '#...#', '...#.', '..#..', '.....', '..#..'];
const GLYPH: Readonly<Record<MarkerKind, { readonly p: readonly string[]; readonly c: string }>> = {
  gateway: { p: ['..#..', '.#.#.', '#...#', '.#.#.', '..#..'], c: '#5cefff' },
  objective: { p: ['..#..', '.###.', '#####', '.###.', '..#..'], c: COURSE },
  key: { p: ['.##..', '#..#.', '.##..', '..#..', '..##.'], c: '#ffb43a' },
  resource: { p: ['.....', '.###.', '.###.', '.###.', '.....'], c: '#9aa2b3' },
  hostile: { p: ['..#..', '..#..', '.###.', '.###.', '#####'], c: '#ff3b4e' },
  station: { p: ['#####', '#...#', '#.#.#', '#...#', '#####'], c: '#5cefff' },
  anomaly: { p: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'], c: '#d07cff' },
};
/** Glyphs drawn on the canvas (resource hints live in the panel; too common to badge). */
const SHOWN: readonly MarkerKind[] = ['objective', 'key', 'gateway', 'hostile', 'station', 'anomaly'];

/** Point on a quadratic lane curve. */
export function curvePoint(c: LaneCurve, t: number): { x: number; y: number } {
  const u = 1 - t;
  return { x: u * u * c.ax + 2 * u * t * c.cx + t * t * c.bx, y: u * u * c.ay + 2 * u * t * c.cy + t * t * c.by };
}

function strokeLane(ctx: CanvasRenderingContext2D, c: LaneCurve, k: number, gap: number, state: LaneState, course: boolean, o: MapDrawOptions): void {
  // trim the ends so lanes stop short of the markers
  const len = Math.hypot(c.bx - c.ax, c.by - c.ay) * k || 1;
  const t0 = Math.min(0.45, gap / len);
  const p0 = curvePoint(c, t0);
  const p1 = curvePoint(c, 1 - t0);
  const mid = curvePoint(c, 0.5);
  // control point of the trimmed curve that still passes through the original midpoint
  const qx = 2 * mid.x - (p0.x + p1.x) / 2;
  const qy = 2 * mid.y - (p0.y + p1.y) / 2;
  ctx.strokeStyle = course ? COURSE : state === 'active' ? 'rgba(92,239,255,0.8)' : state === 'open' ? 'rgba(92,239,255,0.4)' : 'rgba(138,144,173,0.32)';
  ctx.lineWidth = (course ? 2.5 : state === 'active' ? 2 : 1.5) * k;
  ctx.setLineDash(state === 'locked' && !course ? [2 * k, 5 * k] : course ? [9 * k, 5 * k] : []);
  ctx.lineDashOffset = course && !o.reducedMotion ? (-o.timeMs / 40) * k : 0;
  ctx.beginPath();
  ctx.moveTo(p0.x * k, p0.y * k);
  ctx.quadraticCurveTo(qx * k, qy * k, p1.x * k, p1.y * k);
  ctx.stroke();
  ctx.setLineDash([]);
}

function costPips(ctx: CanvasRenderingContext2D, c: LaneCurve, cost: number, k: number): void {
  const m = curvePoint(c, 0.5);
  const d = curvePoint(c, 0.55);
  const l = Math.hypot(d.x - m.x, d.y - m.y) || 1;
  const ux = (d.x - m.x) / l;
  const uy = (d.y - m.y) / l;
  const s = 3.2 * k;
  for (let i = 0; i < cost; i++) {
    const off = (i - (cost - 1) / 2) * 5 * k;
    const x = m.x * k + ux * off;
    const y = m.y * k + uy * off;
    ctx.fillStyle = '#05060c';
    ctx.fillRect(Math.round(x - s / 2 - k), Math.round(y - s / 2 - k), Math.round(s + 2 * k), Math.round(s + 2 * k));
    ctx.fillStyle = COURSE;
    ctx.fillRect(Math.round(x - s / 2), Math.round(y - s / 2), Math.round(s), Math.round(s));
  }
}

export function drawSystemMap(ctx: CanvasRenderingContext2D, W: number, H: number, scene: SystemMapScene, o: MapDrawOptions): void {
  const { layout } = scene;
  const k = o.ratio;
  const r = layout.radius * k;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = COLORS['space.void'];
  ctx.fillRect(0, 0, W, H);
  starfield(ctx, W, H, o, scene.travel, { x: 1, y: 0 });

  const gap = layout.radius + 6;
  const lanes = [...scene.lanes].sort((x, y) => Number(scene.course.has(x.id)) - Number(scene.course.has(y.id)));
  for (const l of lanes) strokeLane(ctx, l.curve, k, gap, l.state, scene.course.has(l.id), o);
  for (const l of lanes) if (scene.course.has(l.id)) costPips(ctx, l.curve, l.cost, k);

  const pulse = o.reducedMotion ? 0 : Math.sin(o.timeMs / 420);
  const px = Math.max(2, Math.round(1.6 * k)); // glyphs stay legible at 1x
  for (const n of scene.nodes) {
    const p = layout.nodes[n.id];
    if (!p) continue;
    const x = p.x * k;
    const y = p.y * k;
    const locked = n.state === 'locked';
    const dimmed = locked || n.state === 'blocked' || n.state === 'remote';
    if (n.knowledge === 'signal') {
      ring(ctx, x, y, r * 0.8, locked ? 'rgba(138,144,173,0.5)' : 'rgba(166,251,255,0.65)', 1.2 * k, [2 * k, 3 * k]);
      pixels(ctx, QUESTION, x, y, px, locked ? DIM : '#a6fbff');
    } else {
      const color = n.category ? CATEGORY_COLOR[n.category] : '#d9d5c9';
      ctx.globalAlpha = locked ? 0.45 : dimmed ? 0.7 : 1;
      ctx.fillStyle = locked ? '#8a90ad' : color;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
      // a 4-point glint keeps the marker pixel-arcade rather than a flat dot
      ctx.fillRect(Math.round(x - k), Math.round(y - r * 0.95), Math.round(2 * k), Math.round(r * 1.9));
      ctx.fillRect(Math.round(x - r * 0.95), Math.round(y - k), Math.round(r * 1.9), Math.round(2 * k));
      ctx.globalAlpha = 1;
      if (n.knowledge === 'surveyed') ring(ctx, x, y, r + 2 * k, locked ? 'rgba(138,144,173,0.6)' : 'rgba(92,239,255,0.85)', 1.5 * k);
      else ring(ctx, x, y, r + 2 * k, 'rgba(138,144,173,0.65)', 1 * k, locked ? [3 * k, 3 * k] : []);
    }
    if (locked) pixels(ctx, LOCK, x + r * 0.9, y + r * 0.7, px, DIM);
    if (n.id === scene.current) {
      ring(ctx, x, y, r + 5 * k, HIGHLIGHT, 2 * k);
      ring(ctx, x, y, r + 9 * k, 'rgba(92,239,255,0.35)', 1 * k);
    }
    // marker glyphs in a row above the marker
    const glyphs = SHOWN.filter((m) => n.markers.includes(m));
    const gw = 7 * px;
    glyphs.forEach((m, i) => {
      const gx = x + (i - (glyphs.length - 1) / 2) * gw;
      pixels(ctx, GLYPH[m].p, gx, y - r - 7 * px, px, GLYPH[m].c);
    });
    if (n.id === scene.hovered && n.id !== scene.selected) brackets(ctx, x, y, r + 7 * k, 'rgba(243,239,228,0.55)', 1 * k, 4 * k);
    if (n.id === scene.selected) brackets(ctx, x, y, r + (8 + pulse * 1.2) * k, '#f3efe4', 2 * k, 6 * k);
  }

  const shipPx = Math.max(1, Math.round(1.4 * k));
  if (scene.travel && scene.travel.curves.length > 0) {
    const hops = scene.travel.curves.length;
    const t = ease(scene.travel.t) * hops;
    const i = Math.min(hops - 1, Math.floor(t));
    const c = scene.travel.curves[i]!;
    const lt = t - i;
    const p = curvePoint(c, lt);
    const q = curvePoint(c, Math.min(1, lt + 0.02));
    const angle = Math.atan2(q.y - p.y, q.x - p.x) + Math.PI / 2;
    pixels(ctx, SHIP, p.x * k, p.y * k, shipPx, '#f3efe4', angle);
  } else if (scene.current && layout.nodes[scene.current]) {
    const p = layout.nodes[scene.current]!;
    pixels(ctx, SHIP, p.x * k - r - 10 * k, p.y * k - r * 0.4, shipPx, '#f3efe4');
  }
  if (scene.arrival !== null && scene.current && layout.nodes[scene.current]) {
    const p = layout.nodes[scene.current]!;
    ctx.globalAlpha = Math.max(0, 1 - scene.arrival);
    ring(ctx, p.x * k, p.y * k, r + (5 + scene.arrival * 18) * k, COURSE, 2 * k);
    ctx.globalAlpha = 1;
  }
}
