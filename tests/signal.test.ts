/**
 * P06.1 Signal Triangulation: the hidden source, bearings through the
 * existing INTERACT path, the 35 degree geometry gate, the five-bearing
 * fallback, planetary occlusion, Simple Signals, the Surveyor factor, the
 * investigation unlocked once (reward once), and the visit lifecycle.
 * Deterministic seeds only; flight timing is the fixed sim step.
 */
import { describe, expect, it } from 'vitest';
import { observe } from '../src/modes/freeroam/advisor/observe.ts';
import { createForecaster } from '../src/modes/freeroam/advisor/forecast.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { sectorGameEvents } from '../src/modes/freeroam/progression/fromSector.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { SECTOR_GEN, type HazardZone, type Landmark, type Point, type Poi, type SectorLayout, type SectorSave } from '../src/modes/freeroam/sector/model.ts';
import { applyShip, createSectorRun, disposeSectorRun, interact, isDone, pauseSector, restartSector, resumeSector, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { bestSeparation, closestOnRay, DEG, intersectRays, leastSquaresFix, lineSeparationDeg, wrapAngle } from '../src/modes/freeroam/sector/bearing.ts';
import {
  bearingSpread,
  cleanFix,
  measureBearing,
  poiVerb,
  resolveSignal,
  ringRadius,
  setSignalOptions,
  SIGNAL,
  signalBlocker,
  signalPoint,
  signalSource,
  signalView,
  startBearing,
  type Bearing,
  type ResolveContext,
  type SignalResult,
} from '../src/modes/freeroam/sector/signal.ts';
import { DEFAULT_CONTROLS, sanitizeControls, withSimpleSignals } from '../src/modes/freeroam/profile.ts';
import { loadFreeRoamPrefs, saveFreeRoamPrefs } from '../src/modes/freeroam/saveSlots.ts';
import { deriveShip, STAT_BOUNDS } from '../src/modes/freeroam/ships/equipment.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import type { ShipId } from '../src/modes/freeroam/ships/types.ts';

const graph = buildNavGraph();
const SYSTEMS = getCatalogue().systems;
const gen = (id: string): SectorLayout => generateSector(SYSTEMS.find((s) => s.id === id)!, sectorContext(graph, id));
const ALL: readonly SectorLayout[] = SYSTEMS.map((s) => generateSector(s, sectorContext(graph, s.id)));
const SOL = gen('milky-way/sol');
const SURVEYED: SectorSave = { done: [], surveyed: true };
const idle: SectorInput = { moveX: 0, moveY: 0 };
const SHIPS: readonly ShipId[] = ['swift', 'shrike', 'petrel', 'magpie', 'condor', 'albatross'];
const anomalies = (L: SectorLayout): Poi[] => L.pois.filter((p) => p.kind === 'anomaly');
const ANOMALIES = ALL.flatMap((L) => anomalies(L).map((p) => ({ L, p })));
/** A real system with an anomaly, bodies and stars (Sol has no anomaly). */
const HOME = ALL.find((L) => anomalies(L).length >= 1 && L.landmarks.length >= 4)!;
const BODY = ALL.flatMap((L) => L.landmarks).find((l) => l.kind === 'body')!;
const BASE = anomalies(HOME)[0]!;

const mid = (L: SectorLayout): Point => ({ x: L.width / 2, y: L.height / 2 });
/** A calm, empty copy of a sector with only the given POIs (and extras). */
function open(L: SectorLayout, pois: readonly Poi[], extra: Partial<SectorLayout> = {}): SectorLayout {
  return { ...L, landmarks: [], regions: [], rocks: [], patrols: [], sites: [], hazards: [], veins: [], pois, ...extra };
}
const anomalyAt = (id: string, at: Point): Poi => ({ ...BASE, id, x: at.x, y: at.y, label: 'Phase shimmer' }) as Poi;
const cacheLike = (id: string, at: Point): Poi => ({ ...SOL.pois.find((p) => p.kind === 'cache' || p.kind === 'derelict')!, id, x: at.x, y: at.y }) as Poi;
const planetLike = (id: string, at: Point, r = 60): Landmark => ({ ...BODY, id, label: 'Test world', x: at.x, y: at.y, r, solidR: r, hazardR: 0 }) as Landmark;
const place = (r: SectorRun, at: Point): void => {
  Object.assign(r.ship, { x: at.x, y: at.y, px: at.x, py: at.y, vx: 0, vy: 0 });
};
function fly(r: SectorRun, ticks: number, at: Point | null): SectorEvent[] {
  const out: SectorEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    if (at) place(r, at);
    out.push(...stepSector(r, idle));
  }
  return out;
}
const signals = (ev: readonly SectorEvent[]): SignalResult[] => ev.flatMap((e) => (e.type === 'signal' ? [e.result] : []));
const looted = (ev: readonly SectorEvent[]) => ev.filter((e) => e.type === 'looted');
/** Point at `d` px from `from` in direction `deg` (screen axes). */
const polar = (from: Point, deg: number, d: number): Point => ({ x: from.x + Math.cos(deg * DEG) * d, y: from.y + Math.sin(deg * DEG) * d });

