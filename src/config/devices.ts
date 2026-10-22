/**
 * Cross-device tuning (Stage 5): touch pad behaviour, responsive layout
 * thresholds, canvas resolution caps and minimum text units. Presentation
 * and input only; nothing here changes gameplay (the engine works in art
 * pixels and fixed ticks whatever the screen).
 */
import { deepFreeze } from './freeze.ts';

export const TOUCH_PAD = deepFreeze({
  /**
   * Move pad: finger offset from the pad centre, normalised to -1..1 of the
   * half-width. Inside +-deadZone the ship stops (rest the thumb in the middle).
   */
  deadZone: 0.16,
  /** Once moving, keep the direction until the finger is back inside deadZone - hysteresis. */
  hysteresis: 0.06,
  /** Minimum visible press feedback for very short taps (CSS state only). */
  minFeedbackMs: 90,
});

export const LAYOUT = deepFreeze({
  /** Desktop side panels: free width on each side of the playfield (CSS px). */
  sidePanels: { wide: 230, compact: 150, maxWidth: 270, gap: 20 },
  /** Touch landscape: control columns beside the playfield (CSS px). */
  sideColumn: { min: 132, max: 240 },
  /** Touch portrait: control strip under the playfield (CSS px, before the safe-area inset). */
  pad: { min: 84, max: 140 },
  /** Width / height at or above which a touch device uses the landscape layout. */
  landscapeAspect: 1,
  /**
   * Desktop panels below the playfield (portrait monitors, tall windows) when
   * there is no room beside it. Free height under the width-fitted playfield
   * (CSS px): `full` shows controls + scoring side by side, `compact` shows the
   * controls panel only. Below `compact` the panels stay hidden (HOW TO PLAY
   * has the same information). Narrower than `minWidth` (phone-sized
   * windows) they would be clipped, so they stay hidden and the II / ⓘ
   * corner buttons open the same content in the info box (TD-75).
   */
  stackedPanels: { full: 270, compact: 190, minWidth: 480 },
});

/**
 * Gamepads (Stage 8): standard-mapping controllers on desktop and mobile.
 * Presentation-free; gameplay sees the same logical actions as keyboard/touch.
 */
export const GAMEPAD = deepFreeze({
  /** Left stick X: ignore |x| below this (stick drift). */
  deadZone: 0.35,
  /** Once moving, keep the direction until |x| drops below deadZone - hysteresis. */
  hysteresis: 0.1,
  /** Stick Y beyond this counts as menu up/down. */
  menuAxis: 0.6,
  /** Menu auto-repeat while a direction is held: first delay, then interval (ms). */
  repeatDelayMs: 380,
  repeatIntervalMs: 140,
  /** Standard-mapping button indices (W3C Gamepad "standard" layout). */
  buttons: { a: 0, b: 1, x: 2, y: 3, select: 8, start: 9, up: 12, down: 13, left: 14, right: 15 },
});

/**
 * Arcade Display (TD-73): Classic's optional cabinet-style presentation. The
 * arena is centred inside a bezel ring plus a margin, both scaled from the
 * short side of the play area and clamped (CSS px). `minScale` keeps the
 * arena at >= 90 % of its Responsive size: the frame gives way first, so the
 * game never becomes too small on a phone.
 */
export const ARCADE = deepFreeze({
  bezel: { fraction: 0.014, min: 3, max: 14 },
  margin: { fraction: 0.022, min: 4, max: 28 },
  minScale: 0.9,
  /** The GALAXIA mark in the bottom bezel edge only appears from this bezel thickness. */
  markMinBezel: 11,
  /** Responsive <-> Arcade switch: viewport glide (ms; 0 with reduced motion). */
  switchMs: 220,
});

export const RENDER = deepFreeze({
  /** Highest backing-store pixel ratio (phones report up to 3-4). */
  maxPixelRatio: 3,
  /**
   * Backing-store budget in device pixels (about 6 MP). Above it the ratio is
   * lowered uniformly, so huge high-DPI windows do not cost a 15-30 MP canvas
   * every frame. Gameplay coordinates are unaffected.
   */
  maxBackingPixels: 6_000_000,
  /**
   * Adaptive render resolution (TD-79), game canvases only (Classic playfield,
   * Free Roam flight). When frames are slow for a sustained stretch, the
   * backing ratio steps down; when they are healthy again it steps back up.
   * The ratio never drops below `minRatio` device px per CSS px (the canvas
   * never renders under CSS resolution), so on a DPR-1 screen nothing changes.
   */
  adaptive: {
    /** Backing-ratio multipliers, best first (applied to the DPR/budget ratio, then clamped to minRatio). */
    levels: [1, 0.85, 0.72, 0.6, 0.5],
    minRatio: 1,
    /** Frames per measurement sample (about 1 s at 60 Hz). */
    windowFrames: 60,
    /** Intervals longer than this are a hitch, tab switch or debugger stop, not render cost: ignored. */
    maxGapMs: 250,
    /** Mean frame interval above this (under ~50 fps) counts as a slow sample. */
    slowMs: 20,
    /** Consecutive slow windows before stepping down (sustained, not one spike). */
    slowWindows: 2,
    /** A sample is healthy when the mean interval is at most this (about 57 fps)... */
    healthyMs: 17.5,
    /** ...and the mean main-thread work per frame is at most this. */
    healthyWorkMs: 8,
    /** Consecutive healthy windows before stepping back up (first attempt). */
    restoreWindows: 4,
    /** Each step up that is followed by a step down within this time doubles the restore wait (hysteresis). */
    relapseMs: 8000,
    /** Upper bound for the restore wait, in windows. */
    maxRestoreWindows: 120, // about 2 minutes between failed restore probes at most
    /** Frames ignored after any change or resume (the reallocation hitch and settling). */
    settleFrames: 30,
    /** A descent that, at its floor, improved the mean interval by less than this fraction is undone (vsync-capped or throttled, not render-bound). */
    minGain: 0.05,
    /** After an undone descent, no new descent for this long; each further undo doubles it... */
    lockMs: 30000,
    /** ...up to this (a 30 Hz display tries again at most every 10 minutes). */
    maxLockMs: 600000,
  },
});

export const UI_SCALE = deepFreeze({
  /** HUD text unit floor (CSS px per arcade unit): label >= 10.8 px, value >= 13.5 px. */
  hudTextMinUnit: 1.8,
  /** Menu unit floor: menu buttons >= 14 px, hints >= 10 px on small playfields. */
  menuMinUnit: 2,
});
