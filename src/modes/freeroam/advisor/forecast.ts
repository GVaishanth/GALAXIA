/**
 * Drift forecast (P05.2): where the ship goes in the next few seconds if the
 * pilot does nothing, and whether a given burn would avoid what it meets.
 *
 * Real physics only. It steps a scratch copy of the ship with the game's own
 * flight code (sim.ts stepShip + the sector's pull in NORMAL,
 * sector/realisticFlight.ts stepRealistic in REALISTIC, STOP included), the
 * sector's real wells, and the same contact test sector/run.ts uses (contact
 * at body radius + ship radius; damage above RUN.impactSpeed). Nothing is
 * invented: if the forecast cannot see a clear line, the advice says so.
 *
 * Never writes its inputs: the ship, STOP state and wells are only read, and
 * every step runs on scratch objects owned by the forecaster (allocated once).
 * Deterministic: no clock, no randomness. Bounded: at most
 * FORECAST.maxTicks steps per run, and at most 1 + candidates runs per call.
 *
 * Simplifications, stated so the advice never claims more: dust drag, ion
 * storms, shear clouds and asteroid rocks are left out of the forecast (they
 * change speed, not where the planets are), and the forecast stops at the
 * first contact it finds.
 */
import { SHIP, stepShip, type ShipState, type ShipTuning } from '../sim.ts';
import { pullOn, freshGravity, type Well } from '../sector/gravityWells.ts';
import type { Landmark } from '../sector/model.ts';
import { createRealisticFlight, freshStationKeeping, stepRealistic, type FlightMode, type StationKeeping } from '../sector/realisticFlight.ts';
import type { VectorControls } from '../sector/vectorFlight.ts';
import type { EscapeKind } from '../crew/observation.ts';

export const FORECAST = Object.freeze({
  /** Hard cap on one forecast run (ticks; 6 s). */
  maxTicks: 360,
  /** A burn counts as clear when nothing is met for this long (s, beyond the warning horizon). */
  clearMarginS: 1,
});

export interface ForecastQuery {
  readonly ship: Readonly<ShipState>;
  readonly mode: FlightMode;
  /** The live STOP state (REALISTIC); copied, never written. */
  readonly stop: Readonly<StationKeeping>;
  /** The ship's own tuning (no boost). */
  readonly tune: ShipTuning;
  readonly wells: readonly Well[];
  readonly bodies: readonly Landmark[];
  readonly width: number;
  readonly height: number;
  readonly impactSpeed: number;
  /** How far ahead to look (ticks, capped at FORECAST.maxTicks). */
  readonly horizonTicks: number;
}

export interface ForecastHit {
  /** Index into `bodies`. */
  readonly body: number;
  readonly ticks: number;
  readonly kind: 'surface' | 'corona';
  /** Closing speed along the contact normal (px/s; surface contacts). */
  readonly speed: number;
}

export interface EscapePlan {
  readonly kind: EscapeKind;
  readonly dx: number;
  readonly dy: number;
  readonly verified: boolean;
}

export interface Forecaster {
  /** Engines idle (STOP as it is now): the first contact within the horizon, or null. */
  coast(q: ForecastQuery): ForecastHit | null;
  /** Try up to `candidates` escape burns in doctrine order; the first that clears is verified, else the first tried is guidance. */
  escape(q: ForecastQuery, hit: ForecastHit, candidates: number, order: 'balanced' | 'safety'): EscapePlan | null;
}

type Burn = { readonly kind: 'idle' } | { readonly kind: 'stop' } | { readonly kind: 'dir'; readonly x: number; readonly y: number };
const IDLE: Burn = Object.freeze({ kind: 'idle' });

