/**
 * Title-screen card art (original pixel illustrations, drawn at 1 device px
 * per art px from the shared sprite cache; CSS scales them, pixelated).
 *
 *  - Classic:   a framed fixed screen: formation row up top, the fighter
 *               locked to the bottom line firing upward, left/right arrows.
 *  - Free Roam: an open star field: the fighter banking along a curved,
 *               dotted flight path past survey beacons and a ringed planet,
 *               with chevrons in four directions.
 */
import { COLORS } from '../../config/palette.ts';
import { drawFrame } from '../../render/sprite/drawSprite.ts';
import type { SpriteCache } from '../../render/sprite/spriteCache.ts';
import type { Viewport } from '../../render/viewport.ts';
import { createRng } from '../../core/rng.ts';
import { paintCanvas } from '../rendering/pixelArt.ts';

export const CARD_ART = Object.freeze({ width: 160, height: 96 });

function stars(ctx: CanvasRenderingContext2D, seed: number, count: number, w: number, h: number): void {
  const rng = createRng(seed);
  const roles = ['star.dim', 'star.mid', 'star.cool', 'star.bright'] as const;
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = COLORS[roles[rng.int(0, roles.length - 1)]!];
    ctx.fillRect(rng.int(1, w - 2), rng.int(1, h - 2), 1, 1);
  }
}

function px(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

export function classicArt(cache: SpriteCache): HTMLCanvasElement {
  const { width: W, height: H } = CARD_ART;
  return paintCanvas(W, H, (ctx, v: Viewport) => {
    ctx.fillStyle = COLORS['space.letterbox'];
    ctx.fillRect(0, 0, W, H);
    // the fixed screen: a portrait frame in the middle
    const fx = 44;
    const fw = 72;
    ctx.fillStyle = COLORS['space.void'];
    ctx.fillRect(fx, 2, fw, H - 4);
    stars(ctx, 11, 26, W, H);
    ctx.strokeStyle = COLORS['ui.highlight'];
    ctx.globalAlpha = 0.55;
    ctx.strokeRect(fx + 0.5, 2.5, fw - 1, H - 5);
    ctx.globalAlpha = 1;
    // formation (zoomed sprites keep the real silhouettes)
    const z = 0.5;
    drawFrame(ctx, cache, cache.frame('enemy.commander', 'formation', 0), v, W / 2, 14, { zoom: z, glow: false });
    for (const dx of [-22, -11, 11, 22]) drawFrame(ctx, cache, cache.frame('enemy.interceptor', 'formation', 0), v, W / 2 + dx, 26, { zoom: z, glow: false });
    for (const dx of [-22, -11, 0, 11, 22]) drawFrame(ctx, cache, cache.frame('enemy.scout', 'formation', 0), v, W / 2 + dx, 37, { zoom: z, glow: false });
    // player bolt and fighter on the bottom line
    px(ctx, COLORS['shot.player.edge'], W / 2, 52, 1, 6);
    px(ctx, COLORS['shot.player.core'], W / 2, 53, 1, 3);
    drawFrame(ctx, cache, cache.frame('player.fighter', 'idle', 0), v, W / 2, 80, { zoom: 0.75, glow: false });
    // left / right only
    ctx.fillStyle = COLORS['ui.accent'];
    for (const [x, dir] of [
      [W / 2 - 22, -1],
      [W / 2 + 22, 1],
    ] as const) {
      for (let i = 0; i < 4; i++) ctx.fillRect(x + dir * i, 80 - (3 - i), 1, 1 + 2 * (3 - i));
    }
    // rail the fighter is locked to
    ctx.globalAlpha = 0.4;
    px(ctx, COLORS['ui.text.dim'], fx + 4, 90, fw - 8, 1);
    ctx.globalAlpha = 1;
  });
}

export function freeRoamArt(cache: SpriteCache): HTMLCanvasElement {
  const { width: W, height: H } = CARD_ART;
  return paintCanvas(W, H, (ctx, v: Viewport) => {
    ctx.fillStyle = COLORS['space.void'];
    ctx.fillRect(0, 0, W, H);
    stars(ctx, 29, 60, W, H);
    // ringed planet, top right (dithered shading, no gradients)
    const pcx = 128;
    const pcy = 24;
    for (let y = -11; y <= 11; y++) {
      for (let x = -11; x <= 11; x++) {
        if (x * x + y * y > 121) continue;
        const lit = x + y < -4 ? 'commander.hull.light' : x + y < 6 || (x + y) % 2 === 0 ? 'commander.hull.shade' : 'commander.hull.dark';
        px(ctx, COLORS[lit], pcx + x, pcy + y);
      }
    }
    ctx.fillStyle = COLORS['commander.gold'];
    for (let x = -20; x <= 20; x++) {
      const y = Math.round(x * 0.28);
      if (Math.abs(x) < 10 && y >= 0) continue; // ring passes behind the planet on the near side
      ctx.fillRect(pcx + x, pcy + y + 1, 1, 1);
    }
    // dotted flight path (curve) ending at the ship
    for (let t = 0; t <= 1; t += 0.035) {
      const x = 14 + t * 86;
      const y = 84 - Math.sin(t * Math.PI * 0.9) * 46 + t * 6;
      px(ctx, COLORS['ui.highlight'], x, y);
    }
    // survey beacons
    for (const [bx, by, charted] of [
      [30, 70, true],
      [58, 46, true],
      [140, 70, false],
    ] as const) {
      const c = charted ? COLORS['fx.cyan'] : COLORS['fx.yellow'];
      px(ctx, c, bx, by - 2, 1, 5);
      px(ctx, c, bx - 2, by, 5, 1);
      px(ctx, c, bx - 1, by - 1, 3, 3);
      px(ctx, COLORS['fx.white'], bx, by);
    }
    // the fighter banking right, with chevrons in four directions
    const sx = 104;
    const sy = 52;
    drawFrame(ctx, cache, cache.frame('player.fighter', 'idle', 0), v, sx, sy, { zoom: 0.75, rotation: Math.PI * 0.32, glow: false });
    ctx.fillStyle = COLORS['ui.accent'];
    const d = 19;
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(sx - 2 + i, sy - d - i, 5 - 2 * i, 1); // up
      ctx.fillRect(sx - 2 + i, sy + d + i, 5 - 2 * i, 1); // down
      ctx.fillRect(sx - d - i, sy - 2 + i, 1, 5 - 2 * i); // left
      ctx.fillRect(sx + d + i, sy - 2 + i, 1, 5 - 2 * i); // right
    }
  });
}
