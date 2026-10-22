/**
 * Draws the simulation world with the Stage 1 sprites plus the Stage 4
 * presentation layers. Read-only: never mutates the world. Positions are
 * interpolated between the previous and current tick with `alpha`.
 *
 * Layer order (bottom -> top):
 *   0 letterbox, margin field (dimmed stars / nebula outside the arena) and the arena edge
 *   1 void, backdrop (stars / planet / nebula / comet, warp)
 *   2 under-ship fx (trails, twinkles), tractor beams
 *   3 enemies, captives, player (+ exhaust), engine explosion sprites
 *   4 over-ship fx (debris, rings, score pop-ups)
 *   5a live phases:   flash, then PLAYER SHOTS, then ENEMY SHOTS (always on top)
 *   5b other phases:  shots, then flash / dim / fade, captions, title art
 * So during live attack no effect, flash or caption can hide an incoming
 * enemy projectile; overlays only cover the field when the engine is itself
 * in a non-interactive phase.
 */
import { ENGINE } from '../config/engine.ts';
import { COLORS } from '../config/palette.ts';
import { BACKDROP, TRANSITIONS } from '../config/presentation.ts';
import { ANIMATION_TIMING } from '../config/visual.ts';
import { SPRITES, type SpriteId, type VariantId } from '../assets/sprites/index.ts';
import type { Enemy, World } from '../core/game/types.ts';
import type { GamePhase } from '../core/game/stateMachine.ts';
import { marginSides, type SpaceBackdrop } from './backdrop.ts';
import { drawTractorBeam } from './beam.ts';
import type { FxDirector } from './fx/fxDirector.ts';
import { frameIndexAt, oneShotFrameAt } from './sprite/animation.ts';
import { drawFrame } from './sprite/drawSprite.ts';
import type { SpriteCache } from './sprite/spriteCache.ts';
import { drawPixelText } from './text.ts';
import type { TransitionFrame } from './transitions.ts';
import type { Viewport } from './viewport.ts';

export interface RenderState {
  /** Interpolation between previous and current tick (0..1). */
  readonly alpha: number;
  /** Presentation clock for sprite animation (ms, frozen while paused). */
  readonly timeMs: number;
  readonly phase: GamePhase;
  /** Phase the game returns to when paused. */
  readonly activePhase: GamePhase;
  readonly glow: boolean;
  /** 1 = full motion, lower with reduced motion. */
  readonly motion: number;
  readonly transition: TransitionFrame;
  /** Optional debug overlay (hitboxes). */
  readonly debug?: boolean;
  readonly hitboxes?: Readonly<Record<string, { w: number; h: number }>>;
}

export interface RenderDeps {
  readonly cache: SpriteCache;
  readonly backdrop: SpaceBackdrop;
  readonly fx?: FxDirector;
}

/** Draw-layer names, reported in order to an optional probe (tests). */
export type Layer = 'margins' | 'backdrop' | 'fxUnder' | 'beams' | 'enemies' | 'player' | 'explosions' | 'fxOver' | 'flash' | 'playerShots' | 'enemyShots' | 'dim' | 'fade' | 'captions' | 'title';

