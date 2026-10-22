/**
 * Art-review export: renders every sprite look to PNG contact sheets using the
 * same pure rasteriser the game uses. Run: npm run sprites:sheet
 * Output: docs/design/review/*.png
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOKS, SPRITES, VARIANTS, type SpriteId } from '../src/assets/sprites/index.ts';
import { expandFrame } from '../src/assets/sprites/format/grid.ts';
import { rasterizeFrame } from '../src/render/sprite/rasterize.ts';
import type { RasterFrame, SpriteDef } from '../src/assets/sprites/format/types.ts';
import { SPRITE_STYLE } from '../src/config/visual.ts';
import { encodePng } from './lib/png.ts';
import { Surface } from './lib/surface.ts';
import { simulate, type Deficiency } from './lib/cvd.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', 'design', 'review');
mkdirSync(outDir, { recursive: true });

const BG = '#06070f';

function frames(spriteId: SpriteId, state: string, variantId?: keyof typeof VARIANTS): RasterFrame[] {
  const def: SpriteDef = SPRITES[spriteId];
  const sources = def.states[state];
  if (!sources) throw new Error(`${spriteId} has no state ${state}`);
  const variant = variantId ? VARIANTS[variantId] : undefined;
  return sources.map((src) => rasterizeFrame(expandFrame(src), def.palette, def.outline, variant));
}

function draw(s: Surface, f: RasterFrame, cx: number, cy: number, scale: number): void {
  const x = Math.round(cx - (f.sprite.width * scale) / 2);
  const y = Math.round(cy - (f.sprite.height * scale) / 2);
  if (f.glow) s.blit(f.glow, x, y, scale, 'add', SPRITE_STYLE.glowOpacity);
  s.blit(f.sprite, x, y, scale, 'over');
}

/* Sheet 1: every look and every frame at 4x art scale, labelled. */
function fleetSheet(scale: number, file: string): void {
  const labelW = 250;
  const rowsData = LOOKS.map((look) => ({ look, fr: frames(look.sprite, look.state, look.variant) }));
  const cell = Math.max(...rowsData.flatMap((r) => r.fr.map((f) => f.sprite.width * scale))) + 8;
  const rowH = (fr: RasterFrame[]) => Math.max(72, ...fr.map((f) => f.sprite.height * scale + 16));
  const maxFrames = Math.max(...rowsData.map((r) => r.fr.length));
  const width = labelW + maxFrames * cell + 16;
  const height = rowsData.reduce((n, r) => n + rowH(r.fr), 0) + 16;
  const s = new Surface(width, height, BG);
  let y = 8;
  for (const { look, fr } of rowsData) {
    const h = rowH(fr);
    s.fillRect(0, y + h - 1, width, 1, '#141829');
    s.text(look.label, 8, y + h / 2 - 7, 2, '#f3efe4');
    s.text(`${look.sprite}/${look.state}${look.variant ? ' +' + look.variant : ''}`, 8, y + h / 2 + 8, 1, '#7d84a3');
    fr.forEach((f, i) => draw(s, f, labelW + i * cell + cell / 2, y + h / 2, scale));
    y += h;
  }
  writeFileSync(join(outDir, file), encodePng(s.width, s.height, s.data));
  console.log(`wrote ${file} ${s.width}x${s.height}`);
}

/* Sheet 2: true game scale lineup on the playfield background (1 art px = 1 px, then integer zoom). */
function lineup(zoom: number, file: string): Surface {
  const W = 448;
  const H = 300;
  const s1 = new Surface(W, H, BG);
  // sparse stars
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 70; i++) s1.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), 1, 1, rnd() < 0.2 ? '#8d96b8' : '#353b57');
  const f = (id: SpriteId, st: string, v?: keyof typeof VARIANTS, i = 0) => frames(id, st, v)[i]!;
  // formation rows (spacing 32 art px = 16 units, classic grid pitch)
  const pitch = 32;
  const cols = (n: number) => Array.from({ length: n }, (_, i) => W / 2 + (i - (n - 1) / 2) * pitch);
  cols(4).forEach((x, i) => draw(s1, f('enemy.commander', 'formation', i === 1 ? 'damaged' : undefined), x, 34, 1));
  cols(8).forEach((x) => draw(s1, f('enemy.interceptor', 'formation'), x, 70, 1));
  cols(8).forEach((x) => draw(s1, f('enemy.interceptor', 'formation', undefined, 1), x, 100, 1));
  cols(10).forEach((x) => draw(s1, f('enemy.scout', 'formation'), x, 130, 1));
  cols(10).forEach((x) => draw(s1, f('enemy.scout', 'formation', undefined, 1), x, 158, 1));
  draw(s1, f('special.stinger', 'flight'), 60, 200, 1);
  draw(s1, f('special.phantom', 'flight'), 100, 200, 1);
  draw(s1, f('special.sovereign', 'flight'), 140, 200, 1);
  draw(s1, f('enemy.commander', 'capture'), 330, 196, 1);
  draw(s1, f('fx.beam.tractor', 'active'), 330, 252, 1);
  draw(s1, f('player.fighter', 'captured', 'captive'), 380, 196, 1);
  draw(s1, f('fx.shot.enemy', 'fly'), 200, 220, 1);
  draw(s1, f('fx.shot.enemy', 'fly'), 250, 240, 1);
  draw(s1, f('fx.shot.player', 'fly'), 160, 240, 1);
  draw(s1, f('fx.explosion.enemy', 'burst', undefined, 1), 230, 180, 1);
  draw(s1, f('player.fighter', 'idle'), 160, 276, 1);
  draw(s1, f('player.dual', 'idle'), 90, 276, 1);
  draw(s1, f('fx.hit', 'spark'), 200, 140, 1);
  // zoom up with nearest neighbour
  const s = new Surface(W * zoom, H * zoom, BG);
  s.blit({ width: W, height: H, data: s1.data }, 0, 0, zoom);
  writeFileSync(join(outDir, file), encodePng(s.width, s.height, s.data));
  console.log(`wrote ${file} ${s.width}x${s.height}`);
  return s;
}

/* Sheet 3: colour-vision-deficiency simulations of the true-scale lineup, stacked. */
function cvdSheet(source: Surface, file: string): void {
  const kinds: Deficiency[] = ['protanopia', 'deuteranopia', 'tritanopia'];
  const labelH = 22;
  const s = new Surface(source.width, (source.height + labelH) * kinds.length, BG);
  kinds.forEach((kind, i) => {
    const y = i * (source.height + labelH);
    s.text(kind.toUpperCase() + ' (MACHADO 2009, SEVERITY 1.0)', 8, y + 6, 2, '#f3efe4');
    s.blit({ width: source.width, height: source.height, data: simulate(source.data, kind) }, 0, y + labelH, 1);
  });
  writeFileSync(join(outDir, file), encodePng(s.width, s.height, s.data));
  console.log(`wrote ${file} ${s.width}x${s.height}`);
}

fleetSheet(4, 'fleet-4x.png');
lineup(1, 'lineup-1x.png');
cvdSheet(lineup(2, 'lineup-2x.png'), 'lineup-cvd-2x.png');
