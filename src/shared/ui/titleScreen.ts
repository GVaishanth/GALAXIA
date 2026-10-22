/**
 * GALAXIA title screen / mode select (Free Roam Prompt 2). DOM menu over a
 * moving pixel starfield (FR-TD-81), with two cards that say at a glance what each mode
 * is: Classic = one fixed screen, left/right, formations; Free Roam = open
 * space, any direction, a universe to navigate.
 *
 * Resource rules: the starfield animates only while the screen is shown and
 * reduced motion is off (one frame loop that repaints only when a star moved
 * by a whole pixel; with reduced motion the sky is painted once, on show and
 * resize); keyboard and pointer listeners exist only while the screen is
 * shown; gamepad polling runs only while shown AND a pad is connected.
 * `hide()` releases all of it, so a running mode never shares the page with
 * title-screen work.
 */
import type { SpriteCache } from '../../render/sprite/spriteCache.ts';
import { isEditableTarget } from '../../input/keyboard.ts';
import { GamepadReader } from '../input/gamepadReader.ts';
import { DisposableScope } from '../lifecycle/scope.ts';
import { logoCanvas } from '../rendering/pixelArt.ts';
import { TITLE_STARS, TitleStarfield } from '../rendering/titleStarfield.ts';
import { classicArt, freeRoamArt } from './modeArt.ts';
import { MenuList } from './menuList.ts';

export type TitleChoice = 'classic' | 'freeroam';

export interface TitleModel {
  /** e.g. "HIGH SCORE 33480 · STAGE 4" */
  readonly classicMeta: string;
  readonly freeRoamMeta: string;
  readonly notices: readonly string[];
  readonly error?: string | undefined;
}

