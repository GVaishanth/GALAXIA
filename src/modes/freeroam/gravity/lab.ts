/**
 * Gravity Flight prototype P01: the experiment runtime (pure, deterministic; no
 * DOM, no clock, no randomness of its own).
 *
 * It plugs into the ordinary sector tick (sector/run.ts) through
 * SectorRun.flight, which only the experimental sector sets:
 *  - stepShip: the ship is flown by the vector model (gravity/physics.ts) or,
 *    for comparison, by the existing assisted controller with gravity added as
 *    an external pull. Planet impacts damage the ship by the sector's usual rule.
 *  - beforeAgents: optional gravity on enemy ships (their own steering still
 *    flies them; nothing teleports them).
 *  - afterTick: optional enemy weapons off, the trajectory prediction (every
 *    PREDICT_EVERY ticks, not every frame), the Gravity Flight Assist escape
 *    advice (a new search every ADVISE_EVERY ticks inside the field, spread
 *    over ADVISE_BUDGET modelled attempts per tick) and the instrumentation
 *    (flyby records, line of sight, enemy shots, damage by source).
 *  - sightBlocked: the planet blocks enemy line of sight (FR-TD-84; lab
 *    toggle PLANET BLOCKS SIGHT, default on). Shots still use the existing
 *    collision; no pass-through rule. A recall (empty hull) resets the current scenario.
 * Everything else (weapons, enemy AI, projectiles, shields, the camera, the
 * fixed-step loop) is the existing game code.
 */
import { spawnAgent } from '../combat/ai.ts';
import { FAMILIES } from '../combat/families.ts';
import { WEAPONS } from '../combat/weapons.ts';
import { damagePlayer, setState, sweptHit } from '../combat/world.ts';
import { freshShip, stepShip as stepAssisted, TICK_SECONDS, type ShipModifiers, type ShipTuning } from '../sim.ts';
import { RUN, type FlightHook, type SectorEvent, type SectorInput, type SectorRun } from '../sector/run.ts';
import type { FactionId } from '../catalogue/types.ts';
import { LAB_SECTOR, sanitizeParams, scenarioStart, type LabParams, type MutableLandmark, type ScenarioId } from './config.ts';
import { resetMissiles } from '../combat/playerMissile.ts';
import {
  freshAdvice,
  freshPrediction,
  freshTelemetry,
  gravityAt,
  influenceRadius,
  NO_CONTROLS,
  orbitalEnergy,
  predictBallistic,
  stepVectorFlight,
  beginEscapeSearch,
  continueEscapeSearch,
  createEscapeSearch,
  type BodyState,
  type EscapeAdvice,
  type EscapeSearch,
  type FieldParams,
  type FlightParams,
  type Prediction,
  type StepTelemetry,
  type Vec,
} from './physics.ts';

/** Prediction refresh interval (ticks): 20 Hz, never per rendered frame. */
export const PREDICT_EVERY = 3;
/** Escape advice refresh interval (ticks) while inside the field with the assist on. */
export const ADVISE_EVERY = 10;
/** Escape advice look-ahead (s). */
export const ADVISE_SECONDS = 4;
/** Escape attempts modelled per tick (ESCAPE_CANDIDATES + 2 * ESCAPE_REFINE = 28 complete within ADVISE_EVERY ticks). */
export const ADVISE_BUDGET = 3;
/** Prediction point spacing (ticks). */
export const PREDICT_STRIDE = 3;
/** Engine speed ceiling that only guards against numerical blow-ups (px/s). */
export const SAFETY_SPEED = 2400;
/** Faction of the pursuing interceptor (a hostile faction from the existing catalogue). */
export const LAB_FACTION: FactionId = 'red-tally';
/** Flyby records kept. */
export const MAX_PASSES = 8;
/** Planet contacts closing faster than this count as an impact in the diagnostics (px/s). */
export const IMPACT_COUNT_SPEED = 20;
/** The moving planet stops this far from the sector edge (end of the experiment path). */
const BODY_MARGIN = 260;

