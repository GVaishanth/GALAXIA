/**
 * Planet and star pull in ordinary sectors (FR-TD-86, owner request after the
 * first playtest: "I don't feel the gravitational pull").
 *
 * Every landmark (planet-like body or star) of a sector pulls the pilot's ship
 * with the shared field equation (sector/gravityField.ts, the one the Gravity
 * Flight lab uses): a softened inverse-square pull that fades smoothly to zero
 * at the field range. The ship keeps its normal assisted-inertia controls
 * (sim.ts): the pull enters through the existing `pullX / pullY` modifier, the
 * same channel as gravity-shear clouds.
 *
 * Strength per landmark (decided with the owner: "normal controls, stronger
 * pull", about 200 px/s^2 near the surface, always weaker than the engine):
 *  - reference radius: a body's surface; a star's core or half its glow,
 *    whichever is larger (so compact stars still pull across their corona);
 *  - pull at the reference radius: bodies 200, stars 240, black holes 320 px/s^2;
 *  - softening = the landmark's solid radius (below the collision radius, the
 *    lab's own rule), field range = 5 reference radii;
 *  - the summed pull of every landmark is capped at 30% of the ship's own
 *    (unboosted) acceleration, so full thrust always escapes.
 *
 * Only the pilot's ship is pulled: enemy ships, projectiles, the missile and
 * pickups are not (unchanged combat balance). The gravity lab, which runs its
 * own flight hook and planet, turns this off (sector/run.ts).
 * Pure: no DOM, no wall clock, no unseeded randomness.
 */
import { gravityAt, type FieldParams, type Vec } from './gravityField.ts';
import type { Landmark } from './model.ts';

export const GRAVITY = Object.freeze({
  /** Pull at a planet-like body's surface (px/s^2). */
  bodyPull: 200,
  /** Pull at a star's reference radius (px/s^2). */
  starPull: 240,
  /** Pull at a black hole's reference radius (px/s^2). */
  blackHolePull: 320,
  /** A star's reference radius: max(core, this share of its glow). */
  starGlowRef: 0.5,
  /** Field range in reference radii (the field fades to zero there). */
  rangeMul: 5,
  /** The summed pull never exceeds this share of the ship's own acceleration. */
  engineShare: 0.3,
  /** Display: the field ring is drawn where the pull falls to this (px/s^2). */
  feltPull: 40,
  /** Display: the pull arrow at the ship shows above this (px/s^2). */
  arrowPull: 25,
  /** Display: the arrow doubles above this (px/s^2). */
  strongPull: 120,
});

export interface Well {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Solid radius (collision) of the landmark. */
  readonly solid: number;
  /** Reference radius where the pull equals `pull`. */
  readonly ref: number;
  /** Pull at the reference radius (px/s^2). */
  readonly pull: number;
  readonly field: FieldParams;
  /** Distance where the pull falls to GRAVITY.feltPull (the field ring), px. */
  readonly felt: number;
}

/** Live pull on the pilot's ship this tick (rendering, HUD and diagnostics read it; never saved). */
export interface GravityState {
  /** Applied acceleration (after the engine cap), px/s^2. */
  x: number;
  y: number;
  g: number;
  /** The landmark pulling hardest, or null. */
  source: string | null;
}

export const freshGravity = (): GravityState => ({ x: 0, y: 0, g: 0, source: null });

const tmp: Vec = { x: 0, y: 0 };

/** Distance from the centre where the (tapered) pull falls to `pull`; searched outward from the reference radius. */
function feltRadius(w: Omit<Well, 'felt'>, pull: number): number {
  if (w.pull <= pull) return w.ref;
  let lo = w.ref;
  let hi = w.field.range;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (gravityAt(0, 0, mid, 0, w.field, tmp) > pull) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function wellOf(l: Landmark): Well {
  const star = l.kind === 'star';
  const ref = star ? Math.max(l.r, l.hazardR * GRAVITY.starGlowRef) : l.r;
  const pull = !star ? GRAVITY.bodyPull : l.style === 'black-hole' ? GRAVITY.blackHolePull : GRAVITY.starPull;
  const eps = l.r;
  const s2 = ref * ref + eps * eps;
  const field: FieldParams = { mu: (pull * s2 * Math.sqrt(s2)) / ref, softening: eps, range: ref * GRAVITY.rangeMul };
  const w = { id: l.id, x: l.x, y: l.y, solid: l.r, ref, pull, field };
  return Object.freeze({ ...w, felt: feltRadius(w, GRAVITY.feltPull) });
}

export function wellsOf(landmarks: readonly Landmark[]): readonly Well[] {
  return Object.freeze(landmarks.map(wellOf));
}

/**
 * Pull on a ship at (x, y): the sum over every well, capped at
 * `engineShare * accel`. Writes the result into `out` and returns it.
 */
export function pullOn(wells: readonly Well[], x: number, y: number, accel: number, out: GravityState): GravityState {
  let gx = 0;
  let gy = 0;
  let best = 0;
  let source: string | null = null;
  for (const w of wells) {
    const g = gravityAt(w.x, w.y, x, y, w.field, tmp);
    if (g <= 0) continue;
    gx += tmp.x;
    gy += tmp.y;
    if (g > best) {
      best = g;
      source = w.id;
    }
  }
  let g = Math.hypot(gx, gy);
  const cap = GRAVITY.engineShare * Math.max(0, accel);
  if (g > cap) {
    const k = g > 0 ? cap / g : 0;
    gx *= k;
    gy *= k;
    g = cap;
  }
  out.x = gx;
  out.y = gy;
  out.g = g;
  out.source = g > 0 ? source : null;
  return out;
}
