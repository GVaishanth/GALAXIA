/**
 * Free Roam input interpretation (pure). Classic reads devices as left/right
 * only (Stage 8 rule) and never imports this file; Free Roam turns the same
 * devices into one controller-independent intent per tick: an analog 2-D
 * move vector, an optional aim and a fire flag, plus edge commands.
 *
 * Device plumbing (held keys, gamepad snapshots, pointers) comes from
 * shared/input and controls.ts; key meaning comes from the player's bindings
 * (controls.ts). Panels and the maps use fixed navigation keys.
 */
import type { PadSnapshot, PadUpdate } from '../../input/gamepad.ts';
import type { StickVector } from '../../shared/input/pointerStick.ts';
import { DEFAULT_BINDINGS, PANEL_KEYS, RESERVED_KEYS, ZOOM_KEYS, type Bindings, type FlightAction } from './bindings.ts';
import type { FlightInput } from './sim.ts';

/** Gamepad standard-mapping indices used by Free Roam flight. */
export const PAD = Object.freeze({ rightX: 2, rightY: 3, fire: [7, 5, 2] as readonly number[], boost: [4, 6] as readonly number[], aimDeadZone: 0.3 });

const held = (keys: ReadonlySet<string>, b: Bindings, a: FlightAction): boolean => keys.has(b[a][0]) || (b[a][1] !== null && keys.has(b[a][1]));

/** 8-way keyboard vector from the bindings, diagonals normalised to length 1. */
export function keyboardVector(keys: ReadonlySet<string>, b: Bindings = DEFAULT_BINDINGS): StickVector {
  const x = (held(keys, b, 'right') ? 1 : 0) - (held(keys, b, 'left') ? 1 : 0);
  const y = (held(keys, b, 'down') ? 1 : 0) - (held(keys, b, 'up') ? 1 : 0);
  const len = Math.hypot(x, y);
  return len > 1 ? { x: x / len, y: y / len } : { x, y };
}

export function keyboardFire(keys: ReadonlySet<string>, b: Bindings = DEFAULT_BINDINGS): boolean {
  return held(keys, b, 'fire');
}

/** Boost key held (Shift by default). */
export function keyboardBoost(keys: ReadonlySet<string>, b: Bindings = DEFAULT_BINDINGS): boolean {
  return held(keys, b, 'boost');
}

/** Left stick with a radial dead zone (rescaled so output starts at 0), or the D-pad. */
export function padVector(snap: PadSnapshot | null, deadZone = 0.2): StickVector {
  if (!snap) return { x: 0, y: 0 };
  const ax = Number.isFinite(snap.axes[0]) ? snap.axes[0]! : 0;
  const ay = Number.isFinite(snap.axes[1]) ? snap.axes[1]! : 0;
  const len = Math.hypot(ax, ay);
  if (len > deadZone) {
    const k = Math.min(1, (len - deadZone) / (1 - deadZone)) / len;
    return { x: ax * k, y: ay * k };
  }
  // standard mapping D-pad: 12 up, 13 down, 14 left, 15 right
  const p = snap.pressed;
  const x = (p[15] ? 1 : 0) - (p[14] ? 1 : 0);
  const y = (p[13] ? 1 : 0) - (p[12] ? 1 : 0);
  const l = Math.hypot(x, y);
  return l > 1 ? { x: x / l, y: y / l } : { x, y };
}

/** Right stick as an aim direction, or null inside its dead zone. */
export function padAim(snap: PadSnapshot | null): StickVector | null {
  if (!snap) return null;
  const x = Number.isFinite(snap.axes[PAD.rightX]) ? snap.axes[PAD.rightX]! : 0;
  const y = Number.isFinite(snap.axes[PAD.rightY]) ? snap.axes[PAD.rightY]! : 0;
  return Math.hypot(x, y) > PAD.aimDeadZone ? { x, y } : null;
}

/** RT, RB or X held. */
export function padFire(snap: PadSnapshot | null): boolean {
  return !!snap && PAD.fire.some((i) => snap.pressed[i] === true);
}

/** LB or LT held (boost, Prompt 8). */
export function padBoost(snap: PadSnapshot | null): boolean {
  return !!snap && PAD.boost.some((i) => snap.pressed[i] === true);
}

/** Sum of all sources, clamped to the unit disc (two devices never exceed full thrust). */
export function combineFlight(...vectors: readonly StickVector[]): FlightInput {
  let x = 0;
  let y = 0;
  for (const v of vectors) {
    x += v.x;
    y += v.y;
  }
  const len = Math.hypot(x, y);
  return len > 1 ? { moveX: x / len, moveY: y / len } : { moveX: x, moveY: y };
}

