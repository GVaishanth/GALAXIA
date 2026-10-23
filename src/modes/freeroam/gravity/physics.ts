/**
 * Gravity Flight prototype P01: physics (pure, deterministic, no DOM, no clock).
 *
 * Only the experimental gravity sector uses this module (gravity/lab.ts plugs it
 * into sector/run.ts through SectorRun.flight). Every other sector keeps the
 * assisted-inertia controller in sim.ts.
 *
 * Model (docs/freeroam/GRAVITY_FLIGHT_P01.md):
 *  - State is separate: position, velocity, facing (heading), engine thrust,
 *    gravitational acceleration and Gravity Flight Assist thrust are distinct
 *    quantities, and each one is reported per tick (StepTelemetry).
 *  - Gravity: a = mu * r / (|r|^2 + eps^2)^(3/2), r pointing from the ship to
 *    the body centre. eps (softening) only removes the singularity at the
 *    centre; the collision radius is separate and is always tested.
 *    Beyond `taperStart * range` the field fades smoothly (smoothstep) to zero
 *    at `range`, so the far sector is unaffected. A central force that depends
 *    only on distance is conservative, so the taper does not create energy.
 *  - Integration: each fixed 1/60 s game tick is split into SUBSTEPS
 *    semi-implicit (symplectic) Euler steps. Unpowered flybys conserve energy
 *    to well under 1% (tests/gravityFlight.test.ts).
 *  - Engine rule: thrust may turn the velocity or reduce speed at any time,
 *    but it can raise speed only while the ship is below its rated top speed.
 *    Gravity is never limited, so a dive can carry the ship above its engine
 *    top speed. A separate safety ceiling (far above anything the configured
 *    field can produce) only guards against numerical blow-ups.
 *  - Collision: every substep is swept against the body's collision circle
 *    (body radius + ship radius) in the body's frame, so no speed can tunnel
 *    through. Contact reflects the normal part of the relative velocity with
 *    the sector's usual restitution.
 *  - Moving body (optional): the body may move at constant velocity (a locally
 *    straight piece of an orbit; the parent star is far outside the sector and
 *    is not simulated). Gravity, collision and prediction all use the body's
 *    position at each substep, so a flyby exchanges energy with it physically.
 *
 * Coordinates are world art px, y down; heading 0 = nose up, clockwise.
 */
import { EDGE, headingOf, noseOf, TICK_SECONDS, wrapAngle, type ShipState } from '../sim.ts';
import { gravityAt, TAPER_START, type FieldParams, type Vec } from '../sector/gravityField.ts';

// The field equation lives in sector/gravityField.ts (shared with ordinary sectors' planet and star pull, FR-TD-86); re-exported unchanged.
export { gravityAt, TAPER_START };
export type { FieldParams, Vec };

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

/** Magnitude of the (tapered) field at distance r. */
function fieldMag(r: number, f: FieldParams): number {
  const range = Math.max(1, f.range);
  if (r >= range || f.mu <= 0) return 0;
  const eps = Math.max(0, f.softening);
  const s2 = r * r + eps * eps;
  let g = (f.mu * r) / (s2 * Math.sqrt(s2));
  const t0 = TAPER_START * range;
  if (r > t0) {
    const s = (range - r) / (range - t0);
    g *= s * s * (3 - 2 * s);
  }
  return g;
}

/** Integral of the field magnitude from a to b (Simpson's rule; the taper is a smooth polynomial blend). */
function fieldIntegral(a: number, b: number, f: FieldParams): number {
  if (b <= a) return 0;
  const n = 32;
  const h = (b - a) / n;
  let sum = fieldMag(a, f) + fieldMag(b, f);
  for (let i = 1; i < n; i++) sum += fieldMag(a + i * h, f) * (i % 2 === 1 ? 4 : 2);
  return (sum * h) / 3;
}

let taperCache = { mu: Number.NaN, softening: Number.NaN, range: Number.NaN, work: 0 };

/**
 * Potential of the actual (tapered) field, px^2/s^2: zero at and beyond the
 * field range, -integral of the field from r to the range inside it. Energy
 * computed with it is what the integrator conserves, and energy >= 0 means the
 * ship reaches the edge of the field (where gravity ends) unpowered.
 */
