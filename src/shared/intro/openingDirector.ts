/**
 * Finale P3: the opening cinematic's director (pure; part of the lazy
 * openingCinematic chunk). It owns time and phases, nothing else: no DOM, no
 * timers, no wall clock. The painter feeds it frame deltas from
 * requestAnimationFrame; everything on screen is a pure function of the
 * director's time (openingScene.ts, openingCockpit.ts), so the sequence is the
 * same on every machine and at every frame rate.
 *
 * Phases (full sequence, 8.5 s):
 *   idle -> arrival -> battle -> victory -> track -> approach -> cabin ->
 *   display -> push -> handoff -> complete
 * Reduced motion (1.65 s, opacity only):
 *   idle -> cabin -> display -> push -> handoff -> complete
 *
 * Rules:
 *   - time advances only through advance(dt); dt is clamped to FRAME_CLAMP_MS,
 *     so a long frame gap (a hidden tab, a stall, a debugger) never jumps the
 *     sequence ahead or skips a phase's callbacks;
 *   - completion, skip and failure each end the run once; after that (or after
 *     dispose) no callback ever fires again (no stale callbacks).
 */

export const OPENING_PHASES = ['idle', 'arrival', 'battle', 'victory', 'track', 'approach', 'cabin', 'display', 'push', 'handoff', 'complete'] as const;
export type OpeningPhase = (typeof OPENING_PHASES)[number];
export type TimedPhase = Exclude<OpeningPhase, 'idle' | 'complete'>;
export type Schedule = readonly (readonly [TimedPhase, number])[];

/** Full sequence: [phase, duration ms]. */
export const FULL_SCHEDULE: Schedule = Object.freeze([
  ['arrival', 900],
  ['battle', 2400],
  ['victory', 600],
  ['track', 800],
  ['approach', 1000],
  ['cabin', 800],
  ['display', 1000],
  ['push', 800],
  ['handoff', 200],
] as const);

/** Reduced motion: a still cockpit fades in, the home page is shown on its display, then a fade to the full page. */
export const REDUCED_SCHEDULE: Schedule = Object.freeze([
  ['cabin', 400],
  ['display', 700],
  ['push', 250],
  ['handoff', 300],
] as const);

/** Upper bounds the tests hold the schedules to. */
export const OPENING_LIMITS = Object.freeze({ fullMs: 9000, reducedMs: 2000, phaseMs: 2500 });

/** Longest step one frame may take (ms). */
export const FRAME_CLAMP_MS = 50;

export type OpeningOutcome = 'played' | 'reduced' | 'skipped' | 'failed';

export interface PhaseSample {
  readonly phase: OpeningPhase;
  /** ms since the start of the sequence. */
  readonly t: number;
  /** ms into the current phase. */
  readonly local: number;
  /** 0..1 through the current phase (1 for complete). */
  readonly p: number;
}

export function totalMs(schedule: Schedule): number {
  return schedule.reduce((s, [, ms]) => s + ms, 0);
}

/** Start time of `phase` in `schedule` (null if the schedule has no such phase). */
export function phaseStart(schedule: Schedule, phase: TimedPhase): number | null {
  let t = 0;
  for (const [p, ms] of schedule) {
    if (p === phase) return t;
    t += ms;
  }
  return null;
}

/** The phase at time `t` (ms). Negative or NaN time is idle; past the end is complete. */
export function phaseAt(schedule: Schedule, t: number): PhaseSample {
  if (!(t >= 0)) return { phase: 'idle', t: 0, local: 0, p: 0 };
  let start = 0;
  for (const [phase, ms] of schedule) {
    if (t < start + ms) return { phase, t, local: t - start, p: ms > 0 ? (t - start) / ms : 1 };
    start += ms;
  }
  return { phase: 'complete', t: start, local: 0, p: 1 };
}

export interface DirectorHooks {
  readonly reduced: boolean;
  readonly onPhase?: ((phase: OpeningPhase) => void) | undefined;
  readonly onComplete?: ((outcome: OpeningOutcome) => void) | undefined;
}

export class OpeningDirector {
  readonly schedule: Schedule;
  readonly reduced: boolean;
  private hooks: DirectorHooks | null;
  private t = 0;
  private started = false;
  private sample: PhaseSample = { phase: 'idle', t: 0, local: 0, p: 0 };
  private result: OpeningOutcome | null = null;
  private gone = false;

  constructor(hooks: DirectorHooks) {
    this.hooks = hooks;
    this.reduced = hooks.reduced;
    this.schedule = hooks.reduced ? REDUCED_SCHEDULE : FULL_SCHEDULE;
  }

  get phase(): OpeningPhase {
    return this.sample.phase;
  }
  get time(): number {
    return this.t;
  }
  get outcome(): OpeningOutcome | null {
    return this.result;
  }
  get done(): boolean {
    return this.result !== null || this.gone;
  }
  get disposed(): boolean {
    return this.gone;
  }
  get current(): PhaseSample {
    return this.sample;
  }

  /** Enter the first phase (time 0). Idempotent. */
  start(): PhaseSample {
    if (this.started || this.done) return this.sample;
    this.started = true;
    this.enter(phaseAt(this.schedule, 0));
    return this.sample;
  }

  /** Advance by one frame's delta (ms, clamped to FRAME_CLAMP_MS). Returns the new sample. */
  advance(dtMs: number): PhaseSample {
    if (!this.started || this.done) return this.sample;
    const dt = Number.isFinite(dtMs) ? Math.min(FRAME_CLAMP_MS, Math.max(0, dtMs)) : 0;
    this.t += dt;
    const next = phaseAt(this.schedule, this.t);
    if (next.phase !== this.sample.phase) {
      // never skip a phase's enter callback, even when one frame crosses a short phase
      const from = OPENING_PHASES.indexOf(this.sample.phase);
      const to = OPENING_PHASES.indexOf(next.phase);
      const timed = new Set(this.schedule.map(([p]) => p as OpeningPhase));
      for (let i = from + 1; i < to; i++) {
        const p = OPENING_PHASES[i]!;
        if (timed.has(p)) this.hooks?.onPhase?.(p);
      }
      this.enter(next);
      if (next.phase === 'complete') this.finish(this.reduced ? 'reduced' : 'played');
    } else {
      this.sample = next;
    }
    return this.sample;
  }

  /** End now (SKIP INTRO). True if this call ended the run. */
  skip(): boolean {
    if (this.done) return false;
    this.sample = { phase: 'complete', t: this.t, local: 0, p: 1 };
    this.finish('skipped');
    return true;
  }

  /** End now because rendering failed. True if this call ended the run. */
  fail(): boolean {
    if (this.done) return false;
    this.sample = { phase: 'complete', t: this.t, local: 0, p: 1 };
    this.finish('failed');
    return true;
  }

  /** Drop the hooks: nothing fires after this. */
  dispose(): void {
    this.gone = true;
    this.hooks = null;
  }

  private enter(s: PhaseSample): void {
    this.sample = s;
    this.hooks?.onPhase?.(s.phase);
  }

  private finish(o: OpeningOutcome): void {
    this.result = o;
    const h = this.hooks;
    this.hooks = null; // at most one completion; later calls find no hooks
    h?.onComplete?.(o);
  }
}
