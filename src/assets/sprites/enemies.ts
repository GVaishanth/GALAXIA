import type { FrameSource, SpriteDef } from './format/types.ts';
import { ANIMATION_TIMING } from '../../config/visual.ts';

const mx = (rows: readonly string[]): FrameSource => ({ rows, symmetry: 'mirror-x' });

/* -------------------------------------------------------------------------- */
/* SCOUT: "Mite". Small, compact, amber body with ultramarine wings.          */
/* Faces down. Two wing beats.                                                 */
/* Y body.light  A body  a body.shade  K stripe  B wing.light  U wing         */
/* u wing.shade  R eye                                                         */
/* -------------------------------------------------------------------------- */

const SCOUT_UP = mx([
  '..B.........',
  '.BUu......aY',
  '.BUUu....aAY',
  '..BUUu..aAAY',
  '..BUUUuaKKKK',
  '...BUUUuAAAY',
  '...BBUUuAAAY',
  '....BUUuKKKK',
  '.....uuaAAAY',
  '.......aAAAY',
  '.......aKKKK',
  '........aAAA',
  '.......RRaAA',
  '........RaaA',
  '.........a.a',
]);

const SCOUT_DOWN = mx([
  '..........aY',
  '.........aAY',
  '........aAAY',
  '.......aKKKK',
  '.....BBuAAAY',
  '...BBUUuAAAY',
  '.BBUUUUuKKKK',
  'BUUUUUuaAAAY',
  'BUUUUuuaAAAY',
  '.uUUuu.aKKKK',
  '..uu....aAAA',
  '.......RRaAA',
  '........RaaA',
  '.........a.a',
  '............',
]);

const SCOUT_PALETTE = {
  Y: 'scout.body.light',
  A: 'scout.body',
  a: 'scout.body.shade',
  K: 'scout.stripe',
  B: 'scout.wing.light',
  U: 'scout.wing',
  u: 'scout.wing.shade',
  R: 'scout.eye',
} as const;

export const ENEMY_SCOUT = {
  id: 'enemy.scout',
  name: 'Mite',
  role: 'Scout: small, numerous, fast diver',
  palette: SCOUT_PALETTE,
  outline: 'scout.outline',
  states: {
    formation: [SCOUT_UP, SCOUT_DOWN],
    attack: [SCOUT_DOWN],
  },
  frameMs: { formation: ANIMATION_TIMING.formationFlapMs },
} as const satisfies SpriteDef<'formation' | 'attack'>;

/* -------------------------------------------------------------------------- */
/* INTERCEPTOR: "Razorwing". Medium escort: two pairs of swept crimson blades */
/* with blue leading edges on a pale spine. Blades fold for the dive.         */
/* P wing.light  Q wing  q wing.shade  I body.light  J body  j body.shade     */
/* Z accent  O eye                                                             */
/* -------------------------------------------------------------------------- */

const INTERCEPTOR_OPEN = mx([
  'Z..........j..',
  'ZPq.........jI',
  '.ZPQq......jJI',
  '..ZPQQq....jJI',
  '..ZPQQQq...jJI',
  '...ZPQQQQq.jJI',
  '...ZPPQQQQqjJI',
  '....ZZPQQQQjJI',
  '......qqQQQjJI',
  '........qQQjJI',
  '.........qQjJI',
  '........qQQjJI',
  '......qQQQQjJI',
  '....qQQQQPZjJI',
  '...qQQQPZ..jJI',
  '..qQQPZ....jJI',
  '.qQPZ......OjI',
  'qPZ........jJ.',
  '............j.',
]);

const INTERCEPTOR_FOLDED = mx([
  '...Z.......j..',
  '...ZPq......jI',
  '....ZPq....jJI',
  '....ZPQq...jJI',
  '.....ZPQq..jJI',
  '.....ZPQQq.jJI',
  '......ZPQQqjJI',
  '......ZZPQQjJI',
  '........qQQjJI',
  '.........qQjJI',
  '.........qQjJI',
  '.........qQjJI',
  '........qQQjJI',
  '.......qQQPjJI',
  '......qQPZ.jJI',
  '.....qQPZ..jJI',
  '....qPZ....OjI',
  '....qZ.....jJ.',
  '............j.',
]);

const INTERCEPTOR_PALETTE = {
  P: 'interceptor.wing.light',
  Q: 'interceptor.wing',
  q: 'interceptor.wing.shade',
  I: 'interceptor.body.light',
  J: 'interceptor.body',
  j: 'interceptor.body.shade',
  Z: 'interceptor.accent',
  O: 'interceptor.eye',
} as const;

