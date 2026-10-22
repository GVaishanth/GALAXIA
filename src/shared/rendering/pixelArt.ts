/**
 * Small pixel-art helpers shared by the title screen and modes: the GALAXIA
 * logo lettering (same banded treatment and palette roles as the Classic title
 * art in render/gameRenderer.ts) and "render once into a small canvas" for
 * icons, which CSS then scales with `image-rendering: pixelated`.
 */
import { textWidth, GLYPH_HEIGHT } from '../../assets/fonts/pixelFont.ts';
import { COLORS } from '../../config/palette.ts';
import { drawPixelText } from '../../render/text.ts';
import { fitViewport, type Viewport } from '../../render/viewport.ts';

/** Viewport that maps art px 1:1 onto a canvas of the given size. */
export function unitViewport(width: number, height: number, scale = 1): Viewport {
  return fitViewport(width * scale, height * scale, { artWidth: width, artHeight: height });
}

/** Draw the banded GALAXIA logo, centred on x, top at y (art px, `size` art px per font px). */
export function drawLogo(ctx: CanvasRenderingContext2D, v: Viewport, x: number, y: number, size: number): void {
  drawPixelText(ctx, v, 'GALAXIA', x, y + Math.max(1, Math.round(size / 2)), COLORS['interceptor.wing.shade'], size, 'center');
  drawPixelText(ctx, v, 'GALAXIA', x, y, COLORS['ui.accent'], size, 'center');
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.offsetX, Math.round(v.offsetY + y * v.scale), Math.ceil(v.artWidth * v.scale), Math.round(size * 2 * v.scale));
  ctx.clip();
  drawPixelText(ctx, v, 'GALAXIA', x, y, COLORS['interceptor.wing.light'], size, 'center');
  ctx.restore();
}

/** A canvas holding the logo at 1 device px per art px (CSS scales it, pixelated). */
export function logoCanvas(size = 2): HTMLCanvasElement {
  const w = textWidth('GALAXIA') * size + 2;
  const h = GLYPH_HEIGHT * size + Math.max(1, Math.round(size / 2)) + 1;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (g) drawLogo(g, unitViewport(w, h), w / 2, 0, size);
  return c;
}

/** Create a w x h canvas and let `paint` draw into it in art px (1:1). */
export function paintCanvas(width: number, height: number, paint: (ctx: CanvasRenderingContext2D, v: Viewport) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  if (g) {
    g.imageSmoothingEnabled = false;
    paint(g, unitViewport(width, height));
  }
  return c;
}
