/**
 * Procedural tractor beam (Stage 4). Replaces stacking the 72-px beam tile,
 * which repeated the cone shape every tile. The beam is one continuous cone
 * from the commander's emitter to the beam tip, in the same visual language as
 * the Stage 1 sprite: travelling bowed arcs in beam.light / mid / deep, drawn
 * as whole-art-pixel rows (crisp at any scale).
 *
 * The cone's bottom half-width matches the engine's capture half-width plus
 * a small margin, so what the player sees is the grab zone.
 */
import { COLORS } from '../config/palette.ts';
import type { Viewport } from './viewport.ts';

export type BeamPhase = 'extending' | 'holding' | 'retracting';

export interface BeamDraw {
  /** Emitter centre x and top y (art px). */
  readonly x: number;
  readonly top: number;
  readonly length: number;
  readonly maxLength: number;
  readonly phase: BeamPhase;
  readonly timeMs: number;
  /** Engine capture half-width; the cone's foot is drawn just wider than this. */
  readonly grabHalfWidth: number;
  readonly glow: boolean;
  /** 1 = full, lower when reduced motion asks for calmer animation. */
  readonly motion: number;
}

const PERIOD = 9;

export function beamHalfWidth(y: number, maxLength: number, grabHalfWidth: number): number {
  const foot = grabHalfWidth + 4;
  const k = maxLength > 0 ? Math.min(1, Math.max(0, y / maxLength)) : 0;
  return 4 + k * (foot - 4);
}

export function drawTractorBeam(ctx: CanvasRenderingContext2D, v: Viewport, b: BeamDraw): void {
  const rows = Math.floor(b.length);
  if (rows < 2) return;
  const light = COLORS['beam.light'];
  const mid = COLORS['beam.mid'];
  const deep = COLORS['beam.deep'];
  // arcs travel down while extending/holding, up while retracting
  const speed = (b.phase === 'retracting' ? -1 : 1) * (b.phase === 'holding' ? 0.05 : 0.035) * b.motion;
  const shift = (b.timeMs * speed) % PERIOD;
  const prev = ctx.globalAlpha;
  const px = Math.max(1, Math.round(v.scale));
  const sx = (ax: number): number => Math.round(v.offsetX + ax * v.scale);
  const sy = (ay: number): number => Math.round(v.offsetY + ay * v.scale);

  if (b.glow) {
    // faint additive halo, two art px wider than the cone
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = prev * 0.12;
    ctx.fillStyle = mid;
    for (let y = 0; y < rows; y += 2) {
      const hw = Math.round(beamHalfWidth(y, b.maxLength, b.grabHalfWidth)) + 2;
      ctx.fillRect(sx(Math.round(b.x) - hw), sy(b.top + y), Math.round(hw * 2 * v.scale), px * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.globalAlpha = prev * 0.85;
  const cx = Math.round(b.x);
  for (let y = 0; y < rows; y++) {
    const hw = Math.round(beamHalfWidth(y, b.maxLength, b.grabHalfWidth));
    // edges
    ctx.fillStyle = deep;
    ctx.fillRect(sx(cx - hw), sy(b.top + y), px, px);
    ctx.fillRect(sx(cx + hw), sy(b.top + y), px, px);
    // bowed arcs: each row draws the spans whose band index is light/mid/deep
    for (let dx = -hw + 1; dx < hw; dx++) {
      const bow = 5 * (dx / hw) ** 2;
      const band = (((y + bow - shift) % PERIOD) + PERIOD) % PERIOD;
      if (band >= 3) continue;
      ctx.fillStyle = band < 1 ? light : band < 2 ? mid : deep;
      // run-length: extend while the band stays the same colour
      let run = 1;
      while (dx + run < hw) {
        const nb = 5 * ((dx + run) / hw) ** 2;
        const nband = (((y + nb - shift) % PERIOD) + PERIOD) % PERIOD;
        if (Math.floor(nband) !== Math.floor(band)) break;
        run++;
      }
      ctx.fillRect(sx(cx + dx), sy(b.top + y), Math.max(px, Math.round(run * v.scale)), px);
      dx += run - 1;
    }
  }
  // bright tip line while extending (the beam "front")
  if (b.phase === 'extending') {
    const hw = Math.round(beamHalfWidth(rows, b.maxLength, b.grabHalfWidth));
    ctx.globalAlpha = prev;
    ctx.fillStyle = light;
    ctx.fillRect(sx(cx - hw), sy(b.top + rows - 1), Math.round((hw * 2 + 1) * v.scale), px);
  }
  ctx.globalAlpha = prev;
}