export function potentialAt(dist: number, f: FieldParams): number {
  const range = Math.max(1, f.range);
  if (dist >= range || f.mu <= 0) return 0;
  const t0 = TAPER_START * range;
  if (dist >= t0) return -fieldIntegral(dist, range, f);
  if (taperCache.mu !== f.mu || taperCache.softening !== f.softening || taperCache.range !== f.range) {
    taperCache = { mu: f.mu, softening: f.softening, range: f.range, work: fieldIntegral(t0, range, f) };
  }
  const eps2 = f.softening * f.softening;
  return -(taperCache.work + f.mu * (1 / Math.sqrt(dist * dist + eps2) - 1 / Math.sqrt(t0 * t0 + eps2)));
}

/** Specific orbital energy relative to the body (tapered field potential): >= 0 means the ship leaves the field unpowered. */
export function orbitalEnergy(x: number, y: number, vx: number, vy: number, b: BodyState, f: FieldParams): number {
  const rvx = vx - b.vx;
  const rvy = vy - b.vy;
  return 0.5 * (rvx * rvx + rvy * rvy) + potentialAt(Math.hypot(x - b.x, y - b.y), f);
}

/** Distance from the field centre where gravity falls to `fraction` of `accel` (untapered; for display and instrumentation). */
export function influenceRadius(f: FieldParams, accel: number, fraction: number): number {
  const a = Math.max(1e-6, accel * fraction);
  return Math.min(f.range, Math.sqrt(Math.max(0, f.mu / a)));
}

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

const gScratch: Vec = { x: 0, y: 0 };

/** Turn the nose toward `want` at most `rate * dt`, the short way round. */
function turnToward(sh: ShipState, want: number, rate: number, dt: number): number {
  const diff = wrapAngle(want - sh.heading);
  const max = Math.max(0, rate) * dt;
  sh.heading = wrapAngle(sh.heading + Math.max(-max, Math.min(max, diff)));
  return wrapAngle(want - sh.heading);
}

