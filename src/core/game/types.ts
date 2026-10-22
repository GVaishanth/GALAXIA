/**
 * World model: plain mutable data owned by the engine and mutated by systems.
 * Coordinates are logical art px; times are simulation ms.
 */
import type { TransformKind } from '../../config/scoring.ts';
import type { StageKind } from '../../config/stages.ts';
import type { StageTuning } from '../../config/difficulty.ts';
import type { Rng } from '../rng.ts';
import type { Path } from '../systems/paths.ts';

export type EnemyKind = 'scout' | 'interceptor' | 'commander' | 'transform' | 'capturedFighter';

/** Per-enemy state machine (see core/systems/enemies.ts for transitions). */
export type EnemyState = 'entering' | 'formingUp' | 'inFormation' | 'attacking' | 'returning' | 'leaving' | 'destroyed';

/** What happens when an enemy reaches the end of its current path. */
export type PathEnd =
  | 'formUp' // fly to slot, then inFormation
  | 'exitThenReturn' // off the bottom: reappear at top and return to slot
  | 'returnToSlot' // fly back to slot directly
  | 'leave' // leave the playfield and be removed
  | 'beam' // stop and project the tractor beam
  | 'split'; // transform: replaced by its trio

export interface PathRun {
  readonly path: Path;
  s: number;
  speed: number;
  readonly end: PathEnd;
  /** Path distances at which to fire (consumed in order). */
  fireAt: number[];
}

export interface Slot {
  readonly id: string;
  readonly row: number;
  readonly col: number;
  readonly kind: 'scout' | 'interceptor' | 'commander';
  readonly group: string;
  readonly baseX: number;
  readonly baseY: number;
}

export type BeamPhase = 'extending' | 'holding' | 'retracting';

export interface Beam {
  phase: BeamPhase;
  t: number;
  /** Current length in art px from the commander's underside. */
  length: number;
  readonly maxLength: number;
  /** True once a fighter has been grabbed. */
  grabbed: boolean;
}

export type CaptiveMode = 'attached' | 'freed' | 'hostile';

export interface Enemy {
  readonly id: string;
  readonly kind: EnemyKind;
  readonly transformKind?: TransformKind;
  state: EnemyState;
  stateMs: number;
  slot: Slot | null;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** Unit heading for rendering (0, 1) = facing down. */
  dirX: number;
  dirY: number;
  run: PathRun | null;
  hp: number;
  /** Challenging Stage wave (0-based). */
  wave?: number;
  /** Transform trio id. */
  groupId?: string;
  /** Commander: escorts that launched with it. */
  escortsAtDiveStart?: number | undefined;
  /** Escort: id of its commander. */
  leaderId?: string | undefined;
  beam?: Beam | undefined;
  /** Commander holding a captive. */
  captiveId?: string | undefined;
  /** capturedFighter only. */
  fighterId?: string;
  captorId?: string | undefined;
  captiveMode?: CaptiveMode;
  /** Ticks this enemy was hit (render flash). */
  hitFlashMs: number;
}

export type PlayerState = 'alive' | 'exploding' | 'tractored' | 'gone';

export interface Player {
  state: PlayerState;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  vx: number;
  dual: boolean;
  /** Id of the ship in play (f1, f2, ...). */
  fighterId: string;
  fighterSeq: number;
  tractorCaptorId: string | null;
  /** True when the ship just lost was the last one. */
  lastShipLost: boolean;
}

export interface Shot {
  readonly id: number;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  readonly vx: number;
  readonly vy: number;
}

export type EffectKind = 'enemyExplosion' | 'playerExplosion' | 'hitSpark';

export interface Effect {
  readonly kind: EffectKind;
  readonly x: number;
  readonly y: number;
  ageMs: number;
  readonly durationMs: number;
}

export interface EntrySpawn {
  readonly atMs: number;
  readonly slotId: string;
  readonly pathKey: string;
}

export interface FormationState {
  timeMs: number;
  mode: 'sway' | 'breathe';
  /** Phase clocks (ms) for sway and breathe. */
  swayMs: number;
  breatheMs: number;
  entryClockMs: number;
  entryQueue: EntrySpawn[];
  entryComplete: boolean;
}

export interface ChallengeState {
  clockMs: number;
  queue: { atMs: number; kind: 'scout' | 'interceptor' | 'commander' | TransformKind; pathKey: string; wave: number }[];
  spawned: number;
  resolved: number;
  total: number;
  ended: boolean;
}

/**
 * Weapon heat (TD-74): holding fire keeps firing, but a long hold overheats
 * the weapon and locks it until it cools. Taps never heat it.
 */
export interface WeaponHeat {
  /** 0 (cold) .. 1 (overheated). */
  level: number;
  /** Locked: no shots until the level falls to ENGINE.heat.resumeAt. */
  overheated: boolean;
  /** How long fire has been held without a break (ms). */
  heldMs: number;
  /** Time left until the next hold-to-fire shot (ms). */
  autoMs: number;
}

export interface World {
  tick: number;
  timeMs: number;
  stage: number;
  stageKind: StageKind;
  tuning: StageTuning;
  player: Player;
  enemies: Enemy[];
  playerShots: Shot[];
  enemyShots: Shot[];
  effects: Effect[];
  slots: readonly Slot[];
  formation: FormationState;
  challenge: ChallengeState | null;
  attackTimerMs: number;
  transformsLaunched: number;
  /** Enemy fire is held until this time (after a diving commander dies). */
  fireHoldUntilMs: number;
  /** The player's weapon heat (hold-to-fire, TD-74). */
  heat: WeaponHeat;
  /** A hostile captive that escaped; re-attached next normal stage. */
  pendingRebound: string | null;
  nextId: number;
  readonly rng: Rng;
}
