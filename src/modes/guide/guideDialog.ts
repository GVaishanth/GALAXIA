/**
 * First-run tutorial and HOW TO PLAY guide: the dialog (DOM, P04.2 guide).
 *
 * One modal `role="dialog"` over whatever opened it (the title screen, or
 * Free Roam's pause menu). The text comes from guideContent.ts; this file
 * only lays it out and handles input.
 *
 *  - Modal: while open, every keydown is stopped in the capture phase on the
 *    window, so no key reaches the game or the title behind it (nothing can
 *    fire, move, switch weapons or lock on). Key-ups pass, so held keys are
 *    released. Pointer input cannot reach the page behind the scrim. Free Roam
 *    also skips its own gamepad and key presses while the guide is open.
 *  - Keyboard: ← / → (also PageUp / PageDown) change step, ↑ / ↓ move between
 *    buttons, Enter / Space press the focused button, Escape skips the tutorial
 *    (or closes the guide). Tab stays inside the dialog.
 *    In a CLASSIC / FREE ROAM or input switch, ← / → move the selection
 *    (radio-group convention).
 *  - Gamepad: polled only while open and a pad is connected (D-pad left /
 *    right = step, up / down = focus, A = press, B = skip / close).
 *  - Highlight: a step may name a live element (the mode cards, the marks
 *    readout). Its ring is placed from the element's measured bounds
 *    (getBoundingClientRect) on open, on every step and on resize, never from
 *    fixed coordinates; if the card cannot sit beside it without covering it,
 *    no ring is drawn.
 *  - Motion: a short fade between steps; none with reduced motion.
 *  - No timers and no animation loop of its own (only the gamepad poll while
 *    a pad is connected); everything is released on close.
 */
import { GamepadReader } from '../../shared/input/gamepadReader.ts';
import { DisposableScope } from '../../shared/lifecycle/scope.ts';
import {
  GUIDE_INPUTS,
  GUIDE_MODES,
  GUIDE_STEPS,
  INPUT_LABEL,
  MODE_LABEL,
  STEP_LABEL,
  guideStep,
  type ControlRow,
  type GuideBlock,
  type GuideContext,
  type GuideInput,
  type GuideMode,
  type GuideStepId,
} from './guideContent.ts';

export type GuideKind = 'tutorial' | 'reference';

export interface GuideOpenOptions {
  readonly kind: GuideKind;
  readonly context: GuideContext;
  /** First step shown (default: the first). */
  readonly step?: GuideStepId;
  /** The last step offers PLAY CLASSIC / PLAY FREE ROAM (title screen only). */
  readonly canPlay: boolean;
  /** A live element to highlight on a step, measured when shown; null for none. */
  readonly highlight?: (step: GuideStepId, ctx: GuideContext) => Element | null;
  /** Focus returns here when the guide closes. */
  readonly opener?: HTMLElement | null;
}

/** How the guide ended: FINISH / PLAY (completed), SKIP TUTORIAL (skipped) or CLOSE / Escape on the reference guide (closed). */
export interface GuideEnd {
  readonly kind: GuideKind;
  readonly how: 'completed' | 'skipped' | 'closed';
  readonly play: GuideMode | null;
  readonly context: GuideContext;
}

export interface GuideDialogDeps {
  readonly onEnd: (end: GuideEnd) => void;
  /** Step or option changed (UI blip). */
  readonly onMove?: () => void;
  readonly reducedMotion: () => boolean;
}

