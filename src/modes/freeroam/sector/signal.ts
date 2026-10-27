/**
 * Signal triangulation (P06.1): the investigation state machine of an
 * anomaly. Pure and deterministic: no DOM, no clock, no unseeded randomness; it reads
 * the run and writes only its own `run.signal` state. It never touches input,
 * the ship's position or velocity, weapons, the wallet, the hold or
 * progression; the reward still comes from the one existing investigation
 * (sector/collect.ts), once.
 *
 * Every unresolved anomaly (not done, never opened) is a signal target:
 *
 *   FAINT SIGNAL         detected, no bearing yet (the marker is only the
 *                        middle of an uncertainty ring; the source is hidden)
 *   BEARING COLLECTION   1+ valid bearings, no fix yet
 *   SOURCE RESOLVED      the bearings fixed the source (or the fallback did)
 *   INVESTIGATION        resolved and the ship within reach of the fix: the
 *   AVAILABLE            existing INVESTIGATE interaction, at the fix
 *
 * then the existing completion (persisted `done`) ends it. Leaving the sector,
 * a restart or a recall drops all partial progress (nothing here is saved);
 * the next visit starts FAINT with the same hidden source and noise sequence.
 *
 * A bearing: INTERACT on the target starts an observation; the ship must stay
 * within sensor range of the marker, slower than 60 px/s, with no planet or
 * star on the line to the source and at least 64 px from every earlier
 * observation point, for 48 consecutive flight ticks (0.8 s). Any break
 * resets it (pause, panels, docking, a ship change or a restart cancel it
 * too). Pressing again while observing restarts nothing and records nothing.
 *
 * Hidden coordinates: the source lives only in a private cache here. Views
 * hand out measured bearings, counts and, after resolution, the fix.
 */
import { createRng } from '../../../core/rng.ts';
import { fnv1a32 } from '../catalogue/build.ts';
import { inInterference } from '../combat/hazards.ts';
import { sweptHit } from '../combat/world.ts';
import { STAT_BOUNDS } from '../ships/equipment.ts';
import { bestSeparation, closestOnRay, DEG, inFront, leastSquaresFix, TAU, validRay, wrapAngle } from './bearing.ts';
import { dist, solidsOf } from './grid.ts';
import { SECTOR_GEN, type Landmark, type Point, type Poi, type SectorLayout } from './model.ts';
import type { SectorEvent, SectorRun } from './run.ts';

export const SIGNAL = Object.freeze({
  /** A bearing needs the ship slower than this (px/s). */
  maxSpeed: 60,
  /** Stable observation: 0.8 s at the fixed 60 Hz step. */
  holdTicks: 48,
  /** Bearing lines closer than this in angle never resolve together (degrees). */
  minSeparationDeg: 35,
  /** The fifth valid bearing always resolves (soft-lock guard). */
  maxBearings: 5,
  /** Each bearing must be taken this far (px) from every earlier observation point. */
  minMove: 64,
  /** Hidden source: within this radius of the marker, at least sourceMin of it away. */
  sourceRadius: 150,
  sourceMin: 0.2,
  /** The source keeps this clear of solids and coronas (px). */
  clearance: 48,
  sourceTries: 24,
  /** Uncertainty ring = sourceRadius + ringSlack * (1 - sensor quality): it always contains the source. */
  ringSlack: 150,
  /** Bearing error half-width (degrees) at sensor quality 0 and 1, before a Surveyor and interference. */
  spreadDeg: [4, 2] as const,
  /** Inside sensor interference the half-width doubles; always within [min, max]. */
  jamMul: 2,
  minSpreadDeg: 0.5,
  maxSpreadDeg: 8,
  /** A fix resolves the source when it lies this close to it (px). */
  tolerance: 45,
});

export type SignalPhase = 'faint' | 'bearings' | 'resolved';
export type SignalState = SignalPhase | 'available';
export type SignalRefusal = 'range' | 'speed' | 'occluded' | 'samePlace' | 'offer';
export type SignalHow = 'fix' | 'fallback' | 'simple';

/** One recorded bearing: where it was taken, the MEASURED direction (radians, atan2) and its error half-width (degrees). */
export interface Bearing {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly spread: number;
}

export interface SignalResolution {
  readonly x: number;
  readonly y: number;
  readonly how: SignalHow;
  /** Exactly two bearings, 35+ degrees apart, within tolerance (a cosmetic distinction only). */
  readonly clean: boolean;
}

