/**
 * Enemy weapons (Free Roam Prompt 9). Pure, typed balance data; the player's
 * weapons stay in ships/equipment.ts. Times are fixed 60 Hz ticks, distances
 * art px, speeds art px/s. Every projectile has a finite life (validated
 * against COMBAT.maxShotLife / maxMineLife), so nothing persists forever.
 *
 * Telegraphs (how a dangerous attack warns the pilot before it lands):
 *   none   small, fast, frequent fire: the muzzle flash is the warning
 *   aim    a dashed aim line from the shooter, locked for `windup` ticks
 *   lock   a lock-on bracket on the pilot + MISSILE LOCK banner
 *   band   a translucent beam band that brightens until it fires
 *   blink  a mine's trigger ring blinks faster until it blows
 *   bay    the capital ship's launch bay glows before ships come out
 */

export const WEAPON_IDS = ['spark', 'spark-burst', 'twin-lance', 'cannon', 'flak', 'missile', 'beam', 'broadside', 'mine', 'launch'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

export type WeaponKind = 'bolt' | 'shell' | 'missile' | 'beam' | 'mine' | 'launch';
export type Telegraph = 'none' | 'aim' | 'lock' | 'band' | 'blink' | 'bay';

export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  readonly kind: WeaponKind;
  readonly telegraph: Telegraph;
  /** Damage per projectile (mine / missile: per detonation; beam: once per firing per target). */
  readonly damage: number;
  /** Projectile speed. */
  readonly speed: number;
  /** Projectile life (ticks). */
  readonly life: number;
  /** Ticks between attacks (after the windup and burst). */
  readonly cooldown: number;
  /** Telegraph duration before the attack lands (ticks). 0 = no telegraph. */
  readonly windup: number;
  /** Shots per burst and ticks between them. */
  readonly burst: number;
  readonly burstGap: number;
  /** Projectiles per shot and their total fan (radians). */
  readonly pellets: number;
  readonly spread: number;
  /** Twin barrels: sideways offset of the two bolts (0 = single). */
  readonly twin: number;
  /** Maximum firing range. */
  readonly range: number;
  /** Fire only when facing the target within this angle (radians). */
  readonly arc: number;
  /** Projectile hit radius. */
  readonly radius: number;
  /** Missiles: turn rate (rad/s) and hit points (the pilot can shoot them down). */
  readonly turn: number;
  readonly hp: number;
  /** Mines: blast radius, trigger radius, arming delay and fuse (ticks), live cap per layer. */
  readonly blast: number;
  readonly trigger: number;
  readonly arm: number;
  readonly fuse: number;
  readonly maxLive: number;
  /** Beams: length, half-width, sweep (radians, total) and active ticks. */
  readonly length: number;
  readonly width: number;
  readonly sweep: number;
  readonly active: number;
}

const base = {
  burst: 1, burstGap: 0, pellets: 1, spread: 0, twin: 0, arc: 0.3, radius: 3, turn: 0, hp: 0,
  blast: 0, trigger: 0, arm: 0, fuse: 0, maxLive: 0, length: 0, width: 0, sweep: 0, active: 0, windup: 0, telegraph: 'none' as Telegraph,
};

export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = Object.freeze({
  spark: { ...base, id: 'spark', name: 'Spark gun', kind: 'bolt', damage: 5, speed: 420, life: 90, cooldown: 70, range: 420, arc: 0.35 },
  'spark-burst': { ...base, id: 'spark-burst', name: 'Burst sparker', kind: 'bolt', damage: 4, speed: 440, life: 90, cooldown: 110, burst: 3, burstGap: 7, range: 460 },
  'twin-lance': { ...base, id: 'twin-lance', name: 'Twin lance', kind: 'bolt', damage: 7, speed: 560, life: 70, cooldown: 80, twin: 7, range: 380, arc: 0.25 },
  cannon: { ...base, id: 'cannon', name: 'Siege cannon', kind: 'shell', telegraph: 'aim', damage: 18, speed: 280, life: 150, cooldown: 170, windup: 42, range: 560, arc: 0.4, radius: 7 },
  flak: { ...base, id: 'flak', name: 'Flak scatter', kind: 'bolt', telegraph: 'aim', damage: 4, speed: 360, life: 40, cooldown: 120, windup: 24, pellets: 5, spread: 0.5, range: 190, arc: 0.6, radius: 3 },
  missile: { ...base, id: 'missile', name: 'Seeker missile', kind: 'missile', telegraph: 'lock', damage: 14, speed: 230, life: 210, cooldown: 260, windup: 45, range: 650, arc: Math.PI, radius: 5, turn: 2.2, hp: 1 },
  beam: { ...base, id: 'beam', name: 'Sweep beam', kind: 'beam', telegraph: 'band', damage: 22, speed: 0, life: 0, cooldown: 330, windup: 60, range: 520, arc: 0.5, length: 520, width: 12, sweep: 0.7, active: 24 },
  broadside: { ...base, id: 'broadside', name: 'Broadside battery', kind: 'shell', telegraph: 'aim', damage: 12, speed: 300, life: 140, cooldown: 200, windup: 40, pellets: 3, spread: 0.25, range: 520, arc: 0.7, radius: 6 },
  mine: { ...base, id: 'mine', name: 'Mine dropper', kind: 'mine', telegraph: 'blink', damage: 22, speed: 0, life: 1200, cooldown: 150, range: 520, arc: Math.PI, radius: 6, blast: 70, trigger: 90, arm: 45, fuse: 50, maxLive: 3 },
  launch: { ...base, id: 'launch', name: 'Launch bay', kind: 'launch', telegraph: 'bay', damage: 0, speed: 0, life: 0, cooldown: 360, windup: 50, range: 900, arc: Math.PI, maxLive: 4 },
});

