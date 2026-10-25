/**
 * P04.3: NORMAL / REALISTIC flight modes and STOP station-keeping
 * (sector/realisticFlight.ts, sector/vectorFlight.ts, sector/run.ts).
 * Simulated only (fixed 60 Hz step): this measures the model, not how it
 * feels to a person; no device or human playtest is implied.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, FLIGHT_ACTIONS, findBinding, sanitizeBindings, trackedCodes } from '../src/modes/freeroam/bindings.ts';
import { DEFAULT_CONTROLS, sanitizeControls } from '../src/modes/freeroam/profile.ts';
import { loadFreeRoamPrefs, saveFreeRoamPrefs } from '../src/modes/freeroam/saveSlots.ts';
import { freshGravity, pullOn } from '../src/modes/freeroam/sector/gravityWells.ts';
import { EMPTY_SECTOR_SAVE, type Landmark, type Poi, type Region, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { realisticInput, REALISTIC, realisticThrust, STOP, stopDisplay, stopLimit, updateStationKeeping, freshStationKeeping, vectorMoving } from '../src/modes/freeroam/sector/realisticFlight.ts';
import { applyShip, createSectorRun, interact, restartSector, setRunFlightMode, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { deriveShip } from '../src/modes/freeroam/ships/equipment.ts';
import { headingOf, noseOf, wrapAngle } from '../src/modes/freeroam/sim.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import { arena } from './helpers/combatProbe.ts';
import { runScript } from './helpers/normalFlightScript.ts';

const root = join(import.meta.dirname, '..');
const body = (id: string, x: number, y: number, r: number): Landmark => ({ id, kind: 'body', style: 'rocky', x, y, r, hazardR: 0, label: 'Test body' });
const shear = (id: string, x: number, y: number, r: number, strength: number): Region => ({ id, kind: 'nebula', x, y, r, effect: 'gravity-shear', strength, label: 'Test cloud' });

/** A bare arena (no rocks, clouds or landmarks unless given), ship at the centre at rest. */
function runWith(o: { landmarks?: Landmark[]; regions?: Region[]; mode?: 'normal' | 'realistic'; ship?: Parameters<typeof deriveShip>[0] } = {}): SectorRun {
  const base = arena(1);
  const L: SectorLayout = { ...base, landmarks: o.landmarks ?? [], regions: o.regions ?? [] };
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 5, ...(o.mode ? { flightMode: o.mode } : {}), ...(o.ship ? { ship: deriveShip(o.ship) } : {}) });
  r.phase = 'flight';
  r.grace = 1e9;
  const cx = L.width / 2;
  const cy = L.height / 2;
  Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0, heading: 0, pheading: 0 });
  return r;
}
const centre = (r: SectorRun): { x: number; y: number } => ({ x: r.layout.width / 2, y: r.layout.height / 2 });

/** REALISTIC input from keys (x: -1 left .. 1 right, y: -1 up/thrust .. 1 down/reverse) and an optional stick / aim. */
const vin = (keys: { x: number; y: number }, extra: Partial<SectorInput> = {}, stick = { x: 0, y: 0 }, aim: { x: number; y: number } | null = null): SectorInput => ({ ...realisticInput(keys, stick, aim), ...extra });
const IDLE = vin({ x: 0, y: 0 });
const THRUST = vin({ x: 0, y: -1 });
const STOP_PRESS = vin({ x: 0, y: 0 }, { stopToggle: true });
const speed = (r: SectorRun): number => Math.hypot(r.ship.vx, r.ship.vy);
const steps = (r: SectorRun, input: SectorInput, n: number): SectorEvent[] => {
  const ev: SectorEvent[] = [];
  for (let i = 0; i < n; i++) ev.push(...stepSector(r, input));
  return ev;
};
/** Fly up to `v` px/s straight up (REALISTIC), then release. */
function cruise(r: SectorRun, v: number): void {
  for (let i = 0; i < 600 && speed(r) < v; i++) stepSector(r, THRUST);
}

