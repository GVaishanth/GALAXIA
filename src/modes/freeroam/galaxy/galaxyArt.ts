/**
 * Original GALAXIA galaxy portraits, generated locally (no image files, no
 * network). Each catalogue `mapShape` has its own silhouette: a barred spiral,
 * a steeply tilted spiral with two companions, a flocculent spiral, an
 * off-centre Magellanic bar, an irregular wing, a grand-design spiral with a
 * companion, a lopsided face-on spiral, an edge-on disk with a dust lane, a
 * round lens crossed by a dark band, and a ring. They are stylised icons in
 * the game's pixel style, not astronomical images.
 *
 * Deterministic: the same galaxy and size always give the same pixels (seeded
 * from the galaxy id). Rendering cost is a few thousand point splats per icon,
 * done once per size and cached.
 */
import { createRng } from '../../../core/rng.ts';
import { fnv1a32 } from '../catalogue/build.ts';
import type { GalaxyRecord, MapShape } from '../catalogue/types.ts';

export type ArtVariant = 'color' | 'mono';

/** The shared mulberry32 stream (core/rng.ts), as a bare float generator. */
const rng = (seed: number): (() => number) => createRng(seed).next;

interface Field {
  readonly n: number;
  readonly light: Float32Array;
  readonly dust: Float32Array;
  readonly rand: () => number;
  gauss(): number;
  /** Add light at normalised coords (-1..1). */
  add(x: number, y: number, w: number): void;
  /** Mark dust (darkening) at normalised coords. */
  shade(x: number, y: number, w: number): void;
}

function field(n: number, seed: number): Field {
  const light = new Float32Array(n * n);
  const dust = new Float32Array(n * n);
  const rand = rng(seed);
  const idx = (x: number, y: number): number => {
    const px = Math.floor((x * 0.47 + 0.5) * n);
    const py = Math.floor((y * 0.47 + 0.5) * n);
    return px < 0 || py < 0 || px >= n || py >= n ? -1 : py * n + px;
  };
  return {
    n,
    light,
    dust,
    rand,
    gauss: () => {
      const u = Math.max(1e-6, rand());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    },
    add(x, y, w) {
      const i = idx(x, y);
      if (i >= 0) light[i]! += w;
    },
    shade(x, y, w) {
      const i = idx(x, y);
      if (i >= 0) dust[i] = Math.max(dust[i]!, w);
    },
  };
}

const rot = (x: number, y: number, a: number): [number, number] => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

function blob(f: Field, cx: number, cy: number, sx: number, sy: number, count: number, w: number, angle = 0): void {
  for (let i = 0; i < count; i++) {
    const [x, y] = rot(f.gauss() * sx, f.gauss() * sy, angle);
    f.add(cx + x, cy + y, w);
  }
}

interface SpiralOpts {
  arms: number;
  /** Radians of winding from inner to outer edge. */
  twist: number;
  squash: number;
  angle: number;
  /** Inner radius where the arms start (bar ends). */
  inner: number;
  /** Scatter around the arm. */
  spread: number;
  count: number;
  /** Per-arm length factor (lopsided galaxies). */
  armLength?: readonly number[];
  cx?: number;
  cy?: number;
}

function spiral(f: Field, o: SpiralOpts): void {
  for (let i = 0; i < o.count; i++) {
    const k = i % o.arms;
    const len = o.armLength?.[k] ?? 1;
    const t = Math.pow(f.rand(), 0.85) * len;
    const r = o.inner + t * (0.95 - o.inner);
    const theta = (k * 2 * Math.PI) / o.arms + o.twist * t;
    const s = o.spread * (0.6 + t);
    let x = r * Math.cos(theta) + f.gauss() * s;
    let y = r * Math.sin(theta) + f.gauss() * s;
    y *= o.squash;
    [x, y] = rot(x, y, o.angle);
    f.add((o.cx ?? 0) + x, (o.cy ?? 0) + y, 1);
  }
}

