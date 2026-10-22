/**
 * Transition director: a pure function of (phase history, UI clock, engine
 * phase clock) that tells the renderer how much to fade, dim or warp.
 *
 * Rules (Stage 4):
 * - Driven only by phaseChanged events and read-only clocks. It never
 *   changes the phase or delays the engine; transitions run *while* the
 *   engine is already in a non-interactive phase (boot, title, ready, stage
 *   clear, pause, game over).
 * - Live attack (playing / challenge) is never covered: fade, dim, banner and
 *   READY are all zero there, by construction (`live` short-circuits).
 * - Resume is instant (no fade-out over live play).
 * - Reduced motion: no warp, no pop scaling, instant dims.
 */
import { TRANSITIONS } from '../config/presentation.ts';
import type { GamePhase, PhaseClock } from '../core/game/stateMachine.ts';

export interface TransitionFrame {
  /** Live attack: nothing may cover the field. */
  readonly live: boolean;
  /** Opaque fade (0..1), drawn over everything including shots; never in live phases. */
  readonly fade: number;
  /** Translucent dim (0..1) for pause / game over. */
  readonly dim: number;
  /** Title art visibility (0..1). */
  readonly titleAlpha: number;
  /** Starfield warp (0..1). */
  readonly warp: number;
  /** READY countdown: remaining share (1 -> 0) and pop-in (0..1); null when hidden. */
  readonly ready: { readonly remaining: number; readonly pop: number } | null;
  /** Stage banner rule extent (0..1). */
  readonly banner: number;
  /** False on the "off" half of the respawn blink. */
  readonly playerVisible: boolean;
}

export interface TransitionFlags {
  readonly reducedMotion: boolean;
  /** READY is a stage intro (true) or a respawn (false). */
  readonly stageIntro: boolean;
}

const LIVE: ReadonlySet<GamePhase> = new Set(['playing', 'challenge']);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (k: number): number => (k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k));

export class TransitionDirector {
  private phase: GamePhase = 'boot';
  private enteredMs = 0;
  /** A fade-in from black (boot, new game, restart). */
  private fadeIn: { startMs: number; ms: number } | null = null;
  /** UI time a game started from the title (title art fades out). */
  private leftTitleMs: number | null = null;

  /** Start the boot fade (call once the shell is mounted). */
  boot(uiMs: number): void {
    this.fadeIn = { startMs: uiMs, ms: TRANSITIONS.bootFadeMs };
  }

  /** Feed every phaseChanged event (in order). */
  onPhaseChanged(from: GamePhase, to: GamePhase, uiMs: number): void {
    this.phase = to;
    this.enteredMs = uiMs;
    if (from === 'title' && to === 'ready') {
      this.leftTitleMs = uiMs;
      this.fadeIn = { startMs: uiMs, ms: TRANSITIONS.gameInFadeMs };
    } else if (from === 'restarting' && to === 'ready') {
      this.fadeIn = { startMs: uiMs, ms: TRANSITIONS.restartFadeMs };
    } else if (to !== 'paused' && from !== 'paused') {
      this.leftTitleMs = null; // title art only fades during the first READY
    }
    if (to === 'title' && from !== 'boot') {
      this.fadeIn = { startMs: uiMs, ms: TRANSITIONS.bootFadeMs / 2 };
    }
  }

  get currentPhase(): GamePhase {
    return this.phase;
  }

  frame(uiMs: number, clock: PhaseClock, flags: TransitionFlags): TransitionFrame {
    const phase = clock.paused ? 'paused' : clock.phase;
    const active = clock.phase;
    const rm = flags.reducedMotion;
    const live = LIVE.has(phase);

    let fade = 0;
    if (this.fadeIn && !live) fade = 1 - clamp01((uiMs - this.fadeIn.startMs) / this.fadeIn.ms);
    if (phase === 'boot') fade = 1;

    let dim = 0;
    if (phase === 'paused') dim = TRANSITIONS.pauseDim * (rm ? 1 : clamp01((uiMs - this.enteredMs) / TRANSITIONS.pauseDimMs));
    else if (phase === 'gameOver') dim = TRANSITIONS.gameOverDim * (rm ? 1 : clamp01(clock.elapsedMs / TRANSITIONS.gameOverDimMs));

    let titleAlpha = 0;
    if (phase === 'title' || phase === 'boot') titleAlpha = 1;
    else if (active === 'ready' && this.leftTitleMs !== null) titleAlpha = 1 - clamp01((uiMs - this.leftTitleMs) / TRANSITIONS.titleOutMs);

    let warp = 0;
    if (!rm && !live) {
      if (active === 'ready' && flags.stageIntro) warp = 1 - easeInOut(clamp01(clock.elapsedMs / TRANSITIONS.warpInMs));
      else if (active === 'stageCleared' && clock.durationMs) {
        const k = clock.elapsedMs / clock.durationMs;
        const start = 1 - TRANSITIONS.warpOutShare;
        warp = easeInOut(clamp01((k - start) / TRANSITIONS.warpOutShare));
      }
    }

    let ready: TransitionFrame['ready'] = null;
    let banner = 0;
    let playerVisible = true;
    if (active === 'ready' && !live) {
      const dur = clock.durationMs ?? 1;
      ready = { remaining: 1 - clamp01(clock.elapsedMs / dur), pop: rm ? 1 : clamp01(clock.elapsedMs / TRANSITIONS.readyPopMs) };
      if (flags.stageIntro) {
        const inK = clamp01(clock.elapsedMs / TRANSITIONS.bannerInMs);
        const outK = clamp01((dur - clock.elapsedMs) / TRANSITIONS.bannerOutMs);
        banner = rm ? 1 : Math.min(easeInOut(inK), outK);
      } else if (!rm) {
        // respawned fighter blinks during the first 60 % of READY
        playerVisible = clock.elapsedMs > dur * 0.6 || Math.floor(clock.elapsedMs / TRANSITIONS.respawnBlinkMs) % 2 === 0;
      }
    }

    if (live) return { live, fade: 0, dim: 0, titleAlpha: 0, warp: 0, ready: null, banner: 0, playerVisible: true };
    return { live, fade, dim, titleAlpha, warp, ready, banner, playerVisible };
  }

  /** True while a UI-clock fade is still running (the shell must keep drawing while paused). */
  animating(uiMs: number, clock: PhaseClock, reducedMotion: boolean): boolean {
    if (this.fadeIn && uiMs - this.fadeIn.startMs < this.fadeIn.ms) return true;
    if (clock.paused && !reducedMotion && uiMs - this.enteredMs < TRANSITIONS.pauseDimMs + 34) return true;
    return false;
  }
}
