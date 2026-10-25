/**
 * Vector (rotate-and-thrust) flight: the integrator shared by the Gravity
 * Flight lab (gravity/physics.ts, dev / QA builds only) and Free Roam's
 * opt-in REALISTIC flight mode (sector/realisticFlight.ts, P04.3).
 *
 * Moved verbatim from gravity/physics.ts (as the field equation was, FR-TD-86),
 * with one generalisation: gravity comes from a GravitySource sampled at every
 * substep, so the same loop serves the lab's single (optionally moving) body
 * and a production sector's several wells (sector/gravityWells.ts). The lab's
 * `stepVectorFlight(sh, c, body, f, ...)` keeps its exact signature and its
 * exact arithmetic (tests/gravityFlight.test.ts, tests/gravityMeasure.test.ts).
 *
 * Model (docs/freeroam/GRAVITY_FLIGHT_P01.md): position, velocity, facing,
 * engine thrust and gravity are separate; turning never redirects velocity;
 * the engine pushes along the nose; each 1/60 s tick is SUBSTEPS
 * semi-implicit Euler steps; thrust may raise speed only below the rated top
 * speed (gravity is never limited); a safety ceiling only guards numerics.
 * Optional: swept collision with one body (the lab), and a manoeuvre
 * acceleration (REALISTIC's STOP station-keeping) added inside the substeps.
 * Pure: no DOM, no wall clock, no randomness, no allocation per tick.
 */
import { EDGE, headingOf, noseOf, TICK_SECONDS, wrapAngle, type ShipState } from '../sim.ts';
import { gravityAt, type FieldParams, type Vec } from './gravityField.ts';

/** Physics substeps per 1/60 s tick. */
export const SUBSTEPS = 4;
/** Restitution on contact with the body (same value as other sector solids, RUN.restitution). */
export const BODY_RESTITUTION = 0.4;

/** The gravity body at the start of a tick: position, constant velocity and collision radius. */
export interface BodyState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** Physical collision radius (px). Independent of the softening length. */
  readonly r: number;
}

/** Controller-independent intent for the vector (rotate-and-thrust) flight model. */
export interface VectorControls {
  /** Keyboard rotation, -1 (anticlockwise) .. 1 (clockwise). */
  readonly turn: number;
  /** Main engine, 0..1, along the nose. */
  readonly thrust: number;
  /** Reverse thrusters, 0..1, against the nose. */
  readonly reverse: number;
  /** Analog stick (touch or gamepad), |p| <= 1, y down: the nose turns toward it, thrust follows its deflection. */
  readonly pointX: number;
  readonly pointY: number;
  /** Optional aim (mouse aim, right stick): the nose turns toward it. */
  readonly aimX?: number | undefined;
  readonly aimY?: number | undefined;
}

export const NO_CONTROLS: VectorControls = Object.freeze({ turn: 0, thrust: 0, reverse: 0, pointX: 0, pointY: 0 });

export interface FlightParams {
  /** Main engine acceleration (px / s^2). */
  readonly thrust: number;
  /** Reverse thrust as a fraction of the main engine. */
  readonly reverseRatio: number;
  /** Rated top speed (px / s): thrust cannot raise speed above it; gravity can. */
  readonly speedLimit: number;
  /** Keyboard rotation rate (rad / s). */
  readonly turnRate: number;
  /** Rotation rate toward a stick or aim direction (rad / s). */
  readonly pointTurnRate: number;
  /** Gravity Flight Assist corrective thrust on/off. */
  readonly assist: boolean;
  /** Fraction (0..1) of the sideways gravity component the assist cancels while the pilot thrusts. */
  readonly assistStrength: number;
  /** Cap on the assist acceleration (px / s^2). */
  readonly assistMax: number;
  /** Numerical safety ceiling (px / s), far above anything the field can produce. */
  readonly safetySpeed: number;
}

