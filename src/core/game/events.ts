/**
 * Engine events for presentation and audio (render effects, sounds, HUD).
 * Scoring decisions are NOT here: they go through the RewardManager.
 */
import type { EnemyKind } from './types.ts';
import type { GamePhase } from './stateMachine.ts';

export type GameEvent =
  | { readonly type: 'phaseChanged'; readonly from: GamePhase; readonly to: GamePhase }
  | { readonly type: 'stageStarted'; readonly stage: number; readonly challenge: boolean }
  | { readonly type: 'playerShot'; readonly x: number; readonly y: number }
  | { readonly type: 'enemyShot'; readonly x: number; readonly y: number }
  | { readonly type: 'enemyHit'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly type: 'enemyDestroyed'; readonly id: string; readonly kind: EnemyKind; readonly x: number; readonly y: number }
  | { readonly type: 'playerDestroyed'; readonly x: number; readonly y: number; readonly dualHalf: boolean }
  | { readonly type: 'beamStarted'; readonly captorId: string }
  | { readonly type: 'fighterTractored'; readonly captorId: string }
  | { readonly type: 'fighterCaptured'; readonly fighterId: string; readonly captorId: string }
  | { readonly type: 'captiveFreed'; readonly fighterId: string }
  | { readonly type: 'dualFighterFormed'; readonly fighterId: string }
  | { readonly type: 'attackLaunched'; readonly pattern: string; readonly ids: readonly string[] }
  | { readonly type: 'stageCleared'; readonly stage: number }
  | { readonly type: 'gameOver' }
  // Stage 4 presentation events (additive; they never feed back into the simulation)
  /** An enemy settled into its formation slot (after entry or a return flight). */
  | { readonly type: 'enemyArrived'; readonly id: string; readonly kind: EnemyKind; readonly x: number; readonly y: number }
  /** A tractor beam finished (retracted, or vanished because its captor was destroyed). */
  | { readonly type: 'beamEnded'; readonly captorId: string; readonly captured: boolean }
  /** A captured fighter turned hostile (rescue impossible). */
  | { readonly type: 'captiveHostile'; readonly fighterId: string; readonly x: number; readonly y: number }
  /** A scout split into a transform trio. */
  | { readonly type: 'transformSplit'; readonly x: number; readonly y: number; readonly ids: readonly string[] }
  /** A fresh fighter was placed after a loss. */
  | { readonly type: 'playerRespawned'; readonly x: number; readonly y: number }
  /** Held fire overheated the weapon (TD-74): it is locked until it cools. */
  | { readonly type: 'weaponOverheated' }
  /** The overheated weapon cooled enough to fire again. */
  | { readonly type: 'weaponCooled' };
