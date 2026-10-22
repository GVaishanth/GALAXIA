import type { FrameSource, SpriteDef } from './format/types.ts';
import { ANIMATION_TIMING } from '../../config/visual.ts';

/**
 * FREE ROAM FLEET (Free Roam Prompt 8): six original GALAXIA spacecraft.
 *
 * Every hull is authored as the LEFT half including the centre column
 * (mirror-x), nose up, in the shared player palette, so the whole fleet
 * reads as "the player" in any scene (the palette never overlaps an enemy's).
 * The ships are told apart by shape, not colour: each one has its own
 * silhouette, wing arrangement, body, engine layout, cockpit / sensor
 * arrangement and proportions (checked by tests/fleet.test.ts):
 *
 *   Swift      scout        a small needle with a swept delta and one engine
 *   Shrike     interceptor  forward-swept wings ending in cannon prongs, twin engines
 *   Petrel     explorer     rounded body, straight wings with winglet pods, twin engines
 *   Condor     defender     broad armoured hexagon, shield-emitter pylons, four engines
 *   Magpie     salvager     U-shaped grab arms around a tractor lens, cargo pods, pod engines
 *   Albatross  long-range   long fuselage, very long thin wings, sensor mast, one large engine
 *
 * States: `idle` (engine cold), `thrust` (two flame frames) and `boost` (two
 * long flame frames). The damaged look is the `scorched` palette variant;
 * the shield impact is `fx.shield.impact`; destruction breaks the ship's own
 * frame into fragments over the shared player explosion (sector/render.ts).
 *
 * Each frame has as many blank rows on top as flame rows below, so the frame
 * centre (the rotation pivot and collision centre) is the centre of the hull.
 *
 * W hull.light  H hull  S hull.shade  D hull.dark
 * T trim  t trim.deep  C cockpit  G cockpit.glint  L light
 * N nozzle  E engine  Y engine.core
 */