export interface SignalTrack {
  readonly id: string;
  readonly bearings: Bearing[];
  /** Null until resolved; then where the INVESTIGATE interaction is. */
  fix: SignalResolution | null;
  /** Why the last attempt or observation failed (cleared by the next bearing), and the body in the way. */
  refusal: SignalRefusal | null;
  blocker: string | null;
}

export interface SignalOptions {
  /** Accessibility (FlightControls.simpleSignals): one valid bearing resolves. */
  readonly simple: boolean;
  /** Bearing spread factor from the Surveyor on duty (crew/traits.ts surveyorSpreadFactor; 1 = solo). */
  readonly assist: number;
}

export interface SignalRunState {
  readonly tracks: Map<string, SignalTrack>;
  /** The observation in progress, or null. */
  obs: { readonly id: string; ticks: number } | null;
  simple: boolean;
  assist: number;
}

export type SignalResult =
  | { readonly kind: 'observing'; readonly ticks: number; readonly need: number }
  | { readonly kind: 'refused' | 'interrupted'; readonly reason: SignalRefusal; readonly by: string | null }
  | { readonly kind: 'bearing'; readonly bearing: Bearing; readonly count: number; readonly separation: number | null; readonly toFallback: number; readonly resolved: SignalResolution | null };

/* -------------------------------------------------------------- the source */

const seedOf = (seed: number, salt: string, k: number): number => (Math.imul((seed ^ fnv1a32(salt)) >>> 0, 0x9e3779b1) + Math.imul(k + 1, 0x85ebca6b)) >>> 0;
const sources = new WeakMap<SectorLayout, Map<string, Point>>();

function sourceFits(L: SectorLayout, x: number, y: number): boolean {
  const m = SECTOR_GEN.edgeMargin / 2;
  if (x < m || y < m || x > L.width - m || y > L.height - m) return false;
  for (const l of L.landmarks) if (dist({ x, y }, l) < Math.max(l.r, l.hazardR) + SIGNAL.clearance) return false;
  for (const c of solidsOf({ landmarks: [], rocks: L.rocks, pois: L.pois })) if (dist({ x, y }, c) < c.r + SIGNAL.clearance) return false;
  return true;
}

/**
 * The hidden signal source of an anomaly: a seeded offset from its marker
 * (stream `signal:<id>` of the sector seed), clear of solids, coronas and the
 * sector edge; the marker itself only if no offset fits. Same layout and id,
 * same point. Sector logic only: the presentation never reads it.
 */
export function signalSource(L: SectorLayout, p: Poi): Point {
  let m = sources.get(L);
  if (!m) sources.set(L, (m = new Map()));
  let s = m.get(p.id);
  if (s) return s;
  const rng = createRng(seedOf(L.seed, `signal:${p.id}`, 0));
  s = { x: p.x, y: p.y };
  for (let i = 0; i < SIGNAL.sourceTries; i++) {
    const a = rng.next() * TAU;
    const d = SIGNAL.sourceRadius * (SIGNAL.sourceMin + (1 - SIGNAL.sourceMin) * Math.sqrt(rng.next()));
    const x = p.x + Math.cos(a) * d;
    const y = p.y + Math.sin(a) * d;
    if (sourceFits(L, x, y)) {
      s = { x, y };
      break;
    }
  }
  m.set(p.id, Object.freeze(s));
  return s;
}

/** Sensor quality 0..1 over the derived stat's own bounds (ships/equipment.ts STAT_BOUNDS). */
const quality = (sensor: number): number => {
  const [lo, hi] = STAT_BOUNDS.sensor;
  return Number.isFinite(sensor) ? Math.min(1, Math.max(0, (sensor - lo) / (hi - lo))) : 0;
};

/** Radius of the uncertainty ring around the marker for a sensor range: longer sensors, tighter ring. */
export const ringRadius = (sensor: number): number => SIGNAL.sourceRadius + SIGNAL.ringSlack * (1 - quality(sensor));

/** Bearing error half-width (degrees): sensors, then the Surveyor factor (0.5..1), then interference; bounded. */
export function bearingSpread(sensor: number, assist: number, jammed: boolean): number {
  const [a, b] = SIGNAL.spreadDeg;
  const k = Number.isFinite(assist) ? Math.min(1, Math.max(0.5, assist)) : 1;
  const e = (a + (b - a) * quality(sensor)) * k * (jammed ? SIGNAL.jamMul : 1);
  return Math.min(SIGNAL.maxSpreadDeg, Math.max(SIGNAL.minSpreadDeg, e));
}

