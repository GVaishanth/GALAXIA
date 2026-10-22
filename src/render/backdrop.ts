/**
 * Space backdrop (Stage 4): three parallax star layers, a distant ringed
 * planet, dithered nebula banks and a rare comet, plus the stage "warp".
 *
 * Everything sits far below sprite contrast (alpha <= ~0.35, dim palette
 * roles) so ships and projectiles always read first. Distant objects are
 * generated procedurally as pixel art (ordered dithering, no smoothing) and
 * cached once; per frame the backdrop only blits two images and draws ~110
 * star rects. Scroll offsets are integrated (not derived from absolute
 * time), so warp changes are continuous and pausing simply stops update().
 */
import { BACKDROP, type StarLayer } from '../config/presentation.ts';
import { COLORS, type ColorRole } from '../config/palette.ts';
import { PLAYFIELD_ART } from '../config/visual.ts';
import { createRng, type Rng } from '../core/rng.ts';
import { domCanvasFactory, type CanvasFactory, type CanvasLike } from './sprite/spriteCache.ts';
import type { Viewport } from './viewport.ts';

export interface PixelImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

interface Star {
  readonly x: number;
  readonly y: number;
  readonly color: string;
  readonly phase: number;
  readonly twinkles: boolean;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

function rgb(role: ColorRole): [number, number, number] {
  const hex = COLORS[role] as string;
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function put(img: PixelImage, x: number, y: number, c: readonly number[], a = 255): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0]!;
  img.data[i + 1] = c[1]!;
  img.data[i + 2] = c[2]!;
  img.data[i + 3] = a;
}

/** Ringed planet, lit from the upper left, 3 dithered shade bands. */
export function planetPixels(radius: number, tilt: number): PixelImage {
  const ringR = Math.round(radius * 1.7);
  const width = ringR * 2 + 3;
  const height = radius * 2 + 3;
  const img: PixelImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const cx = width / 2;
  const cy = height / 2;
  const bands = [rgb('commanderHit.hull.dark'), rgb('commanderHit.hull.shade'), rgb('commanderHit.hull'), rgb('commanderHit.hull.light')];
  const ring = rgb('star.warm');
  const ringLight = rgb('scout.body.shade');
  const lx = -0.6;
  const ly = -0.55;
  const lz = 0.58;
  const ringAt = (x: number, y: number, front: boolean): void => {
    const dx = (x + 0.5 - cx) / ringR;
    const dy = (y + 0.5 - cy) / (ringR * tilt);
    const d = dx * dx + dy * dy;
    if (d > 1 || d < 0.62) return;
    if (front !== y + 0.5 >= cy) return;
    put(img, x, y, d > 0.8 ? ring : ringLight);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) ringAt(x, y, false);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5 - cx) / radius;
      const ny = (y + 0.5 - cy) / radius;
      const r2 = nx * nx + ny * ny;
      if (r2 > 1) continue;
      const nz = Math.sqrt(1 - r2);
      // banded surface: slight horizontal stripes
      const stripe = Math.sin(ny * 9) * 0.08;
      const lum = Math.max(0, nx * lx + ny * ly + nz * lz) + stripe;
      const level = lum * (bands.length - 1) + BAYER4[(y % 4) * 4 + (x % 4)]! - 0.5;
      const idx = Math.max(0, Math.min(bands.length - 1, Math.round(level)));
      put(img, x, y, bands[idx]!);
    }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) ringAt(x, y, true);
  return img;
}

/** Tileable value noise on a wrapped lattice (period gw x gh cells). */
function valueNoise(rng: Rng, gw: number, gh: number): (u: number, v: number) => number {
  const g = Array.from({ length: gw * gh }, () => rng.next());
  const at = (i: number, j: number): number => g[(((j % gh) + gh) % gh) * gw + (((i % gw) + gw) % gw)]!;
  const s = (t: number): number => t * t * (3 - 2 * t);
  return (u, v) => {
    const x = u * gw;
    const y = v * gh;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = s(x - i);
    const fy = s(y - j);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return a + (b - a) * fy;
  };
}

/**
 * Dithered nebula banks at 1/4 resolution (drawn x4 with nearest-neighbour,
 * so the clouds read as chunky pixels). Tiles vertically for seamless scroll.
 */