/** One pass through the gravity field (entry to exit across the instrumentation boundary). */
export interface PassRecord {
  readonly index: number;
  readonly scenario: ScenarioId;
  readonly entryTick: number;
  exitTick: number;
  /** Speeds in the sector frame (px/s). */
  readonly entrySpeed: number;
  maxSpeed: number;
  exitSpeed: number;
  /** Speeds relative to the planet (equal to the above when it is stationary). */
  readonly entrySpeedRel: number;
  maxSpeedRel: number;
  exitSpeedRel: number;
  /** Closest distance to the planet centre and above its collision surface (px). */
  closest: number;
  altitude: number;
  /** Turn of the planet-frame velocity between entry and exit (degrees). */
  deflectionDeg: number;
  /** Velocity change from engine and assist during the pass (px/s, integrated magnitude). */
  engineDv: number;
  assistDv: number;
  collisions: number;
  /** Left the field with orbital energy >= 0 (null while inside). */
  escaped: boolean | null;
  /** Distance to the nearest enemy at entry, exit and 3 s after exit (null = none). */
  readonly enemyAtEntry: number | null;
  enemyAtExit: number | null;
  enemyAfter3s: number | null;
  readonly entryVx: number;
  readonly entryVy: number;
}

export interface LabDiagnostics {
  speed: number;
  speedRel: number;
  /** Scenario start speed (the "before" reference). */
  startSpeed: number;
  maxSpeed: number;
  gravity: number;
  engine: number;
  assist: number;
  distance: number;
  altitude: number;
  energy: number;
  inField: boolean;
  fieldRadius: number;
  /** Seconds inside the field this scenario run. */
  fieldSeconds: number;
  collisions: number;
  escapes: number;
  enemyDistance: number | null;
  enemyState: string | null;
  enemyLocked: boolean;
  /** Times the enemy lost its lock on the pilot, and the first tick it did. */
  lockLosses: number;
  firstLockLossTick: number;
  readonly passes: PassRecord[];
  current: PassRecord | null;
  /** Passes started this scenario run. */
  passCount: number;
  /* FR-TD-84: occlusion and combat outcome, this scenario run */
  /** The planet blocks the nearest enemy's view of the pilot right now. */
  sightBlocked: boolean;
  /** Seconds the planet blocked the enemy's view (any distance). */
  blockedSeconds: number;
  /** Seconds inside the enemy's weapon range with its view blocked (covered) or clear (exposed). */
  coveredSeconds: number;
  exposedSeconds: number;
  /** Enemy weapon releases, and enemy shots that ended on the planet. */
  enemyShots: number;
  shotsStopped: number;
  /** Damage taken (shield + hull) by source. */
  damageShots: number;
  damageRam: number;
  damagePlanet: number;
  /** Ticks from the view clearing to the enemy's next weapon release (last cover episode; -1 = none yet). */
  fireDelayAfterCover: number;
  /** Pursuit now: the enemy has the pilot, searches its last-known position, has given up, or none. */
  pursuit: 'pursued' | 'searching' | 'lost' | 'none';
  /** Run totals: engine and assist velocity change (px/s, integrated magnitude). */
  engineDv: number;
  assistDv: number;
  /** Turn of the velocity since the scenario start (degrees; trajectory bending + engines). */
  headingChangeDeg: number;
}

export interface GravityLab {
  params: LabParams;
  scenario: ScenarioId;
  /** Gravity Flight Assist (corrective thrust + escape advice). Off = gravity still applies, no correction. */
  assist: boolean;
  /** Show the predicted trajectory even with the assist off. */
  showPath: boolean;
  readonly body: MutableLandmark;
  bodyVx: number;
  bodyVy: number;
  bodyFrozen: boolean;
  /** Ticks since the scenario started. */
  tick: number;
  resets: number;
  readonly tel: StepTelemetry;
  readonly path: Float32Array;
  readonly prediction: Prediction;
  readonly advice: EscapeAdvice;
  /** The escape search being spread over the ticks, and the tick it started. */
  readonly search: EscapeSearch;
  adviseStart: number;
  readonly diag: LabDiagnostics;
  enemyId: number | null;
  /** run.recalls last seen (a change means the ship was destroyed). */
  recallsSeen: number;
  /** Enemy shots seen last tick (to tell which ones the planet stopped). */
  readonly shotsSeen: Map<number, { x: number; y: number; vx: number; vy: number; r: number }>;
  /** Tick the enemy's view last cleared after a cover episode (-1 = none pending). */
  coverEndedTick: number;
  readonly startVx: number[];
}

