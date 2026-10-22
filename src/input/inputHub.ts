/**
 * Unified input (Stage 5). Every device adapter (keyboard, touch pad, canvas
 * tap, test scripts) feeds the same logical actions into one InputHub; the
 * engine only ever sees the InputFrame it produces (core/game/input.ts).
 *
 * - Gamepads (Stage 8) are one more source ('gamepad'), polled once per frame.
 * - Movement is a per-source hold (-1 / 0 / 1). The most recently changed
 *   non-zero source wins, and releasing it falls back to any source still
 *   held. Lifting a finger therefore never cancels a held arrow key, and vice
 *   versa (touch and keyboard can be used together).
 * - Fire, pause and confirm are edge presses latched until the next tick
 *   consumes them, so a tap shorter than one frame is never lost and one
 *   press is exactly one action.
 * - Fire is also a per-source hold (TD-74): holding a fire key, the FIRE
 *   button or pad A keeps firing (the engine paces it and heats the weapon).
 *   The hold ends when the last source releases; clear() drops it.
 * - Fire doubles as "confirm" only where the caller allows it (the title
 *   screen), so mashing fire through a death cannot skip game over.
 *
 * DOM-free: adapters translate platform events; this class owns no listeners.
 */
import type { InputFrame } from '../core/game/input.ts';

/** Logical actions. `start` is the confirm action (Enter, tap to start). */
export type Action = 'left' | 'right' | 'fire' | 'pause' | 'start';
export type MoveDir = -1 | 0 | 1;
export type InputSource = 'keyboard' | 'touch' | 'pointer' | 'gamepad' | 'script';

export interface FrameOptions {
  /** Let a fire press also count as confirm (true on the title screen only). */
  readonly fireConfirms?: boolean;
}

interface Hold {
  dir: MoveDir;
  seq: number;
}

export class InputHub {
  private readonly holds = new Map<InputSource, Hold>();
  private seq = 0;
  private firePressed = false;
  /** Sources currently holding fire (keyboard, touch, gamepad, script). */
  private readonly fireHolds = new Set<InputSource>();
  private pausePressed = false;
  private startPressed = false;
  /** Source of the latest user action (UI adapts touch vs keyboard layouts). */
  lastSource: InputSource | null = null;
  /** Presses accepted per source (diagnostics for automated checks). */
  readonly pressCount: Record<InputSource, number> = { keyboard: 0, touch: 0, pointer: 0, gamepad: 0, script: 0 };

  /** Set the movement hold of one source (0 releases it). */
  setMove(source: InputSource, dir: MoveDir): void {
    const cur = this.holds.get(source);
    if (dir === 0) {
      this.holds.delete(source);
      return;
    }
    if (cur && cur.dir === dir) return; // unchanged: keep its priority
    this.holds.set(source, { dir, seq: ++this.seq });
    this.lastSource = source;
  }

  /** Current resolved direction (latest non-zero hold). */
  get moveX(): MoveDir {
    let best: Hold | null = null;
    for (const h of this.holds.values()) if (!best || h.seq > best.seq) best = h;
    return best ? best.dir : 0;
  }

  /** Set whether one source holds fire (a press with press('fire') still fires once on its own). */
  setFireHeld(source: InputSource, held: boolean): void {
    if (held) this.fireHolds.add(source);
    else this.fireHolds.delete(source);
  }

  /** True while any source holds fire. */
  get fireHeld(): boolean {
    return this.fireHolds.size > 0;
  }

  moveOf(source: InputSource): MoveDir {
    return this.holds.get(source)?.dir ?? 0;
  }

  /**
   * Edge press. `left` / `right` are accepted for scripts and old callers and
   * become a hold of that source (release with `release`).
   */
  press(action: Action, source: InputSource = 'script'): void {
    this.pressCount[source] += 1;
    this.lastSource = source;
    switch (action) {
      case 'left':
        this.setMove(source, -1);
        break;
      case 'right':
        this.setMove(source, 1);
        break;
      case 'fire':
        this.firePressed = true;
        break;
      case 'pause':
        this.pausePressed = true;
        break;
      case 'start':
        this.startPressed = true;
        break;
    }
  }

  /** Release a `left` / `right` hold made with press(). */
  release(action: 'left' | 'right', source: InputSource = 'script'): void {
    const dir: MoveDir = action === 'left' ? -1 : 1;
    if (this.moveOf(source) === dir) this.setMove(source, 0);
  }

  /** Drop one source's hold (finger lifted, pointer cancelled, adapter reset). */
  clearSource(source: InputSource): void {
    this.holds.delete(source);
    this.fireHolds.delete(source);
  }

  /** Drop everything held and latched (blur / visibility loss / menu click). */
  clear(): void {
    this.holds.clear();
    this.fireHolds.clear();
    this.firePressed = this.pausePressed = this.startPressed = false;
  }

  /** Consume one tick of input. */
  frame(options: FrameOptions = {}): InputFrame {
    const fireConfirms = options.fireConfirms ?? true;
    const f: InputFrame = {
      moveX: this.moveX,
      fire: this.firePressed,
      fireHeld: this.fireHolds.size > 0,
      pause: this.pausePressed,
      start: this.startPressed || (fireConfirms && this.firePressed),
    };
    this.firePressed = this.pausePressed = this.startPressed = false;
    return f;
  }
}
