import { SPRITE_STYLE } from '../../config/visual.ts';
import type { Viewport } from '../viewport.ts';
import type { CachedFrame, SpriteCache } from './spriteCache.ts';

export interface DrawOptions {
  /** Radians, clockwise. Rotated sprites skip pixel snapping. */
  readonly rotation?: number;
  readonly alpha?: number;
  /** Draw the pre-rendered glow layer (default true). */
  readonly glow?: boolean;
  /** Extra scale multiplier (e.g. 0.5 for a distant ship). Default 1. */
  readonly zoom?: number;
}

/**
 * Draw a cached frame centred at art-space (x, y).
 * - Integer device scale: nearest-neighbour, position snapped to the art grid.
 * - Fractional scale: "sharp bilinear" (integer NN prescale, then smooth
 *   resample to the exact size) so pixels stay even-sized without shimmer.
 * The glow layer is composited additively ('lighter') with config opacity.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  cache: SpriteCache,
  frame: CachedFrame,
  v: Viewport,
  x: number,
  y: number,
  options: DrawOptions = {},
): void {
  const scale = v.scale * (options.zoom ?? 1);
  const rotation = options.rotation ?? 0;
  const alpha = options.alpha ?? 1;
  const w = frame.raster.sprite.width;
  const h = frame.raster.sprite.height;
  const isInteger = Math.abs(scale - Math.round(scale)) < 1e-6 && scale >= 1;
  const source = isInteger ? { sprite: frame.sprite, glow: frame.glow } : cache.prescaled(frame, scale);

  let cx = v.offsetX + x * v.scale;
  let cy = v.offsetY + y * v.scale;
  if (rotation === 0) {
    // Snap so the sprite's top-left lands on a whole device pixel.
    cx = Math.round(cx - (w * scale) / 2) + (w * scale) / 2;
    cy = Math.round(cy - (h * scale) / 2) + (h * scale) / 2;
  }

  ctx.save();
  ctx.translate(cx, cy);
  if (rotation !== 0) ctx.rotate(rotation);
  const dw = w * scale;
  const dh = h * scale;

  if (source.glow && options.glow !== false) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * SPRITE_STYLE.glowOpacity;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(source.glow, -dw / 2, -dh / 2, dw, dh);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = !(isInteger && rotation === 0);
  if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(source.sprite, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}
