/**
 * Browser icons from the real in-game fighter sprite (same rasteriser as the game).
 * Run: npm run icons
 * Output (committed, served from public/ under any base path):
 *   public/favicon.svg          scalable tab icon (crisp pixel rects)
 *   public/favicon-32.png       PNG fallback for browsers without SVG favicons
 *   public/apple-touch-icon.png 180x180 home-screen icon (iOS ignores SVG)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYER_FIGHTER } from '../src/assets/sprites/player.ts';
import { expandFrame } from '../src/assets/sprites/format/grid.ts';
import { rasterizeFrame } from '../src/render/sprite/rasterize.ts';
import type { RgbaImage } from '../src/assets/sprites/format/types.ts';
import { encodePng } from './lib/png.ts';
import { Surface } from './lib/surface.ts';

const BG = '#06070f'; // palette background (matches <meta name="theme-color">)
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public');
mkdirSync(outDir, { recursive: true });

const def = PLAYER_FIGHTER;
const src = def.states.idle[0];
if (!src) throw new Error('playerFighter has no idle frame');
const frame = rasterizeFrame(expandFrame(src), def.palette, def.outline);

/** Crop an image to its non-transparent bounds. */
function crop(img: RgbaImage): RgbaImage & { x0: number; y0: number } {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > 0) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  if (x1 < 0) throw new Error('empty sprite');
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data, x0, y0 };
}

const ship = crop(frame.sprite);
const hex = (r: number, g: number, b: number): string => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/* SVG: one rect per horizontal run of identical pixels, on a rounded dark tile. */
const pad = 2;
const size = Math.max(ship.width, ship.height) + pad * 2;
const ox = Math.floor((size - ship.width) / 2);
const oy = Math.floor((size - ship.height) / 2);
const rects: string[] = [];
for (let y = 0; y < ship.height; y++) {
  let x = 0;
  while (x < ship.width) {
    const i = (y * ship.width + x) * 4;
    const a = ship.data[i + 3]!;
    if (a === 0) { x++; continue; }
    const key = ship.data.subarray(i, i + 4).join();
    let run = 1;
    while (x + run < ship.width && ship.data.subarray(i + run * 4, i + run * 4 + 4).join() === key) run++;
    const fill = hex(ship.data[i]!, ship.data[i + 1]!, ship.data[i + 2]!);
    rects.push(`<rect x="${x + ox}" y="${y + oy}" width="${run}" height="1" fill="${fill}"${a < 255 ? ` fill-opacity="${(a / 255).toFixed(2)}"` : ''}/>`);
    x += run;
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><title>GALAXIA</title><rect width="${size}" height="${size}" rx="3" fill="${BG}"/>${rects.join('')}</svg>\n`;
writeFileSync(join(outDir, 'favicon.svg'), svg);
console.log(`wrote public/favicon.svg ${size}x${size} (${rects.length} runs)`);

/* PNGs: largest integer scale that fits ~84% of the tile, centred; glow layer on larger icons. */
for (const [file, n] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180]] as const) {
  const s = new Surface(n, n, BG);
  const scale = Math.max(1, Math.floor((n * 0.84) / Math.max(ship.width, ship.height)));
  const x = Math.floor((n - ship.width * scale) / 2);
  const y = Math.floor((n - ship.height * scale) / 2);
  // the glow layer has the sprite's padded size: align it through the crop offset
  if (frame.glow && n >= 64) s.blit(frame.glow, x - ship.x0 * scale, y - ship.y0 * scale, scale, 'add', 0.6);
  s.blit(ship, x, y, scale, 'over');
  writeFileSync(join(outDir, file), encodePng(n, n, s.data));
  console.log(`wrote public/${file} ${n}x${n} (scale ${scale})`);
}