const SHAPES: Readonly<Record<MapShape, (f: Field, scale: number) => void>> = {
  'barred-spiral': (f, s) => {
    const a = 0.45;
    for (let i = 0; i < 260 * s; i++) {
      const [x, y] = rot((f.rand() * 2 - 1) * 0.3, f.gauss() * 0.045, a);
      f.add(x * 0.85, y * 0.85, 1.4);
    }
    spiral(f, { arms: 2, twist: 3.6, squash: 0.82, angle: a, inner: 0.28, spread: 0.06, count: 1100 * s });
    blob(f, 0, 0, 0.09, 0.08, 220 * s, 2);
  },
  'tilted-spiral': (f, s) => {
    spiral(f, { arms: 2, twist: 4.2, squash: 0.42, angle: -0.62, inner: 0.12, spread: 0.1, count: 1400 * s });
    blob(f, 0, 0, 0.16, 0.08, 420 * s, 2, -0.62);
    blob(f, 0.18, -0.24, 0.035, 0.035, 50 * s, 2); // compact companion
    blob(f, -0.3, 0.42, 0.07, 0.04, 70 * s, 1.4, 0.9); // elongated companion
  },
  'loose-spiral': (f, s) => {
    spiral(f, { arms: 3, twist: 3.2, squash: 0.72, angle: 0.4, inner: 0.06, spread: 0.13, count: 1200 * s });
    for (let k = 0; k < 7; k++) blob(f, (f.rand() - 0.5) * 1.1, (f.rand() - 0.5) * 0.8, 0.03, 0.03, 26 * s, 1.6);
    blob(f, 0, 0, 0.07, 0.06, 140 * s, 1.6);
  },
  'magellanic-bar': (f, s) => {
    blob(f, 0, 0, 0.55, 0.42, 620 * s, 0.7);
    for (let i = 0; i < 380 * s; i++) {
      const [x, y] = rot((f.rand() * 2 - 1) * 0.52, f.gauss() * 0.08, 0.25);
      f.add(x - 0.12, y + 0.08, 1.5);
    }
    for (let i = 0; i < 360 * s; i++) {
      const t = f.rand();
      const th = -0.4 - t * 2.2;
      f.add(0.4 + Math.cos(th) * 0.62 * t + f.gauss() * 0.06, -0.05 + Math.sin(th) * 0.56 * t + f.gauss() * 0.06, 1);
    }
    blob(f, 0.26, -0.26, 0.04, 0.04, 90 * s, 2.6); // bright star-forming knot
  },
  'irregular-wing': (f, s) => {
    blob(f, -0.08, 0.04, 0.4, 0.17, 900 * s, 1, 0.55);
    blob(f, 0.42, 0.42, 0.18, 0.09, 260 * s, 1, -0.3);
    for (let k = 0; k < 6; k++) blob(f, (f.rand() - 0.6) * 0.7, (f.rand() - 0.4) * 0.6, 0.035, 0.03, 30 * s, 1.8);
  },
  'spiral-with-companion': (f, s) => {
    spiral(f, { arms: 2, twist: 5, squash: 0.9, angle: 0.2, inner: 0.08, spread: 0.05, count: 1250 * s, armLength: [1, 0.86], cx: -0.12, cy: -0.06 });
    blob(f, -0.12, -0.06, 0.08, 0.07, 260 * s, 2);
    for (let i = 0; i < 140 * s; i++) {
      const t = f.rand();
      f.add(0.28 + t * 0.38 + f.gauss() * 0.04, 0.3 + t * 0.26 + f.gauss() * 0.04, 0.8); // tidal bridge
    }
    blob(f, 0.68, 0.6, 0.09, 0.08, 260 * s, 1.8); // companion galaxy
  },
  'face-on-spiral': (f, s) => {
    spiral(f, { arms: 5, twist: 3.4, squash: 1, angle: 0.3, inner: 0.07, spread: 0.07, count: 1400 * s, armLength: [1, 0.8, 1, 0.65, 0.9], cx: 0.06, cy: -0.04 });
    blob(f, 0.06, -0.04, 0.06, 0.06, 170 * s, 1.8);
    for (let k = 0; k < 6; k++) blob(f, (f.rand() - 0.5) * 1.3, (f.rand() - 0.5) * 1.3, 0.03, 0.03, 24 * s, 1.6);
  },
  'edge-on-disk': (f, s) => {
    blob(f, 0, 0, 0.26, 0.17, 900 * s, 1.4);
    for (let i = 0; i < 700 * s; i++) f.add(Math.max(-0.95, Math.min(0.95, f.gauss() * 0.42)), f.gauss() * 0.045, 1);
    for (let i = 0; i < 900; i++) {
      const x = (f.rand() * 2 - 1) * 0.9;
      f.shade(x, 0.03 + f.gauss() * 0.012, 1);
    }
  },
  'lens-with-dust-lane': (f, s) => {
    blob(f, 0, 0, 0.36, 0.32, 1300 * s, 1);
    blob(f, 0, 0, 0.1, 0.09, 260 * s, 1.6);
    for (let i = 0; i < 1200; i++) {
      const t = f.rand() * 2 - 1;
      const [x, y] = rot(t * 0.78, Math.sin(t * 2.2) * 0.07 + f.gauss() * 0.03, -0.42);
      f.shade(x, y, 1);
    }
    for (let i = 0; i < 70 * s; i++) {
      // faint jets, perpendicular to the dust band
      const [x, y] = rot((f.rand() * 2 - 1) * 0.95, f.gauss() * 0.03, -0.42 + Math.PI / 2);
      f.add(x, y, 0.5);
    }
  },
  ring: (f, s) => {
    for (let i = 0; i < 1100 * s; i++) {
      const th = f.rand() * Math.PI * 2;
      const r = 0.8 + f.gauss() * 0.045;
      const [x, y] = rot(Math.cos(th) * r, Math.sin(th) * r * 0.78, 0.35);
      f.add(x, y, 1.2);
    }
    for (let k = 0; k < 8; k++) {
      const th = (k / 8) * Math.PI * 2 + f.rand() * 0.4;
      const [x, y] = rot(Math.cos(th) * 0.8, Math.sin(th) * 0.8 * 0.78, 0.35);
      blob(f, x, y, 0.035, 0.035, 26 * s, 2);
    }
    for (let i = 0; i < 260 * s; i++) {
      const th = f.rand() * Math.PI * 2;
      const r = 0.24 + f.gauss() * 0.03;
      const [x, y] = rot(Math.cos(th) * r, Math.sin(th) * r * 0.78, 0.35);
      f.add(x + 0.05, y, 1);
    }
    blob(f, 0.05, 0, 0.06, 0.05, 160 * s, 1.8);
    for (let k = 0; k < 6; k++) {
      const th = (k / 6) * Math.PI * 2 + 0.3;
      for (let i = 0; i < 26 * s; i++) {
        const r = 0.3 + f.rand() * 0.45;
        const [x, y] = rot(Math.cos(th) * r, Math.sin(th) * r * 0.78, 0.35);
        f.add(x, y, 0.35);
      }
    }
  },
};

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const mix = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as [number, number, number];
const grey = (c: readonly number[]): [number, number, number] => {
  const l = Math.round(c[0]! * 0.3 + c[1]! * 0.59 + c[2]! * 0.11);
  return [l, l, l];
};