/** What one tick did, quantity by quantity (instrumentation and the HUD read it). */
export interface StepTelemetry {
  /** Gravity at the start of the tick (px / s^2). */
  gx: number;
  gy: number;
  g: number;
  /** Engine acceleration requested this tick (px / s^2) and how much speed it actually added (px / s, signed). */
  ex: number;
  ey: number;
  engine: number;
  /** Assist corrective acceleration (px / s^2), zero when off or not thrusting. */
  ax: number;
  ay: number;
  assist: number;
  /** The engine rule capped the speed this tick. */
  limited: boolean;
  /** Largest impact speed along the contact normal this tick (px / s); 0 = no contact. */
  impact: number;
  /** World position of the last contact (valid when impact > 0). */
  impactX: number;
  impactY: number;
  /** The soft sector edge pushed the ship. */
  pushed: boolean;
}

export function freshTelemetry(): StepTelemetry {
  return { gx: 0, gy: 0, g: 0, ex: 0, ey: 0, engine: 0, ax: 0, ay: 0, assist: 0, limited: false, impact: 0, impactX: 0, impactY: 0, pushed: false };
}

const finite = (n: number | undefined): number => (n !== undefined && Number.isFinite(n) ? n : 0);
const clamp01 = (n: number): number => Math.min(1, Math.max(0, finite(n)));

/**
 * First time t in [0, 1] at which the segment p0 -> p1 (relative to a circle
 * centre) touches a circle of radius R, or -1. A start already inside counts as t = 0.
 */
