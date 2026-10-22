/**
 * Reward contract.
 *
 * GameplayFact = what the engine observed (input). The engine never states a
 * score; it reports conditions (kind, phase, escorts, rescue steps).
 * RewardEvent  = what the reward manager decided (output), consumed
 * independently by HUD, audio, statistics and persistence.
 */
import type { TransformKind } from '../../config/scoring.ts';
import type { StageKind } from '../../config/stages.ts';

/** Where an enemy was when destroyed. In Challenging Stages phase is ignored (all targets are attacking). */
export type EnemyPhase = 'formation' | 'entering' | 'attacking';

export interface Point {
  readonly x: number;
  readonly y: number;
}

interface KillBase {
  readonly type: 'enemyDestroyed';
  /** Unique within a stage. Re-reporting the same id is rejected (no double awards). */
  readonly enemyId: string;
  readonly phase: EnemyPhase;
  /** Challenging Stage wave index (0-based). Required in Challenging Stages, ignored elsewhere. */
  readonly wave?: number;
  /** Optional playfield position for score pop-ups (art px). */
  readonly position?: Point;
}

export type EnemyDestroyedFact =
  | (KillBase & { readonly kind: 'scout' | 'interceptor' | 'challengeSpecial' })
  | (KillBase & {
      readonly kind: 'commander';
      /** Escorts that launched with this commander's attack (0-2). */
      readonly escortsAtDiveStart?: number;
      /** Escorts still alive at the moment of the kill (0-2). */
      readonly escortsAlive?: number;
      /** Set if this commander was holding a captured fighter. Never grants a rescue by itself. */
      readonly holdingFighterId?: string;
    })
  | (KillBase & { readonly kind: 'capturedFighter'; readonly fighterId: string })
  | (KillBase & {
      readonly kind: 'transform';
      readonly transformKind: TransformKind;
      /** Transform group id (normal stages). Ignored in Challenging Stages. */
      readonly groupId?: string;
    });

export type CaptiveLossReason = 'player-lost-before-docking' | 'game-over';

export type GameplayFact =
  | { readonly type: 'stageStarted'; readonly stage: number }
  | EnemyDestroyedFact
  /** A transform group left or was cancelled before every member was destroyed. */
  | { readonly type: 'transformGroupEnded'; readonly groupId: string }
  | { readonly type: 'challengeStageEnded' }
  /** The tractor beam took the active fighter; it is now held by `captorId`. */
  | { readonly type: 'fighterCaptured'; readonly fighterId: string; readonly captorId: string }
  /** The captor was destroyed while attacking; the fighter is released and returning (not yet docked). */
  | { readonly type: 'captiveFreed'; readonly fighterId: string; readonly captorId: string }
  /** The released fighter has docked with the player ship. This is the rescue. */
  | { readonly type: 'captiveDocked'; readonly fighterId: string }
  /** The captor was destroyed in formation; the captive turns hostile. */
  | { readonly type: 'captiveTurnedHostile'; readonly fighterId: string; readonly captorId: string }
  /** A hostile captive that escaped returns held by a new captor (next stage). */
  | { readonly type: 'captiveRebound'; readonly fighterId: string; readonly captorId: string }
  | { readonly type: 'captiveLost'; readonly fighterId: string; readonly reason: CaptiveLossReason }
  /** Player ship destroyed. dualHalf=true: one half of a Dual Fighter was lost (no reserve used). */
  | { readonly type: 'playerFighterDestroyed'; readonly dualHalf: boolean }
  /** Variant modes only. Rejected in classic. Never awards points. */
  | { readonly type: 'powerUpCollected'; readonly powerUpId: string; readonly kind: string }
  | { readonly type: 'gameOver' };

export type ScoreSource =
  | 'enemy'
  | 'capturedFighter'
  | 'transformGroup'
  | 'challengeWave'
  | 'challengeResult'
  | 'rescue';

export type RescueOutcome =
  | { readonly status: 'freed' }
  | { readonly status: 'rescued' }
  | { readonly status: 'failed'; readonly reason: 'captive-destroyed' | 'captor-destroyed-in-formation' | CaptiveLossReason };

export type RewardEvent =
  | { readonly type: 'gameStarted'; readonly modeId: string; readonly reserves: number; readonly highScore: number }
  | { readonly type: 'stageChanged'; readonly stage: number; readonly kind: StageKind; readonly challengeNumber: number | null }
  | {
      readonly type: 'pointsAwarded';
      readonly source: ScoreSource;
      /** Points actually applied (can be lower than requested at the score cap). */
      readonly amount: number;
      readonly requested: number;
      readonly scoreAfter: number;
      readonly key: string;
      readonly enemyKind?: string;
      readonly phase?: EnemyPhase | 'challenge';
      readonly escorts?: number;
      readonly position?: Point;
    }
  | { readonly type: 'scoreChanged'; readonly score: number; readonly delta: number; readonly highScore: number }
  | { readonly type: 'highScoreBeaten'; readonly score: number; readonly previous: number }
  | { readonly type: 'extraLifeAwarded'; readonly index: number; readonly threshold: number; readonly reserves: number; readonly nextThreshold: number | null }
  | { readonly type: 'transformGroupCleared'; readonly groupId: string; readonly transformKind: TransformKind; readonly bonus: number }
  | { readonly type: 'challengeWaveCleared'; readonly stage: number; readonly wave: number; readonly bonus: number }
  | {
      readonly type: 'challengeStageResult';
      readonly stage: number;
      readonly challengeNumber: number;
      readonly hits: number;
      readonly total: number;
      readonly perfect: boolean;
      readonly perHitBonus: number;
      readonly perfectBonus: number;
      readonly bonus: number;
    }
  | { readonly type: 'fighterCaptured'; readonly fighterId: string; readonly captorId: string; readonly reserves: number }
  | {
      readonly type: 'rescue';
      /** The fighter this rescue step concerns. */
      readonly fighterId: string;
      readonly captorId: string | null;
      readonly outcome: RescueOutcome;
      /** True once the rescued fighter has docked (a second fighter is in play). */
      readonly secondFighterAvailable: boolean;
      readonly dualFighterActive: boolean;
      /** Points granted by this step (rescue bonus); 0 when none. */
      readonly bonus: number;
    }
  | { readonly type: 'dualFighterChanged'; readonly active: boolean }
  | { readonly type: 'reservesChanged'; readonly reserves: number; readonly delta: number }
  | { readonly type: 'powerUpCollected'; readonly powerUpId: string; readonly kind: string }
  | {
      readonly type: 'gameOver';
      readonly finalScore: number;
      readonly highScore: number;
      readonly newHighScore: boolean;
      readonly stage: number;
    };

export type RejectReason =
  | 'game-not-running'
  | 'no-stage'
  | 'invalid-fact'
  | 'duplicate'
  | 'wrong-stage-kind'
  | 'invalid-rescue-state'
  | 'power-ups-disabled';

export interface FactResult {
  readonly accepted: boolean;
  readonly reason?: RejectReason;
  readonly detail?: string;
  /** Events emitted for this fact, in emission order. */
  readonly events: readonly RewardEvent[];
}
