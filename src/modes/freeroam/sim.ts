/**
 * Free Roam ship physics (pure, deterministic): fixed 1/60 s steps, no DOM, no
 * clock, no camera. Since Prompt 6 the flight takes place in a generated local
 * sector (sector/run.ts); this module keeps only what any sector needs: the
 * ship pose, assisted-inertia movement, the soft sector edge and the nose.
 *
 * Movement model (Prompt 7, FR-TD-40): **assisted inertia**. The stick or
 * keys push the ship toward the input direction; drag always slows it, more
 * strongly when there is no input, so the ship comes to rest by itself in
 * under a second. Thrust against the current motion is boosted, so turning
 * around is snappy instead of a long Newtonian loop. All numbers live in a
 * `ShipTuning` object (acceleration, maximum speed, damping, turn rates), so
 * ships and hazards can tune the feel without new code.
 *
 * Orientation rule (FR-TD-41): the nose turns toward the **aim** when an aim
 * is given (mouse aim, gamepad right stick), otherwise toward the **direction
 * of travel** (or the input when nearly stopped). It turns at a capped rate
 * (`turnRate` / `aimTurnRate` rad/s), never jumps, and crosses the ±π seam
 * the short way. Shots and the engine flame are derived from the same heading
 * (`noseOf`), so they always agree with the drawn ship.
 *
 * Coordinates are art px (same density as Classic); heading 0 = nose up,
 * positive = clockwise (canvas y points down).
 */

export interface ShipTuning {
  /** Thrust acceleration at full input, art px / s^2. */
  readonly accel: number;
  /** Speed cap, art px / s. */
  readonly maxSpeed: number;
  /** Damping per second while thrusting. */
  readonly drag: number;
  /** Damping per second without input (how fast the ship settles). */
  readonly brakeDrag: number;
  /** Extra thrust multiplier for input that opposes the current motion. */
  readonly reverseBoost: number;
  /** Nose turn rate following the travel direction, rad / s. */
  readonly turnRate: number;
  /** Nose turn rate following an aim (mouse / right stick), rad / s. */
  readonly aimTurnRate: number;
  /** Collision radius, art px. */
  readonly radius: number;
}

export const SHIP: ShipTuning = Object.freeze({ accel: 1150, maxSpeed: 340, drag: 1.4, brakeDrag: 3.2, reverseBoost: 1.8, turnRate: 9, aimTurnRate: 16, radius: 12 });

/** Soft sector edge: inside this band the ship is pushed back toward the sector. */
export const EDGE = Object.freeze({ band: 140, push: 1400 });

export const TICK_SECONDS = 1 / 60;

/** Below this speed the nose follows the input instead of the (tiny) velocity. */
const FACE_VELOCITY_MIN = 24;

export type FreeRoamPhase = 'briefing' | 'flight' | 'paused' | 'complete';

export interface ShipState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  /** Previous-tick pose, for render interpolation. */
  px: number;
  py: number;
  pheading: number;
  thrusting: boolean;
  /** Applied input this tick (unit disc), for the engine flame. */
  thrustX: number;
  thrustY: number;
}

/**
 * Controller-independent flight intent for one tick. Keys, touch, gamepad and
 * mouse are all reduced to this before the simulation sees them.
 */
export interface FlightInput {
  /** Analog movement, |(moveX, moveY)| <= 1, y down. */
  readonly moveX: number;
  readonly moveY: number;
  /** Optional aim direction (any length > 0); the nose turns toward it instead of the travel direction. */
  readonly aimX?: number | undefined;
  readonly aimY?: number | undefined;
}

/** Per-tick environment modifiers (hazard regions); all default to "none". */
export interface ShipModifiers {
  /** Multiplies the maximum speed (ion storms). */
  readonly speedMul?: number | undefined;
  /** Extra drag per second (dust). */
  readonly extraDrag?: number | undefined;
  /** Acceleration added this tick, art px / s^2 (gravity shear). */
  readonly pullX?: number | undefined;
  readonly pullY?: number | undefined;
}

export function freshShip(x: number, y: number, heading = 0): ShipState {
  return { x, y, vx: 0, vy: 0, heading, px: x, py: y, pheading: heading, thrusting: false, thrustX: 0, thrustY: 0 };
}