export interface TitleCallbacks {
  readonly onSelect: (choice: TitleChoice) => void;
  readonly onMove?: (() => void) | undefined;
  /** The game's reduced-motion setting (shared prefs + system); true keeps the sky still. Default: the system setting. */
  readonly reducedMotion?: (() => boolean) | undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export class TitleScreen {
  readonly root: HTMLElement;
  private readonly cb: TitleCallbacks;
  private readonly stars: HTMLCanvasElement;
  private readonly field = new TitleStarfield(7);
  private starsAnimating = false;
  private readonly menu: MenuList;
  private readonly meta: Record<TitleChoice, HTMLElement>;
  private readonly notices: HTMLElement;
  private readonly cards: Record<TitleChoice, HTMLButtonElement>;
  private scope: DisposableScope | null = null;
  private focused: TitleChoice = 'classic';
  /** Times show() was called (diagnostics). */
  shows = 0;

  constructor(parent: HTMLElement, sprites: SpriteCache, cb: TitleCallbacks) {
    this.cb = cb;
    this.root = el('section', 'title-screen');
    this.root.setAttribute('aria-label', 'GALAXIA: choose a mode');
    this.root.hidden = true;
    this.stars = el('canvas', 'title-stars');
    this.stars.setAttribute('aria-hidden', 'true');

    const inner = el('div', 'title-inner');
    const heading = el('h1', 'title-logo');
    const logo = logoCanvas(1);
    logo.setAttribute('aria-hidden', 'true');
    heading.append(logo, el('span', 'sr-only', 'GALAXIA'));
    const kicker = el('p', 'title-kicker', 'SELECT MODE');

    const list = el('div', 'mode-cards');
    const make = (choice: TitleChoice, tag: string, name: string, desc: string, art: HTMLCanvasElement): HTMLButtonElement => {
      const b = el('button', `mode-card mode-card-${choice}`);
      b.type = 'button';
      b.dataset['mode'] = choice;
      const artBox = el('span', 'mode-card-art');
      art.setAttribute('aria-hidden', 'true');
      artBox.append(art);
      const meta = el('span', 'mode-card-meta');
      b.append(artBox, el('span', 'mode-card-tag', tag), el('span', 'mode-card-name', name), el('span', 'mode-card-desc', desc), meta);
      b.addEventListener('click', () => this.cb.onSelect(choice)); // element-owned: removed with the element
      b.addEventListener('focus', () => (this.focused = choice));
      this.meta[choice] = meta;
      return b;
    };
    this.meta = {} as Record<TitleChoice, HTMLElement>;
    this.cards = {
      classic: make('classic', 'ARCADE · ONE SCREEN', 'CLASSIC', 'Fixed-screen arcade action: hold the line against diving formations.', classicArt(sprites)),
      freeroam: make('freeroam', 'EXPLORE · ANY DIRECTION', 'FREE ROAM', 'Fly freely through open space and chart a navigable universe.', freeRoamArt(sprites)),
    };
    list.append(this.cards.classic, this.cards.freeroam);
    this.menu = new MenuList(list, () => this.cb.onMove?.());

    const hint = el('p', 'title-hint');
    hint.append(el('span', 'title-hint-keys', '← → / ↑ ↓ CHOOSE · ENTER START'), el('span', 'title-hint-touch', 'TAP A MODE TO START'));
    this.notices = el('div', 'title-notices');
    this.notices.setAttribute('role', 'status');
    inner.append(heading, kicker, list, hint, this.notices);
    this.root.append(this.stars, inner);
    parent.append(this.root);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(model: TitleModel): void {
    this.shows += 1;
    this.meta.classic.textContent = model.classicMeta;
    this.meta.freeroam.textContent = model.freeRoamMeta;
    const lines = [...(model.error ? [model.error] : []), ...model.notices];
    this.notices.replaceChildren(...lines.map((t, i) => el('p', i === 0 && model.error ? 'title-notice is-error' : 'title-notice', t)));
    this.root.hidden = false;
    this.attach();
    this.paintStars();
    this.menu.focus(this.focused === 'classic' ? 0 : 1);
  }

  hide(): void {
    this.root.hidden = true;
    this.scope?.dispose();
    this.scope = null;
  }

  /** Listeners / loops currently held by the title screen (0 while hidden), and the starfield's state. */
  debug(): { listeners: number; loops: number; starsAnimating: boolean; starPaints: number } {
    return { listeners: this.scope?.activeListeners ?? 0, loops: this.scope?.activeLoops ?? 0, starsAnimating: this.starsAnimating, starPaints: this.field.paints };
  }

  private reduced(): boolean {
    if (this.cb.reducedMotion) return this.cb.reducedMotion();
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private attach(): void {
    this.scope?.dispose();
    const scope = new DisposableScope();
    this.scope = scope;
    scope.on<KeyboardEvent>(window, 'keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
      const prev = e.code === 'ArrowLeft' || e.code === 'ArrowUp' || e.code === 'KeyA' || e.code === 'KeyW';
      const next = e.code === 'ArrowRight' || e.code === 'ArrowDown' || e.code === 'KeyD' || e.code === 'KeyS';
      if (prev || next) {
        e.preventDefault();
        this.menu.move(prev ? -1 : 1);
      } else if ((e.code === 'Enter' || e.code === 'Space') && this.menu.focusedIndex() < 0) {
        // focus is outside the cards (e.g. after a click elsewhere): Enter still starts the highlighted mode
        e.preventDefault();
        if (!e.repeat) this.menu.activate();
      }
    });
    scope.observer(new ResizeObserver(() => this.paintStars())).observe(this.root);
    this.animateStars(scope);

    // gamepad: poll only while shown and a pad is present (no idle loop for keyboard / touch players)
    const pad = new GamepadReader();
    let loop: { stop(): void; readonly running: boolean } | null = null;
    const startPad = (): void => {
      if (loop?.running) return;
      pad.reset(); // a button held while the screen appeared must not fire
      loop = scope.frameLoop((ts) => {
        const { update } = pad.poll(ts);
        if (pad.connected === 0) return false;
        for (const b of update.presses) {
          if (b === 'up' || b === 'left') this.menu.move(-1);
          else if (b === 'down' || b === 'right') this.menu.move(1);
          else if (b === 'a' || b === 'start') {
            this.menu.activate();
            return false; // a mode is starting; this screen is going away
          }
        }
        return true;
      });
    };
    scope.on(window, 'gamepadconnected', startPad);
    const pads = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    if ([...pads].some((p) => p?.connected)) startPad();
  }

  /**
   * Cruise the starfield while shown (FR-TD-81). One frame loop; it repaints
   * only when a layer moved by a whole pixel. The pointer (mouse hover or a
   * dragging finger) leans the view; it eases back when the pointer leaves.
   * Reduced motion: no loop and no look-around, the sky stays still. Turning
   * the system setting on or off while the screen is open takes effect at once.
   */
  private animateStars(scope: DisposableScope): void {
    let loop: { stop(): void; readonly running: boolean } | null = null;
    let last: number | null = null;
    const stop = (): void => {
      loop?.stop();
      loop = null;
      this.starsAnimating = false;
      this.field.look(null);
    };
    const start = (): void => {
      if (loop?.running || this.reduced()) return;
      last = null;
      this.starsAnimating = true;
      loop = scope.frameLoop((ts) => {
        const g = this.stars.getContext('2d');
        if (last !== null) this.field.step(ts - last);
        last = ts;
        if (g) this.field.draw(g);
        return true;
      });
    };
    const lookAt = (e: PointerEvent): void => {
      if (!this.starsAnimating) return;
      const r = this.root.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) this.field.look((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    scope.on<PointerEvent>(this.root, 'pointermove', lookAt);
    scope.on<PointerEvent>(this.root, 'pointerdown', lookAt);
    const release = (e: PointerEvent): void => {
      if (e.type === 'pointerleave' || e.pointerType !== 'mouse') this.field.look(null);
    };
    scope.on<PointerEvent>(this.root, 'pointerup', release);
    scope.on<PointerEvent>(this.root, 'pointercancel', release);
    scope.on<PointerEvent>(this.root, 'pointerleave', release);
    if (typeof window.matchMedia === 'function') {
      scope.on(window.matchMedia('(prefers-reduced-motion: reduce)'), 'change', () => {
        if (this.reduced()) {
          stop();
          this.paintStars(true);
        } else start();
      });
    }
    scope.add(() => {
      this.starsAnimating = false;
    });
    start();
  }

  /** Size the half-resolution star canvas to the screen and paint the current frame (on show, resize and setting changes). */
  private paintStars(force = false): void {
    if (this.root.hidden) return;
    const w = Math.max(1, Math.round(this.root.clientWidth / TITLE_STARS.pixel));
    const h = Math.max(1, Math.round(this.root.clientHeight / TITLE_STARS.pixel));
    const c = this.stars;
    const resized = c.width !== w || c.height !== h;
    if (resized) {
      c.width = w; // only when the size really changes: no per-frame reallocation
      c.height = h;
    }
    this.field.resize(w, h);
    const g = c.getContext('2d');
    if (g) this.field.draw(g, resized || force);
  }
}
