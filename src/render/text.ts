import { GLYPH_ADVANCE, glyph, textWidth } from '../assets/fonts/pixelFont.ts';
import type { Viewport } from './viewport.ts';

export type TextAlign = 'left' | 'center' | 'right';

/**
 * Draw pixel-font text at art-space (x, y) (top edge). `size` is art pixels
 * per font pixel (1 = 7 art px tall glyphs).
 */
export function drawPixelText(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  text: string,
  x: number,
  y: number,
  color: string,
  size = 1,
  align: TextAlign = 'left',
): void {
  const w = textWidth(text) * size;
  const startX = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const px = Math.max(1, Math.round(size * v.scale));
  ctx.fillStyle = color;
  let cx = startX;
  for (const ch of text) {
    const rows = glyph(ch);
    for (let gy = 0; gy < rows.length; gy++) {
      const row = rows[gy]!;
      for (let gx = 0; gx < row.length; gx++) {
        if (row[gx] !== '#') continue;
        ctx.fillRect(
          Math.round(v.offsetX + (cx + gx * size) * v.scale),
          Math.round(v.offsetY + (y + gy * size) * v.scale),
          px,
          px,
        );
      }
    }
    cx += GLYPH_ADVANCE * size;
  }
}