export function nebulaPixels(seed: number, cellsW: number, cellsH: number, roles: readonly ColorRole[], threshold = 0.6): PixelImage {
  const rng = createRng(seed);
  const n1 = valueNoise(rng, 4, 5);
  const n2 = valueNoise(rng, 9, 11);
  const img: PixelImage = { width: cellsW, height: cellsH, data: new Uint8ClampedArray(cellsW * cellsH * 4) };
  const cols = roles.map(rgb);
  for (let y = 0; y < cellsH; y++) {
    for (let x = 0; x < cellsW; x++) {
      const u = x / cellsW;
      const v = y / cellsH;
      const d = n1(u, v) * 0.7 + n2(u, v) * 0.3;
      const t = BAYER4[(y % 4) * 4 + (x % 4)]!;
      // only the densest banks show (sparse), with a dithered edge
      const level = (d - threshold) * 6 + t - 0.5;
      if (level < 0) continue;
      const idx = Math.min(cols.length - 1, Math.floor(level));
      put(img, x, y, cols[idx]!);
    }
  }
  return img;
}

export class SpaceBackdrop {
  private readonly layers: { readonly spec: StarLayer; readonly stars: Star[]; offset: number }[];
  private readonly make: CanvasFactory;
  private planetCanvas: CanvasLike | null = null;
  private nebulaCanvas: CanvasLike | null = null;
  private planetOffset = 0;
  private nebulaOffset = 0;
  private clockMs = 0;
  private warp = 0;
  private readonly rng: Rng;
  private nextCometMs: number;
  private comet: { startMs: number; x: number; y: number; dx: number; dy: number } | null = null;
  reducedMotion = false;

  constructor(make: CanvasFactory = domCanvasFactory, seed: number = BACKDROP.seed) {
    this.make = make;
    const rng = createRng(seed);
    this.layers = BACKDROP.layers.map((spec) => ({
      spec,
      offset: 0,
      stars: Array.from({ length: spec.count }, () => ({
        x: Math.floor(rng.range(0, PLAYFIELD_ART.width)),
        y: rng.range(0, PLAYFIELD_ART.height),
        color: COLORS[spec.roles[rng.int(0, spec.roles.length - 1)]!],
        phase: rng.next(),
        twinkles: rng.next() < spec.twinkle,
      })),
    }));
    this.rng = createRng(seed ^ 0x5eed);
    this.nextCometMs = this.rng.range(BACKDROP.comet.minGapMs, BACKDROP.comet.maxGapMs);
  }

  get starCount(): number {
    return this.layers.reduce((n, l) => n + l.stars.length, 0);
  }

  /** Presentation time consumed so far (frozen while the game is paused). */
  get elapsedMs(): number {
    return this.clockMs;
  }

  get currentWarp(): number {
    return this.warp;
  }

