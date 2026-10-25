/**
 * P04.3: Free Roam's opt-in REALISTIC flight mode and its STOP control.
 *
 * NORMAL (the default) is untouched: sector/run.ts keeps calling sim.ts
 * stepShip with the planet / star pull as a modifier, exactly as before.
 * REALISTIC replaces only that one movement call, inside the same fixed tick:
 *
 *  - Flight model: the Gravity Flight experiment's vector (rotate-and-thrust)
 *    integrator, sector/vectorFlight.ts (moved out of the lab, not copied):
 *    velocity persists, turning never redirects it, the engine pushes along
 *    the nose, releasing the controls never slows the ship, and thrust may raise
 *    speed only below the ship's top speed (gravity is not limited).
 *  - Ship stats: thrust = the ship's own acceleration x THRUST_SHARE (the lab's
 *    tuned 450 px/s^2 for the 1150 px/s^2 reference hull), boost scales it like
 *    the normal controller; the top speed is the ship's (boosted) top speed
 *    under ion storms' speed factor; key rotation scales with the ship's turn rate.
 *  - Gravity: the sector's real wells (sector/gravityWells.ts pullOn, the same
 *    capped field NORMAL feels, built from the layout's planets and stars) plus
 *    gravity-shear clouds, sampled at every substep (stable at speed and close
 *    in). Dust clouds add their drag. No other force; no lab planet, scenario,
 *    assist or diagnostic. Collisions stay with sector/run.ts (the same rule as
 *    NORMAL), so nothing passes through a body.
 *
 * STOP (REALISTIC only): a flight computer that first brakes (a visible,
 * thrust-limited deceleration, never a one-frame stop), then holds the point
 * where the ship came to rest with a critically damped position controller and
 * gravity feed-forward. Its thrust is limited to the ship's main-engine thrust
 * (unboosted) in any direction; it never turns the nose (aim and the target
 * lock keep sole charge of facing), never fires, never touches collisions,
 * gravity, damage or position. When the local pull is stronger than that
 * thrust it says so (CAN'T HOLD) instead of claiming to hold. Thrust, brake or
 * stick input hands control back at once with the velocity the ship really
 * has (a key already held when STOP was pressed is ignored until released).
 * It is cleared on a mode change, docking, recall (death / restart), survey
 * completion, ship change and every new sector run; it is never saved.
 *
 * Pure: no DOM, no wall clock, no randomness, no allocation per tick.
 */
import { SHIP, TICK_SECONDS, type ShipModifiers, type ShipState, type ShipTuning } from '../sim.ts';
import type { Vec } from './gravityField.ts';
import { freshGravity, pullOn, type GravityState, type Well } from './gravityWells.ts';
import { freshTelemetry, stepVector, type FlightParams, type GravitySource, type ManoeuvreSource, type StepTelemetry, type VectorControls } from './vectorFlight.ts';

export type FlightMode = 'normal' | 'realistic';
export const FLIGHT_MODES: readonly FlightMode[] = Object.freeze(['normal', 'realistic']);
export const DEFAULT_FLIGHT_MODE: FlightMode = 'normal';
export const isFlightMode = (v: unknown): v is FlightMode => v === 'normal' || v === 'realistic';

/** Settings and guide texts (one copy, P04.3). */
export const FLIGHT_MODE_TEXT = Object.freeze({
  normal: "Standard flight behaviour. Uses GALAXIA's current flight controls.",
  realistic: 'Momentum-based flight. Your ship keeps drifting when thrust is released. Gravity affects your trajectory.',
  stop: 'STOP: brake your ship, then use station-keeping to hold position against momentum and gravity. It is active thrust, not paused physics: a strong enough pull can overpower it.',
  stopNormal: 'STOP is available in REALISTIC flight only.',
});

export const REALISTIC = Object.freeze({
  /** Main engine thrust as a share of the ship's acceleration stat (the lab's 450 px/s^2 on the 1150 px/s^2 reference hull). */
  thrustShare: 450 / 1150,
  /** Reverse thrusters (S / down) as a share of the main engine (the lab's value). */
  reverseRatio: 0.55,
  /** Key rotation (rad/s) for the reference hull's turn rate; other hulls scale with theirs. */
  turnRate: 4.2,
  /** Numerical safety ceiling (px/s): far above what the capped pull and the engines can produce. */
  safetySpeed: 1500,
});