/** The measured direction from (x, y): the true direction to the source plus seeded noise in [-spread, +spread] (stream `signal-noise:<id>`, index k). */
export function measureBearing(L: SectorLayout, p: Poi, k: number, x: number, y: number, spread: number): number {
  const s = signalSource(L, p);
  const u = createRng(seedOf(L.seed, `signal-noise:${p.id}`, k)).next();
  return wrapAngle(Math.atan2(s.y - y, s.x - x) + (2 * u - 1) * spread * DEG);
}

/** The planet or star whose solid body crosses the line from (x, y) to the source (the shots' own sweptHit rule), or null. */
export function signalBlocker(L: SectorLayout, p: Poi, x: number, y: number): Landmark | null {
  const s = signalSource(L, p);
  for (const l of L.landmarks) if (sweptHit(x, y, s.x, s.y, l.x, l.y, l.r)) return l;
  return null;
}

/* -------------------------------------------------------------- resolution */

export interface ResolveContext {
  readonly source: Point;
  readonly marker: Point;
  readonly ring: number;
  readonly width: number;
  readonly height: number;
  readonly simple: boolean;
}

const inside = (p: Point, c: ResolveContext): boolean => p.x >= 0 && p.y >= 0 && p.x <= c.width && p.y <= c.height;

/** Bring an estimate into the uncertainty ring and the sector (fallback and Simple Signals only). */
function settle(p: Point, c: ResolveContext): Point {
  const d = dist(p, c.marker);
  const k = d > c.ring ? c.ring / d : 1;
  const x = c.marker.x + (p.x - c.marker.x) * k;
  const y = c.marker.y + (p.y - c.marker.y) * k;
  return { x: Math.min(c.width, Math.max(0, x)), y: Math.min(c.height, Math.max(0, y)) };
}

/**
 * Does this set of bearings resolve the source? Normal: two or more bearings
 * with two lines 35+ degrees apart whose least-squares fix lies in the sector,
 * in front of every observer and within the tolerance of the source; else the
 * fifth bearing resolves anyway (the fit, or the last ray's point nearest the
 * marker, kept inside the ring). Simple Signals: the first bearing resolves
 * at its ray's point nearest the marker. Invalid bearing records are ignored.
 */
export function resolveSignal(all: readonly Bearing[], c: ResolveContext): SignalResolution | null {
  const bs = all.filter(validRay);
  const n = bs.length;
  const last = bs[n - 1];
  if (!last) return null;
  if (c.simple) return { ...settle(closestOnRay(last, c.marker), c), how: 'simple', clean: false };
  const f = n >= 2 ? leastSquaresFix(bs) : null;
  if (f && inside(f, c) && (bestSeparation(bs) ?? 0) >= SIGNAL.minSeparationDeg && inFront(bs, f, SIGNAL.tolerance / 2) && dist(f, c.source) <= SIGNAL.tolerance) {
    return { x: f.x, y: f.y, how: 'fix', clean: n === 2 };
  }
  if (n < SIGNAL.maxBearings) return null;
  return { ...settle(f && inside(f, c) ? f : closestOnRay(last, c.marker), c), how: 'fallback', clean: false };
}

/* ------------------------------------------------------------ the run state */

const track = (id: string): SignalTrack => ({ id, bearings: [], fix: null, refusal: null, blocker: null });

/** Signal targets of a visit: anomalies not done and never opened (saved leftovers mean an earlier visit resolved it). */
export function createSignals(L: SectorLayout, done: ReadonlySet<string>, opened: ReadonlyMap<string, unknown>): SignalRunState {
  const tracks = new Map<string, SignalTrack>();
  for (const p of L.pois) {
    if (p.kind !== 'anomaly' || done.has(p.id) || opened.has(p.id)) continue;
    signalSource(L, p); // initialised with the sector, deterministically
    tracks.set(p.id, track(p.id));
  }
  return { tracks, obs: null, simple: false, assist: 1 };
}

/** Sector reset (restart, recall): every target back to FAINT; the sources stay. */
export function resetSignals(run: SectorRun): void {
  for (const id of run.signal.tracks.keys()) run.signal.tracks.set(id, track(id));
  run.signal.obs = null;
}