/** Pixels of one portrait (RGBA, n x n). Exposed for tests; the DOM wrapper is galaxyCanvas(). */
export function galaxyPixels(galaxy: GalaxyRecord, n: number, variant: ArtVariant = 'color'): Uint8ClampedArray<ArrayBuffer> {
  const f = field(n, fnv1a32(`galaxia:map-art:${galaxy.id}`));
  const scale = Math.min(2, Math.max(0.5, (n * n) / 1600));
  SHAPES[galaxy.gameplay.theme.mapShape](f, scale);
  // tone map against a high percentile so every shape reaches full brightness
  const lit = [...f.light].filter((v) => v > 0).sort((a, b) => a - b);
  const ref = lit.length ? lit[Math.floor(lit.length * 0.9)]! : 1;
  const [a1, a2] = galaxy.gameplay.theme.accent;
  const outer = hex(a2);
  const inner = hex(a1);
  let ramp: [number, number, number][] = [mix([6, 7, 15], outer, 0.55), outer, mix(outer, inner, 0.7), mix(inner, [255, 255, 255], 0.55)];
  if (variant === 'mono') ramp = ramp.map((c) => grey(mix(c, [120, 126, 150], 0.35)));
  const out = new Uint8ClampedArray(new ArrayBuffer(n * n * 4));
  for (let i = 0; i < n * n; i++) {
    const v = f.light[i]! / ref;
    if (v < 0.08) continue;
    let rgb: [number, number, number];
    let alpha = 255;
    if (f.dust[i]! > 0.5 && v > 0.15) rgb = variant === 'mono' ? [30, 30, 30] : [28, 18, 12];
    else if (v < 0.3) (rgb = ramp[0]!), (alpha = 200);
    else if (v < 0.62) rgb = ramp[1]!;
    else if (v < 1.25) rgb = ramp[2]!;
    else rgb = ramp[3]!;
    out.set([rgb[0], rgb[1], rgb[2], alpha], i * 4);
  }
  return out;
}

/** A cached n x n canvas with the portrait (draw it scaled with smoothing off). */
export class GalaxyArtCache {
  private readonly cache = new Map<string, HTMLCanvasElement>();

  get(galaxy: GalaxyRecord, n: number, variant: ArtVariant = 'color'): HTMLCanvasElement {
    const key = `${galaxy.id}:${n}:${variant}`;
    let c = this.cache.get(key);
    if (!c) {
      if (this.cache.size > 64) this.clear(); // sizes change on resize; keep memory bounded
      c = document.createElement('canvas');
      c.width = n;
      c.height = n;
      const ctx = c.getContext('2d');
      if (ctx) ctx.putImageData(new ImageData(galaxyPixels(galaxy, n, variant), n, n), 0, 0);
      this.cache.set(key, c);
    }
    return c;
  }

  clear(): void {
    for (const c of this.cache.values()) {
      c.width = 0;
      c.height = 0;
    }
    this.cache.clear();
  }
}
