/**
 * HUD layout, labels and notification timing. Presentation only: changing
 * anything here never affects scoring or simulation.
 *
 * Bands are in art px of the 448x576 playfield. Gameplay keeps out of them:
 * the formation's top row (with a captured fighter above it) starts below
 * topBand, and the player ship's lowest pixel sits above the bottom band.
 */
import { deepFreeze } from './freeze.ts';

export const HUD_LAYOUT = deepFreeze({
  /** Top band (scores + ticker). */
  topBand: 40,
  /** Bottom band (reserve ships + stage). */
  bottomBand: 20,
  /** Lowest art-px y any formation slot may use (captive drawn above commander row). */
  formationTopLimit: 44,
  /** Highest art-px y the player ship's bottom edge may reach. */
  playerBottomLimit: 556,
  /** Reserve icons drawn before switching to "+N". */
  maxReserveIcons: 6,
  /** Score pop-ups only for awards at or above this many points. */
  popupMinPoints: 400,
  /** Simultaneous pop-ups; older ones are dropped. */
  maxPopups: 6,
  /** Stage insignia icons drawn before the row is truncated. */
  maxBadgeIcons: 10,
});

export const HUD_LABELS = deepFreeze({
  /** Top-left label over the player's score (TD-80: the game's name, formerly '1UP'). */
  player: 'GALAXIA',
  highScore: 'HIGH SCORE',
  stage: 'STAGE',
  challenge: 'CHALLENGE',
  extraLife: 'EXTRA FIGHTER',
  newHighScore: 'NEW HIGH SCORE',
  captured: 'FIGHTER CAPTURED',
  freed: 'FIGHTER FREED',
  rescued: 'TWIN FIGHTER',
  captiveLost: 'CAPTIVE LOST',
  waveBonus: 'WAVE BONUS',
  setBonus: 'SET BONUS',
  hits: 'HITS',
  bonus: 'BONUS',
  perfect: 'PERFECT',
  gameOver: 'GAME OVER',
  challengingStage: 'CHALLENGING STAGE',
  dual: 'TWIN',
  single: 'SINGLE',
  paused: 'PAUSED',
});

/** Durations in ms. Blink = on/off half-period. lineDelay = stagger between lines. */
export const HUD_TIMING = deepFreeze({
  ticker: { durationMs: 1800, blinkMs: 0 },
  extraLife: { durationMs: 2400, blinkMs: 200 },
  newHighScore: { durationMs: 1800, blinkMs: 0 },
  popup: { durationMs: 900, blinkMs: 0 },
  stageIntro: { durationMs: 1600, blinkMs: 0 },
  captured: { durationMs: 2000, blinkMs: 0 },
  challengeResult: { durationMs: 3600, blinkMs: 0, lineDelayMs: 700 },
  perfect: { durationMs: 3600, blinkMs: 250, lineDelayMs: 700 },
  gameOver: { durationMs: 3000, blinkMs: 0 },
  /** CSS fade for entering/leaving notifications (kept short; never delays play). */
  fadeMs: 120,
  /** Score digits briefly highlight after a change. */
  scoreFlashMs: 160,
});

/** Stage insignia denominations, largest first (art: assets/insignia.ts, Stage 4). */
export const STAGE_BADGE_VALUES: readonly number[] = Object.freeze([50, 30, 20, 10, 5, 1]);