export interface GuideStatus {
  readonly open: boolean;
  readonly kind: GuideKind | null;
  readonly step: GuideStepId;
  readonly index: number;
  readonly mode: GuideMode;
  readonly input: GuideInput;
  readonly highlighted: boolean;
  readonly listeners: number;
  readonly loops: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(className: string, text: string): HTMLButtonElement {
  const b = el('button', `guide-btn ${className}`, text);
  b.type = 'button';
  return b;
}

/* ------------------------------------------------------------ touch diagrams */

/**
 * Schematic phone (portrait) with the touch controls where the game puts
 * them. Positions are fractions of a 390 x 844 screen, measured from the live
 * layouts (Free Roam flight HUD; Classic touch pad), so the picture matches
 * what the player sees; the rows below it are the authoritative text.
 */
interface DiagramPart {
  readonly cls: string;
  readonly label: string;
  /** left, top, width, height in % of the phone screen. */
  readonly box: readonly [number, number, number, number];
  readonly round?: boolean;
  /** Shown only in some situations (drawn dashed, with the condition). */
  readonly when?: string;
}

const FR_PARTS: readonly DiagramPart[] = [
  { cls: 'card', label: 'SHIP · ◈ MARKS', box: [2.6, 0.9, 47.2, 14] },
  { cls: 'hud', label: 'MAP CARGO II', box: [56.4, 0.9, 41, 5.2] },
  { cls: 'lock', label: 'LOCK', box: [6.7, 40, 14.4, 6.6], round: true },
  { cls: 'next', label: '»', box: [23.6, 40.8, 11.3, 5.2], round: true, when: 'while locked' },
  { cls: 'stick', label: 'DRAG TO FLY', box: [8, 58, 36, 16.6], round: true },
  { cls: 'wpn', label: 'WPN', box: [75.4, 67.3, 14.4, 6.6], round: true },
  { cls: 'boost', label: 'BOOST', box: [55.4, 87.2, 16.4, 7.6], round: true },
  { cls: 'fire', label: 'FIRE', box: [74.9, 85.8, 21.5, 10], round: true },
];

function classicParts(gate: boolean): DiagramPart[] {
  return [
    { cls: 'field', label: 'PLAYFIELD', box: [0, 0, 100, 83] },
    { cls: 'pad', label: '◀  SLIDE  ▶', box: [2.6, 84.4, 51.3, 14.7] },
    { cls: 'pause', label: 'II', box: [56.4, 84.4, 14.4, 6.9] },
    { cls: 'info', label: 'i', box: [56.4, 92.2, 14.4, 6.9] },
    gate ? { cls: 'wpn', label: 'WPN', box: [73.3, 84.4, 24.1, 5.4] } : { cls: 'wpn', label: 'WPN', box: [73.3, 84.4, 24.1, 5.4], when: 'after Wave 20' },
    { cls: 'fire', label: 'FIRE', box: [73.3, 90.4, 24.1, 8.7] },
  ];
}

function diagram(layout: 'freeroam' | 'classic', gate: boolean): HTMLElement {
  const fig = el('figure', `guide-diagram guide-diagram-${layout}`);
  const phone = el('div', 'guide-phone');
  const parts = layout === 'freeroam' ? FR_PARTS : classicParts(gate);
  phone.setAttribute('role', 'img');
  phone.setAttribute(
    'aria-label',
    layout === 'freeroam'
      ? 'Free Roam touch layout: ship card with Guild marks top left; MAP, CARGO and pause top right; LOCK on the left with NEXT TARGET beside it while locked; drag on open space to fly; the weapon button above FIRE; BOOST beside FIRE at the bottom right.'
      : `Classic touch layout: the playfield above; below it the slide pad on the left, pause and info in the middle, FIRE on the right${gate ? ' with the weapon button above it' : ', with a weapon button above it after Wave 20'}.`,
  );
  for (const p of parts) {
    const n = el('span', `guide-part guide-part-${p.cls}${p.round ? ' is-round' : ''}${p.when ? ' is-conditional' : ''}`, p.label);
    n.setAttribute('aria-hidden', 'true');
    const [l, t, w, h] = p.box;
    n.style.left = `${l}%`;
    n.style.top = `${t}%`;
    n.style.width = `${w}%`;
    n.style.height = `${h}%`;
    phone.append(n);
  }
  const notes = parts.filter((p) => p.when).map((p) => `${p.label}: ${p.when}`);
  fig.append(phone, el('figcaption', 'guide-diagram-cap', notes.length ? `Dashed: ${notes.join(' · ')}` : 'Your touch layout'));
  return fig;
}

/* ---------------------------------------------------------------- blocks */

function keycaps(row: ControlRow): HTMLElement {
  const dt = el('dt', 'guide-keycaps');
  row.keys.forEach((group, i) => {
    if (i > 0) dt.append(el('span', 'guide-or', '/'));
    const g = el('span', 'guide-keygroup');
    for (const k of group) g.append(el('kbd', 'guide-kbd', k));
    dt.append(g);
  });
  return dt;
}

function renderBlock(b: GuideBlock): HTMLElement {
  switch (b.kind) {
    case 'lead':
      return el('p', 'guide-lead', b.text);
    case 'note':
      return el('p', 'guide-note', b.text);
    case 'points': {
      const dl = el('dl', 'guide-points');
      for (const p of b.items) {
        const row = el('div', 'guide-point');
        row.append(el('dt', '', p.label), el('dd', '', p.text));
        dl.append(row);
      }
      return dl;
    }
    case 'controls': {
      const dl = el('dl', 'guide-keys');
      for (const r of b.rows) {
        const row = el('div', 'guide-keyrow');
        row.dataset['control'] = r.id;
        const dd = el('dd', '');
        dd.append(el('b', 'guide-action', r.action), el('span', 'guide-action-text', r.text));
        row.append(keycaps(r), dd);
        dl.append(row);
      }
      return dl;
    }
    case 'sample': {
      const fig = el('figure', 'guide-sample');
      const out = el('div', 'guide-sample-lines');
      for (const line of b.lines) out.append(el('samp', 'guide-samp', line));
      fig.append(out, el('figcaption', 'guide-sample-cap', b.caption));
      return fig;
    }
    case 'diagram':
      return diagram(b.layout, b.gate);
  }
}

/* ---------------------------------------------------------------- dialog */

let guideInstances = 0;

export class GuideDialog {
  readonly root: HTMLElement;
  private readonly deps: GuideDialogDeps;
  private readonly card: HTMLElement;
  private readonly ring: HTMLElement;
  private readonly kickerEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly progress: HTMLOListElement;
  private readonly switches: HTMLElement;
  private readonly modeSeg: HTMLElement;
  private readonly inputSeg: HTMLElement;
  private readonly body: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private opts: GuideOpenOptions | null = null;
  private ctx: GuideContext | null = null;
  private index = 0;
  private scope: DisposableScope | null = null;
  private highlighted = false;
  private opener: HTMLElement | null = null;
  /** Unique per instance: the title screen and Free Roam may each hold a (hidden) guide. */
  private readonly titleId = `guide-title-${(guideInstances += 1)}`;

