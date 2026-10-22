/**
 * Touch controls DOM adapter (Pointer Events) -> TouchPadModel -> InputHub.
 *
 * Layout: a slide move pad (◀ knob ▶), a pause button and a large FIRE
 * button. The pad lives outside the playfield (below it in portrait, in the
 * side columns in landscape), so fingers never cover the action.
 *
 * Robustness:
 * - pointerdown is taken on the control (default prevented: no focus, no
 *   text selection, no compatibility mouse events) and captured when the
 *   browser allows it;
 * - move / up / cancel are observed on the window and filtered by pointer
 *   id, so a finger released outside its control (or with capture refused)
 *   still releases it;
 * - lostpointercapture and pointercancel release too; reset() (blur, hidden
 *   page) drops every pointer;
 * - only pointer events are used (never click / mousedown), so one touch is
 *   exactly one action even when the browser also emits synthetic mouse events.
 */
import { TOUCH_PAD } from '../config/devices.ts';
import type { InputHub } from './inputHub.ts';
import { normaliseX, TouchPadModel, type TouchPadState, type TouchZone } from './touchPad.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export class TouchControls {
  readonly root: HTMLElement;
  readonly model: TouchPadModel;
  private readonly zones: Record<TouchZone, HTMLElement>;
  private readonly knob: HTMLElement;
  private readonly pressedAt: Record<TouchZone, number> = { move: 0, fire: 0, pause: 0 };
  private readonly timers: Partial<Record<TouchZone, ReturnType<typeof setTimeout>>> = {};
  private readonly detach: () => void;
  /** The ⓘ button (controls and scoring box): a plain UI button, not a game input zone. */
  readonly info: HTMLElement;
  /** Called when the ⓘ button is tapped. */
  onInfo: (() => void) | null = null;
  private heatKey = '';

  constructor(hub: InputHub, host: Pick<Window, 'addEventListener' | 'removeEventListener'> = window) {
    this.model = new TouchPadModel(hub);
    this.root = el('div', 'touch-pad');
    this.root.setAttribute('aria-hidden', 'true'); // keyboard / screen-reader users have the real keys and menus

    const move = el('div', 'touch-zone touch-move');
    move.dataset['zone'] = 'move';
    this.knob = el('span', 'touch-knob');
    move.append(el('span', 'touch-arrow touch-arrow-left', '◀'), this.knob, el('span', 'touch-arrow touch-arrow-right', '▶'));
    const pause = el('div', 'touch-zone touch-btn touch-pause', 'II');
    pause.dataset['zone'] = 'pause';
    const fire = el('div', 'touch-zone touch-btn touch-fire', 'FIRE');
    fire.dataset['zone'] = 'fire';
    this.zones = { move, pause, fire };
    // ⓘ next to II: opens the controls and scoring box (app.ts pauses a running game first)
    this.info = el('div', 'touch-zone touch-btn touch-info', 'i');
    const system = el('div', 'touch-system');
    system.append(pause, this.info);
    const fireGroup = el('div', 'touch-group touch-group-action');
    fireGroup.append(system, fire);
    const moveGroup = el('div', 'touch-group touch-group-move');
    moveGroup.append(move);
    this.root.append(moveGroup, fireGroup);

    this.model.onChange = (s) => this.render(s);

    const down = (e: PointerEvent): void => {
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-zone]') : null;
      const zone = target?.dataset['zone'] as TouchZone | undefined;
      if (!target || !zone) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* capture refused (pointer already gone, synthetic event): window listeners still release it */
      }
      this.model.down(e.pointerId, zone, zone === 'move' ? normaliseX(e.clientX, move.getBoundingClientRect()) : 0);
    };
    const moveH = (e: PointerEvent): void => {
      if (!this.model.has(e.pointerId)) return;
      this.model.move(e.pointerId, normaliseX(e.clientX, move.getBoundingClientRect()));
    };
    const up = (e: PointerEvent): void => this.model.up(e.pointerId);
    const noMenu = (e: Event): void => e.preventDefault();
    const infoDown = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      this.info.classList.add('is-pressed');
    };
    const infoUp = (e: PointerEvent): void => {
      if (!this.info.classList.contains('is-pressed')) return;
      this.info.classList.remove('is-pressed');
      // released over the button: open the box (a finger slid away cancels)
      const r = this.info.getBoundingClientRect();
      if (e.type === 'pointerup' && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) this.onInfo?.();
    };
    this.info.addEventListener('pointerdown', infoDown);
    host.addEventListener('pointerup', infoUp as EventListener);
    host.addEventListener('pointercancel', infoUp as EventListener);

    this.root.addEventListener('pointerdown', down);
    this.root.addEventListener('lostpointercapture', up as EventListener);
    this.root.addEventListener('contextmenu', noMenu);
    host.addEventListener('pointermove', moveH as EventListener);
    host.addEventListener('pointerup', up as EventListener);
    host.addEventListener('pointercancel', up as EventListener);
    this.detach = () => {
      this.root.removeEventListener('pointerdown', down);
      this.root.removeEventListener('lostpointercapture', up as EventListener);
      this.root.removeEventListener('contextmenu', noMenu);
      this.info.removeEventListener('pointerdown', infoDown);
      host.removeEventListener('pointerup', infoUp as EventListener);
      host.removeEventListener('pointercancel', infoUp as EventListener);
      host.removeEventListener('pointermove', moveH as EventListener);
      host.removeEventListener('pointerup', up as EventListener);
      host.removeEventListener('pointercancel', up as EventListener);
    };
  }

  /** Weapon heat on the FIRE button (TD-74): a rising fill, and HOT while locked. DOM only on change. */
  setHeat(level: number, overheated: boolean): void {
    const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
    const key = `${pct}|${overheated}`;
    if (key === this.heatKey) return;
    this.heatKey = key;
    const fire = this.zones.fire;
    fire.style.setProperty('--heat', `${pct}%`);
    fire.classList.toggle('is-overheated', overheated);
    const label = overheated ? 'HOT' : 'FIRE';
    if (fire.textContent !== label) fire.textContent = label;
  }

  /** Drop all pointers (blur, hidden page, layout switch). */
  reset(): void {
    this.model.reset();
  }

  dispose(): void {
    this.reset();
    this.detach();
    // pending press-feedback timers must not outlive the pad (mode switch)
    for (const zone of ['move', 'fire', 'pause'] as const) clearTimeout(this.timers[zone]);
    this.root.remove();
  }

  /** Press feedback: classes and the knob position (no layout work). */
  private render(s: TouchPadState): void {
    const now = performance.now();
    for (const zone of ['move', 'fire', 'pause'] as const) {
      const node = this.zones[zone];
      const on = s.pressed[zone];
      clearTimeout(this.timers[zone]);
      if (on) {
        if (!node.classList.contains('is-pressed')) this.pressedAt[zone] = now;
        node.classList.add('is-pressed');
      } else if (node.classList.contains('is-pressed')) {
        // keep very short taps visible for a moment
        const left = TOUCH_PAD.minFeedbackMs - (now - this.pressedAt[zone]);
        if (left > 0) this.timers[zone] = setTimeout(() => node.classList.remove('is-pressed'), left);
        else node.classList.remove('is-pressed');
      }
    }
    const move = this.zones.move;
    move.dataset['dir'] = String(s.moveDir);
    move.style.setProperty('--knob', s.knob === null ? '0' : s.knob.toFixed(3));
    this.knob.classList.toggle('is-active', s.knob !== null);
  }
}
