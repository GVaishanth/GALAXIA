/**
 * DOM menu screens over the playfield: title, how to play, settings, pause
 * and game over. One small panel per screen, created once and toggled
 * (no per-frame DOM churn). Text is real DOM text (readable, high contrast,
 * screen-reader friendly); the canvas keeps the art.
 *
 * Keyboard: Up/Down (or W/S) move focus, Enter/Space activate, Escape goes
 * back from sub-panels. Pause/resume keys (P, Esc on the pause screen) are
 * left to the game input so behaviour matches play.
 * Gamepad (Stage 8): app.ts calls navigate / activate / back / adjust, the
 * same paths the keyboard uses, so both behave identically.
 */
import { UI_SCALE } from '../config/devices.ts';
import { CLASSIC_SCORING } from '../config/scoring.ts';
import { PLAYFIELD_ART } from '../config/visual.ts';
import { isEditableTarget } from '../input/keyboard.ts';
import type { AudioPrefs, DisplayPrefs } from '../persistence/saveData.ts';
import type { PlayfieldRect } from './hud.ts';

/** Screens that may use the whole game area on touch layouts (see setPlayfieldRect). */
const PAGE_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['howTo', 'settings']);

/** Horizontal extent (stage coordinates) the overlay screens may span. */
export interface MenuBand {
  readonly left: number;
  readonly width: number;
}

/**
 * Box of the menu layer, in stage coordinates (pure, Stage 9 / TD-72).
 * Overlay screens (title, pause, game over) follow the playfield vertically
 * across `band` (the play area: the safe width on desktop, the column between
 * the touch controls in landscape); page screens use `pageArea` when the
 * layout provides one.
 */
export function menuBox(screen: ScreenId, r: PlayfieldRect, band: MenuBand, pageArea: PlayfieldRect | null): PlayfieldRect {
  if (pageArea !== null && PAGE_SCREENS.has(screen)) return pageArea;
  return { left: band.left, top: r.top, width: band.width, height: r.height };
}
import { MENUS, type MenuAction, type MenuItem, type ScreenId } from './screenModel.ts';

export type SettingChange =
  | { readonly kind: 'muted'; readonly value: boolean }
  | { readonly kind: 'volume'; readonly bus: 'master' | 'sfx' | 'music'; readonly value: number; readonly commit: boolean }
  | { readonly kind: 'glow'; readonly value: boolean }
  | { readonly kind: 'pixelPerfect'; readonly value: boolean }
  /** Classic presentation (TD-73): false = Responsive Display, true = Arcade Display. */
  | { readonly kind: 'arcadeDisplay'; readonly value: boolean }
  | { readonly kind: 'reducedMotion'; readonly value: DisplayPrefs['reducedMotion'] }
  /** Page fullscreen (TD-72): not a saved preference, the browser owns the state. */
  | { readonly kind: 'fullscreen'; readonly value: boolean };

export interface ScreensOptions {
  readonly onAction: (action: MenuAction) => void;
  readonly onSetting: (change: SettingChange) => void;
  /** Focus moved between items (UI blip). */
  readonly onNavigate?: () => void;
}

