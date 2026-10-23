/**
 * Gravity Flight prototype P01 (FR-TD-83): physics, Gravity Flight Assist,
 * slingshot behaviour, the pursuing interceptor and the isolation of the
 * experiment. Simulated tests only (no browser, no device); the measured
 * values print with GRAVITY_REPORT=1.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FixedStepClock } from '../src/core/clock.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { FAMILIES } from '../src/modes/freeroam/combat/families.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { DEFAULT_PARAMS, gravityLabLayout, LAB_SAVE, LAB_SYSTEM_ID, LAB_SECTOR, PARAM_SPECS, sanitizeParams, scenarioStart, type LabParams, type ScenarioId } from '../src/modes/freeroam/gravity/config.ts';
import { ADVISE_BUDGET, ADVISE_EVERY, ADVISE_SECONDS, applyScenario, createGravityLab, fieldOf, flightOf, installGravityLab, PREDICT_EVERY, setLabParams, surfacePullRatio, type GravityLab, type PassRecord } from '../src/modes/freeroam/gravity/lab.ts';
import {
  freshPrediction,
  freshTelemetry,
  gravityAt,
  NO_CONTROLS,
  orbitalEnergy,
  predictBallistic,
  stepVectorFlight,
  suggestEscape,
  freshAdvice,
  influenceRadius,
  ESCAPE_CANDIDATES,
  ESCAPE_REFINE,
  sweepCircle,
  type BodyState,
  type FieldParams,
  type FlightParams,
  type VectorControls,
} from '../src/modes/freeroam/gravity/physics.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, stepSector, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import { sweptHit } from '../src/modes/freeroam/combat/world.ts';
import { spawnShot } from '../src/modes/freeroam/combat/projectiles.ts';
import { flyC, input as pilotInput, mean, startC, starts, STRATEGIES, strategy, type RunResult } from './helpers/gravityPilots.ts';
import { freshShip, noseOf, SHIP, type ShipState } from '../src/modes/freeroam/sim.ts';

const REPORT = process.env['GRAVITY_REPORT'] === '1';
const report = (label: string, v: unknown): void => {
  if (REPORT) console.log(`[gravity] ${label}: ${JSON.stringify(v)}`);
};
const r1 = (n: number): number => Math.round(n * 10) / 10;

const graph = buildNavGraph();
const SOL = getCatalogue().systems.find((s) => s.id === LAB_SYSTEM_ID)!;
const SOL_LAYOUT: SectorLayout = generateSector(SOL, sectorContext(graph, LAB_SYSTEM_ID));

const F: FieldParams = { mu: DEFAULT_PARAMS.mu, softening: DEFAULT_PARAMS.softening, range: DEFAULT_PARAMS.range };
const BODY: BodyState = { x: 2300, y: 1400, vx: 0, vy: 0, r: 120 };
const W = LAB_SECTOR.width;
const H = LAB_SECTOR.height;
const SR = SHIP.radius;
const P: FlightParams = {
  thrust: 380,
  reverseRatio: 0.55,
  speedLimit: 340,
  turnRate: 4.2,
  pointTurnRate: 9,
  assist: false,
  assistStrength: 0.6,
  assistMax: 190,
  safetySpeed: 2400,
};
const NONE: FieldParams = { mu: 0, softening: 30, range: 1400 };
const FAR: BodyState = { x: -1e6, y: -1e6, vx: 0, vy: 0, r: 1 };
const ctl = (c: Partial<VectorControls>): VectorControls => ({ ...NO_CONTROLS, ...c });

function ship(x: number, y: number, vx: number, vy: number, heading = 0): ShipState {
  const s = freshShip(x, y, heading);
  s.vx = vx;
  s.vy = vy;
  return s;
}

/** Fly `ticks` ticks of the bare vector model; returns min distance to the body centre. */
function fly(s: ShipState, ticks: number, c: VectorControls = NO_CONTROLS, b: BodyState = BODY, f: FieldParams = F, p: FlightParams = P, each?: (t: number) => void): number {
  const tel = freshTelemetry();
  let min = Infinity;
  for (let t = 0; t < ticks; t++) {
    stepVectorFlight(s, c, b, f, p, SR, W, H, tel);
    min = Math.min(min, Math.hypot(s.x - b.x, s.y - b.y));
    each?.(t);
  }
  return min;
}

/** A lab run in the experimental sector. */
function labRun(scenario: ScenarioId, params: Partial<LabParams> = {}, seed = 7): { run: SectorRun; lab: GravityLab } {
  const p = sanitizeParams({ ...DEFAULT_PARAMS, ...params });
  const { layout, body } = gravityLabLayout(SOL_LAYOUT, p);
  const run = createSectorRun(layout, LAB_SAVE, { seed });
  const lab = createGravityLab(body, p);
  lab.scenario = scenario;
  installGravityLab(run, lab);
  return { run, lab };
}

const vecInput = (c: Partial<VectorControls> = {}, extra: Partial<SectorInput> = {}): SectorInput => {
  const v = ctl(c);
  return { moveX: 0, moveY: -Math.max(v.thrust, v.reverse), vector: v, ...extra };
};

function step(run: SectorRun, ticks: number, input: SectorInput | ((t: number) => SectorInput) = vecInput()): void {
  for (let t = 0; t < ticks; t++) stepSector(run, typeof input === 'function' ? input(t) : input);
}

/* ------------------------------------------------------------------ physics */