/** Press INTERACT on the target from `at`, then hold steady there for `hold` ticks. */
function bearingFrom(r: SectorRun, id: string, at: Point, hold: number = SIGNAL.holdTicks): SectorEvent[] {
  fly(r, 1, at);
  r.focus = id;
  const start = interact(r);
  return [...start, ...fly(r, hold, at)];
}
/** The bearings of the scripted two-angle approach (60 degrees apart, 300 px from the source). */
function triangulate(r: SectorRun, p: Poi, angles: readonly number[] = [0, 60], d = 300): SectorEvent[] {
  const s = signalSource(r.layout, p);
  return angles.flatMap((a) => bearingFrom(r, p.id, polar(s, a, d)));
}
/** Investigate at the fix (the existing interaction). */
function investigate(r: SectorRun, p: Poi): SectorEvent[] {
  const at = signalPoint(r, p);
  fly(r, 1, at);
  r.focus = p.id;
  return interact(r);
}
const ctx = (L: SectorLayout, p: Poi): ResolveContext => ({ source: signalSource(L, p), marker: p, ring: ringRadius(900), width: L.width, height: L.height, simple: false });
const ray = (x: number, y: number, deg: number, spread = 0): Bearing => ({ x, y, angle: wrapAngle(deg * DEG), spread });
/** Exact (noise-free) bearings from observers toward a point. */
const toward = (t: Point, ...from: Point[]): Bearing[] => from.map((o) => ({ x: o.x, y: o.y, angle: Math.atan2(t.y - o.y, t.x - o.x), spread: 0 }));