export interface GameOverInfo {
  readonly score: string;
  readonly stage: number;
  readonly newHighScore: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * Keep a focused item visible inside a scrolling panel (small screens) by
 * scrolling the PANEL only. focus() uses preventScroll so the game stage and
 * the page never shift; without this, keyboard / gamepad navigation could land
 * on an item below the panel's fold.
 */
export function revealInPanel(panel: RevealPanel, item: RevealItem): void {
  if (panel.scrollHeight <= panel.clientHeight + 1) return;
  const p = panel.getBoundingClientRect();
  const r = item.getBoundingClientRect();
  if (r.bottom > p.bottom) panel.scrollTop += r.bottom - p.bottom + 4;
  else if (r.top < p.top) panel.scrollTop -= p.top - r.top + 4;
}

/** The parts of a panel / item revealInPanel reads (DOM elements in the game; plain objects in tests). */
export interface RevealPanel {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  scrollTop: number;
  getBoundingClientRect(): { readonly top: number; readonly bottom: number };
}
export interface RevealItem {
  getBoundingClientRect(): { readonly top: number; readonly bottom: number };
}

/** Arcade Display Mode switch copy (TD-73): the selected presentation, in a few words. */
const ARCADE_COPY = {
  off: { mode: 'RESPONSIVE DISPLAY', detail: 'Playfield fills your screen' },
  on: { mode: 'ARCADE DISPLAY', detail: 'Centred, framed arcade screen' },
} as const;
/** Unique ids per Screens instance (aria-labelledby / aria-describedby). */
let switchIds = 0;

const MOTION_LABEL: Readonly<Record<DisplayPrefs['reducedMotion'], string>> = { system: 'SYSTEM', on: 'REDUCED', off: 'FULL' };
const MOTION_NEXT: Readonly<Record<DisplayPrefs['reducedMotion'], DisplayPrefs['reducedMotion']>> = { system: 'on', on: 'off', off: 'system' };

export class Screens {
  readonly root: HTMLElement;
  private readonly panels: Record<Exclude<ScreenId, 'none'>, HTMLElement>;
  private current: ScreenId = 'none';
  private lastRect = '';
  private geometry: { r: PlayfieldRect; band: MenuBand; pageArea: PlayfieldRect | null } | null = null;
  private readonly opts: ScreensOptions;
  private readonly controls: {
    mute: HTMLButtonElement;
    volumes: Record<'master' | 'sfx' | 'music', HTMLInputElement>;
    volumeOut: Record<'master' | 'sfx' | 'music', HTMLElement>;
    glow: HTMLButtonElement;
    pixel: HTMLButtonElement;
    motion: HTMLButtonElement;
    fullscreen: HTMLButtonElement;
    fullscreenRow: HTMLElement;
    arcade: { button: HTMLButtonElement; state: HTMLElement; mode: HTMLElement; detail: HTMLElement };
  };
  private fullscreenOn = false;
  private readonly gameOver: { score: HTMLElement; stage: HTMLElement; best: HTMLElement };
  private audio: AudioPrefs | null = null;
  private display: DisplayPrefs | null = null;
  private detachKeys: (() => void) | null = null;
  /** TD-77: keeps the focused item in view whenever a panel box changes size, whatever caused it. */
  private focusObserver: ResizeObserver | null = null;
  /** TD-77: the menu button that opened SETTINGS / HOW TO PLAY; focus returns to it when that panel closes. */
  private opener: HTMLElement | null = null;