describe('gravity field', () => {
  it('points at the body centre with the softened inverse-square magnitude', () => {
    const out = { x: 0, y: 0 };
    for (const [dx, dy] of [
      [300, 0],
      [0, -500],
      [-260, 410],
      [150, 150],
    ] as const) {
      const g = gravityAt(BODY.x, BODY.y, BODY.x + dx, BODY.y + dy, F, out);
      const r = Math.hypot(dx, dy);
      // direction: opposite to the offset
      expect((out.x * -dx + out.y * -dy) / (g * r)).toBeCloseTo(1, 9);
      if (r < 0.7 * F.range) expect(g).toBeCloseTo(F.mu * r / Math.pow(r * r + F.softening ** 2, 1.5), 6);
    }
  });

  it('is finite at the centre (softening), zero beyond the range, and smooth across the taper', () => {
    const out = { x: 0, y: 0 };
    expect(gravityAt(BODY.x, BODY.y, BODY.x, BODY.y, F, out)).toBe(0);
    expect(Number.isFinite(gravityAt(BODY.x, BODY.y, BODY.x + 1, BODY.y, F, out))).toBe(true);
    expect(gravityAt(BODY.x, BODY.y, BODY.x + F.range, BODY.y, F, out)).toBe(0);
    expect(gravityAt(BODY.x, BODY.y, BODY.x + F.range + 500, BODY.y, F, out)).toBe(0);
    // no jumps: neighbouring samples 1 px apart differ by under 1% of the local value (or a tiny absolute amount)
    let prev = gravityAt(BODY.x, BODY.y, BODY.x + 130, BODY.y, F, out);
    let worst = 0;
    for (let r = 131; r <= F.range; r++) {
      const g = gravityAt(BODY.x, BODY.y, BODY.x + r, BODY.y, F, out);
      worst = Math.max(worst, Math.abs(g - prev) / Math.max(prev, 1));
      prev = g;
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('does not depend on the ship facing', () => {
    const a = ship(2000, 1100, 40, 30, 0);
    const b = ship(2000, 1100, 40, 30, 2.1);
    fly(a, 240);
    fly(b, 240);
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.vx).toBe(b.vx);
  });
});

describe('vector flight model', () => {
  it('thrust accelerates along the nose only; turning changes the thrust direction, not the velocity', () => {
    for (const h of [0, 0.7, -2.4, Math.PI]) {
      const s = ship(1000, 1000, 0, 0, h);
      fly(s, 30, ctl({ thrust: 1 }), FAR, NONE);
      const n = noseOf(h);
      const sp = Math.hypot(s.vx, s.vy);
      expect((s.vx * n.x + s.vy * n.y) / sp).toBeCloseTo(1, 9);
      expect(sp).toBeCloseTo(P.thrust * 0.5, 6);
    }
    const s = ship(1000, 1000, 120, 0, 0);
    fly(s, 30, ctl({ turn: 1 }), FAR, NONE);
    expect(s.vx).toBe(120);
    expect(s.vy).toBe(0);
    expect(s.heading).toBeCloseTo(P.turnRate * 0.5, 9);
  });

  it('keeps momentum after the engines stop (no drag)', () => {
    const s = ship(600, 1000, 0, 0, Math.PI / 2);
    fly(s, 30, ctl({ thrust: 1 }), FAR, NONE);
    const v = s.vx;
    fly(s, 300, NO_CONTROLS, FAR, NONE);
    expect(s.vx).toBe(v);
    expect(s.x).toBeGreaterThan(600 + v * 4.9);
  });

  it('reverse thrust brakes along the nose at reverseRatio of the main engine', () => {
    const s = ship(600, 1000, 200, 0, Math.PI / 2);
    fly(s, 60, ctl({ reverse: 1 }), FAR, NONE);
    expect(s.vx).toBeCloseTo(200 - P.thrust * P.reverseRatio, 6);
  });

  it('combines engine thrust and gravity as a vector sum', () => {
    const s0 = ship(2300 - 450, 1400, 0, 0, 0); // nose up, gravity to the right
    const g = ship(s0.x, s0.y, 0, 0, 0);
    const e = ship(s0.x, s0.y, 0, 0, 0);
    const both = ship(s0.x, s0.y, 0, 0, 0);
    fly(g, 1);
    fly(e, 1, ctl({ thrust: 1 }), FAR, NONE);
    fly(both, 1, ctl({ thrust: 1 }));
    expect(both.vx).toBeCloseTo(g.vx + e.vx, 2);
    expect(both.vy).toBeCloseTo(g.vy + e.vy, 2);
  });

  it('engine thrust alone cannot exceed the engine top speed, but gravity can carry the ship above it', () => {
    const s = ship(400, 1400, 0, 0, Math.PI / 2);
    let top = 0;
    fly(s, 600, ctl({ thrust: 1 }), FAR, NONE, P, () => (top = Math.max(top, Math.hypot(s.vx, s.vy))));
    expect(top).toBeLessThanOrEqual(P.speedLimit + 1e-9);
    // unpowered close pass (scenario B, 10 degree approach, ~19 px above the surface): the periapsis speed passes the engine limit
    const st = scenarioStart('B', { ...DEFAULT_PARAMS, approachDeg: 10 });
    const d = ship(st.x, st.y, st.vx, st.vy, st.heading);
    let peak = 0;
    fly(d, 900, NO_CONTROLS, BODY, F, P, () => (peak = Math.max(peak, Math.hypot(d.vx, d.vy))));
    report('B unpowered peak speed (px/s)', r1(peak));
    expect(peak).toBeGreaterThan(P.speedLimit);
  });

  it('thrust can still turn the velocity when gravity has pushed the ship above the engine limit', () => {
    const s = ship(2300 - 200, 1400, 0, -420, Math.PI / 2); // fast, nose sideways
    const before = Math.atan2(s.vy, s.vx);
    fly(s, 3, ctl({ thrust: 1 }), FAR, NONE);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(420 + 1e-6);
    expect(Math.abs(Math.atan2(s.vy, s.vx) - before)).toBeGreaterThan(0.01);
  });

  it('conserves orbital energy on an unpowered flyby (no speed gain from a stationary planet)', () => {
    const st = scenarioStart('B', DEFAULT_PARAMS);
    const s = ship(st.x, st.y, st.vx, st.vy, st.heading);
    const e0 = orbitalEnergy(s.x, s.y, s.vx, s.vy, BODY, F);
    let worst = 0;
    fly(s, 900, NO_CONTROLS, BODY, F, P, () => {
      const r = Math.hypot(s.x - BODY.x, s.y - BODY.y);
      if (r < 0.7 * F.range) worst = Math.max(worst, Math.abs(orbitalEnergy(s.x, s.y, s.vx, s.vy, BODY, F) - e0) / Math.abs(e0));
    });
    report('B energy drift inside the untapered field (relative)', worst);
    expect(worst).toBeLessThan(0.01);
  });

  it('never passes through the planet, at any speed or angle (swept collision)', () => {
    for (const speed of [60, 300, 900, 2400]) {
      for (let k = -6; k <= 6; k++) {
        const s = ship(2300 - 600, 1400 + k * 20, speed, 0, Math.PI / 2);
        const tel = freshTelemetry();
        for (let t = 0; t < 200; t++) {
          const x0 = s.x;
          const y0 = s.y;
          stepVectorFlight(s, NO_CONTROLS, BODY, NONE, P, SR, W, H, tel);
          const R = BODY.r + SR;
          expect(Math.hypot(s.x - BODY.x, s.y - BODY.y)).toBeGreaterThanOrEqual(R - 1e-6);
          // the swept segment of this tick never enters the circle beyond contact
          expect(sweepCircle(x0 - BODY.x, y0 - BODY.y, s.x - BODY.x, s.y - BODY.y, R - 0.5)).toBe(-1);
        }
      }
    }
  });

  it('reports impacts with the real collision radius and bounces with the sector restitution', () => {
    const s = ship(2300 - 400, 1400, 300, 0, Math.PI / 2);
    const tel = freshTelemetry();
    let impact = 0;
    for (let t = 0; t < 120 && impact === 0; t++) {
      stepVectorFlight(s, NO_CONTROLS, BODY, NONE, P, SR, W, H, tel);
      impact = tel.impact;
    }
    expect(impact).toBeCloseTo(300, 6);
    expect(s.vx).toBeCloseTo(-0.4 * 300, 6);
    expect(Math.hypot(tel.impactX - BODY.x, tel.impactY - BODY.y)).toBeCloseTo(BODY.r, 6);
  });

  it('a ship resting on the planet can always climb away: default surface pull is below thrust', () => {
    const { run, lab } = labRun('A');
    expect(surfacePullRatio(lab, run.tune.radius)).toBeLessThan(0.9);
    // crash unpowered, then settle on the surface
    for (let t = 0; t < 600; t++) stepSector(run, { moveX: 0, moveY: 0, vector: NO_CONTROLS });
    expect(lab.diag.altitude).toBeLessThan(2);
    const hits = lab.diag.collisions;
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan(10); // distinct impacts, not every tick of contact
    // nose straight up from the surface and burn: the ship leaves the field
    for (let t = 0; t < 600 && !lab.diag.passes.some((p) => p.escaped); t++) {
      const dx = run.ship.x - lab.body.x;
      const dy = run.ship.y - lab.body.y;
      const d = Math.hypot(dx, dy);
      stepSector(run, { moveX: 0, moveY: -1, vector: { ...NO_CONTROLS, pointX: dx / d, pointY: dy / d } });
    }
    expect(lab.diag.passes.some((p) => p.escaped)).toBe(true);
    expect(lab.diag.collisions).toBe(hits);
  });

  it('keeps the soft sector edge rule', () => {
    const s = ship(100, 1400, -200, 0, 0);
    let pushed = false;
    const tel = freshTelemetry();
    for (let t = 0; t < 120; t++) pushed = stepVectorFlight(s, NO_CONTROLS, FAR, NONE, P, SR, W, H, tel).pushed || pushed;
    expect(pushed).toBe(true);
    expect(s.x).toBeGreaterThanOrEqual(0);
    expect(s.vx).toBeGreaterThan(0);
  });
});

describe('fixed step, frame rate and pause', () => {
  /** Drive a lab run from a FixedStepClock at a given display rate for `ms` of wall time. */
  function drive(hz: number, ms: number, gapAtMs = -1, gapMs = 0): SectorRun {
    const { run } = labRun('B');
    const clock = new FixedStepClock();
    let t = 0;
    clock.advance(0, () => {});
    while (t < ms) {
      t += 1000 / hz;
      let ts = t;
      if (gapAtMs >= 0 && t >= gapAtMs) ts += gapMs;
      clock.advance(ts, () => stepSector(run, vecInput()));
    }
    return run;
  }

  it('gives the same trajectory at 30, 60, 120 and 144 Hz displays (fixed ticks)', () => {
    const ref = drive(60, 3000);
    for (const hz of [30, 120, 144]) {
      const r = drive(hz, 3000);
      // same tick count within one tick; compare at equal ticks
      expect(Math.abs(r.tick - ref.tick)).toBeLessThanOrEqual(1);
    }
    const a = labRun('B').run;
    const b = labRun('B').run;
    step(a, 180);
    for (let i = 0; i < 6; i++) step(b, 30);
    expect(a.ship.x).toBe(b.ship.x);
    expect(a.ship.vy).toBe(b.ship.vy);
  });

  it('a long tab pause consumes at most the clock limit (no jump, no spiral)', () => {
    const { run } = labRun('B');
    const clock = new FixedStepClock();
    clock.advance(0, () => {});
    clock.advance(16.7, () => stepSector(run, vecInput()));
    const before = { x: run.ship.x, y: run.ship.y, tick: run.tick };
    let ticks = 0;
    clock.advance(16.7 + 30_000, () => {
      stepSector(run, vecInput());
      ticks++;
    });
    expect(ticks).toBeLessThanOrEqual(15); // 250 ms cap
    expect(Math.hypot(run.ship.x - before.x, run.ship.y - before.y)).toBeLessThan(15 * 8);
    // and the shell's resetTiming() on resume consumes nothing
    clock.resetTiming();
    let after = 0;
    clock.advance(99_999, () => after++);
    expect(after).toBe(0);
  });
});

/* ------------------------------------------------------------------ assist */

describe('Gravity Flight Assist', () => {
  const ON: FlightParams = { ...P, assist: true };

  it('applies no corrective thrust when off (gravity still applies)', () => {
    const s = ship(2300 - 400, 1400, 0, -100, 0);
    const tel = freshTelemetry();
    for (let t = 0; t < 60; t++) {
      stepVectorFlight(s, ctl({ thrust: 1 }), BODY, F, P, SR, W, H, tel);
      expect(tel.assist).toBe(0);
      expect(tel.g).toBeGreaterThan(0);
    }
  });

  it('never rotates the ship and does nothing while the engines are off', () => {
    const a = ship(2300 - 400, 1400, 30, -100, 0.3);
    const b = ship(2300 - 400, 1400, 30, -100, 0.3);
    fly(a, 120, NO_CONTROLS, BODY, F, P);
    fly(b, 120, NO_CONTROLS, BODY, F, ON);
    expect(b).toEqual(a);
    const c = ship(2300 - 400, 1400, 0, 0, 0.3);
    const d = ship(2300 - 400, 1400, 0, 0, 0.3);
    fly(c, 60, ctl({ thrust: 1, turn: 0.5 }), BODY, F, P);
    fly(d, 60, ctl({ thrust: 1, turn: 0.5 }), BODY, F, ON);
    expect(d.heading).toBe(c.heading);
  });

  it('only cancels part of the sideways pull, capped, never along the thrust and never all of gravity', () => {
    const s = ship(2300, 1400 - 300, 0, 0, Math.PI / 2); // above the planet, nose east: gravity is sideways (down)
    const tel = freshTelemetry();
    stepVectorFlight(s, ctl({ thrust: 1 }), BODY, F, ON, SR, W, H, tel);
    const n = noseOf(Math.PI / 2);
    expect(Math.abs(tel.ax * n.x + tel.ay * n.y)).toBeLessThan(1e-9);
    expect(tel.assist).toBeLessThanOrEqual(ON.assistMax + 1e-9);
    expect(tel.assist).toBeLessThan(tel.g); // never all of it
    const strong: FlightParams = { ...ON, assistStrength: 0.9, assistMax: 10_000 };
    stepVectorFlight(ship(2300, 1400 - 300, 0, 0, Math.PI / 2), ctl({ thrust: 1 }), BODY, F, strong, SR, W, H, tel);
    expect(tel.assist / tel.g).toBeCloseTo(0.9, 2);
  });

  it('reduces the sideways drift of a straight burn past the planet', () => {
    const drift = (p: FlightParams): number => {
      const s = ship(2300 - 300, 1400 - 260, 0, 0, Math.PI / 2);
      fly(s, 60, ctl({ thrust: 1 }), BODY, F, p);
      return s.y - (1400 - 260);
    };
    const off = drift(P);
    const on = drift(ON);
    report('sideways drift over a 1 s burn (px): off / on', [r1(off), r1(on)]);
    expect(on).toBeLessThan(off * 0.75);
    expect(on).toBeGreaterThan(0); // gravity still bends the path
  });

  it('does not guarantee escape: thrusting at the planet still hits it', () => {
    const s = ship(2300 - 400, 1400, 0, 0, Math.PI / 2);
    const tel = freshTelemetry();
    let hit = false;
    for (let t = 0; t < 300 && !hit; t++) {
      stepVectorFlight(s, ctl({ thrust: 1 }), BODY, F, { ...ON, assistStrength: 0.9 }, SR, W, H, tel);
      hit = tel.impact > 0;
    }
    expect(hit).toBe(true);
  });

  /* P02: escape advice from the real state (FR-TD-84) */
  const SAFE = influenceRadius(F, P.thrust, DEFAULT_PARAMS.displayThreshold);
  const ang = (a: number, b: number): number => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  const advise = (s: ShipState, seconds = 4, safe = SAFE) => suggestEscape(s, BODY, F, P, SR, W, H, seconds, freshAdvice(), safe);
  /** An independent keyboard pilot: turn at the keyboard rate toward `heading`, burn once within 20 degrees. */
  const follow = (s: ShipState, heading: number, ticks: number): { hit: boolean; outAt: number } => {
    const tel = freshTelemetry();
    let hit = false;
    let outAt = -1;
    for (let t = 0; t < ticks && outAt < 0; t++) {
      const err = ang(heading, s.heading);
      const turn = Math.max(-1, Math.min(1, err / (P.turnRate / 60)));
      stepVectorFlight(s, ctl({ turn, thrust: Math.abs(err) <= 0.35 ? 1 : 0 }), BODY, F, P, SR, W, H, tel);
      hit = hit || tel.impact >= 20;
      if (Math.hypot(s.x - BODY.x, s.y - BODY.y) >= SAFE) outAt = t + 1;
    }
    return { hit, outAt };
  };
  const OUT = Math.PI; // straight down: away from the planet for a ship below it

  it('escape advice comes from the actual state: facing, velocity and position all change it', () => {
    // facing out and slow: straight out (within one refinement step)
    const out = advise(ship(2300, 1730, 0, 0, OUT));
    expect(out.status).toBe('escape');
    expect(Math.abs(ang(out.heading, OUT))).toBeLessThanOrEqual((4 * Math.PI) / 180);
    // facing the planet: it accounts for the turn (facing is not velocity) and still gets out
    const inward = advise(ship(2300, 1730, 0, 0, 0));
    expect(inward.status).toBe('escape');
    expect(inward.time).toBeGreaterThan(out.time);
    expect(Math.abs(inward.turn)).toBeLessThan(Math.PI);
    // velocity changes the answer, and a mirrored state gives the mirrored heading
    const byV = [0, 100, 200, 300].map((vx) => advise(ship(2300, 1730, vx, 0, 0)).heading);
    report('P02 escape advice, ship facing the planet, tangential 0/100/200/300 px/s (deg)', byV.map((h) => r1((h * 180) / Math.PI)));
    expect(new Set(byV.map((h) => Math.round((h * 180) / Math.PI))).size).toBeGreaterThan(1);
    const r = advise(ship(2300, 1730, 200, 0, 0)).heading;
    const m = advise(ship(2300, 1730, -200, 0, 0)).heading;
    expect(Math.abs(ang(m, -r))).toBeLessThan(1e-9);
    // rotating the whole state about the planet rotates the advice (left of the planet, same state turned 90 degrees)
    // (x, y) -> (-y, x) about the planet adds a quarter turn to every heading
    const below = advise(ship(2300, 1730, 60, -100, 0.4));
    const left = advise(ship(2300 - 330, 1400, 100, 60, 0.4 + Math.PI / 2));
    expect(Math.abs(ang(left.heading - below.heading, Math.PI / 2))).toBeLessThanOrEqual((4 * Math.PI) / 180);
  });

  it('following the advice gets out without touching the planet, from many states', () => {
    let checked = 0;
    for (const r of [200, 260, 330, 420]) {
      for (const a of [0, 1.3, 2.6, 3.9, 5.2]) {
        for (const [vt, vr, face] of [[0, 0, 0], [200, 0, 1.5], [-150, -120, 3], [300, 60, 4.5]] as const) {
          const x = BODY.x + Math.sin(a) * r;
          const y = BODY.y - Math.cos(a) * r;
          const ux = Math.sin(a);
          const uy = -Math.cos(a);
          const s = ship(x, y, ux * vr - uy * vt, uy * vr + ux * vt, face);
          const adv = advise(s);
          if (adv.status !== 'escape') continue;
          // never straight at the planet
          expect(Math.sin(adv.heading) * -ux + -Math.cos(adv.heading) * -uy).toBeLessThan(0.9);
          const f = follow(ship(s.x, s.y, s.vx, s.vy, s.heading), adv.heading, 300);
          expect(f.hit).toBe(false);
          expect(f.outAt).toBeGreaterThan(0);
          expect(Math.abs(f.outAt / 60 - adv.time)).toBeLessThan(0.1);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('reports honestly when there is no safe escape, and when nothing gets out within the look-ahead', () => {
    const doomed = advise(ship(2300, 1560, 0, -350, 0));
    expect(doomed.status).toBe('none');
    expect(Number.isNaN(doomed.heading)).toBe(true);
    expect(doomed.escapes).toBe(false);
    expect(doomed.horizon).toBe(4);
    // a field edge beyond reach in 1 s: a climb heading, not a false escape
    const climb = advise(ship(2300, 1730, 0, 0, OUT), 1);
    expect(climb.status).toBe('climb');
    expect(climb.escapes).toBe(false);
    expect(Number.isFinite(climb.heading)).toBe(true);
    expect(follow(ship(2300, 1730, 0, 0, OUT), climb.heading, 60).hit).toBe(false);
  });

  it('the lab spreads the search over ticks and publishes exactly the one-shot advice for its snapshot', () => {
    const { run, lab } = labRun('A');
    lab.assist = true;
    step(run, 1);
    const snap = { ...run.ship };
    const expected = suggestEscape(snap, { x: lab.body.x, y: lab.body.y, vx: lab.bodyVx, vy: lab.bodyVy, r: lab.body.r }, fieldOf(lab), flightOf(lab, run), run.tune.radius, run.layout.width, run.layout.height, ADVISE_SECONDS, freshAdvice(), lab.diag.fieldRadius);
    expect(Number.isNaN(lab.advice.heading)).toBe(true); // not published after one tick
    step(run, ADVISE_EVERY - 1);
    expect(lab.advice.status).toBe(expected.status);
    expect(lab.advice.heading).toBe(expected.heading);
    expect(lab.advice.time).toBe(expected.time);
    expect(ADVISE_BUDGET * ADVISE_EVERY).toBeGreaterThanOrEqual(ESCAPE_CANDIDATES + 2 * ESCAPE_REFINE);
  });

  it('the advice is bounded and advice only: it never changes the ship', () => {
    expect(ESCAPE_CANDIDATES + 2 * ESCAPE_REFINE).toBeLessThanOrEqual(30);
    const s = ship(2300, 1730, 120, -40, 1);
    const copy = { ...s };
    advise(s);
    expect(s).toEqual(copy);
  });

  it('refreshes the escape advice on a cadence inside the field, and only with the assist on', () => {
    const { run, lab } = labRun('A');
    step(run, ADVISE_EVERY);
    expect(Number.isNaN(lab.advice.heading)).toBe(true);
    lab.assist = true;
    step(run, ADVISE_EVERY);
    expect(Number.isFinite(lab.advice.heading)).toBe(true);
  });
});

/* ------------------------------------------------------------------ slingshot */

function unpoweredPass(params: Partial<LabParams>, ticks = 900): { pass: PassRecord | undefined; lab: GravityLab; run: SectorRun } {
  const { run, lab } = labRun('B', params);
  step(run, ticks);
  return { pass: lab.diag.passes[0], lab, run };
}

describe('slingshot (emergent)', () => {
  it('bends the path by an amount that depends on the approach angle; too steep an approach hits the planet', () => {
    const rows: unknown[] = [];
    const defl: number[] = [];
    const hits: number[] = [];
    for (const a of [8, 10, 12, 14, 16, 20, 25]) {
      const { pass, lab } = unpoweredPass({ approachDeg: a }, 600);
      rows.push({ approach: a, collisions: lab.diag.collisions, deflection: pass ? r1(pass.deflectionDeg) : null, altitude: pass ? r1(pass.altitude) : null, entry: pass ? r1(pass.entrySpeed) : null, peak: pass ? r1(pass.maxSpeed) : null, exit: pass ? r1(pass.exitSpeed) : null, seconds: pass ? r1((pass.exitTick - pass.entryTick) / 60) : null });
      hits.push(lab.diag.collisions);
      if (a > 8) defl.push(Math.abs(pass!.deflectionDeg));
    }
    report('B unpowered sweep (approach deg -> pass)', rows);
    expect(hits[0]).toBeGreaterThan(0);
    expect(hits.slice(1).every((h) => h === 0)).toBe(true);
    for (let i = 1; i < defl.length; i++) expect(defl[i]!).toBeLessThan(defl[i - 1]!);
    expect(defl[0]!).toBeGreaterThan(30);
  });

  it('a stationary planet gives a temporary speed rise and no lasting gain', () => {
    const { pass } = unpoweredPass({});
    expect(pass).toBeDefined();
    expect(pass!.maxSpeed).toBeGreaterThan(pass!.entrySpeed * 1.3);
    expect(Math.abs(pass!.exitSpeed - pass!.entrySpeed) / pass!.entrySpeed).toBeLessThan(0.01);
    expect(pass!.escaped).toBe(true);
  });

  it('the moving-planet option exchanges energy in the sector frame while planet-frame speed is conserved', () => {
    const { pass, lab } = unpoweredPass({ planetSpeed: 80, approachDeg: 14 }, 1100);
    expect(pass).toBeDefined();
    report('moving planet (80 px/s) pass', { entry: r1(pass!.entrySpeed), exit: r1(pass!.exitSpeed), entryRel: r1(pass!.entrySpeedRel), exitRel: r1(pass!.exitSpeedRel), deflection: r1(pass!.deflectionDeg), collisions: lab.diag.collisions });
    expect(Math.abs(pass!.exitSpeedRel - pass!.entrySpeedRel) / pass!.entrySpeedRel).toBeLessThan(0.02);
    expect(Math.abs(pass!.exitSpeed - pass!.entrySpeed)).toBeGreaterThan(10);
  });

  it('is repeatable: the same inputs give the same pass', () => {
    const a = unpoweredPass({ approachDeg: 15 }).pass!;
    const b = unpoweredPass({ approachDeg: 15 }).pass!;
    expect(b).toEqual(a);
  });

  it('no proximity reward: a prograde burn at periapsis gains no more lasting speed than the same burn far out', () => {
    // Same 1 s burn along the velocity. The engine rule (thrust cannot raise speed above the engine limit) removes the
    // Oberth bonus, so being close to the planet is not itself rewarded.
    const burnAt = (near: boolean): number => {
      const { run, lab } = labRun('B');
      let burning = 0;
      step(run, 1000, () => {
        const d = Math.hypot(run.ship.x - lab.body.x, run.ship.y - lab.body.y);
        const go = burning > 0 && burning < 60;
        if (burning === 0 && (near ? d < 260 : run.tick === 30)) burning = 1;
        else if (burning > 0) burning++;
        const h = Math.atan2(run.ship.vx, -run.ship.vy);
        return vecInput(go ? { thrust: 1, pointX: Math.sin(h), pointY: -Math.cos(h) } : {});
      });
      return lab.diag.passes[0]?.exitSpeed ?? 0;
    };
    const near = burnAt(true);
    const far = burnAt(false);
    report('1 s prograde burn: exit speed near periapsis / far out (px/s)', [r1(near), r1(far)]);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThanOrEqual(far + 1);
  });
});

/* ------------------------------------------------------------------ prediction */

describe('trajectory prediction', () => {
  it('matches the real engines-off path (same physics)', () => {
    const { run, lab } = labRun('B');
    const pts = Float32Array.from(lab.path.subarray(0, lab.prediction.count * 2));
    const real: number[] = [];
    step(run, 210, () => {
      return vecInput();
    });
    // re-simulate to collect positions every PREDICT_STRIDE ticks
    const { run: r2 } = labRun('B');
    real.push(r2.ship.x, r2.ship.y);
    for (let t = 1; t <= 210; t++) {
      stepSector(r2, vecInput());
      if (t % 3 === 0) real.push(r2.ship.x, r2.ship.y);
    }
    let worst = 0;
    for (let i = 0; i < Math.min(pts.length, real.length); i += 2) worst = Math.max(worst, Math.hypot(pts[i]! - real[i]!, pts[i + 1]! - real[i + 1]!));
    expect(worst).toBeLessThan(0.01);
    expect(run.tick).toBe(210);
  });

  it('warns of an impact using the actual collision radius', () => {
    const res = freshPrediction();
    const out = new Float32Array(800);
    predictBallistic(2300 - 500, 1400, 200, 0, BODY, F, SR, W, H, 4, 3, out, res);
    expect(res.impactIn).toBeGreaterThan(0);
    expect(res.closest).toBeCloseTo(BODY.r + SR, 6);
    predictBallistic(2300 - 500, 1400 + 400, 200, 0, BODY, NONE, SR, W, H, 4, 3, out, res);
    expect(res.impactIn).toBe(-1);
  });

  it('refreshes on a fixed tick cadence, not every rendered frame', () => {
    const { run, lab } = labRun('B');
    const first = lab.path[2];
    step(run, PREDICT_EVERY - 1);
    expect(lab.path[2]).toBe(first);
    step(run, 1);
    expect(lab.path[2]).not.toBe(first);
  });
});

/* ------------------------------------------------------------------ enemy */

describe('pursuing interceptor (existing AI)', () => {
  it('scenario C spawns one interceptor behind the pilot that pursues it, without teleporting', () => {
    const { run, lab } = labRun('C');
    expect(run.hostiles.length).toBe(1);
    const a = run.hostiles[0]!;
    expect(a.family).toBe('lancer');
    expect(Math.hypot(a.x - run.ship.x, a.y - run.ship.y)).toBeCloseTo(DEFAULT_PARAMS.enemyGap, 0);
    const cap = FAMILIES.lancer.speed * 1.6 + 60;
    let px = a.x;
    let py = a.y;
    let closed = Infinity;
    step(run, 240, (t) => {
      if (t > 0) {
        expect(Math.hypot(a.x - px, a.y - py)).toBeLessThan(cap / 60 + 2);
        const d = Math.hypot(a.x - lab.body.x, a.y - lab.body.y);
        expect(d).toBeGreaterThanOrEqual(lab.body.r + FAMILIES.lancer.radius - 1);
      }
      px = a.x;
      py = a.y;
      closed = Math.min(closed, Math.hypot(a.x - run.ship.x, a.y - run.ship.y));
      return vecInput({ thrust: 1 });
    });
    expect(a.target).toBe('player');
    expect(closed).toBeLessThan(DEFAULT_PARAMS.enemyGap);
  });

  it('enemy gravity is a toggle and enemy weapons can be switched off', () => {
    const on = labRun('C', { enemyGravity: true });
    const off = labRun('C', { enemyGravity: false });
    step(on.run, 300, vecInput({ thrust: 1 }));
    step(off.run, 300, vecInput({ thrust: 1 }));
    expect(on.run.hostiles[0]!.x).not.toBe(off.run.hostiles[0]!.x);
    const quiet = labRun('C', { enemyFires: false });
    let fired = 0;
    for (let t = 0; t < 900; t++) fired += stepSector(quiet.run, vecInput()).filter((e) => e.type === 'enemyFired').length + quiet.run.enemyShots.length;
    expect(fired).toBe(0);
  });

  it('destruction resets the scenario (no save, no recall to an arrival)', () => {
    const { run, lab } = labRun('C');
    const resets = lab.resets;
    run.hull = 0.0001;
    run.shield = 0;
    run.hull = 0;
    stepSector(run, vecInput());
    expect(lab.resets).toBe(resets + 1);
    const s = scenarioStart('C', lab.params);
    expect(run.ship.x).toBe(s.x);
    expect(run.hostiles.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ P02: occlusion and tactics */

/** Put the pilot and the lab's interceptor at fixed points, at rest (test placement only). */
function place(run: SectorRun, ship: { x: number; y: number }, enemy: { x: number; y: number }): Agent {
  const a = run.hostiles[0]!;
  Object.assign(run.ship, { x: ship.x, y: ship.y, px: ship.x, py: ship.y, vx: 0, vy: 0 });
  Object.assign(a, { x: enemy.x, y: enemy.y, vx: 0, vy: 0 });
  return a;
}
/** Hold the pilot still at a point (cancels gravity in the test harness, not in the game). */
const hold = (run: SectorRun, x: number, y: number): void => {
  Object.assign(run.ship, { x, y, px: x, py: y, vx: 0, vy: 0 });
};

describe('planet occlusion (P02, gravity sector only)', () => {
  const BXc = LAB_SECTOR.bodyX;
  const BYc = LAB_SECTOR.bodyY;

  it('the planet hides the pilot from the interceptor: it loses its target and searches the last seen spot', () => {
    const { run, lab } = labRun('C');
    const a = place(run, { x: BXc + 250, y: BYc }, { x: BXc - 290, y: BYc });
    step(run, 3, () => (hold(run, BXc + 250, BYc), vecInput()));
    expect(lab.diag.sightBlocked).toBe(true);
    expect(a.target).toBeNull();
    expect(a.state).toBe('investigate');
    expect(lab.diag.pursuit).toBe('searching');
    // with occlusion off the same geometry keeps the lock (the line passes through the planet)
    const off = labRun('C', { occlusion: false });
    const b = place(off.run, { x: BXc + 250, y: BYc }, { x: BXc - 290, y: BYc });
    step(off.run, 3, () => (hold(off.run, BXc + 250, BYc), vecInput()));
    expect(b.target).toBe('player');
    expect(off.lab.diag.sightBlocked).toBe(false);
  });

  it('only the gravity sector has a sight hook; ordinary sectors keep line of sight through bodies', () => {
    const run = createSectorRun(SOL_LAYOUT, EMPTY_SECTOR_SAVE, { seed: 3 });
    expect(run.flight).toBeNull();
    const { run: lr } = labRun('C');
    expect(typeof lr.flight?.sightBlocked).toBe('function');
    expect(lr.flight!.sightBlocked!(BXc - 300, BYc, BXc + 300, BYc)).toBe(true);
    expect(lr.flight!.sightBlocked!(BXc - 300, BYc - 200, BXc + 300, BYc - 200)).toBe(false);
  });

  it('enemy shots are stopped by the planet through the existing collision (no special case)', () => {
    for (const occlusion of [true, false]) {
      const { run, lab } = labRun('C', { occlusion });
      const a = place(run, { x: BXc + 200, y: BYc }, { x: BXc - 300, y: BYc });
      const hp = run.shield + run.hull;
      // a real twin-lance bolt aimed straight through the planet at the pilot, then the shooter is moved well away
      expect(spawnShot(run, a, 'twin-lance', 0)).toBe(true);
      const id = run.enemyShots[run.enemyShots.length - 1]!.id;
      Object.assign(a, { x: BXc - 1500, y: BYc - 1200 });
      step(run, 60, () => (hold(run, BXc + 200, BYc), vecInput()));
      expect(run.enemyShots.some((x) => x.id === id)).toBe(false);
      expect(lab.diag.shotsStopped).toBe(1);
      expect(run.shield + run.hull).toBe(hp);
    }
  });

  it('never fires while the planet blocks the line to the pilot, across every strategy', () => {
    for (const st of STRATEGIES) {
      const { run, lab } = startC({ seed: 2, gap: 450, dy: 0 });
      const pilot = st.make();
      for (let t = 0; t < 900; t++) {
        const events = stepSector(run, pilotInput(pilot(run, lab)));
        for (const e of events) {
          if (e.type !== 'enemyFired') continue;
          for (const a of run.hostiles) if (a.state !== 'destroyed') expect(sweptHit(a.x, a.y, run.ship.x, run.ship.y, lab.body.x, lab.body.y, lab.body.r)).toBe(false);
        }
      }
    }
  });

  it('reacquires after the existing reaction delay once the pilot is in view again (bounded, not instant)', () => {
    const { run, lab } = labRun('C');
    const a = place(run, { x: BXc + 250, y: BYc }, { x: BXc - 300, y: BYc });
    step(run, 10, () => (hold(run, BXc + 250, BYc), vecInput()));
    expect(a.target).toBeNull();
    // the pilot slides into clear view within detection and weapon range
    const vx = a.x + 40;
    const vy = a.y - 300;
    let seenAt = -1;
    let firedAt = -1;
    for (let t = 0; t < 600 && firedAt < 0; t++) {
      hold(run, vx, vy);
      const events = stepSector(run, vecInput());
      if (seenAt < 0 && a.target === 'player') seenAt = t;
      if (events.some((e) => e.type === 'enemyFired')) firedAt = t;
    }
    expect(lab.diag.sightBlocked).toBe(false);
    expect(seenAt).toBeGreaterThanOrEqual(0);
    expect(seenAt).toBeLessThan(5); // sight is a plain geometric check, no forgetting
    expect(firedAt - seenAt).toBeGreaterThanOrEqual(Math.round(run.row.reaction * 0.8));
    expect(firedAt).toBeLessThan(4 * 60);
    expect(lab.diag.fireDelayAfterCover).toBeGreaterThanOrEqual(Math.round(run.row.reaction * 0.8));
    expect(lab.diag.pursuit).toBe('pursued');
  });

  it('the lab toggle turns occlusion off; the parameter is sanitised and defaults on', () => {
    expect(DEFAULT_PARAMS.occlusion).toBe(true);
    expect(sanitizeParams({ ...DEFAULT_PARAMS, occlusion: 'yes' as unknown as boolean }).occlusion).toBe(true);
    expect(sanitizeParams({ ...DEFAULT_PARAMS, occlusion: false }).occlusion).toBe(false);
    const { run, lab } = labRun('C');
    setLabParams(lab, { occlusion: false });
    expect(run.flight!.sightBlocked!(BXc - 300, BYc, BXc + 300, BYc)).toBe(false);
  });
});

describe('tactical evasion under identical starts (P02)', () => {
  const S = starts(1); // 3 enemy gaps x 3 offsets, seed 1
  const runs = (id: string, params: Partial<LabParams> = {}): RunResult[] => S.map((s) => flyC(s, strategy(id).make(), params));

  it('a correct low skim behind the planet (C) cuts enemy shots and damage against the best direct escape (A)', () => {
    const aBest = ['A-south', 'A-north', 'A-back'].map((id) => runs(id)).sort((x, y) => mean(x, (o) => o.damage) - mean(y, (o) => o.damage))[0]!;
    const c = runs('C-215');
    const b = runs('B-330');
    const cOff = runs('C-215', { occlusion: false });
    report('P02 gate: mean damage A-best / B / C / C without occlusion', [mean(aBest, (o) => o.damage), mean(b, (o) => o.damage), mean(c, (o) => o.damage), mean(cOff, (o) => o.damage)].map(r1));
    report('P02 gate: mean shots A-best / B / C / C without occlusion', [mean(aBest, (o) => o.shots), mean(b, (o) => o.shots), mean(c, (o) => o.shots), mean(cOff, (o) => o.shots)].map(r1));
    expect(mean(c, (o) => o.shots)).toBeLessThan(mean(aBest, (o) => o.shots));
    expect(mean(c, (o) => o.damage)).toBeLessThan(mean(aBest, (o) => o.damage));
    // the advantage comes from the planet blocking sight, not from a speed gift
    expect(mean(cOff, (o) => o.shots)).toBeGreaterThan(mean(c, (o) => o.shots) + 2);
    expect(c.every((o) => o.covered > 0)).toBe(true);
    // a plain flyby without the occlusion geometry gets no such benefit
    expect(mean(b, (o) => o.shots)).toBeGreaterThan(mean(c, (o) => o.shots) + 2);
  });

  it('C is not a guaranteed win: poor executions fail in measurable ways', () => {
    expect(runs('C-low').every((o) => o.planetHits > 0)).toBe(true); // too low: hits the planet
    expect(runs('C-east').every((o) => o.pursuedAtEnd && o.damage > 0)).toBe(true); // exits back into view: reacquired
    expect(runs('C-wide').some((o) => o.pursuedAtEnd)).toBe(true); // too wide: sometimes still pursued
  });

  it('identical starts are repeatable: the same start and pilot give the same result', () => {
    const s = S[4]!;
    expect(flyC(s, strategy('C-215').make())).toEqual(flyC(s, strategy('C-215').make()));
    const { run, lab } = labRun('C');
    const pilot = strategy('C-215').make();
    step(run, 300, () => pilotInput(pilot(run, lab)));
    applyScenario(run, lab);
    expect(lab.diag.enemyShots + lab.diag.shotsStopped + lab.diag.blockedSeconds + lab.diag.engineDv + lab.diag.damageShots).toBe(0);
    expect(lab.diag.fireDelayAfterCover).toBe(-1);
    expect(lab.diag.headingChangeDeg).toBe(0);
  });

  it('the assist neither steers nor evades: with no input it changes nothing, and on a manoeuvre it never rotates the ship', () => {
    const off = startC(S[4]!, {}, false);
    const on = startC(S[4]!, {}, true);
    for (let t = 0; t < 600; t++) {
      stepSector(off.run, vecInput());
      stepSector(on.run, vecInput());
    }
    expect(on.run.ship).toEqual(off.run.ship);
    expect(on.run.hostiles[0]!.x).toBe(off.run.hostiles[0]!.x);
    expect(on.lab.diag.assistDv).toBe(0);
    // under thrust with no turn input the heading never changes, assist on
    const r = startC(S[4]!, {}, true);
    const h0 = r.run.ship.heading;
    let assistUsed = 0;
    for (let t = 0; t < 240; t++) {
      stepSector(r.run, vecInput({ thrust: 1 }));
      assistUsed += r.lab.tel.assist;
      expect(r.run.ship.heading).toBe(h0);
    }
    expect(assistUsed).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ isolation */

describe('isolation and configuration', () => {
  it('ordinary sectors have no flight hook and fly exactly as before', () => {
    const run = createSectorRun(SOL_LAYOUT, EMPTY_SECTOR_SAVE, { seed: 3 });
    expect(run.flight).toBeNull();
    const ref = createSectorRun(SOL_LAYOUT, EMPTY_SECTOR_SAVE, { seed: 3 });
    // a gravity lab elsewhere does not touch this run
    labRun('B');
    for (let t = 0; t < 120; t++) {
      stepSector(run, { moveX: 1, moveY: 0 });
      stepSector(ref, { moveX: 1, moveY: 0 });
    }
    expect(run.ship).toEqual(ref.ship);
  });

  it('the lab sector reuses Sol and contains one body, no POIs, rocks, patrols, sites or hazards', () => {
    const { layout } = gravityLabLayout(SOL_LAYOUT, DEFAULT_PARAMS);
    expect(layout.systemId).toBe(LAB_SYSTEM_ID);
    expect(layout.landmarks.length).toBe(1);
    expect(layout.pois.length + layout.rocks.length + layout.patrols.length + layout.sites.length + layout.hazards.length + layout.regions.length).toBe(0);
    expect(layout.width / 640).toBeGreaterThanOrEqual(6);
    expect(layout.height / 360).toBeGreaterThanOrEqual(6);
    expect(SOL_LAYOUT.width).not.toBe(layout.width); // Sol's own sector is unchanged
  });

  it('bounds every tuning value and keeps softening below the collision radius', () => {
    const wild = sanitizeParams({ mu: 1e12, range: -5, radius: 9999, softening: 9999, thrust: Number.NaN, enemyFamily: 'boss' as never, flightModel: 'warp' as never });
    for (const s of PARAM_SPECS) {
      expect(wild[s.key]).toBeGreaterThanOrEqual(s.min);
      expect(wild[s.key]).toBeLessThanOrEqual(s.max);
    }
    expect(wild.softening).toBeLessThan(wild.radius);
    expect(wild.thrust).toBe(DEFAULT_PARAMS.thrust);
    expect(wild.enemyFamily).toBe('lancer');
    expect(wild.flightModel).toBe('vector');
  });

  it('live tuning applies to the running scenario; resets restore the same start', () => {
    const { run, lab } = labRun('B');
    setLabParams(lab, { radius: 150 });
    expect(lab.body.r).toBe(150);
    step(run, 60);
    applyScenario(run, lab, 'B');
    const s = scenarioStart('B', lab.params);
    expect(run.ship.x).toBe(s.x);
    expect(run.ship.vx).toBe(s.vx);
    expect(lab.tick).toBe(0);
  });

  it('the assisted (existing controller) comparison model caps speed, so a flyby cannot carry momentum', () => {
    const { run, lab } = labRun('B', { flightModel: 'assisted' });
    let peak = 0;
    step(run, 900, () => {
      peak = Math.max(peak, Math.hypot(run.ship.vx, run.ship.vy));
      return { moveX: 0, moveY: 0 };
    });
    report('assisted model: peak speed, passes', [r1(peak), lab.diag.passes.length]);
    expect(peak).toBeLessThanOrEqual(SHIP.maxSpeed + 1e-6);
  });

  it('the shell offers the test only in its system, only behind the build flag, and writes nothing while it runs', () => {
    const shell = readFileSync(new URL('../src/modes/freeroam/freeRoamMode.ts', import.meta.url), 'utf8');
    expect(shell).toContain(`gravityTest: __GALAXIA_GRAVITY_LAB__ ? { systemId: '${LAB_SYSTEM_ID}'`);
    expect(shell).toMatch(/const persist = \(\): boolean => \{\n[^\n]*\n\s*if \(__GALAXIA_GRAVITY_LAB__ && lab\) return true;/);
    expect(shell).toMatch(/__GALAXIA_GRAVITY_LAB__ && new URLSearchParams\(window\.location\.search\)\.get\('lab'\) === 'gravity'/);
  });

  it('vector flight parameters follow boost exactly like the normal controller', () => {
    const { run, lab } = labRun('B');
    const boosted = { ...run.tune, accel: run.tune.accel * 1.7, maxSpeed: run.tune.maxSpeed * 1.45 };
    const p = flightOf(lab, run, boosted);
    expect(p.thrust).toBeCloseTo(DEFAULT_PARAMS.thrust * 1.7, 9);
    expect(p.speedLimit).toBeCloseTo(run.tune.maxSpeed * 1.45, 9);
    expect(fieldOf(lab).mu).toBe(DEFAULT_PARAMS.mu);
  });
});

describe('Gravity lab with the Combat P03 missile', () => {
  it('a scenario reset clears missiles in flight, a lock and the cooldown (nothing carries into the next start)', () => {
    const { run, lab } = labRun('B');
    run.missiles.push({ id: 1, x: run.ship.x, y: run.ship.y - 50, px: run.ship.x, py: run.ship.y - 40, vx: 0, vy: -400, speed: 400, life: 100, target: null });
    run.missile.state = 'cooldown';
    run.missile.cooldown = 500;
    run.missile.target = 3;
    applyScenario(run, lab);
    expect(run.missiles).toHaveLength(0);
    expect(run.missile.state).toBe('ready');
    expect(run.missile.cooldown).toBe(0);
    expect(run.missile.target).toBeNull();
  });
});
