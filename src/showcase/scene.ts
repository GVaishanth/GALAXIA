/**
 * Hangar demo scene: a scripted, time-driven tableau that puts every ship,
 * projectile and effect on the same background at true game scale.
 * This is choreography for visual validation only, NOT gameplay or enemy AI:
 * positions are pure functions of time, so the scene is deterministic.
 */
import { COLORS } from '../config/palette.ts';
import { ANIMATION_TIMING, PLAYFIELD_ART } from '../config/visual.ts';
import { SPRITES, type SpriteId, type VariantId } from '../assets/sprites/index.ts';
import { DUAL_FIGHTER_GAP } from '../assets/sprites/player.ts';
import { createRng } from '../core/rng.ts';
import { frameIndexAt, oneShotFrameAt } from '../render/sprite/animation.ts';
import { drawFrame } from '../render/sprite/drawSprite.ts';
import type { SpriteCache } from '../render/sprite/spriteCache.ts';
import type { Starfield } from '../render/starfield.ts';
import { drawPixelText } from '../render/text.ts';
import type { Viewport } from '../render/viewport.ts';

export interface SceneOptions {
  readonly glow: boolean;
  /** Starfield motion multiplier (reduced motion lowers it). */
  readonly motion: number;
  /** Draw the in-canvas title lines (off when a DOM HUD owns the top band). Default true. */
  readonly titles?: boolean;
}

interface Ctx {
  readonly ctx: CanvasRenderingContext2D;
  readonly cache: SpriteCache;
  readonly v: Viewport;
  readonly t: number;
  readonly glow: boolean;
}

type Vec = readonly [number, number];

const W = PLAYFIELD_ART.width;
const PITCH = 32;
const ROW_Y = { commander: 84, interceptorA: 118, interceptorB: 148, scoutA: 180, scoutB: 208 } as const;

function slotX(count: number, i: number, sway: number): number {
  return W / 2 + (i - (count - 1) / 2) * PITCH + sway;
}

function draw(c: Ctx, id: SpriteId, state: string, pos: Vec, opts: { variant?: VariantId; rotation?: number; frame?: number; alpha?: number } = {}): void {
  const def = SPRITES[id];
  const index = opts.frame ?? frameIndexAt(def, state, c.t);
  const frame = c.cache.frame(id, state, index, opts.variant);
  drawFrame(c.ctx, c.cache, frame, c.v, pos[0], pos[1], {
    glow: c.glow,
    ...(opts.rotation !== undefined ? { rotation: opts.rotation } : {}),
    ...(opts.alpha !== undefined ? { alpha: opts.alpha } : {}),
  });
}

/** Heading of a path at s (sprites face down, so rotate from +Y). */
function heading(path: (s: number) => Vec, s: number): number {
  const a = path(Math.max(0, s - 0.002));
  const b = path(Math.min(1, s + 0.002));
  return Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.PI / 2;
}