  constructor(container: HTMLElement, options: ScreensOptions) {
    this.opts = options;
    this.root = el('div', 'screens');

    const title = this.panel('title', 'screen-title', 'GALAXIA main menu');
    title.append(this.menu(MENUS.title), this.hint('↑ ↓ · ENTER TO SELECT', 'TAP TO SELECT', 'D-PAD · A TO SELECT'));

    const pause = this.panel('pause', 'screen-pause', 'Paused');
    pause.append(el('h2', 'screen-heading', 'PAUSED'), this.menu(MENUS.pause), this.hint('P / ESC TO RESUME', 'II TO RESUME', 'START / B TO RESUME'));

    const over = this.panel('gameOver', 'screen-over', 'Game over');
    const score = el('p', 'screen-score');
    const stage = el('p', 'screen-sub');
    const best = el('p', 'screen-best', 'NEW HIGH SCORE');
    over.append(el('h2', 'screen-heading screen-heading-accent', 'GAME OVER'), score, stage, best, this.menu(MENUS.gameOver));
    this.gameOver = { score, stage, best };

    const how = this.panel('howTo', 'screen-howto', 'How to play');
    how.append(el('h2', 'screen-heading', 'HOW TO PLAY'), this.howToContent(), this.menu([{ id: 'back', label: 'BACK', action: 'back' }]));

    const settings = this.panel('settings', 'screen-settings', 'Settings');
    const list = el('div', 'screen-settings-list');
    const mute = this.toggle('SOUND', () => this.opts.onSetting({ kind: 'muted', value: !(this.audio?.muted ?? false) }));
    const volumes = {} as Record<'master' | 'sfx' | 'music', HTMLInputElement>;
    const volumeOut = {} as Record<'master' | 'sfx' | 'music', HTMLElement>;
    list.append(mute.row);
    for (const [bus, label] of [['master', 'VOLUME'], ['sfx', 'EFFECTS'], ['music', 'JINGLES']] as const) {
      const row = el('label', 'screen-row');
      const name = el('span', 'screen-row-label', label);
      const input = el('input', 'screen-range');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '5';
      input.setAttribute('aria-label', `${label} volume`);
      const out = el('span', 'screen-row-value');
      input.addEventListener('input', () => this.opts.onSetting({ kind: 'volume', bus, value: Number(input.value) / 100, commit: false }));
      input.addEventListener('change', () => this.opts.onSetting({ kind: 'volume', bus, value: Number(input.value) / 100, commit: true }));
      row.append(name, input, out);
      list.append(row);
      volumes[bus] = input;
      volumeOut[bus] = out;
    }
    const arcade = this.displaySwitch();
    list.append(arcade.row);
    const glow = this.toggle('GLOW', () => this.opts.onSetting({ kind: 'glow', value: !(this.display?.glow ?? true) }));
    const pixel = this.toggle('PIXEL SCALE', () => this.opts.onSetting({ kind: 'pixelPerfect', value: !(this.display?.pixelPerfect ?? false) }));
    const motion = this.toggle('MOTION', () => this.opts.onSetting({ kind: 'reducedMotion', value: MOTION_NEXT[this.display?.reducedMotion ?? 'system'] }));
    // fullscreen where supported (shared/ui/fullscreen.ts): hidden and disabled until setFullscreen() says otherwise
    const full = this.toggle('FULLSCREEN', () => this.opts.onSetting({ kind: 'fullscreen', value: !this.fullscreenOn }));
    full.row.classList.add('screen-row-fullscreen');
    full.row.hidden = true;
    full.button.disabled = true;
    list.append(glow.row, pixel.row, motion.row, full.row);
    settings.append(el('h2', 'screen-heading', 'SETTINGS'), list, this.menu([{ id: 'back', label: 'BACK', action: 'back' }]));
    this.controls = { mute: mute.button, volumes, volumeOut, glow: glow.button, pixel: pixel.button, motion: motion.button, fullscreen: full.button, fullscreenRow: full.row, arcade };

    this.panels = { title, pause, gameOver: over, howTo: how, settings };
    for (const p of Object.values(this.panels)) {
      p.hidden = true;
      this.root.append(p);
    }
    container.append(this.root);
    this.attachKeys();
    // TD-77: a game key on a touch device switches to the keyboard layout AFTER the menu keys moved the
    // focus, so the panel is resized under an already-focused item (layout CSS first, the menu box on
    // the next frame). setPlayfieldRect reveals the focused item when the menu box changes; this
    // observer also covers a panel resized by CSS alone (no new menu box), which nothing revealed.
    // It runs after layout and before paint. It sizes nothing (not a resize system): it only scrolls
    // the open panel.
    if (typeof ResizeObserver !== 'undefined') {
      this.focusObserver = new ResizeObserver(() => this.revealFocused());
      for (const p of Object.values(this.panels)) this.focusObserver.observe(p);
    }
  }

  /** Scroll the open panel so its focused item is fully visible (no-op when nothing there is focused). */
  private revealFocused(): void {
    if (this.current === 'none') return;
    const panel = this.panels[this.current];
    const active = document.activeElement;
    if (active instanceof HTMLElement && panel.contains(active)) revealInPanel(panel, active);
  }

  get screen(): ScreenId {
    return this.current;
  }

  /** Show one screen (or none). Focus moves to its first control when it changes. */
  show(id: ScreenId): void {
    if (id === this.current) return;
    const prev = this.current;
    this.current = id;
    for (const [key, p] of Object.entries(this.panels)) p.hidden = key !== id;
    this.root.classList.toggle('screens-active', id !== 'none');
    this.applyGeometry(); // page screens may use a larger area than the overlays
    const active = document.activeElement;
    if (id === 'none') {
      // never leave focus on a hidden button (Space would "click" it during play)
      if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
      return;
    }
    const panel = this.panels[id];
    // closing SETTINGS / HOW TO PLAY: focus goes back to the button that opened it (title or pause menu)
    const opener = this.opener;
    if ((prev === 'settings' || prev === 'howTo') && opener) {
      this.opener = null;
      if (panel.contains(opener) && !opener.closest('[hidden]')) {
        opener.focus({ preventScroll: true });
        revealInPanel(panel, opener);
        return;
      }
    }
    const first = panel.querySelector<HTMLElement>('button, input');
    // Focus the first item so Enter selects it. Not on the pause screen: there,
    // Space/Enter must not resume by "clicking" RESUME (only the pause key
    // resumes, as in Stage 3); arrow keys bring focus into the menu.
    if (first && prev !== id && id !== 'pause') first.focus({ preventScroll: true });
    else if (id === 'pause' && active instanceof HTMLElement && this.root.contains(active)) active.blur();
  }