describe('NORMAL flight is unchanged (P04.3)', () => {
  it('a 1500-tick scripted flight through a planet, a star, a shear and a dust cloud, with boost, aim and lock presses, matches the pre-P04.3 build bit for bit', () => {
    const golden = JSON.parse(readFileSync(join(root, 'tests/fixtures/normalFlightGolden.json'), 'utf8')) as number[];
    const { trace } = runScript();
    expect(trace.length).toBe(golden.length);
    expect(trace).toEqual(golden); // exact: the same arithmetic, not "close"
    // the script really crosses the fields (the golden is not a trivial straight line)
    expect(golden.filter((_, i) => i % 6 === 5 && golden[i]! > 0).length).toBeGreaterThan(10);
  });

  it('a new run flies NORMAL by default; NORMAL ignores rotate-and-thrust controls, and STOP only reports that it is unavailable', () => {
    const a = runWith();
    const b = runWith();
    expect(a.flightMode).toBe('normal');
    const ev: SectorEvent[] = [];
    for (let t = 0; t < 240; t++) {
      const base: SectorInput = { moveX: t < 120 ? 1 : 0, moveY: -0.5 };
      stepSector(a, base);
      ev.push(...stepSector(b, { ...base, vector: { turn: 1, thrust: 1, reverse: 0, pointX: 0, pointY: 0 }, stopToggle: t % 30 === 0 }));
    }
    expect(b.ship).toEqual(a.ship);
    expect(b.stop.phase).toBe('off');
    expect(ev.filter((e) => e.type === 'stop').every((e) => e.type === 'stop' && e.change === 'unavailable')).toBe(true);
    expect(ev.some((e) => e.type === 'stop')).toBe(true);
  });

  it('a junk flight mode in the run options flies NORMAL', () => {
    const r = createSectorRun(arena(1), EMPTY_SECTOR_SAVE, { flightMode: 'warp' as never });
    expect(r.flightMode).toBe('normal');
  });
});

