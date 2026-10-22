import type { FrameSource, SpriteDef } from './format/types.ts';
import { ANIMATION_TIMING } from '../../config/visual.ts';

/**
 * FREE ROAM ENEMIES (Free Roam Prompt 9): eight original hostile hulls, one
 * per enemy family. Each family is told apart by SHAPE and size (tested in
 * tests/combat.test.ts), and each faction by its palette variant plus an emblem
 * and engine trail drawn by the renderer, so nothing depends on colour alone.
 *
 *   raider   13 px  a small dart with forward claw prongs
 *   recon    15 px  a thin hull with a sensor mast and a ring eye
 *   picket   17 px  straight wings ending in weapon pods
 *   lancer   19 px  a long needle with forward-swept blades
 *   hauler   21 px  a boxy cargo hull with grab claws and a cargo bay
 *   heavy    25 px  an armoured wedge with side slabs and a long siege barrel
 *   elite    27 px  a layered crescent with crown blades and three engines
 *   capital  47 px  a carrier: bridge tower, glowing launch bay, forked sponsons
 *
 * Hulls are authored nose up as the LEFT half including the centre column
 * (mirror-x), in Red Tally roles (`tally.*`); the other factions are palette
 * variants (gleaners, cordon, tessellate) and every faction has a worn variant
 * for a badly damaged hull. States: `fly` (two flame frames) and `drift`
 * (engines cold: disabled ships). As in the player fleet, each frame has as
 * many blank rows above as flame rows below, so the frame centre is the hull
 * centre (rotation pivot and collision centre).
 *
 * W hull.light  H hull  S hull.shade  D hull.dark  N nozzle (hull.dark)
 * M mark  m mark.deep  E eye (sensor / bridge glow)  F engine  Y engine.core
 */
const PALETTE = {
  W: 'tally.hull.light',
  H: 'tally.hull',
  S: 'tally.hull.shade',
  D: 'tally.hull.dark',
  N: 'tally.hull.dark',
  M: 'tally.mark',
  m: 'tally.mark.deep',
  E: 'tally.eye',
  F: 'tally.engine',
  Y: 'tally.engine.core',
} as const;

export const FOE_FLAME_ROWS = 3;

/** Two flame frames under every nozzle pixel ('N') of the last hull row. */
function flames(rows: readonly string[]): [string[], string[]] {
  const last = rows[rows.length - 1]!;
  const at = (ch: string): string => [...last].map((c) => (c === 'N' ? ch : '.')).join('');
  const blank = '.'.repeat(last.length);
  return [
    [at('Y'), at('F'), blank],
    [at('Y'), at('Y'), at('F')],
  ];
}

function states(rows: readonly string[]): { fly: FrameSource[]; drift: FrameSource[] } {
  const w = rows[0]!.length;
  const blank = Array.from({ length: FOE_FLAME_ROWS }, () => '.'.repeat(w));
  const [a, b] = flames(rows);
  const frame = (flame: readonly string[]): FrameSource => ({ rows: [...blank, ...rows, ...flame], symmetry: 'mirror-x' });
  return { fly: [frame(a), frame(b)], drift: [frame(blank)] };
}

/* raider: light raider, a dart with claw prongs */
const RAIDER = [
  'M.....W',
  'H.....W',
  'H....HE',
  'SH...HH',
  'SH..SHW',
  '.SHSSHW',
  '..SHHHM',
  '...DSHM',
  '....DSD',
  '.....NN',
];

/* recon: reconnaissance, sensor mast and ring eye on thin booms */
const RECON = [
  '.......E',
  '.......D',
  '.......D',
  '.....SHW',
  '....SHEW',
  '....SHHW',
  '.....SHH',
  'M.....SH',
  '.H....SH',
  '..H..SHM',
  '...HSSHM',
  '..D..DSD',
  '......NN',
];

/* picket: patrol fighter, straight wings with weapon pods */
const PICKET = [
  '........W',
  '.......HW',
  '.......HE',
  '.......SH',
  '......SHH',
  'M.....SHW',
  'H....SSHW',
  'HMMMMSHHM',
  'HSSSSSHHM',
  'D.....SHW',
  'D....DSHH',
  '.....DDSD',
  '......NNN',
];

/* lancer: interceptor, a needle with forward-swept blades */
const LANCER = [
  '.........W',
  '.........W',
  '.........H',
  '........HE',
  '..M.....HH',
  '..HM....SH',
  '...HM..SHW',
  '....HMSSHW',
  '.....SSHHW',
  '....SSHHHM',
  '...SS.SHHM',
  '..SD..DSHH',
  '.D.....DSD',
  '........NN',
];

