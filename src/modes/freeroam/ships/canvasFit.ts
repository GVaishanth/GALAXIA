/**
 * Canvas helpers shared by the hangar and armory panels (one copy: both draw
 * ship sprites into small DOM canvases at the device pixel ratio, capped 1..3).
 */
import type { SpriteId } from '../../../assets/sprites/index.ts';
import { FLEET_FLAME_ROWS } from '../../../assets/sprites/fleet.ts';
import { drawFrame } from '../../../render/sprite/drawSprite.ts';
import type { SpriteCache } from '../../../render/sprite/spriteCache.ts';
import type { Viewport } from '../../../render/viewport.ts';

/** A whole-canvas viewport at one art scale. */
export const viewport = (w: number, h: number, scale: number): Viewport => ({ scale, offsetX: 0, offsetY: 0, deviceWidth: w, deviceHeight: h, artWidth: w / scale, artHeight: h / scale });

const dpr = (): number => Math.min(Math.max(1, Math.round(window.devicePixelRatio || 1)), 3);

/** Size a canvas backing store to its CSS box (only touching width / height when they change). */
export function fitCanvas(c: HTMLCanvasElement, cssW: number, cssH: number): { w: number; h: number; ratio: number } {
  const ratio = dpr();
  const w = Math.max(1, Math.round(cssW * ratio));
  const h = Math.max(1, Math.round(cssH * ratio));
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return { w, h, ratio };
}

/** A ship's idle frame centred in a small card canvas (hangar cards and the armory's ship thumb). */
export function drawShipThumb(c: HTMLCanvasElement, sprites: SpriteCache, sprite: SpriteId, glow: boolean): void {
  const { w, h } = fitCanvas(c, c.clientWidth || 52, c.clientHeight || 52);
  const g = c.getContext('2d');
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  const fr = sprites.frame(sprite, 'idle', 0);
  // the idle frame carries blank flame rows above and below the hull: size the hull itself
  const scale = Math.max(1, Math.floor(Math.min(w / fr.raster.sprite.width, h / Math.max(1, fr.raster.sprite.height - 2 * FLEET_FLAME_ROWS))));
  drawFrame(g, sprites, fr, viewport(w, h, scale), w / 2 / scale, h / 2 / scale, { glow });
}
