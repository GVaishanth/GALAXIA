/**
 * Gamepad input (Stage 8): W3C Gamepad API, polled once per animation frame.
 *
 * GamepadModel is pure (no DOM, no navigator): it turns successive snapshots
 * into a horizontal move direction (left stick or D-pad, with a dead zone and
 * hysteresis) and button *edges* (one press = one event, like keyboard and
 * touch: no auto-fire). Menu directions auto-repeat while held.
 *
 * GamepadInput is the thin browser adapter: it merges every connected pad
 * (so any controller works without a "player 1" choice) and reports whether
 * the player is actively using a pad, so the UI can hide touch controls.
 *
 * What a press *means* (fire in play, select in a menu) is decided by the
 * caller (game/app.ts) from the current screen; the engine never sees pads.
 */
import { GAMEPAD } from '../config/devices.ts';
import type { MoveDir } from './inputHub.ts';

/** Named buttons the game uses (standard mapping). */
export type PadButton = 'a' | 'b' | 'x' | 'y' | 'select' | 'start' | 'up' | 'down' | 'left' | 'right';

export interface PadSnapshot {
  /** axes[0] = left stick X, axes[1] = left stick Y (-1 up .. 1 down). */
  readonly axes: readonly number[];
  /** pressed[i] for standard button index i. */
  readonly pressed: readonly boolean[];
}

export interface PadUpdate {
  /** Held horizontal direction for gameplay (stick or D-pad). */
  readonly moveX: MoveDir;
  /** Button edges this poll; menu directions include auto-repeats. */
  readonly presses: readonly PadButton[];
  /** True when any button is down or a stick is past the dead zone (the player is using a pad). */
  readonly active: boolean;
  /** A or X held (hold-to-fire, TD-74). False for a button already held through a reset until it is released. */
  readonly fireHeld: boolean;
}

type Cfg = typeof GAMEPAD;
const EDGE_BUTTONS: readonly PadButton[] = ['a', 'b', 'x', 'y', 'select', 'start'];
const DIRS: readonly ('up' | 'down' | 'left' | 'right')[] = ['up', 'down', 'left', 'right'];

export class GamepadModel {
  private prev: Partial<Record<PadButton, boolean>> = {};
  private moveDir: MoveDir = 0;
  /** Stick-only direction (hysteresis must not latch onto a D-pad direction). */
  private stickDir: MoveDir = 0;
  /** Next auto-repeat time per held menu direction (ms). */
  private repeatAt: Partial<Record<'up' | 'down' | 'left' | 'right', number>> = {};
  /** After reset(): adopt the next snapshot without edges (a button held through a blur must not fire). */
  private suppress = false;
  /** Set by reset(): a fire button held through it does not count as held until released. */
  private fireBlocked = false;

  private readonly cfg: Cfg;

  constructor(cfg: Cfg = GAMEPAD) {
    this.cfg = cfg;
  }

