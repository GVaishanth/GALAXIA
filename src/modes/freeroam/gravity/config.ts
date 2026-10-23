/**
 * Gravity Flight prototype P01: tuning parameters, their safe bounds, the three
 * repeatable scenarios and the experimental sector layout (pure data + small
 * pure helpers; no DOM, no clock, no randomness).
 *
 * The experimental sector is a separate region of the existing Sol system (the
 * starting system): it reuses Sol's generated sector record (system id,
 * factions, resource profile) but replaces its contents with one gravity body
 * and empty space. Sol's ordinary sector, its saved progress and every other
 * sector are untouched (docs/freeroam/GRAVITY_FLIGHT_P01.md).
 */
import type { FamilyId } from '../combat/families.ts';
import type { Landmark, SectorLayout } from '../sector/model.ts';

/** The system the experiment runs in. */
export const LAB_SYSTEM_ID = 'milky-way/sol';
/** Shown on the HUD and the System Map button. */
export const LAB_NAME = 'GRAVITY TEST';

/** Experimental sector size (world art px): about 6.6 x 7.8 default desktop views (640 x 360 art px each). */
export const LAB_SECTOR = Object.freeze({ width: 4200, height: 2800, bodyX: 2300, bodyY: 1400 });

export type FlightModel = 'vector' | 'assisted';
export type ScenarioId = 'A' | 'B' | 'C';
export type EnemyFamily = Extract<FamilyId, 'lancer' | 'raider' | 'picket'>;
export const ENEMY_FAMILIES: readonly EnemyFamily[] = ['lancer', 'raider', 'picket'];

export interface LabParams {
  /** Gravitational parameter mu (px^3/s^2). */
  readonly mu: number;
  /** Field range (px): gravity fades smoothly to zero here. */
  readonly range: number;
  /** Softening length eps (px). Always kept below the collision radius. */
  readonly softening: number;
  /** Planet collision radius (px). */
  readonly radius: number;
  /** Gravity indicator and instrumentation boundary: field strength as a fraction of engine thrust. */
  readonly displayThreshold: number;
  /** Main engine acceleration (px/s^2) in the vector model. */
  readonly thrust: number;
  /** Reverse thrust as a fraction of the main engine (braking strength). */
  readonly reverseRatio: number;
  /** Engine top speed as a multiple of the ship's rated top speed. */
  readonly speedLimitMul: number;
  /** Keyboard rotation rate (rad/s). */
  readonly turnRate: number;
  /** Gravity Flight Assist strength (fraction of the sideways pull cancelled while thrusting). */
  readonly assistStrength: number;
  /** Assist acceleration cap, as a fraction of engine thrust. */
  readonly assistMaxRatio: number;
  /** Scenario B start speed (px/s). */
  readonly startSpeed: number;
  /** Scenario B approach angle (degrees off the line to the planet centre). */
  readonly approachDeg: number;
  /** Trajectory prediction look-ahead (s). */
  readonly predictSeconds: number;
  /** Optional moving planet: speed along its (locally straight) orbit, px/s. 0 = stationary. */
  readonly planetSpeed: number;
  readonly flightModel: FlightModel;
  /** Enemy pursuit: family (sets its speed and weapons), gravity on it, its weapons, start gap. */
  readonly enemyFamily: EnemyFamily;
  readonly enemyGravity: boolean;
  readonly enemyFires: boolean;
  readonly enemyGap: number;
  /** The planet blocks enemy line of sight (FR-TD-84). Off = distance-only sight, for comparison. */
  readonly occlusion: boolean;
}

export const DEFAULT_PARAMS: LabParams = Object.freeze({
  mu: 7_000_000,
  range: 1400,
  softening: 30,
  radius: 120,
  displayThreshold: 0.05,
  thrust: 450,
  reverseRatio: 0.55,
  speedLimitMul: 1,
  turnRate: 4.2,
  assistStrength: 0.6,
  assistMaxRatio: 0.5,
  startSpeed: 200,
  approachDeg: 12,
  predictSeconds: 3.5,
  planetSpeed: 0,
  flightModel: 'vector',
  enemyFamily: 'lancer',
  enemyGravity: true,
  enemyFires: true,
  occlusion: true,
  enemyGap: 450,
});