const freshDiag = (): LabDiagnostics => ({
  speed: 0,
  speedRel: 0,
  startSpeed: 0,
  maxSpeed: 0,
  gravity: 0,
  engine: 0,
  assist: 0,
  distance: 0,
  altitude: 0,
  energy: 0,
  inField: false,
  fieldRadius: 0,
  fieldSeconds: 0,
  collisions: 0,
  escapes: 0,
  enemyDistance: null,
  enemyState: null,
  enemyLocked: false,
  lockLosses: 0,
  firstLockLossTick: -1,
  passes: [],
  current: null,
  passCount: 0,
  sightBlocked: false,
  blockedSeconds: 0,
  coveredSeconds: 0,
  exposedSeconds: 0,
  enemyShots: 0,
  shotsStopped: 0,
  damageShots: 0,
  damageRam: 0,
  damagePlanet: 0,
  fireDelayAfterCover: -1,
  pursuit: 'none',
  engineDv: 0,
  assistDv: 0,
  headingChangeDeg: 0,
});

export function createGravityLab(body: MutableLandmark, params: Partial<LabParams> = {}): GravityLab {
  return {
    params: sanitizeParams(params),
    scenario: 'B',
    assist: false,
    showPath: false,
    body,
    bodyVx: 0,
    bodyVy: 0,
    bodyFrozen: false,
    tick: 0,
    resets: 0,
    tel: freshTelemetry(),
    path: new Float32Array(2 * 400),
    prediction: freshPrediction(),
    advice: freshAdvice(),
    search: createEscapeSearch(),
    adviseStart: -Infinity,
    diag: freshDiag(),
    enemyId: null,
    recallsSeen: 0,
    shotsSeen: new Map(),
    coverEndedTick: -1,
    startVx: [0, 0],
  };
}

export const fieldOf = (lab: GravityLab): FieldParams => ({ mu: lab.params.mu, softening: lab.params.softening, range: lab.params.range });

/**
 * Gravity at the collision surface (ship touching the planet) as a share of
 * engine thrust. At or above 1 a ship that touches down cannot climb away
 * without boost, so the defaults keep it well below (0.83); the tuning panel
 * can exceed it and the diagnostics then say so.
 */
export function surfacePullRatio(lab: GravityLab, shipRadius: number): number {
  const g = gravityAt(0, 0, lab.body.r + shipRadius, 0, fieldOf(lab), { x: 0, y: 0 });
  return lab.params.thrust > 0 ? g / lab.params.thrust : Infinity;
}
export const bodyOf = (lab: GravityLab): BodyState => ({ x: lab.body.x, y: lab.body.y, vx: lab.bodyVx, vy: lab.bodyVy, r: lab.body.r });
/** Radius where gravity equals `displayThreshold` of engine thrust: the field boundary shown and measured. */
export const fieldRadiusOf = (lab: GravityLab): number => influenceRadius(fieldOf(lab), lab.params.thrust, lab.params.displayThreshold);

/** Vector-model flight parameters for this tick (boost scales thrust and the engine limit exactly as it scales the normal controller). */
export function flightOf(lab: GravityLab, run: SectorRun, tune: ShipTuning = run.tune): FlightParams {
  const p = lab.params;
  return {
    thrust: p.thrust * (tune.accel / run.tune.accel),
    reverseRatio: p.reverseRatio,
    speedLimit: run.tune.maxSpeed * p.speedLimitMul * (tune.maxSpeed / run.tune.maxSpeed),
    turnRate: p.turnRate,
    pointTurnRate: run.tune.turnRate,
    assist: lab.assist,
    assistStrength: p.assistStrength,
    assistMax: p.assistMaxRatio * p.thrust,
    safetySpeed: SAFETY_SPEED,
  };
}