export function sweepCircle(p0x: number, p0y: number, p1x: number, p1y: number, R: number): number {
  const c = p0x * p0x + p0y * p0y - R * R;
  if (c <= 0) return 0;
  const dx = p1x - p0x;
  const dy = p1y - p0y;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return -1;
  const b = 2 * (p0x * dx + p0y * dy);
  if (b >= 0) return -1; // moving away from (or tangent to) the circle
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

/** Turn the nose toward `want` at most `rate * dt`, the short way round. */
function turnToward(sh: ShipState, want: number, rate: number, dt: number): number {
  const diff = wrapAngle(want - sh.heading);
  const max = Math.max(0, rate) * dt;
  sh.heading = wrapAngle(sh.heading + Math.max(-max, Math.min(max, diff)));
  return wrapAngle(want - sh.heading);
}


/** Gravity for the substep loop: the acceleration at (x, y) at the start of substep k (0..SUBSTEPS-1), written into `out`; returns its magnitude. */
export interface GravitySource {
  sample(x: number, y: number, k: number, out: Vec): number;
}

/**
 * An extra controlled acceleration inside the substeps (REALISTIC STOP): given
 * the state and the gravity just sampled, write the acceleration into `out`.
 * It must respect its own thrust limit; the loop adds it as it adds the engine.
 */
export interface ManoeuvreSource {
  accel(x: number, y: number, vx: number, vy: number, gx: number, gy: number, out: Vec): void;
}

/** The lab's source: one body moving at constant velocity (its position at substep k). */
class BodyGravity implements GravitySource {
  body: BodyState = { x: 0, y: 0, vx: 0, vy: 0, r: 0 };
  field: FieldParams = { mu: 0, softening: 0, range: 1 };
  sample(x: number, y: number, k: number, out: Vec): number {
    const h = TICK_SECONDS / SUBSTEPS;
    return gravityAt(this.body.x + this.body.vx * h * k, this.body.y + this.body.vy * h * k, x, y, this.field, out);
  }
}
const bodyGravity = new BodyGravity();
const gScratch: Vec = { x: 0, y: 0 };
const mScratch: Vec = { x: 0, y: 0 };

/**
 * Advance the ship one fixed tick under the vector flight model: rotation,
 * engine, Gravity Flight Assist, gravity from one body, swept collision with
 * it, and the soft sector edge. `shipRadius` is the ship's collision radius.
 * Writes what happened into `tel`. (The Gravity Flight lab's entry point.)
 */
export function stepVectorFlight(
  sh: ShipState,
  c: VectorControls,
  body: BodyState,
  f: FieldParams,
  p: FlightParams,
  shipRadius: number,
  width: number,
  height: number,
  tel: StepTelemetry,
): { distance: number; pushed: boolean } {
  bodyGravity.body = body;
  bodyGravity.field = f;
  return stepVector(sh, c, p, bodyGravity, body, null, true, shipRadius, width, height, tel);
}

/**
 * The general tick: gravity from `src` (sampled every substep), an optional
 * body for swept collision (null: the caller resolves contacts, as ordinary
 * sectors do in sector/run.ts), an optional manoeuvre acceleration, and
 * `engine` = false to keep the pilot's engine silent this tick (rotation still
 * follows the controls).
 */
export function stepVector(
  sh: ShipState,
  c: VectorControls,
  p: FlightParams,
  src: GravitySource,
  body: BodyState | null,
  manoeuvre: ManoeuvreSource | null,
  engine: boolean,
  shipRadius: number,
  width: number,
  height: number,
  tel: StepTelemetry,
): { distance: number; pushed: boolean } {
  const dt = TICK_SECONDS;
  sh.px = sh.x;
  sh.py = sh.y;
  sh.pheading = sh.heading;

  /* 1. orientation: aim > stick > keyboard rotation. Only pilot input turns the ship. */
  const ax = finite(c.aimX);
  const ay = finite(c.aimY);
  const aiming = Math.hypot(ax, ay) > 1e-6;
  let px = finite(c.pointX);
  let py = finite(c.pointY);
  const pl = Math.hypot(px, py);
  if (pl > 1) {
    px /= pl;
    py /= pl;
  }
  const pointing = pl > 0.25;
  if (aiming) turnToward(sh, headingOf(ax, ay), p.pointTurnRate, dt);
  else if (pointing) turnToward(sh, headingOf(px, py), p.pointTurnRate, dt);
  else sh.heading = wrapAngle(sh.heading + Math.max(-1, Math.min(1, finite(c.turn))) * p.turnRate * dt);
  sh.pheading = sh.heading - wrapAngle(sh.heading - sh.pheading);

  /* 2. engine: keys directly; a stick thrusts with its deflection, only as far as the nose points its way */
  let forward = engine ? clamp01(c.thrust) : 0;
  const reverse = engine ? clamp01(c.reverse) : 0;
  const n = noseOf(sh.heading);
  if (pointing && engine) {
    const align = (px * n.x + py * n.y) / Math.min(1, pl);
    const fromStick = clamp01((Math.min(1, pl) - 0.3) / 0.6) * Math.max(0, align) ** 2;
    forward = Math.max(forward, fromStick);
  }
  const level = forward - reverse * p.reverseRatio;
  const ex = n.x * level * p.thrust;
  const ey = n.y * level * p.thrust;
  const thrusting = Math.abs(level) > 1e-3;
  sh.thrusting = thrusting;
  sh.thrustX = thrusting ? n.x * Math.sign(level) : 0;
  sh.thrustY = thrusting ? n.y * Math.sign(level) : 0;
  // the assist works relative to the pilot's intended direction: the way the engine is pushing
  const ux = thrusting ? n.x * Math.sign(level) : 0;
  const uy = thrusting ? n.y * Math.sign(level) : 0;

  tel.ex = ex;
  tel.ey = ey;
  tel.engine = Math.hypot(ex, ey);
  tel.ax = 0;
  tel.ay = 0;
  tel.assist = 0;
  tel.limited = false;
  tel.impact = 0;
  tel.g = src.sample(sh.x, sh.y, 0, gScratch);
  tel.gx = gScratch.x;
  tel.gy = gScratch.y;

  /* 3. substeps: gravity always, engine + assist under the engine rule, swept collision in the body frame */
  const h = dt / SUBSTEPS;
  const R = body ? body.r + shipRadius : 0;
  let distance = 0;
  for (let k = 0; k < SUBSTEPS; k++) {
    src.sample(sh.x, sh.y, k, gScratch);
    let aax = 0;
    let aay = 0;
    if (p.assist && thrusting && p.assistStrength > 0) {
      // cancel part of the gravity component perpendicular to the pilot's thrust direction; never the part along it
      const along = gScratch.x * ux + gScratch.y * uy;
      const sx = gScratch.x - along * ux;
      const sy = gScratch.y - along * uy;
      aax = -sx * p.assistStrength;
      aay = -sy * p.assistStrength;
      const al = Math.hypot(aax, aay);
      if (al > p.assistMax && al > 0) {
        aax *= p.assistMax / al;
        aay *= p.assistMax / al;
      }
      if (k === 0) {
        tel.ax = aax;
        tel.ay = aay;
        tel.assist = Math.hypot(aax, aay);
      }
    }
    if (manoeuvre) {
      // controlled thrust (STOP): limited by its own authority, added like the engine
      manoeuvre.accel(sh.x, sh.y, sh.vx, sh.vy, gScratch.x, gScratch.y, mScratch);
      aax += mScratch.x;
      aay += mScratch.y;
    }
    const gvx = sh.vx + gScratch.x * h;
    const gvy = sh.vy + gScratch.y * h;
    let vx = gvx + (ex + aax) * h;
    let vy = gvy + (ey + aay) * h;
    const sp = Math.hypot(vx, vy);
    if (thrusting && sp > p.speedLimit) {
      const gs = Math.hypot(gvx, gvy);
      if (sp > gs) {
        const cap = Math.max(gs, p.speedLimit);
        vx *= cap / sp;
        vy *= cap / sp;
        tel.limited = true;
      }
    }
    const sp2 = Math.hypot(vx, vy);
    if (sp2 > p.safetySpeed) {
      vx *= p.safetySpeed / sp2;
      vy *= p.safetySpeed / sp2;
    }
    let nx = sh.x + vx * h;
    let ny = sh.y + vy * h;
    if (body) {
      const bx0 = body.x + body.vx * h * k;
      const by0 = body.y + body.vy * h * k;
      const bx1 = bx0 + body.vx * h;
      const by1 = by0 + body.vy * h;
      const t = sweepCircle(sh.x - bx0, sh.y - by0, nx - bx1, ny - by1, R);
      if (t >= 0) {
        // contact point in the body frame, normal outward; reflect the relative normal velocity
        const rx = sh.x - bx0 + (nx - bx1 - (sh.x - bx0)) * t;
        const ry = sh.y - by0 + (ny - by1 - (sh.y - by0)) * t;
        const rl = Math.hypot(rx, ry);
        const nrx = rl > 1e-9 ? rx / rl : 0;
        const nry = rl > 1e-9 ? ry / rl : -1;
        const rvx = vx - body.vx;
        const rvy = vy - body.vy;
        const vn = rvx * nrx + rvy * nry;
        if (vn < 0) {
          vx = rvx - (1 + BODY_RESTITUTION) * vn * nrx + body.vx;
          vy = rvy - (1 + BODY_RESTITUTION) * vn * nry + body.vy;
          if (-vn > tel.impact) {
            tel.impact = -vn;
            tel.impactX = bx1 + nrx * body.r;
            tel.impactY = by1 + nry * body.r;
          }
        }
        nx = bx1 + nrx * (R + 0.01);
        ny = by1 + nry * (R + 0.01);
      }
    }
    distance += Math.hypot(nx - sh.x, ny - sh.y);
    sh.x = nx;
    sh.y = ny;
    sh.vx = vx;
    sh.vy = vy;
  }

  /* 4. soft sector edge: the same rule as every sector (sim.ts EDGE), once per tick */
  const pushed = edgePush(sh, width, height);
  tel.pushed = pushed;
  return { distance, pushed };
}

/** The sector's soft edge (sim.ts rule), applied once per tick; returns whether it pushed. */
export function edgePush(sh: { x: number; y: number; vx: number; vy: number }, width: number, height: number): boolean {
  const dt = TICK_SECONDS;
  const push = (d: number): number => (d < EDGE.band ? EDGE.push * dt * (1 - d / EDGE.band) : 0);
  const l = push(sh.x);
  const r = push(width - sh.x);
  const t = push(sh.y);
  const b = push(height - sh.y);
  sh.vx += l - r;
  sh.vy += t - b;
  sh.x = Math.min(width, Math.max(0, sh.x));
  sh.y = Math.min(height, Math.max(0, sh.y));
  return l + r + t + b > 0;
}