  setGameOver(info: GameOverInfo): void {
    this.gameOver.score.textContent = `SCORE ${info.score}`;
    this.gameOver.stage.textContent = `REACHED STAGE ${info.stage}`;
    this.gameOver.best.hidden = !info.newHighScore;
  }

  setPrefs(audio: AudioPrefs, display: DisplayPrefs): void {
    this.audio = audio;
    this.display = display;
    const c = this.controls;
    this.setToggle(c.mute, !audio.muted, audio.muted ? 'OFF' : 'ON');
    for (const bus of ['master', 'sfx', 'music'] as const) {
      const pct = Math.round(audio[bus] * 100);
      if (document.activeElement !== c.volumes[bus]) c.volumes[bus].value = String(pct);
      c.volumeOut[bus].textContent = `${pct}`;
      c.volumes[bus].disabled = audio.muted;
    }
    this.setToggle(c.glow, display.glow, display.glow ? 'ON' : 'OFF');
    this.setToggle(c.pixel, display.pixelPerfect, display.pixelPerfect ? 'INTEGER' : 'FIT');
    this.setToggle(c.motion, display.reducedMotion !== 'off', MOTION_LABEL[display.reducedMotion]);
    const on = display.arcadeDisplay;
    const copy = on ? ARCADE_COPY.on : ARCADE_COPY.off;
    c.arcade.button.setAttribute('aria-checked', String(on));
    c.arcade.state.textContent = on ? 'ON' : 'OFF';
    c.arcade.mode.textContent = copy.mode;
    c.arcade.detail.textContent = copy.detail;
  }

  /** Fullscreen toggle state (TD-72): the row exists only where the browser supports it. */
  setFullscreen(supported: boolean, on: boolean): void {
    this.fullscreenOn = on;
    const c = this.controls;
    c.fullscreenRow.hidden = !supported;
    c.fullscreen.disabled = !supported;
    this.setToggle(c.fullscreen, on, on ? 'ON' : 'OFF');
  }

  /**
   * Menus follow the playfield vertically but may use the full stage width,
   * and their unit never drops below UI_SCALE.menuMinUnit, so text and touch
   * targets stay usable on small playfields (landscape phones).
   *
   * `pageArea` (Stage 9, optional, in stage coordinates) is the whole safe
   * game area on touch layouts, including the space of the touch controls.
   * The reading/adjusting screens (HOW TO PLAY, SETTINGS) use it, because the
   * gameplay controls are inactive there (app.ts hides them); overlay screens
   * (title, pause, game over) stay over the playfield.
   */
  setPlayfieldRect(r: PlayfieldRect, band: MenuBand = { left: 0, width: r.left * 2 + r.width }, pageArea: PlayfieldRect | null = null): void {
    this.geometry = { r, band, pageArea };
    this.applyGeometry();
  }

  private applyGeometry(): void {
    const g = this.geometry;
    if (!g) return;
    const { r, band, pageArea } = g;
    const box = menuBox(this.current, r, band, pageArea);
    const page = box === pageArea;
    const key = `${box.left}|${box.top}|${box.width}|${box.height}|${r.width}|${page}`;
    if (key === this.lastRect) return;
    this.lastRect = key;
    const s = this.root.style;
    s.left = `${box.left}px`;
    s.top = `${box.top}px`;
    s.width = `${box.width}px`;
    s.height = `${box.height}px`;
    s.setProperty('--u', `${Math.max(UI_SCALE.menuMinUnit, (r.width / PLAYFIELD_ART.width) * 2)}px`);
    // the panel was re-sized (resize, input-device switch, display mode): keep the focused item in view
    this.revealFocused();
  }