/** Change parameters (bounded). Physics values apply at once; scenario start values apply at the next reset. */
export function setLabParams(lab: GravityLab, patch: Partial<LabParams>): void {
  lab.params = sanitizeParams({ ...lab.params, ...patch });
  lab.body.r = lab.params.radius;
  if (!lab.bodyFrozen) {
    const sp = Math.hypot(lab.bodyVx, lab.bodyVy);
    if (sp !== lab.params.planetSpeed) {
      lab.bodyVx = 0;
      lab.bodyVy = -lab.params.planetSpeed;
    }
  }
}

const liveEnemies = (run: SectorRun) => run.hostiles.filter((a) => a.state !== 'destroyed');

/** Start (or restart) a scenario: same start state every time, no reload. */
export function applyScenario(run: SectorRun, lab: GravityLab, id: ScenarioId = lab.scenario): void {
  const p = lab.params;
  const s = scenarioStart(id, p);
  lab.scenario = id;
  const st = run.craft.stats;
  run.ship = freshShip(s.x, s.y, s.heading);
  run.ship.vx = s.vx;
  run.ship.vy = s.vy;
  run.shield = st.shield;
  run.hull = st.hull;
  run.energy = st.energy;
  run.boost = 0;
  run.boosting = false;
  run.sinceBoost = RUN.energyDelayTicks + 1;
  run.shieldHit = null;
  run.docked = null;
  run.offer = null;
  run.snooze = null;
  run.invuln = 0;
  run.sinceHit = RUN.regenDelayTicks;
  run.hostiles.length = 0;
  run.shots.length = 0;
  run.enemyShots.length = 0;
  resetMissiles(run); // Combat P03: no missile or lock survives a scenario reset
  run.mines.length = 0;
  run.pending = [];
  run.provoked.clear();
  run.grace = 0;
  run.fireCooldown = 0;
  run.heat = 0;
  run.overheated = false;
  run.dropBudget = 0;
  lab.body.x = s.bodyX;
  lab.body.y = s.bodyY;
  lab.body.r = p.radius;
  lab.bodyVx = s.bodyVx;
  lab.bodyVy = s.bodyVy;
  lab.bodyFrozen = false;
  lab.tick = 0;
  lab.resets += 1;
  lab.recallsSeen = run.recalls;
  Object.assign(lab.diag, freshDiag(), { passes: lab.diag.passes });
  lab.diag.passes.length = 0;
  lab.diag.startSpeed = Math.hypot(s.vx, s.vy);
  lab.startVx[0] = s.vx;
  lab.startVx[1] = s.vy;
  lab.shotsSeen.clear();
  lab.coverEndedTick = -1;
  lab.enemyId = null;
  if (s.enemy) {
    const a = spawnAgent(run, p.enemyFamily, LAB_FACTION, 'gravity-lab', 'wave', s.enemy.x, s.enemy.y, s.enemy.heading);
    if (a) {
      a.vx = s.enemy.vx;
      a.vy = s.enemy.vy;
      a.target = 'player';
      a.lastSeen = { x: s.x, y: s.y };
      setState(a, 'pursue');
      lab.enemyId = a.id;
    }
  }
  Object.assign(lab.advice, freshAdvice());
  lab.search.done = true;
  lab.adviseStart = -Infinity;
  refreshPrediction(run, lab);
  updateDiagnostics(run, lab, false);
  // starting inside the field (scenario A) opens a pass whose entry values are the start values
  if (lab.diag.inField) lab.diag.current = newPass(lab, run.ship.vx - lab.bodyVx, run.ship.vy - lab.bodyVy);
}

/** Install the lab on a run (only the experimental sector does this). */
export function installGravityLab(run: SectorRun, lab: GravityLab): void {
  run.flight = labHook(lab);
  applyScenario(run, lab, lab.scenario);
}