describe('REALISTIC flight: momentum, facing and thrust (P04.3)', () => {
  it('released controls never slow the ship: the velocity stays exactly the same in empty space', () => {
    const r = runWith({ mode: 'realistic' });
    steps(r, THRUST, 30);
    const v0 = { vx: r.ship.vx, vy: r.ship.vy };
    expect(speed(r)).toBeGreaterThan(100);
    const y0 = r.ship.y;
    steps(r, IDLE, 120);
    expect(r.ship.vx).toBeCloseTo(v0.vx, 9);
    expect(r.ship.vy).toBeCloseTo(v0.vy, 9);
    expect(y0 - r.ship.y).toBeCloseTo((-v0.vy * 120) / 60, 6); // it keeps drifting the whole time
  });

  it('turning changes the facing only; thrust then accelerates along the new nose', () => {
    const r = runWith({ mode: 'realistic' });
    steps(r, THRUST, 30);
    const v0 = { vx: r.ship.vx, vy: r.ship.vy };
    const h0 = r.ship.heading;
    steps(r, vin({ x: 1, y: 0 }), 23); // rotate right about 90 degrees, no thrust
    expect(Math.abs(wrapAngle(r.ship.heading - h0))).toBeGreaterThan(1.3);
    expect(r.ship.vx).toBeCloseTo(v0.vx, 9);
    expect(r.ship.vy).toBeCloseTo(v0.vy, 9);
    const before = { vx: r.ship.vx, vy: r.ship.vy };
    const n = noseOf(r.ship.heading);
    stepSector(r, THRUST);
    const dvx = r.ship.vx - before.vx;
    const dvy = r.ship.vy - before.vy;
    const dl = Math.hypot(dvx, dvy);
    expect((dvx * n.x + dvy * n.y) / dl).toBeGreaterThan(0.999);
    expect(dl).toBeCloseTo(realisticThrust(r.tune) / 60, 6);
  });

  it('the reverse thrusters brake along the nose; braking reduces speed, it never stops the ship in one tick', () => {
    const r = runWith({ mode: 'realistic' });
    cruise(r, 300);
    const s0 = speed(r);
    stepSector(r, vin({ x: 0, y: 1 }));
    expect(speed(r)).toBeLessThan(s0);
    expect(s0 - speed(r)).toBeCloseTo((realisticThrust(r.tune) * REALISTIC.reverseRatio) / 60, 6);
  });

  it('thrust cannot push past the ship\'s top speed; boost raises it the way it raises NORMAL\'s; each hull keeps its own stats', () => {
    const r = runWith({ mode: 'realistic' });
    steps(r, THRUST, 150);
    expect(speed(r)).toBeLessThanOrEqual(r.tune.maxSpeed + 1e-6);
    expect(speed(r)).toBeGreaterThan(r.tune.maxSpeed - 1);
    r.energy = 1e6;
    steps(r, { ...THRUST, boost: true }, 60);
    expect(speed(r)).toBeGreaterThan(r.tune.maxSpeed + 10);
    const slow = runWith({ mode: 'realistic', ship: 'condor' });
    const fast = runWith({ mode: 'realistic', ship: 'swift' });
    steps(slow, THRUST, 20);
    steps(fast, THRUST, 20);
    expect(speed(fast)).toBeGreaterThan(speed(slow));
    expect(realisticThrust(fast.tune) / realisticThrust(slow.tune)).toBeCloseTo(fast.tune.accel / slow.tune.accel, 9);
  });

  it('the stick points the nose and thrusts once aligned; aim turns the nose; the boost rule sees "thrust held"', () => {
    const i = realisticInput({ x: 0, y: 0 }, { x: 1, y: 0 }, null);
    expect(i.vector.pointX).toBe(1);
    expect(i.moveY).toBe(-1);
    expect(realisticInput({ x: 1, y: 0 }, { x: 0, y: 0 }, null).vector.turn).toBe(1);
    expect(realisticInput({ x: 0, y: 1 }, { x: 0, y: 0 }, null).vector.reverse).toBe(1);
    expect(realisticInput({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 3, y: 4 }).vector.aimX).toBe(3);
    const r = runWith({ mode: 'realistic' });
    steps(r, vin({ x: 0, y: 0 }, {}, { x: 1, y: 0 }), 60);
    expect(Math.abs(wrapAngle(r.ship.heading - Math.PI / 2))).toBeLessThan(0.01);
    expect(r.ship.vx).toBeGreaterThan(50); // thrusting right once aligned
  });

  it('is deterministic: the same inputs give the same flight', () => {
    const fly = (): number[] => {
      const r = runWith({ mode: 'realistic', landmarks: [body('p', 2600, 2000, 90)] });
      for (let t = 0; t < 600; t++) stepSector(r, vin({ x: t % 120 < 30 ? 1 : 0, y: t % 90 < 40 ? -1 : 0 }, { stopToggle: t === 400 }));
      return [r.ship.x, r.ship.y, r.ship.vx, r.ship.vy, r.ship.heading];
    };
    expect(fly()).toEqual(fly());
  });
});

