/**
 * Advisor observation builder (P05.2): turns the live sector run into the
 * frozen, read-only Observation (crew/observation.ts) that the Ship Mind and
 * the crew advisors read. The one bridge between the run and crew/advisor.ts.
 *
 * Sensor-honest by construction (nothing an advisor says can come from
 * anything the pilot's instruments do not already show):
 *  - targets: only POIs in `run.revealed` (the sector map's set); hidden
 *    ones are never listed, never counted except as the HUD's
 *    survey-marks-left number;
 *  - hostile contacts: the sector map's own rule (sector/combatRender.ts):
 *    none while the ship is inside interference, none inside interference,
 *    none beyond the ship's sensor range; plus alive and hostile;
 *  - gravity: the pull the ship feels this tick (run.gravity, the HUD arrow)
 *    and the drift forecast (advisor/forecast.ts, the game's own flight step).
 *
 * Read-only: it never assigns to the run or anything inside it, and calls
 * only reading helpers; the forecast works on its own scratch copy. The
 * result is a new frozen object holding numbers and strings only (no
 * reference into the run), so an advisor cannot reach the run through it.
 */
import { WEAPON_BY_ID } from '../../../config/weapons.ts';
import { inInterference } from '../combat/hazards.ts';
import { hostileTo } from '../combat/world.ts';
import { resourceName } from '../inventory/resources.ts';
import { isDone, RUN, type SectorRun } from '../sector/run.ts';
import { POI_RULES, type Landmark, type Poi } from '../sector/model.ts';
import { realisticThrust, stopDisplay } from '../sector/realisticFlight.ts';
import { signalView, type SignalView } from '../sector/signal.ts';
import { OBSERVATION_LIMITS, type Forecast, type Observation, type ObservedBody, type ObservedPoi, type ObservedPoiKind, type ObservedSignal, type Offset } from '../crew/observation.ts';
import type { NavDoctrine } from '../crew/types.ts';
import type { Forecaster, ForecastQuery } from './forecast.ts';

export interface ObserveOptions {
  /** Identity of this sector visit (the shell counts runs). */
  readonly visit: string;
  /** Forecast horizon (s): the longest any advisor on duty needs. */
  readonly horizonS: number;
  /** A Navigator is on duty: how many escape burns to check, in which doctrine order (null = no escape advice). */
  readonly escape: { readonly candidates: number; readonly doctrine: NavDoctrine } | null;
  /** Reactor cells and the lane costs out of this system (null = not applicable). */
  readonly route: { readonly cells: number; readonly cheapest: number; readonly dearest: number } | null;
}

const ADVISED: ReadonlySet<string> = new Set<ObservedPoiKind>(['survey', 'salvage', 'derelict', 'cache', 'anomaly', 'installation']);

const offset = (sx: number, sy: number, x: number, y: number): Offset => {
  const dx = x - sx;
  const dy = y - sy;
  return Object.freeze({ dx, dy, distance: Math.hypot(dx, dy) });
};

const bodyOf = (l: Landmark): ObservedBody => Object.freeze({ id: l.id, label: l.label, kind: l.kind });

/** Main resource of a target's sensor return (largest amount; the first on a tie). */
function mainResource(p: Poi): string | null {
  let best: { resource: string; amount: number } | null = null;
  for (const e of p.loot) if (!best || e.amount > best.amount) best = e;
  return best ? resourceName(best.resource) : null;
}