const gv: Vec = { x: 0, y: 0 };

function labHook(lab: GravityLab): FlightHook {
  return {
    stepShip(run: SectorRun, input: SectorInput, mods: ShipModifiers, tune: ShipTuning, events: SectorEvent[]) {
      const L = run.layout;
      const sh = run.ship;
      const b = bodyOf(lab);
      const f = fieldOf(lab);
      const tel = lab.tel;
      let moved: { distance: number; pushed: boolean };
      if (lab.params.flightModel === 'vector') {
        moved = stepVectorFlight(sh, input.vector ?? NO_CONTROLS, b, f, flightOf(lab, run, tune), run.tune.radius, L.width, L.height, tel);
      } else {
        moved = stepAssistedWithGravity(run, lab, input, mods, tune, b, f);
      }
      if (tel.impact > RUN.impactSpeed && run.invuln === 0) damagePlayer(run, Math.round(2 + tel.impact / 50), 'impact', events, { x: tel.impactX, y: tel.impactY });
      advanceBody(lab);
      return moved;
    },
    beforeAgents(run: SectorRun) {
      if (!lab.params.enemyGravity) return;
      const f = fieldOf(lab);
      for (const a of run.hostiles) {
        if (a.state === 'destroyed') continue;
        gravityAt(lab.body.x, lab.body.y, a.x, a.y, f, gv);
        a.vx += gv.x * TICK_SECONDS;
        a.vy += gv.y * TICK_SECONDS;
      }
    },
    sightBlocked(ax: number, ay: number, bx: number, by: number): boolean {
      // the same swept-circle test projectiles use against the planet (combat/world.ts)
      return lab.params.occlusion && sweptHit(ax, ay, bx, by, lab.body.x, lab.body.y, lab.body.r);
    },
    afterTick(run: SectorRun, events: SectorEvent[]) {
      if (run.recalls !== lab.recallsSeen) {
        // the ship was destroyed: start the same scenario again (nothing is lost; the lab writes no progress)
        applyScenario(run, lab, lab.scenario);
        return;
      }
      if (!lab.params.enemyFires) {
        run.enemyShots.length = 0;
        for (let i = events.length - 1; i >= 0; i--) {
          const t = events[i]!.type;
          if (t === 'enemyFired' || t === 'telegraph') events.splice(i, 1);
        }
      }
      lab.tick += 1;
      combatDiagnostics(run, lab, events);
      updateDiagnostics(run, lab, true);
      if (lab.tick % PREDICT_EVERY === 0) refreshPrediction(run, lab);
      if (lab.assist && lab.diag.inField) {
        // spread over the ticks: a new search from a snapshot every ADVISE_EVERY ticks, ADVISE_BUDGET attempts per tick
        if (lab.search.done && lab.tick - lab.adviseStart >= ADVISE_EVERY) {
          beginEscapeSearch(lab.search, run.ship, bodyOf(lab), fieldOf(lab), flightOf(lab, run), run.tune.radius, run.layout.width, run.layout.height, ADVISE_SECONDS, fieldRadiusOf(lab));
          lab.adviseStart = lab.tick;
        }
        continueEscapeSearch(lab.search, ADVISE_BUDGET, lab.advice);
      } else {
        lab.search.done = true;
        lab.adviseStart = -Infinity;
        if (Number.isFinite(lab.advice.heading) || lab.advice.horizon > 0) Object.assign(lab.advice, freshAdvice());
      }
    },
  };
}

/**
 * Comparison model: the existing assisted-inertia controller (sim.ts) with
 * gravity (and the assist correction relative to the stick direction) added as
 * an external pull. Its drag and hard speed cap still apply, which is exactly
 * why it cannot carry momentum through a flyby (docs). The ship's top speed
 * (about 8 px per tick) is far below the 132 px collision radius, so a per-tick
 * overlap test cannot tunnel here.
 */
