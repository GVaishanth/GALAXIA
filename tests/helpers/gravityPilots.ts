/**
 * Gravity Flight P02: deterministic scripted pilots and identical-start runs
 * for scenario C (simulation only). Shared by tests/gravityFlight.test.ts (a
 * small regression gate) and tests/gravityMeasure.test.ts (the full tables,
 * behind GRAVITY_MEASURE=1). An autopilot is not a player: these numbers say
 * what the physics and the existing AI allow, not how it feels.
 */
import { getCatalogue } from '../../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../../src/modes/freeroam/galaxy/graph.ts';
import { DEFAULT_PARAMS, gravityLabLayout, LAB_SAVE, LAB_SECTOR, LAB_SYSTEM_ID, sanitizeParams, type LabParams, type ScenarioId } from '../../src/modes/freeroam/gravity/config.ts';
import { createGravityLab, installGravityLab, type GravityLab } from '../../src/modes/freeroam/gravity/lab.ts';
import { NO_CONTROLS, type VectorControls } from '../../src/modes/freeroam/gravity/physics.ts';
import { sectorContext } from '../../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../../src/modes/freeroam/sector/generate.ts';
import { createSectorRun, stepSector, type SectorInput, type SectorRun } from '../../src/modes/freeroam/sector/run.ts';

const SOL = getCatalogue().systems.find((s) => s.id === LAB_SYSTEM_ID)!;
const BASE = generateSector(SOL, sectorContext(buildNavGraph(), LAB_SYSTEM_ID));
export const BX = LAB_SECTOR.bodyX;
export const BY = LAB_SECTOR.bodyY;

export type Controller = (run: SectorRun, l: GravityLab) => VectorControls;

/** One identical start: run seed, enemy gap (scenario distance) and a lateral offset of the whole start (pilot and enemy together). */
export interface Start {
  readonly seed: number;
  readonly gap: number;
  readonly dy: number;
}

/** 3 enemy gaps x 3 lateral offsets x `seeds` run seeds. */
export function starts(seeds: number): Start[] {
  const out: Start[] = [];
  for (const gap of [350, 450, 550]) for (const dy of [-60, 0, 60]) for (let seed = 1; seed <= seeds; seed++) out.push({ seed, gap, dy });
  return out;
}

export function labRun(scenario: ScenarioId, params: Partial<LabParams> = {}, seed = 1, assist = false): { run: SectorRun; lab: GravityLab } {
  const p = sanitizeParams({ ...DEFAULT_PARAMS, ...params });
  const { layout, body } = gravityLabLayout(BASE, p);
  const run = createSectorRun(layout, LAB_SAVE, { seed });
  const l = createGravityLab(body, p);
  l.scenario = scenario;
  l.assist = assist;
  installGravityLab(run, l);
  return { run, lab: l };
}

/** Scenario C from `start` (the offset moves pilot and enemy together, so the geometry between them is unchanged). */
export function startC(start: Start, params: Partial<LabParams> = {}, assist = false): { run: SectorRun; lab: GravityLab } {
  const r = labRun('C', { ...params, enemyGap: start.gap }, start.seed, assist);
  if (start.dy !== 0) {
    r.run.ship.y += start.dy;
    r.run.ship.py = r.run.ship.y;
    for (const a of r.run.hostiles) a.y += start.dy;
  }
  return r;
}

export const input = (v: VectorControls, fire = false): SectorInput => ({ moveX: 0, moveY: -(v.thrust > 0 || Math.hypot(v.pointX, v.pointY) > 0.3 ? 1 : 0), vector: v, fire });

/** Waypoint autopilot (as in P01): points the stick along (desired velocity - velocity); the vector model thrusts once the nose is aligned. */
export function waypointPilot(points: readonly { x: number; y: number; r: number }[], cruise = 340): Controller {
  let i = 0;
  return (run: SectorRun): VectorControls => {
    const sh = run.ship;
    while (i < points.length - 1 && Math.hypot(points[i]!.x - sh.x, points[i]!.y - sh.y) < points[i]!.r) i++;
    const w = points[i]!;
    const dx = w.x - sh.x;
    const dy = w.y - sh.y;
    const d = Math.hypot(dx, dy) || 1;
    const sx = (dx / d) * cruise - sh.vx;
    const sy = (dy / d) * cruise - sh.vy;
    const s = Math.hypot(sx, sy);
    if (s < 25) return NO_CONTROLS;
    return { ...NO_CONTROLS, pointX: sx / s, pointY: sy / s };
  };
}