/** Loop out of the formation slot, then a swaying dive off the bottom. */
function diveLoop(home: Vec, dir: 1 | -1, sweep: number): (s: number) => Vec {
  const r = 26;
  return (s) => {
    if (s < 0.3) {
      const a = (s / 0.3) * Math.PI * 1.5;
      return [home[0] + dir * (r - r * Math.cos(a)), home[1] - r * Math.sin(a)];
    }
    const start: Vec = [home[0] + dir * r, home[1] + r];
    const q = (s - 0.3) / 0.7;
    return [start[0] + dir * Math.sin(q * Math.PI * 1.4) * sweep, start[1] + q * (PLAYFIELD_ART.height + 40 - start[1])];
  };
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  cache: SpriteCache,
  stars: Starfield,
  v: Viewport,
  t: number,
  options: SceneOptions,
): void {
  const c: Ctx = { ctx, cache, v, t, glow: options.glow };

  ctx.fillStyle = COLORS['space.letterbox'];
  ctx.fillRect(0, 0, v.deviceWidth, v.deviceHeight);
  ctx.fillStyle = COLORS['space.void'];
  ctx.fillRect(v.offsetX, v.offsetY, Math.ceil(v.artWidth * v.scale), Math.ceil(v.artHeight * v.scale));
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.offsetX, v.offsetY, Math.ceil(v.artWidth * v.scale), Math.ceil(v.artHeight * v.scale));
  ctx.clip();

  stars.draw(ctx, v, t, options.motion);

  if (options.titles !== false) {
    drawPixelText(ctx, v, 'GALAXIA', 12, 10, COLORS['ui.accent'], 2);
    drawPixelText(ctx, v, 'HANGAR / TRUE SCALE', W - 12, 14, COLORS['ui.text.dim'], 1, 'right');
  }

  const sway = Math.sin(t / 1700) * 14;

  /* Formation ------------------------------------------------------------ */
  const razorCycle = 6400;
  const razorP = (t % razorCycle) / razorCycle;
  const razorDiving = razorP > 0.1 && razorP < 0.92;
  const miteCycle = 5200;
  const miteP = ((t + 2100) % miteCycle) / miteCycle;
  const miteDiving = miteP > 0.1 && miteP < 0.92;

  for (let i = 0; i < 4; i++) {
    const pos: Vec = [slotX(4, i, sway), ROW_Y.commander];
    const flashing = i === 0 && t % 2000 < ANIMATION_TIMING.hitFlashMs * 2;
    draw(c, 'enemy.commander', 'formation', pos, { ...(i === 1 ? { variant: 'damaged' as const } : {}), ...(flashing ? { variant: 'flash' as const } : {}) });
    if (i === 0 && t % 2000 < 100) draw(c, 'fx.hit', 'spark', [pos[0] + 2, pos[1] + 8], { frame: t % 2000 < 50 ? 0 : 1 });
    if (i === 2) draw(c, 'player.fighter', 'captured', [pos[0], pos[1] - 30], { variant: 'captive' });
  }
  for (let i = 0; i < 8; i++) {
    if (!(i === 7 && razorDiving)) draw(c, 'enemy.interceptor', 'formation', [slotX(8, i, sway), ROW_Y.interceptorA]);
    draw(c, 'enemy.interceptor', 'formation', [slotX(8, i, sway), ROW_Y.interceptorB]);
  }
  for (let i = 0; i < 10; i++) {
    if (!(i === 0 && miteDiving)) draw(c, 'enemy.scout', 'formation', [slotX(10, i, sway), ROW_Y.scoutA]);
    draw(c, 'enemy.scout', 'formation', [slotX(10, i, sway), ROW_Y.scoutB]);
  }

  /* Divers (rotated sprites) --------------------------------------------- */
  if (razorDiving) {
    const s = (razorP - 0.1) / 0.82;
    const path = diveLoop([slotX(8, 7, sway), ROW_Y.interceptorA], -1, 80);
    draw(c, 'enemy.interceptor', 'attack', path(s), { rotation: heading(path, s) });
  }
  let miteSpark: Vec | null = null;
  if (miteDiving) {
    const s = (miteP - 0.1) / 0.82;
    const path = diveLoop([slotX(10, 0, sway), ROW_Y.scoutA], 1, 70);
    const pos = path(s);
    draw(c, 'enemy.scout', 'attack', pos, { rotation: heading(path, s) });
    if (s > 0.4 && s < 0.45) miteSpark = pos;
  }

  /* Special transform trio on a lissajous sweep ----------------------------- */
  // Rigid V (leader + two wings) so the three silhouettes never overlap.
  const trio: readonly [SpriteId, number, number][] = [
    ['special.sovereign', 0, 0],
    ['special.stinger', -36, -16],
    ['special.phantom', 36, -16],
  ];
  const trioPath = (s: number): Vec => [204 + Math.sin(s * Math.PI * 2) * 90, 270 + Math.sin(s * Math.PI * 4) * 18];
  const trioS = (t % 9000) / 9000;
  const trioCentre = trioPath(trioS);
  const trioTilt = Math.max(-0.35, Math.min(0.35, heading(trioPath, trioS) * 0.4));
  for (const [id, dx, dy] of trio) {
    const cos = Math.cos(trioTilt);
    const sin = Math.sin(trioTilt);
    draw(c, id, 'flight', [trioCentre[0] + dx * cos - dy * sin, trioCentre[1] + dx * sin + dy * cos], { rotation: trioTilt });
  }

  /* Warden capture with tractor beam ---------------------------------------- */
  const wardenPos: Vec = [384, 314];
  const wardenDef = SPRITES['enemy.commander'];
  const wardenFrame = cache.frame('enemy.commander', 'capture', frameIndexAt(wardenDef, 'capture', t));
  const wardenBottom = wardenPos[1] + wardenFrame.raster.contentHeight / 2;
  const beamPos: Vec = [wardenPos[0], wardenBottom + SPRITES['fx.beam.tractor'].states.active[0]!.rows.length / 2 - 2];
  draw(c, 'fx.beam.tractor', 'active', beamPos);
  draw(c, 'enemy.commander', 'capture', wardenPos);
  const lift = (t % 3200) / 3200;
  draw(c, 'player.fighter', 'idle', [wardenPos[0], 452 - lift * 96], {
    rotation: lift * Math.PI * 4,
    ...(lift > 0.85 ? { variant: 'captive' as const } : {}),
  });

  /* Rescued fighter returning (gold blink) ----------------------------------- */
  const rescueQ = (t % 4200) / 4200;
  const blinkOn = Math.floor(t / ANIMATION_TIMING.rescueBlinkMs) % 2 === 0;
  draw(c, 'player.fighter', 'rescued', [52, 300 + rescueQ * 190], blinkOn ? { variant: 'rescued' } : {});

  /* Player Dual Fighter, bolts ------------------------------------------------ */
  const playerX = (time: number): number => W / 2 + Math.sin(time / 1300) * 110;
  const playerY = 540;
  const half = (27 + DUAL_FIGHTER_GAP) / 2;
  const fireEvery = 340;
  for (let k = 0; k < 6; k++) {
    const tk = Math.floor(t / fireEvery) * fireEvery - k * fireEvery;
    if (tk < 0) continue;
    const age = t - tk;
    const y = playerY - 18 - age * 0.55;
    if (y < 30) continue;
    draw(c, 'fx.shot.player', 'fly', [playerX(tk) - half, y]);
    draw(c, 'fx.shot.player', 'fly', [playerX(tk) + half, y]);
  }
  draw(c, 'player.dual', 'idle', [playerX(t), playerY]);

  /* Enemy sparks raining from fixed lanes ------------------------------------- */
  for (let k = 0; k < 5; k++) {
    const cycle = 2600;
    const tt = (t + k * 520) % cycle;
    const lane = 96 + ((k * 61) % 240);
    draw(c, 'fx.shot.enemy', 'fly', [lane + Math.sin(k) * 10, 236 + tt * 0.13]);
  }
  if (miteSpark) draw(c, 'fx.shot.enemy', 'fly', [miteSpark[0], miteSpark[1] + 14]);

  /* Explosions: enemy burst + player breakup on staggered loops --------------- */
  const burstCycle = 1500;
  const burstIndex = Math.floor(t / burstCycle);
  const rng = createRng(burstIndex * 7919 + 13);
  const burstPos: Vec = [rng.range(110, 300), rng.range(300, 420)];
  const burstFrame = oneShotFrameAt(SPRITES['fx.explosion.enemy'], 'burst', t % burstCycle);
  if (burstFrame >= 0) draw(c, 'fx.explosion.enemy', 'burst', burstPos, { frame: burstFrame });
  const breakupFrame = oneShotFrameAt(SPRITES['fx.explosion.player'], 'burst', (t + 900) % 3000);
  if (breakupFrame >= 0) draw(c, 'fx.explosion.player', 'burst', [96, 470], { frame: breakupFrame });

  ctx.restore();
}