function stepAssistedWithGravity(run: SectorRun, lab: GravityLab, input: SectorInput, mods: ShipModifiers, tune: ShipTuning, b: BodyState, f: FieldParams): { distance: number; pushed: boolean } {
  const sh = run.ship;
  const tel = lab.tel;
  tel.g = gravityAt(b.x, b.y, sh.x, sh.y, f, gv);
  tel.gx = gv.x;
  tel.gy = gv.y;
  const mx = Number.isFinite(input.moveX) ? input.moveX : 0;
  const my = Number.isFinite(input.moveY) ? input.moveY : 0;
  const ml = Math.hypot(mx, my);
  tel.ax = 0;
  tel.ay = 0;
  tel.assist = 0;
  tel.impact = 0;
  tel.limited = false;
  if (lab.assist && ml > 0.05 && lab.params.assistStrength > 0) {
    const ux = mx / ml;
    const uy = my / ml;
    const along = gv.x * ux + gv.y * uy;
    let ax = -(gv.x - along * ux) * lab.params.assistStrength;
    let ay = -(gv.y - along * uy) * lab.params.assistStrength;
    const al = Math.hypot(ax, ay);
    const cap = lab.params.assistMaxRatio * lab.params.thrust;
    if (al > cap) {
      ax *= cap / al;
      ay *= cap / al;
    }
    tel.ax = ax;
    tel.ay = ay;
    tel.assist = Math.hypot(ax, ay);
  }
  const L = run.layout;
  const moved = stepAssisted(sh, input, L.width, L.height, { ...mods, pullX: (mods.pullX ?? 0) + gv.x + tel.ax, pullY: (mods.pullY ?? 0) + gv.y + tel.ay }, tune);
  tel.engine = ml > 0.05 ? tune.accel * Math.min(1, ml) : 0;
  tel.ex = ml > 0.05 ? (mx / ml) * tel.engine : 0;
  tel.ey = ml > 0.05 ? (my / ml) * tel.engine : 0;
  tel.pushed = moved.pushed;
  // planet contact (same restitution and damage rule as every solid; body frame)
  const bx = b.x + b.vx * TICK_SECONDS;
  const by = b.y + b.vy * TICK_SECONDS;
  const dx = sh.x - bx;
  const dy = sh.y - by;
  const d = Math.hypot(dx, dy);
  const min = b.r + run.tune.radius;
  if (d < min) {
    const nx = d > 0 ? dx / d : 0;
    const ny = d > 0 ? dy / d : -1;
    sh.x = bx + nx * (min + 0.01);
    sh.y = by + ny * (min + 0.01);
    const rvx = sh.vx - b.vx;
    const rvy = sh.vy - b.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      sh.vx -= (1 + RUN.restitution) * vn * nx;
      sh.vy -= (1 + RUN.restitution) * vn * ny;
      tel.impact = -vn;
      tel.impactX = bx + nx * b.r;
      tel.impactY = by + ny * b.r;
    }
  }
  return moved;
}

/** Moving-planet option: constant velocity; it stops at the end of its path inside the sector. */
function advanceBody(lab: GravityLab): void {
  if (lab.bodyFrozen || (lab.bodyVx === 0 && lab.bodyVy === 0)) return;
  lab.body.x += lab.bodyVx * TICK_SECONDS;
  lab.body.y += lab.bodyVy * TICK_SECONDS;
  const m = BODY_MARGIN + lab.body.r;
  if (lab.body.x < m || lab.body.y < m || lab.body.x > LAB_SECTOR.width - m || lab.body.y > LAB_SECTOR.height - m) {
    lab.bodyFrozen = true;
    lab.bodyVx = 0;
    lab.bodyVy = 0;
  }
}

/** Recompute the ballistic (engines-off) prediction from the ship's current state. */
export function refreshPrediction(run: SectorRun, lab: GravityLab): void {
  const sh = run.ship;
  predictBallistic(sh.x, sh.y, sh.vx, sh.vy, bodyOf(lab), fieldOf(lab), run.tune.radius, run.layout.width, run.layout.height, lab.params.predictSeconds, PREDICT_STRIDE, lab.path, lab.prediction);
}

