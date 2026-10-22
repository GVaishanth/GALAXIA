/**
 * Mode app shell (screen-sizing unification, TD-72 / FR-TD-73): the single
 * owner of a mode's viewport, shared by Classic and Free Roam so both modes
 * size their screen with one policy:
 *
 *  - container: the mode root fills the host's display area (`.mode-shell`:
 *    absolutely positioned, inset 0, inside the 100dvh `.galaxia-root`); no
 *    page scroll (`html.game-mode`);
 *  - canvas: full-bleed in the shell (a CanvasSurface; the shared DPR and
 *    backing-store caps), never shrunk by controls or safe-area padding;
 *  - safe area: ONE source, the `--safe-*` custom properties (styles.css,
 *    `env(safe-area-inset-*)` by default). CSS positions HUDs and controls
 *    with them; this class measures the same values (two hidden probes sized
 *    left x top and right x bottom by the insets) so the scripts that place
 *    essential content (Classic's fixed arena) use exactly the numbers the
 *    CSS uses;
 *  - resize: one ResizeObserver watching the shell AND the two probes, so a
 *    change of any inset (even without a size change) re-measures at once;
 *    listeners get the new box, insets and safe box, only when something
 *    changed;
 *  - orientation: an aspect flip of the shell box counts as a rotation (once),
 *    and `orientationchange` / `screen.orientation` give the early "rotation
 *    started" signal (modes release held input and pause).
 *
 * Gameplay never reads any of this: each mode maps its own logical
 * coordinates onto the canvas (Classic letterboxes its fixed playfield,
 * Free Roam frames its camera).
 */
import type { DisposableScope } from '../lifecycle/scope.ts';

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** A box in CSS px, relative to the shell's top-left corner. */
export interface ShellBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type Orientation = 'portrait' | 'landscape';

export interface ShellState {
  /** Shell (and canvas) size in CSS px. */
  readonly width: number;
  readonly height: number;
  readonly insets: Insets;
  /** Shell box minus the safe-area insets: where essential content goes. */
  readonly safe: ShellBox;
  readonly orientation: Orientation | null;
}

export interface ShellChange extends ShellState {
  /** The orientation flipped with this change (portrait <-> landscape). */
  readonly rotated: boolean;
}

export const NO_INSETS: Insets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

/** Boxes this small are not laid out yet (hidden, collapsed): no orientation. */
const MIN_ORIENTED = 8;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Safe content box of a width x height shell (pure). Insets never invert the box. */
export function safeBox(width: number, height: number, insets: Insets): ShellBox {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const left = clamp(insets.left, 0, w);
  const right = clamp(insets.right, 0, w - left);
  const top = clamp(insets.top, 0, h);
  const bottom = clamp(insets.bottom, 0, h - top);
  return { left, top, width: w - left - right, height: h - top - bottom };
}

/** Orientation of a box (pure); null while it is not laid out. Square counts as landscape. */
export function orientationOf(width: number, height: number): Orientation | null {
  if (!(width > MIN_ORIENTED) || !(height > MIN_ORIENTED)) return null;
  return width >= height ? 'landscape' : 'portrait';
}

/** "12.5px" -> 12.5; anything unparsable or negative -> 0. */
export function cssPx(value: string | null | undefined): number {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const sameInsets = (a: Insets, b: Insets): boolean => a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;

export class AppShell implements ShellState {
  readonly root: HTMLElement;
  width = 0;
  height = 0;
  insets: Insets = NO_INSETS;
  safe: ShellBox = { left: 0, top: 0, width: 0, height: 0 };
  orientation: Orientation | null = null;
  /** Aspect flips seen so far (the first laid-out orientation is not a change). */
  orientationChanges = 0;
  /** Bumped on every change of size or insets (cheap redraw keys). */
  revision = 0;
  /** Shell measurements so far (ResizeObserver callbacks + rotation events). */
  measures = 0;
  /** Sized (left x top) and (right x bottom) by the --safe-* insets. */
  private readonly probes: readonly [HTMLElement, HTMLElement];
  private readonly changeListeners: Array<(c: ShellChange) => void> = [];
  private readonly rotateListeners: Array<() => void> = [];

  /**
   * `kind` is the mode's own shell class (e.g. 'game-app', 'freeroam-app').
   * The root keeps its existing classes (the host's `.mode-root` marker).
   */
  constructor(root: HTMLElement, scope: DisposableScope, kind: string) {
    this.root = root;
    root.classList.add('app', 'mode-shell', kind);
    const html = document.documentElement;
    html.classList.add('game-mode'); // no page scroll / overscroll while a mode runs
    scope.add(() => html.classList.remove('game-mode'));

    const probe = (edge: 'start' | 'end'): HTMLElement => {
      const p = document.createElement('div');
      p.className = `shell-safe-probe shell-safe-probe-${edge}`;
      p.setAttribute('aria-hidden', 'true');
      root.append(p);
      scope.add(() => p.remove());
      return p;
    };
    this.probes = [probe('start'), probe('end')];

    const ro = scope.observer(new ResizeObserver(() => this.measure()));
    ro.observe(root);
    for (const p of this.probes) ro.observe(p);
    const rotateStart = (): void => {
      for (const fn of this.rotateListeners) fn();
      this.measure(); // some browsers report the new insets before the box changes
    };
    scope.on(window, 'orientationchange', rotateStart);
    const so = typeof screen !== 'undefined' ? screen.orientation : undefined;
    if (so && typeof so.addEventListener === 'function') scope.on(so, 'change', rotateStart);
    this.measure();
  }

  /** Called on every real change of size, insets or orientation. */
  onChange(fn: (c: ShellChange) => void): void {
    this.changeListeners.push(fn);
  }

  /** Early rotation signal (before the new size is known). */
  onRotateStart(fn: () => void): void {
    this.rotateListeners.push(fn);
  }

  /** Re-read the shell box and insets (layout read; called on events, never per frame). */
  measure(): void {
    this.measures += 1;
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    const a = getComputedStyle(this.probes[0]);
    const b = getComputedStyle(this.probes[1]);
    const insets: Insets = { top: cssPx(a.height), right: cssPx(b.width), bottom: cssPx(b.height), left: cssPx(a.width) };
    if (width === this.width && height === this.height && sameInsets(insets, this.insets)) return;
    this.width = width;
    this.height = height;
    this.insets = insets;
    this.safe = safeBox(width, height, insets);
    const next = orientationOf(width, height);
    const rotated = next !== null && this.orientation !== null && next !== this.orientation;
    if (rotated) this.orientationChanges += 1;
    if (next !== null) this.orientation = next;
    this.revision += 1;
    const change: ShellChange = { width, height, insets, safe: this.safe, orientation: this.orientation, rotated };
    for (const fn of this.changeListeners) fn(change);
  }

  /** Read-only snapshot for diagnostics. */
  state(): ShellState & { readonly orientationChanges: number; readonly revision: number } {
    return { width: this.width, height: this.height, insets: this.insets, safe: this.safe, orientation: this.orientation, orientationChanges: this.orientationChanges, revision: this.revision };
  }
}
