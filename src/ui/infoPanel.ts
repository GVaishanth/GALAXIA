/**
 * Classic info box (ⓘ): the CONTROLS and SCORING reference in a small modal,
 * for layouts that have no room for the side panels (phones, narrow
 * windows). Opened by the ⓘ button beside II (touch pad, or the top-right
 * corner of the playfield). app.ts pauses a running game before opening it,
 * routes keys and gamepad buttons to it while open, and restores focus.
 *
 * Content is the same data as the desktop side panels (sidePanels.ts), so
 * the two never disagree. The controls list follows the device in use
 * (CSS, `data-input` on the app root), with a touch list added here.
 */
import { CLASSIC_SCORING } from '../config/scoring.ts';
import { CONTROL_ROWS, PAD_CONTROL_ROWS, type SideInfo } from './sidePanels.ts';

/** The same actions on the touch pad. */
export const TOUCH_CONTROL_ROWS: readonly (readonly [string, string])[] = [
  ['MOVE', 'SLIDE ◀ ▶'],
  ['FIRE', 'TAP / HOLD FIRE'],
  ['PAUSE', 'II'],
  ['INFO', 'i'],
];

/** One line on hold-to-fire and heat (TD-74). */
export const HEAT_NOTE = 'HOLD FIRE TO KEEP SHOOTING. HOLD TOO LONG AND THE WEAPON OVERHEATS: IT COOLS IN A MOMENT.';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export class InfoPanel {
  readonly root: HTMLElement;
  readonly closeButton: HTMLButtonElement;
  /** Called after the box closes (any way: button, Esc, backdrop, gamepad). */
  onClose: (() => void) | null = null;
  private open = false;
  private returnFocus: HTMLElement | null = null;
  private readonly bestValue: HTMLElement;
  private readonly stageValue: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = el('div', 'info-layer');
    this.root.hidden = true;
    const card = el('section', 'info-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'classic-info-title');
    const head = el('div', 'info-head');
    const title = el('h2', 'info-title', 'INFO');
    title.id = 'classic-info-title';
    this.closeButton = el('button', 'info-close', 'CLOSE');
    this.closeButton.type = 'button';
    this.closeButton.setAttribute('aria-label', 'Close the info box');
    head.append(title, this.closeButton);

    const controls = el('div', 'info-section info-controls');
    controls.append(el('h3', 'info-heading', 'CONTROLS'));
    for (const [cls, rows] of [
      ['info-keys info-keys-kb', CONTROL_ROWS],
      ['info-keys info-keys-pad', PAD_CONTROL_ROWS],
      ['info-keys info-keys-touch', TOUCH_CONTROL_ROWS],
    ] as const) {
      const dl = el('dl', cls);
      for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v));
      controls.append(dl);
    }
    controls.append(el('p', 'info-note', HEAT_NOTE));

    const scoring = el('div', 'info-section info-scoring');
    scoring.append(el('h3', 'info-heading', 'SCORING'));
    const table = el('table', 'info-table');
    const head2 = el('tr', '');
    head2.append(el('th', '', ''), el('th', '', 'FORM'), el('th', '', 'DIVE'));
    table.append(head2);
    const s = CLASSIC_SCORING.enemies;
    for (const [name, a, b] of [
      ['SCOUT', s.scout.formation, s.scout.attack],
      ['INTERCEPTOR', s.interceptor.formation, s.interceptor.attack],
      ['COMMANDER', s.commander.formation, s.commander.attackByEscorts[0]],
    ] as const) {
      const tr = el('tr', '');
      tr.append(el('td', '', name), el('td', '', String(a)), el('td', '', String(b)));
      table.append(tr);
    }
    const records = el('dl', 'info-records');
    this.bestValue = el('dd', '');
    this.stageValue = el('dd', '');
    records.append(el('dt', '', 'HIGH SCORE'), this.bestValue, el('dt', '', 'BEST STAGE'), this.stageValue);
    scoring.append(table, records);

    const body = el('div', 'info-body');
    body.append(controls, scoring);
    card.append(head, body);
    this.root.append(card);
    host.append(this.root);

    this.closeButton.addEventListener('click', () => this.hide());
    // a tap on the dimmed backdrop (outside the card) closes too
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) {
        e.preventDefault();
        this.hide();
      }
    });
  }

  isOpen(): boolean {
    return this.open;
  }

  show(info: Pick<SideInfo, 'best' | 'bestStage'>, returnFocus: HTMLElement | null = null): void {
    this.bestValue.textContent = info.best;
    this.stageValue.textContent = String(info.bestStage || '-');
    if (this.open) return;
    this.open = true;
    this.returnFocus = returnFocus;
    this.root.hidden = false;
    this.closeButton.focus({ preventScroll: true });
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.hidden = true;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back && back.isConnected && !back.closest('[hidden]')) back.focus({ preventScroll: true });
    this.onClose?.();
  }

  dispose(): void {
    this.open = false;
    this.root.remove();
  }
}