interface Draw {
  readonly ctx: CanvasRenderingContext2D;
  readonly cache: SpriteCache;
  readonly v: Viewport;
  readonly t: number;
  readonly glow: boolean;
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

function sprite(d: Draw, id: SpriteId, state: string, x: number, y: number, o: { variant?: VariantId | undefined; rotation?: number; frame?: number; alpha?: number } = {}): void {
  const def = SPRITES[id];
  const index = o.frame ?? frameIndexAt(def, state, d.t);
  const frame = d.cache.frame(id, state, index, o.variant);
  drawFrame(d.ctx, d.cache, frame, d.v, x, y, {
    glow: d.glow,
    ...(o.rotation !== undefined ? { rotation: o.rotation } : {}),
    ...(o.alpha !== undefined ? { alpha: o.alpha } : {}),
  });
}

/** Clockwise rotation for a down-facing sprite moving along (dx, dy). */
function headingRotation(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  return Math.atan2(-dx, dy);
}

function enemySprite(e: Enemy): { id: SpriteId; state: string; variant?: VariantId } {
  const flying = e.state !== 'inFormation';
  switch (e.kind) {
    case 'scout':
      return { id: 'enemy.scout', state: flying ? 'attack' : 'formation' };
    case 'interceptor':
      return { id: 'enemy.interceptor', state: flying ? 'attack' : 'formation' };
    case 'commander': {
      const damaged = e.hp < 2;
      return { id: 'enemy.commander', state: e.beam ? 'capture' : flying ? 'attack' : 'formation', ...(damaged ? { variant: 'damaged' as const } : {}) };
    }
    case 'transform':
      return { id: `special.${e.transformKind ?? 'stinger'}` as SpriteId, state: 'flight' };
    case 'capturedFighter':
      return { id: 'player.fighter', state: e.captiveMode === 'freed' ? 'rescued' : 'captured', variant: e.captiveMode === 'freed' ? 'rescued' : 'captive' };
  }
}

function fillField(ctx: CanvasRenderingContext2D, v: Viewport, color: string, alpha: number): void {
  if (alpha <= 0.003) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * Math.min(1, alpha);
  ctx.fillStyle = color;
  ctx.fillRect(v.offsetX, v.offsetY, Math.ceil(v.artWidth * v.scale), Math.ceil(v.artHeight * v.scale));
  ctx.globalAlpha = prev;
}

/** Player engine exhaust: a short flickering plume under each nozzle (pixel rows, no blur). */
function drawExhaust(ctx: CanvasRenderingContext2D, v: Viewport, x: number, y: number, t: number, motion: number): void {
  const flick = Math.floor(t / ANIMATION_TIMING.engineFlickerMs) % 3;
  const len = motion < 1 ? 2 : 2 + flick;
  const px = Math.max(1, Math.round(v.scale));
  const ax = Math.round(x);
  const ay = Math.round(y + 17);
  const prev = ctx.globalAlpha;
  for (let i = 0; i < len; i++) {
    ctx.fillStyle = i === 0 ? COLORS['player.engine.core'] : i < 2 ? COLORS['player.engine'] : COLORS['fx.orange'];
    const w = i < 2 ? 2 : 1;
    ctx.globalAlpha = prev * (i < 2 ? 0.9 : 0.55);
    ctx.fillRect(Math.round(v.offsetX + (ax - w / 2) * v.scale), Math.round(v.offsetY + (ay + i) * v.scale), Math.max(px, Math.round(w * v.scale)), px);
  }
  ctx.globalAlpha = prev;
}

/**
 * One art pixel of `space.edge` just outside the arena, on each side that has
 * a margin (TD-76). It sits outside the arena rect, so it never covers play.
 */
export function drawArenaEdge(ctx: CanvasRenderingContext2D, v: Viewport): void {
  const sides = marginSides(v);
  if (!sides.left && !sides.right && !sides.top && !sides.bottom) return;
  const px = Math.max(1, Math.round(v.scale));
  const aw = Math.ceil(v.artWidth * v.scale);
  const ah = Math.ceil(v.artHeight * v.scale);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * BACKDROP.margin.edgeAlpha;
  ctx.fillStyle = COLORS['space.edge'];
  // vertical rules run the arena's full height plus the corners where the horizontal rules meet them
  const top = v.offsetY - (sides.top ? px : 0);
  const height = ah + (sides.top ? px : 0) + (sides.bottom ? px : 0);
  if (sides.left) ctx.fillRect(v.offsetX - px, top, px, height);
  if (sides.right) ctx.fillRect(v.offsetX + aw, top, px, height);
  if (sides.top) ctx.fillRect(v.offsetX, v.offsetY - px, aw, px);
  if (sides.bottom) ctx.fillRect(v.offsetX, v.offsetY + ah, aw, px);
  ctx.globalAlpha = prev;
}

export function drawGame(ctx: CanvasRenderingContext2D, deps: RenderDeps, v: Viewport, world: World, rs: RenderState, probe?: (layer: Layer) => void): void {
  const { cache, backdrop, fx } = deps;
  const d: Draw = { ctx, cache, v, t: rs.timeMs, glow: rs.glow };
  const k = rs.alpha;
  const W = v.artWidth;
  const H = v.artHeight;
  const tr = rs.transition;
  const mark = probe ?? ((): void => undefined);

  ctx.fillStyle = COLORS['space.letterbox'];
  ctx.fillRect(0, 0, v.deviceWidth, v.deviceHeight);
  // margins (TD-76): the dimmed star field continues outside the arena, then a thin edge marks
  // where the arena ends. Both use the unshaken viewport: the frame never moves with screen shake.
  backdrop.drawMargins(ctx, v);
  drawArenaEdge(ctx, v);
  mark('margins');
  ctx.fillStyle = COLORS['space.void'];
  ctx.fillRect(v.offsetX, v.offsetY, Math.ceil(W * v.scale), Math.ceil(H * v.scale));
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.offsetX, v.offsetY, Math.ceil(W * v.scale), Math.ceil(H * v.scale));
  ctx.clip();
  backdrop.draw(ctx, v);
  mark('backdrop');