/* ------------------------------------------------------------ the source */
describe('the hidden source: deterministic, offset, legal, never shown', () => {
  it('every anomaly in the galaxy gets a seeded offset inside its uncertainty radius, the sector and clear space', () => {
    expect(ANOMALIES.length).toBe(142);
    let atMarker = 0;
    for (const { L, p } of ANOMALIES) {
      const s = signalSource(L, p);
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d === 0) atMarker++;
      else expect(d).toBeGreaterThanOrEqual(SIGNAL.sourceRadius * SIGNAL.sourceMin - 1e-9);
      expect(d).toBeLessThanOrEqual(SIGNAL.sourceRadius + 1e-9);
      const m = SECTOR_GEN.edgeMargin / 2;
      expect(s.x >= m && s.y >= m && s.x <= L.width - m && s.y <= L.height - m, p.id).toBe(true);
      for (const l of L.landmarks) expect(Math.hypot(s.x - l.x, s.y - l.y), `${p.id} vs ${l.id}`).toBeGreaterThanOrEqual(Math.max(l.r, l.hazardR) + SIGNAL.clearance);
      // the uncertainty ring of every ship contains it
      for (const id of SHIPS) expect(d).toBeLessThanOrEqual(ringRadius(deriveShip(id).stats.sensor));
    }
    expect(atMarker).toBe(0); // not at the marker
  });

  it('is identical over 100 regenerations of the sector and differs per anomaly and per seed', () => {
    const first = signalSource(HOME, BASE);
    for (let i = 0; i < 100; i++) {
      const L = gen(HOME.systemId); // a fresh layout object: no cache shared
      expect(signalSource(L, anomalies(L)[0]!)).toEqual(first);
    }
    const m = mid(SOL);
    const a = signalSource(open(SOL, [anomalyAt('anomaly-a', m)]), anomalyAt('anomaly-a', m));
    const b = signalSource(open(SOL, [anomalyAt('anomaly-b', m)]), anomalyAt('anomaly-b', m));
    const c = signalSource({ ...open(SOL, [anomalyAt('anomaly-a', m)]), seed: (SOL.seed + 1) >>> 0 }, anomalyAt('anomaly-a', m));
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('is never exposed before resolution: views, the observation and the bearing events carry no source', () => {
    const m = mid(SOL);
    const p = anomalyAt('anomaly-1', m);
    const L = open(SOL, [p]);
    const r = createSectorRun(L, SURVEYED, { seed: 1 });
    const s = signalSource(L, p);
    const ev = bearingFrom(r, p.id, polar(s, 17, 300));
    const v = signalView(r, p)!;
    expect(v.fix).toBeNull();
    expect(Object.keys(v).sort()).toEqual(['bearings', 'blocker', 'fix', 'id', 'inRange', 'jammed', 'label', 'marker', 'observing', 'refusal', 'ring', 'separation', 'slow', 'spread', 'state', 'toFallback']);
    expect(signalPoint(r, p)).toBe(p); // drawn at the marker until resolved
    const o = observe(r, createForecaster(), { visit: 't#1', horizonS: 5, escape: null, route: null });
    const blob = JSON.stringify([v, o, signals(ev)]);
    for (const n of [s.x, s.y]) expect(blob).not.toContain(String(n));
    expect(o.signal).toMatchObject({ id: p.id, state: 'bearings', bearings: 1, toFallback: 4 });
    expect(o.pois.find((q) => q.id === p.id)).toMatchObject({ signal: true, verb: 'Take a bearing on' });
  });
});

/* ------------------------------------------------------------ sensors */
describe('sensor mapping: ring and bearing spread from the real sensor stat', () => {
  it('orders the ships by their catalogue sensor range (Albatross > Swift > Petrel), bounded', () => {
    const sensor = (id: ShipId): number => deriveShip(id).stats.sensor;
    expect(sensor('albatross')).toBeGreaterThan(sensor('swift'));
    expect(sensor('swift')).toBeGreaterThan(sensor('petrel'));
    expect(ringRadius(sensor('albatross'))).toBeLessThan(ringRadius(sensor('swift')));
    expect(ringRadius(sensor('swift'))).toBeLessThan(ringRadius(sensor('petrel')));
    expect(bearingSpread(sensor('albatross'), 1, false)).toBeLessThan(bearingSpread(sensor('petrel'), 1, false));
    const [lo, hi] = STAT_BOUNDS.sensor;
    expect([ringRadius(lo), ringRadius(hi), ringRadius(Number.NaN)]).toEqual([300, 150, 300]);
    expect([bearingSpread(lo, 1, false), bearingSpread(hi, 1, false)]).toEqual([4, 2]);
    for (const s of [0, lo, 900, hi, 1e9]) {
      for (const k of [0, 0.5, 1, 2, Number.NaN]) {
        for (const j of [false, true]) {
          const e = bearingSpread(s, k, j);
          expect(e).toBeGreaterThanOrEqual(SIGNAL.minSpreadDeg);
          expect(e).toBeLessThanOrEqual(SIGNAL.maxSpreadDeg);
        }
      }
    }
  });

  it('interference widens the spread (bounded); a Surveyor narrows it (factor clamped to 0.5..1)', () => {
    expect(bearingSpread(900, 1, true)).toBeCloseTo(2 * bearingSpread(900, 1, false), 9);
    expect(bearingSpread(900, 0.6, false)).toBeCloseTo(0.6 * bearingSpread(900, 1, false), 9);
    expect(bearingSpread(900, 0.1, false)).toBe(bearingSpread(900, 0.5, false));
    expect(bearingSpread(900, Number.NaN, false)).toBe(bearingSpread(900, 1, false));
  });
});

/* ------------------------------------------------------------ noise */
describe('bearing noise: bounded, seeded, separate stream', () => {
  it('stays within the spread for every anomaly and index, and repeats exactly', () => {
    for (const { L, p } of ANOMALIES) {
      const s = signalSource(L, p);
      const o = polar(s, 200, 250);
      const truth = Math.atan2(s.y - o.y, s.x - o.x);
      for (let k = 0; k < 6; k++) {
        const a = measureBearing(L, p, k, o.x, o.y, 3);
        expect(Math.abs(wrapAngle(a - truth))).toBeLessThanOrEqual(3 * DEG + 1e-9);
        expect(measureBearing(L, p, k, o.x, o.y, 3)).toBe(a);
      }
    }
  });

  it('varies with the observation index without moving the source', () => {
    const p = BASE;
    const s = signalSource(HOME, p);
    const o = polar(s, 90, 300);
    const seen = new Set<number>();
    for (let k = 0; k < 5; k++) seen.add(measureBearing(HOME, p, k, o.x, o.y, 4));
    expect(seen.size).toBe(5);
    expect(signalSource(HOME, p)).toBe(s);
  });

  it('a bearing taken inside sensor interference records the widened spread', () => {
    const m = mid(SOL);
    const p = anomalyAt('anomaly-1', m);
    const s = signalSource(open(SOL, [p]), p);
    const at = polar(s, 0, 300);
    const jam: HazardZone = { id: 'hazard-1', kind: 'interference', x: at.x, y: at.y, r: 120, faction: null, mines: [], period: 0 } as unknown as HazardZone;
    const r = createSectorRun(open(SOL, [p], { hazards: [jam] }), SURVEYED, { seed: 1 });
    const b = signals(bearingFrom(r, p.id, at)).find((x) => x.kind === 'bearing');
    expect(b?.kind === 'bearing' && b.bearing.spread).toBeCloseTo(bearingSpread(r.craft.stats.sensor, 1, true), 9);
    expect(signalView(r, p)!.jammed).toBe(true);
  });
});

/* ------------------------------------------------------------ geometry */
describe('bearing geometry (sector/bearing.ts)', () => {
  it('wraps angles and measures line separation across the seam (0..90 degrees)', () => {
    expect(Math.abs(wrapAngle(3 * Math.PI))).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(2 * Math.PI + 1)).toBeCloseTo(1, 12);
    expect(wrapAngle(-2 * Math.PI - 1)).toBeCloseTo(-1, 12);
    expect(lineSeparationDeg(179 * DEG, -179 * DEG)).toBeCloseTo(2, 9);
    expect(lineSeparationDeg(1 * DEG, 359 * DEG)).toBeCloseTo(2, 9);
    expect(lineSeparationDeg(10 * DEG, 190 * DEG)).toBeCloseTo(0, 9); // opposite rays: the same line
    expect(lineSeparationDeg(0, 100 * DEG)).toBeCloseTo(80, 9);
    expect(bestSeparation([ray(0, 0, 0)])).toBeNull();
    expect(bestSeparation([ray(0, 0, 0), ray(0, 0, 20), ray(0, 0, 50)])).toBeCloseTo(50, 9);
  });

  it('intersects rays only in front of both observers; parallel rays never meet', () => {
    const hit = intersectRays(ray(0, 0, 45), ray(100, 0, 135));
    expect(hit!.x).toBeCloseTo(50, 9);
    expect(hit!.y).toBeCloseTo(50, 9);
    expect(intersectRays(ray(0, 0, 0), ray(0, 100, 0))).toBeNull(); // parallel
    expect(intersectRays(ray(0, 0, 0), ray(0, 100, 180))).toBeNull(); // anti-parallel
    expect(intersectRays(ray(0, 0, -135), ray(100, 0, -45))).toBeNull(); // lines meet behind both
    expect(leastSquaresFix([ray(0, 0, 0), ray(0, 100, 0)])).toBeNull();
    expect(closestOnRay(ray(0, 0, 0), { x: -50, y: 10 })).toEqual({ x: 0, y: 0 }); // never behind the observer
  });

  it('two bearings under 35 degrees apart never resolve; 35 or more do (exact bearings)', () => {
    const m = mid(SOL);
    const p = anomalyAt('anomaly-1', m);
    const L = open(SOL, [p]);
    const c = ctx(L, p);
    const s = c.source;
    for (const sep of [0, 10, 20, 30, 34.9]) expect(resolveSignal(toward(s, polar(s, 0, 300), polar(s, sep, 300)), c), `${sep}`).toBeNull();
    for (const sep of [35.1, 45, 90, 144.9, 180 - 35.1]) {
      const f = resolveSignal(toward(s, polar(s, 0, 300), polar(s, sep, 300)), c);
      expect(f, `${sep}`).toMatchObject({ how: 'fix', clean: true });
      expect(Math.hypot(f!.x - s.x, f!.y - s.y)).toBeLessThan(1e-6);
    }
    // wrap: observers at 350 and 20 degrees around the source are 30 degrees apart, not 330
    expect(resolveSignal(toward(s, polar(s, 350, 300), polar(s, 20, 300)), c)).toBeNull();
    expect(resolveSignal(toward(s, polar(s, 350, 300), polar(s, 30, 300)), c)).toMatchObject({ how: 'fix' });
    // a third bearing: resolved, but not a clean fix
    expect(resolveSignal(toward(s, polar(s, 0, 300), polar(s, 10, 300), polar(s, 80, 300)), c)).toMatchObject({ how: 'fix', clean: false });
  });

  it('rejects parallel bearings, intersections behind the observers, out-of-sector fixes and fixes beyond tolerance', () => {
    const m = mid(SOL);
    const p = anomalyAt('anomaly-1', m);
    const L = open(SOL, [p]);
    const c = ctx(L, p);
    const s = c.source;
    // parallel (two observers on one line through the source)
    expect(resolveSignal(toward(s, polar(s, 0, 300), polar(s, 0, 500)), c)).toBeNull();
    // pointing away from the source: the lines cross behind both observers
    const away = toward(s, polar(s, 0, 300), polar(s, 70, 300)).map((b) => ({ ...b, angle: wrapAngle(b.angle + Math.PI) }));
    expect(resolveSignal(away, c)).toBeNull();
    // a perfect fix outside the sector
    const outside = { x: -120, y: m.y };
    expect(resolveSignal(toward(outside, { x: 100, y: m.y - 200 }, { x: 100, y: m.y + 200 }), { ...c, source: outside })).toBeNull();
    // the lines cross 3 tolerances from the source (bad bearings): no fix
    const off = { x: s.x + 3 * SIGNAL.tolerance, y: s.y };
    expect(resolveSignal(toward(off, polar(s, 0, 300), polar(s, 70, 300)), c)).toBeNull();
    // invalid records are ignored
    expect(resolveSignal([{ x: Number.NaN, y: 0, angle: 0, spread: 0 }], c)).toBeNull();
  });

  it('the fifth valid bearing always resolves, inside the uncertainty ring and the sector', () => {
    const m = mid(SOL);
    const p = anomalyAt('anomaly-1', m);
    const L = open(SOL, [p]);
    const c = ctx(L, p);
    const s = c.source;
    const parallel = toward(s, ...[300, 400, 500, 600, 700].map((d) => polar(s, 0, d)));
    expect(resolveSignal(parallel.slice(0, 4), c)).toBeNull();
    const awayFrom = parallel.map((b) => ({ ...b, angle: wrapAngle(b.angle + Math.PI) }));
    const outside = { x: -120, y: m.y };
    const cases = [parallel, awayFrom, toward(outside, ...[0, 1, 2, 3, 4].map((i) => ({ x: 100, y: m.y - 200 + i * 100 })))];
    for (const bs of cases) {
      const f = resolveSignal(bs, c)!;
      expect(f.how).toBe('fallback');
      expect(f.clean).toBe(false);
      expect(Math.hypot(f.x - m.x, f.y - m.y)).toBeLessThanOrEqual(c.ring + 1e-6);
      expect(f.x >= 0 && f.y >= 0 && f.x <= L.width && f.y <= L.height).toBe(true);
    }
  });
});

