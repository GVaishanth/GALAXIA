/**
 * The gravity field equation (moved verbatim from gravity/physics.ts, FR-TD-86).
 *
 * a = mu * r / (|r|^2 + eps^2)^(3/2), r pointing from the point to the body
 * centre. eps (softening) only removes the singularity at the centre. Beyond
 * `TAPER_START * range` the field fades smoothly (smoothstep) to zero at
 * `range`. A central force that depends only on distance is conservative.
 *
 * Shared by the Gravity Flight lab (gravity/physics.ts re-exports it) and the
 * planet / star pull of ordinary sectors (sector/gravityWells.ts), so both use
 * one equation. Pure: no DOM, no wall clock, no unseeded randomness.
 */

/** Fraction of the field range where the smooth fade to zero begins. */
export const TAPER_START = 0.7;

export interface FieldParams {
  /** Gravitational parameter mu (px^3 / s^2). */
  readonly mu: number;
  /** Softening length eps (px); keep it below the collision radius. */
  readonly softening: number;
  /** Field range (px): zero gravity at and beyond it. */
  readonly range: number;
}

export interface Vec {
  x: number;
  y: number;
}

/**
 * Gravitational acceleration at (x, y) from a body centred at (bx, by), written
 * into `out`; returns its magnitude. Never infinite (softening), zero at and
 * beyond the field range, smooth everywhere in between.
 */
export function gravityAt(bx: number, by: number, x: number, y: number, f: FieldParams, out: Vec): number {
  const dx = bx - x;
  const dy = by - y;
  const r2 = dx * dx + dy * dy;
  const range = Math.max(1, f.range);
  if (r2 >= range * range || f.mu <= 0) {
    out.x = 0;
    out.y = 0;
    return 0;
  }
  const r = Math.sqrt(r2);
  const eps = Math.max(0, f.softening);
  const s2 = r2 + eps * eps;
  let k = f.mu / (s2 * Math.sqrt(s2));
  const t0 = TAPER_START * range;
  if (r > t0) {
    const s = (range - r) / (range - t0);
    k *= s * s * (3 - 2 * s);
  }
  out.x = dx * k;
  out.y = dy * k;
  return Math.hypot(out.x, out.y);
}