  const inTitle = rs.phase === 'title' || rs.phase === 'boot';
  if (inTitle) {
    drawTitle(d, rs, W, H, tr.titleAlpha);
    mark('title');
    fillField(ctx, v, COLORS[TRANSITIONS.fadeColor], tr.fade);
    mark('fade');
    ctx.restore();
    return;
  }

  // screen shake moves the world layers only (whole art px; never captions or shots' readability)
  const shake = fx?.shakeOffset() ?? { x: 0, y: 0 };
  const sv: Viewport = shake.x || shake.y ? { ...v, offsetX: v.offsetX + Math.round(shake.x * v.scale), offsetY: v.offsetY + Math.round(shake.y * v.scale) } : v;
  const ds: Draw = sv === v ? d : { ...d, v: sv };

  fx?.drawUnder(ctx, v);
  mark('fxUnder');

  /* beams (under ships) */
  for (const e of world.enemies) {
    if (!e.beam || e.beam.length <= 1 || e.state === 'destroyed') continue;
    drawTractorBeam(ctx, sv, {
      x: e.x,
      top: e.y + 12,
      length: e.beam.length,
      maxLength: e.beam.maxLength,
      phase: e.beam.phase,
      timeMs: rs.timeMs,
      grabHalfWidth: ENGINE.capture.captureHalfWidth,
      glow: rs.glow,
      motion: rs.motion,
    });
  }
  mark('beams');

  /* enemies */
  for (const e of world.enemies) {
    if (e.state === 'destroyed') continue;
    const x = lerp(e.prevX, e.x, k);
    const y = lerp(e.prevY, e.y, k);
    const s = enemySprite(e);
    const rotation = e.state === 'inFormation' || e.beam ? 0 : headingRotation(e.dirX, e.dirY);
    let variant = s.variant;
    if (e.hitFlashMs > 0 || (fx?.enemyFlash(e.id) && e.kind !== 'capturedFighter')) variant = 'flash';
    if (e.kind === 'capturedFighter' && e.captiveMode === 'freed' && Math.floor(rs.timeMs / ANIMATION_TIMING.rescueBlinkMs) % 2 === 1) variant = undefined;
    sprite(ds, s.id, s.state, x, y, { variant, rotation });
  }
  mark('enemies');

  /* player */
  const p = world.player;
  const px = lerp(p.prevX, p.x, k);
  const py = lerp(p.prevY, p.y, k);
  if (p.state === 'alive' && tr.playerVisible) {
    if (p.dual) {
      const o = ENGINE.player.dualHalfOffset;
      drawExhaust(ctx, sv, px - o, py, rs.timeMs, rs.motion);
      drawExhaust(ctx, sv, px + o, py, rs.timeMs + 35, rs.motion);
      sprite(ds, 'player.dual', 'idle', px, py);
    } else {
      drawExhaust(ctx, sv, px, py, rs.timeMs, rs.motion);
      sprite(ds, 'player.fighter', 'idle', px, py);
    }
  } else if (p.state === 'tractored') {
    sprite(ds, 'player.fighter', 'idle', px, py, { rotation: (rs.timeMs / 140) % (Math.PI * 2) });
  }
  mark('player');

  /* engine explosion sprites (world.effects) */
  for (const f of world.effects) {
    const id: SpriteId = f.kind === 'enemyExplosion' ? 'fx.explosion.enemy' : f.kind === 'playerExplosion' ? 'fx.explosion.player' : 'fx.hit';
    const state = f.kind === 'hitSpark' ? 'spark' : 'burst';
    const frame = oneShotFrameAt(SPRITES[id], state, f.ageMs);
    if (frame >= 0) sprite(ds, id, state, f.x, f.y, { frame });
  }
  mark('explosions');

  fx?.drawOver(ctx, v);
  mark('fxOver');

  const drawShots = (): void => {
    for (const s of world.playerShots) sprite(d, 'fx.shot.player', 'fly', lerp(s.prevX, s.x, k), lerp(s.prevY, s.y, k));
    mark('playerShots');
    // enemy shots are drawn after every effect in live play: nothing may hide them
    for (const s of world.enemyShots) sprite(d, 'fx.shot.enemy', 'fly', lerp(s.prevX, s.x, k), lerp(s.prevY, s.y, k));
    mark('enemyShots');
  };

  if (tr.live) {
    fx?.drawFlash(ctx, v);
    mark('flash');
    drawShots();
  } else {
    drawShots();
    fx?.drawFlash(ctx, v);
    mark('flash');
    fillField(ctx, v, COLORS['space.void'], tr.dim);
    mark('dim');
    drawCaptions(d, world, rs, W, H);
    mark('captions');
    if (tr.titleAlpha > 0) {
      drawTitle(d, rs, W, H, tr.titleAlpha);
      mark('title');
    }
    fillField(ctx, v, COLORS[TRANSITIONS.fadeColor], tr.fade);
    mark('fade');
  }

