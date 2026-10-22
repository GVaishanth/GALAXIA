/**
 * Input arming for panels the game opens by itself (FR-TD-82).
 *
 * The recovery screen and the survey-complete card open in the middle of
 * flight, not in answer to a menu press (the jump-gate prompt and docking
 * answer the player's own INTERACT press, so they are ready at once). A player is usually
 * steering (arrow keys / WASD), firing (Space) or tapping the touch pad at
 * that moment. Before this gate, the first fresh press after the panel
 * appeared was read as menu input: an arrow moved the focus from CONTINUE to
 * SECTOR MAP, Space activated the focused button, and the recovery screen
 * took input while still invisible (its entrance waits 650 ms for the wreck
 * burst). A later Enter then opened the sector map instead of resuming the
 * flight; this was the intermittent Firefox "CONTINUE (Enter)" failure.
 *
 * The gate drops panel commands (keys and gamepad) until the panel has been
 * visible for a short settle time; the panel also ignores pointers meanwhile
 * (`data-arming`, CSS). Panels the player opens themselves are never armed.
 * Pure and clock-agnostic so it can be unit tested with synthetic times.
 */

/** Time a game-opened panel ignores input after it becomes visible. */
export const PANEL_SETTLE_MS = 300;

/** How long a game-opened panel stays unarmed: its entrance delay (if it animates) plus the settle time. */
export function armingDelayMs(entranceDelayMs: number, animates: boolean): number {
  return (animates ? Math.max(0, entranceDelayMs) : 0) + PANEL_SETTLE_MS;
}

export class InputArming {
  private readyAt = Number.NEGATIVE_INFINITY;
  private dropped = 0;

  /** Ignore input for `ms` from `now`. */
  arm(now: number, ms: number): void {
    this.readyAt = now + Math.max(0, ms);
  }

  /** Any panel change: the next panel is ready at once unless it is armed again. */
  clear(): void {
    this.readyAt = Number.NEGATIVE_INFINITY;
  }

  ready(now: number): boolean {
    return now >= this.readyAt;
  }

  /** True when the command may run; counts the ones it drops (diagnostics). */
  admit(now: number): boolean {
    if (this.ready(now)) return true;
    this.dropped += 1;
    return false;
  }

  /** Commands dropped while unarmed, in total. */
  get droppedCount(): number {
    return this.dropped;
  }
}
