/**
 * Local sector renderer (DOM / Canvas 2D). Draws a read-only SectorRun
 * through the follow camera with the shared sprite pipeline (SpriteCache +
 * drawFrame) for ships; everything else is procedural - no image files, no
 * external URLs.
 *
 * Layers, back to front:
 *   decoration   letterbox, sector void, a seeded parallax starfield (the only
 *                parallax: three far layers at 0.2 / 0.45 / 0.75), nebula tint,
 *                a faint survey grid;
 *   obstacles    stars (with their burn radius), bodies, asteroids - muted,
 *                solid shapes, never ringed;
 *   interactive  points of interest - bright, white-cored, with a dashed range
 *                ring and a label; completed ones turn grey with a check;
 *   combat       hazard zones, mines, warp-in markers, encounter markers and
 *                the cargo wreck (sector/combatRender.ts);
 *   loot         marked ore veins, floating pickups and the full-hold marker
 *                (sector/lootRender.ts, Prompt 10);
 *   ships        player bolts, enemy ships with their telegraphs, beams and
 *                projectiles (combatRender.ts), the player (interpolated),
 *                short destruction bursts;
 *   UI           objective arrow, mouse-aim reticle, touch stick (device px).
 * World -> screen uses the camera's CameraView (camera.ts worldToScreen, the
 * same transform the shell inverts for clicks and touches). The engine flame
 * sits behind the nose and scales with the thrust along it; sideways or
 * reverse thrust shows small manoeuvring puffs instead (FR-TD-41).
 * drawSectorMap draws the whole sector, scaled to fit, for the map overlay.
 * Everything that matters for navigation is drawn at parallax 1, so what the
 * pilot sees is exactly where it collides or triggers.
 *
 * SectorArt is the per-sector rendering cache (rock outlines as Path2D,
 * nebula textures as small offscreen canvases). It is built when a sector is
 * entered and disposed when the pilot leaves it, so only the active sector
 * ever holds rendering resources.
 */
import { COLORS, type ColorRole } from '../../../config/palette.ts';
import { drawFrame } from '../../../render/sprite/drawSprite.ts';
import type { SpriteCache } from '../../../render/sprite/spriteCache.ts';
import type { Viewport } from '../../../render/viewport.ts';
import type { CameraView } from '../camera.ts';
import { noseOf } from '../sim.ts';
import type { Landmark, Poi, Rock, SectorLayout } from './model.ts';
import { drawCombatMap, drawCombatShips, drawCombatWorld, drawPlayerMissiles, drawShipLock, drawShipLockMarker, drawThreatMarkers, type CombatView } from './combatRender.ts';
import { drawLootMap, drawLootWorld } from './lootRender.ts';
import { drawFieldRings, drawPullArrow } from './gravityRender.ts';
import { isDone, objectiveOf, RUN, type SectorRun } from './run.ts';
import { openBearings, ringRadius, signalPoint, signalProgress } from './signal.ts';
import { SPRITES, type SpriteId } from '../../../assets/sprites/index.ts';
import { ANIMATION_TIMING } from '../../../config/visual.ts';

export interface StickOverlay {
  readonly active: boolean;
  /** Device px. */
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly radius: number;
}

export interface RenderOptions {
  readonly alpha: number;
  readonly timeMs: number;
  readonly glow: boolean;
  readonly reducedMotion: boolean;
  /** Device px per CSS px (for UI-sized overlay elements). */
  readonly ratio: number;
  readonly stick: StickOverlay | null;
  /** Mouse-aim reticle (world point), or null. */
  readonly aim?: { readonly x: number; readonly y: number } | null | undefined;
  /** Short destruction bursts (presentation only, owned and capped by the shell). */
  readonly bursts?: readonly Burst[] | undefined;
  /** Combat P03C: detonation shockwaves (presentation only, owned and capped by the shell). */
  readonly waves?: readonly Shockwave[] | undefined;
  /** Destroyed-ship breakups (Prompt 8; owned and capped by the shell). */
  readonly wrecks?: readonly Wreck[] | undefined;
  /** Prompt 12: arrival in a sector (frame-clock ms), drawn as a widening ring around the ship. */
  readonly arrivalMs?: number | null | undefined;
}

/** Arrival ring lifetime (ms); presentation only, skipped under reduced motion. */
export const ARRIVAL_MS = 650;

/** A destroyed player ship: its sprite splits into four drifting quadrants over an explosion. */
export interface Wreck {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly sprite: SpriteId;
  readonly startMs: number;
}
/** Wreck lifetime (ms). */
export const WRECK_MS = 900;
/** Hull fraction below which the ship shows scorch marks and sparks. */
export const HULL_DAMAGED = 0.35;

/** A destruction burst: world position, start time and size (1 small .. 4 capital). */
export interface Burst {
  readonly x: number;
  readonly y: number;
  readonly startMs: number;
  readonly size: 1 | 2 | 3 | 4;
}
/** Burst lifetime (ms). */
export const BURST_MS = 420;

/**
 * A detonation shockwave (Combat P03C): a ring expanding to the blast radius
 * over `ms` (the catalogue's `effect.ringTicks`); the nuke adds a second,
 * trailing ring. Never a full-screen flash.
 */
export interface Shockwave {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly startMs: number;
  readonly ms: number;
  readonly double: boolean;
}
/** Overheat rattle (FR-TD-79): peak jitter in CSS px, fading to nothing over `ms`. Never with reduced motion. */
export const SHAKE = Object.freeze({ px: 5, ms: 900 });

