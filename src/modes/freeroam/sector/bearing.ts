/**
 * Bearing geometry for signal triangulation (P06.1). Pure functions on plain
 * numbers: no DOM, no clock, no randomness, no state.
 *
 * Conventions: world space (art px, y down); an angle is a direction in
 * radians as Math.atan2(dy, dx) gives it (0 = +x). A bearing is a RAY: it
 * starts at the observation point and runs forward along its angle only.
 *
 * Method (documented in docs/freeroam/SIGNALS.md):
 *  - independence: two bearings are compared as LINES, so the angle between
 *    them is folded into 0..90 degrees (10 and 190 degrees are the same line;
 *    170 degrees apart is as weak as 10). Wrapping across 0 / 2 pi is exact.
 *  - the fix: the point with the least summed squared perpendicular distance
 *    to every bearing line (2x2 normal equations). With two bearings that is
 *    their intersection; with more, noisy lines that miss each other still
 *    give one bounded estimate. The system's determinant equals the sum of
 *    sin^2 of the angle between every pair of lines, so near-parallel input is
 *    detected exactly and rejected instead of producing a far-away point.
 *  - the fix must lie in front of the observers (a ray never looks backward).
 * Limitation: the least-squares fit weighs every line equally, although a
 * bearing taken from far away is less precise on the ground than a near one;
 * with at most five bearings this is accepted and covered by the tolerance.
 */
import type { Point } from './model.ts';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** A bearing ray: observation point and direction (radians). */
export interface Ray {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/** Below this determinant (sin^2 of about half a degree) the lines are treated as parallel. */
export const MIN_DET = Math.sin(0.5 * DEG) ** 2;

/** Angle wrapped to [-pi, pi); NaN for a non-finite input. */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return NaN;
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}

export const validRay = (r: Ray): boolean => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.angle);

/** Angle between two bearing lines, in degrees, 0..90 (NaN for non-finite input). */
export function lineSeparationDeg(a: number, b: number): number {
  const d = Math.abs(wrapAngle(a - b));
  return Math.min(d, Math.PI - d) / DEG;
}

/** Widest line separation over every pair of bearings (degrees); null with fewer than two valid ones. */
export function bestSeparation(rays: readonly Ray[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < rays.length; i++) {
    for (let j = i + 1; j < rays.length; j++) {
      const s = lineSeparationDeg(rays[i]!.angle, rays[j]!.angle);
      if (Number.isFinite(s) && (best === null || s > best)) best = s;
    }
  }
  return best;
}

/**
 * Where two rays cross (forward parts only). Null when they are parallel or
 * nearly so, when the crossing lies behind either observation point, or for
 * non-finite input.
 */
export function intersectRays(a: Ray, b: Ray): Point | null {
  if (!validRay(a) || !validRay(b)) return null;
  const ax = Math.cos(a.angle);
  const ay = Math.sin(a.angle);
  const bx = Math.cos(b.angle);
  const by = Math.sin(b.angle);
  const den = ax * by - ay * bx; // sin of the angle between them
  if (den * den < MIN_DET) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = (dx * by - dy * bx) / den;
  const u = (dx * ay - dy * ax) / den;
  if (!(t > 0) || !(u > 0)) return null;
  return { x: a.x + ax * t, y: a.y + ay * t };
}

/** Least-squares fix of the bearing lines (see the header); null when degenerate or not finite. */
export function leastSquaresFix(rays: readonly Ray[]): Point | null {
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;
  for (const r of rays) {
    if (!validRay(r)) continue;
    const c = Math.cos(r.angle);
    const s = Math.sin(r.angle);
    // projector onto the line's normal: I - d d^T
    a11 += s * s;
    a12 -= c * s;
    a22 += c * c;
    b1 += s * s * r.x - c * s * r.y;
    b2 += c * c * r.y - c * s * r.x;
  }
  const det = a11 * a22 - a12 * a12;
  if (!(det >= MIN_DET)) return null;
  const x = (a22 * b1 - a12 * b2) / det;
  const y = (a11 * b2 - a12 * b1) / det;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Every ray looks toward `p` (it lies no more than `slack` px behind any observation point). */
export function inFront(rays: readonly Ray[], p: Point, slack: number): boolean {
  for (const r of rays) if (validRay(r) && (p.x - r.x) * Math.cos(r.angle) + (p.y - r.y) * Math.sin(r.angle) < -slack) return false;
  return true;
}

/** The point of a ray closest to `p` (the observation point when `p` lies behind it). */
export function closestOnRay(r: Ray, p: Point): Point {
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  const t = Math.max(0, (p.x - r.x) * c + (p.y - r.y) * s);
  return { x: r.x + c * t, y: r.y + s * t };
}
