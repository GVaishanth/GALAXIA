/**
 * Fixed-timestep clock (TD-04). Real frame time is accumulated and consumed in
 * fixed ticks so simulation is deterministic regardless of display refresh.
 */
export interface FixedStepOptions {
  /** Ticks per second (default 60). */
  readonly hz?: number;
  /** Max real time consumed per advance, to avoid a spiral after tab switches. */
  readonly maxFrameMs?: number;
}

export class FixedStepClock {
  readonly stepMs: number;
  readonly maxFrameMs: number;
  private accumulator = 0;
  private lastTimestamp: number | null = null;
  /** Total ticks executed. */
  ticks = 0;

  constructor(options: FixedStepOptions = {}) {
    this.stepMs = 1000 / (options.hz ?? 60);
    this.maxFrameMs = options.maxFrameMs ?? 250;
  }

  /** Simulated time in ms (ticks * step). */
  get timeMs(): number {
    return this.ticks * this.stepMs;
  }

  /**
   * Feed a frame timestamp (e.g. from requestAnimationFrame). Runs `tick` zero
   * or more times and returns the interpolation alpha in [0, 1).
   */
  advance(timestampMs: number, tick: (stepMs: number) => void): number {
    if (this.lastTimestamp === null) this.lastTimestamp = timestampMs;
    const frame = Math.min(Math.max(0, timestampMs - this.lastTimestamp), this.maxFrameMs);
    this.lastTimestamp = timestampMs;
    this.accumulator += frame;
    while (this.accumulator >= this.stepMs) {
      tick(this.stepMs);
      this.ticks++;
      this.accumulator -= this.stepMs;
    }
    return this.accumulator / this.stepMs;
  }

  /** Forget the last timestamp (call when resuming from pause). */
  resetTiming(): void {
    this.lastTimestamp = null;
    this.accumulator = 0;
  }
}