type NumericKey = { [K in keyof LabParams]: LabParams[K] extends number ? K : never }[keyof LabParams];

export interface ParamSpec {
  readonly key: NumericKey;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Display scale and unit (e.g. mu shown in millions). */
  readonly scale?: number;
  readonly unit?: string;
}

/** Safe bounds for every numeric parameter (the tuning panel and the sanitizer use the same table). */
export const PARAM_SPECS: readonly ParamSpec[] = Object.freeze([
  { key: 'mu', label: 'Gravitational strength μ', min: 1_000_000, max: 20_000_000, step: 250_000, scale: 1e-6, unit: '×10⁶ px³/s²' },
  { key: 'range', label: 'Field range', min: 600, max: 2400, step: 50, unit: 'px' },
  { key: 'radius', label: 'Planet collision radius', min: 60, max: 200, step: 5, unit: 'px' },
  { key: 'softening', label: 'Softening ε', min: 5, max: 100, step: 5, unit: 'px' },
  { key: 'displayThreshold', label: 'Field display threshold', min: 0.01, max: 0.3, step: 0.01, scale: 100, unit: '% of thrust' },
  { key: 'thrust', label: 'Ship thrust', min: 150, max: 900, step: 10, unit: 'px/s²' },
  { key: 'reverseRatio', label: 'Braking (reverse) strength', min: 0.2, max: 1, step: 0.05, scale: 100, unit: '% of thrust' },
  { key: 'speedLimitMul', label: 'Engine top speed', min: 0.6, max: 1.6, step: 0.05, scale: 100, unit: '% of rated' },
  { key: 'turnRate', label: 'Turn rate (keys)', min: 2, max: 8, step: 0.2, unit: 'rad/s' },
  { key: 'assistStrength', label: 'Flight Assist strength', min: 0, max: 0.9, step: 0.05, scale: 100, unit: '%' },
  { key: 'assistMaxRatio', label: 'Flight Assist cap', min: 0.1, max: 1, step: 0.05, scale: 100, unit: '% of thrust' },
  { key: 'startSpeed', label: 'Initial velocity (B)', min: 0, max: 450, step: 10, unit: 'px/s' },
  { key: 'approachDeg', label: 'Approach angle (B)', min: -40, max: 40, step: 1, unit: '°' },
  { key: 'predictSeconds', label: 'Prediction duration', min: 1, max: 8, step: 0.5, unit: 's' },
  { key: 'planetSpeed', label: 'Planet orbital speed', min: 0, max: 120, step: 5, unit: 'px/s' },
  { key: 'enemyGap', label: 'Enemy start gap (C)', min: 250, max: 900, step: 25, unit: 'px' },
]);

const clampTo = (v: unknown, s: ParamSpec, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(s.max, Math.max(s.min, n));
};

/** Bound every parameter; unknown or invalid values fall back to the defaults. Softening stays below the collision radius. */
export function sanitizeParams(p: Partial<Record<keyof LabParams, unknown>>): LabParams {
  const out: Record<string, unknown> = { ...DEFAULT_PARAMS };
  for (const s of PARAM_SPECS) out[s.key] = clampTo(p[s.key], s, DEFAULT_PARAMS[s.key]);
  out['flightModel'] = p.flightModel === 'assisted' ? 'assisted' : 'vector';
  out['enemyFamily'] = ENEMY_FAMILIES.includes(p.enemyFamily as EnemyFamily) ? p.enemyFamily : DEFAULT_PARAMS.enemyFamily;
  out['enemyGravity'] = typeof p.enemyGravity === 'boolean' ? p.enemyGravity : DEFAULT_PARAMS.enemyGravity;
  out['enemyFires'] = typeof p.enemyFires === 'boolean' ? p.enemyFires : DEFAULT_PARAMS.enemyFires;
  out['occlusion'] = typeof p.occlusion === 'boolean' ? p.occlusion : DEFAULT_PARAMS.occlusion;
  const r = out['radius'] as number;
  out['softening'] = Math.min(out['softening'] as number, Math.floor(r * 0.5));
  return Object.freeze(out) as unknown as LabParams;
}