describe('REALISTIC flight: gravity from the sector\'s real wells (P04.3)', () => {
  it('a coasting ship\'s path bends around a planet; with no landmark it stays straight', () => {
    const fly = (landmarks: Landmark[]): { turn: number; r: SectorRun } => {
      const r = runWith({ mode: 'realistic', landmarks });
      const c = centre(r);
      Object.assign(r.ship, { x: c.x - 900, y: c.y - 180, px: c.x - 900, py: c.y - 180, vx: 220, vy: 0, heading: Math.PI / 2 });
      const h0 = headingOf(r.ship.vx, r.ship.vy);
      let gMax = 0;
      for (let t = 0; t < 480; t++) {
        stepSector(r, IDLE);
        gMax = Math.max(gMax, r.gravity.g);
      }
      return { turn: wrapAngle(headingOf(r.ship.vx, r.ship.vy) - h0), r };
    };
    const c = centre(runWith());
    const bent = fly([body('p', c.x, c.y, 90)]);
    const straight = fly([]);
    expect(Math.abs(straight.turn)).toBeLessThan(1e-9);
    expect(bent.turn).toBeGreaterThan(0.1); // pulled toward the planet (below the path; y down, headings clockwise): the travel direction swings that way
    expect(bent.r.ship.heading).toBeCloseTo(Math.PI / 2, 9); // the nose was never turned by gravity
  });

  it('uses exactly the field NORMAL uses (pullOn: same wells, same cap) and reports it the same way', () => {
    const c = centre(runWith());
    const r = runWith({ mode: 'realistic', landmarks: [body('p', c.x + 200, c.y, 90)] });
    stepSector(r, IDLE);
    const expectG = pullOn(r.wells, r.ship.px, r.ship.py, r.tune.accel, freshGravity());
    expect(r.gravity.g).toBeCloseTo(expectG.g, 9);
    expect(r.gravity.g).toBeGreaterThan(50);
    // one tick of free fall changes the velocity by that pull (substeps sample it along the way): no double gravity
    const dv = Math.hypot(r.ship.vx, r.ship.vy);
    expect(dv).toBeGreaterThan(expectG.g / 60 * 0.95);
    expect(dv).toBeLessThan(expectG.g / 60 * 1.05);
  });

  it('a dive stays numerically stable and never passes through the planet (the sector collision rule still applies)', () => {
    const c = centre(runWith());
    const r = runWith({ mode: 'realistic', landmarks: [body('p', c.x, c.y, 90)] });
    r.invuln = 1e9;
    Object.assign(r.ship, { x: c.x - 700, y: c.y, px: c.x - 700, py: c.y, vx: 900, vy: 0 });
    let minD = Infinity;
    for (let t = 0; t < 300; t++) {
      stepSector(r, IDLE);
      expect(Number.isFinite(r.ship.x + r.ship.y + r.ship.vx + r.ship.vy)).toBe(true);
      minD = Math.min(minD, Math.hypot(r.ship.x - c.x, r.ship.y - c.y));
    }
    expect(minD).toBeGreaterThanOrEqual(90 + r.tune.radius - 1e-6);
  });
});