/** Round the far side of the planet at radius `r` (below, east, above), then burn out toward `exit`. */
const farSide = (r: number, exit: { x: number; y: number }): Controller =>
  waypointPilot([{ x: BX - 0.28 * r, y: BY + r, r: 90 }, { x: BX + 1.07 * r, y: BY, r: 90 }, { x: BX, y: BY - 1.1 * r, r: 90 }, { x: exit.x, y: exit.y, r: 100 }]);

export interface Strategy {
  readonly id: string;
  readonly group: 'A' | 'B' | 'C';
  readonly name: string;
  /** A deliberately poor execution (shows the manoeuvre can fail). */
  readonly poor: boolean;
  readonly make: () => Controller;
}

const AWAY = { x: 900, y: 500 };
export const STRATEGIES: readonly Strategy[] = [
  { id: 'A-south', group: 'A', name: 'direct escape: wide south of the field, then east', poor: false, make: () => waypointPilot([{ x: BX, y: BY + 560, r: 200 }, { x: 4000, y: BY + 560, r: 100 }]) },
  { id: 'A-north', group: 'A', name: 'direct escape: wide north of the field, then east', poor: false, make: () => waypointPilot([{ x: BX - 300, y: BY - 600, r: 200 }, { x: 4000, y: BY - 600, r: 100 }]) },
  { id: 'A-back', group: 'A', name: 'direct escape: turn back north-west past the enemy', poor: false, make: () => waypointPilot([{ x: 900, y: 300, r: 100 }]) },
  { id: 'B-400', group: 'B', name: 'flyby round the far side at r 400 (altitude ~270), exit north-west', poor: false, make: () => farSide(400, AWAY) },
  { id: 'B-330', group: 'B', name: 'flyby round the far side at r 330 (altitude ~200), exit north-west', poor: false, make: () => farSide(330, AWAY) },
  { id: 'C-215', group: 'C', name: 'tactical: low skim round the far side at r 215 (altitude ~85), exit burn north-west', poor: false, make: () => farSide(215, AWAY) },
  { id: 'C-low', group: 'C', name: 'poor: too low, r 175 (altitude ~45)', poor: true, make: () => farSide(175, AWAY) },
  { id: 'C-wide', group: 'C', name: 'poor: too wide, r 260', poor: true, make: () => farSide(260, AWAY) },
  { id: 'C-east', group: 'C', name: 'poor: skims behind, then exits east (back into the enemy\'s view)', poor: true, make: () => waypointPilot([{ x: BX - 60, y: BY + 215, r: 90 }, { x: BX + 230, y: BY, r: 90 }, { x: 4000, y: BY + 300, r: 100 }]) },
];
export const strategy = (id: string): Strategy => STRATEGIES.find((s) => s.id === id)!;

export interface RunResult {
  damage: number;
  damageShots: number;
  damageRam: number;
  damagePlanet: number;
  shots: number;
  stopped: number;
  covered: number;
  exposed: number;
  blocked: number;
  lockLost: boolean;
  pursuedAtEnd: boolean;
  finalGap: number;
  planetHits: number;
  engineDv: number;
  assistDv: number;
  headingChange: number;
  finalSpeed: number;
  fireDelay: number;
}

/** Fly `seconds` of scenario C from `start` with `ctl`. */
export function flyC(start: Start, ctl: Controller, params: Partial<LabParams> = {}, seconds = 15, assist = false): RunResult {
  const { run, lab: l } = startC(start, params, assist);
  let damage = 0;
  for (let t = 0; t < seconds * 60; t++) {
    const before = run.shield + run.hull;
    stepSector(run, input(ctl(run, l)));
    const after = run.shield + run.hull;
    if (after < before) damage += before - after;
  }
  const d = l.diag;
  return {
    damage,
    damageShots: d.damageShots,
    damageRam: d.damageRam,
    damagePlanet: d.damagePlanet,
    shots: d.enemyShots,
    stopped: d.shotsStopped,
    covered: d.coveredSeconds,
    exposed: d.exposedSeconds,
    blocked: d.blockedSeconds,
    lockLost: d.lockLosses > 0,
    pursuedAtEnd: d.pursuit === 'pursued',
    finalGap: d.enemyDistance ?? Infinity,
    planetHits: d.collisions,
    engineDv: d.engineDv,
    assistDv: d.assistDv,
    headingChange: d.headingChangeDeg,
    finalSpeed: d.speed,
    fireDelay: d.fireDelayAfterCover,
  };
}

export const mean = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((s, x) => s + f(x), 0) / Math.max(1, xs.length);
