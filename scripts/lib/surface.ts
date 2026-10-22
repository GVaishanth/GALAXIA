import type { RgbaImage } from '../../src/assets/sprites/format/types.ts';
import { GLYPH_ADVANCE, glyph } from '../../src/assets/fonts/pixelFont.ts';
import { hexToRgb } from '../../src/config/palette.ts';

/** Software RGBA surface used to compose review sheets in Node. */
export class Surface {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number, background: string) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    const [r, g, b] = hexToRgb(background);
    for (let i = 0; i < width * height; i++) {
      this.data[i * 4] = r;
      this.data[i * 4 + 1] = g;
      this.data[i * 4 + 2] = b;
      this.data[i * 4 + 3] = 255;
    }
  }

  fillRect(x: number, y: number, w: number, h: number, hex: string): void {
    const [r, g, b] = hexToRgb(hex);
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) {
        const i = (yy * this.width + xx) * 4;
        this.data[i] = r;
        this.data[i + 1] = g;
        this.data[i + 2] = b;
      }
    }
  }

  /** Nearest-neighbour integer-scaled blit. mode 'over' = alpha blend, 'add' = additive with opacity. */
  blit(img: RgbaImage, x0: number, y0: number, scale: number, mode: 'over' | 'add' = 'over', opacity = 1): void {
    for (let sy = 0; sy < img.height; sy++) {
      for (let sx = 0; sx < img.width; sx++) {
        const si = (sy * img.width + sx) * 4;
        const a = (img.data[si + 3]! / 255) * opacity;
        if (a <= 0) continue;
        const r = img.data[si]!;
        const g = img.data[si + 1]!;
        const b = img.data[si + 2]!;
        for (let dy = 0; dy < scale; dy++) {
          const y = y0 + sy * scale + dy;
          if (y < 0 || y >= this.height) continue;
          for (let dx = 0; dx < scale; dx++) {
            const x = x0 + sx * scale + dx;
            if (x < 0 || x >= this.width) continue;
            const di = (y * this.width + x) * 4;
            if (mode === 'over') {
              this.data[di] = this.data[di]! * (1 - a) + r * a;
              this.data[di + 1] = this.data[di + 1]! * (1 - a) + g * a;
              this.data[di + 2] = this.data[di + 2]! * (1 - a) + b * a;
            } else {
              this.data[di] = this.data[di]! + r * a;
              this.data[di + 1] = this.data[di + 1]! + g * a;
              this.data[di + 2] = this.data[di + 2]! + b * a;
            }
          }
        }
      }
    }
  }

  text(str: string, x: number, y: number, scale: number, hex: string): void {
    let cx = x;
    for (const ch of str) {
      const rows = glyph(ch);
      rows.forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) {
          if (row[gx] === '#') this.fillRect(cx + gx * scale, y + gy * scale, scale, scale, hex);
        }
      });
      cx += GLYPH_ADVANCE * scale;
    }
  }
}
