/**
 * Moving starfield for the title screen (owner request, FR-TD-81): three
 * parallax layers like Free Roam's sector starfield (FR-TD-40 look: far
 * layers at 0.2 / 0.45 / 0.75), drifting as if the ship were cruising, with
 * a slight look-around when the pointer or a finger moves.
 *
 * Pure and DOM-free: positions come from a seeded integer hash per grid cell,
 * so the field is endless with nothing allocated per frame, and the same seed
 * always gives the same sky. The title screen owns the canvas, the loop and
 * the listeners; this module only steps the camera and draws.
 *
 * Cost rules: `draw` repaints only when a layer's whole-pixel offset changed
 * (most 60 Hz frames are skipped at cruising speed); the canvas is a
 * half-resolution backing store scaled up with pixelated rendering.
 */
import { COLORS, type ColorRole } from '../../config/palette.ts';

export interface TitleStarLayer {
  /** Parallax depth: how far this layer moves per unit of camera movement. */
  readonly factor: number;
  /** Grid cell (canvas px) holding `perCell` stars. */
  readonly cell: number;
  readonly roles: readonly ColorRole[];
}

export const TITLE_STARS = Object.freeze({
  /** Far -> near, the same depths and colour roles as Free Roam's sector starfield. */
  layers: [
    { factor: 0.2, cell: 70, roles: ['star.dim', 'star.dim', 'star.cool'] },
    { factor: 0.45, cell: 90, roles: ['star.dim', 'star.mid', 'star.warm'] },
    { factor: 0.75, cell: 120, roles: ['star.mid', 'star.bright', 'star.cool'] },
  ] as readonly TitleStarLayer[],
  perCell: 3,
  /** CSS px per canvas px (the field is drawn at half resolution, like the old static sky). */
  pixel: 2,
  /** Cruise: camera speed (canvas px/s at depth 1); the heading sways around "up" so the trip never feels like a loop. */
  cruise: { speed: 13, sway: 0.55, swayPeriodMs: 120_000 },
  /** Look-around: the camera leans up to `maxPx` canvas px towards the pointer, eased over ~`easeMs`. */
  parallax: { maxPx: 22, easeMs: 320 },
  /** Longest step accepted (ms): a tab coming back from the background never jumps the sky. */
  maxStepMs: 100,
});

/** Integer hash -> [0, 1). Stable per (a, b, c); decoration only. */
export function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Minimal 2D context surface the field draws with (a real canvas context satisfies it). */
export interface StarContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
}

export class TitleStarfield {
  private readonly seed: number;
  private width = 0;
  private height = 0;
  /** Cruise position (canvas px at depth 1). */
  private camX = 0;
  private camY = 0;
  /** Eased look-around offset and its target (canvas px at depth 1). */
  private lookX = 0;
  private lookY = 0;
  private targetX = 0;
  private targetY = 0;
  private clockMs = 0;
  /** Whole-pixel offsets of the last painted frame, per layer (NaN = never painted). */
  private readonly painted: number[];
  /** Frames actually painted (diagnostics). */
  paints = 0;

  constructor(seed = 7) {
    this.seed = seed;
    this.painted = TITLE_STARS.layers.flatMap(() => [Number.NaN, Number.NaN]);
  }

  /** Canvas size in canvas px; returns true when it changed (the next draw repaints). */
  resize(width: number, height: number): boolean {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.painted.fill(Number.NaN);
    return true;
  }

  /**
   * Where the pointer is, as a fraction of the screen (0..1 on each axis), or
   * null when it left / the finger lifted (the view eases back to centre).
   */
  look(fx: number | null, fy?: number): void {
    if (fx === null || fy === undefined || !Number.isFinite(fx) || !Number.isFinite(fy)) {
      this.targetX = 0;
      this.targetY = 0;
      return;
    }
    const P = TITLE_STARS.parallax;
    this.targetX = (Math.max(0, Math.min(1, fx)) * 2 - 1) * P.maxPx;
    this.targetY = (Math.max(0, Math.min(1, fy)) * 2 - 1) * P.maxPx;
  }

  /** Advance the cruise and the look-around easing by dtMs (clamped). */
  step(dtMs: number): void {
    const dt = Math.max(0, Math.min(TITLE_STARS.maxStepMs, dtMs));
    if (dt === 0) return;
    const C = TITLE_STARS.cruise;
    this.clockMs += dt;
    const heading = -Math.PI / 2 + C.sway * Math.sin((2 * Math.PI * this.clockMs) / C.swayPeriodMs);
    this.camX += (Math.cos(heading) * C.speed * dt) / 1000;
    this.camY += (Math.sin(heading) * C.speed * dt) / 1000;
    const k = 1 - Math.exp(-dt / TITLE_STARS.parallax.easeMs);
    this.lookX += (this.targetX - this.lookX) * k;
    this.lookY += (this.targetY - this.lookY) * k;
  }

  /** The whole-pixel camera offset of layer `li` (what the frame is drawn at). */
  layerOffset(li: number): { x: number; y: number } {
    const f = TITLE_STARS.layers[li]!.factor;
    return { x: Math.round((this.camX + this.lookX) * f), y: Math.round((this.camY + this.lookY) * f) };
  }

  /** True when the next draw would paint something new. */
  get dirty(): boolean {
    for (let li = 0; li < TITLE_STARS.layers.length; li++) {
      const o = this.layerOffset(li);
      if (o.x !== this.painted[li * 2] || o.y !== this.painted[li * 2 + 1]) return true;
    }
    return false;
  }

  /**
   * Paint the void and every visible star. Skips the work (returns false)
   * when no layer moved by a whole pixel since the last paint, unless forced.
   */
  draw(ctx: StarContext, force = false): boolean {
    if (this.width === 0 || (!force && !this.dirty)) return false;
    const W = this.width;
    const H = this.height;
    ctx.fillStyle = COLORS['space.void'];
    ctx.fillRect(0, 0, W, H);
    TITLE_STARS.layers.forEach((layer, li) => {
      const o = this.layerOffset(li);
      this.painted[li * 2] = o.x;
      this.painted[li * 2 + 1] = o.y;
      const C = layer.cell;
      const c0 = Math.floor(o.x / C);
      const c1 = Math.floor((o.x + W) / C);
      const r0 = Math.floor(o.y / C);
      const r1 = Math.floor((o.y + H) / C);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          for (let i = 0; i < TITLE_STARS.perCell; i++) {
            const salt = this.seed * 131 + li * 16 + i;
            const x = Math.floor((c + hash01(c, r, salt)) * C) - o.x;
            const y = Math.floor((r + hash01(r, c, salt + 7)) * C) - o.y;
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            ctx.fillStyle = COLORS[layer.roles[Math.floor(hash01(c, r, salt + 13) * layer.roles.length)]!];
            ctx.fillRect(x, y, 1, 1);
          }
        }
      }
    });
    this.paints += 1;
    return true;
  }
}
