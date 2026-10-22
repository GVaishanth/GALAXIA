import type { FrameSource, SpriteDef } from './format/types.ts';
import { ANIMATION_TIMING } from '../../config/visual.ts';

const mx = (rows: readonly string[]): FrameSource => ({ rows, symmetry: 'mirror-x' });

/* -------------------------------------------------------------------------- */
/* SPECIAL 1: "Barbtail". Scorpion-like transform: segmented tail arched over */
/* the back with a glowing barb, side legs, forward pincers.                  */
/* L light  B body  s shade  k dark  T tail  t tail.tip  R eye                */
/* -------------------------------------------------------------------------- */

const BARBTAIL_TAIL: readonly string[] = [
  '.............t',
  '............tT',
  '...........t.T',
  '.............T',
  '...........sBL',
  '............kk',
  '...........sBL',
  '............kk',
  '...........sBL',
  '............kk',
];

const BARBTAIL_BODY: readonly string[] = [
  '..........sBBL',
  '.kk......sBBBL',
  '...kk..sBBLBBL',
  '.....kksBkkkkk',
  '.kk....sBBLBBL',
  '...kkkksBkkkkk',
  '.......sBBLBBL',
  '.kk.kkksBkkkkk',
  '........sBBBBL',
];

const BARBTAIL_CLAWS_OPEN: readonly string[] = [
  '....sBBs.RsBBL',
  '..sBBLBBs..sBL',
  '.sBLs..sBs..sk',
  'sBL......sB...',
  'sBL.......sL..',
  '.sBs.....sL...',
  '..sL....L.....',
];

const BARBTAIL_CLAWS_CLOSED: readonly string[] = [
  '....sBBs.RsBBL',
  '..sBBLBBs..sBL',
  '.sBLs..sBs..sk',
  'sBL....sB.....',
  'sBL...sL......',
  '.sBs.sL.......',
  '..sLL.........',
];

const BARBTAIL_PALETTE = {
  L: 'stinger.light',
  B: 'stinger.body',
  s: 'stinger.shade',
  k: 'stinger.dark',
  T: 'stinger.tail',
  t: 'stinger.tail.tip',
  R: 'stinger.eye',
} as const;

export const SPECIAL_STINGER = {
  id: 'special.stinger',
  name: 'Barbtail',
  role: 'Special transform: scorpion-like, bonus trio',
  palette: BARBTAIL_PALETTE,
  outline: 'stinger.outline',
  states: {
    flight: [
      mx([...BARBTAIL_TAIL, ...BARBTAIL_BODY, ...BARBTAIL_CLAWS_OPEN]),
      mx([...BARBTAIL_TAIL, ...BARBTAIL_BODY, ...BARBTAIL_CLAWS_CLOSED]),
    ],
  },
  frameMs: { flight: ANIMATION_TIMING.formationFlapMs / 2 },
} as const satisfies SpriteDef<'flight'>;

/* -------------------------------------------------------------------------- */
/* SPECIAL 2: "Wisp". Spy-ship-like transform: magenta kite hull, swept       */
/* silver blades, pulsing amber core lamp.                                     */
/* L light  M body  m shade  d dark  S silver  s silver.shade  C core          */
/* -------------------------------------------------------------------------- */

const wispFrame = (core: string, tip: string): FrameSource =>
  mx([
    '............mM',
    '...........mML',
    '..........mMML',
    '.........mMMLL',
    '.....ss.mMMdMM',
    '....sSSSmMMMd' + core,
    '...sSSSsmMMd' + core + core,
    '..sSSSsmMMMd' + core + core,
    '.sSSSs.mMMMMd' + core,
    'sSSSs...mMMMMM',
    'sSSs.....mMMMM',
    'sSs.......mMMd',
    tip + 's.........mMd',
    tip + '............d',
  ]);

const WISP_PALETTE = {
  L: 'phantom.light',
  M: 'phantom.body',
  m: 'phantom.shade',
  d: 'phantom.dark',
  S: 'phantom.silver',
  s: 'phantom.silver.shade',
  C: 'phantom.core',
  c: 'phantom.light',
} as const;

export const SPECIAL_PHANTOM = {
  id: 'special.phantom',
  name: 'Wisp',
  role: 'Special transform: spy-ship-like, bonus trio',
  palette: WISP_PALETTE,
  outline: 'phantom.outline',
  states: {
    flight: [wispFrame('C', 'S'), wispFrame('c', 's')],
  },
  frameMs: { flight: ANIMATION_TIMING.formationFlapMs / 2 },
} as const satisfies SpriteDef<'flight'>;

/* -------------------------------------------------------------------------- */
/* SPECIAL 3: "Regent". Flagship-like transform: crowned gold hull, crimson   */
/* wings tipped royal blue, central gem.                                       */
/* L gold.light  O gold  o gold.shade  R red  r red.shade  B blue             */
/* b blue.shade  G gem                                                         */
/* -------------------------------------------------------------------------- */

const regentFrame = (gem: string): FrameSource =>
  mx([
    '..........O...O',
    '..........Oo.oL',
    '..........oOOOL',
    'bb.........oOOL',
    'bBR........oOOL',
    'bBRr......oOOOL',
    '.bBRr....oOOOO' + gem,
    '.bBRRr..oOOOL' + gem + gem,
    '..bBRRrroOOOOL' + gem,
    '..bBRRRRoOOOOLO',
    '...bBRRRRoOOOOO',
    '...bBRRRRroOOOO',
    '....bBRRRRroOOO',
    '....bBRRRrr.oOO',
    '.....bBRrr...oO',
    '.....bBr.....oO',
    '......b.....oO.',
    '............O..',
  ]);

const REGENT_PALETTE = {
  L: 'sovereign.gold.light',
  O: 'sovereign.gold',
  o: 'sovereign.gold.shade',
  R: 'sovereign.red',
  r: 'sovereign.red.shade',
  B: 'sovereign.blue',
  b: 'sovereign.blue.shade',
  G: 'sovereign.gem',
  g: 'sovereign.gold.light',
} as const;

export const SPECIAL_SOVEREIGN = {
  id: 'special.sovereign',
  name: 'Regent',
  role: 'Special transform: flagship-like, bonus leader',
  palette: REGENT_PALETTE,
  outline: 'sovereign.outline',
  states: {
    flight: [regentFrame('G'), regentFrame('g')],
  },
  frameMs: { flight: ANIMATION_TIMING.formationFlapMs / 2 },
} as const satisfies SpriteDef<'flight'>;
