/**
 * Adaptive render resolution (TD-79): picks a backing-ratio level for a game
 * canvas from measured frame timing. Pure and allocation-free per frame (running
 * sums, no arrays), so it is unit-tested with synthetic frames and costs nothing
 * measurable in the loop.
 *
 * Rules (numbers in RENDER.adaptive):
 * - Only active, visible frames are sampled: a paused game, an open panel, a
 *   hidden tab or a hitch longer than maxGapMs never counts, and every resume,
 *   resize or level change is followed by settleFrames that are ignored.
 * - Start a descent after slowWindows consecutive slow windows (mean interval
 *   > slowMs): sustained degradation, not a single spike. While the frames stay
 *   slow the descent continues one level per window.
 * - The descent is judged against the level where it started, not step by
 *   step: frame times snap to the display's refresh, so one step can show no
 *   gain while the next one helps a lot (measured, TD-79). When the floor is
 *   reached (last level, or canLower false) and the mean interval has not
 *   improved by minGain overall, the whole descent is undone and new descents
 *   are locked for lockMs, doubling with every undo up to maxLockMs (a 30 Hz
 *   display, battery saver or a CPU-bound frame does not get blurrier for
 *   nothing, nor dip periodically).
 * - Step back up one level after restoreWindows consecutive healthy windows
 *   (mean interval <= healthyMs and mean work <= healthyWorkMs). If the first
 *   window after a step up is slow, step straight back (a failed probe costs
 *   one window). Any step down within relapseMs of a step up doubles the
 *   restore wait (up to maxRestoreWindows): hysteresis, so it does not
 *   oscillate.
 *
 * Presentation only: the level changes the backing store, never gameplay.
 */
import { RENDER } from '../../config/devices.ts';

export interface RenderScaleConfig {
  readonly levels: readonly number[];
  readonly minRatio: number;
  readonly windowFrames: number;
  readonly maxGapMs: number;
  readonly slowMs: number;
  readonly slowWindows: number;
  readonly healthyMs: number;
  readonly healthyWorkMs: number;
  readonly restoreWindows: number;
  readonly relapseMs: number;
  readonly maxRestoreWindows: number;
  readonly settleFrames: number;
  readonly minGain: number;
  readonly lockMs: number;
  readonly maxLockMs: number;
}

/** Diagnostics (mutated in place; read by the e2e harnesses through the mode status). */
export interface RenderScaleStats {
  level: number;
  multiplier: number;
  stepsDown: number;
  stepsUp: number;
  undone: number;
  /** Healthy windows currently needed before a step up. */
  restoreWindows: number;
  /** Mean interval / work of the last complete window (ms; 0 before the first). */
  lastMeanMs: number;
  lastWorkMs: number;
  windows: number;
  /** Frames ignored: inactive, settling or over maxGapMs. */
  ignored: number;
}

export class RenderScaleController {
  readonly cfg: RenderScaleConfig;
  readonly stats: RenderScaleStats;
  private settle: number;
  private sum = 0;
  private work = 0;
  private n = 0;
  private slowRun = 0;
  private healthyRun = 0;
  private lastUpMs = Number.NEGATIVE_INFINITY;
  private lockUntil = Number.NEGATIVE_INFINITY;
  /** Current lock length: lockMs, doubled by every undone step (up to maxLockMs). */
  private lockLen: number;
  /** The descent in progress: level it started from (-1 = none) and the mean that started it. */
  private anchorFrom = -1;
  private anchorBefore = 0;
  /** The last change was a step up whose first window has not been judged yet. */
  private probing = false;

  constructor(cfg: RenderScaleConfig = RENDER.adaptive) {
    this.cfg = cfg;
    this.settle = cfg.settleFrames;
    this.lockLen = cfg.lockMs;
    this.stats = { level: 0, multiplier: cfg.levels[0] ?? 1, stepsDown: 0, stepsUp: 0, undone: 0, restoreWindows: cfg.restoreWindows, lastMeanMs: 0, lastWorkMs: 0, windows: 0, ignored: 0 };
  }

  get level(): number {
    return this.stats.level;
  }

  /** Backing-ratio multiplier for the current level. */
  get multiplier(): number {
    return this.stats.multiplier;
  }

