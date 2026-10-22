/**
 * Desktop side panels in the letterbox (Stage 5). Static reference content:
 * controls on the left, scoring and records on the right. As the window
 * narrows they collapse to one compact controls panel, then disappear (the
 * same information stays in HOW TO PLAY). On portrait monitors and tall
 * windows they sit under the playfield instead (Stage 8). Never shown with
 * touch layouts. The controls list shows keyboard or gamepad buttons,
 * following the device in use (CSS, `data-input` on the app root).
 * Essential game information is always in the in-playfield HUD, never only here.
 */
import { LAYOUT } from '../config/devices.ts';
import { CLASSIC_SCORING } from '../config/scoring.ts';
import type { PlayfieldRect } from './hud.ts';
import type { SidePanels as Mode } from './layout.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export const CONTROL_ROWS: readonly (readonly [string, string])[] = [
  ['MOVE', '← → / A D'],
  ['FIRE', 'SPACE / HOLD'],
  ['PAUSE', 'P / ESC'],
  ['SELECT', '↑ ↓ ENTER'],
  ['MUTE', 'M'],
];

/** Same actions on a standard-mapping gamepad (Stage 8). */
export const PAD_CONTROL_ROWS: readonly (readonly [string, string])[] = [
  ['MOVE', 'STICK / D-PAD'],
  ['FIRE', 'A / X / HOLD'],
  ['PAUSE', 'START'],
  ['SELECT', 'D-PAD + A'],
  ['BACK', 'B'],
];

export interface SideInfo {
  readonly best: string;
  readonly bestStage: number;
  readonly muted: boolean;
}

export class SidePanels {
  readonly left: HTMLElement;
  readonly right: HTMLElement;
  private mode: Mode = 'none';
  private lastKey = '';
  private readonly bestValue: HTMLElement;
  private readonly stageValue: HTMLElement;
  private readonly soundValue: HTMLElement;
  private readonly scoring: HTMLElement;
  private readonly controlsCompact: HTMLElement;

  constructor(container: HTMLElement) {
    this.left = el('aside', 'side-panel side-panel-left');
    this.left.setAttribute('aria-label', 'Controls');
    this.left.append(el('h2', 'side-heading', 'CONTROLS'), this.keys());

    this.right = el('aside', 'side-panel side-panel-right');
    this.right.setAttribute('aria-label', 'Scoring and records');
    this.scoring = el('div', 'side-section');
    const table = el('table', 'side-table');
    const s = CLASSIC_SCORING.enemies;
    const head = el('tr', '');
    head.append(el('th', '', ''), el('th', '', 'FORM'), el('th', '', 'DIVE'));
    table.append(head);
    for (const [name, a, b] of [
      ['SCOUT', s.scout.formation, s.scout.attack],
      ['INTERCEPTOR', s.interceptor.formation, s.interceptor.attack],
      ['COMMANDER', s.commander.formation, s.commander.attackByEscorts[0]],
    ] as const) {
      const tr = el('tr', '');
      tr.append(el('td', '', name), el('td', '', String(a)), el('td', '', String(b)));
      table.append(tr);
    }
    this.scoring.append(el('h2', 'side-heading', 'SCORING'), table);
    this.controlsCompact = el('div', 'side-section side-compact-controls');
    this.controlsCompact.append(el('h2', 'side-heading', 'CONTROLS'), this.keys());
    const records = el('dl', 'side-records');
    this.bestValue = el('dd', '');
    this.stageValue = el('dd', '');
    this.soundValue = el('dd', '');
    records.append(el('dt', '', 'HIGH SCORE'), this.bestValue, el('dt', '', 'BEST STAGE'), this.stageValue, el('dt', '', 'SOUND (M)'), this.soundValue);
    this.right.append(this.controlsCompact, this.scoring, records);
    container.append(this.left, this.right);
    this.setMode('none');
  }

  setMode(mode: Mode): void {
    if (mode === this.mode && this.lastKey !== '') return;
    this.mode = mode;
    this.left.hidden = mode !== 'sides' && mode !== 'below' && mode !== 'below-compact';
    this.right.hidden = mode === 'none' || mode === 'below-compact';
    this.right.classList.toggle('side-panel-compact', mode === 'compact');
    this.lastKey = '';
  }

  /**
   * Place the panels in the letterbox beside (or under) the playfield, inside
   * `area` (stage coordinates: the safe play area, TD-72; default the whole
   * stage around a centred playfield).
   */
  setRect(r: PlayfieldRect, area: PlayfieldRect = { left: 0, top: 0, width: r.left * 2 + r.width, height: r.top * 2 + r.height }): void {
    const key = `${this.mode}|${r.left}|${r.top}|${r.width}|${r.height}|${area.left}|${area.top}|${area.width}|${area.height}`;
    if (key === this.lastKey || this.mode === 'none') return;
    this.lastKey = key;
    const x0Area = area.left;
    const stageWidth = area.width;
    const stageHeight = area.top + area.height;
    const { gap, maxWidth } = LAYOUT.sidePanels;
    if (this.mode === 'below' || this.mode === 'below-compact') {
      const top = Math.round(r.top + r.height + gap);
      const maxHeight = `${Math.max(0, Math.round(stageHeight - top - gap))}px`;
      if (this.mode === 'below') {
        const w = Math.max(0, Math.min(maxWidth, (stageWidth - gap * 3) / 2));
        const x0 = x0Area + (stageWidth - (w * 2 + gap)) / 2;
        Object.assign(this.left.style, { left: `${Math.round(x0)}px`, width: `${Math.round(w)}px`, top: `${top}px`, maxHeight });
        Object.assign(this.right.style, { left: `${Math.round(x0 + w + gap)}px`, width: `${Math.round(w)}px`, top: `${top}px`, maxHeight });
      } else {
        const w = Math.max(0, Math.min(maxWidth, stageWidth - gap * 2));
        Object.assign(this.left.style, { left: `${Math.round(x0Area + (stageWidth - w) / 2)}px`, width: `${Math.round(w)}px`, top: `${top}px`, maxHeight });
      }
      return;
    }
    const leftFree = r.left - x0Area;
    const rightFree = x0Area + stageWidth - (r.left + r.width);
    const top = `${Math.round(r.top + r.height * 0.1)}px`;
    const maxH = `${Math.round(r.height * 0.8)}px`;
    const lw = Math.max(0, Math.min(maxWidth, leftFree - gap * 2));
    Object.assign(this.left.style, { left: `${Math.round(r.left - gap - lw)}px`, width: `${lw}px`, top, maxHeight: maxH });
    const rw = Math.max(0, Math.min(maxWidth, rightFree - gap * 2));
    Object.assign(this.right.style, { left: `${Math.round(r.left + r.width + gap)}px`, width: `${rw}px`, top, maxHeight: maxH });
  }

  update(info: SideInfo): void {
    this.bestValue.textContent = info.best;
    this.stageValue.textContent = String(info.bestStage || '-');
    this.soundValue.textContent = info.muted ? 'OFF' : 'ON';
  }

  /** Keyboard and gamepad lists; CSS shows the one for the device in use. */
  private keys(): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const [cls, rows] of [['side-keys side-keys-kb', CONTROL_ROWS], ['side-keys side-keys-pad', PAD_CONTROL_ROWS]] as const) {
      const dl = el('dl', cls);
      for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v));
      frag.append(dl);
    }
    return frag;
  }
}
