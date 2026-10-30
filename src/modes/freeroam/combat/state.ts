/**
 * Temporary combat entities of one sector visit (Free Roam Prompt 9). They
 * live on the SectorRun, exist only while the sector is loaded and are all
 * dropped by disposeSectorRun(); nothing here is ever saved.
 */
import type { FactionId } from '../catalogue/types.ts';
import type { EncounterKind } from '../sector/model.ts';
import type { FamilyId } from './families.ts';
import type { WeaponId } from './weapons.ts';

/**
 * Explicit AI states (combat/ai.ts documents every transition):
 *  idle         holds position at its post (guards, sleeping escorts)
 *  patrol       flies its route, or returns to its post
 *  investigate  flies to a last-known contact / alarm and searches it
 *  pursue       closes on a target it can see
 *  attack       fights inside engagement range with its family's tactic
 *  evade        jinks or breaks off after a hit or a charge pass
 *  retreat      runs from the fight (hurt, recon spotted, cargo raider shot)
 *  disabled     systems knocked out: drifts, cannot fire, still takes damage
 *  destroyed    terminal: removed at the end of the tick
 */
export const AI_STATES = ['idle', 'patrol', 'investigate', 'pursue', 'attack', 'evade', 'retreat', 'disabled', 'destroyed'] as const;
export type AiState = (typeof AI_STATES)[number];

/** What a ship is shooting at: the pilot, or another ship (by id). */
export type Target = 'player' | number;

/** How a ship joined the sector (drives its idle behaviour and despawning). */
export type AgentRole = 'patrol' | 'guard' | 'wave' | 'boss' | 'launched';

export interface Windup {
  /** Index into the family's weapon list. */
  readonly slot: number;
  readonly weapon: WeaponId;
  ticks: number;
  readonly total: number;
  /** Locked firing angle (world radians, 0 = +x) for aimed telegraphs. */
  angle: number;
}

export interface BeamState {
  readonly start: number;
  readonly sweep: number;
  ticks: number;
  readonly total: number;
  /** Angle this tick (world radians). */
  angle: number;
  /** Targets this firing already hit: a beam damages each target once per firing. */
  readonly hit: Set<Target>;
}

export interface Agent {
  readonly id: number;
  readonly family: FamilyId;
  readonly faction: FactionId;
  /** Patrol id, installation POI id or encounter site id. */
  readonly source: string;
  readonly role: AgentRole;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing (radians, 0 = nose up, clockwise), as the player ship. */
  heading: number;
  /** Combat P03C local time dilation (combat/dilation.ts): step accumulator and the scale it ran at (absent = normal time). */
  tacc?: number;
  tscale?: number;
  px: number;
  py: number;
  pheading: number;
  hull: number;
  shield: number;
  readonly maxHull: number;
  readonly maxShield: number;
  sinceHit: number;
  state: AiState;
  stateTicks: number;
  target: Target | null;
  /** Last known target position (investigate). */
  lastSeen: { x: number; y: number } | null;
  /** P09.1: tick of this ship's last heat-counted player hit (combat/factionHeat.ts). */
  heatAt?: number;
  /** Post: patrol waypoint index / guard position. */
  waypoint: number;
  readonly homeX: number;
  readonly homeY: number;
  /** Cooldown per weapon slot (ticks). */
  readonly cooldowns: number[];
  /** Ticks until it may fire at a newly acquired target. */
  reaction: number;
  /** Ticks since it appeared. */
  age: number;
  windup: Windup | null;
  burstLeft: number;
  burstTimer: number;
  burstSlot: number;
  beam: BeamState | null;
  evadeCooldown: number;
  /** Evade / strafe direction (+1 / -1), seeded. */
  side: 1 | -1;
  /** Seeded per-ship variation (0..1): preferred range, timings. */
  readonly trait: number;
  /** One-time transitions already used (so a ship cannot loop through them). */
  disabledUsed: boolean;
  retreatUsed: boolean;
  /** Recon: has already called its allies. Capital: phase two reached. */
  called: boolean;
  phase2: boolean;
  /** Capital: ships launched in this visit. */
  launched: number;
  /** Ticks of hit flash (presentation). */
  flash: number;
  /** Ticks continuously seeing its target (recon call). */
  seen: number;
  /** P07.1 contact memory: AI steps since the pilot was last observed while the contact is held (0 = in sight or no contact). */
  lost: number;
  /** P07.2 Gravity Shadow: at the last AI step the pilot was within this ship's acquisition range but a celestial body blocked its sight (the AI's own result; presentation reads it). */
  shadow: boolean;
}

export type ShotKind = 'bolt' | 'shell' | 'missile';

export interface EnemyShot {
  readonly id: number;
  readonly owner: number;
  readonly faction: FactionId;
  readonly weapon: WeaponId;
  readonly kind: ShotKind;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  life: number;
  readonly damage: number;
  readonly radius: number;
  /** Missiles: what they home on, and their hit points (player bolts shoot them down). */
  readonly target: Target | null;
  hp: number;
}

export interface Mine {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly faction: FactionId;
  /** Hazard zone id (field mine) or agent id (dropped mine). */
  readonly owner: string | number;
  /** Ticks until armed. */
  arm: number;
  /** Ticks until detonation once triggered; -1 = not triggered. */
  fuse: number;
  /** Ticks left (dropped mines); field mines last for the visit (Infinity). */
  life: number;
}

export interface Pending {
  /** Run tick at which the ship materialises (the warp marker shows until then). */
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly family: FamilyId;
  readonly faction: FactionId;
  readonly source: string;
  readonly role: AgentRole;
  readonly heading: number;
  /** Post override (wreck-defence cargo raiders guard the wreck they strip). */
  readonly home?: { readonly x: number; readonly y: number } | undefined;
}

export type EncounterState = 'dormant' | 'warning' | 'active' | 'done' | 'failed';

export interface EncounterRuntime {
  /** Installation POI id or site id. */
  readonly id: string;
  readonly kind: EncounterKind;
  state: EncounterState;
  /** Ticks in the current state. */
  ticks: number;
  /** Waves spawned and ships spawned in total (waves refused at the cap still count). */
  waves: number;
  spawned: number;
  /** Defence: hold time left and the wreck's integrity; others unused. */
  holdLeft: number;
  integrity: number;
  /** The pilot damaged one of its ships (disputes only pay a pilot who fought). */
  engaged: boolean;
  /** Guards woken (elite / capital / dispute ships exist). */
  awake: boolean;
}

/** Overall combat situation for the HUD and the docking / ship-switch rules. */
export type CombatLevel = 'calm' | 'alert' | 'engaged';