export function observe(run: SectorRun, fc: Forecaster, o: ObserveOptions): Observation {
  const L = run.layout;
  const sh = run.ship;
  const stats = run.craft.stats;
  const sensor = stats.sensor;
  const jammed = inInterference(L, sh);

  // hostile contacts: the sector map's rule
  let count = 0;
  let nearest: Offset | null = null;
  if (!jammed) {
    for (const a of run.hostiles) {
      if (a.state === 'destroyed' || a.state === 'disabled' || !hostileTo(run, a.faction, 'player') || inInterference(L, a)) continue;
      const d = Math.hypot(a.x - sh.x, a.y - sh.y);
      if (d > sensor) continue;
      count += 1;
      if (!nearest || d < nearest.distance) nearest = offset(sh.x, sh.y, a.x, a.y);
    }
  }

  // gravity felt now (the HUD arrow's numbers)
  const accel = run.tune.accel;
  const gv = run.gravity;
  const src = gv.source ? L.landmarks.find((l) => l.id === gv.source) ?? null : null;
  const closing = src !== null && (src.x - sh.x) * sh.vx + (src.y - sh.y) * sh.vy > 0;
  const realistic = run.flightMode === 'realistic';
  const engineBeats = realistic ? realisticThrust(run.tune) > gv.g : true;

  // inside a star's corona
  let inCorona: Observation['inCorona'] = null;
  for (const l of L.landmarks) {
    if (l.hazardR <= l.r) continue;
    const d = Math.hypot(sh.x - l.x, sh.y - l.y);
    if (d < l.hazardR) {
      inCorona = Object.freeze({ ...bodyOf(l), outX: d > 0 ? (sh.x - l.x) / d : 0, outY: d > 0 ? (sh.y - l.y) / d : -1 });
      break;
    }
  }

  // drift forecast (only where there is something to meet)
  let forecast: Forecast | null = null;
  const flying = run.phase === 'flight' && run.docked === null && !run.disposed && run.flight === null;
  if (flying && L.landmarks.length) {
    const q: ForecastQuery = { ship: sh, mode: run.flightMode, stop: run.stop, tune: run.tune, wells: run.wells, bodies: L.landmarks, width: L.width, height: L.height, impactSpeed: RUN.impactSpeed, horizonTicks: Math.round(o.horizonS * 60) };
    const hit = fc.coast(q);
    let impact: Forecast['impact'] = null;
    let escape: Forecast['escape'] = null;
    if (hit) {
      const l = L.landmarks[hit.body]!;
      const damaging = hit.kind === 'corona' || hit.speed > RUN.impactSpeed;
      if (damaging) {
        impact = Object.freeze({ body: bodyOf(l), inS: hit.ticks / 60, kind: hit.kind, damaging });
        if (o.escape) {
          const e = fc.escape(q, hit, o.escape.candidates, o.escape.doctrine);
          if (e) escape = Object.freeze({ kind: e.kind, dx: e.dx, dy: e.dy, verified: e.verified });
        }
      }
    }
    forecast = Object.freeze({ horizonS: o.horizonS, impact, escape });
  }

  // targets on sensors (revealed and not yet done), nearest first
  const pois: ObservedPoi[] = [];
  let onSensors = 0;
  let seen = 0;
  let remaining = 0;
  let markNearest: Offset | null = null;
  let exit: Offset | null = null;
  // P06.1: the signal being observed, else the nearest unresolved one in range (instrument data only)
  let signal: SignalView | null = null;
  let signalD = Infinity;
  for (const p of L.pois) {
    if (p.kind === 'exit') {
      exit = offset(sh.x, sh.y, p.x, p.y);
      continue;
    }
    if (!ADVISED.has(p.kind)) continue;
    const done = isDone(run, p);
    const shown = run.revealed.has(p.id);
    if (p.kind === 'survey') {
      if (!done) remaining += 1;
      if (shown) seen += 1;
      if (shown && !done) {
        onSensors += 1;
        const off = offset(sh.x, sh.y, p.x, p.y);
        if (!markNearest || off.distance < markNearest.distance) markNearest = off;
      }
    }
    if (!shown || done) continue;
    const sv = p.kind === 'anomaly' ? signalView(run, p) : null;
    const open = sv !== null && sv.fix === null;
    const off = sv?.fix ? offset(sh.x, sh.y, sv.fix.x, sv.fix.y) : offset(sh.x, sh.y, p.x, p.y);
    const sd = !open ? Infinity : sv.observing !== null ? -1 : sv.inRange ? off.distance : Infinity;
    if (sd < signalD) {
      signal = sv;
      signalD = sd;
    }
    let hazard: ObservedPoi['hazard'] = null;
    for (const z of L.hazards) if (Math.hypot(p.x - z.x, p.y - z.y) < z.r) hazard = z.kind;
    const rule = POI_RULES[p.kind];
    const base = { ...off, id: p.id, kind: p.kind as ObservedPoiKind, label: p.label, reach: p.r, verb: rule.verb, auto: rule.auto, required: p.required, hazard, resource: mainResource(p) };
    pois.push(Object.freeze(open ? { ...base, reach: sensor, verb: 'Take a bearing on', signal: true as const } : base));
  }
  pois.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
  if (pois.length > OBSERVATION_LIMITS.pois) pois.length = OBSERVATION_LIMITS.pois;

  // stocked weapons of the flown ship with an empty magazine (Admin Access never runs dry)
  const emptyMagazines: string[] = [];
  if (!run.unlimitedAmmo) {
    for (const id of run.arsenal.rotation) {
      const w = WEAPON_BY_ID.get(id);
      if (w && w.ammo.kind === 'stock' && (run.ammo[id] ?? 0) <= 0 && emptyMagazines.length < OBSERVATION_LIMITS.magazines) emptyMagazines.push(w.name);
    }
  }

  const stop = stopDisplay(run.stop);
  return Object.freeze({
    sector: o.visit,
    tick: run.tick,
    flying,
    combat: run.combat,
    flightMode: run.flightMode,
    stop: stop === 'stopping' ? 'braking' : stop,
    heading: sh.heading,
    hull: stats.hull > 0 ? Math.max(0, Math.min(1, run.hull / stats.hull)) : 0,
    shield: stats.shield > 0 ? Math.max(0, Math.min(1, run.shield / stats.shield)) : 0,
    jammed,
    sensorRange: sensor,
    contacts: Object.freeze({ count, nearest }),
    gravity: Object.freeze({
      share: accel > 0 ? gv.g / accel : 0,
      dx: gv.g > 0 ? gv.x / gv.g : 0,
      dy: gv.g > 0 ? gv.y / gv.g : 0,
      body: src ? bodyOf(src) : null,
      closing,
      engineBeats,
    }),
    inCorona,
    forecast,
    pois: Object.freeze(pois),
    survey: Object.freeze({ remaining, onSensors, seen, nearest: markNearest, complete: run.surveyed || remaining === 0 }),
    exit,
    route: o.route ? Object.freeze({ ...o.route }) : null,
    emptyMagazines: Object.freeze(emptyMagazines),
    offer: run.offer !== null,
    ...(signal ? { signal: observedSignal(signal) } : {}),
  });
}

function observedSignal(v: SignalView): ObservedSignal {
  return Object.freeze({
    id: v.id,
    label: v.label,
    state: v.bearings.length ? 'bearings' : 'faint',
    bearings: v.bearings.length,
    separation: v.separation,
    toFallback: v.toFallback,
    inRange: v.inRange,
    slow: v.slow,
    spread: v.spread,
    jammed: v.jammed,
    refusal: v.refusal,
    blocker: v.blocker,
  });
}