  if (rs.debug && rs.hitboxes) {
    ctx.strokeStyle = 'rgba(92,239,255,0.7)';
    ctx.lineWidth = 1;
    for (const e of world.enemies) {
      const b = rs.hitboxes[e.kind];
      if (b) ctx.strokeRect(v.offsetX + (e.x - b.w / 2) * v.scale, v.offsetY + (e.y - b.h / 2) * v.scale, b.w * v.scale, b.h * v.scale);
    }
  }
  ctx.restore();
}

/** READY + countdown bar and the stage banner rules (non-live phases only). */
function drawCaptions(d: Draw, world: World, rs: RenderState, W: number, H: number): void {
  const { ctx, v } = d;
  const tr = rs.transition;
  const px = Math.max(1, Math.round(v.scale));
  if (tr.banner > 0) {
    // two accent rules frame the HUD's stage title (drawn by the DOM HUD at 46 %)
    const half = Math.round(84 * tr.banner);
    const challenge = world.stageKind === 'challenge';
    ctx.fillStyle = challenge ? COLORS['ui.highlight'] : COLORS['ui.accent'];
    for (const y of [Math.round(H * 0.46) - 9, Math.round(H * 0.46) + 25]) {
      ctx.fillRect(Math.round(v.offsetX + (W / 2 - half) * v.scale), Math.round(v.offsetY + y * v.scale), Math.round(half * 2 * v.scale), px);
    }
  }
  if (tr.ready && world.player.state === 'alive' && rs.activePhase === 'ready') {
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * (tr.ready.pop < 0.5 ? 0.5 : 1);
    drawPixelText(ctx, v, 'READY', W / 2, H * 0.56, COLORS['ui.accent'], 2, 'center');
    ctx.globalAlpha = prev;
    // countdown bar: shrinks to the centre as play approaches
    const full = 60;
    const w = Math.round(full * tr.ready.remaining);
    const y = Math.round(H * 0.56) + 20;
    ctx.fillStyle = COLORS['ui.text.dim'];
    ctx.fillRect(Math.round(v.offsetX + (W / 2 - full / 2) * v.scale), Math.round(v.offsetY + y * v.scale), Math.round(full * v.scale), px);
    if (w > 0) {
      ctx.fillStyle = COLORS['ui.text'];
      ctx.fillRect(Math.round(v.offsetX + (W / 2 - w / 2) * v.scale), Math.round(v.offsetY + y * v.scale), Math.round(w * v.scale), px);
    }
  }
}

/**
 * Title art: the GALAXIA logo (banded pixel lettering with a drop shadow) and
 * the three archetypes in formation. Menus are DOM (ui/screens.ts) below it.
 */
function drawTitle(d: Draw, rs: RenderState, W: number, H: number, alpha: number): void {
  if (alpha <= 0) return;
  const { ctx, v } = d;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  const size = 5;
  const ly = Math.round(H * 0.17);
  drawPixelText(ctx, v, 'GALAXIA', W / 2, ly + 2, COLORS['interceptor.wing.shade'], size, 'center');
  drawPixelText(ctx, v, 'GALAXIA', W / 2, ly, COLORS['ui.accent'], size, 'center');
  // highlight band across the top of the letters (classic chrome banding)
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.offsetX, Math.round(v.offsetY + ly * v.scale), Math.ceil(W * v.scale), Math.round(size * 2 * v.scale));
  ctx.clip();
  drawPixelText(ctx, v, 'GALAXIA', W / 2, ly, COLORS['interceptor.wing.light'], size, 'center');
  ctx.restore();
  // thin rule under the logo
  ctx.fillStyle = COLORS['ui.highlight'];
  ctx.fillRect(Math.round(v.offsetX + (W / 2 - 96) * v.scale), Math.round(v.offsetY + (ly + 44) * v.scale), Math.round(192 * v.scale), Math.max(1, Math.round(v.scale)));
  // formation lineup with a gentle bob (none with reduced motion)
  const bob = rs.motion < 1 ? 0 : Math.round(Math.sin(rs.timeMs / 600) * 2);
  sprite(d, 'enemy.commander', 'formation', W / 2 - 64, H * 0.335 + bob, { alpha });
  sprite(d, 'enemy.interceptor', 'formation', W / 2, H * 0.335 - bob, { alpha });
  sprite(d, 'enemy.scout', 'formation', W / 2 + 64, H * 0.335 + bob, { alpha });
  drawExhaust(ctx, v, W / 2, H * 0.88, rs.timeMs, rs.motion);
  sprite(d, 'player.fighter', 'idle', W / 2, H * 0.88, { alpha });
  ctx.globalAlpha = prev;
}
