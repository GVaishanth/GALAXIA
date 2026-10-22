/**
 * Held-key tracker for any mode: which key codes are down right now, plus the
 * fresh presses since the last `takePresses()`. Mode-specific meaning (move,
 * pause, confirm) is decided by each mode's own input interpretation; this
 * class only knows keys. Listeners are owned by a DisposableScope, and
 * `clear()` forgets everything (blur, pause, mode switch) so no key can stay
 * "stuck" into the next mode.
 */
import { isEditableTarget } from '../../input/keyboard.ts';
import type { DisposableScope, ListenerTarget } from '../lifecycle/scope.ts';

interface KeyEventLike {
  readonly code: string;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

export class KeyTracker {
  private readonly held = new Set<string>();
  private presses: string[] = [];
  /** Codes this mode uses: only these are tracked and have their default action (scrolling) prevented. */
  private codes: ReadonlySet<string>;

  constructor(codes: Iterable<string>) {
    this.codes = new Set(codes);
  }

  /** Replace the tracked codes (key rebinding). Held keys and pending presses are dropped so nothing stays stuck. */
  setCodes(codes: Iterable<string>): void {
    this.codes = new Set(codes);
    this.clear();
  }

  attach(scope: DisposableScope, target: ListenerTarget): void {
    scope.on<KeyEventLike>(target, 'keydown', (e) => this.down(e));
    scope.on<KeyEventLike>(target, 'keyup', (e) => this.up(e));
    scope.add(() => this.clear());
  }

  down(e: KeyEventLike): boolean {
    if (!this.codes.has(e.code) || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return false;
    e.preventDefault();
    this.held.add(e.code);
    if (!e.repeat) this.presses.push(e.code);
    return true;
  }

  up(e: Pick<KeyEventLike, 'code'> & { preventDefault?: () => void }): void {
    this.held.delete(e.code);
    // the mode handles confirm itself: keep a focused button's native Space-on-keyup click from doubling it
    if (this.codes.has(e.code)) e.preventDefault?.();
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  get heldCodes(): ReadonlySet<string> {
    return this.held;
  }

  /** Fresh presses since the last call (edge-triggered; auto-repeat excluded). */
  takePresses(): readonly string[] {
    const p = this.presses;
    this.presses = [];
    return p;
  }

  clear(): void {
    this.held.clear();
    this.presses = [];
  }
}