export function createForecaster(): Forecaster {
  const s: ShipState = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, px: 0, py: 0, pheading: 0, thrusting: false, thrustX: 0, thrustY: 0 };
  const stop = freshStationKeeping();
  const rf = createRealisticFlight();
  const g = freshGravity();
  const gOut = freshGravity();
  const ctl: { turn: number; thrust: number; reverse: number; pointX: number; pointY: number } = { turn: 0, thrust: 0, reverse: 0, pointX: 0, pointY: 0 };
  const input: { moveX: number; moveY: number } = { moveX: 0, moveY: 0 };
  const mods: { pullX: number; pullY: number } = { pullX: 0, pullY: 0 };
  const noMods = Object.freeze({});
  const inside: boolean[] = [];

  function run(q: ForecastQuery, burn: Burn, ticks: number): ForecastHit | null {
    Object.assign(s, q.ship);
    Object.assign(stop, q.stop);
    if (burn.kind === 'stop') {
      stop.phase = 'braking';
      stop.latch = false;
      stop.ticks = 0;
      stop.satRun = 0;
      stop.saturated = false;
    } else if (burn.kind === 'dir' && q.mode === 'realistic') {
      stop.phase = 'off'; // a burn hands control back, exactly as a movement input releases STOP
    }
    ctl.turn = 0;
    ctl.thrust = 0;
    ctl.reverse = 0;
    ctl.pointX = burn.kind === 'dir' ? burn.x : 0;
    ctl.pointY = burn.kind === 'dir' ? burn.y : 0;
    input.moveX = burn.kind === 'dir' ? burn.x : 0;
    input.moveY = burn.kind === 'dir' ? burn.y : 0;
    // coronas already around the ship at the start are not "ahead" (the observation reports being inside one)
    inside.length = 0;
    for (const l of q.bodies) inside.push(l.hazardR > l.r && Math.hypot(s.x - l.x, s.y - l.y) < l.hazardR);
    const n = Math.min(ticks, FORECAST.maxTicks);
    for (let t = 1; t <= n; t++) {
      if (q.mode === 'realistic') {
        stepRealistic(rf, { ship: s, controls: ctl as VectorControls, base: q.tune, tune: q.tune, mods: noMods, wells: q.wells, lockAim: null, stop, width: q.width, height: q.height, gravityOut: gOut });
      } else {
        const p = pullOn(q.wells, s.x, s.y, q.tune.accel, g);
        mods.pullX = p.x;
        mods.pullY = p.y;
        stepShip(s, input, q.width, q.height, p.g > 0 ? mods : noMods, q.tune);
      }
      for (let i = 0; i < q.bodies.length; i++) {
        const l = q.bodies[i]!;
        const dx = s.x - l.x;
        const dy = s.y - l.y;
        const d = Math.hypot(dx, dy);
        if (d < l.r + q.tune.radius) {
          const speed = d > 0 ? -(s.vx * dx + s.vy * dy) / d : Math.hypot(s.vx, s.vy);
          return { body: i, ticks: t, kind: 'surface', speed };
        }
        if (!inside[i] && l.hazardR > l.r && d < l.hazardR) return { body: i, ticks: t, kind: 'corona', speed: 0 };
      }
    }
    return null;
  }

  /** A contact the pilot should be warned of (a gentle touch below the damage speed is not). */
  const harmful = (h: ForecastHit | null, q: ForecastQuery): boolean => h !== null && (h.kind === 'corona' || h.speed > q.impactSpeed);

  return {
    coast(q) {
      if (!q.wells.length && !q.bodies.length) return null;
      return run(q, IDLE, q.horizonTicks);
    },
    escape(q, hit, candidates, order) {
      const l = q.bodies[hit.body];
      if (!l || candidates <= 0) return null;
      const sh = q.ship;
      let rx = sh.x - l.x;
      let ry = sh.y - l.y;
      const rl = Math.hypot(rx, ry) || 1;
      rx /= rl;
      ry /= rl;
      const sp = Math.hypot(sh.vx, sh.vy);
      const bx = sp > 1 ? -sh.vx / sp : rx;
      const by = sp > 1 ? -sh.vy / sp : ry;
      // the tangent on the side the ship is already sliding past
      const side = sh.vx * -ry + sh.vy * rx >= 0 ? 1 : -1;
      const tx = -ry * side;
      const ty = rx * side;
      const list: { kind: EscapeKind; burn: Burn }[] = [];
      if (q.mode === 'realistic') list.push({ kind: 'stop', burn: { kind: 'stop' } });
      const radial = { kind: 'radial' as const, burn: { kind: 'dir' as const, x: rx, y: ry } };
      const retro = { kind: 'retro' as const, burn: { kind: 'dir' as const, x: bx, y: by } };
      const tangent = { kind: 'tangent' as const, burn: { kind: 'dir' as const, x: tx, y: ty } };
      if (order === 'safety') list.push(radial, retro, tangent);
      else list.push(tangent, radial, retro);
      const ticks = Math.min(FORECAST.maxTicks, q.horizonTicks + Math.round(FORECAST.clearMarginS * 60));
      const tried = list.slice(0, Math.max(1, Math.min(candidates, list.length)));
      for (const c of tried) {
        const h = run(q, c.burn, ticks);
        if (!harmful(h, q)) return { kind: c.kind, dx: c.burn.kind === 'dir' ? c.burn.x : 0, dy: c.burn.kind === 'dir' ? c.burn.y : 0, verified: true };
      }
      // nothing confirmed: the burn straight away from the body is offered as guidance, never as a promise
      return { kind: 'radial', dx: rx, dy: ry, verified: false };
    },
  };
}

/** The default tuning (tests). */
export const FORECAST_TUNE: ShipTuning = SHIP;