/** Sector art colours (interactive = saturated, obstacles = muted, decoration = dim). */
const ART = Object.freeze({
  star: { yellow: '#ffe08a', orange: '#ffb35c', red: '#ff7a5c', blue: '#9cc8ff', white: '#f2f6ff', neutron: '#c8f0ff', 'black-hole': '#000000', protostar: '#ff9ec2', 'anomaly-core': '#d68cff', dim: '#b0a090' } as Record<string, string>,
  body: { rocky: ['#7d6f66', '#4e4440'], ice: ['#a9c4d4', '#5f7a8c'], gas: ['#c9a27a', '#7a5a44'], molten: ['#c2563a', '#5e2418'] } as Record<string, [string, string]>,
  rock: '#5c5650',
  rockEdge: '#2a2724',
  nebula: { dust: '#8a6a4a', 'ion-storm': '#4a7aff', radiation: '#7aff6a', flare: '#ff8a3a', 'gravity-shear': '#b06aff', none: '#5a4a8a' } as Record<string, string>,
  label: '#8d96b8',
  done: '#5a6378',
  poi: { survey: '#ffd23f', salvage: '#6cf2c2', derelict: '#ff9440', cache: '#ffcf4a', anomaly: '#e46bff', station: '#5cefff', installation: '#ff4f5e', gate: '#7dff8a', exit: '#7dff8a' } as Record<string, string>,
  sealed: '#ff6b6b',
  dormant: '#5a6378',
});

const STAR_LAYERS = [
  { factor: 0.2, cell: 180, roles: ['star.dim', 'star.dim', 'star.cool'] as ColorRole[], size: 1 },
  { factor: 0.45, cell: 220, roles: ['star.dim', 'star.mid', 'star.warm'] as ColorRole[], size: 1 },
  { factor: 0.75, cell: 260, roles: ['star.mid', 'star.bright', 'star.cool'] as ColorRole[], size: 2 },
] as const;
const STARS_PER_CELL = 3;
const GRID = 400;
/** Visual radius of a jump gate ring (art px). */
const GATE_RADIUS = 36;

/** Integer hash -> [0, 1). Deterministic per (a, b, c); decoration only. */
function hash01(a: number, b: number, c: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Outline vertex bounds for an asteroid (decoration only; collision uses the circle). */
export const ROCK_VERTICES = Object.freeze({ min: 7, max: 10 });

/**
 * Flat [x0, y0, x1, y1, ...] outline for one asteroid. `rock.shape` is an
 * integer seed (0..0xffff), so it is hashed, never used as a fraction: using
 * it directly once produced ~10^5 vertices per rock and exhausted WebKit's
 * memory on rock-heavy sectors.
 */
export function rockOutline(rock: Rock): number[] {
  const span = ROCK_VERTICES.max - ROCK_VERTICES.min + 1;
  const n = ROCK_VERTICES.min + Math.min(span - 1, Math.floor(hash01(rock.shape, 0, 7) * span));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 0.78 + 0.22 * hash01(rock.shape, i + 1, 3);
    out.push(rock.x + Math.cos(a) * rock.r * k, rock.y + Math.sin(a) * rock.r * k);
  }
  return out;
}

/* -------------------------------------------------------------- art cache */

export class SectorArt {
  readonly systemId: string;
  private rocks: Path2D[] = [];
  private clouds = new Map<string, HTMLCanvasElement>();
  private released = false;

  constructor(layout: SectorLayout) {
    this.systemId = layout.systemId;
    // rock outlines: 7..10 jittered vertices seeded by the rock's shape value
    for (const r of layout.rocks) {
      const p = new Path2D();
      const pts = rockOutline(r);
      for (let i = 0; i < pts.length; i += 2) {
        if (i === 0) p.moveTo(pts[0]!, pts[1]!);
        else p.lineTo(pts[i]!, pts[i + 1]!);
      }
      p.closePath();
      this.rocks.push(p);
    }
    // nebula textures: soft lumpy blobs at 96 px, scaled up with smoothing when drawn
    for (const g of layout.regions) {
      if (g.kind !== 'nebula') continue;
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 96;
      const x = c.getContext('2d');
      if (!x) continue;
      const col = ART.nebula[g.effect] ?? ART.nebula['none']!;
      const seed = Math.floor(g.x * 7 + g.y * 13);
      for (let i = 0; i < 14; i++) {
        const a = hash01(seed, i, 1) * Math.PI * 2;
        const d = hash01(seed, i, 2) * 26;
        const r = 14 + hash01(seed, i, 3) * 20;
        const cx = 48 + Math.cos(a) * d;
        const cy = 48 + Math.sin(a) * d;
        const grad = x.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, `${col}55`);
        grad.addColorStop(1, `${col}00`);
        x.fillStyle = grad;
        x.fillRect(0, 0, 96, 96);
      }
      this.clouds.set(g.id, c);
    }
  }

  rockPaths(): readonly Path2D[] {
    return this.rocks;
  }

  cloud(id: string): HTMLCanvasElement | undefined {
    return this.clouds.get(id);
  }

  /** Rendering resources held (rock paths + cloud canvases), for diagnostics. */
  get resources(): number {
    return this.rocks.length + this.clouds.size;
  }

  get disposed(): boolean {
    return this.released;
  }

  dispose(): void {
    for (const c of this.clouds.values()) {
      c.width = 0; // release the backing store now rather than at GC
      c.height = 0;
    }
    this.clouds.clear();
    this.rocks = [];
    this.released = true;
  }
}

/* ------------------------------------------------------------------- draw */