/** A start state: ship pose and velocity, planet start, whether an enemy pursues. */
export interface ScenarioStart {
  readonly id: ScenarioId;
  readonly title: string;
  readonly goal: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly heading: number;
  /** Planet start position (the moving-planet option shifts it so the encounter still happens mid-sector). */
  readonly bodyX: number;
  readonly bodyY: number;
  /** Planet velocity (px/s). */
  readonly bodyVx: number;
  readonly bodyVy: number;
  readonly enemy: { readonly x: number; readonly y: number; readonly vx: number; readonly vy: number; readonly heading: number } | null;
}

const H_EAST = Math.PI / 2;

/**
 * The three repeatable scenarios. Positions are fixed functions of the
 * parameters (no randomness), so every reset starts identically.
 *  A Escape:   start 330 px from the centre (inside the field), drifting slowly sideways; reach the field edge.
 *  B Slingshot: start 1500 px out, moving at `startSpeed`, `approachDeg` off the centre line; fly by and leave.
 *  C Evasion:  heading for the planet at 250 px/s with an interceptor `enemyGap` behind; use the planet to break pursuit.
 */
export function scenarioStart(id: ScenarioId, p: LabParams): ScenarioStart {
  const bx = LAB_SECTOR.bodyX;
  const by = LAB_SECTOR.bodyY;
  // moving planet: it travels up the screen; start it below so it crosses the middle around the encounter
  const lead = id === 'A' ? 0 : 6.5;
  const body = { bodyX: bx, bodyY: by + p.planetSpeed * lead, bodyVx: 0, bodyVy: -p.planetSpeed, enemy: null };
  if (id === 'A') {
    return { id, title: 'A · ESCAPE', goal: 'You start deep in the field. Climb out past the dotted field edge without hitting the planet.', x: bx, y: by + 330, vx: 60, vy: 0, heading: H_EAST, ...body };
  }
  if (id === 'B') {
    const a = (p.approachDeg * Math.PI) / 180;
    const x = bx - 1500;
    const y = by;
    return { id, title: 'B · SLINGSHOT', goal: 'Coast in, let gravity bend your path around the planet, then thrust out on a new heading.', x, y, vx: Math.cos(a) * p.startSpeed, vy: Math.sin(a) * p.startSpeed, heading: Math.atan2(Math.cos(a), -Math.sin(a)), ...body };
  }
  const x = bx - 1300;
  const y = by + 150;
  return {
    id,
    title: 'C · EVASION',
    goal: 'An interceptor is on your tail. Use the planet to change course, block its fire or open the gap until it loses you.',
    x,
    y,
    vx: 250,
    vy: 0,
    heading: H_EAST,
    ...body,
    enemy: { x: x - p.enemyGap, y, vx: 260, vy: 0, heading: H_EAST },
  };
}

/** The Landmark object of the gravity body is mutable: the moving-planet option and the radius tuning change it in place. */
export type MutableLandmark = { -readonly [K in keyof Landmark]: Landmark[K] };

/**
 * The experimental sector: Sol's sector record (id, factions, resources) with
 * its contents replaced by one gravity body and open space. No POIs, rocks,
 * patrols, encounter sites or hazards, so nothing in it can write progress.
 */
export function gravityLabLayout(base: SectorLayout, p: LabParams): { readonly layout: SectorLayout; readonly body: MutableLandmark } {
  const body: MutableLandmark = { id: 'gravity-body', kind: 'body', style: 'gas', x: LAB_SECTOR.bodyX, y: LAB_SECTOR.bodyY, r: p.radius, hazardR: 0, label: 'Gas giant · gravity test (simulated)' };
  const layout: SectorLayout = {
    ...base,
    width: LAB_SECTOR.width,
    height: LAB_SECTOR.height,
    difficulty: 2,
    encounterSlots: 0,
    arrival: { x: 240, y: 240, r: 110 },
    spawns: [{ id: 'arrival', x: 400, y: 400, heading: Math.PI * 0.75 }],
    landmarks: [body],
    regions: [],
    rocks: [],
    pois: [],
    patrols: [],
    sites: [],
    hazards: [],
    veins: [],
  };
  return { layout, body };
}

/** The lab's sector save: marked surveyed (there is nothing to survey) and never written anywhere. */
export const LAB_SAVE = Object.freeze({ done: Object.freeze([] as string[]), surveyed: true });