  /** Feed one poll. `snap` null = no pad connected (everything released). */
  update(snap: PadSnapshot | null, nowMs: number): PadUpdate {
    if (!snap) {
      // no pad: forget state, but do not suppress. Browsers expose a pad only
      // after its first button press, and that press must count.
      this.clearState();
      return { moveX: 0, presses: [], active: false, fireHeld: false };
    }
    const b = this.cfg.buttons;
    const btn = (i: number): boolean => snap.pressed[i] === true;
    const ax = (i: number): number => {
      const v = snap.axes[i];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    const x = ax(0);
    const y = ax(1);

    // gameplay movement: D-pad wins over the stick; stick has a dead zone with hysteresis
    const pad = btn(b.left) === btn(b.right) ? 0 : btn(b.left) ? -1 : 1;
    let stick: MoveDir = 0;
    const keep = this.stickDir !== 0 && Math.sign(x) === this.stickDir && Math.abs(x) >= this.cfg.deadZone - this.cfg.hysteresis;
    if (keep) stick = this.stickDir;
    else if (Math.abs(x) >= this.cfg.deadZone) stick = x < 0 ? -1 : 1;
    this.stickDir = stick;
    this.moveDir = pad !== 0 ? (pad as MoveDir) : stick;

    const now: Record<PadButton, boolean> = {
      a: btn(b.a),
      b: btn(b.b),
      x: btn(b.x),
      y: btn(b.y),
      select: btn(b.select),
      start: btn(b.start),
      up: btn(b.up) || y <= -this.cfg.menuAxis,
      down: btn(b.down) || y >= this.cfg.menuAxis,
      left: btn(b.left) || x <= -this.cfg.menuAxis,
      right: btn(b.right) || x >= this.cfg.menuAxis,
    };

    const presses: PadButton[] = [];
    const fireDown = now.a === true || now.x === true;
    if (!fireDown) this.fireBlocked = false;
    const fireHeld = fireDown && !this.fireBlocked;
    if (this.suppress) {
      this.suppress = false;
      this.prev = now;
      for (const d of DIRS) if (now[d]) this.repeatAt[d] = Infinity; // held through the reset: no repeats until released
      return { moveX: this.moveDir, presses, active: false, fireHeld: false };
    }
    for (const k of EDGE_BUTTONS) if (now[k] && !this.prev[k]) presses.push(k);
    for (const d of DIRS) {
      if (!now[d]) {
        delete this.repeatAt[d];
        continue;
      }
      if (!this.prev[d]) {
        presses.push(d);
        this.repeatAt[d] = nowMs + this.cfg.repeatDelayMs;
      } else if (nowMs >= (this.repeatAt[d] ?? Infinity)) {
        presses.push(d);
        this.repeatAt[d] = nowMs + this.cfg.repeatIntervalMs;
      }
    }
    this.prev = now;
    const active = Object.values(now).some(Boolean) || this.moveDir !== 0 || Math.abs(y) >= this.cfg.deadZone;
    return { moveX: this.moveDir, presses, active, fireHeld };
  }

  /** Forget all held state (blur, hidden page). Buttons still held afterwards are ignored until released. */
  reset(): void {
    this.clearState();
    this.suppress = true;
    this.fireBlocked = true;
  }

  private clearState(): void {
    this.prev = {};
    this.moveDir = 0;
    this.stickDir = 0;
    this.repeatAt = {};
  }
}

/** Merge several pads into one snapshot (any pad can play). */
export function mergeSnapshots(pads: readonly PadSnapshot[]): PadSnapshot | null {
  if (pads.length === 0) return null;
  if (pads.length === 1) return pads[0]!;
  const axes: number[] = [];
  const pressed: boolean[] = [];
  for (const p of pads) {
    p.axes.forEach((v, i) => {
      if (Math.abs(v) > Math.abs(axes[i] ?? 0)) axes[i] = v;
    });
    p.pressed.forEach((v, i) => {
      pressed[i] = (pressed[i] ?? false) || v;
    });
  }
  return { axes, pressed };
}

interface GamepadLike {
  readonly connected: boolean;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

/** Browser adapter: reads navigator.getGamepads() once per frame. */
export class GamepadInput {
  readonly model: GamepadModel;
  /** Connected pads at the last poll (diagnostics / UI). */
  connected = 0;

  private readonly getPads: () => readonly (GamepadLike | null)[];

  constructor(getPads: () => readonly (GamepadLike | null)[] = defaultGetPads, model: GamepadModel = new GamepadModel()) {
    this.getPads = getPads;
    this.model = model;
  }

  poll(nowMs: number): PadUpdate {
    let pads: readonly (GamepadLike | null)[] = [];
    try {
      pads = this.getPads();
    } catch {
      pads = []; // blocked by permissions policy or unsupported
    }
    const snaps: PadSnapshot[] = [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      // treat analogue triggers/buttons as pressed past half travel
      snaps.push({ axes: p.axes, pressed: p.buttons.map((b) => b.pressed || b.value > 0.5) });
    }
    this.connected = snaps.length;
    return this.model.update(mergeSnapshots(snaps), nowMs);
  }

  reset(): void {
    this.model.reset();
  }
}

function defaultGetPads(): readonly (GamepadLike | null)[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
  return navigator.getGamepads();
}
