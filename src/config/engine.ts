/**
 * Engine tuning: timing, player, shots, hitboxes, capture. All units are
 * logical art px (448 x 576 playfield) and milliseconds / seconds as named.
 * Stage-dependent values (attack rate, speeds) live in difficulty.ts.
 */
import { deepFreeze } from './freeze.ts';

export interface Box {
  readonly w: number;
  readonly h: number;
}

export const ENGINE = deepFreeze({
  /** Fixed simulation rate (TD-04). */
  tickHz: 60,
  /** Largest real frame gap fed to the simulation; longer gaps are dropped (no huge catch-up). */
  maxFrameMs: 100,
  world: { width: 448, height: 576 },

  player: {
    y: 536,
    /** Movement: 'direct' = constant speed while held (arcade), 'accel' = eased. */
    movement: 'direct' as 'direct' | 'accel',
    speed: 210,
    accel: 1800,
    decel: 2600,
    minX: 16,
    maxX: 432,
    /** Dual Fighter: each half sits this far from the pair centre. */
    dualHalfOffset: 15,
    dualMinX: 31,
    dualMaxX: 417,
    hitbox: { w: 16, h: 20 } as Box,
    /** Explosion before respawn checks begin. */
    respawnDelayMs: 1500,
    /** Upper bound on waiting for attackers to return before respawning anyway. */
    maxRespawnWaitMs: 7000,
    readyMs: 1500,
  },

  /**
   * Hold-to-fire and weapon heat (TD-74, requested by the owner). A press
   * still fires at once, exactly as before. Holding fire keeps firing every
   * autoIntervalMs, still capped by the shots-on-screen limit below. A hold
   * longer than graceMs heats the weapon (taps never do). A full heat bar
   * overheats it: no shots until it cools back to resumeAt.
   */
  heat: {
    autoIntervalMs: 160,
    graceMs: 300,
    /** Continuous hold after the grace: cold to overheated (ms). 2800 -> 6000 at the owner's request (about 6.3 s of holding in total). */
    riseMs: 6000,
    /** Fire released, or locked: overheated to cold (ms). */
    coolMs: 1600,
    resumeAt: 0.3,
  },

  shots: {
    playerSpeed: 720,
    /** Original-style limit: two player shots on screen (single fighter). */
    maxSingle: 2,
    /** Dual Fighter fires pairs: two pairs on screen. */
    maxDual: 4,
    spawnOffsetY: -16,
    playerBox: { w: 4, h: 10 } as Box,
    enemyBox: { w: 4, h: 8 } as Box,
    /** Enemy shots never go steeper sideways than this fraction of their speed. */
    enemyMaxSlope: 0.35,
    /** Enemies do not fire when closer than this (vertically) to the player row. */
    enemyMinFireGap: 70,
  },

  hitboxes: {
    scout: { w: 20, h: 14 },
    interceptor: { w: 22, h: 16 },
    commander: { w: 26, h: 22 },
    transform: { w: 22, h: 18 },
    capturedFighter: { w: 18, h: 20 },
  } as Readonly<Record<'scout' | 'interceptor' | 'commander' | 'transform' | 'capturedFighter', Box>>,

  commanderHits: 2,

  capture: {
    enabled: true,
    minStage: 1,
    /** Commander stops at player.y - this to project the beam. */
    beamStopAbove: 228,
    extendMs: 900,
    holdMs: 2200,
    retractMs: 700,
    /** Player centre must be within this horizontal distance of the beam axis. */
    captureHalfWidth: 20,
    /** Pull-up speed of a tractored fighter. */
    pullSpeed: 110,
    /** Captive sits this far above its captor. */
    captiveOffsetY: -30,
    /** Freed fighter: hover, then fly to dock. */
    freedHoverMs: 600,
    dockSpeed: 170,
    /** Enemy shots pause briefly after a diving commander is destroyed (original behaviour). */
    fireHoldAfterCommanderMs: 600,
  },

  stage: {
    /** Pause after the last enemy before the next stage. */
    clearDelayMs: 1600,
    /** Challenging Stage result display before the next stage. */
    challengeResultMs: 3800,
    /** READY / stage intro before play starts. */
    introMs: 1800,
    gameOverMs: 4000,
  },

  /** Enemy flight speeds when not set by difficulty. */
  formingUpSpeed: 200,
  /**
   * Dive scripts keep every Bezier control point at least this far inside the
   * left/right edges, so (by the convex-hull property) a diver never leaves the
   * playfield sideways. Bottom exits and top re-entries are unaffected (Stage 6).
   */
  diveMarginX: 16,
});

export type EngineConfig = typeof ENGINE;
