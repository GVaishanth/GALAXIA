/**
 * FR-TD-86 feedback for planet and star pull in ordinary sectors:
 *  - field ring: a dotted neutral circle where the pull falls to GRAVITY.feltPull.
 *    It appears as the ship approaches (within 1.5x its radius) and brightens inside.
 *    Its dotted pattern and neutral colour keep it distinct from a star's dashed,
 *    star-coloured burn ring (not colour alone).
 *  - pull chevron: a small chevron just outside the hull, pointing where the
 *    ship is being pulled; a second chevron is added when the pull is strong.
 * Presentation only: reads run.wells / run.gravity, never changes them.
 */
import { GRAVITY } from './gravityWells.ts';
import type { SectorRun } from './run.ts';

const RING = '#b9c4e4';
const ARROW = '#e6ecff';
const ARROW_EDGE = '#1a1f33';

/** Field rings for the wells near the ship (drawn with the landmarks, under ships). */
export function drawFieldRings(
  ctx: CanvasRenderingContext2D,
  run: SectorRun,
  toX: (x: number) => number,
  toY: (y: number) => number,
  zoom: number,
  visible: (x: number, y: number, r: number) => boolean,
): void {
  if (run.flight || run.wells.length === 0) return;
  const sh = run.ship;
  const dot = Math.max(1, Math.round(2 * zoom));
  const gap = Math.max(4, Math.round(11 * zoom));
  ctx.lineWidth = Math.max(1, Math.round(1.5 * zoom));
  ctx.lineCap = 'round';
  ctx.strokeStyle = RING;
  ctx.setLineDash([dot, gap]);
  for (const w of run.wells) {
    if (!visible(w.x, w.y, w.felt)) continue;
    const d = Math.hypot(sh.x - w.x, sh.y - w.y);
    const reach = w.felt * 1.5;
    if (d >= reach) continue;
    // fades in over the approach band, steady (and brighter) once inside
    const a = d <= w.felt ? 0.42 : 0.22 * (1 - (d - w.felt) / (reach - w.felt));
    if (a <= 0.01) continue;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(toX(w.x), toY(w.y), w.felt * zoom, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineCap = 'butt';
  ctx.globalAlpha = 1;
}

/** The pull chevron at the ship's (interpolated) position. */
export function drawPullArrow(ctx: CanvasRenderingContext2D, run: SectorRun, sx: number, sy: number, toX: (x: number) => number, toY: (y: number) => number, zoom: number): void {
  const g = run.gravity;
  if (run.flight || g.g < GRAVITY.arrowPull) return;
  const ux = g.x / g.g;
  const uy = g.y / g.g;
  const vx = -uy;
  const vy = ux;
  const size = 6;
  const a = Math.min(0.9, 0.45 + (0.45 * (g.g - GRAVITY.arrowPull)) / (GRAVITY.strongPull - GRAVITY.arrowPull));
  const count = g.g >= GRAVITY.strongPull ? 2 : 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = a;
  for (let i = 0; i < count; i++) {
    const off = run.tune.radius + 8 + i * 7; // world px from the ship centre
    const tx = sx + ux * (off + size);
    const ty = sy + uy * (off + size);
    const bx = sx + ux * off;
    const by = sy + uy * off;
    ctx.beginPath();
    ctx.moveTo(toX(bx + vx * size), toY(by + vy * size));
    ctx.lineTo(toX(tx), toY(ty));
    ctx.lineTo(toX(bx - vx * size), toY(by - vy * size));
    ctx.strokeStyle = ARROW_EDGE;
    ctx.lineWidth = Math.max(2, Math.round(4 * zoom));
    ctx.stroke();
    ctx.strokeStyle = ARROW;
    ctx.lineWidth = Math.max(1, Math.round(2 * zoom));
    ctx.stroke();
  }
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.globalAlpha = 1;
}
