/**
 * Enemy ship families (Free Roam Prompt 9): geometry (sprite), gameplay role,
 * stats, weapons and the tactical parameters the AI reads. Pure, typed
 * balance data: AI, combat and UI read these values and hard-code none.
 *
 * Roles (combat/ai.ts implements the tactic of each):
 *   raider   light raider     orbits its target in packs and pecks with sparks; never retreats
 *   picket   patrol fighter   flies the patrol route, holds medium range and strafes; regroups when hurt
 *   lancer   interceptor      fastest hull: charges straight in with twin lances, breaks away, repeats
 *   heavy    heavy combat     slow armour: keeps its distance and fires a telegraphed siege cannon, flak up close
 *   recon    reconnaissance   keeps far away, calls every ally in range to the pilot, flees when approached
 *   hauler   cargo raider     strips wrecks and salvage, lays mines behind it and runs when shot
 *   elite    elite ship       named ace: orbits, dodges incoming fire, mixes lances and seeker missiles
 *   capital  boss / capital   huge and slow: broadsides, launches raiders; below half hull adds beam and missiles
 *
 * Damage states: the shield absorbs first (a bubble flare on the struck
 * side), then the hull; below `wornAt` of its hull a ship switches to its
 * faction's worn palette and trails smoke and sparks; `disableAt` knocks some
 * families' systems out for `disableTicks` (drifting, no fire); destruction
 * breaks the sprite apart over a burst sized by `size`.
 */
import type { WeaponId } from './weapons.ts';

export const FAMILY_IDS = ['raider', 'picket', 'lancer', 'heavy', 'recon', 'hauler', 'elite', 'capital'] as const;
export type FamilyId = (typeof FAMILY_IDS)[number];

export interface FamilyDef {
  readonly id: FamilyId;
  readonly label: string;
  readonly role: string;
  readonly sprite: `foe.${FamilyId}`;
  readonly hull: number;
  readonly shield: number;
  /** Shield regeneration per second, after `regenDelay` ticks without a hit. */
  readonly shieldRegen: number;
  readonly regenDelay: number;
  readonly speed: number;
  readonly accel: number;
  /** Facing turn rate (rad/s). */
  readonly turn: number;
  /** Collision and hit radius (art px). */
  readonly radius: number;
  /** Sight range: hostile targets inside it are noticed. */
  readonly detect: number;
  /** Switches from pursue to attack inside this range. */
  readonly engage: number;
  /** Preferred distance while attacking (orbit / stand-off radius). */
  readonly prefer: number;
  /** Weapons in priority order (the first usable one fires). */
  readonly weapons: readonly WeaponId[];
  /** Retreats at or below this hull fraction (0 = never). */
  readonly retreatAt: number;
  /** Systems knocked out at or below this hull fraction, once (0 = never). */
  readonly disableAt: number;
  readonly disableTicks: number;
  /** Chance to evade after being hit, evade duration and cooldown (ticks). */
  readonly evadeChance: number;
  readonly evadeTicks: number;
  readonly evadeCooldown: number;
  /** Dodges incoming player bolts when its evade is ready (elites). */
  readonly dodges: boolean;
  /** Ramming damage to the pilot. */
  readonly contact: number;
  /** Below this hull fraction the ship shows its worn (damaged) look. */
  readonly wornAt: number;
  /** Destruction burst size (1 small .. 4 capital). */
  readonly size: 1 | 2 | 3 | 4;
  /** Budget weight for wave composition (combat/difficulty.ts). */
  readonly threat: number;
}

/**
 * Light-ship recovery (Combat P03 FR-TD-85; retuned in Combat P03C FR-TD-89).
 * Measured: what kept weak ships alive was shield regeneration in the lulls a
 * pilot leaves while dodging, plus the seeded evade roll after each hit.
 * Families at or below `lightThreat` (raider, picket, lancer, recon, hauler):
 *  - wait `lightRegenDelayMul` times as long after a hit before recharging
 *    (P03: x2 -> P03C: x3);
 *  - recharge at `lightRegenMul` of their base rate (P03: x1 -> P03C: x0.5);
 *  - break away after a hit with `lightEvadeMul` of their base chance
 *    (P03: x1 -> P03C: x0.6).
 * Hull, shield size, speed, weapons, retreat and disable (which always
 * recovers) are unchanged, so none is ever helpless; heavy, elite and capital
 * ships (threat > 2) are untouched and keep their roles. The table below keeps
 * the base values; FAMILIES holds the effective ones.
 */
export const RECOVERY = Object.freeze({ lightThreat: 2, lightRegenDelayMul: 3, lightRegenMul: 0.5, lightEvadeMul: 0.6 });

const F = (d: FamilyDef): FamilyDef =>
  Object.freeze(
    d.threat <= RECOVERY.lightThreat
      ? { ...d, regenDelay: Math.round(d.regenDelay * RECOVERY.lightRegenDelayMul), shieldRegen: d.shieldRegen * RECOVERY.lightRegenMul, evadeChance: d.evadeChance * RECOVERY.lightEvadeMul }
      : d,
  );