/** Simple Signals and the Surveyor factor. Changing them never resolves or awards anything by itself. */
export function setSignalOptions(run: SectorRun, o: SignalOptions): void {
  run.signal.simple = o.simple === true;
  run.signal.assist = Number.isFinite(o.assist) ? Math.min(1, Math.max(0.5, o.assist)) : 1;
}

/** An unresolved signal target (else null: the anomaly behaves as before). */
const open = (run: SectorRun, p: Poi): SignalTrack | null => {
  const t = run.signal.tracks.get(p.id);
  return t && !t.fix && !run.done.has(p.id) ? t : null;
};

/** Where an anomaly's button interaction is and how far it reaches: a bearing anywhere within sensor range once detected, the investigation at the fix. */
export function signalReach(run: SectorRun, p: Poi): { readonly x: number; readonly y: number; readonly r: number } | null {
  const t = run.signal.tracks.get(p.id);
  if (!t) return null;
  const near = p.r + run.tune.radius;
  if (t.fix) return { x: t.fix.x, y: t.fix.y, r: near };
  return { x: p.x, y: p.y, r: run.revealed.has(p.id) ? Math.max(near, run.craft.stats.sensor) : near };
}

/** The INTERACT prompt verb: the bearing (numbered after the first, its hold progress while observing), else the POI's own verb. */
export function poiVerb(run: SectorRun, p: Poi, verb: string): string {
  const t = open(run, p);
  if (!t) return verb;
  const f = signalProgress(run, p.id);
  return f > 0 ? `Hold steady ${Math.floor(f * 10) * 10}%` : `Take bearing${t.bearings.length ? ` ${t.bearings.length + 1}` : ''}`;
}

function check(run: SectorRun, p: Poi, t: SignalTrack): { reason: SignalRefusal; by: string | null } | null {
  const sh = run.ship;
  if (run.offer) return { reason: 'offer', by: null };
  if (!(dist(sh, p) <= run.craft.stats.sensor)) return { reason: 'range', by: null };
  if (!(Math.hypot(sh.vx, sh.vy) < SIGNAL.maxSpeed)) return { reason: 'speed', by: null };
  const b = signalBlocker(run.layout, p, sh.x, sh.y);
  if (b) return { reason: 'occluded', by: b.label };
  for (const q of t.bearings) if (dist(sh, q) < SIGNAL.minMove) return { reason: 'samePlace', by: null };
  return null;
}

/** INTERACT on an unresolved target: start an observation (null = not a signal target; investigate as before). */
export function startBearing(run: SectorRun, p: Poi): SignalResult | null {
  const t = open(run, p);
  if (!t) return null;
  const st = run.signal;
  if (st.obs?.id === p.id) return { kind: 'observing', ticks: st.obs.ticks, need: SIGNAL.holdTicks };
  const bad = check(run, p, t);
  t.refusal = bad?.reason ?? null;
  t.blocker = bad?.by ?? null;
  if (bad) return { kind: 'refused', ...bad };
  st.obs = { id: p.id, ticks: 0 };
  return { kind: 'observing', ticks: 0, need: SIGNAL.holdTicks };
}

/** Cancel the observation in progress (pause, panels, docking, ship change, phase change). */
export function cancelBearing(run: SectorRun): void {
  run.signal.obs = null;
}

/** One flight tick of the observation in progress (after the ship moved): break it, or record the bearing on the 48th steady tick. */
export function stepSignal(run: SectorRun, events: SectorEvent[]): void {
  const st = run.signal;
  const o = st.obs;
  if (!o) return;
  const p = run.layout.pois.find((q) => q.id === o.id);
  const t = p ? open(run, p) : null;
  if (!p || !t) {
    st.obs = null;
    return;
  }
  const bad = check(run, p, t);
  if (bad) {
    st.obs = null;
    t.refusal = bad.reason;
    t.blocker = bad.by;
    events.push({ type: 'signal', id: p.id, label: p.label, result: { kind: 'interrupted', ...bad } });
    return;
  }
  o.ticks += 1;
  if (o.ticks < SIGNAL.holdTicks) return;
  st.obs = null;
  const L = run.layout;
  const sh = run.ship;
  const sensor = run.craft.stats.sensor;
  const spread = bearingSpread(sensor, st.assist, inInterference(L, sh));
  const bearing: Bearing = Object.freeze({ x: sh.x, y: sh.y, angle: measureBearing(L, p, t.bearings.length, sh.x, sh.y, spread), spread });
  t.bearings.push(bearing);
  t.refusal = null;
  t.blocker = null;
  const fix = resolveSignal(t.bearings, { source: signalSource(L, p), marker: p, ring: ringRadius(sensor), width: L.width, height: L.height, simple: st.simple });
  if (fix) t.fix = Object.freeze({ ...reachable(L, fix), how: fix.how, clean: fix.clean });
  const n = t.bearings.length;
  events.push({ type: 'signal', id: p.id, label: p.label, result: { kind: 'bearing', bearing, count: n, separation: bestSeparation(t.bearings), toFallback: Math.max(0, SIGNAL.maxBearings - n), resolved: t.fix } });
}