describe('STOP: braking, then station-keeping (P04.3)', () => {
  it('brakes visibly (thrust-limited, never a one-frame stop), then holds the point where it came to rest', () => {
    const r = runWith({ mode: 'realistic' });
    cruise(r, 300);
    const s0 = speed(r);
    const ev = steps(r, STOP_PRESS, 1);
    expect(ev).toContainEqual({ type: 'stop', change: 'engaged' });
    expect(stopDisplay(r.stop)).toBe('stopping');
    expect(s0 - speed(r)).toBeLessThanOrEqual(stopLimit(r.tune) / 60 + 1e-6); // at most one tick of full STOP thrust
    let ticks = 1;
    let prev = speed(r);
    while (r.stop.phase === 'braking' && ticks < 600) {
      stepSector(r, IDLE);
      ticks += 1;
      expect(speed(r)).toBeLessThanOrEqual(prev + 1e-9); // monotonic braking
      prev = speed(r);
    }
    expect(r.stop.phase).toBe('holding');
    // ~300 px/s at full thrust: it takes most of a second, not one frame
    expect(ticks).toBeGreaterThan(30);
    expect(ticks).toBeLessThan(90);
    const hold = { x: r.stop.holdX, y: r.stop.holdY };
    let maxErr = 0;
    for (let t = 0; t < 600; t++) {
      const x0 = r.ship.x;
      const y0 = r.ship.y;
      stepSector(r, IDLE);
      expect(Math.hypot(r.ship.x - x0, r.ship.y - y0)).toBeLessThan(1); // no teleport
      maxErr = Math.max(maxErr, Math.hypot(r.ship.x - hold.x, r.ship.y - hold.y));
    }
    expect(maxErr).toBeLessThan(STOP.tolerance);
    expect(speed(r)).toBeLessThan(0.01);
    expect(stopDisplay(r.stop)).toBe('holding');
  });

  it('holds against a planet\'s pull without oscillating, using no more than its thrust limit, with gravity still acting', () => {
    const c = centre(runWith());
    for (const ship of ['petrel', 'condor', 'swift'] as const) {
      const r = runWith({ mode: 'realistic', landmarks: [body('p', c.x, c.y, 90)], ship });
      Object.assign(r.ship, { x: c.x + 125, y: c.y, px: c.x + 125, py: c.y, vx: 0, vy: 160 }); // just above the surface, sliding
      stepSector(r, STOP_PRESS);
      steps(r, IDLE, 240);
      expect(r.stop.phase).toBe('holding');
      expect(r.gravity.g).toBeGreaterThan(120); // a strong pull is really there
      expect(r.gravity.g).toBeLessThan(stopLimit(r.tune));
      const hold = { x: r.stop.holdX, y: r.stop.holdY };
      const errs: number[] = [];
      for (let t = 0; t < 900; t++) {
        stepSector(r, IDLE);
        errs.push(Math.hypot(r.ship.x - hold.x, r.ship.y - hold.y));
      }
      expect(Math.max(...errs)).toBeLessThan(1);
      // settled: no growing or periodic motion in the last 5 s
      expect(Math.max(...errs.slice(600)) - Math.min(...errs.slice(600))).toBeLessThan(0.05);
      expect(stopDisplay(r.stop)).toBe('holding');
      expect(r.stop.saturated).toBe(false);
      // released: the planet pulls it down again (gravity was never switched off)
      stepSector(r, STOP_PRESS);
      expect(r.stop.phase).toBe('off');
      steps(r, IDLE, 30);
      expect(Math.hypot(r.ship.x - c.x, r.ship.y - c.y)).toBeLessThan(Math.hypot(hold.x - c.x, hold.y - c.y));
    }
  });

  it('says CAN\'T HOLD (never HOLDING) when the local pull needs more thrust than STOP has; collisions still stop the fall', () => {
    const c = centre(runWith());
    // the slowest hull: STOP ~352 px/s^2; planet surface ~200 + a full shear cloud 220 pull the same way
    const r = runWith({ mode: 'realistic', ship: 'condor', landmarks: [body('p', c.x, c.y, 90)], regions: [shear('s', c.x, c.y, 400, 1)] });
    r.invuln = 1e9;
    Object.assign(r.ship, { x: c.x + 115, y: c.y, px: c.x + 115, py: c.y });
    stepSector(r, STOP_PRESS);
    let everHolding = false;
    for (let t = 0; t < 300; t++) {
      stepSector(r, IDLE);
      if (stopDisplay(r.stop) === 'holding') everHolding = true;
      expect(Math.hypot(r.ship.x - c.x, r.ship.y - c.y)).toBeGreaterThanOrEqual(90 + r.tune.radius - 1e-6);
    }
    expect(everHolding).toBe(false);
    expect(stopDisplay(r.stop)).toBe('cannot');
    expect(r.stop.saturated).toBe(true);
  });

  it('thrust, reverse or the stick hand control back at once, with the velocity the ship really has (no jump)', () => {
    for (const input of [THRUST, vin({ x: 0, y: 1 }), vin({ x: 0, y: 0 }, {}, { x: 0.8, y: 0 })]) {
      const r = runWith({ mode: 'realistic' });
      cruise(r, 250);
      stepSector(r, STOP_PRESS);
      steps(r, IDLE, 10); // mid-brake
      expect(r.stop.phase).toBe('braking');
      const v0 = { vx: r.ship.vx, vy: r.ship.vy };
      const ev = stepSector(r, input);
      expect(ev).toContainEqual({ type: 'stop', change: 'cancelled' });
      expect(r.stop.phase).toBe('off');
      // the change this tick is at most one tick of the pilot's own engine
      expect(Math.hypot(r.ship.vx - v0.vx, r.ship.vy - v0.vy)).toBeLessThanOrEqual(realisticThrust(r.tune) / 60 + 1e-6);
      // and the momentum is kept afterwards (no hidden force left)
      const v1 = { vx: r.ship.vx, vy: r.ship.vy };
      steps(r, IDLE, 60);
      expect(r.ship.vx).toBeCloseTo(v1.vx, 9);
      expect(r.ship.vy).toBeCloseTo(v1.vy, 9);
    }
  });

  it('a key already held when STOP is pressed is ignored until released (the engine stays silent); a new press then cancels', () => {
    const r = runWith({ mode: 'realistic' });
    cruise(r, 250);
    stepSector(r, { ...THRUST, stopToggle: true });
    expect(r.stop.phase).toBe('braking');
    expect(r.stop.latch).toBe(true);
    const s0 = speed(r);
    steps(r, THRUST, 10);
    expect(speed(r)).toBeLessThan(s0); // still braking, the held key does not thrust
    expect(r.boosting).toBe(false);
    steps(r, IDLE, 1);
    expect(r.stop.latch).toBe(false);
    stepSector(r, THRUST);
    expect(r.stop.phase).toBe('off');
  });

  it('rotation keys, aim, weapon steps, lock presses and target steps never cancel STOP or change the velocity', () => {
    const r = runWith({ mode: 'realistic' });
    stepSector(r, STOP_PRESS);
    steps(r, IDLE, 120);
    expect(r.stop.phase).toBe('holding');
    const ev = [
      ...steps(r, vin({ x: 1, y: 0 }), 30),
      ...steps(r, vin({ x: 0, y: 0 }, {}, { x: 0, y: 0 }, { x: 1, y: 1 }), 30),
      ...steps(r, vin({ x: 0, y: 0 }, { cycle: 1 }), 1),
      ...steps(r, vin({ x: 0, y: 0 }, { lockToggle: true }), 1),
      ...steps(r, vin({ x: 0, y: 0 }, { targetCycle: true }), 1),
      ...steps(r, vin({ x: 0, y: 0 }, { fire: true }), 20),
    ];
    expect(ev.some((e) => e.type === 'stop')).toBe(false);
    expect(r.stop.phase).toBe('holding');
    expect(stopDisplay(r.stop)).toBe('holding');
  });

  it('STOP never turns the nose, and the target lock never moves the ship: one clear owner each', () => {
    const r = runWith({ mode: 'realistic' });
    cruise(r, 200);
    const h0 = r.ship.heading;
    stepSector(r, STOP_PRESS);
    steps(r, IDLE, 120);
    expect(r.ship.heading).toBe(h0);
    // the same flight with a lock aim injected: the path is identical, only the facing differs
    const a = runWith({ mode: 'realistic' });
    const b = runWith({ mode: 'realistic' });
    for (let t = 0; t < 200; t++) {
      stepSector(a, t < 30 ? THRUST : t === 60 ? STOP_PRESS : IDLE);
      stepSector(b, t < 30 ? THRUST : t === 60 ? { ...STOP_PRESS, vector: { ...STOP_PRESS.vector!, aimX: 1, aimY: 0 } } : t > 60 ? vin({ x: 0, y: 0 }, {}, { x: 0, y: 0 }, { x: 1, y: 0 }) : IDLE);
    }
    expect(b.ship.x).toBeCloseTo(a.ship.x, 9);
    expect(b.ship.y).toBeCloseTo(a.ship.y, 9);
    expect(Math.abs(wrapAngle(b.ship.heading - Math.PI / 2))).toBeLessThan(0.01);
  });

  it('pure state rules: toggle on / off, hand-back, display', () => {
    const s = freshStationKeeping();
    expect(stopDisplay(s)).toBe('off');
    expect(updateStationKeeping(s, true, false)).toBe('engaged');
    expect(updateStationKeeping(s, false, false)).toBe(null);
    expect(updateStationKeeping(s, true, false)).toBe('released');
    expect(s.phase).toBe('off');
    updateStationKeeping(s, true, false);
    expect(updateStationKeeping(s, false, true)).toBe('cancelled');
    expect(vectorMoving({ turn: 1, thrust: 0, reverse: 0, pointX: 0, pointY: 0, aimX: 5, aimY: 5 })).toBe(false);
    expect(vectorMoving({ turn: 0, thrust: 0, reverse: 0, pointX: 0.2, pointY: 0 })).toBe(false);
    expect(vectorMoving({ turn: 0, thrust: 0, reverse: 0, pointX: 0.5, pointY: 0 })).toBe(true);
  });
});