export const STOP = Object.freeze({
  /** STOP thrust limit, as a share of the main engine thrust (unboosted), in any direction. */
  authority: 1,
  /** Braking command -v / tau (s): with the thrust limit it is a constant full deceleration until slow. */
  brakeTau: 0.12,
  /** Below this speed (px/s) the brake hands over to holding the point the ship came to rest at. */
  stopSpeed: 6,
  /** Hold controller natural frequency (rad/s); critically damped, so it settles without oscillating. */
  omega: 2.5,
  /** "HOLDING POSITION" is shown only within this distance of the hold point (px). */
  tolerance: 16,
  /** Ticks of saturation before CAN'T HOLD shows (and the same back to clear it): no flicker. */
  satTicks: 12,
  /** A stick past this deflection is a movement command (it starts turning the ship). */
  stickMove: 0.25,
  /** Keys and triggers past this level are movement commands. */
  keyMove: 0.05,
});

export type StopPhase = 'off' | 'braking' | 'holding';
/** What the HUD shows: STOP (available) / STOPPING / HOLDING POSITION / CAN'T HOLD. */
export type StopDisplay = 'off' | 'stopping' | 'holding' | 'cannot';

/** STOP state of one run (never saved). */
export interface StationKeeping {
  phase: StopPhase;
  /** The point being held (valid while holding). */
  holdX: number;
  holdY: number;
  /** A movement input was already held when STOP engaged: ignored (engine silent) until released. */
  latch: boolean;
  /** Distance from the hold point after the last tick (px); 0 while braking or off. */
  error: number;
  /** Consecutive-saturation counter (hysteresis for `saturated`). */
  satRun: number;
  /** The local pull (or a push) needs more thrust than STOP has: shown as CAN'T HOLD. */
  saturated: boolean;
  /** Ticks since STOP engaged (diagnostics, tests). */
  ticks: number;
}

export const freshStationKeeping = (): StationKeeping => ({ phase: 'off', holdX: 0, holdY: 0, latch: false, error: 0, satRun: 0, saturated: false, ticks: 0 });

/** Turn STOP off and forget the hold point (no force is left behind: the controller only acts while engaged). */
export function clearStationKeeping(s: StationKeeping): void {
  s.phase = 'off';
  s.holdX = 0;
  s.holdY = 0;
  s.latch = false;
  s.error = 0;
  s.satRun = 0;
  s.saturated = false;
  s.ticks = 0;
}

export function stopDisplay(s: StationKeeping): StopDisplay {
  if (s.phase === 'off') return 'off';
  if (s.saturated) return 'cannot';
  if (s.phase === 'braking') return 'stopping';
  return s.error <= STOP.tolerance ? 'holding' : 'stopping';
}

/** Is this a movement or thrust command (STOP hands back)? Rotation keys alone and aim are not: they only turn the nose. */
export function vectorMoving(c: VectorControls): boolean {
  const n = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) ? v : 0);
  return n(c.thrust) > STOP.keyMove || n(c.reverse) > STOP.keyMove || Math.hypot(n(c.pointX), n(c.pointY)) > STOP.stickMove;
}

export type StopChange = 'engaged' | 'released' | 'cancelled' | null;

/**
 * Apply this tick's STOP input before the flight step: the toggle (engage /
 * release) and the hand-back on a new movement command. Returns what changed.
 */