  constructor(parent: HTMLElement, deps: GuideDialogDeps) {
    this.deps = deps;
    this.root = el('div', 'guide');
    this.root.hidden = true;
    const scrim = el('div', 'guide-scrim');
    scrim.setAttribute('aria-hidden', 'true');
    this.ring = el('div', 'guide-ring');
    this.ring.setAttribute('aria-hidden', 'true');
    this.ring.hidden = true;

    this.card = el('section', 'guide-card');
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', this.titleId);

    const head = el('header', 'guide-head');
    this.kickerEl = el('p', 'guide-context');
    this.countEl = el('p', 'guide-count');
    this.closeBtn = button('guide-close', 'SKIP TUTORIAL');
    this.closeBtn.addEventListener('click', () => this.end(this.opts?.kind === 'tutorial' ? 'skipped' : 'closed'));
    head.append(this.kickerEl, this.countEl, this.closeBtn);

    this.progress = el('ol', 'guide-progress');
    this.progress.setAttribute('aria-label', 'Steps');
    GUIDE_STEPS.forEach((id, i) => {
      const li = el('li', 'guide-progress-item');
      const b = el('button', 'guide-dot');
      b.type = 'button';
      b.dataset['step'] = id;
      b.append(el('span', 'guide-dot-mark'), el('span', 'guide-dot-label', STEP_LABEL[id]));
      b.setAttribute('aria-label', `Step ${i + 1} of ${GUIDE_STEPS.length}: ${STEP_LABEL[id]}`);
      b.addEventListener('click', () => this.go(i));
      li.append(b);
      this.progress.append(li);
    });

    this.switches = el('div', 'guide-switches');
    this.modeSeg = this.segment('Game mode', GUIDE_MODES.map((m) => [m, MODE_LABEL[m]] as const), (v) => this.setContext({ mode: v as GuideMode }));
    this.inputSeg = this.segment('Input', GUIDE_INPUTS.map((m) => [m, INPUT_LABEL[m]] as const), (v) => this.setContext({ input: v as GuideInput }));
    this.switches.append(this.modeSeg, this.inputSeg);

    this.body = el('div', 'guide-body');
    // a scroll region on short screens: focusable so the keyboard can scroll it
    this.body.tabIndex = 0;
    this.body.setAttribute('role', 'region');
    this.body.setAttribute('aria-labelledby', this.titleId);

    this.actions = el('footer', 'guide-actions');
    this.backBtn = button('guide-back', '◀ BACK');
    this.backBtn.addEventListener('click', () => this.go(this.index - 1));
    this.nextBtn = button('guide-next is-primary', 'NEXT ▶');
    this.nextBtn.addEventListener('click', () => (this.index >= GUIDE_STEPS.length - 1 ? this.end(this.opts?.kind === 'tutorial' ? 'completed' : 'closed') : this.go(this.index + 1)));

    this.card.append(head, this.progress, this.switches, this.body, this.actions);
    this.root.append(scrim, this.ring, this.card);
    parent.append(this.root);
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  status(): GuideStatus {
    const ctx = this.ctx;
    return {
      open: this.isOpen(),
      kind: this.opts?.kind ?? null,
      step: GUIDE_STEPS[this.index]!,
      index: this.index,
      mode: ctx?.mode ?? 'freeroam',
      input: ctx?.input ?? 'keyboard',
      highlighted: this.highlighted,
      listeners: this.scope?.activeListeners ?? 0,
      loops: this.scope?.activeLoops ?? 0,
    };
  }

  open(o: GuideOpenOptions): void {
    this.opts = o;
    this.ctx = o.context;
    this.opener = o.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.index = Math.max(0, GUIDE_STEPS.indexOf(o.step ?? 'welcome'));
    this.root.dataset['kind'] = o.kind;
    this.closeBtn.textContent = o.kind === 'tutorial' ? 'SKIP TUTORIAL' : 'CLOSE';
    this.closeBtn.setAttribute('aria-label', o.kind === 'tutorial' ? 'Skip tutorial' : 'Close how to play');
    if (o.kind === 'tutorial') {
      // narrow screens drop the prefix (styles.css) so the header stays on one line
      const pre = document.createElement('span');
      pre.className = 'guide-context-pre';
      pre.textContent = 'FIRST FLIGHT · ';
      this.kickerEl.replaceChildren(pre, 'TUTORIAL');
    } else this.kickerEl.textContent = 'HOW TO PLAY';
    this.root.hidden = false;
    this.attach();
    this.render(false);
    this.nextBtn.focus({ preventScroll: true });
  }

  /** Close without a result (the screen behind is going away). */
  dismiss(): void {
    if (!this.isOpen()) return;
    this.release();
  }

  dispose(): void {
    this.release();
    this.root.remove();
  }

  private release(): void {
    this.scope?.dispose();
    this.scope = null;
    this.root.hidden = true;
    this.ring.hidden = true;
    this.root.classList.remove('is-spotlit');
    this.highlighted = false;
  }

  private end(how: GuideEnd['how'], play: GuideMode | null = null): void {
    if (!this.isOpen() || !this.opts || !this.ctx) return;
    const end: GuideEnd = { kind: this.opts.kind, how, play, context: this.ctx };
    const opener = this.opener;
    this.release();
    this.opener = null;
    // the owner first: it lifts its own inert / blocked state, which a focus call needs
    this.deps.onEnd(end);
    if (play === null && opener?.isConnected) opener.focus({ preventScroll: true });
  }

  private go(i: number): void {
    const n = Math.max(0, Math.min(GUIDE_STEPS.length - 1, i));
    if (n === this.index) return;
    this.index = n;
    this.deps.onMove?.();
    this.render(true);
  }

  private setContext(patch: Partial<GuideContext>): void {
    if (!this.ctx) return;
    const next = { ...this.ctx, ...patch };
    if (next.mode === this.ctx.mode && next.input === this.ctx.input) return;
    this.ctx = next;
    this.deps.onMove?.();
    this.render(true);
  }

  private segment(label: string, options: readonly (readonly [string, string])[], pick: (v: string) => void): HTMLElement {
    const seg = el('div', 'guide-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', label);
    seg.append(el('span', 'guide-seg-label', label.toUpperCase()));
    for (const [value, text] of options) {
      const b = el('button', 'guide-seg-opt', text);
      b.type = 'button';
      b.dataset['value'] = value;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => pick(value));
      seg.append(b);
    }
    return seg;
  }