/* ----------------------------------------------------------- flight commands */

/** Edge commands during flight (fire and movement are held, not commands). */
export type FlightCommand = 'interact' | 'map' | 'cargo' | 'pause' | 'back' | 'zoomIn' | 'zoomOut';

const is = (b: Bindings, a: FlightAction, code: string): boolean => b[a][0] === code || b[a][1] === code;

export function flightKeyCommands(presses: readonly string[], b: Bindings = DEFAULT_BINDINGS): FlightCommand[] {
  const out: FlightCommand[] = [];
  for (const code of presses) {
    if (code === RESERVED_KEYS.back) out.push('back');
    else if (is(b, 'pause', code)) out.push('pause');
    else if (is(b, 'interact', code)) out.push('interact');
    else if (is(b, 'map', code)) out.push('map');
    else if (is(b, 'cargo', code)) out.push('cargo');
    else if (ZOOM_KEYS.in.includes(code)) out.push('zoomIn');
    else if (ZOOM_KEYS.out.includes(code)) out.push('zoomOut');
  }
  return out;
}

export function flightPadCommands(update: PadUpdate): FlightCommand[] {
  const out: FlightCommand[] = [];
  for (const btn of update.presses) {
    if (btn === 'start') out.push('pause');
    else if (btn === 'a') out.push('interact');
    else if (btn === 'b') out.push('back');
    else if (btn === 'select') out.push('map');
    else if (btn === 'y') out.push('cargo');
  }
  return out;
}

/* ------------------------------------------------------------ panel commands */

/** Commands inside panels (briefing, pause, map, cargo, controls...). Navigation keys are fixed. */
export type PanelCommand = 'prev' | 'next' | 'confirm' | 'back' | 'restart' | 'map' | 'cargo' | 'pause' | 'tabPrev' | 'tabNext';

export function panelKeyCommands(presses: readonly string[], b: Bindings = DEFAULT_BINDINGS): PanelCommand[] {
  const out: PanelCommand[] = [];
  for (const code of presses) {
    if (code === RESERVED_KEYS.back) out.push('back');
    else if (PANEL_KEYS.confirm.includes(code)) out.push('confirm');
    else if (PANEL_KEYS.prev.includes(code)) out.push('prev');
    else if (PANEL_KEYS.next.includes(code)) out.push('next');
    else if (PANEL_KEYS.restart.includes(code)) out.push('restart');
    else if (PANEL_KEYS.tabPrev.includes(code)) out.push('tabPrev');
    else if (PANEL_KEYS.tabNext.includes(code)) out.push('tabNext');
    else if (is(b, 'map', code)) out.push('map');
    else if (is(b, 'cargo', code)) out.push('cargo');
    else if (is(b, 'pause', code)) out.push('pause');
  }
  return out;
}

export function panelPadCommands(update: PadUpdate): PanelCommand[] {
  const out: PanelCommand[] = [];
  for (const btn of update.presses) {
    if (btn === 'a') out.push('confirm');
    else if (btn === 'b') out.push('back');
    else if (btn === 'start') out.push('pause');
    else if (btn === 'up' || btn === 'left') out.push('prev');
    else if (btn === 'down' || btn === 'right') out.push('next');
    else if (btn === 'select') out.push('map');
    else if (btn === 'y') out.push('cargo');
    else if (btn === 'x') out.push('tabNext');
  }
  return out;
}

/* ------------------------------------------------------------- galaxy map */

/** Galaxy / System Map commands: spatial focus movement plus confirm / back (Tab focus is left to the browser). */
export type MapCommand = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back';

/** Fixed map keys (the maps are menus, not flight). */
export const MAP_KEYS = Object.freeze({
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  confirm: ['Enter', 'Space'],
});

export function mapKeyCommands(presses: readonly string[]): MapCommand[] {
  const out: MapCommand[] = [];
  for (const code of presses) {
    if (MAP_KEYS.up.includes(code)) out.push('up');
    else if (MAP_KEYS.down.includes(code)) out.push('down');
    else if (MAP_KEYS.left.includes(code)) out.push('left');
    else if (MAP_KEYS.right.includes(code)) out.push('right');
    else if (MAP_KEYS.confirm.includes(code)) out.push('confirm');
    else if (code === RESERVED_KEYS.back) out.push('back');
  }
  return out;
}

export function mapPadCommands(update: PadUpdate): MapCommand[] {
  const out: MapCommand[] = [];
  for (const b of update.presses) {
    if (b === 'up' || b === 'down' || b === 'left' || b === 'right') out.push(b);
    else if (b === 'a') out.push('confirm');
    else if (b === 'b') out.push('back');
  }
  return out;
}