/* ------------------------------------------------------------ the observation */
describe('taking a bearing: existing INTERACT, range, speed, 48 steady ticks, one per press', () => {
  const setup = (ship: ShipId = 'petrel') => {
    const m = mid(SOL);
    const p = anomalyAt('anomaly-1', m);
    const L = open(SOL, [p]);
    const r = createSectorRun(L, SURVEYED, { seed: 1, ship: deriveShip(ship) });
    return { p, L, r, s: signalSource(L, p) };
  };

  it('records exactly on the 48th steady tick, typed: bearing, count, separation, fallback count; no source, no reward', () => {
    const { p, r, s } = setup();
    const at = polar(s, 0, 300);
    const ev = bearingFrom(r, p.id, at, SIGNAL.holdTicks - 1);
    expect(signals(ev)).toEqual([{ kind: 'observing', ticks: 0, need: 48 }]);
    expect(signalView(r, p)!.observing).toBeCloseTo(47 / 48, 9);
    const last = fly(r, 1, at);
    const [b] = signals(last);
    expect(b).toBeDefined();
    if (b?.kind !== 'bearing') throw new Error('no bearing');
    expect(Object.keys(b).sort()).toEqual(['bearing', 'count', 'kind', 'resolved', 'separation', 'toFallback']);
    expect(Object.keys(b.bearing).sort()).toEqual(['angle', 'spread', 'x', 'y']);
    expect([b.count, b.separation, b.toFallback, b.resolved]).toEqual([1, null, 4, null]);
    expect([b.bearing.x, b.bearing.y]).toEqual([r.ship.x, r.ship.y]);
    expect(looted(last)).toEqual([]);
    expect(sectorGameEvents(last[0]!, { systemId: 'milky-way/sol', kindOf: () => 'anomaly', applied: true, gained: [] })).toEqual([]);
    expect(signalView(r, p)!.state).toBe('bearings');
  });

  it('refuses out of sensor range, at 60 px/s or more, and from the same spot; nothing counts', () => {
    const { p, r, s } = setup();
    const sensor = r.craft.stats.sensor;
    fly(r, 1, polar(p, 0, sensor + 20));
    expect(r.focus).toBeNull(); // out of reach: INTERACT does not even address it
    r.focus = p.id;
    expect(signals(interact(r))).toEqual([{ kind: 'refused', reason: 'range', by: null }]);
    const at = polar(s, 0, 300);
    place(r, at);
    r.ship.vx = SIGNAL.maxSpeed;
    expect(startBearing(r, p)).toEqual({ kind: 'refused', reason: 'speed', by: null });
    r.ship.vx = SIGNAL.maxSpeed - 1;
    expect(startBearing(r, p)?.kind).toBe('observing');
    fly(r, SIGNAL.holdTicks, at);
    expect(signalView(r, p)!.bearings).toHaveLength(1);
    expect(signals(bearingFrom(r, p.id, polar(at, 90, SIGNAL.minMove - 2)))[0]).toEqual({ kind: 'refused', reason: 'samePlace', by: null });
    expect(signalView(r, p)!.bearings).toHaveLength(1);
    expect(signalView(r, p)!.refusal).toBe('samePlace');
  });

  it('a material interruption resets the observation: speed, a jump in position out of range, pause, ship change', () => {
    const { p, r, s } = setup();
    const at = polar(s, 0, 300);
    bearingFrom(r, p.id, at, 30);
    r.ship.vx = 400; // the pilot burns away
    const ev = stepSector(r, idle);
    expect(signals(ev)).toEqual([{ kind: 'interrupted', reason: 'speed', by: null }]);
    expect(signalView(r, p)!.observing).toBeNull();
    // restarting needs a full 48 steady ticks again
    expect(signals(bearingFrom(r, p.id, at, 47)).some((x) => x.kind === 'bearing')).toBe(false);
    expect(signals(fly(r, 1, at))[0]?.kind).toBe('bearing');
    // pause cancels; resume does not continue it
    const at2 = polar(s, 70, 300);
    bearingFrom(r, p.id, at2, 20);
    pauseSector(r);
    resumeSector(r);
    expect(signals(fly(r, 60, at2))).toEqual([]);
    // a ship change cancels
    bearingFrom(r, p.id, at2, 20);
    applyShip(r, deriveShip('swift'));
    expect(signals(fly(r, 60, at2))).toEqual([]);
    // so does docking (the existing station interaction)
    const st = createSectorRun(open(SOL, [p, { ...SOL.pois.find((x) => x.kind === 'station')!, x: at2.x + 400, y: at2.y }]), SURVEYED, { seed: 1 });
    bearingFrom(st, p.id, at2, 20);
    st.focus = st.layout.pois[1]!.id;
    expect(interact(st).some((e) => e.type === 'docked')).toBe(true);
    expect(st.signal.obs).toBeNull();
    expect(signalView(r, p)!.bearings).toHaveLength(1);
  });

  it('pressing again while observing restarts nothing and records nothing extra (key repeat, repeated calls)', () => {
    const { p, r, s } = setup();
    const at = polar(s, 0, 300);
    bearingFrom(r, p.id, at, 20);
    for (let i = 0; i < 5; i++) expect(signals(interact(r))).toEqual([{ kind: 'observing', ticks: 20, need: 48 }]);
    const ev = fly(r, 28, at);
    expect(signals(ev).filter((x) => x.kind === 'bearing')).toHaveLength(1);
    for (let i = 0; i < 5; i++) interact(r); // the presses after the bearing: refused (same spot), never a second bearing
    fly(r, 100, at);
    expect(signalView(r, p)!.bearings).toHaveLength(1);
  });

  it('proximity alone never resolves or investigates: hovering on the marker for 10 s does nothing', () => {
    const { p, r } = setup();
    const ev = fly(r, 600, p);
    expect(signals(ev)).toEqual([]);
    expect(looted(ev)).toEqual([]);
    expect(isDone(r, p)).toBe(false);
    expect(signalView(r, p)!.state).toBe('faint');
    expect(poiVerb(r, p, 'Investigate')).toBe('Take bearing');
    // INTERACT on the marker takes a bearing: it is not the investigation
    r.focus = p.id;
    expect(signals(interact(r))[0]?.kind).toBe('observing');
    expect(r.done.has(p.id)).toBe(false);
  });

  it('signal logic never moves the ship or writes outside its own state', () => {
    const { p, r, s } = setup();
    place(r, polar(s, 0, 300));
    const ship = { ...r.ship };
    const done = [...r.done];
    startBearing(r, p);
    signalView(r, p);
    signalPoint(r, p);
    expect(r.ship).toEqual(ship);
    expect([...r.done]).toEqual(done);
  });
});