  dispose(): void {
    this.detachKeys?.();
    this.focusObserver?.disconnect();
    this.focusObserver = null;
    this.root.remove();
  }

  /* ---------------------------------- build ---------------------------------- */

  private panel(id: ScreenId, cls: string, label: string): HTMLElement {
    const p = el('section', `screen ${cls}`);
    p.dataset['screen'] = id;
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', label);
    return p;
  }

  private menu(items: readonly MenuItem[]): HTMLElement {
    const nav = el('div', 'screen-menu');
    nav.setAttribute('role', 'menu');
    for (const item of items) {
      const b = el('button', 'screen-btn', item.label);
      b.type = 'button';
      b.dataset['action'] = item.action;
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => {
        // remembered from the click itself: Safari and touch taps do not focus a clicked button
        if (item.action === 'settings' || item.action === 'howTo') this.opener = b;
        this.opts.onAction(item.action);
      });
      nav.append(b);
    }
    return nav;
  }

  /** Hint with keyboard, touch and gamepad wording; CSS shows the one matching the device in use. */
  private hint(keys: string, touch: string, pad: string): HTMLElement {
    const p = el('p', 'screen-hint');
    p.append(el('span', 'hint-keys', keys), el('span', 'hint-touch', touch), el('span', 'hint-pad', pad));
    return p;
  }

  private toggle(label: string, onClick: () => void): { row: HTMLElement; button: HTMLButtonElement } {
    const row = el('div', 'screen-row');
    const name = el('span', 'screen-row-label', label);
    const button = el('button', 'screen-toggle');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    row.append(name, button);
    return { row, button };
  }

  /**
   * ARCADE DISPLAY MODE (TD-73): an accessible switch (role="switch" +
   * aria-checked, a visible track/thumb and ON/OFF text, >= 44 px tall) with a
   * line describing the selected presentation (aria-describedby). A plain
   * button, so the menu keys, Enter/Space, touch and the gamepad all work.
   */
  private displaySwitch(): { row: HTMLElement; button: HTMLButtonElement; state: HTMLElement; mode: HTMLElement; detail: HTMLElement } {
    const id = `screen-arcade-${++switchIds}`;
    const row = el('div', 'screen-row screen-row-switch');
    const name = el('span', 'screen-row-label', 'ARCADE DISPLAY MODE');
    name.id = `${id}-label`;
    const button = el('button', 'screen-switch');
    button.type = 'button';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', 'false');
    button.setAttribute('aria-labelledby', name.id);
    button.setAttribute('aria-describedby', `${id}-desc`);
    button.dataset['setting'] = 'arcadeDisplay';
    const track = el('span', 'screen-switch-track');
    track.setAttribute('aria-hidden', 'true');
    track.append(el('span', 'screen-switch-thumb'));
    const state = el('span', 'screen-switch-state', 'OFF');
    state.setAttribute('aria-hidden', 'true'); // aria-checked carries the state
    button.append(track, state);
    button.addEventListener('click', () => this.opts.onSetting({ kind: 'arcadeDisplay', value: !(this.display?.arcadeDisplay ?? false) }));
    const desc = el('p', 'screen-row-desc');
    desc.id = `${id}-desc`;
    const mode = el('span', 'screen-row-desc-mode', ARCADE_COPY.off.mode);
    const detail = el('span', 'screen-row-desc-detail', ARCADE_COPY.off.detail);
    desc.append(mode, detail);
    row.append(name, button, desc);
    return { row, button, state, mode, detail };
  }

  private setToggle(b: HTMLButtonElement, on: boolean, text: string): void {
    b.textContent = text;
    b.setAttribute('aria-pressed', String(on));
  }

