/**
 * Visual effect recipes (Stage 4). Presentation only: nothing here changes
 * simulation, scoring or timing of play. Every effect has a fixed duration
 * and every pool a fixed capacity, so effects can never accumulate.
 *
 * Units: art px, art px/s, ms. Colours are palette roles.
 */
import { deepFreeze } from './freeze.ts';
import type { ColorRole } from './palette.ts';

export interface DebrisRecipe {
  readonly count: number;
  readonly colors: readonly ColorRole[];
  /** Initial speed range (art px/s). */
  readonly speed: readonly [number, number];
  readonly lifeMs: readonly [number, number];
  /** Square size in art px (1 or 2 keeps the pixel look). */
  readonly size: readonly [number, number];
  /** Velocity damping per second (0 = none, 0.9 = strong). */
  readonly drag: number;
}

export interface RingRecipe {
  readonly r0: number;
  readonly r1: number;
  readonly ms: number;
  readonly color: ColorRole;
}

export interface FlashRecipe {
  readonly alpha: number;
  readonly ms: number;
  readonly color: ColorRole;
}

export interface ShakeRecipe {
  /** Peak offset in art px (whole pixels keep sprites crisp). */
  readonly amp: number;
  readonly ms: number;
}

const debris = (count: number, colors: readonly ColorRole[], speed: [number, number], lifeMs: [number, number], size: [number, number] = [1, 2], drag = 0.6): DebrisRecipe => ({
  count,
  colors,
  speed,
  lifeMs,
  size,
  drag,
});

export const FX = deepFreeze({
  /** Hard caps. Pools refuse new particles when full (counted as dropped). */
  caps: {
    /** Under-ship layer: trails, arrival twinkles, exhaust sparks. */
    trails: 240,
    /** Over-ship layer: debris, sparks, celebrations. */
    debris: 420,
    rings: 16,
    flashes: 2,
    popups: 8,
    emitters: 10,
    scheduled: 24,
    marks: 64,
  },
  /** Particle counts are scaled by this when reduced motion is on (trails are disabled). */
  reducedMotionScale: 0.35,
  /** Every effect primitive ends within this time (popups, rings, emitters, celebrations included). */
  maxEffectMs: 3000,

  debris: {
    scout: debris(10, ['scout.body.light', 'scout.body', 'scout.wing', 'fx.white'], [40, 130], [240, 480]),
    interceptor: debris(12, ['interceptor.wing.light', 'interceptor.wing', 'interceptor.body', 'fx.white'], [40, 140], [240, 500]),
    commander: debris(22, ['commander.hull.light', 'commander.hull', 'commander.gold', 'fx.white', 'fx.yellow'], [50, 170], [320, 640], [1, 2], 0.5),
    transform: debris(12, ['fx.yellow', 'fx.orange', 'fx.white', 'phantom.light'], [40, 140], [240, 480]),
    capturedFighter: debris(14, ['captive.hull.light', 'captive.hull', 'captive.trim', 'fx.white'], [40, 140], [260, 520]),
    player: debris(30, ['player.hull.light', 'player.trim', 'player.engine', 'player.engine.core', 'fx.white', 'fx.red'], [40, 180], [380, 820], [1, 2], 0.45),
    playerHalf: debris(18, ['player.hull.light', 'player.trim', 'player.engine', 'fx.white'], [40, 150], [320, 640]),
    /** Small spark burst when a two-hit commander takes its first hit. */
    hit: debris(6, ['fx.white', 'fx.yellow', 'commanderHit.hull.light'], [30, 110], [120, 240], [1, 1], 0.7),
    /** Embers that linger after big explosions (slow, dark). */
    smoke: debris(6, ['fx.smoke', 'fx.orange'], [6, 26], [420, 760], [1, 2], 0.9),
  },

  ring: {
    launch: { r0: 3, r1: 15, ms: 220, color: 'fx.cyan' },
    boss: { r0: 6, r1: 38, ms: 380, color: 'fx.yellow' },
    player: { r0: 4, r1: 44, ms: 460, color: 'fx.orange' },
    capture: { r0: 20, r1: 6, ms: 420, color: 'captive.hull' },
    freed: { r0: 4, r1: 26, ms: 360, color: 'fx.rescue' },
    dual: { r0: 6, r1: 48, ms: 520, color: 'fx.cyan' },
    hostile: { r0: 4, r1: 24, ms: 320, color: 'fx.red' },
    split: { r0: 3, r1: 18, ms: 260, color: 'fx.yellow' },
    respawn: { r0: 30, r1: 4, ms: 420, color: 'player.trim' },
  } satisfies Record<string, RingRecipe>,

  flash: {
    boss: { alpha: 0.08, ms: 110, color: 'fx.white' },
    player: { alpha: 0.16, ms: 200, color: 'fx.red' },
    dual: { alpha: 0.1, ms: 180, color: 'fx.cyan' },
    capture: { alpha: 0.08, ms: 160, color: 'captive.hull' },
    perfect: { alpha: 0.14, ms: 260, color: 'fx.white' },
  } satisfies Record<string, FlashRecipe>,

  shake: {
    boss: { amp: 2, ms: 160 },
    player: { amp: 4, ms: 320 },
    /** Weapon overheated (TD-74): a longer rattle that fades out (none with reduced motion). */
    overheat: { amp: 3, ms: 900 },
  } satisfies Record<string, ShakeRecipe>,

  /** Canvas score pop-ups (drawn under projectiles). */
  popup: { ms: 820, risePx: 14, bigFrom: 1000, holdShare: 0.6 },

  /** Motion trails behind entering / diving enemies (under ships). */
  trail: { intervalMs: 55, lifeMs: 230, entering: 0.55, attacking: 1, offsetPx: 9 },

  /** Enemy settles into its slot. */
  arrival: { sparkles: 4, markMs: 90 },
  /** Attack launch: the diver flashes briefly. */
  launchMarkMs: 80,

  /** Freed captive: gold sparkle trail while it flies down to dock. */
  rescueTrail: { intervalMs: 40, lifeMs: 360, maxMs: 2400 },
  /** Commander emitter sparkles while the beam is up. */
  beamSparkle: { intervalMs: 70, lifeMs: 300, maxMs: 2600 },

  celebration: {
    stageClear: { bursts: 3, spanMs: 900, count: 14, colors: ['fx.cyan', 'fx.white', 'fx.yellow'] as ColorRole[] },
    perfect: { bursts: 7, spanMs: 2200, count: 22, colors: ['fx.yellow', 'fx.cyan', 'fx.red', 'fx.white', 'phantom.light', 'stinger.light'] as ColorRole[] },
    extraLife: { count: 16, colors: ['fx.cyan', 'player.light', 'fx.white'] as ColorRole[] },
    bonus: { count: 12, colors: ['fx.yellow', 'fx.white'] as ColorRole[] },
  },

  respawn: { count: 14, lifeMs: 420, radius: 36 },
});
