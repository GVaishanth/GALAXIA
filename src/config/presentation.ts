/**
 * Screen transitions and backdrop tuning (Stage 4). Presentation only.
 *
 * Transition rule: nothing here may cover the playfield during live attack
 * (playing / challenge). Fades and dims only run in phases where the engine is
 * itself changing state (boot, title, ready, stage clear, pause, game over).
 */
import { deepFreeze } from './freeze.ts';
import type { ColorRole } from './palette.ts';

export const TRANSITIONS = deepFreeze({
  /** Boot -> title: fade in from black. */
  bootFadeMs: 600,
  /** Title -> game: title art fades while the field fades in from black. */
  titleOutMs: 320,
  gameInFadeMs: 420,
  /** Restart after game over: same fade-in. */
  restartFadeMs: 420,
  /** Stage intro: stars decelerate from warp. */
  warpInMs: 900,
  /** Stage clear: warp ramps up over the last part of the clear delay. */
  warpOutShare: 0.55,
  /** Pause: quick dim (resume is instant). */
  pauseDimMs: 140,
  pauseDim: 0.62,
  /** Game over: field dims slowly behind the caption. */
  gameOverDimMs: 700,
  gameOverDim: 0.45,
  /** READY caption pop-in. */
  readyPopMs: 160,
  /** Stage banner rules (decorative lines around the stage name). */
  bannerInMs: 260,
  bannerOutMs: 200,
  /** Respawned fighter blinks at this half-period during READY. */
  respawnBlinkMs: 80,
  /** Game-over menu appears after this long (the caption reads first). */
  gameOverMenuDelayMs: 1200,
  /** Colour of fades. */
  fadeColor: 'space.void' as ColorRole,
});

export interface StarLayer {
  readonly count: number;
  /** Scroll speed (art px/s). */
  readonly speed: number;
  readonly roles: readonly ColorRole[];
  /** Fraction that twinkle. */
  readonly twinkle: number;
}

export const BACKDROP = deepFreeze({
  seed: 1981,
  /** Far -> near. Total stars stay close to the Stage 1 count (110). */
  layers: [
    { count: 56, speed: 5, roles: ['star.dim', 'star.dim', 'star.cool'], twinkle: 0.3 },
    { count: 38, speed: 11, roles: ['star.mid', 'star.cool', 'star.warm'], twinkle: 0.25 },
    { count: 18, speed: 22, roles: ['star.bright', 'star.mid'], twinkle: 0.15 },
  ] as StarLayer[],
  twinklePeriodMs: 1400,
  /** Warp: speed multiplier at full warp and maximum streak length (art px). */
  warpMultiplier: 10,
  streakMaxPx: 22,
  /** Distant objects: drawn far below sprite contrast. */
  planet: { radius: 16, x: 388, y: 330, speed: 0.9, alpha: 0.2, ringTilt: 0.32 },
  nebula: { blobs: 5, width: 448, height: 640, speed: 1.6, alpha: 0.1, threshold: 0.64, roles: ['fx.smoke', 'star.cool', 'beam.deep'] as ColorRole[] },
  /** Occasional comet streak far behind the action (disabled with reduced motion). */
  comet: { minGapMs: 7000, maxGapMs: 14000, durationMs: 520, length: 26, alpha: 0.5 },
  /**
   * Margin field (owner request, TD-76): the stars and nebula continue into the
   * screen margins around the arena, dimmed to `alpha`, as offset tiles of the
   * arena's own layers (no planet, no comet). `maxTiles` bounds the work on
   * very wide or very tall screens. `edge` is the rule around the arena: one
   * art pixel of `space.edge` at `edgeAlpha` on each side that has a margin.
   */
  margin: { alpha: 0.42, maxTiles: 16, edgeAlpha: 0.9 },
});