  private howToContent(): HTMLElement {
    const box = el('div', 'screen-howto-body');
    const controls = el('dl', 'screen-keys');
    const rows: [string, string][] = [
      ['MOVE', '← → / A D'],
      ['FIRE', 'SPACE / Z / X'], // holding is explained in the rules line (one line at 320 px)
      ['PAUSE', 'P / ESC'],
      ['SELECT', '↑ ↓ + ENTER'],
      ['SOUND', 'M  (MUTE)'],
      ['TOUCH', 'SLIDE ◀ ▶ · FIRE · II · i'],
      ['GAMEPAD', 'STICK / D-PAD · A FIRE · START'],
    ];
    for (const [k, v] of rows) controls.append(el('dt', '', k), el('dd', '', v));
    const rules = el('p', 'screen-rules', 'Clear every wave. A commander may capture your fighter with its beam. Shoot that commander while it dives to free the fighter and fly as a TWIN FIGHTER with double fire. Hold fire to keep shooting, but too long overheats it.');
    const s = CLASSIC_SCORING.enemies;
    const table = el('table', 'screen-scores');
    const head = el('tr', '');
    // short headers (as in the scoring side panel) keep the table inside a 240px phone panel
    const th = (text: string, label: string): HTMLElement => {
      const cell = el('th', '', text);
      cell.setAttribute('aria-label', label);
      return cell;
    };
    head.append(th('SHIP', 'Ship'), th('FORM', 'In formation'), th('DIVE', 'Diving'));
    table.append(head);
    const add = (name: string, a: string, b: string): void => {
      const tr = el('tr', '');
      tr.append(el('td', '', name), el('td', '', a), el('td', '', b));
      table.append(tr);
    };
    add('SCOUT', String(s.scout.formation), String(s.scout.attack));
    add('INTERCEPTOR', String(s.interceptor.formation), String(s.interceptor.attack));
    add('COMMANDER', String(s.commander.formation), s.commander.attackByEscorts.join(' / '));
    box.append(controls, rules, table);
    return box;
  }

  /** Focusable items of a panel, in order. */
  private items(panel: HTMLElement): HTMLElement[] {
    return [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
  }

  /** Move focus to the next (1) or previous (-1) item; wraps. False when no menu is open. */
  navigate(dir: 1 | -1): boolean {
    if (this.current === 'none') return false;
    const items = this.items(this.panels[this.current]);
    if (items.length === 0) return false;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = i < 0 ? 0 : (i + dir + items.length) % items.length;
    const target = items[next]!;
    target.focus({ preventScroll: true });
    revealInPanel(this.panels[this.current], target);
    this.opts.onNavigate?.();
    return true;
  }

  /**
   * Activate the focused item (gamepad A). With nothing focused it only
   * focuses the first item, so a stray press can never pick an action
   * (on the pause screen that would resume the game).
   */
  activate(): boolean {
    if (this.current === 'none') return false;
    const items = this.items(this.panels[this.current]);
    const focused = items.find((n) => n === document.activeElement);
    if (!focused) return this.navigate(1);
    if (focused instanceof HTMLButtonElement) focused.click();
    return true;
  }

  /** Leave a sub-panel (how to play / settings). False elsewhere. */
  back(): boolean {
    if (this.current !== 'howTo' && this.current !== 'settings') return false;
    this.opts.onAction('back');
    return true;
  }

  /** Step a focused slider left (-1) or right (1), like arrow keys on a range input. */
  adjust(dir: 1 | -1): boolean {
    const n = document.activeElement;
    if (this.current === 'none' || !(n instanceof HTMLInputElement) || n.type !== 'range' || !this.panels[this.current].contains(n)) return false;
    const before = n.value;
    if (dir > 0) n.stepUp();
    else n.stepDown();
    if (n.value === before) return true;
    n.dispatchEvent(new Event('input', { bubbles: true }));
    n.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  private attachKeys(): void {
    const onKey = (e: KeyboardEvent): void => {
      if (this.current === 'none' || isEditableTarget(e.target)) return;
      const panel = this.panels[this.current];
      // Escape / Backspace close sub-panels (before the game sees Escape as "pause")
      if ((e.code === 'Escape' || e.code === 'Backspace') && (this.current === 'howTo' || this.current === 'settings')) {
        e.preventDefault();
        e.stopPropagation();
        this.opts.onAction('back');
        return;
      }
      const vertical = e.code === 'ArrowDown' || e.code === 'ArrowUp' || e.code === 'KeyS' || e.code === 'KeyW';
      if (!vertical || this.items(panel).length === 0) return;
      e.preventDefault();
      this.navigate(e.code === 'ArrowDown' || e.code === 'KeyS' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    this.detachKeys = () => window.removeEventListener('keydown', onKey, { capture: true });
  }
}
