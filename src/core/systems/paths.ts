/**
 * Cubic Bézier chains sampled into arc-length tables, so entities move at a
 * constant speed along any curve. Pure arithmetic (no trig): deterministic.
 */
import type { PathPoints } from '../../config/paths.ts';

export interface Vec {
  x: number;
  y: number;
}

export interface Path {
  /** Sampled points along the curve. */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Cumulative length at each sample. */
  readonly lengths: Float64Array;
  readonly length: number;
}

const SAMPLES_PER_SEGMENT = 24;

export type Pt = readonly [number, number];

function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Build a path from 3n+1 control points. */
export function buildPath(points: readonly Pt[]): Path {
  if (points.length < 4 || (points.length - 1) % 3 !== 0) throw new Error(`Path needs 3n+1 points, got ${points.length}`);
  const segs = (points.length - 1) / 3;
  const n = segs * SAMPLES_PER_SEGMENT + 1;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const lengths = new Float64Array(n);
  let k = 0;
  for (let s = 0; s < segs; s++) {
    const [a, b, c, d] = [points[s * 3]!, points[s * 3 + 1]!, points[s * 3 + 2]!, points[s * 3 + 3]!];
    for (let i = s === 0 ? 0 : 1; i <= SAMPLES_PER_SEGMENT; i++) {
      const t = i / SAMPLES_PER_SEGMENT;
      xs[k] = bezier(a[0], b[0], c[0], d[0], t);
      ys[k] = bezier(a[1], b[1], c[1], d[1], t);
      if (k > 0) {
        const dx = xs[k]! - xs[k - 1]!;
        const dy = ys[k]! - ys[k - 1]!;
        lengths[k] = lengths[k - 1]! + Math.sqrt(dx * dx + dy * dy);
      }
      k++;
    }
  }
  return { xs, ys, lengths, length: lengths[n - 1]! };
}

/** Position (and unit direction) at distance s along the path, clamped to [0, length]. */
export function pointAt(path: Path, s: number, out: Vec, dir?: Vec): void {
  const { xs, ys, lengths } = path;
  const last = lengths.length - 1;
  if (s <= 0) {
    out.x = xs[0]!;
    out.y = ys[0]!;
    if (dir) direction(path, 0, dir);
    return;
  }
  if (s >= path.length) {
    out.x = xs[last]!;
    out.y = ys[last]!;
    if (dir) direction(path, last - 1, dir);
    return;
  }
  // binary search for the segment containing s
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const span = lengths[hi]! - lengths[lo]!;
  const t = span > 0 ? (s - lengths[lo]!) / span : 0;
  out.x = xs[lo]! + (xs[hi]! - xs[lo]!) * t;
  out.y = ys[lo]! + (ys[hi]! - ys[lo]!) * t;
  if (dir) direction(path, lo, dir);
}

function direction(path: Path, i: number, dir: Vec): void {
  const dx = path.xs[i + 1]! - path.xs[i]!;
  const dy = path.ys[i + 1]! - path.ys[i]!;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 0) {
    dir.x = dx / len;
    dir.y = dy / len;
  }
}

export function mirrorPoints(points: PathPoints | readonly Pt[], width: number): Pt[] {
  return points.map(([x, y]) => [width - x, y] as const);
}

export function translatePoints(points: readonly Pt[], dx: number, dy: number): Pt[] {
  return points.map(([x, y]) => [x + dx, y + dy] as const);
}

/** Straight line as a degenerate Bézier (for simple legs). */
export function line(a: Pt, b: Pt): Pt[] {
  return [a, [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3], [a[0] + ((b[0] - a[0]) * 2) / 3, a[1] + ((b[1] - a[1]) * 2) / 3], b];
}

/** Concatenate point chains (drops the duplicated joint). */
export function chain(...parts: (readonly Pt[])[]): Pt[] {
  const out: Pt[] = [];
  for (const p of parts) out.push(...(out.length === 0 ? p : p.slice(1)));
  return out;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Triangle wave in [-1, 1], 0 at phase 0 (deterministic replacement for sin). */
export function tri(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p < 0.25) return 4 * p;
  if (p < 0.75) return 2 - 4 * p;
  return 4 * p - 4;
}

/** Triangle wave in [0, 1], 0 at phase 0. */
export function tri01(phase: number): number {
  const p = phase - Math.floor(phase);
  return p < 0.5 ? 2 * p : 2 - 2 * p;
}
