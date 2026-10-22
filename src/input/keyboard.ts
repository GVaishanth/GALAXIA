/**
 * Keyboard adapter -> InputHub (source 'keyboard').
 *
 * Keys: Left/Right or A/D move; Space (also Z or X) fires; P or Escape
 * pause/resume; Enter confirms (starts from the title). Menus handle their
 * own Up/Down navigation (ui/screens.ts); a focused button keeps Enter/Space.
 *
 * Guards:
 * - typing in an editable field (text input, textarea, select,
 *   contenteditable) or composing with an IME never reaches the game;
 * - Ctrl / Cmd / Alt combinations are left to the browser (Ctrl+D, Cmd+R);
 * - auto-repeat never re-triggers fire, pause or confirm (holding P cannot
 *   toggle pause on and off); repeats of a held direction are harmless;
 * - key-up always releases a direction, whatever has focus, so nothing sticks.
 */
import type { Action, InputHub, MoveDir } from './inputHub.ts';

export type { Action } from './inputHub.ts';

const KEYMAP: Readonly<Record<string, Action>> = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Space: 'fire',
  KeyZ: 'fire',
  KeyX: 'fire',
  KeyP: 'pause',
  Escape: 'pause',
  Enter: 'start',
  NumpadEnter: 'start',
};

/** Keys a focused menu control handles itself (activate / adjust). */
/**
 * Keys that mean "the player is using a keyboard" (Stage 8): the game keys plus
 * menu navigation and mute. Used to switch a touch device to the keyboard
 * layout; system keys (volume, media, modifiers) never count.
 */
export const LAYOUT_SWITCH_KEYS: ReadonlySet<string> = new Set([...Object.keys(KEYMAP), 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'KeyM']);

const CONTROL_KEYS: ReadonlySet<string> = new Set(['Enter', 'NumpadEnter', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const CONTROL_TAGS: ReadonlySet<string> = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A']);
/** <input> types that do not take typed text. */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image']);

interface TargetLike {
  readonly tagName?: unknown;
  readonly type?: unknown;
  readonly isContentEditable?: unknown;
}

/**
 * True when a key event belongs to a focused menu control (a button pressed
 * with Enter/Space, a slider moved with arrows) and must not also reach the
 * game. Touch-pad buttons use pointer events, so they are unaffected.
 */
export function isControlKey(e: Pick<KeyboardEvent, 'code' | 'target'>): boolean {
  const t = e.target as TargetLike | null;
  return !!t && typeof t.tagName === 'string' && CONTROL_TAGS.has(t.tagName) && CONTROL_KEYS.has(e.code);
}

/** True for elements that accept typed text: no game key may leak from them. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const t = target as TargetLike | null;
  if (!t) return false;
  if (t.isContentEditable === true) return true;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.tagName === 'INPUT') return !NON_TEXT_INPUTS.has(String(t.type ?? 'text').toLowerCase());
  return false;
}

export type KeyLike = Pick<KeyboardEvent, 'code' | 'repeat' | 'target' | 'ctrlKey' | 'metaKey' | 'altKey'> & {
  readonly isComposing?: boolean;
  preventDefault(): void;
};

type Listener = (e: KeyboardEvent) => void;
export interface KeyTarget {
  addEventListener(type: 'keydown' | 'keyup', listener: Listener): void;
  removeEventListener(type: 'keydown' | 'keyup', listener: Listener): void;
}

export class KeyboardInput {
  private readonly hub: InputHub;
  /** Held directions in press order (the last one wins). */
  private readonly held: ('left' | 'right')[] = [];
  /** Fire keys currently down (Space, Z, X): the hold lasts until the last one is released. */
  private readonly fireKeys = new Set<string>();
  private detach: (() => void) | null = null;

  constructor(hub: InputHub) {
    this.hub = hub;
  }

  attach(target: KeyTarget): void {
    this.dispose();
    const down: Listener = (e) => this.keyDown(e);
    const up: Listener = (e) => this.keyUp(e);
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    this.detach = () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
    };
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
  }

  /** Returns true when the key was taken by the game. */
  keyDown(e: KeyLike): boolean {
    const action = KEYMAP[e.code];
    if (!action) return false;
    if (e.isComposing || isEditableTarget(e.target)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (isControlKey(e)) return false;
    e.preventDefault(); // no page scroll on Space / arrows
    if (action === 'left' || action === 'right') {
      if (!this.held.includes(action)) this.held.push(action);
      this.sync();
      if (!e.repeat) this.hub.pressCount.keyboard += 1;
      return true;
    }
    if (action === 'fire' && !e.repeat) {
      // a hold starts on the real press only: a stray auto-repeat (focus came back mid-hold) never autofires
      this.fireKeys.add(e.code);
      this.hub.setFireHeld('keyboard', true);
    }
    if (e.repeat) return true; // swallowed, but never re-triggers (holding fire is the hold above, paced by the engine)
    this.hub.press(action, 'keyboard');
    return true;
  }

  keyUp(e: Pick<KeyboardEvent, 'code'>): void {
    const action = KEYMAP[e.code];
    if (action === 'fire') {
      this.fireKeys.delete(e.code);
      if (this.fireKeys.size === 0) this.hub.setFireHeld('keyboard', false);
      return;
    }
    if (action !== 'left' && action !== 'right') return;
    const i = this.held.indexOf(action);
    if (i >= 0) this.held.splice(i, 1);
    this.sync();
  }

  /** Forget held keys (blur, visibility loss). */
  reset(): void {
    this.held.length = 0;
    this.fireKeys.clear();
    this.hub.setFireHeld('keyboard', false);
    this.sync();
  }

  private sync(): void {
    const last = this.held[this.held.length - 1];
    const dir: MoveDir = last === 'left' ? -1 : last === 'right' ? 1 : 0;
    this.hub.setMove('keyboard', dir);
  }
}