/** Keep a fix outside every planet and star body (with room for the ship), so the investigation can always be reached. */
function reachable(L: SectorLayout, p: Point): Point {
  let { x, y } = p;
  for (const l of L.landmarks) {
    const d = Math.hypot(x - l.x, y - l.y);
    const min = l.r + SECTOR_GEN.shipClearance;
    if (d >= min) continue;
    const k = d > 0 ? min / d : 1;
    x = l.x + (d > 0 ? (x - l.x) * k : 0);
    y = l.y + (d > 0 ? (y - l.y) * k : -min);
  }
  return { x, y };
}

/* -------------------------------------------------------------------- views */

/** What a pilot may know about one target: measured bearings, counts, the ring, and the fix only once resolved. */
export interface SignalView {
  readonly id: string;
  readonly label: string;
  readonly state: SignalState;
  readonly marker: Point;
  readonly ring: number;
  readonly bearings: readonly Bearing[];
  readonly separation: number | null;
  readonly toFallback: number;
  readonly fix: SignalResolution | null;
  /** Observation progress 0..1, or null when none is running. */
  readonly observing: number | null;
  readonly refusal: SignalRefusal | null;
  readonly blocker: string | null;
  /** Error half-width a bearing taken here and now would have (degrees), and whether interference widens it. */
  readonly spread: number;
  readonly jammed: boolean;
  readonly inRange: boolean;
  readonly slow: boolean;
}

export function signalView(run: SectorRun, p: Poi): SignalView | null {
  const t = run.signal.tracks.get(p.id);
  if (!t || run.done.has(p.id)) return null;
  const sh = run.ship;
  const sensor = run.craft.stats.sensor;
  const jammed = inInterference(run.layout, sh);
  const o = run.signal.obs;
  const state: SignalState = t.fix ? (run.focus === p.id ? 'available' : 'resolved') : t.bearings.length ? 'bearings' : 'faint';
  return {
    id: p.id,
    label: p.label,
    state,
    marker: { x: p.x, y: p.y },
    ring: ringRadius(sensor),
    bearings: [...t.bearings],
    separation: bestSeparation(t.bearings),
    toFallback: Math.max(0, SIGNAL.maxBearings - t.bearings.length),
    fix: t.fix,
    observing: o?.id === p.id ? o.ticks / SIGNAL.holdTicks : null,
    refusal: t.refusal,
    blocker: t.blocker,
    spread: bearingSpread(sensor, run.signal.assist, jammed),
    jammed,
    inRange: dist(sh, p) <= sensor,
    slow: Math.hypot(sh.vx, sh.vy) < SIGNAL.maxSpeed,
  };
}

/** Was this anomaly's signal fixed cleanly in this visit (two bearings)? Readable after the investigation too (cosmetic tag only). */
export const cleanFix = (run: SectorRun, id: string): boolean => run.signal.tracks.get(id)?.fix?.clean === true;

/* P06.2 presentation reads: allocation-free, never the hidden source */

/** Progress (0..1) of the observation in progress (on `id`, if given); 0 when none. */
export function signalProgress(run: SectorRun, id?: string): number {
  const o = run.signal.obs;
  return o && (id === undefined || o.id === id) ? o.ticks / SIGNAL.holdTicks : 0;
}

/** The recorded (measured, noisy) bearings of an unresolved target, or null (no target, resolved or done). */
export const openBearings = (run: SectorRun, p: Poi): readonly Bearing[] | null => open(run, p)?.bearings ?? null;

/** The point an anomaly is drawn and investigated at: its fix once resolved, else its marker. */
export const signalPoint = (run: SectorRun, p: Poi): Point => run.signal.tracks.get(p.id)?.fix ?? p;
