/**
 * Finale P3: the opening cinematic, entry side (small; in the entry chunk).
 *
 * The cinematic itself (director, choreography, cockpit, painter) is a lazy
 * chunk (shared/intro/openingCinematic.ts, CHUNK_BUDGETS 'openingCinematic').
 * This module holds what the home page needs before that chunk exists:
 *
 *  - the entry policy: the intro plays once per page load, on the first
 *    showing of the home page, when the page was opened at the home page
 *    (a `?mode=` deep link never shows it, returning from a mode never shows it
 *    again, `?intro=skip` opens straight to the home page);
 *  - the hero ship: the Free Roam active hull when the active slot names a known
 *    hull, otherwise the Classic fighter (documented fallback);
 *  - the gate: one state machine that resolves the intro exactly once, whatever
 *    happens first: the cinematic completes, the player skips, the chunk fails
 *    to load or render, or the load watchdog fires. Timers come from injected
 *    Schedulers (DisposableScope's), so node tests drive them.
 *
 * Nothing here reads or writes storage; the caller passes the active ship id
 * it already read for the Free Roam card (a read-only peek).
 */
import type { Schedulers } from '../lifecycle/scope.ts';
import type { SpriteCache } from '../../render/sprite/spriteCache.ts';

export const INTRO = Object.freeze({
  /** SKIP INTRO appears this long after the intro starts (avoids skipping by the press that opened the page). */
  skipDelayMs: 600,
  /** The indeterminate "LOADING" line appears only if the cinematic chunk takes longer than this. */
  slowLoadMs: 400,
  /** If the chunk has not loaded by then, the home page opens without the intro (no retry loop). */
  loadTimeoutMs: 6000,
});

/** The notice shown on the home page (polite status) when the cinematic could not run. */
export const INTRO_FAILED_NOTICE = 'The opening cinematic could not be shown, so GALAXIA opened at the home page.';

export type IntroOutcome = 'played' | 'reduced' | 'skipped' | 'failed' | 'timeout' | 'cancelled';
export type IntroState = 'idle' | 'loading' | 'playing' | 'resolved';

/** The documented fallback when no Free Roam hull can be shown. */
export const FALLBACK_HERO = 'player.fighter';

/** False when the URL asks to open straight at the home page (`?intro=skip` or `?intro=off`). */
export function introRequested(search: string): boolean {
  let v: string | null = null;
  try {
    v = new URLSearchParams(search).get('intro');
  } catch {
    return true;
  }
  return v !== 'skip' && v !== 'off';
}

/**
 * Sprite id for the hero: `ship.<id>` when the active Free Roam hull is a known sprite,
 * otherwise the Classic fighter. `known` is the sprite registry check (injected for tests).
 */
export function heroSpriteFor(shipId: string | null | undefined, known: (spriteId: string) => boolean): string {
  if (typeof shipId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(shipId)) return FALLBACK_HERO;
  const id = `ship.${shipId}`;
  return known(id) ? id : FALLBACK_HERO;
}

/* ---- the contract with the lazy chunk (types only cross the boundary) ---- */

export type CinematicPhase = 'idle' | 'arrival' | 'battle' | 'victory' | 'track' | 'approach' | 'cabin' | 'display' | 'push' | 'handoff' | 'complete';

export interface CinematicOptions {
  /** The overlay the cinematic draws into (its canvas goes first, under the controls). */
  readonly host: HTMLElement;
  /** The live home page (TitleScreen root): placed on the cockpit display, then released full-viewport. */
  readonly target: HTMLElement;
  readonly sprites: SpriteCache;
  /** Sprite id of the hero ship (heroSpriteFor). */
  readonly hero: string;
  /** Choreography seed (fixed per release: the same intro every time). */
  readonly seed: number;
  readonly reduced: boolean;
  readonly onPhase?: ((phase: CinematicPhase) => void) | undefined;
  /** The sequence reached its end (the display fills the viewport). Called at most once. */
  readonly onComplete: () => void;
  /** Rendering failed (no 2D context, an exception in a frame). Called at most once. */
  readonly onError: (err: unknown) => void;
}

export interface CinematicDebug {
  readonly phase: CinematicPhase;
  readonly time: number;
  readonly frames: number;
  readonly loops: number;
  readonly listeners: number;
  readonly actors: number;
  readonly particles: number;
  readonly maxParticles: number;
  readonly hero: string;
  readonly reduced: boolean;
  readonly disposed: boolean;
}

export interface CinematicHandle {
  dispose(): void;
  debug(): CinematicDebug;
}

export interface CinematicModule {
  createOpeningCinematic(opts: CinematicOptions): CinematicHandle;
}

/* ---- the gate ---- */

export interface IntroGateHooks {
  /** SKIP INTRO may be shown now. */
  readonly onSkippable?: (() => void) | undefined;
  /** The chunk is slow: show the indeterminate loading line. */
  readonly onSlow?: (() => void) | undefined;
  /** Exactly once: the intro is over; the home page takes over. */
  readonly onResolve: (outcome: IntroOutcome) => void;
}

export interface IntroGate {
  readonly state: IntroState;
  readonly outcome: IntroOutcome | null;
  readonly skippable: boolean;
  /** Timers currently scheduled (0 once resolved). */
  readonly timers: number;
  /** Start the clock (skip delay, slow-load line, load watchdog). */
  start(): void;
  /** The chunk arrived and the cinematic is running. False if the intro already resolved (a stale load). */
  loaded(): boolean;
  /** The cinematic reached its end. */
  complete(reduced: boolean): void;
  /** The player skipped. Ignored before SKIP INTRO is available. True if this call resolved the intro. */
  skip(): boolean;
  /** The chunk failed to load or render. */
  fail(): void;
  /** The home page went away (a mode started): resolve without the home-page handoff. */
  cancel(): void;
}

export function createIntroGate(schedulers: Pick<Schedulers, 'setTimer' | 'clearTimer'>, hooks: IntroGateHooks): IntroGate {
  let state: IntroState = 'idle';
  let outcome: IntroOutcome | null = null;
  let skippable = false;
  const timers = new Set<unknown>();
  const later = (ms: number, cb: () => void): void => {
    const id = schedulers.setTimer(() => {
      timers.delete(id);
      if (state !== 'resolved') cb();
    }, ms);
    timers.add(id);
  };
  const resolve = (o: IntroOutcome): boolean => {
    if (state === 'resolved') return false;
    state = 'resolved';
    outcome = o;
    for (const id of timers) schedulers.clearTimer(id);
    timers.clear();
    hooks.onResolve(o);
    return true;
  };
  return {
    get state() {
      return state;
    },
    get outcome() {
      return outcome;
    },
    get skippable() {
      return skippable && state !== 'resolved';
    },
    get timers() {
      return timers.size;
    },
    start() {
      if (state !== 'idle') return;
      state = 'loading';
      later(INTRO.skipDelayMs, () => {
        skippable = true;
        hooks.onSkippable?.();
      });
      later(INTRO.slowLoadMs, () => {
        if (state === 'loading') hooks.onSlow?.();
      });
      later(INTRO.loadTimeoutMs, () => {
        if (state === 'loading') resolve('timeout');
      });
    },
    loaded() {
      if (state !== 'loading') return false;
      state = 'playing';
      return true;
    },
    complete(reduced) {
      if (state === 'playing') resolve(reduced ? 'reduced' : 'played');
    },
    skip() {
      if (!skippable) return false;
      return resolve('skipped');
    },
    fail() {
      resolve('failed');
    },
    cancel() {
      resolve('cancelled');
    },
  };
}
