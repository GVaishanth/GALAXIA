/**
 * Touch pad pointer model (pure, DOM-free; the DOM adapter is
 * touchControls.ts). Tracks every active pointer independently, so moving
 * and firing work at the same time (multi-touch).
 *
 * Zones:
 * - move: a horizontal slide control. The finger's offset from the pad
 *   centre (normalised -1..1) gives the direction; sliding across switches
 *   direction without lifting; the middle dead zone stops the ship. If
 *   several fingers are on the pad, the newest one steers and lifting it
 *   falls back to the next.
 * - fire: every new touch is one shot, and holding it keeps firing (TD-74;
 *   the engine paces the shots and heats the weapon, as on the keyboard).
 * - pause: every new touch toggles pause.
 *
 * Releasing a pointer (lifted, cancelled by the browser, released outside the
 * control, capture lost) or reset() (blur / hidden page) always stops movement.
 */
import { TOUCH_PAD } from '../config/devices.ts';
import type { InputHub, MoveDir } from './inputHub.ts';

export type TouchZone = 'move' | 'fire' | 'pause';

export interface TouchPadState {
  readonly moveDir: MoveDir;
  /** Normalised x of the steering finger (-1..1), or null when none. */
  readonly knob: number | null;
  readonly pressed: Readonly<Record<TouchZone, boolean>>;
}

interface Tracked {
  readonly zone: TouchZone;
  x: number;
}

const clamp1 = (v: number): number => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

/** Direction for a normalised finger x, with hysteresis around the dead zone. */
export function moveDirFor(x: number, prev: MoveDir, deadZone: number = TOUCH_PAD.deadZone, hysteresis: number = TOUCH_PAD.hysteresis): MoveDir {
  const keep = Math.max(0, deadZone - hysteresis);
  if (prev === 1 && x > keep) return 1;
  if (prev === -1 && x < -keep) return -1;
  if (x > deadZone) return 1;
  if (x < -deadZone) return -1;
  return 0;
}

/** Client x within a control rect -> -1..1 offset from its centre. */
export function normaliseX(clientX: number, rect: { readonly left: number; readonly width: number }): number {
  if (!(rect.width > 0)) return 0;
  return clamp1((clientX - (rect.left + rect.width / 2)) / (rect.width / 2));
}

export class TouchPadModel {
  private readonly hub: InputHub;
  private readonly pointers = new Map<number, Tracked>();
  /** Pointer ids on the move pad, oldest first (the last one steers). */
  private readonly steer: number[] = [];
  private dir: MoveDir = 0;
  onChange: ((s: TouchPadState) => void) | null = null;

  constructor(hub: InputHub) {
    this.hub = hub;
  }

  has(id: number): boolean {
    return this.pointers.has(id);
  }

  get activePointers(): number {
    return this.pointers.size;
  }

  down(id: number, zone: TouchZone, x = 0): void {
    if (this.pointers.has(id)) this.up(id);
    this.pointers.set(id, { zone, x: clamp1(x) });
    if (zone === 'move') {
      this.steer.push(id);
      this.updateMove();
    } else {
      this.hub.press(zone, 'touch');
      if (zone === 'fire') this.hub.setFireHeld('touch', true);
    }
    this.emit();
  }

  move(id: number, x: number): void {
    const p = this.pointers.get(id);
    if (!p || p.zone !== 'move') return;
    p.x = clamp1(x);
    if (this.updateMove()) this.emit();
    else if (this.steer[this.steer.length - 1] === id) this.emit(); // knob feedback
  }

  /** Pointer lifted, cancelled, released elsewhere or capture lost (idempotent). */
  up(id: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    this.pointers.delete(id);
    if (p.zone === 'fire') this.hub.setFireHeld('touch', [...this.pointers.values()].some((q) => q.zone === 'fire'));
    if (p.zone === 'move') {
      const i = this.steer.indexOf(id);
      if (i >= 0) this.steer.splice(i, 1);
      this.updateMove();
    }
    this.emit();
  }

  /** Forget every pointer (blur, hidden page, layout change). */
  reset(): void {
    if (this.pointers.size === 0 && this.dir === 0) return;
    this.pointers.clear();
    this.steer.length = 0;
    this.dir = 0;
    this.hub.clearSource('touch');
    this.emit();
  }

  state(): TouchPadState {
    const id = this.steer[this.steer.length - 1];
    const knob = id === undefined ? null : (this.pointers.get(id)?.x ?? null);
    const pressed = { move: false, fire: false, pause: false };
    for (const p of this.pointers.values()) pressed[p.zone] = true;
    return { moveDir: this.dir, knob, pressed };
  }

  /** Recompute direction; returns true when it changed. */
  private updateMove(): boolean {
    const id = this.steer[this.steer.length - 1];
    const p = id === undefined ? undefined : this.pointers.get(id);
    const next: MoveDir = p ? moveDirFor(p.x, this.dir) : 0;
    // re-assert if the hub was cleared meanwhile (e.g. a menu click cleared input)
    if (next === this.dir && this.hub.moveOf('touch') === next) return false;
    const changed = next !== this.dir;
    this.dir = next;
    this.hub.setMove('touch', next);
    return changed;
  }

  private emit(): void {
    this.onChange?.(this.state());
  }
}