const PALETTE = {
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

/** Flame rows below every hull (and blank rows above it). */
export const FLEET_FLAME_ROWS = 4;

interface Hull {
  readonly rows: readonly string[];
  /** Flame rows [thrust A, thrust B, boost A, boost B], each FLEET_FLAME_ROWS long and as wide as `rows`. */
  readonly flames: readonly [readonly string[], readonly string[], readonly string[], readonly string[]];
}

function states(h: Hull): { idle: FrameSource[]; thrust: FrameSource[]; boost: FrameSource[] } {
  const w = h.rows[0]!.length;
  const blank = Array.from({ length: FLEET_FLAME_ROWS }, () => '.'.repeat(w));
  const frame = (flame: readonly string[]): FrameSource => ({ rows: [...blank, ...h.rows, ...flame], symmetry: 'mirror-x' });
  return {
    idle: [frame(blank)],
    thrust: [frame(h.flames[0]), frame(h.flames[1])],
    boost: [frame(h.flames[2]), frame(h.flames[3])],
  };
}

/* ------------------------------------------------------------- Swift (scout) */
const SWIFT: Hull = {
  rows: [
    '.......W',
    '.......W',
    '......HW',
    '......HC',
    '......SG',
    '......SC',
    '......SH',
    '.....tSH',
    '....tTSH',
    '...tTHSH',
    '..tTHHSW',
    '.tTHHHSW',
    'LTHHDSSH',
    'L.DD.DSD',
    '......DN',
    '......NN',
  ],
  flames: [
    ['......EY', '.......E', '.......E', '........'],
    ['......EY', '......EY', '.......E', '........'],
    ['......EY', '......YY', '......EY', '.......E'],
    ['......YY', '......EY', '......EY', '......EE'],
  ],
};

/* ------------------------------------------------------- Shrike (interceptor) */
const SHRIKE: Hull = {
  rows: [
    '..W........',
    '..H........',
    '..H.......W',
    '..S......HW',
    '.LS......HC',
    '.SH.....SCG',
    '.SHt....SCC',
    '..HTt...SHW',
    '..SHTt.SHHW',
    '...SHTtSHTW',
    '....SHHHHTW',
    '.....SHHHTW',
    '.....DSHHtW',
    '......DSHtH',
    '......DSSDD',
    '......NN.DD',
  ],
  flames: [
    ['......EY...', '.......E...', '...........', '...........'],
    ['......YE...', '......E....', '.......E...', '...........'],
    ['......YY...', '......EY...', '......EE...', '.......E...'],
    ['......YY...', '......YE...', '.......E...', '......E....'],
  ],
};

/* ---------------------------------------------------------- Petrel (explorer) */
const PETREL: Hull = {
  rows: [
    '..........W',
    '.........SW',
    '........SHW',
    '........HCC',
    '........SCG',
    '........SCC',
    '........SHW',
    '.......SHHW',
    'T......SHTW',
    'W......SHTW',
    'HSSSSSSHHTW',
    'HHHHWWHHHTW',
    'SHHHHHHHHtW',
    'DSSSSSHHHtW',
    'L....DSSHtH',
    '.....DSSHSH',
    '.....DSDDSD',
    '.....NNN.DD',
  ],
  flames: [
    ['.....EYE...', '......E....', '......E....', '...........'],
    ['.....EYE...', '.....EYE...', '......E....', '...........'],
    ['.....YYY...', '.....EYE...', '.....EYE...', '......E....'],
    ['.....YYY...', '.....YYE...', '......YE...', '......E....'],
  ],
};

/* ---------------------------------------------------------- Condor (defender) */
const CONDOR: Hull = {
  rows: [
    '...........SHW',
    '..........SHHW',
    '.........SHHCC',
    '........SHHHCG',
    '.......SHHHHCC',
    '......SHHTTHHW',
    '.....SHHTttTHW',
    'L...SHHHTttTHW',
    'T..SHHHHHTTHHW',
    'T.SHHWWHHHHHHW',
    'TSHHHHHHHHHHHW',
    'THHHHHHHHHHHHW',
    'TSSSHHHHHHHHSW',
    'L.DSSSSHHHHSSH',
    '...DDSSSSSSSDH',
    '....DSDDDSDDDD',
    '....NNN.NNN.DD',
  ],
  flames: [
    ['....EYE.EYE...', '.....E...E....', '..............', '..............'],
    ['....EYE.EYE...', '....EYE.EYE...', '.....E...E....', '..............'],
    ['....YYY.YYY...', '....EYE.EYE...', '....EYE.EYE...', '.....E...E....'],
    ['....YYY.YYY...', '....YYE.YYE...', '.....YE..YE...', '.....E...E....'],
  ],
};

/* ---------------------------------------------------------- Magpie (salvager) */
const MAGPIE: Hull = {
  rows: [
    '.TW..........',
    '.HW..........',
    '.HH..........',
    '.SH..........',
    '.SH..........',
    'DSHH.........',
    'DSHHH.....LLL',
    'DSHHHSSSSHHHH',
    'SHHHHHHHHHCCC',
    'SHWWHHHHHHCGC',
    'SHHHHHHHHHHHW',
    'SHTTHHHHHHHHW',
    'SHTtHSSSSHHHW',
    'SHTtHD...SHHW',
    'SHHHHD...DSSH',
    'DSSSD.....DDD',
    '.NNN.........',
  ],
  flames: [
    ['.EYE.........', '..E..........', '..E..........', '.............'],
    ['.EYE.........', '.EYE.........', '..E..........', '.............'],
    ['.YYY.........', '.EYE.........', '.EYE.........', '..E..........'],
    ['.YYY.........', '.YYE.........', '..YE.........', '..E..........'],
  ],
};

/* ----------------------------------------------------- Albatross (long-range) */
const ALBATROSS: Hull = {
  rows: [
    '..............L',
    '..............S',
    '..............S',
    '.............SW',
    '.............HW',
    '.............HC',
    '............SCG',
    '............SCC',
    '............SHW',
    '............SHW',
    '............SHW',
    'L...........SHW',
    'TSSSSSSSSSSSHHW',
    'DHHHHHHHHHHHHTW',
    '.DDDSSDDDDDSHTW',
    '....DD......SHW',
    '............SHW',
    '............SHW',
    '...........SHHW',
    '.........tTSHtW',
    '.........DDDHtH',
    '...........DNNN',
  ],
  flames: [
    ['............EYY', '.............EY', '..............E', '...............'],
    ['............EYY', '............EYY', '.............EY', '..............E'],
    ['............YYY', '............EYY', '............EYY', '.............EY'],
    ['............YYY', '............YYY', '.............EY', '.............EE'],
  ],
};

const ms = { thrust: ANIMATION_TIMING.engineFlickerMs, boost: Math.round(ANIMATION_TIMING.engineFlickerMs * 0.75) };
const def = <const I extends string>(id: I, name: string, role: string, hull: Hull) =>
  ({ id, name, role, palette: PALETTE, outline: 'player.outline', states: states(hull), frameMs: ms }) as const;

export const SHIP_SWIFT = def('ship.swift', 'Swift', 'Scout', SWIFT) satisfies SpriteDef<'idle' | 'thrust' | 'boost'>;
export const SHIP_SHRIKE = def('ship.shrike', 'Shrike', 'Interceptor', SHRIKE) satisfies SpriteDef<'idle' | 'thrust' | 'boost'>;
export const SHIP_PETREL = def('ship.petrel', 'Petrel', 'Explorer', PETREL) satisfies SpriteDef<'idle' | 'thrust' | 'boost'>;
export const SHIP_CONDOR = def('ship.condor', 'Condor', 'Defender', CONDOR) satisfies SpriteDef<'idle' | 'thrust' | 'boost'>;
export const SHIP_MAGPIE = def('ship.magpie', 'Magpie', 'Salvager', MAGPIE) satisfies SpriteDef<'idle' | 'thrust' | 'boost'>;
export const SHIP_ALBATROSS = def('ship.albatross', 'Albatross', 'Long-range vessel', ALBATROSS) satisfies SpriteDef<'idle' | 'thrust' | 'boost'>;

/** The fleet hulls in roster order (also the authored rows, for the silhouette tests). */
export const FLEET_SPRITES = [SHIP_SWIFT, SHIP_SHRIKE, SHIP_PETREL, SHIP_CONDOR, SHIP_MAGPIE, SHIP_ALBATROSS] as const;

/**
 * Shield impact: a bright arc drawn on the side that was hit (the renderer
 * rotates it toward the impact and scales it to the hull). Three frames,
 * bright to faint. Rows are the left half of the arc, opening downward.
 */
const ARC_A = ['......LGL', '...LLL...', '.LL......', 'L........', 'L........'];
const ARC_B = ['......L.L', '...L.L...', '.L.......', 'L........', '.........'];
const ARC_C = ['.......L.', '...L.....', '.........', 'L........', '.........'];

export const FX_SHIELD_IMPACT = {
  id: 'fx.shield.impact',
  name: 'Shield impact',
  role: 'Shield flare on the struck side of a Free Roam ship',
  palette: { L: 'player.light', G: 'player.cockpit.glint' },
  outline: null,
  states: {
    flare: [
      { rows: ARC_A, symmetry: 'mirror-x' },
      { rows: ARC_B, symmetry: 'mirror-x' },
      { rows: ARC_C, symmetry: 'mirror-x' },
    ],
  },
  frameMs: { flare: 70 },
} as const satisfies SpriteDef<'flare'>;