describe('mode switches and resets (P04.3)', () => {
  it('REALISTIC -> NORMAL mid-STOP: pose and velocity carry over, STOP is gone, and the next tick is exactly a NORMAL tick (no leftover force, no double gravity)', () => {
    const c = centre(runWith());
    const lm = [body('p', c.x + 220, c.y, 90)];
    const r = runWith({ mode: 'realistic', landmarks: lm });
    cruise(r, 200);
    stepSector(r, STOP_PRESS);
    steps(r, IDLE, 8);
    const pose = { ...r.ship };
    setRunFlightMode(r, 'normal');
    expect(r.ship).toEqual(pose);
    expect(r.flightMode).toBe('normal');
    expect(r.stop.phase).toBe('off');
    // compare with a fresh NORMAL run put in the same state
    const n = runWith({ landmarks: lm });
    Object.assign(n.ship, pose);
    for (let t = 0; t < 120; t++) {
      const i: SectorInput = { moveX: t < 40 ? 1 : 0, moveY: 0 };
      stepSector(r, i);
      stepSector(n, i);
    }
    expect(r.ship).toEqual(n.ship);
    expect(r.gravity).toEqual(n.gravity);
  });

  it('NORMAL -> REALISTIC keeps the momentum (no impulse, no stale STOP); switching back and forth is harmless', () => {
    const r = runWith();
    for (let t = 0; t < 40; t++) stepSector(r, { moveX: 1, moveY: 0 });
    const v = { vx: r.ship.vx, vy: r.ship.vy };
    setRunFlightMode(r, 'realistic');
    expect(r.stop.phase).toBe('off');
    stepSector(r, IDLE);
    expect(r.ship.vx).toBeCloseTo(v.vx, 9);
    expect(r.ship.vy).toBeCloseTo(v.vy, 9);
    setRunFlightMode(r, 'realistic'); // no-op
    stepSector(r, STOP_PRESS);
    setRunFlightMode(r, 'normal');
    setRunFlightMode(r, 'realistic');
    expect(r.stop.phase).toBe('off');
  });

  it('STOP is cleared by a recall (destroyed), a restart, docking, survey completion and a ship change; a new run starts without it', () => {
    const fresh = (): SectorRun => {
      const r = runWith({ mode: 'realistic' });
      stepSector(r, STOP_PRESS);
      steps(r, IDLE, 5);
      expect(r.stop.phase).not.toBe('off');
      return r;
    };
    const a = fresh();
    a.hull = 0;
    a.invuln = 0;
    const ev = stepSector(a, IDLE);
    expect(ev.some((e) => e.type === 'recalled')).toBe(true);
    expect(a.stop.phase).toBe('off');
    const b = fresh();
    restartSector(b);
    expect(b.stop.phase).toBe('off');
    expect(b.flightMode).toBe('realistic'); // the preference stays; only the controller resets
    const c = fresh();
    applyShip(c, deriveShip('swift'));
    expect(c.stop.phase).toBe('off');
    // docking: a station in range (the bare arena has none, so one is added)
    const base = arena(1);
    const cx = base.width / 2;
    const cy = base.height / 2;
    const station: Poi = { id: 'station', kind: 'station', x: cx, y: cy - 300, r: 90, solidR: 0, label: 'Test station', required: false, loot: [], target: null, group: null, alertR: 0, wave: 0, tier: 0 as Poi['tier'], holdTicks: 0 };
    const full = createSectorRun({ ...base, landmarks: [], regions: [], pois: [...base.pois, station] }, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 5, flightMode: 'realistic' });
    full.phase = 'flight';
    full.grace = 1e9;
    Object.assign(full.ship, { x: station.x, y: station.y + 40, px: station.x, py: station.y + 40, vx: 0, vy: 0 });
    stepSector(full, STOP_PRESS);
    expect(full.stop.phase).not.toBe('off');
    expect(full.focus).toBe('station');
    expect(interact(full)).toContainEqual(expect.objectContaining({ type: 'docked' }));
    expect(full.stop.phase).toBe('off');
    // survey completion (the bare arena with no marks left completes on its first tick)
    const d = createSectorRun({ ...base, landmarks: [], regions: [] }, EMPTY_SECTOR_SAVE, { seed: 5, flightMode: 'realistic' });
    d.phase = 'flight';
    d.stop.phase = 'braking';
    stepSector(d, IDLE);
    expect(d.phase).toBe('complete');
    expect(d.stop.phase).toBe('off');
    expect(createSectorRun(arena(1), EMPTY_SECTOR_SAVE, { flightMode: 'realistic' }).stop.phase).toBe('off');
  });
});