  private syncSegment(seg: HTMLElement, value: string): void {
    for (const b of seg.querySelectorAll<HTMLButtonElement>('.guide-seg-opt')) {
      const on = b.dataset['value'] === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1; // one tab stop per group (radio convention)
    }
  }

  private render(animate: boolean): void {
    const o = this.opts;
    const ctx = this.ctx;
    if (!o || !ctx) return;
    const id = GUIDE_STEPS[this.index]!;
    const step = guideStep(id, ctx, o.canPlay);
    const last = this.index === GUIDE_STEPS.length - 1;
    this.root.dataset['step'] = id;
    this.root.dataset['motion'] = this.deps.reducedMotion() ? 'reduced' : 'full';
    this.countEl.textContent = `STEP ${this.index + 1} OF ${GUIDE_STEPS.length}`;
    this.progress.querySelectorAll<HTMLButtonElement>('.guide-dot').forEach((b, i) => {
      b.classList.toggle('is-done', i < this.index);
      if (i === this.index) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
    this.modeSeg.hidden = !step.byMode;
    this.inputSeg.hidden = !step.byInput;
    this.switches.hidden = !step.byMode && !step.byInput;
    this.syncSegment(this.modeSeg, ctx.mode);
    this.syncSegment(this.inputSeg, ctx.input);

    const heading = el('h2', 'guide-title', step.title);
    heading.id = this.titleId;
    const content = el('div', 'guide-content');
    content.append(el('p', 'guide-kicker', step.kicker), heading, ...step.blocks.map(renderBlock));
    this.body.replaceChildren(content);
    this.body.scrollTop = 0;
    if (animate && this.root.dataset['motion'] === 'full') {
      content.classList.add('is-entering');
      content.addEventListener('animationend', () => content.classList.remove('is-entering'), { once: true });
    }

    // actions: BACK, then NEXT / FINISH (or the PLAY buttons on the last step from the title)
    const focusedWasNext = document.activeElement === this.nextBtn;
    this.backBtn.disabled = this.index === 0;
    this.nextBtn.textContent = last ? (o.kind === 'tutorial' ? 'FINISH' : 'DONE') : 'NEXT ▶';
    this.nextBtn.setAttribute('aria-label', last ? (o.kind === 'tutorial' ? 'Finish the tutorial' : 'Close how to play') : `Next: ${STEP_LABEL[GUIDE_STEPS[this.index + 1]!]}`);
    const play: HTMLButtonElement[] = [];
    if (last && o.canPlay) {
      for (const m of [ctx.mode, ...GUIDE_MODES.filter((x) => x !== ctx.mode)]) {
        const b = button(`guide-play guide-play-${m}${m === ctx.mode ? ' is-primary' : ''}`, `PLAY ${MODE_LABEL[m]}`);
        b.dataset['mode'] = m;
        b.addEventListener('click', () => this.end(o.kind === 'tutorial' ? 'completed' : 'closed', m));
        play.push(b);
      }
      this.nextBtn.classList.remove('is-primary');
    } else this.nextBtn.classList.add('is-primary');
    this.actions.replaceChildren(this.backBtn, ...play, this.nextBtn);
    if (focusedWasNext && last && play[0]) play[0].focus({ preventScroll: true });
    else if (document.activeElement === document.body || !this.card.contains(document.activeElement)) (play[0] ?? this.nextBtn).focus({ preventScroll: true });
    this.place();
  }

  /** Highlight ring from the live element's measured bounds, with the card beside it; none when it cannot fit. */
  private place(): void {
    const o = this.opts;
    const ctx = this.ctx;
    this.card.style.removeProperty('--guide-top');
    this.card.classList.remove('is-anchored');
    this.ring.hidden = true;
    this.root.classList.remove('is-spotlit');
    this.highlighted = false;
    if (!o?.highlight || !ctx) return;
    const target = o.highlight(GUIDE_STEPS[this.index]!, ctx);
    if (!target || !target.isConnected) return;
    const r = target.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || getComputedStyle(target).visibility === 'hidden') return;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return;
    const pad = 6;
    const gap = 12;
    const c = this.card.getBoundingClientRect();
    const clear = c.right <= r.left - pad - gap || c.left >= r.right + pad + gap || c.bottom <= r.top - pad - gap || c.top >= r.bottom + pad + gap;
    if (!clear) {
      // the centred card covers the element: move the card above or below it, or show no ring
      const below = vh - (r.bottom + pad + gap);
      const above = r.top - pad - gap;
      let top: number | null = null;
      if (below >= c.height + 8) top = r.bottom + pad + gap;
      else if (above >= c.height + 8) top = r.top - pad - gap - c.height;
      if (top === null) return;
      this.card.classList.add('is-anchored');
      this.card.style.setProperty('--guide-top', `${Math.round(top)}px`);
    }
    const s = this.ring.style;
    s.left = `${Math.round(r.left - pad)}px`;
    s.top = `${Math.round(r.top - pad)}px`;
    s.width = `${Math.round(r.width + pad * 2)}px`;
    s.height = `${Math.round(r.height + pad * 2)}px`;
    this.ring.hidden = false;
    this.root.classList.add('is-spotlit');
    this.highlighted = true;
  }

  private focusables(): HTMLElement[] {
    return [...this.card.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')].filter((n) => n.offsetParent !== null || n === document.activeElement);
  }

  /** Buttons for ↑ / ↓ and the gamepad (not the scroll region). */
  private buttons(): HTMLButtonElement[] {
    return [...this.card.querySelectorAll<HTMLButtonElement>('button:not([disabled])')].filter((n) => n.offsetParent !== null && (n.tabIndex >= 0 || n.getAttribute('aria-checked') === 'true'));
  }

  private moveFocus(dir: 1 | -1): void {
    const list = this.buttons();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = list[(i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length)]!;
    next.focus({ preventScroll: false });
  }

  /** ← / → inside a radio group: select the neighbouring option. */
  private moveRadio(current: HTMLElement, dir: 1 | -1): void {
    const seg = current.closest('.guide-seg');
    if (!seg) return;
    const opts = [...seg.querySelectorAll<HTMLButtonElement>('.guide-seg-opt')];
    const i = opts.indexOf(current as HTMLButtonElement);
    const next = opts[(i + dir + opts.length) % opts.length]!;
    next.click();
    seg.querySelector<HTMLButtonElement>(`.guide-seg-opt[data-value="${next.dataset['value'] ?? ''}"]`)?.focus();
  }

  private attach(): void {
    this.scope?.dispose();
    const scope = new DisposableScope();
    this.scope = scope;
    scope.on<KeyboardEvent>(
      window,
      'keydown',
      (e) => {
        if (!this.isOpen()) return;
        // modal: nothing behind the guide sees a key press
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target instanceof HTMLElement ? e.target : null;
        const inRadio = t?.classList.contains('guide-seg-opt') ?? false;
        switch (e.code) {
          case 'Escape':
            e.preventDefault();
            if (!e.repeat) this.end(this.opts?.kind === 'tutorial' ? 'skipped' : 'closed');
            return;
          case 'Tab': {
            const list = this.focusables();
            if (list.length === 0) return;
            const i = list.indexOf(document.activeElement as HTMLElement);
            if (e.shiftKey && (i <= 0 || i < 0)) {
              e.preventDefault();
              list[list.length - 1]!.focus();
            } else if (!e.shiftKey && (i === list.length - 1 || i < 0)) {
              e.preventDefault();
              list[0]!.focus();
            }
            return;
          }
          case 'ArrowLeft':
          case 'ArrowRight':
            e.preventDefault();
            if (inRadio && t) this.moveRadio(t, e.code === 'ArrowLeft' ? -1 : 1);
            else this.go(this.index + (e.code === 'ArrowLeft' ? -1 : 1));
            return;
          case 'PageUp':
          case 'PageDown':
            e.preventDefault();
            this.go(this.index + (e.code === 'PageUp' ? -1 : 1));
            return;
          case 'ArrowUp':
          case 'ArrowDown':
            if (t === this.body) return; // let the scroll region scroll
            e.preventDefault();
            this.moveFocus(e.code === 'ArrowUp' ? -1 : 1);
            return;
          default:
            // Enter / Space reach the focused button (native activation); everything else does nothing here
            if ((e.code === 'Enter' || e.code === 'Space') && !(t instanceof HTMLButtonElement) && t !== this.body) {
              e.preventDefault();
              if (!e.repeat) this.nextBtn.click();
            }
        }
      },
      { capture: true },
    );
    const replace = (): void => {
      if (this.isOpen()) this.place();
    };
    scope.on(window, 'resize', replace);
    scope.on(window, 'orientationchange', replace);

    // gamepad: only while open and a pad is present
    const pad = new GamepadReader();
    let loop: { stop(): void; readonly running: boolean } | null = null;
    const startPad = (): void => {
      if (loop?.running) return;
      pad.reset(); // the button that opened the guide must not also act in it
      loop = scope.frameLoop((ts) => {
        const { update } = pad.poll(ts);
        if (pad.connected === 0 || !this.isOpen()) return false;
        for (const b of update.presses) {
          if (b === 'left' || b === 'right') {
            const t = document.activeElement;
            if (t instanceof HTMLElement && t.classList.contains('guide-seg-opt')) this.moveRadio(t, b === 'left' ? -1 : 1);
            else this.go(this.index + (b === 'left' ? -1 : 1));
          } else if (b === 'up' || b === 'down') this.moveFocus(b === 'up' ? -1 : 1);
          else if (b === 'a') {
            const t = document.activeElement;
            if (t instanceof HTMLButtonElement && this.card.contains(t)) t.click();
            else this.nextBtn.click();
          } else if (b === 'b') this.end(this.opts?.kind === 'tutorial' ? 'skipped' : 'closed');
          if (!this.isOpen()) return false;
        }
        return true;
      });
    };
    scope.on(window, 'gamepadconnected', startPad);
    const pads = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    if ([...pads].some((p) => p?.connected)) startPad();
  }
}