function nearestEnemy(run: SectorRun): { d: number; state: string; locked: boolean } | null {
  let best: { d: number; state: string; locked: boolean } | null = null;
  for (const a of liveEnemies(run)) {
    const d = Math.hypot(a.x - run.ship.x, a.y - run.ship.y);
    if (!best || d < best.d) best = { d, state: a.state, locked: a.target === 'player' };
  }
  return best;
}

/**
 * Occlusion and combat bookkeeping for one tick (FR-TD-84; dev diagnostics only). Reads this
 * tick's events and the enemy shots; writes nothing outside the lab's diagnostics.
 */
function combatDiagnostics(run: SectorRun, lab: GravityLab, events: readonly SectorEvent[]): void {
  const d = lab.diag;
  const sh = run.ship;
  for (const e of events) {
    if (e.type === 'enemyFired') {
      d.enemyShots += 1;
      if (lab.coverEndedTick >= 0) {
        d.fireDelayAfterCover = lab.tick - lab.coverEndedTick;
        lab.coverEndedTick = -1;
      }
    } else if (e.type === 'hit') {
      if (e.source === 'fire') d.damageShots += e.damage;
      else if (e.source === 'hostile') d.damageRam += e.damage;
      else if (e.source === 'impact') d.damagePlanet += e.damage;
    }
  }
  // enemy shots that vanished this tick on their way through the planet were stopped by it
  const b = lab.body;
  for (const [id, p] of lab.shotsSeen) {
    if (run.enemyShots.some((s) => s.id === id)) continue;
    if (sweptHit(p.x, p.y, p.x + p.vx * TICK_SECONDS, p.y + p.vy * TICK_SECONDS, b.x, b.y, b.r + p.r + 1)) d.shotsStopped += 1;
  }
  lab.shotsSeen.clear();
  for (const s of run.enemyShots) lab.shotsSeen.set(s.id, { x: s.x, y: s.y, vx: s.vx, vy: s.vy, r: s.radius });
  // line of sight to the nearest live enemy
  let near: (typeof run.hostiles)[number] | null = null;
  let nd = Infinity;
  for (const a of run.hostiles) {
    if (a.state === 'destroyed') continue;
    const dd = Math.hypot(a.x - sh.x, a.y - sh.y);
    if (dd < nd) {
      nd = dd;
      near = a;
    }
  }
  const was = d.sightBlocked;
  d.sightBlocked = near !== null && lab.params.occlusion && sweptHit(near.x, near.y, sh.x, sh.y, b.x, b.y, b.r);
  if (was && !d.sightBlocked) lab.coverEndedTick = lab.tick;
  if (near) {
    const range = Math.max(...FAMILIES[near.family].weapons.map((w) => WEAPONS[w].range));
    if (d.sightBlocked) d.blockedSeconds += TICK_SECONDS;
    if (nd <= range) {
      if (d.sightBlocked) d.coveredSeconds += TICK_SECONDS;
      else d.exposedSeconds += TICK_SECONDS;
    }
    d.pursuit = near.target === 'player' ? 'pursued' : near.state === 'investigate' || near.lastSeen ? 'searching' : 'lost';
  } else d.pursuit = 'none';
  d.engineDv += lab.tel.engine * TICK_SECONDS;
  d.assistDv += lab.tel.assist * TICK_SECONDS;
  const v0x = lab.startVx[0]!;
  const v0y = lab.startVx[1]!;
  d.headingChangeDeg = (Math.atan2(v0x * sh.vy - v0y * sh.vx, v0x * sh.vx + v0y * sh.vy) * 180) / Math.PI;
}