export const ENEMY_INTERCEPTOR = {
  id: 'enemy.interceptor',
  name: 'Razorwing',
  role: 'Interceptor: medium escort, sweeping dives',
  palette: INTERCEPTOR_PALETTE,
  outline: 'interceptor.outline',
  states: {
    formation: [INTERCEPTOR_OPEN, INTERCEPTOR_FOLDED],
    attack: [INTERCEPTOR_FOLDED],
  },
  frameMs: { formation: ANIMATION_TIMING.formationFlapMs },
} as const satisfies SpriteDef<'formation' | 'attack'>;

/* -------------------------------------------------------------------------- */
/* COMMANDER: "Warden". Large crowned carrier: emerald dome with light ridges, */
/* gold-edged manta plates that flex, a single rose visor band, gold mandibles */
/* around the belly emitter (dim at rest, lit blue while capturing).           */
/* X hull.light  G hull  g hull.shade  d hull.dark  O gold  o gold.shade      */
/* V visor  e/c emitter (idle or lit)                                          */
/* -------------------------------------------------------------------------- */

const COMMANDER_CROWN: readonly string[] = [
  '..............oO',
  '..........o...oO',
  '..........Oo.oOO',
  '..........oOOOOO',
  '.........dgGGGGX',
  '........dgGGGXGX',
  '.......dgGGGXGGX',
  '......dgGGGXGGGX',
];

const COMMANDER_PLATES_OUT: readonly string[] = [
  '...o.dgGGGXGGGGX',
  '..oOdgGGGXGGGGGX',
  '.oOGdgGGXGGGGGGX',
  'oOXGgdgGXGGGGGGX',
  'oOXGgdgGGGGGGGGX',
  'oOGGgddgGGGGGGGX',
  'oOGGGgddgGGGGGGG',
  '.oOGGgdgVVVVVVVV',
  '.oOGGgddgggggggg',
  '..oOgg.ddgGGGGGG',
  '...oOg..dgGGGGGG',
  '....oo...dgGGGGG',
];

const COMMANDER_PLATES_IN: readonly string[] = [
  '.....dgGGGXGGGGX',
  '...oOdGGGXGGGGGX',
  '..oOGdgGXGGGGGGX',
  '.oOXGdgGXGGGGGGX',
  '.oOXgdgGGGGGGGGX',
  '.oOGgddgGGGGGGGX',
  '.oOGGgddgGGGGGGG',
  '..oOGgdgVVVVVVVV',
  '..oOGgddgggggggg',
  '...oOg.ddgGGGGGG',
  '....oOg.dgGGGGGG',
  '.....oo..dgGGGGG',
];

const commanderBelly = (e: string, c: string): readonly string[] => [
  '.........odgGGGG',
  '........oOddgggd',
  '........oO..d' + e + e + e,
  '.........oO..d' + e + c,
  '..........Oo..' + e + c,
  '...........o...' + e,
];

const BELLY_IDLE = commanderBelly('n', 'n');
const BELLY_EMIT = commanderBelly('M', 'm');

const commanderFrame = (plates: readonly string[], belly: readonly string[]): FrameSource =>
  mx([...COMMANDER_CROWN, ...plates, ...belly]);

const COMMANDER_PALETTE = {
  X: 'commander.hull.light',
  G: 'commander.hull',
  g: 'commander.hull.shade',
  d: 'commander.hull.dark',
  O: 'commander.gold',
  o: 'commander.gold.shade',
  V: 'commander.visor',
  n: 'commander.emitter.idle',
  M: 'commander.emitter',
  m: 'commander.emitter.core',
} as const;

export const ENEMY_COMMANDER = {
  id: 'enemy.commander',
  name: 'Warden',
  role: 'Commander: tractor-beam ship, takes two hits',
  palette: COMMANDER_PALETTE,
  outline: 'commander.outline',
  states: {
    formation: [commanderFrame(COMMANDER_PLATES_OUT, BELLY_IDLE), commanderFrame(COMMANDER_PLATES_IN, BELLY_IDLE)],
    attack: [commanderFrame(COMMANDER_PLATES_IN, BELLY_IDLE)],
    capture: [commanderFrame(COMMANDER_PLATES_OUT, BELLY_EMIT), commanderFrame(COMMANDER_PLATES_IN, BELLY_EMIT)],
  },
  frameMs: { formation: ANIMATION_TIMING.formationFlapMs, capture: ANIMATION_TIMING.beamCycleMs * 2 },
} as const satisfies SpriteDef<'formation' | 'attack' | 'capture'>;