/**
 * Advance the ship one fixed tick under the vector flight model: rotation,
 * engine, Gravity Flight Assist, gravity from one body, swept collision with
 * it, and the soft sector edge. `shipRadius` is the ship's collision radius.
 * Writes what happened into `tel`.
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
  let forward = clamp01(c.thrust);
  const reverse = clamp01(c.reverse);
  const n = noseOf(sh.heading);
  if (pointing) {
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
  tel.g = gravityAt(body.x, body.y, sh.x, sh.y, f, gScratch);
  tel.gx = gScratch.x;
  tel.gy = gScratch.y;

  /* 3. substeps: gravity always, engine + assist under the engine rule, swept collision in the body frame */
  const h = dt / SUBSTEPS;
  const R = body.r + shipRadius;
  let distance = 0;
  for (let k = 0; k < SUBSTEPS; k++) {
    const bx0 = body.x + body.vx * h * k;
    const by0 = body.y + body.vy * h * k;
    gravityAt(bx0, by0, sh.x, sh.y, f, gScratch);
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
function edgePush(sh: { x: number; y: number; vx: number; vy: number }, width: number, height: number): boolean {
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

/** Result of a ballistic prediction. Points are written to the caller's buffer as x, y pairs. */
export interface Prediction {
  /** Points written (pairs). */
  count: number;
  /** Seconds until the predicted path touches the collision circle, or -1. */
  impactIn: number;
  /** Closest predicted distance between the ship and the body centre. */
  closest: number;
  /** Seconds covered. */
  seconds: number;
}

export function freshPrediction(): Prediction {
  return { count: 0, impactIn: -1, closest: Infinity, seconds: 0 };
}

/**
 * Ballistic prediction: where the ship goes **if the engines stay off** (the
 * documented prediction model; it never assumes the current thrust continues).
 * Uses the same substep integrator, field, body motion, collision radius and
 * sector edge as the simulation, so with no input the real path follows it
 * exactly. Stops at the first contact. Writes one point every `stride` ticks.
 */
export function predictBallistic(
  x: number,
  y: number,
  vx: number,
  vy: number,
  body: BodyState,
  f: FieldParams,
  shipRadius: number,
  width: number,
  height: number,
  seconds: number,
  stride: number,
  out: Float32Array,
  res: Prediction,
): Prediction {
  const ticks = Math.max(1, Math.round(seconds * 60));
  const h = TICK_SECONDS / SUBSTEPS;
  const R = body.r + shipRadius;
  const s = { x, y, vx, vy };
  const maxPts = Math.floor(out.length / 2);
  res.count = 0;
  res.impactIn = -1;
  res.closest = Math.hypot(x - body.x, y - body.y);
  res.seconds = ticks / 60;
  if (maxPts > 0) {
    out[0] = x;
    out[1] = y;
    res.count = 1;
  }
  for (let tick = 0; tick < ticks; tick++) {
    for (let k = 0; k < SUBSTEPS; k++) {
      const tt = tick * SUBSTEPS + k;
      const bx0 = body.x + body.vx * h * tt;
      const by0 = body.y + body.vy * h * tt;
      gravityAt(bx0, by0, s.x, s.y, f, gScratch);
      s.vx += gScratch.x * h;
      s.vy += gScratch.y * h;
      const nx = s.x + s.vx * h;
      const ny = s.y + s.vy * h;
      const bx1 = bx0 + body.vx * h;
      const by1 = by0 + body.vy * h;
      const hit = sweepCircle(s.x - bx0, s.y - by0, nx - bx1, ny - by1, R);
      if (hit >= 0) {
        const cx = s.x + (nx - s.x) * hit;
        const cy = s.y + (ny - s.y) * hit;
        res.impactIn = (tt + hit) * h;
        res.closest = Math.min(res.closest, R);
        if (res.count < maxPts) {
          out[res.count * 2] = cx;
          out[res.count * 2 + 1] = cy;
          res.count += 1;
        }
        return res;
      }
      s.x = nx;
      s.y = ny;
      res.closest = Math.min(res.closest, Math.hypot(s.x - bx1, s.y - by1));
    }
    edgePush(s, width, height);
    if ((tick + 1) % stride === 0 && res.count < maxPts) {
      out[res.count * 2] = s.x;
      out[res.count * 2 + 1] = s.y;
      res.count += 1;
    }
  }
  return res;
}

/** Coarse escape headings examined (every 15 degrees), then refined around the best. */
export const ESCAPE_CANDIDATES = 24;
/** Refinement halvings around the best coarse heading (15 -> 7.5 -> 3.75 degrees). */
export const ESCAPE_REFINE = 2;
/** The modelled pilot burns once the nose is within this of the suggested heading (rad, 20 degrees). */
export const ESCAPE_BURN_WITHIN = 0.35;
/** Clearance above the collision surface below which a route is penalised (px). */
export const ESCAPE_CLEARANCE = 40;
/** A contact at or above this normal speed counts as hitting the planet (px/s); slower is resting contact. */
export const ESCAPE_CONTACT = 20;

/**
 * What Gravity Flight Assist suggests:
 *  - escape  a heading that reaches the edge of the field (`safeRadius`, moving outward) within the horizon
 *  - climb   no heading gets out within the horizon, but this one does not hit the planet and gains the most energy
 *  - none    every heading examined hits the planet within the horizon (no heading is shown)
 */
export type EscapeStatus = 'escape' | 'climb' | 'none';

export interface EscapeAdvice {
  /** Suggested heading (radians, ship convention), or NaN when `status` is 'none' (or no advice yet). */
  heading: number;
  /** Orbital energy at the end of the suggested route (px^2/s^2). */
  energy: number;
  /** `status === 'escape'` (kept for the overlay and older readers). */
  escapes: boolean;
  status: EscapeStatus;
  /** Seconds to the field edge along the suggestion (escape), else Infinity. */
  time: number;
  /** Lowest altitude above the collision surface along the suggestion (px). */
  clearance: number;
  /** Turn the nose needs from its current facing (rad, signed). */
  turn: number;
  /** Look-ahead the advice was computed over (s); 0 = not computed. */
  horizon: number;
}

export function freshAdvice(): EscapeAdvice {
  return { heading: Number.NaN, energy: -Infinity, escapes: false, status: 'none', time: Infinity, clearance: 0, turn: 0, horizon: 0 };
}

interface Rollout {
  crashed: boolean;
  /** Ticks (fractional) to the field edge, or -1. */
  out: number;
  clearance: number;
  energy: number;
}

const rollProbe: ShipState = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, px: 0, py: 0, pheading: 0 } as ShipState;
const rollTel = freshTelemetry();
const rollBody: { x: number; y: number; vx: number; vy: number; r: number } = { x: 0, y: 0, vx: 0, vy: 0, r: 0 };
const rollCtl = { turn: 0, thrust: 0, reverse: 0, pointX: 0, pointY: 0 };

/**
 * One modelled attempt at a heading from the ship's real state: the nose turns at the keyboard
 * turn rate with the engine off (turning changes facing, not velocity, so gravity keeps acting
 * meanwhile), then burns at full thrust once within ESCAPE_BURN_WITHIN, under the same engine
 * rule, field, body motion, swept collision and sector edge as the game. Bounded by `ticks`.
 */
function rollout(sh: ShipState, heading: number, body: BodyState, f: FieldParams, p: FlightParams, shipRadius: number, width: number, height: number, safeRadius: number, ticks: number, res: Rollout): Rollout {
  Object.assign(rollProbe, sh);
  const R = body.r + shipRadius;
  const b = rollBody;
  Object.assign(b, body);
  res.crashed = false;
  res.out = -1;
  res.clearance = Infinity;
  const ctl = rollCtl;
  let prevD = Math.hypot(sh.x - body.x, sh.y - body.y);
  for (let t = 0; t < ticks; t++) {
    const err = wrapAngle(heading - rollProbe.heading);
    ctl.turn = Math.max(-1, Math.min(1, err / Math.max(1e-6, p.turnRate * TICK_SECONDS)));
    ctl.thrust = Math.abs(err) <= ESCAPE_BURN_WITHIN ? 1 : 0;
    stepVectorFlight(rollProbe, ctl, b, f, p, shipRadius, width, height, rollTel);
    b.x += b.vx * TICK_SECONDS;
    b.y += b.vy * TICK_SECONDS;
    if (rollTel.impact >= ESCAPE_CONTACT) {
      res.crashed = true;
      return res;
    }
    const dx = rollProbe.x - b.x;
    const dy = rollProbe.y - b.y;
    const d = Math.hypot(dx, dy);
    res.clearance = Math.min(res.clearance, d - R);
    if (d >= safeRadius && dx * (rollProbe.vx - b.vx) + dy * (rollProbe.vy - b.vy) > 0) {
      // sub-tick crossing time so nearby headings compare smoothly
      res.out = t + (d > prevD && prevD < safeRadius ? (safeRadius - prevD) / (d - prevD) : 1);
      break;
    }
    prevD = d;
  }
  res.energy = orbitalEnergy(rollProbe.x, rollProbe.y, rollProbe.vx, rollProbe.vy, b, f);
  return res;
}

/** Lower is better: seconds to the field edge plus up to one second for a low pass over the surface. */
const escapeCost = (r: Rollout): number => r.out / 60 + Math.max(0, ESCAPE_CLEARANCE - r.clearance) / ESCAPE_CLEARANCE;

/**
 * An escape search in progress: a snapshot of the state plus the candidates
 * examined so far, so the work can be spread over several ticks (the lab runs
 * a few attempts per tick instead of all of them on one frame).
 */
export interface EscapeSearch {
  readonly ship: ShipState;
  body: BodyState;
  f: FieldParams;
  p: FlightParams;
  shipRadius: number;
  width: number;
  height: number;
  safeRadius: number;
  ticks: number;
  /** Next coarse candidate (0..ESCAPE_CANDIDATES), then refinement steps. */
  next: number;
  /** Centre of the current refinement level. */
  centre: number;
  done: boolean;
  bestEsc: number;
  escHeading: number;
  escOut: number;
  escClear: number;
  escEnergy: number;
  bestClimb: number;
  climbHeading: number;
  climbClear: number;
}

export function createEscapeSearch(): EscapeSearch {
  return {
    ship: { x: 0, y: 0, vx: 0, vy: 0, heading: 0, px: 0, py: 0, pheading: 0, thrusting: false, thrustX: 0, thrustY: 0 },
    body: { x: 0, y: 0, vx: 0, vy: 0, r: 0 },
    f: { mu: 0, softening: 1, range: 0 },
    p: { thrust: 0, reverseRatio: 0, speedLimit: 0, turnRate: 0, pointTurnRate: 0, assist: false, assistStrength: 0, assistMax: 0, safetySpeed: 0 },
    shipRadius: 0,
    width: 0,
    height: 0,
    safeRadius: Infinity,
    ticks: 0,
    next: 0,
    centre: 0,
    done: true,
    bestEsc: Infinity,
    escHeading: Number.NaN,
    escOut: -1,
    escClear: 0,
    escEnergy: -Infinity,
    bestClimb: -Infinity,
    climbHeading: Number.NaN,
    climbClear: 0,
  };
}

/** Start a search from a snapshot of the current state (nothing is evaluated yet). */
export function beginEscapeSearch(s: EscapeSearch, sh: ShipState, body: BodyState, f: FieldParams, p: FlightParams, shipRadius: number, width: number, height: number, seconds: number, safeRadius = Infinity): EscapeSearch {
  Object.assign(s.ship, sh);
  s.body = { x: body.x, y: body.y, vx: body.vx, vy: body.vy, r: body.r };
  s.f = f;
  s.p = { ...p, assist: false };
  s.shipRadius = shipRadius;
  s.width = width;
  s.height = height;
  s.safeRadius = safeRadius;
  s.ticks = Math.max(1, Math.round(seconds * 60));
  s.next = 0;
  s.centre = 0;
  s.done = false;
  s.bestEsc = Infinity;
  s.escHeading = Number.NaN;
  s.escOut = -1;
  s.escClear = 0;
  s.escEnergy = -Infinity;
  s.bestClimb = -Infinity;
  s.climbHeading = Number.NaN;
  s.climbClear = 0;
  return s;
}

const searchRes: Rollout = { crashed: false, out: -1, clearance: 0, energy: 0 };

function consider(s: EscapeSearch, heading: number): void {
  const r = rollout(s.ship, heading, s.body, s.f, s.p, s.shipRadius, s.width, s.height, s.safeRadius, s.ticks, searchRes);
  if (r.crashed) return;
  if (r.out > 0) {
    const c = escapeCost(r);
    if (c < s.bestEsc) {
      s.bestEsc = c;
      s.escHeading = heading;
      s.escOut = r.out;
      s.escClear = r.clearance;
      s.escEnergy = r.energy;
    }
  } else if (r.energy > s.bestClimb) {
    s.bestClimb = r.energy;
    s.climbHeading = heading;
    s.climbClear = r.clearance;
  }
}

/**
 * Run up to `budget` modelled attempts of a search; when it completes, write the
 * advice to `out` and return true. ESCAPE_CANDIDATES coarse headings, then
 * ESCAPE_REFINE halvings (two attempts each) around the best escape.
 */
export function continueEscapeSearch(s: EscapeSearch, budget: number, out: EscapeAdvice): boolean {
  if (s.done) return false;
  const step = (Math.PI * 2) / ESCAPE_CANDIDATES;
  const total = ESCAPE_CANDIDATES + 2 * ESCAPE_REFINE;
  for (let n = 0; n < budget && s.next < total; n++, s.next++) {
    if (s.next < ESCAPE_CANDIDATES) consider(s, s.next * step - Math.PI);
    else {
      if (!Number.isFinite(s.escHeading)) {
        s.next = total;
        break;
      }
      const k = s.next - ESCAPE_CANDIDATES;
      const span = step / 2 / 2 ** (k >> 1);
      // both sides of a refinement level are measured from the best heading at the start of that level
      if ((k & 1) === 0) s.centre = s.escHeading;
      consider(s, wrapAngle(s.centre + ((k & 1) === 0 ? -span : span)));
    }
  }
  if (s.next < total) return false;
  s.done = true;
  if (Number.isFinite(s.escHeading)) {
    out.status = 'escape';
    out.heading = s.escHeading;
    out.energy = s.escEnergy;
    out.time = s.escOut / 60;
    out.clearance = s.escClear;
  } else if (Number.isFinite(s.climbHeading)) {
    out.status = 'climb';
    out.heading = s.climbHeading;
    out.energy = s.bestClimb;
    out.time = Infinity;
    out.clearance = s.climbClear;
  } else {
    out.status = 'none';
    out.heading = Number.NaN;
    out.energy = -Infinity;
    out.time = Infinity;
    out.clearance = 0;
  }
  out.escapes = out.status === 'escape';
  out.horizon = s.ticks / 60;
  out.turn = Number.isFinite(out.heading) ? wrapAngle(out.heading - s.ship.heading) : 0;
  return true;
}

/**
 * Gravity Flight Assist escape suggestion (FR-TD-84, replacing P01's instant-turn energy search),
 * computed in one go (the lab spreads the same search over several ticks).
 * Each candidate heading is tried with `rollout` (the real state, the real turn rate and thrust,
 * the same physics). Prefers the quickest way out of the field that keeps clear of the surface;
 * never a heading whose modelled attempt hits the planet. Reports honestly when nothing gets out
 * ('climb') or everything hits ('none'). Bounded: at most ESCAPE_CANDIDATES + 2 * ESCAPE_REFINE
 * attempts of `seconds` each. Advice only: the ship is never rotated or thrusted by it.
 */
export function suggestEscape(sh: ShipState, body: BodyState, f: FieldParams, p: FlightParams, shipRadius: number, width: number, height: number, seconds: number, out: EscapeAdvice, safeRadius = Infinity): EscapeAdvice {
  const s = beginEscapeSearch(oneShot, sh, body, f, p, shipRadius, width, height, seconds, safeRadius);
  continueEscapeSearch(s, Infinity, out);
  return out;
}
const oneShot = createEscapeSearch();