/* ------------------------------------------------------------ occlusion */
describe('planetary occlusion: the segment from the ship to the hidden source', () => {
  const m = mid(SOL);
  const p = anomalyAt('anomaly-1', m);
  const s = signalSource(open(SOL, [p]), p);
  const at = polar(s, 0, 600);
  const layout = (l: Landmark): SectorLayout => {
    const L = open(SOL, [p], { landmarks: [l] });
    expect(signalSource(L, p)).toEqual(s); // the body does not move the source
    return L;
  };

  it('a body on the line blocks; one behind the source or beside the line does not', () => {
    expect(signalBlocker(layout(planetLike('planet-1', polar(s, 0, 300))), p, at.x, at.y)?.id).toBe('planet-1');
    expect(signalBlocker(layout(planetLike('planet-1', polar(s, 180, 300))), p, at.x, at.y)).toBeNull();
    const beside = { x: s.x + 300, y: s.y + 60 + 25 };
    expect(signalBlocker(layout(planetLike('planet-1', beside)), p, at.x, at.y)).toBeNull();
    const grazing = { x: s.x + 300, y: s.y + 60 - 5 };
    expect(signalBlocker(layout(planetLike('planet-1', grazing)), p, at.x, at.y)?.id).toBe('planet-1');
  });

  it('an occluded bearing is refused with the body and counts toward nothing; moving into the shadow interrupts', () => {
    const r = createSectorRun(layout(planetLike('planet-1', polar(s, 0, 300))), SURVEYED, { seed: 1 });
    for (let i = 0; i < 6; i++) expect(signals(bearingFrom(r, p.id, at))[0]).toEqual({ kind: 'refused', reason: 'occluded', by: 'Test world' });
    expect(signalView(r, p)!).toMatchObject({ bearings: [], fix: null, refusal: 'occluded', blocker: 'Test world' });
    const clear = polar(s, 40, 600);
    bearingFrom(r, p.id, clear, 10);
    const ev = fly(r, 1, at);
    expect(signals(ev)).toEqual([{ kind: 'interrupted', reason: 'occluded', by: 'Test world' }]);
    expect(signalView(r, p)!.bearings).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ integration */
describe('resolution unlocks the existing investigation, rewarded once', () => {
  it('two good bearings resolve; INVESTIGATE at the fix pays once; the anomaly stays done', () => {
    const m = mid(SOL);
    const p = anomalyAt('anomaly-1', m);
    const L = open(SOL, [p]);
    const r = createSectorRun(L, SURVEYED, { seed: 1 });
    const ev = triangulate(r, p);
    const res = signals(ev).filter((x) => x.kind === 'bearing');
    expect(res).toHaveLength(2);
    const fix = res[1]!.kind === 'bearing' ? res[1]!.resolved : null;
    expect(fix).toMatchObject({ how: 'fix', clean: true });
    expect(Math.hypot(fix!.x - signalSource(L, p).x, fix!.y - signalSource(L, p).y)).toBeLessThanOrEqual(SIGNAL.tolerance);
    expect(looted(ev)).toEqual([]); // resolving pays nothing
    expect(signalView(r, p)!.state).toBe('resolved');
    expect(poiVerb(r, p, 'Investigate')).toBe('Investigate');
    const first = investigate(r, p);
    expect(looted(first)).toHaveLength(1);
    expect(r.done.has(p.id)).toBe(true);
    expect(cleanFix(r, p.id)).toBe(true); // cosmetic tag, read from state
    const ge = sectorGameEvents(first[0]!, { systemId: 'milky-way/sol', kindOf: () => 'anomaly', applied: true, gained: [] });
    expect(ge).toContainEqual({ type: 'poi-completed', systemId: 'milky-way/sol', poiId: p.id, kind: 'anomaly' }); // contracts count it
    expect(investigate(r, p)).toEqual([]);
    expect(fly(r, 120, signalPoint(r, p)).filter((e) => e.type === 'looted' || e.type === 'signal')).toEqual([]);
    // a later visit: completed stays completed, no signal target
    const again = createSectorRun(L, { done: [p.id], surveyed: true }, { seed: 1 });
    expect(again.signal.tracks.has(p.id)).toBe(false);
    expect(isDone(again, p)).toBe(true);
  });

  it('the same reward as before P06.1: the investigation of a resolved anomaly equals the legacy one', () => {
    const m = mid(SOL);
    const p = anomalyAt('anomaly-1', m);
    const L = open(SOL, [p]);
    const r = createSectorRun(L, SURVEYED, { seed: 1 });
    triangulate(r, p);
    const got = looted(investigate(r, p))[0];
    // a visit that had already opened the anomaly (saved leftovers) investigates it at the marker, untouched by P06.1
    const legacy = createSectorRun(L, { done: [], surveyed: true }, { seed: 1 });
    legacy.signal.tracks.delete(p.id);
    fly(legacy, 1, p);
    legacy.focus = p.id;
    expect(looted(interact(legacy))[0]).toEqual(got);
  });

  it('caches and derelicts open at their marker exactly as before; only anomalies become signal targets', () => {
    const m = mid(SOL);
    const c = cacheLike('cache-1', m);
    const r = createSectorRun(open(SOL, [c]), SURVEYED, { seed: 1 });
    fly(r, 1, { x: c.x + c.solidR + r.tune.radius - 2, y: c.y });
    r.focus = c.id;
    expect(looted(interact(r))).toHaveLength(1);
    expect(r.signal.tracks.size).toBe(0);
    let tracked = 0;
    for (const L of ALL) {
      const run = createSectorRun(L, SURVEYED, { seed: 1 });
      for (const id of run.signal.tracks.keys()) expect(L.pois.find((q) => q.id === id)?.kind).toBe('anomaly');
      tracked += run.signal.tracks.size;
    }
    expect(tracked).toBe(ANOMALIES.length);
  });

  it('solo play stays completable: every anomaly in the galaxy resolves from open positions and pays once', () => {
    for (const src of ALL) {
      if (!anomalies(src).length) continue;
      const L: SectorLayout = { ...src, patrols: [], sites: [], hazards: [] };
      const r = createSectorRun(L, SURVEYED, { seed: 1 });
      for (const p of anomalies(L)) {
        for (let k = 0; k < 16 && !signalView(r, p)!.fix; k++) {
          const at = polar(p, k * 137.5, 280);
          if (L.landmarks.some((l) => Math.hypot(at.x - l.x, at.y - l.y) < Math.max(l.r, l.hazardR) + 40)) continue;
          bearingFrom(r, p.id, at);
        }
        expect(signalView(r, p)!.fix, `${L.systemId} ${p.id}`).not.toBeNull();
        expect(looted(investigate(r, p)), `${L.systemId} ${p.id}`).toHaveLength(1);
      }
    }
  });
});

/* ------------------------------------------------------------ simple signals, surveyor */
describe('Simple Signals and the Surveyor', () => {
  const m = mid(SOL);
  const p = anomalyAt('anomaly-1', m);
  const L = open(SOL, [p]);
  const s = signalSource(L, p);

  it('Simple Signals: one valid bearing resolves; range, speed and occlusion still apply; the reward stays once', () => {
    const r = createSectorRun(L, SURVEYED, { seed: 1 });
    setSignalOptions(r, { simple: true, assist: 1 });
    place(r, polar(s, 0, 300));
    r.ship.vx = 80;
    expect(startBearing(r, p)).toEqual({ kind: 'refused', reason: 'speed', by: null });
    const ev = bearingFrom(r, p.id, polar(s, 0, 300));
    const b = signals(ev).find((x) => x.kind === 'bearing');
    expect(b?.kind === 'bearing' && b.resolved).toMatchObject({ how: 'simple', clean: false });
    const fix = signalView(r, p)!.fix!;
    expect(Math.hypot(fix.x - p.x, fix.y - p.y)).toBeLessThanOrEqual(ringRadius(r.craft.stats.sensor) + 1e-6);
    expect(looted(investigate(r, p))).toHaveLength(1);
    expect(investigate(r, p)).toEqual([]);
    // occlusion is not waived
    const blocked = createSectorRun(open(SOL, [p], { landmarks: [planetLike('planet-1', polar(s, 0, 300))] }), SURVEYED, { seed: 1 });
    setSignalOptions(blocked, { simple: true, assist: 1 });
    expect(signals(bearingFrom(blocked, p.id, polar(s, 0, 600)))[0]).toMatchObject({ kind: 'refused', reason: 'occluded' });
    // turning it on never resolves anything by itself
    const fresh = createSectorRun(L, SURVEYED, { seed: 1 });
    setSignalOptions(fresh, { simple: true, assist: 1 });
    fly(fresh, 60, polar(s, 0, 300));
    expect(signalView(fresh, p)!.fix).toBeNull();
  });

  it('Simple Signals is an opt-in flag of the existing prefs record: off by default, only true stored, older prefs unchanged', () => {
    expect(DEFAULT_CONTROLS.simpleSignals).toBeUndefined();
    const store = new MemoryStore();
    expect(loadFreeRoamPrefs(store).data.controls.simpleSignals).toBeUndefined();
    const on = withSimpleSignals({ ...DEFAULT_CONTROLS, advice: 'critical', zoom: 1.5 }, true);
    expect(on).toMatchObject({ simpleSignals: true, advice: 'critical', zoom: 1.5 });
    expect(saveFreeRoamPrefs(store, { controls: on })).toBe(true);
    expect(loadFreeRoamPrefs(store)).toMatchObject({ status: 'ok', data: { controls: { simpleSignals: true, advice: 'critical' } } });
    const off = withSimpleSignals(on, false);
    expect('simpleSignals' in off).toBe(false);
    expect(off).toMatchObject({ advice: 'critical', zoom: 1.5 });
    expect(sanitizeControls({ bindings: DEFAULT_CONTROLS.bindings, mouseAim: false, zoom: 1, flightMode: 'normal' })).toMatchObject({ repaired: false });
    const junk = sanitizeControls({ ...DEFAULT_CONTROLS, simpleSignals: 'yes' });
    expect(junk.repaired).toBe(true);
    expect('simpleSignals' in junk.controls).toBe(false);
  });

  it('a Surveyor tightens the recorded spread but takes no bearing itself; options are clamped', () => {
    const solo = createSectorRun(L, SURVEYED, { seed: 1 });
    const crewed = createSectorRun(L, SURVEYED, { seed: 1 });
    setSignalOptions(crewed, { simple: false, assist: 0.6 });
    expect(signals(fly(crewed, 600, polar(s, 0, 300)))).toEqual([]); // no auto-collection
    const a = signals(bearingFrom(solo, p.id, polar(s, 0, 300))).find((x) => x.kind === 'bearing');
    const b = signals(bearingFrom(crewed, p.id, polar(s, 0, 300))).find((x) => x.kind === 'bearing');
    expect(a?.kind === 'bearing' && b?.kind === 'bearing').toBe(true);
    if (a?.kind !== 'bearing' || b?.kind !== 'bearing') return;
    expect(b.bearing.spread).toBeCloseTo(0.6 * a.bearing.spread, 9);
    setSignalOptions(crewed, { simple: false, assist: 0.01 });
    expect(crewed.signal.assist).toBe(0.5);
    setSignalOptions(crewed, { simple: false, assist: Number.NaN });
    expect(crewed.signal.assist).toBe(1);
  });
});

/* ------------------------------------------------------------ lifecycle, determinism */
describe('lifecycle and determinism', () => {
  const m = mid(SOL);
  const p = anomalyAt('anomaly-1', m);
  const q = anomalyAt('anomaly-2', { x: m.x + 900, y: m.y });
  const L = open(SOL, [p, q]);

  it('100 identical scripted visits give identical bearings, fixes and events', () => {
    const script = (): string => {
      const r = createSectorRun(L, SURVEYED, { seed: 7 });
      // 20 degrees apart: no fix; the third bearing (80 degrees) resolves
      const ev = signals(triangulate(r, p, [0, 20, 80]));
      expect(ev.filter((x) => x.kind === 'bearing').map((x) => x.kind === 'bearing' && x.resolved !== null)).toEqual([false, false, true]);
      return JSON.stringify([ev, signalView(r, p)!.fix]);
    };
    const first = script();
    for (let i = 0; i < 100; i++) expect(script()).toBe(first);
  });

  it('anomalies are independent; a restart, a new visit or dispose drops partial progress (same source and noise)', () => {
    const r = createSectorRun(L, SURVEYED, { seed: 1 });
    const s = signalSource(L, p);
    const one = signals(bearingFrom(r, p.id, polar(s, 0, 300))).find((x) => x.kind === 'bearing');
    expect(signalView(r, q)!.bearings).toHaveLength(0);
    expect(signalView(r, p)!.bearings).toHaveLength(1);
    restartSector(r);
    expect(signalView(r, p)!).toMatchObject({ state: 'faint', bearings: [], fix: null, refusal: null });
    expect(signalSource(L, p)).toBe(s);
    const again = signals(bearingFrom(r, p.id, polar(s, 0, 300))).find((x) => x.kind === 'bearing');
    expect(again).toEqual(one);
    const next = createSectorRun(L, SURVEYED, { seed: 1 });
    expect(signalView(next, p)!.state).toBe('faint');
    expect(signals(bearingFrom(next, p.id, polar(s, 0, 300))).find((x) => x.kind === 'bearing')).toEqual(one);
    disposeSectorRun(next);
    expect(next.signal.tracks.size).toBe(0);
    expect(next.signal.obs).toBeNull();
    expect(stepSector(next, idle)).toEqual([]);
  });

  it('a resolved but uninvestigated signal is not saved: the next visit starts faint again', () => {
    const r = createSectorRun(L, SURVEYED, { seed: 1 });
    triangulate(r, p);
    expect(signalView(r, p)!.fix).not.toBeNull();
    const back = createSectorRun(L, { done: [...r.done], surveyed: true }, { seed: 1 });
    expect(signalView(back, p)!.state).toBe('faint');
  });
});