function updateDiagnostics(run: SectorRun, lab: GravityLab, ticked: boolean): void {
  const d = lab.diag;
  const sh = run.ship;
  const b = bodyOf(lab);
  const f = fieldOf(lab);
  const tel = lab.tel;
  const rvx = sh.vx - b.vx;
  const rvy = sh.vy - b.vy;
  d.speed = Math.hypot(sh.vx, sh.vy);
  d.speedRel = Math.hypot(rvx, rvy);
  d.maxSpeed = Math.max(d.maxSpeed, d.speed);
  d.distance = Math.hypot(sh.x - b.x, sh.y - b.y);
  d.altitude = d.distance - b.r - run.tune.radius;
  d.gravity = gravityAt(b.x, b.y, sh.x, sh.y, f, gv);
  d.engine = ticked ? tel.engine : 0;
  d.assist = ticked ? tel.assist : 0;
  d.energy = orbitalEnergy(sh.x, sh.y, sh.vx, sh.vy, b, f);
  d.fieldRadius = fieldRadiusOf(lab);
  const wasIn = d.inField;
  d.inField = d.distance < d.fieldRadius;
  const e = nearestEnemy(run);
  d.enemyDistance = e ? e.d : null;
  d.enemyState = e ? e.state : null;
  if (d.enemyLocked && !(e?.locked ?? false)) {
    d.lockLosses += 1;
    if (d.firstLockLossTick < 0) d.firstLockLossTick = lab.tick;
  }
  d.enemyLocked = e?.locked ?? false;
  if (!ticked) return;
  // count distinct impacts, not the decaying micro-bounces of a ship resting on the surface
  const impact = tel.impact >= IMPACT_COUNT_SPEED;
  if (impact) d.collisions += 1;
  if (d.inField) d.fieldSeconds += TICK_SECONDS;

  // flyby records
  if (d.inField && !wasIn) d.current = newPass(lab, rvx, rvy);
  const c = d.current;
  if (c) {
    c.maxSpeed = Math.max(c.maxSpeed, d.speed);
    c.maxSpeedRel = Math.max(c.maxSpeedRel, d.speedRel);
    c.closest = Math.min(c.closest, d.distance);
    c.altitude = Math.min(c.altitude, d.altitude);
    c.engineDv += tel.engine * TICK_SECONDS;
    c.assistDv += tel.assist * TICK_SECONDS;
    if (impact) c.collisions += 1;
    if (!d.inField) {
      c.exitTick = lab.tick;
      c.exitSpeed = d.speed;
      c.exitSpeedRel = d.speedRel;
      const cross = c.entryVx * rvy - c.entryVy * rvx;
      const dot = c.entryVx * rvx + c.entryVy * rvy;
      c.deflectionDeg = (Math.atan2(cross, dot) * 180) / Math.PI;
      const radial = (sh.x - b.x) * rvx + (sh.y - b.y) * rvy;
      c.escaped = radial > 0 && d.energy >= 0;
      if (c.escaped) d.escapes += 1;
      c.enemyAtExit = d.enemyDistance;
      d.passes.push(c);
      if (d.passes.length > MAX_PASSES) d.passes.shift();
      d.current = null;
    }
  }
  for (const pr of d.passes) {
    if (pr.enemyAfter3s === null && pr.enemyAtExit !== null && lab.tick - pr.exitTick === 180) pr.enemyAfter3s = d.enemyDistance;
  }
}

/** A new flyby record from the current diagnostics (planet-frame velocity rvx, rvy). */
function newPass(lab: GravityLab, rvx: number, rvy: number): PassRecord {
  const d = lab.diag;
  d.passCount += 1;
  return {
    index: d.passCount,
    scenario: lab.scenario,
    entryTick: lab.tick,
    exitTick: -1,
    entrySpeed: d.speed,
    maxSpeed: d.speed,
    exitSpeed: 0,
    entrySpeedRel: d.speedRel,
    maxSpeedRel: d.speedRel,
    exitSpeedRel: 0,
    closest: d.distance,
    altitude: d.altitude,
    deflectionDeg: 0,
    engineDv: 0,
    assistDv: 0,
    collisions: 0,
    escaped: null,
    enemyAtEntry: d.enemyDistance,
    enemyAtExit: null,
    enemyAfter3s: null,
    entryVx: rvx,
    entryVy: rvy,
  };
}