export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Unit vector the nose points along (heading 0 = up). Shots and the flame use this. */
export function noseOf(heading: number): { readonly x: number; readonly y: number } {
  return { x: Math.sin(heading), y: -Math.cos(heading) };
}

/** Heading that points along (dx, dy); 0 for a zero vector. */
export function headingOf(dx: number, dy: number): number {
  return dx === 0 && dy === 0 ? 0 : Math.atan2(dx, -dy);
}

const finite = (n: number | undefined): number => (n !== undefined && Number.isFinite(n) ? n : 0);

/**
 * Advance the ship one fixed tick inside a `width` x `height` sector.
 * Returns the distance flown and whether the soft edge pushed the ship.
 */
export function stepShip(sh: ShipState, input: FlightInput, width: number, height: number, mods: ShipModifiers = {}, tune: ShipTuning = SHIP): { distance: number; pushed: boolean } {
  const dt = TICK_SECONDS;
  sh.px = sh.x;
  sh.py = sh.y;
  sh.pheading = sh.heading;

  // intent: clamp to the unit disc (defensive: input is already normalised)
  let ix = finite(input.moveX);
  let iy = finite(input.moveY);
  const il = Math.hypot(ix, iy);
  if (il > 1) {
    ix /= il;
    iy /= il;
  }
  sh.thrusting = il > 0.05;
  sh.thrustX = sh.thrusting ? ix : 0;
  sh.thrustY = sh.thrusting ? iy : 0;

  // assisted inertia: thrust toward the input (boosted against the motion), drag always, stronger when coasting
  const speed0 = Math.hypot(sh.vx, sh.vy);
  const opposing = sh.thrusting && speed0 > 1 ? Math.max(0, -(ix * sh.vx + iy * sh.vy) / (Math.min(1, il) * speed0)) : 0;
  const boost = 1 + (tune.reverseBoost - 1) * opposing;
  sh.vx += (ix * tune.accel * boost + finite(mods.pullX)) * dt;
  sh.vy += (iy * tune.accel * boost + finite(mods.pullY)) * dt;
  const drag = Math.exp(-((sh.thrusting ? tune.drag : tune.brakeDrag) + Math.max(0, finite(mods.extraDrag))) * dt);
  sh.vx *= drag;
  sh.vy *= drag;

  // soft sector edge: push grows linearly from 0 at the inner edge of the band to full at the boundary
  const push = (d: number): number => (d < EDGE.band ? EDGE.push * dt * (1 - d / EDGE.band) : 0);
  const pl = push(sh.x);
  const pr = push(width - sh.x);
  const pt = push(sh.y);
  const pb = push(height - sh.y);
  sh.vx += pl - pr;
  sh.vy += pt - pb;

  const max = tune.maxSpeed * Math.min(1, Math.max(0.2, mods.speedMul ?? 1));
  const speed = Math.hypot(sh.vx, sh.vy);
  if (speed > max) {
    sh.vx *= max / speed;
    sh.vy *= max / speed;
  }
  sh.x = Math.min(width, Math.max(0, sh.x + sh.vx * dt));
  sh.y = Math.min(height, Math.max(0, sh.y + sh.vy * dt));

  // orientation: the aim if there is one, else the direction of travel (or the input when nearly stopped)
  const ax = finite(input.aimX);
  const ay = finite(input.aimY);
  const aiming = Math.hypot(ax, ay) > 1e-6;
  const v = Math.hypot(sh.vx, sh.vy);
  const fx = aiming ? ax : v > FACE_VELOCITY_MIN ? sh.vx : ix;
  const fy = aiming ? ay : v > FACE_VELOCITY_MIN ? sh.vy : iy;
  if (Math.hypot(fx, fy) > 0.01) {
    const diff = wrapAngle(headingOf(fx, fy) - sh.heading);
    const maxTurn = (aiming ? tune.aimTurnRate : tune.turnRate) * dt;
    sh.heading = wrapAngle(sh.heading + Math.max(-maxTurn, Math.min(maxTurn, diff)));
    // keep interpolation continuous across the ±π seam
    sh.pheading = sh.heading - wrapAngle(sh.heading - sh.pheading);
  }
  return { distance: Math.min(v, max) * dt, pushed: pl + pr + pt + pb > 0 };
}