  /** Ignore the next settleFrames frames and drop the partial window (resize, reallocation, resume). */
  hold(): void {
    this.settle = this.cfg.settleFrames;
    this.sum = 0;
    this.work = 0;
    this.n = 0;
  }

  /** Back to full resolution now (a mode that cannot use a lower ratio); counters are kept. */
  reset(): boolean {
    this.anchorFrom = -1;
    this.probing = false;
    if (this.stats.level === 0) return false;
    return this.setLevel(0);
  }

  /**
   * One frame. `active` is false while paused, behind a panel or hidden;
   * `canLower` is false when the next level would not reduce the ratio (the
   * minRatio floor). Returns true when the level changed.
   */
  sample(nowMs: number, intervalMs: number, workMs: number, active: boolean, canLower: boolean): boolean {
    const c = this.cfg;
    const s = this.stats;
    if (!active) {
      s.ignored += 1;
      this.hold();
      this.slowRun = 0;
      this.healthyRun = 0;
      return false;
    }
    if (this.settle > 0) {
      this.settle -= 1;
      s.ignored += 1;
      return false;
    }
    if (!(intervalMs > 0) || intervalMs > c.maxGapMs) {
      s.ignored += 1;
      return false;
    }
    this.sum += intervalMs;
    this.work += workMs > 0 ? workMs : 0;
    this.n += 1;
    if (this.n < c.windowFrames) return false;

    const mean = this.sum / this.n;
    const meanWork = this.work / this.n;
    this.sum = 0;
    this.work = 0;
    this.n = 0;
    s.windows += 1;
    s.lastMeanMs = mean;
    s.lastWorkMs = meanWork;

    if (this.anchorFrom >= 0) {
      if (mean > c.slowMs) {
        // still slow: keep descending while a lower level exists
        if (canLower && s.level < c.levels.length - 1) {
          s.stepsDown += 1;
          return this.setLevel(s.level + 1);
        }
        // at the floor: judge the whole descent
        const from = this.anchorFrom;
        const gain = (this.anchorBefore - mean) / this.anchorBefore;
        this.anchorFrom = -1;
        if (gain < c.minGain) {
          s.undone += 1;
          this.lockUntil = nowMs + this.lockLen;
          this.lockLen = Math.min(this.lockLen * 2, c.maxLockMs);
          return this.setLevel(from);
        }
        return false; // it helped, not enough: the floor is as good as it gets
      }
      this.anchorFrom = -1; // fast enough again: the descent worked, keep this level
    }

    if (this.probing) {
      this.probing = false;
      if (mean > c.slowMs && canLower && s.level < c.levels.length - 1) {
        // the level above is still too slow: straight back, and wait longer next time
        s.restoreWindows = Math.min(s.restoreWindows * 2, c.maxRestoreWindows);
        s.stepsDown += 1;
        return this.setLevel(s.level + 1);
      }
    }

    if (mean > c.slowMs) {
      this.healthyRun = 0;
      this.slowRun += 1;
      if (this.slowRun >= c.slowWindows && canLower && s.level < c.levels.length - 1 && nowMs >= this.lockUntil) {
        if (nowMs - this.lastUpMs < c.relapseMs) s.restoreWindows = Math.min(s.restoreWindows * 2, c.maxRestoreWindows);
        this.anchorFrom = s.level;
        this.anchorBefore = mean;
        s.stepsDown += 1;
        return this.setLevel(s.level + 1);
      }
      return false;
    }
    this.slowRun = 0;
    if (mean <= c.healthyMs && meanWork <= c.healthyWorkMs) {
      this.healthyRun += 1;
      if (s.level > 0 && this.healthyRun >= s.restoreWindows) {
        this.lastUpMs = nowMs;
        s.stepsUp += 1;
        this.setLevel(s.level - 1);
        this.probing = true;
        return true;
      }
    } else {
      this.healthyRun = 0;
    }
    return false;
  }

  private setLevel(level: number): boolean {
    const s = this.stats;
    s.level = level;
    s.multiplier = this.cfg.levels[level] ?? 1;
    this.slowRun = 0;
    this.healthyRun = 0;
    this.hold();
    return true;
  }
}