export function updateStationKeeping(s: StationKeeping, toggle: boolean, moving: boolean): StopChange {
  if (toggle) {
    if (s.phase === 'off') {
      clearStationKeeping(s);
      s.phase = 'braking';
      s.latch = moving;
      return 'engaged';
    }
    clearStationKeeping(s);
    return 'released';
  }
  if (s.phase === 'off') return null;
  if (!moving) {
    s.latch = false;
    return null;
  }
  if (s.latch) return null;
  clearStationKeeping(s);
  return 'cancelled';
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The sector's wells (+ shear clouds) as the substep gravity source: the same capped field NORMAL applies. */
class WellGravity implements GravitySource {
  wells: readonly Well[] = [];
  /** Ship acceleration the pull cap is taken from (unboosted, as in NORMAL). */
  accel = 0;
  shearX = 0;
  shearY = 0;
  private readonly g: GravityState = freshGravity();
  sample(x: number, y: number, _k: number, out: Vec): number {
    pullOn(this.wells, x, y, this.accel, this.g);
    out.x = this.g.x + this.shearX;
    out.y = this.g.y + this.shearY;
    return Math.hypot(out.x, out.y);
  }
}

/** STOP's controller, evaluated inside every substep with the gravity just sampled. */
class StopController implements ManoeuvreSource {
  s: StationKeeping = freshStationKeeping();
  /** Thrust limit this tick (px/s^2). */
  limit = 0;
  /** Some substep this tick needed more than `limit`. */
  saturatedTick = false;
  accel(x: number, y: number, vx: number, vy: number, gx: number, gy: number, out: Vec): void {
    const s = this.s;
    let ax: number;
    let ay: number;
    if (s.phase === 'braking') {
      // cancel the pull and take the velocity down at full thrust (the command saturates until slow)
      ax = -gx - vx / STOP.brakeTau;
      ay = -gy - vy / STOP.brakeTau;
      if (Math.hypot(gx, gy) >= this.limit * 0.98) this.saturatedTick = true;
    } else {
      const w = STOP.omega;
      ax = -gx + w * w * (s.holdX - x) - 2 * w * vx;
      ay = -gy + w * w * (s.holdY - y) - 2 * w * vy;
    }
    const m = Math.hypot(ax, ay);
    if (m > this.limit) {
      const k = m > 0 ? this.limit / m : 0;
      ax *= k;
      ay *= k;
      if (s.phase === 'holding') this.saturatedTick = true;
    }
    out.x = ax;
    out.y = ay;
  }
}

/** Per-run scratch of the REALISTIC step (built once per run; nothing is allocated per tick). */
export interface RealisticFlight {
  readonly gravity: WellGravity;
  readonly stop: StopController;
  readonly params: Mutable<FlightParams>;
  readonly controls: Mutable<VectorControls>;
  readonly tel: StepTelemetry;
}

export function createRealisticFlight(): RealisticFlight {
  return {
    gravity: new WellGravity(),
    stop: new StopController(),
    params: { thrust: 0, reverseRatio: REALISTIC.reverseRatio, speedLimit: 0, turnRate: REALISTIC.turnRate, pointTurnRate: SHIP.turnRate, assist: false, assistStrength: 0, assistMax: 0, safetySpeed: REALISTIC.safetySpeed },
    controls: { turn: 0, thrust: 0, reverse: 0, pointX: 0, pointY: 0, aimX: undefined, aimY: undefined },
    tel: freshTelemetry(),
  };
}

/** The ship's REALISTIC engine thrust (px/s^2) for a tuning. */
export const realisticThrust = (tune: ShipTuning): number => tune.accel * REALISTIC.thrustShare;
/** STOP's thrust limit (px/s^2): the unboosted main engine. */
export const stopLimit = (base: ShipTuning): number => realisticThrust(base) * STOP.authority;

export interface RealisticStepArgs {
  readonly ship: ShipState;
  readonly controls: VectorControls;
  /** The ship's own tuning (gravity cap, STOP limit, turn rates). */
  readonly base: ShipTuning;
  /** This tick's tuning (boost applied). */
  readonly tune: ShipTuning;
  readonly mods: ShipModifiers;
  readonly wells: readonly Well[];
  /** The ship-lock aim (P04.1), or null: it replaces mouse aim / right stick, exactly as in NORMAL. */
  readonly lockAim: { readonly x: number; readonly y: number } | null;
  readonly stop: StationKeeping;
  readonly width: number;
  readonly height: number;
  /** Written: the pull at the ship (HUD / render read it, as in NORMAL). */
  readonly gravityOut: GravityState;
}

/** One REALISTIC tick of ship movement (replaces sim.ts stepShip; collisions follow in sector/run.ts). */
export function stepRealistic(rf: RealisticFlight, a: RealisticStepArgs): { distance: number; pushed: boolean } {
  const sh = a.ship;
  const p = rf.params;
  p.thrust = realisticThrust(a.tune);
  const speedMul = a.mods.speedMul !== undefined && Number.isFinite(a.mods.speedMul) ? a.mods.speedMul : 1;
  p.speedLimit = a.tune.maxSpeed * Math.max(0, Math.min(1, speedMul));
  p.turnRate = REALISTIC.turnRate * (a.base.turnRate / SHIP.turnRate);
  p.pointTurnRate = a.base.turnRate;
  const c = rf.controls;
  c.turn = a.controls.turn;
  c.thrust = a.controls.thrust;
  c.reverse = a.controls.reverse;
  c.pointX = a.controls.pointX;
  c.pointY = a.controls.pointY;
  // one orientation rule: a held lock is the aim (as in NORMAL), else mouse aim / right stick
  c.aimX = a.lockAim ? a.lockAim.x : a.controls.aimX;
  c.aimY = a.lockAim ? a.lockAim.y : a.controls.aimY;

  const g = rf.gravity;
  g.wells = a.wells;
  g.accel = a.base.accel;
  g.shearX = a.mods.pullX !== undefined && Number.isFinite(a.mods.pullX) ? a.mods.pullX : 0;
  g.shearY = a.mods.pullY !== undefined && Number.isFinite(a.mods.pullY) ? a.mods.pullY : 0;
  // the HUD pull at the ship: the planet / star field only, exactly as NORMAL reports it
  pullOn(a.wells, sh.x, sh.y, a.base.accel, a.gravityOut);

  // dust clouds: their drag acts on the drifting ship too
  const drag = a.mods.extraDrag ?? 0;
  if (drag > 0) {
    const k = Math.exp(-drag * TICK_SECONDS);
    sh.vx *= k;
    sh.vy *= k;
  }

  const s = a.stop;
  const on = s.phase !== 'off';
  const ctl = rf.stop;
  ctl.s = s;
  ctl.limit = stopLimit(a.base);
  ctl.saturatedTick = false;
  // while STOP flies the ship the pilot's engine is silent (a key held from before STOP is ignored until released)
  const moved = stepVector(sh, c, p, g, null, on ? ctl : null, !on, a.base.radius, a.width, a.height, rf.tel);
  if (on) afterStopTick(s, sh, ctl.saturatedTick);
  return moved;
}

function afterStopTick(s: StationKeeping, sh: ShipState, saturated: boolean): void {
  s.ticks += 1;
  s.satRun = saturated ? Math.min(s.satRun + 1, 2 * STOP.satTicks) : Math.max(0, s.satRun - 1);
  if (s.satRun >= STOP.satTicks) s.saturated = true;
  else if (s.satRun === 0) s.saturated = false;
  if (s.phase === 'braking' && !saturated && Math.hypot(sh.vx, sh.vy) < STOP.stopSpeed) {
    // at rest (within the threshold): hold this point; the controller removes the last few px/s smoothly
    s.phase = 'holding';
    s.holdX = sh.x;
    s.holdY = sh.y;
  }
  s.error = s.phase === 'holding' ? Math.hypot(sh.x - s.holdX, sh.y - s.holdY) : 0;
}

/**
 * Map the shared movement inputs onto rotate-and-thrust controls (the lab's
 * mapping, now in production): left / right keys rotate, up thrusts, down fires
 * the reverse thrusters; a stick (touch or pad) points the nose and thrusts with
 * its deflection once aligned; aim (mouse / right stick) turns the nose.
 * `moveY` carries "thrust held" for the existing boost rule.
 */
export function realisticInput(keys: { readonly x: number; readonly y: number }, stick: { readonly x: number; readonly y: number }, aim: { readonly x: number; readonly y: number } | null): { moveX: number; moveY: number; vector: VectorControls } {
  const turn = keys.x > 0.1 ? 1 : keys.x < -0.1 ? -1 : 0;
  const thrust = keys.y < -0.1 ? 1 : 0;
  const reverse = keys.y > 0.1 ? 1 : 0;
  const sl = Math.hypot(stick.x, stick.y);
  const sx = sl > 1 ? stick.x / sl : stick.x;
  const sy = sl > 1 ? stick.y / sl : stick.y;
  const vector: VectorControls = aim ? { turn, thrust, reverse, pointX: sx, pointY: sy, aimX: aim.x, aimY: aim.y } : { turn, thrust, reverse, pointX: sx, pointY: sy };
  const level = Math.max(thrust, reverse, Math.min(1, sl) > 0.3 ? 1 : 0);
  return { moveX: 0, moveY: -level, vector };
}