export const FAMILIES: Readonly<Record<FamilyId, FamilyDef>> = Object.freeze({
  raider: F({ id: 'raider', label: 'Raider', role: 'Light raider', sprite: 'foe.raider', hull: 18, shield: 0, shieldRegen: 0, regenDelay: 120, speed: 250, accel: 700, turn: 6, radius: 8, detect: 420, engage: 320, prefer: 150, weapons: ['spark'], retreatAt: 0, disableAt: 0, disableTicks: 0, evadeChance: 0.25, evadeTicks: 30, evadeCooldown: 120, dodges: false, contact: 6, wornAt: 0.5, size: 1, threat: 1 }),
  picket: F({ id: 'picket', label: 'Picket', role: 'Patrol fighter', sprite: 'foe.picket', hull: 30, shield: 15, shieldRegen: 3, regenDelay: 150, speed: 215, accel: 560, turn: 4.5, radius: 10, detect: 480, engage: 360, prefer: 230, weapons: ['spark-burst'], retreatAt: 0.2, disableAt: 0, disableTicks: 0, evadeChance: 0.15, evadeTicks: 36, evadeCooldown: 150, dodges: false, contact: 8, wornAt: 0.45, size: 2, threat: 1.5 }),
  lancer: F({ id: 'lancer', label: 'Lancer', role: 'Interceptor', sprite: 'foe.lancer', hull: 26, shield: 20, shieldRegen: 4, regenDelay: 150, speed: 330, accel: 900, turn: 5, radius: 10, detect: 560, engage: 420, prefer: 0, weapons: ['twin-lance'], retreatAt: 0, disableAt: 0, disableTicks: 0, evadeChance: 0, evadeTicks: 50, evadeCooldown: 0, dodges: false, contact: 10, wornAt: 0.45, size: 2, threat: 2 }),
  heavy: F({ id: 'heavy', label: 'Heavy', role: 'Heavy combat ship', sprite: 'foe.heavy', hull: 90, shield: 50, shieldRegen: 5, regenDelay: 180, speed: 150, accel: 320, turn: 2.2, radius: 13, detect: 520, engage: 560, prefer: 320, weapons: ['flak', 'cannon'], retreatAt: 0, disableAt: 0.15, disableTicks: 150, evadeChance: 0, evadeTicks: 0, evadeCooldown: 0, dodges: false, contact: 16, wornAt: 0.4, size: 3, threat: 4 }),
  recon: F({ id: 'recon', label: 'Recon', role: 'Reconnaissance craft', sprite: 'foe.recon', hull: 16, shield: 10, shieldRegen: 4, regenDelay: 120, speed: 280, accel: 700, turn: 5, radius: 8, detect: 760, engage: 600, prefer: 520, weapons: ['spark'], retreatAt: 0.5, disableAt: 0.3, disableTicks: 240, evadeChance: 0.4, evadeTicks: 40, evadeCooldown: 90, dodges: false, contact: 4, wornAt: 0.5, size: 1, threat: 1 }),
  hauler: F({ id: 'hauler', label: 'Hauler', role: 'Cargo raider', sprite: 'foe.hauler', hull: 70, shield: 30, shieldRegen: 3, regenDelay: 180, speed: 160, accel: 360, turn: 2.5, radius: 12, detect: 420, engage: 360, prefer: 260, weapons: ['mine', 'spark'], retreatAt: 0.5, disableAt: 0.2, disableTicks: 240, evadeChance: 0, evadeTicks: 0, evadeCooldown: 0, dodges: false, contact: 12, wornAt: 0.45, size: 3, threat: 2 }),
  elite: F({ id: 'elite', label: 'Elite', role: 'Elite ship', sprite: 'foe.elite', hull: 140, shield: 90, shieldRegen: 8, regenDelay: 150, speed: 290, accel: 800, turn: 5.5, radius: 13, detect: 640, engage: 460, prefer: 220, weapons: ['missile', 'twin-lance'], retreatAt: 0.3, disableAt: 0, disableTicks: 0, evadeChance: 0.2, evadeTicks: 28, evadeCooldown: 90, dodges: true, contact: 14, wornAt: 0.4, size: 3, threat: 8 }),
  capital: F({ id: 'capital', label: 'Capital', role: 'Capital-class boss', sprite: 'foe.capital', hull: 600, shield: 250, shieldRegen: 6, regenDelay: 240, speed: 70, accel: 120, turn: 0.6, radius: 24, detect: 800, engage: 620, prefer: 380, weapons: ['beam', 'missile', 'launch', 'broadside'], retreatAt: 0, disableAt: 0, disableTicks: 0, evadeChance: 0, evadeTicks: 0, evadeCooldown: 0, dodges: false, contact: 30, wornAt: 0.5, size: 4, threat: 30 }),
});

/** Capital ship: below this hull fraction it adds its beam and missiles (phase two). */
export const CAPITAL_PHASE_TWO = 0.5;
/** Weapons a capital ship only uses in phase two. */
export const PHASE_TWO_WEAPONS: readonly WeaponId[] = ['beam', 'missile'];
/** Launch bay: total ships one capital may launch in a visit. */
export const CAPITAL_LAUNCH_TOTAL = 8;