  /** Advance scrolling. `warp` 0..1 multiplies star speed; reduced motion slows everything. */
  update(dtMs: number, warp: number): void {
    if (dtMs <= 0) return;
    this.clockMs += dtMs;
    this.warp = this.reducedMotion ? 0 : Math.max(0, Math.min(1, warp));
    const motion = this.reducedMotion ? 0.25 : 1;
    const mult = 1 + this.warp * (BACKDROP.warpMultiplier - 1);
    const H = PLAYFIELD_ART.height;
    for (const l of this.layers) l.offset = (l.offset + (l.spec.speed * motion * mult * dtMs) / 1000) % H;
    this.planetOffset += (BACKDROP.planet.speed * motion * dtMs) / 1000;
    this.nebulaOffset = (this.nebulaOffset + (BACKDROP.nebula.speed * motion * (1 + this.warp * 2) * dtMs) / 1000) % BACKDROP.nebula.height;
    if (this.comet && this.clockMs - this.comet.startMs > BACKDROP.comet.durationMs) this.comet = null;
    if (this.clockMs >= this.nextCometMs) {
      this.nextCometMs = this.clockMs + this.rng.range(BACKDROP.comet.minGapMs, BACKDROP.comet.maxGapMs);
      if (!this.reducedMotion && !this.comet) {
        const fromLeft = this.rng.next() < 0.5;
        this.comet = { startMs: this.clockMs, x: fromLeft ? this.rng.range(20, 200) : this.rng.range(248, 428), y: this.rng.range(60, 300), dx: fromLeft ? 1 : -1, dy: 0.45 };
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, v: Viewport): void {
    const H = PLAYFIELD_ART.height;
    const prevAlpha = ctx.globalAlpha;
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;

    // nebula (x4 chunky pixels), drawn twice for a seamless vertical wrap
    const neb = this.nebula();
    if (neb) {
      const nh = BACKDROP.nebula.height;
      ctx.globalAlpha = prevAlpha * BACKDROP.nebula.alpha;
      const y0 = Math.round(this.nebulaOffset) - nh;
      for (const y of [y0, y0 + nh]) ctx.drawImage(neb, v.offsetX, Math.round(v.offsetY + y * v.scale), Math.ceil(BACKDROP.nebula.width * v.scale), Math.ceil(nh * v.scale));
    }

    // distant planet
    const planet = this.planet();
    if (planet) {
      const P = BACKDROP.planet;
      const span = H + planet.height * 2;
      const py = ((P.y + this.planetOffset + planet.height) % span) - planet.height;
      ctx.globalAlpha = prevAlpha * P.alpha;
      ctx.drawImage(planet, Math.round(v.offsetX + (P.x - planet.width / 2) * v.scale), Math.round(v.offsetY + (py - planet.height / 2) * v.scale), Math.round(planet.width * v.scale), Math.round(planet.height * v.scale));
    }
    ctx.globalAlpha = prevAlpha;

    // stars: dots, or vertical streaks during warp
    this.drawStars(ctx, v, v.offsetX, v.offsetY, 0, false, 0);

    // comet: a short pixel streak with a stepped tail
    if (this.comet) {
      const px = Math.max(1, Math.round(v.scale));
      const C = BACKDROP.comet;
      const k = (this.clockMs - this.comet.startMs) / C.durationMs;
      const hx = this.comet.x + this.comet.dx * k * 160;
      const hy = this.comet.y + this.comet.dy * k * 160;
      ctx.fillStyle = COLORS['star.bright'];
      for (let i = 0; i < C.length; i++) {
        ctx.globalAlpha = prevAlpha * C.alpha * (1 - i / C.length) * (k > 0.8 ? (1 - k) * 5 : 1);
        ctx.fillRect(Math.round(v.offsetX + Math.round(hx - this.comet.dx * i) * v.scale), Math.round(v.offsetY + Math.round(hy - this.comet.dy * i) * v.scale), px, px);
      }
      ctx.globalAlpha = prevAlpha;
    }
    ctx.imageSmoothingEnabled = prevSmooth;
  }

  /**
   * The margin field (TD-76): the star layers and the nebula continued outside
   * the arena as dimmed tiles, each the arena's size, laid around it on the
   * same grid. Every tile shifts the pattern vertically and mirrors it on odd
   * columns, so neighbouring margins never show the same stars side by side.
   * Nothing is drawn when the arena fills the canvas. Returns the tiles drawn
   * (bounded by BACKDROP.margin.maxTiles, nearest first).
   */
  drawMargins(ctx: CanvasRenderingContext2D, v: Viewport): number {
    const tiles = marginTiles(v, BACKDROP.margin.maxTiles);
    if (tiles.length === 0) return 0;
    const H = PLAYFIELD_ART.height;
    const tw = v.artWidth * v.scale;
    const th = v.artHeight * v.scale;
    const prevAlpha = ctx.globalAlpha;
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    const neb = this.nebula();
    const nh = BACKDROP.nebula.height;
    for (const t of tiles) {
      const ox = tileEdge(t.i, v.offsetX, tw);
      const oy = tileEdge(t.j, v.offsetY, th);
      const shift = tileShift(t.i, t.j);
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, tileEdge(t.i + 1, v.offsetX, tw) - ox, tileEdge(t.j + 1, v.offsetY, th) - oy);
      ctx.clip();
      ctx.globalAlpha = prevAlpha * BACKDROP.margin.alpha;
      if (neb) {
        ctx.globalAlpha = prevAlpha * BACKDROP.margin.alpha * BACKDROP.nebula.alpha;
        const y0 = Math.round((this.nebulaOffset + shift * nh) % nh) - nh;
        for (const y of [y0, y0 + nh]) ctx.drawImage(neb, ox, Math.round(oy + y * v.scale), Math.ceil(BACKDROP.nebula.width * v.scale), Math.ceil(nh * v.scale));
        ctx.globalAlpha = prevAlpha * BACKDROP.margin.alpha;
      }
      this.drawStars(ctx, v, ox, oy, shift * H, (t.i & 1) !== 0, shift);
      ctx.restore();
    }
    ctx.globalAlpha = prevAlpha;
    ctx.imageSmoothingEnabled = prevSmooth;
    return tiles.length;
  }

  /** The three star layers into one arena-sized tile at device (ox, oy). */
  private drawStars(ctx: CanvasRenderingContext2D, v: Viewport, ox: number, oy: number, shiftY: number, mirror: boolean, twinkleShift: number): void {
    const H = PLAYFIELD_ART.height;
    const W = PLAYFIELD_ART.width;
    const px = Math.max(1, Math.round(v.scale));
    const maxSpeed = BACKDROP.layers[BACKDROP.layers.length - 1]!.speed;
    for (const l of this.layers) {
      const streak = Math.round(BACKDROP.streakMaxPx * this.warp * (l.spec.speed / maxSpeed));
      for (const s of l.stars) {
        if (s.twinkles && streak === 0) {
          const t = (this.clockMs / BACKDROP.twinklePeriodMs + s.phase + twinkleShift) % 1;
          if (t < 0.35) continue;
        }
        const y = Math.floor((s.y + l.offset + shiftY) % H);
        ctx.fillStyle = s.color;
        const dx = Math.round(ox + (mirror ? W - 1 - s.x : s.x) * v.scale);
        if (streak > 0) ctx.fillRect(dx, Math.round(oy + (y - streak) * v.scale), px, Math.max(px, Math.round((streak + 1) * v.scale)));
        else ctx.fillRect(dx, Math.round(oy + y * v.scale), px, px);
      }
    }
  }

  private planet(): CanvasLike | null {
    if (!this.planetCanvas) this.planetCanvas = this.toCanvas(planetPixels(BACKDROP.planet.radius, BACKDROP.planet.ringTilt));
    return this.planetCanvas;
  }

  private nebula(): CanvasLike | null {
    if (!this.nebulaCanvas) {
      const N = BACKDROP.nebula;
      this.nebulaCanvas = this.toCanvas(nebulaPixels(BACKDROP.seed + 7, N.width / 4, N.height / 4, N.roles, N.threshold));
    }
    return this.nebulaCanvas;
  }

  private toCanvas(img: PixelImage): CanvasLike | null {
    const c = this.make(img.width, img.height);
    const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    const data = ctx.createImageData(img.width, img.height);
    data.data.set(img.data);
    ctx.putImageData(data, 0, 0);
    return c;
  }
}

/** A margin tile: grid position relative to the arena (0, 0), in arena-sized steps. */
export interface MarginTile {
  readonly i: number;
  readonly j: number;
}

/**
 * The arena-sized tiles that cover the canvas outside the arena (pure). The
 * arena's own cell (0, 0) is never included; tiles are ordered nearest first
 * and capped at `max`, so a pathological canvas cannot multiply the work.
 */
export function marginTiles(v: Viewport, max: number): MarginTile[] {
  const tw = v.artWidth * v.scale;
  const th = v.artHeight * v.scale;
  if (!(tw > 0 && th > 0)) return [];
  const left = Math.ceil(Math.max(0, v.offsetX) / tw - 1e-6);
  const right = Math.ceil(Math.max(0, v.deviceWidth - v.offsetX - tw) / tw - 1e-6);
  const up = Math.ceil(Math.max(0, v.offsetY) / th - 1e-6);
  const down = Math.ceil(Math.max(0, v.deviceHeight - v.offsetY - th) / th - 1e-6);
  const tiles: MarginTile[] = [];
  for (let j = -up; j <= down; j++) for (let i = -left; i <= right; i++) if (i !== 0 || j !== 0) tiles.push({ i, j });
  tiles.sort((a, b) => Math.max(Math.abs(a.i), Math.abs(a.j)) - Math.max(Math.abs(b.i), Math.abs(b.j)) || Math.abs(a.i) + Math.abs(a.j) - (Math.abs(b.i) + Math.abs(b.j)));
  return tiles.slice(0, Math.max(0, max));
}

/**
 * Device-px position of grid line `k` (line 0 is the arena's left / top edge,
 * line 1 its right / bottom edge at ceil(size), like the arena fill). Tiles
 * between consecutive lines meet the arena and each other exactly.
 */
export function tileEdge(k: number, origin: number, size: number): number {
  return k <= 0 ? origin + Math.round(k * size) : origin + Math.ceil(size) + Math.round((k - 1) * size);
}

/** Per-tile vertical phase in [0, 1): decorrelates neighbouring margin tiles (pure, stable; R2 sequence constants). */
export function tileShift(i: number, j: number): number {
  const x = i * 0.7548777 + j * 0.5698403 + 0.5;
  return ((x % 1) + 1) % 1;
}

/**
 * The sides of the arena that have a margin of at least one art pixel (pure).
 * The renderer draws the arena edge only on those sides.
 */
export function marginSides(v: Viewport): { readonly left: boolean; readonly right: boolean; readonly top: boolean; readonly bottom: boolean } {
  const px = Math.max(1, Math.round(v.scale));
  const aw = Math.ceil(v.artWidth * v.scale);
  const ah = Math.ceil(v.artHeight * v.scale);
  return {
    left: v.offsetX >= px,
    right: v.deviceWidth - (v.offsetX + aw) >= px,
    top: v.offsetY >= px,
    bottom: v.deviceHeight - (v.offsetY + ah) >= px,
  };
}
