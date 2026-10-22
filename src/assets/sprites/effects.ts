import type { FrameSource, SpriteDef } from './format/types.ts';
import { generateRows } from './format/grid.ts';
import { ANIMATION_TIMING } from '../../config/visual.ts';

const mx = (rows: readonly string[]): FrameSource => ({ rows, symmetry: 'mirror-x' });
const mxy = (rows: readonly string[]): FrameSource => ({ rows, symmetry: 'mirror-xy' });

/* Player shot: slim cyan-white bolt. C core  E edge */
export const SHOT_PLAYER = {
  id: 'fx.shot.player',
  name: 'Aster bolt',
  role: 'Player projectile',
  palette: { C: 'shot.player.core', E: 'shot.player.edge' },
  outline: null,
  states: {
    fly: [
      mx(['.C', 'EC', 'EC', 'EC', 'EC', 'EC', '.E', '.E']),
      mx(['.C', 'EC', 'EC', 'EC', 'EC', '.C', '.E', '..']),
    ],
  },
  frameMs: { fly: ANIMATION_TIMING.shotFlickerMs },
} as const satisfies SpriteDef<'fly'>;

/* Enemy shot: vermilion diamond with a hot yellow core. Y core  E edge  d dark */
export const SHOT_ENEMY = {
  id: 'fx.shot.enemy',
  name: 'Hostile spark',
  role: 'Enemy projectile',
  palette: { Y: 'shot.enemy.core', E: 'shot.enemy.edge', d: 'shot.enemy.dark' },
  outline: null,
  states: {
    fly: [
      mx(['..d', '.EE', 'EYY', 'EYY', '.EY', '.dE', '..d']),
      mx(['..d', '.EY', 'EEY', 'EYY', '.EE', '.dE', '..d']),
    ],
  },
  frameMs: { fly: ANIMATION_TIMING.shotFlickerMs },
} as const satisfies SpriteDef<'fly'>;

/* Tractor beam: procedural widening cone of travelling arcs. L light  M mid  D deep */
export const BEAM_WIDTH = 47;
export const BEAM_HEIGHT = 72;
const BEAM_PERIOD = 9;

function beamFrame(phase: number): FrameSource {
  const centre = (BEAM_WIDTH - 1) / 2;
  const rows = generateRows(BEAM_WIDTH, BEAM_HEIGHT, (x, y) => {
    const halfWidth = 4 + (y / (BEAM_HEIGHT - 1)) * (centre - 4);
    const dx = Math.abs(x - centre);
    if (dx > halfWidth) return '.';
    const bow = 5 * (dx / halfWidth) ** 2;
    const band = (((y + bow - phase) % BEAM_PERIOD) + BEAM_PERIOD) % BEAM_PERIOD;
    if (band < 1) return 'L';
    if (band < 2) return 'M';
    if (band < 3) return 'D';
    if (dx > halfWidth - 1) return 'D';
    return '.';
  });
  return { rows, symmetry: 'none' };
}

export const BEAM_TRACTOR = {
  id: 'fx.beam.tractor',
  name: 'Tractor beam',
  role: 'Warden capture beam',
  palette: { L: 'beam.light', M: 'beam.mid', D: 'beam.deep' },
  outline: null,
  states: { active: [beamFrame(0), beamFrame(3), beamFrame(6)] },
  frameMs: { active: ANIMATION_TIMING.beamCycleMs },
} as const satisfies SpriteDef<'active'>;

/*
 * Explosions are authored as the TOP-LEFT quadrant (last column = centre
 * column, last row = centre row) and mirrored both ways.
 * W white  Y yellow  O orange  R red  S smoke  C cyan  B blue
 */
const EXPLOSION_PALETTE = {
  W: 'fx.white',
  Y: 'fx.yellow',
  O: 'fx.orange',
  R: 'fx.red',
  S: 'fx.smoke',
  C: 'fx.cyan',
  B: 'fx.blue',
} as const;

const E = '............';
export const EXPLOSION_ENEMY = {
  id: 'fx.explosion.enemy',
  name: 'Enemy burst',
  role: 'Enemy destruction',
  palette: EXPLOSION_PALETTE,
  outline: null,
  states: {
    burst: [
      mxy([E, E, E, E, E, E, E, '...........O', '........O..Y', '.........YYY', '.........YWW', '.......OYYWW']),
      mxy([
        E,
        E,
        E,
        '...........R',
        '....R......O',
        '.....O.....Y',
        '......Y..OOY',
        '.......Y.OYW',
        '........YYWW',
        '......OOYWWW',
        '......OYWWWW',
        '...ROOYYWWWW',
      ]),
      mxy([
        '...........R',
        '.R..........',
        '..O........O',
        '...O.......Y',
        '....Y...R...',
        '.......O....',
        '......O..R..',
        '...R.....Y..',
        '........Y..O',
        '.......O..YY',
        '..........Y.',
        'RO..OY...Y..',
      ]),
      mxy([
        '...........S',
        'S...........',
        '.R..........',
        '...........R',
        '...S........',
        '........S...',
        '......R.....',
        '..S.........',
        '.........R..',
        '............',
        '....S.......',
        '.R......R...',
      ]),
    ],
  },
  frameMs: { burst: ANIMATION_TIMING.explosionFrameMs },
} as const satisfies SpriteDef<'burst'>;

const P = '................';
export const EXPLOSION_PLAYER = {
  id: 'fx.explosion.player',
  name: 'Aster breakup',
  role: 'Player destruction',
  palette: EXPLOSION_PALETTE,
  outline: null,
  states: {
    burst: [
      mxy([P, P, P, P, P, P, P, P, P, '...............C', '...............Y', '...........C..YW', '............YYWW', '............YWWW', '.............WWW', '.........CYYWWWW']),
      mxy([
        P,
        P,
        P,
        '...............C',
        '....B...........',
        '.....C.........Y',
        '......Y.....O..O',
        '.......O.......Y',
        '........Y...OYYW',
        '..........C.YWWW',
        '...........YYWWW',
        '..........OYWWW.',
        '..........YWW...',
        '.........OYWW...',
        '.......OYYWW....',
        '...BCOYYWW......',
      ]),
      mxy([
        '...............B',
        '.B..............',
        '..C.............',
        '...C...........C',
        '....O.......R...',
        '.....Y.....O....',
        '.........Y......',
        '.......R....C...',
        '..O.......Y.....',
        '.....Y.....O....',
        '........C.....YO',
        '...........O..Y.',
        '.....R..Y.......',
        '..C.........O...',
        '..........Y.....',
        'BC..OY...R...Y..',
      ]),
      mxy([
        '...............S',
        'S...............',
        '.B..............',
        '..............R.',
        '...S............',
        '..........S.....',
        '......R.........',
        '..B.........C...',
        '.........R......',
        '....S...........',
        '..............S.',
        '.R.......R......',
        '................',
        '.....S......B...',
        '.........S......',
        'S.....R.........',
      ]),
    ],
  },
  frameMs: { burst: ANIMATION_TIMING.explosionFrameMs * 1.4 },
} as const satisfies SpriteDef<'burst'>;

export const FX_HIT = {
  id: 'fx.hit',
  name: 'Impact spark',
  role: 'Shot impact on a surviving target',
  palette: EXPLOSION_PALETTE,
  outline: null,
  states: {
    spark: [mxy(['...Y', '...W', '..WW', 'YWWW']), mxy(['O...', '.Y..', '..Y.', '...W'])],
  },
  frameMs: { spark: ANIMATION_TIMING.hitSparkFrameMs },
} as const satisfies SpriteDef<'spark'>;