/* hauler: cargo raider, grab claws, box hull with an open cargo bay */
const HAULER = [
  '.W.........',
  '.H.........',
  '.HS........',
  '..HS.....HE',
  '..SHSSSSHHW',
  '...SHHHHHHW',
  '....SHHHHHW',
  '.MMSSHDDDHH',
  'MHHSSHD..DH',
  'MHHSSHD..DH',
  'MHHSSHDDDHM',
  '.SSSSHHHHHM',
  '..D.SSSSSSD',
  '....D...NNN',
];

/* heavy: heavy combat ship, armoured wedge with a long siege barrel */
const HEAVY = [
  '............W',
  '............W',
  '...........DH',
  '...........DH',
  '.........SSHE',
  '....MM..SHHHH',
  '...SHHMSHHWHH',
  '..SHHHHSHHWHM',
  '.SHHHHHSHHWHM',
  'SHHDDDHSHHHHH',
  'SHD...DSHHSHW',
  'SD.....DSSSHW',
  'D.......DDSSD',
  '..........NNN',
];

/* elite: layered crescent with crown blades */
const ELITE = [
  '.............W',
  '.............W',
  '............HW',
  '............HE',
  '...........SHH',
  '..M........SHW',
  '..HM......SHHW',
  '..HHM....SHHHM',
  '.SHHHM..SHHWHM',
  '.SHHHHMSHHHWHH',
  'SHHHHHHSHHHWHH',
  'SHHDDHHSHHHHHM',
  'SHD..DHSHHSSHM',
  'SD....DSHSDDSH',
  'D......DSD..DS',
  '........N...NN',
];

/* capital: carrier with a bridge tower, launch bay and forked sponsons */
const CAPITAL = [
  '.......................W',
  '.......................W',
  '......................HW',
  '......................HH',
  '.....................SHH',
  '....................SHHW',
  '...................SHHHW',
  '..................SHHDHW',
  '.................SHHDEHW',
  '................SHHHDHHH',
  '...............SHHHHHHHM',
  '..............SHHMMHHHHM',
  '.........MMMMSHHHHHHHHHH',
  '........SHHHHSHHWWHHHDDD',
  '.......SHHHHHSHHWWHHHDmm',
  '......SHDHDHHSHHWWHHHDEE',
  '......SHDHDHHSHHWWHHHDmm',
  '......SHHHHHHSHHWWHHHDDD',
  '.......SHHHHSSHHHHHHHHHM',
  '........DDDDSHHHHHHHHHHM',
  '...........SHHSSSSHHHHHH',
  '..........SHHSDDDDSHHHHW',
  '.........MHHSD....DSHHHW',
  '........MHHSD......DSHHW',
  '.......MHHSD........DSHH',
  '......DSSD..........DSSD',
  '.....NNN............DNNN',
];

const ms = { fly: ANIMATION_TIMING.engineFlickerMs };
const def = <const I extends string>(id: I, name: string, role: string, rows: readonly string[]) =>
  ({ id, name, role, palette: PALETTE, outline: 'tally.outline', states: states(rows), frameMs: ms }) as const;

export const FOE_RAIDER = def('foe.raider', 'Raider', 'Light raider', RAIDER) satisfies SpriteDef<'fly' | 'drift'>;
export const FOE_RECON = def('foe.recon', 'Recon', 'Reconnaissance craft', RECON) satisfies SpriteDef<'fly' | 'drift'>;
export const FOE_PICKET = def('foe.picket', 'Picket', 'Patrol fighter', PICKET) satisfies SpriteDef<'fly' | 'drift'>;
export const FOE_LANCER = def('foe.lancer', 'Lancer', 'Interceptor', LANCER) satisfies SpriteDef<'fly' | 'drift'>;
export const FOE_HAULER = def('foe.hauler', 'Hauler', 'Cargo raider', HAULER) satisfies SpriteDef<'fly' | 'drift'>;
export const FOE_HEAVY = def('foe.heavy', 'Heavy', 'Heavy combat ship', HEAVY) satisfies SpriteDef<'fly' | 'drift'>;
export const FOE_ELITE = def('foe.elite', 'Elite', 'Elite ship', ELITE) satisfies SpriteDef<'fly' | 'drift'>;
export const FOE_CAPITAL = def('foe.capital', 'Capital', 'Capital-class boss', CAPITAL) satisfies SpriteDef<'fly' | 'drift'>;

/** Every enemy hull in family order (also the authored rows, for the silhouette tests). */
export const FOE_SPRITES = [FOE_RAIDER, FOE_PICKET, FOE_LANCER, FOE_HEAVY, FOE_RECON, FOE_HAULER, FOE_ELITE, FOE_CAPITAL] as const;
