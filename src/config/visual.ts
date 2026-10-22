/**
 * Shared visual constants. Rendering code reads these instead of embedding
 * numbers, so tuning the look never requires touching renderer logic.
 */

/** Logical playfield in arcade units (portrait, classic proportions). */
export const PLAYFIELD = {
  widthUnits: 224,
  heightUnits: 288,
} as const;

/**
 * Art density: sprite pixels ("art pixels") per arcade unit.
 * 2 means ships are authored at twice the classic resolution while keeping the
 * classic on-screen size (a ~27 art-px fighter is ~13.5 units wide).
 * Every playfield sprite uses this single density.
 */
export const ART_PIXELS_PER_UNIT = 2;

export const PLAYFIELD_ART = {
  width: PLAYFIELD.widthUnits * ART_PIXELS_PER_UNIT,
  height: PLAYFIELD.heightUnits * ART_PIXELS_PER_UNIT,
} as const;

export const SPRITE_STYLE = {
  /** Auto-generated outline thickness in art pixels (0 disables). */
  outlineWidth: 1,
  /** Glow spread radius in art pixels around emissive pixels. */
  glowRadius: 3,
  /** Multiplier applied to accumulated glow coverage before clamping. */
  glowGain: 0.55,
  /** Opacity used when compositing the glow layer ('lighter' blend). */
  glowOpacity: 0.5,
  /** Largest integer pre-scale used by the sharp-bilinear scaler. */
  maxPrescale: 8,
} as const;

/** Frame durations for looping sprite animations, in milliseconds. */
export const ANIMATION_TIMING = {
  formationFlapMs: 480,
  engineFlickerMs: 70,
  shotFlickerMs: 60,
  beamCycleMs: 90,
  explosionFrameMs: 85,
  hitSparkFrameMs: 50,
  rescueBlinkMs: 160,
  hitFlashMs: 60,
} as const;

export const STARFIELD = {
  starCount: 110,
  /** Scroll speed in art pixels per second for the slowest/fastest layer. */
  minSpeed: 6,
  maxSpeed: 22,
  /** Fraction of stars that twinkle off at any time. */
  twinkleShare: 0.25,
  twinklePeriodMs: 1400,
} as const;