describe('the flight mode preference and the STOP binding (P04.3)', () => {
  it('defaults to NORMAL; an older save (no field) flies NORMAL; junk falls back to NORMAL (repaired); REALISTIC round-trips', () => {
    expect(DEFAULT_CONTROLS.flightMode).toBe('normal');
    expect(sanitizeControls({ bindings: DEFAULT_BINDINGS, mouseAim: false, zoom: 1 })).toEqual({ controls: { ...DEFAULT_CONTROLS }, repaired: false });
    expect(sanitizeControls({ bindings: DEFAULT_BINDINGS, flightMode: 'warp' })).toMatchObject({ controls: { flightMode: 'normal' }, repaired: true });
    expect(sanitizeControls({ bindings: DEFAULT_BINDINGS, flightMode: 7 })).toMatchObject({ controls: { flightMode: 'normal' }, repaired: true });
    const store = new MemoryStore();
    expect(loadFreeRoamPrefs(store).data.controls.flightMode).toBe('normal');
    saveFreeRoamPrefs(store, { controls: { ...DEFAULT_CONTROLS, flightMode: 'realistic', zoom: 1.2 } });
    const back = loadFreeRoamPrefs(store);
    expect(back.status).toBe('ok');
    expect(back.data.controls.flightMode).toBe('realistic');
    expect(back.data.controls.zoom).toBe(1.2);
    // STOP state is never part of the preference
    const raw = store.read('galaxia:freeroam:prefs')!;
    expect(raw).not.toMatch(/hold|braking|station|"stop"\s*:\s*\{/i);
  });

  it('STOP is bound to B by default, collides with nothing, and an older bindings save gets B (or a spare key) without being reset', () => {
    expect(FLIGHT_ACTIONS).toContain('stop');
    expect(DEFAULT_BINDINGS.stop).toEqual(['KeyB', null]);
    const all = FLIGHT_ACTIONS.flatMap((a) => DEFAULT_BINDINGS[a].filter((k) => k !== null));
    expect(new Set(all).size).toBe(all.length);
    expect(trackedCodes(DEFAULT_BINDINGS)).toContain('KeyB');
    // the P04.1 / P04.2 keys are unchanged
    expect(DEFAULT_BINDINGS.missile[0]).toBe('KeyQ');
    expect(DEFAULT_BINDINGS.lock[0]).toBe('KeyX');
    expect(DEFAULT_BINDINGS.target[0]).toBe('KeyC');
    const { stop: _s, ...older } = DEFAULT_BINDINGS;
    const r = sanitizeBindings(older);
    expect(r.repaired).toBe(false);
    expect(r.bindings.stop).toEqual(['KeyB', null]);
    const taken = sanitizeBindings({ ...older, cargo: ['KeyB', null] });
    expect(taken.repaired).toBe(false);
    expect(taken.bindings.cargo[0]).toBe('KeyB');
    expect(taken.bindings.stop[0]).not.toBe('KeyB');
    expect(findBinding(taken.bindings, taken.bindings.stop[0])?.action).toBe('stop');
  });
});