export function drawSector(ctx: CanvasRenderingContext2D, sprites: SpriteCache, art: SectorArt, run: SectorRun, view: CameraView, o: RenderOptions): void {
  const L = run.layout;
  const W = view.width;
  const H = view.height;
  const zoom = view.zoom;
  const cam = view;
  // identical to camera.ts worldToScreen (inlined: called thousands of times per frame)
  const cx = W / 2 - cam.x * zoom;
  const cy = H / 2 - cam.y * zoom;
  const toX = (x: number): number => cx + x * zoom;
  const toY = (y: number): number => cy + y * zoom;
  const viewR = Math.hypot(W, H) / zoom / 2;
  const visible = (x: number, y: number, r: number): boolean => Math.abs(x - cam.x) < viewR + r && Math.abs(y - cam.y) < viewR + r;
  const px = (n: number): number => Math.max(1, Math.round(n * zoom));
  const t = o.reducedMotion ? 0 : o.timeMs;

  /* decoration ---------------------------------------------------------- */
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS['space.letterbox'];
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = COLORS['space.void'];
  ctx.fillRect(Math.round(toX(0)), Math.round(toY(0)), Math.round(L.width * zoom), Math.round(L.height * zoom));

  for (let li = 0; li < STAR_LAYERS.length; li++) {
    const S = STAR_LAYERS[li]!;
    const ox = cam.x * S.factor;
    const oy = cam.y * S.factor;
    const halfW = W / zoom / 2;
    const halfH = H / zoom / 2;
    const c0 = Math.floor((ox - halfW) / S.cell);
    const c1 = Math.floor((ox + halfW) / S.cell);
    const r0 = Math.floor((oy - halfH) / S.cell);
    const r1 = Math.floor((oy + halfH) / S.cell);
    const size = Math.max(1, Math.round((S.size * zoom) / 2));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (let i = 0; i < STARS_PER_CELL; i++) {
          const sx = (c + hash01(c, r, li * 16 + i + L.seed)) * S.cell;
          const sy = (r + hash01(r, c, li * 16 + i + 7 + L.seed)) * S.cell;
          ctx.fillStyle = COLORS[S.roles[i % S.roles.length]!];
          ctx.fillRect(Math.round(W / 2 + (sx - ox) * zoom), Math.round(H / 2 + (sy - oy) * zoom), size, size);
        }
      }
    }
  }

  // nebula and dust clouds (hazard regions: drawn exactly where they act)
  ctx.imageSmoothingEnabled = true;
  for (const g of L.regions) {
    if (g.kind !== 'nebula' || !visible(g.x, g.y, g.r)) continue;
    const tex = art.cloud(g.id);
    if (tex) ctx.drawImage(tex, toX(g.x - g.r * 1.15), toY(g.y - g.r * 1.15), g.r * 2.3 * zoom, g.r * 2.3 * zoom);
    if (g.effect !== 'none') {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = ART.nebula[g.effect] ?? ART.label;
      ctx.lineWidth = px(1);
      ctx.setLineDash([px(3), px(9)]);
      ctx.beginPath();
      ctx.arc(toX(g.x), toY(g.y), g.r * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }
  ctx.imageSmoothingEnabled = false;

  ctx.globalAlpha = 0.14;
  ctx.fillStyle = COLORS['star.dim'];
  const line = Math.max(1, Math.round(zoom / 2));
  for (let gx = GRID; gx < L.width; gx += GRID) ctx.fillRect(Math.round(toX(gx)), Math.round(toY(0)), line, Math.round(L.height * zoom));
  for (let gy = GRID; gy < L.height; gy += GRID) ctx.fillRect(Math.round(toX(0)), Math.round(toY(gy)), Math.round(L.width * zoom), line);
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = COLORS['ui.highlight'];
  ctx.lineWidth = px(1);
  ctx.strokeRect(Math.round(toX(0)), Math.round(toY(0)), Math.round(L.width * zoom), Math.round(L.height * zoom));
  ctx.globalAlpha = 1;

  /* obstacles ------------------------------------------------------------ */
  for (const l of L.landmarks) if (visible(l.x, l.y, Math.max(l.r, l.hazardR))) drawLandmark(ctx, l, toX(l.x), toY(l.y), zoom, t);
  drawFieldRings(ctx, run, toX, toY, zoom, visible); // FR-TD-86

  ctx.setTransform(zoom, 0, 0, zoom, cx, cy);
  ctx.fillStyle = ART.rock;
  ctx.strokeStyle = ART.rockEdge;
  ctx.lineWidth = 2;
  const paths = art.rockPaths();
  for (let i = 0; i < L.rocks.length; i++) {
    const r = L.rocks[i]!;
    const p = paths[i];
    if (!p || !visible(r.x, r.y, r.r)) continue;
    ctx.fill(p);
    ctx.stroke(p);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // landmark labels (dim, decoration)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `${Math.round(10 * o.ratio)}px system-ui, sans-serif`;
  for (const l of L.landmarks) {
    if (!visible(l.x, l.y, l.r)) continue;
    ctx.fillStyle = ART.label;
    ctx.globalAlpha = 0.75;
    ctx.fillText(l.label, toX(l.x), toY(l.y + l.r) + 6 * o.ratio);
  }
  ctx.globalAlpha = 1;

  /* interactive ------------------------------------------------------------ */
  const A = L.arrival;
  if (visible(A.x, A.y, A.r)) {
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = ART.poi['exit']!;
    ctx.lineWidth = px(1);
    ctx.setLineDash([px(6), px(10)]);
    ctx.beginPath();
    ctx.arc(toX(A.x), toY(A.y), A.r * zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  const pulse = o.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(o.timeMs / 260);
  // P06.2 signal traces: the uncertainty ring around an unresolved marker and each RECORDED (noisy) bearing
  // from where it was taken; never the hidden source (sector/signal.ts keeps it private)
  const ring = ringRadius(run.craft.stats.sensor);
  ctx.strokeStyle = ART.poi['anomaly']!;
  ctx.lineWidth = px(1);
  for (const p of L.pois) {
    const bs = p.kind === 'anomaly' && run.revealed.has(p.id) ? openBearings(run, p) : null;
    if (!bs || (!bs.length && Math.hypot(run.ship.x - p.x, run.ship.y - p.y) > run.craft.stats.sensor)) continue;
    ctx.globalAlpha = 0.3;
    ctx.setLineDash([px(4), px(8)]);
    ctx.beginPath();
    ctx.arc(toX(p.x), toY(p.y), ring * zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.65;
    for (const b of bs) {
      const len = Math.hypot(p.x - b.x, p.y - b.y) + ring;
      ctx.beginPath();
      ctx.moveTo(toX(b.x), toY(b.y));
      ctx.lineTo(toX(b.x + Math.cos(b.angle) * len), toY(b.y + Math.sin(b.angle) * len));
      ctx.stroke();
      disc(ctx, toX(b.x), toY(b.y), px(3), ART.poi['anomaly']!);
    }
  }
  ctx.globalAlpha = 1;
  for (const p of L.pois) {
    // P06.1: a resolved anomaly signal is drawn (and investigated) at its fix
    const at = p.kind === 'anomaly' ? signalPoint(run, p) : p;
    if (!visible(at.x, at.y, Math.max(p.r, p.alertR))) continue;
    drawPoi(ctx, run, p, toX(at.x), toY(at.y), zoom, pulse, t, o.ratio);
  }

  /* ships ------------------------------------------------------------------- */
  const k = o.alpha;
  const v: Viewport = { scale: zoom, offsetX: cx, offsetY: cy, deviceWidth: W, deviceHeight: H, artWidth: W / zoom, artHeight: H / zoom };
  const V: CombatView = { toX, toY, zoom, ratio: o.ratio, W, H, v, visible, alpha: k, timeMs: o.timeMs, glow: o.glow, reducedMotion: o.reducedMotion };
  drawLootWorld(ctx, run, V);
  drawCombatWorld(ctx, run, V);
  // player bolts: a short streak along their (fixed) flight direction
  if (run.shots.length > 0) {
    ctx.lineCap = 'round';
    for (const s of run.shots) {
      const bx = s.px + (s.x - s.px) * k;
      const by = s.py + (s.y - s.py) * k;
      if (!visible(bx, by, 20)) continue;
      const sp = Math.hypot(s.vx, s.vy) || 1;
      const tx = bx - (s.vx / sp) * 11;
      const ty = by - (s.vy / sp) * 11;
      ctx.strokeStyle = COLORS['shot.player.edge'];
      ctx.lineWidth = px(4);
      ctx.beginPath();
      ctx.moveTo(toX(tx), toY(ty));
      ctx.lineTo(toX(bx), toY(by));
      ctx.stroke();
      ctx.strokeStyle = COLORS['shot.player.core'];
      ctx.lineWidth = px(2);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }
  drawPlayerMissiles(ctx, run, V); // under ships and enemy fire (Combat P03)
  drawShipLock(ctx, run, V); // P04.1 target brackets, under ships and every shot
  drawCombatShips(ctx, sprites, run, V);
  for (const w of o.waves ?? []) {
    const age = (o.timeMs - w.startMs) / w.ms;
    if (age < 0 || age >= 1 || !visible(w.x, w.y, w.r)) continue;
    const grow = o.reducedMotion ? 1 : 1 - (1 - age) * (1 - age); // ease-out; reduced motion: the full ring, fading
    for (let ring = 0; ring < (w.double ? 2 : 1); ring++) {
      const g = ring === 0 ? grow : Math.max(0, grow - 0.25) / 0.75;
      if (g <= 0) continue;
      ctx.globalAlpha = (1 - age) * (ring === 0 ? 0.9 : 0.55);
      ctx.strokeStyle = ring === 0 ? COLORS['fx.orange'] : COLORS['fx.yellow'];
      ctx.lineWidth = px(ring === 0 ? 3 : 2);
      ctx.beginPath();
      ctx.arc(toX(w.x), toY(w.y), Math.max(2, w.r * g * zoom), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.18 * (1 - age);
    disc(ctx, toX(w.x), toY(w.y), w.r * grow * zoom, COLORS['fx.orange']);
    ctx.globalAlpha = 1;
  }
  for (const b of o.bursts ?? []) {
    const age = (o.timeMs - b.startMs) / BURST_MS;
    if (age < 0 || age >= 1 || !visible(b.x, b.y, 60)) continue;
    const grow = o.reducedMotion ? 0.6 : age;
    const r = (10 + b.size * 8) * (0.4 + grow) * zoom;
    ctx.globalAlpha = 1 - age;
    disc(ctx, toX(b.x), toY(b.y), r * 0.45, COLORS['fx.yellow']);
    ctx.strokeStyle = COLORS['fx.orange'];
    ctx.lineWidth = px(2);
    ctx.beginPath();
    ctx.arc(toX(b.x), toY(b.y), r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const sh = run.ship;
  const sx = sh.px + (sh.x - sh.px) * k;
  const sy = sh.py + (sh.y - sh.py) * k;
  const heading = sh.pheading + (sh.heading - sh.pheading) * k;
  const tune = run.tune;
  const n = noseOf(heading);
  const along = sh.thrusting ? sh.thrustX * n.x + sh.thrustY * n.y : 0;
  if (sh.thrusting) {
    // manoeuvring puffs: opposite the sideways / reverse thrust (the main engine is part of the ship sprite)
    const side = sh.thrustX * -n.y + sh.thrustY * n.x;
    const puff = (dx: number, dy: number): void => {
      const s = Math.max(1, Math.round(2 * zoom));
      ctx.fillStyle = COLORS['player.engine.core'];
      ctx.globalAlpha = 0.7;
      ctx.fillRect(Math.round(toX(sx + dx) - s / 2), Math.round(toY(sy + dy) - s / 2), s, s);
      ctx.globalAlpha = 1;
    };
    if (Math.abs(side) > 0.3) puff(n.y * Math.sign(side) * tune.radius, -n.x * Math.sign(side) * tune.radius);
    if (along < -0.3) puff(n.x * (tune.radius + 2), n.y * (tune.radius + 2));
  }
  const stats = run.craft.stats;
  const damaged = run.hull < stats.hull * HULL_DAMAGED;
  // state: boost > engine (forward thrust) > idle; two-frame flame flicker (steady with reduced motion)
  const state = run.boost > 0.25 ? 'boost' : along > 0.15 ? 'thrust' : 'idle';
  const fi = state === 'idle' || o.reducedMotion ? 0 : Math.floor(o.timeMs / 90) % 2;
  // invulnerability after a hit: blink (steady half alpha with reduced motion)
  const alpha = run.invuln > 0 ? (o.reducedMotion ? 0.55 : Math.floor(o.timeMs / 80) % 2 ? 0.35 : 1) : 1;
  drawPullArrow(ctx, run, sx, sy, toX, toY, zoom); // FR-TD-86: under the hull sprite
  drawFrame(ctx, sprites, sprites.frame(run.craft.sprite, state, fi, damaged ? 'scorched' : undefined), v, sx, sy, { rotation: heading, glow: o.glow, alpha });
  ctx.globalAlpha = 1;
  if (damaged && !o.reducedMotion) {
    // hull breach: short sparks flicker over the hull (presentation only, time-seeded)
    const slot = Math.floor(o.timeMs / 110);
    for (let i = 0; i < 2; i++) {
      const hsh = Math.sin((slot + i * 7.3) * 12.9898) * 43758.5453;
      const f = hsh - Math.floor(hsh);
      if (f > 0.55) continue;
      const a = f * 11.4;
      const d = tune.radius * (0.25 + 0.5 * ((f * 7) % 1));
      const s = Math.max(1, Math.round(1.5 * zoom));
      ctx.fillStyle = i ? COLORS['fx.yellow'] : COLORS['fx.white'];
      ctx.fillRect(Math.round(toX(sx + Math.cos(a) * d) - s / 2), Math.round(toY(sy + Math.sin(a) * d) - s / 2), s, s);
    }
  }
  if (run.shield < stats.shield) {
    // shield arc around the ship: shrinks as the shield drains
    ctx.strokeStyle = run.shield > stats.shield * 0.35 ? COLORS['player.light'] : ART.sealed;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = px(1.5);
    ctx.beginPath();
    ctx.arc(toX(sx), toY(sy), (tune.radius + 7) * zoom, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * run.shield) / Math.max(1, stats.shield));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const obs = signalProgress(run);
  if (obs > 0) {
    // P06.2: the bearing being held fills a ring around the ship (sim ticks; gone the moment it breaks)
    ctx.strokeStyle = ART.poi['anomaly']!;
    ctx.lineWidth = px(2);
    ctx.beginPath();
    ctx.arc(toX(sx), toY(sy), (tune.radius + 12) * zoom, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * obs);
    ctx.stroke();
  }
  if (run.shieldHit && run.tick - run.shieldHit.tick < RUN.shieldFlareTicks) {
    // shield impact: a flare on the struck side, facing the hit
    const age = (run.tick - run.shieldHit.tick) / RUN.shieldFlareTicks;
    const a = run.shieldHit.angle;
    const d = tune.radius + 4;
    const fr = Math.min(2, Math.floor(age * 3));
    drawFrame(ctx, sprites, sprites.frame('fx.shield.impact', 'flare', fr), v, sx + Math.cos(a) * d, sy + Math.sin(a) * d, { rotation: a + Math.PI / 2, glow: o.glow, alpha: 1 - age * 0.6, zoom: Math.max(1, tune.radius / 12) });
    ctx.globalAlpha = 1;
  }
  for (const w of o.wrecks ?? []) drawWreck(ctx, sprites, v, w, o.timeMs, o.reducedMotion, o.glow, toX, toY, zoom);
  if (o.arrivalMs != null && !o.reducedMotion) {
    // arrival: two thin rings widen and fade around the ship (no flash, no fill)
    const t = (o.timeMs - o.arrivalMs) / ARRIVAL_MS;
    if (t >= 0 && t < 1) {
      ctx.save();
      ctx.strokeStyle = COLORS['player.light'];
      ctx.lineWidth = px(1.5);
      for (const lag of [0, 0.25]) {
        const k = Math.max(0, Math.min(1, (t - lag) / (1 - lag)));
        if (k <= 0) continue;
        ctx.globalAlpha = 0.7 * (1 - k);
        ctx.beginPath();
        ctx.arc(toX(sx), toY(sy), (tune.radius + 6 + 70 * k * (2 - k)) * zoom, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* UI ---------------------------------------------------------------------- */
  const target = objectiveOf(run);
  if (target) {
    const tx = toX(target.x);
    const ty = toY(target.y);
    const inset = 28 * o.ratio;
    if (tx < inset || ty < inset || tx > W - inset || ty > H - inset) {
      const ang = Math.atan2(ty - H / 2, tx - W / 2);
      const ex = W / 2 + Math.cos(ang) * (W / 2 - inset);
      const ey = H / 2 + Math.sin(ang) * (H / 2 - inset);
      const ax = Math.max(inset, Math.min(W - inset, ex));
      const ay = Math.max(inset, Math.min(H - inset, ey));
      const s = 9 * o.ratio;
      ctx.save();
      ctx.translate(Math.round(ax), Math.round(ay));
      ctx.rotate(ang);
      ctx.fillStyle = target.kind === 'survey' ? ART.poi['survey']! : ART.poi['exit']!;
      ctx.beginPath();
      ctx.moveTo(s, 0);
      ctx.lineTo(-s * 0.7, -s * 0.75);
      ctx.lineTo(-s * 0.35, 0);
      ctx.lineTo(-s * 0.7, s * 0.75);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  drawThreatMarkers(ctx, run, V);
  drawShipLockMarker(ctx, run, V); // P04.1: the locked ship, when off screen

  if (o.aim) {
    // mouse-aim reticle (device px sized)
    const ax = toX(o.aim.x);
    const ay = toY(o.aim.y);
    const r = 7 * o.ratio;
    ctx.strokeStyle = COLORS['ui.highlight'];
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = Math.max(1, Math.round(1.5 * o.ratio));
    ctx.beginPath();
    ctx.arc(ax, ay, r, 0, Math.PI * 2);
    ctx.moveTo(ax - r * 1.7, ay);
    ctx.lineTo(ax - r * 0.6, ay);
    ctx.moveTo(ax + r * 0.6, ay);
    ctx.lineTo(ax + r * 1.7, ay);
    ctx.moveTo(ax, ay - r * 1.7);
    ctx.lineTo(ax, ay - r * 0.6);
    ctx.moveTo(ax, ay + r * 0.6);
    ctx.lineTo(ax, ay + r * 1.7);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const st = o.stick;
  if (st && st.active) {
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = COLORS['ui.highlight'];
    ctx.lineWidth = Math.max(1, Math.round(1.5 * o.ratio));
    ctx.beginPath();
    ctx.arc(st.x, st.y, st.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = COLORS['ui.highlight'];
    ctx.beginPath();
    ctx.arc(st.x + st.vx * st.radius, st.y + st.vy * st.radius, st.radius * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/**
 * The sector map overlay: the whole sector scaled to fit a w x h (device px)
 * canvas. Rocks are dots, stars and bodies discs, points of interest marked
 * by kind (completed ones grey), the ship an arrow along its nose.
 */
export function drawSectorMap(ctx: CanvasRenderingContext2D, w: number, h: number, run: SectorRun, ratio: number): void {
  const L = run.layout;
  const pad = 10 * ratio;
  const scale = Math.min((w - pad * 2) / L.width, (h - pad * 2) / L.height);
  const ox = (w - L.width * scale) / 2;
  const oy = (h - L.height * scale) / 2;
  const X = (x: number): number => ox + x * scale;
  const Y = (y: number): number => oy + y * scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS['space.letterbox'];
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = COLORS['space.void'];
  ctx.fillRect(Math.round(X(0)), Math.round(Y(0)), Math.round(L.width * scale), Math.round(L.height * scale));
  ctx.strokeStyle = ART.dormant;
  ctx.lineWidth = Math.max(1, Math.round(ratio));
  ctx.strokeRect(Math.round(X(0)) + 0.5, Math.round(Y(0)) + 0.5, Math.round(L.width * scale) - 1, Math.round(L.height * scale) - 1);
  for (const l of L.landmarks) disc(ctx, X(l.x), Y(l.y), Math.max(2 * ratio, l.r * scale), l.kind === 'star' ? (ART.star[l.style] ?? ART.star['yellow']!) : (ART.body[l.style]?.[0] ?? ART.rock));
  ctx.fillStyle = ART.rock;
  for (const k of L.rocks) {
    const r = Math.max(1, k.r * scale);
    ctx.fillRect(Math.round(X(k.x) - r / 2), Math.round(Y(k.y) - r / 2), Math.ceil(r), Math.ceil(r));
  }
  ctx.font = `${Math.round(10 * ratio)}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const p of L.pois) {
    // sensors (Prompt 8): only what the ship has picked up is charted (all of it once surveyed)
    if (!run.revealed.has(p.id)) continue;
    const done = isDone(run, p);
    const col = done ? ART.done : (ART.poi[p.kind] ?? COLORS['ui.highlight']);
    const r = Math.max(3 * ratio, Math.min(7 * ratio, p.r * scale));
    const at = p.kind === 'anomaly' ? signalPoint(run, p) : p; // P06.1: a resolved signal is charted at its fix
    disc(ctx, X(at.x), Y(at.y), r, col);
    if (p.kind === 'gate' || p.kind === 'exit' || p.kind === 'station') {
      ctx.fillStyle = col;
      ctx.fillText(p.kind === 'exit' ? 'EXIT' : p.kind === 'gate' ? 'GATE' : 'STATION', X(p.x), Y(p.y) + r + 2 * ratio);
    }
  }
  const sh = run.ship;
  const n = noseOf(sh.heading);
  const s = 9 * ratio;
  const x = X(sh.x);
  const y = Y(sh.y);
  // sensor range, and the hostiles inside it
  const range = run.craft.stats.sensor;
  ctx.strokeStyle = COLORS['ui.highlight'];
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = Math.max(1, Math.round(ratio));
  ctx.setLineDash([3 * ratio, 4 * ratio]);
  ctx.beginPath();
  ctx.arc(x, y, range * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  drawLootMap(ctx, run, X, Y, ratio);
  drawCombatMap(ctx, run, X, Y, scale, ratio);
  // a ring makes the ship stand out from points of interest and labels
  ctx.strokeStyle = COLORS['ui.highlight'];
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(1, Math.round(1.5 * ratio));
  ctx.beginPath();
  ctx.arc(x, y, s * 1.7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS['ui.highlight'];
  ctx.strokeStyle = COLORS['space.letterbox'];
  ctx.lineWidth = Math.max(1, Math.round(ratio));
  ctx.beginPath();
  ctx.moveTo(x + n.x * s, y + n.y * s);
  ctx.lineTo(x - n.x * s * 0.6 - n.y * s * 0.7, y - n.y * s * 0.6 + n.x * s * 0.7);
  ctx.lineTo(x - n.x * s * 0.6 + n.y * s * 0.7, y - n.y * s * 0.6 - n.x * s * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/** A destroyed ship: four hull quadrants drift apart and fade over the player explosion. */
function drawWreck(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteCache,
  v: Viewport,
  w: Wreck,
  timeMs: number,
  reduced: boolean,
  glow: boolean,
  toX: (x: number) => number,
  toY: (y: number) => number,
  zoom: number,
): void {
  const age = (timeMs - w.startMs) / WRECK_MS;
  if (age < 0 || age >= 1) return;
  const boom = SPRITES['fx.explosion.player'].states.burst;
  const bi = Math.min(boom.length - 1, Math.floor((timeMs - w.startMs) / ANIMATION_TIMING.explosionFrameMs));
  if (bi < boom.length - 1 || age < 0.6) drawFrame(ctx, sprites, sprites.frame('fx.explosion.player', 'burst', bi), v, w.x, w.y, { glow, zoom: 1.4 });
  const f = sprites.frame(w.sprite, 'idle', 0);
  const src = f.sprite as CanvasImageSource;
  const sw = f.raster.sprite.width;
  const shh = f.raster.sprite.height;
  const hw = Math.floor(sw / 2);
  const hh = Math.floor(shh / 2);
  const drift = reduced ? 6 : 6 + 34 * age;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1 - age;
  for (let q = 0; q < 4; q++) {
    const qx = q % 2;
    const qy = q >> 1;
    const ox = (qx ? 1 : -1) * drift;
    const oy = (qy ? 1 : -1) * drift;
    // quadrant offset in the ship's frame, rotated to the world
    const c = Math.cos(w.heading);
    const s = Math.sin(w.heading);
    const wx = w.x + ox * c - oy * s;
    const wy = w.y + ox * s + oy * c;
    ctx.setTransform(1, 0, 0, 1, Math.round(toX(wx)), Math.round(toY(wy)));
    ctx.rotate(w.heading + (reduced ? 0 : (qx ? 1 : -1) * (qy ? 0.9 : 0.6) * age * 2));
    const x0 = qx ? 0 : -hw;
    const y0 = qy ? 0 : -hh;
    ctx.drawImage(src, qx ? hw : 0, qy ? hh : 0, qx ? sw - hw : hw, qy ? shh - hh : hh, x0 * zoom, y0 * zoom, (qx ? sw - hw : hw) * zoom, (qy ? shh - hh : hh) * zoom);
  }
  ctx.restore();
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
  ctx.fill();
}

function drawLandmark(ctx: CanvasRenderingContext2D, l: Landmark, x: number, y: number, zoom: number, t: number): void {
  const r = l.r * zoom;
  if (l.kind === 'star') {
    const col = ART.star[l.style] ?? ART.star['yellow']!;
    if (l.hazardR > l.r) {
      // burn radius: a soft glow plus a faint dashed boundary (the danger is where it is drawn)
      const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, l.hazardR * zoom);
      g.addColorStop(0, `${l.style === 'black-hole' ? '#d68cff' : col}55`);
      g.addColorStop(1, `${l.style === 'black-hole' ? '#d68cff' : col}00`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, l.hazardR * zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = col === '#000000' ? '#d68cff' : col;
      ctx.lineWidth = Math.max(1, zoom);
      ctx.setLineDash([Math.max(2, 4 * zoom), Math.max(4, 8 * zoom)]);
      ctx.beginPath();
      ctx.arc(x, y, l.hazardR * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    if (l.style === 'black-hole') {
      ctx.strokeStyle = '#ffcf8a';
      ctx.lineWidth = Math.max(2, 3 * zoom);
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.5, r * 0.45, (t / 9000) % (Math.PI * 2), 0, Math.PI * 2);
      ctx.stroke();
      disc(ctx, x, y, r, '#000000');
      return;
    }
    disc(ctx, x, y, r, col);
    disc(ctx, x - r * 0.18, y - r * 0.18, r * 0.62, '#ffffff22');
    return;
  }
  const [base, shade] = ART.body[l.style] ?? ART.body['rocky']!;
  disc(ctx, x, y, r, shade);
  disc(ctx, x - r * 0.12, y - r * 0.12, r * 0.88, base);
  if (l.style === 'gas') {
    ctx.fillStyle = `${shade}88`;
    for (let i = -2; i <= 2; i++) ctx.fillRect(Math.round(x - r * 0.8), Math.round(y + i * r * 0.28), Math.round(r * 1.6), Math.max(1, Math.round(r * 0.08)));
    ctx.strokeStyle = '#d8c6a888';
    ctx.lineWidth = Math.max(1, 2 * zoom);
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.55, r * 0.32, -0.3, 0, Math.PI * 2);
    ctx.stroke();
  } else if (l.style === 'molten') {
    disc(ctx, x + r * 0.3, y + r * 0.2, r * 0.18, '#ffb04a');
    disc(ctx, x - r * 0.35, y + r * 0.35, r * 0.12, '#ffb04a');
  } else {
    disc(ctx, x + r * 0.3, y - r * 0.25, r * 0.16, `${shade}cc`);
    disc(ctx, x - r * 0.25, y + r * 0.35, r * 0.11, `${shade}cc`);
  }
}

function drawPoi(ctx: CanvasRenderingContext2D, run: SectorRun, p: Poi, x: number, y: number, zoom: number, pulse: number, t: number, ratio: number): void {
  const done = isDone(run, p);
  const gate = p.kind === 'gate' ? run.gates[p.id] : undefined;
  let col = done ? ART.done : ART.poi[p.kind] ?? '#ffffff';
  if (gate && gate.state !== 'open') col = gate.state === 'sealed' ? ART.sealed : ART.dormant;
  const s = zoom;
  const lw = Math.max(1, Math.round(1.5 * zoom));

  // installations: red alert radius while active
  if (p.kind === 'installation' && !done) {
    const live = run.encounters.some((e) => e.id === p.id && e.state === 'active');
    ctx.globalAlpha = live ? 0.35 + 0.25 * pulse : 0.2;
    ctx.strokeStyle = ART.poi['installation']!;
    ctx.lineWidth = lw;
    ctx.setLineDash([Math.max(2, 5 * s), Math.max(3, 7 * s)]);
    ctx.beginPath();
    ctx.arc(x, y, p.alertR * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // range ring: where the interaction triggers
  if (!done && p.kind !== 'installation') {
    // P06.2: a resolved signal's ring at the fix is bright and breathes like a survey mark
    const fixed = p.kind === 'anomaly' && signalPoint(run, p) !== p;
    ctx.globalAlpha = p.id === run.focus || fixed ? 0.9 : 0.32;
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, Math.round(zoom));
    ctx.setLineDash([Math.max(2, 3 * s), Math.max(2, 5 * s)]);
    ctx.beginPath();
    ctx.arc(x, y, (p.r + (p.kind === 'survey' || fixed ? 2 * pulse : 0)) * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  ctx.lineWidth = lw;
  switch (p.kind) {
    case 'survey':
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-6 * s, -6 * s, 12 * s, 12 * s);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-2.5 * s, -2.5 * s, 5 * s, 5 * s);
      break;
    case 'salvage':
      for (const [dx, dy] of [[-5, -3], [4, -5], [1, 5]] as const) ctx.fillRect((dx - 2.5) * s, (dy - 2.5) * s, 5 * s, 5 * s);
      ctx.fillStyle = done ? ART.done : '#ffffff';
      ctx.fillRect(-1 * s, -1 * s, 2 * s, 2 * s);
      break;
    case 'derelict': {
      // a broken hull: angular silhouette split in two
      ctx.rotate(0.5);
      ctx.fillStyle = done ? '#3a3f4f' : '#6a6f80';
      ctx.beginPath();
      ctx.moveTo(-p.solidR * s, -6 * s);
      ctx.lineTo(-4 * s, -10 * s);
      ctx.lineTo(-2 * s, 8 * s);
      ctx.lineTo(-p.solidR * s * 0.8, 6 * s);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(2 * s, -9 * s);
      ctx.lineTo(p.solidR * s, -3 * s);
      ctx.lineTo(p.solidR * s * 0.7, 7 * s);
      ctx.lineTo(4 * s, 9 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = col;
      ctx.fillRect(-2 * s, -2 * s, 4 * s, 4 * s);
      break;
    }
    case 'cache':
      ctx.fillRect(-7 * s, -6 * s, 14 * s, 12 * s);
      ctx.fillStyle = done ? '#3a3f4f' : '#7a4a10';
      ctx.fillRect(-7 * s, -1 * s, 14 * s, 2 * s);
      ctx.fillStyle = '#ffffff';
      if (!done) ctx.fillRect(-1.5 * s, -1.5 * s, 3 * s, 3 * s);
      break;
    case 'anomaly': {
      const a = (t / 700) % (Math.PI * 2);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, (6 + i * 4) * s, a + i * 2.1, a + i * 2.1 + Math.PI * 1.1);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-2 * s, -2 * s, 4 * s, 4 * s);
      break;
    }
    case 'station': {
      ctx.fillStyle = '#2a3550';
      ctx.beginPath();
      ctx.arc(0, 0, p.solidR * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, p.solidR * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.rotate((t / 12000) % (Math.PI * 2));
      for (let i = 0; i < 4; i++) {
        ctx.rotate(Math.PI / 2);
        ctx.fillStyle = col;
        ctx.fillRect(-1.5 * s, -p.solidR * s, 3 * s, p.solidR * 0.7 * s);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-4 * s, -4 * s, 8 * s, 8 * s);
      break;
    }
    case 'installation': {
      ctx.fillStyle = done ? '#3a3f4f' : '#5a1a22';
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.lineTo(Math.cos(a) * p.solidR * s, Math.sin(a) * p.solidR * s);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = done ? ART.done : '#ffd23f';
      ctx.fillRect(-4 * s, -4 * s, 8 * s, 8 * s);
      break;
    }
    case 'gate': {
      // gates are flown into (no hull): a fixed-size ring marks the aperture
      const gr = GATE_RADIUS * s;
      ctx.lineWidth = Math.max(2, Math.round(3 * zoom));
      ctx.beginPath();
      ctx.arc(0, 0, gr, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        ctx.fillRect(Math.cos(a) * gr - 3 * s, Math.sin(a) * gr - 3 * s, 6 * s, 6 * s);
      }
      if (!gate || gate.state === 'open') {
        ctx.globalAlpha = 0.18 + 0.2 * pulse;
        ctx.beginPath();
        ctx.arc(0, 0, gr * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (gate.state === 'sealed') {
        ctx.beginPath();
        ctx.moveTo(-gr * 0.5, -gr * 0.5);
        ctx.lineTo(gr * 0.5, gr * 0.5);
        ctx.moveTo(gr * 0.5, -gr * 0.5);
        ctx.lineTo(-gr * 0.5, gr * 0.5);
        ctx.stroke();
      }
      break;
    }
    case 'exit':
      ctx.beginPath();
      ctx.moveTo(0, -10 * s);
      ctx.lineTo(8 * s, 6 * s);
      ctx.lineTo(0, 2 * s);
      ctx.lineTo(-8 * s, 6 * s);
      ctx.closePath();
      ctx.fill();
      break;
  }
  ctx.restore();

  // label: kind-coloured, with a check once complete
  const label = gate ? gate.label : p.label;
  const near = Math.hypot(run.ship.x - p.x, run.ship.y - p.y) < 700 || p.kind === 'gate' || p.kind === 'exit' || p.kind === 'station';
  if (!near || p.kind === 'salvage') return;
  ctx.font = `${Math.round(10 * ratio)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = col;
  ctx.globalAlpha = done ? 0.7 : 0.95;
  const below = (p.kind === 'installation' ? p.solidR + 8 : Math.max(p.r, p.solidR + 6)) * zoom + 4 * ratio;
  ctx.fillText(done ? `\u2713 ${label}` : label, Math.round(x), Math.round(y + below));
  ctx.globalAlpha = 1;
}
