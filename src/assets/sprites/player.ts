import type { FrameSource, SpriteDef } from './format/types.ts';
import { flipVertical, joinHorizontal } from './format/grid.ts';
import { ANIMATION_TIMING } from '../../config/visual.ts';

/**
 * PLAYER: "Aster" fighter.
 * Rows are the LEFT half including the centre column (mirror-x).
 * Nose up. Twin forward cannon pods sit mid-wing, wingtip running lights at
 * the swept tips, central cyan canopy, triple-nozzle engine block.
 *
 * W hull.light  H hull  S hull.shade  D hull.dark
 * T trim  t trim.deep  C cockpit  G cockpit.glint  L light
 * N nozzle  E engine  Y engine.core
 */
const PLAYER_PALETTE = {
  W: 'player.hull.light',
  H: 'player.hull',
  S: 'player.hull.shade',
  D: 'player.hull.dark',
  T: 'player.trim',
  t: 'player.trim.deep',
  C: 'player.cockpit',
  G: 'player.cockpit.glint',
  L: 'player.light',
  N: 'player.nozzle',
  E: 'player.engine',
  Y: 'player.engine.core',
} as const;

const HULL: readonly string[] = [
  '.............W',
  '............HW',
  '............HW',
  '...........SHW',
  '...........tCG',
  '...........tCC',
  '......T....tCC',
  '......W....SHW',
  '.....tW....SHW',
  '.....tH...SHHW',
  '.....tH...SHTW',
  '.....tH..SHHTW',
  '....StHSSHHHTW',
  '...SHtHHHHHHTW',
  '..SHHtHWWHHHTW',
  '.SHHHtHHHHHHTW',
  'LHHTTtHHHHHHtW',
  'LSHHHSSHHHHHtW',
  '.DSSSDDSHHHHtW',
  '..DD..DDSHHtSW',
  '........DSHtSH',
  '.......DDDSSDH',
  '.......NN..NNN',
];

const FLAME_A: readonly string[] = [
  '.......YE..EYY',
  '.......E...EYY',
  '...........EEY',
  '............EE',
  '.............E',
];

const FLAME_B: readonly string[] = [
  '.......EE..EYY',
  '...........EYY',
  '............EY',
  '.............E',
  '..............',
];

const ENGINE_OFF: readonly string[] = ['..............', '..............', '..............', '..............', '..............'];

const fighter = (flame: readonly string[]): FrameSource => ({ rows: [...HULL, ...flame], symmetry: 'mirror-x' });

const FIGHTER_A = fighter(FLAME_A);
const FIGHTER_B = fighter(FLAME_B);
const FIGHTER_COLD = fighter(ENGINE_OFF);

/** Gap between the two halves of the Dual Fighter, in art px (outlines must not merge). */
export const DUAL_FIGHTER_GAP = 3;

export const PLAYER_FIGHTER = {
  id: 'player.fighter',
  name: 'Aster',
  role: 'Player fighter',
  palette: PLAYER_PALETTE,
  outline: 'player.outline',
  states: {
    idle: [FIGHTER_A, FIGHTER_B],
    /** Held by a Warden: engine cold, nose down. Render with the 'captive' variant. */
    captured: [flipVertical(FIGHTER_COLD)],
    /** Freed ship returning to the player: render with the 'rescued' variant blinking. */
    rescued: [FIGHTER_A, FIGHTER_B],
  },
  frameMs: { idle: ANIMATION_TIMING.engineFlickerMs, rescued: ANIMATION_TIMING.engineFlickerMs },
} as const satisfies SpriteDef<'idle' | 'captured' | 'rescued'>;

export const PLAYER_DUAL = {
  id: 'player.dual',
  name: 'Aster Twin',
  role: 'Dual Fighter (two docked Asters)',
  palette: PLAYER_PALETTE,
  outline: 'player.outline',
  states: {
    idle: [
      joinHorizontal([FIGHTER_A, FIGHTER_B], DUAL_FIGHTER_GAP),
      joinHorizontal([FIGHTER_B, FIGHTER_A], DUAL_FIGHTER_GAP),
    ],
  },
  frameMs: { idle: ANIMATION_TIMING.engineFlickerMs },
} as const satisfies SpriteDef<'idle'>;
