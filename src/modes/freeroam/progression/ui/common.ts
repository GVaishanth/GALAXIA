/**
 * Shared DOM helpers of the progression panels (Free Roam Prompt 11). DOM
 * only: no rules. Every paid action is two presses: the first shows the
 * quote (cost and the resulting change), the second confirms it.
 */
import type { QuoteLine } from '../economy.ts';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function btn(className: string, text: string, key: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `fr-btn ${className}`, text);
  b.type = 'button';
  b.dataset['key'] = key;
  b.addEventListener('click', onClick);
  return b;
}

/** Before -> after table of a quote. */
export function quoteTable(lines: readonly QuoteLine[]): HTMLElement {
  const t = el('dl', 'fr-quote');
  for (const l of lines) {
    const dd = el('dd', '');
    dd.append(el('span', 'fr-quote-before', l.before), el('span', 'fr-quote-arrow', ' → '), el('span', 'fr-quote-after', l.after));
    t.append(el('dt', '', l.label.toUpperCase()), dd);
  }
  return t;
}

/** The focused button's key inside `root` (refreshes keep the focus on the same action). */
export const focusedKey = (root: HTMLElement): string | undefined => (document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset['key'] : undefined);

export function restoreFocus(root: HTMLElement, key: string | undefined): void {
  if (key) root.querySelector<HTMLButtonElement>(`button[data-key="${CSS.escape(key)}"]:not([disabled])`)?.focus({ preventScroll: true });
}

export function panelShell(id: string, label: string, title: string): { root: HTMLElement; kicker: HTMLElement; head: HTMLElement; message: HTMLElement; preview: HTMLElement; menu: HTMLElement } {
  const root = el('section', `fr-panel fr-panel-${id} fr-panel-station`);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', label);
  root.hidden = true;
  const kicker = el('p', 'fr-kicker', label.toUpperCase());
  const head = el('p', 'fr-stats fr-station-head');
  const message = el('p', 'fr-text fr-station-msg');
  message.setAttribute('role', 'status');
  const preview = el('div', 'fr-station-preview');
  preview.hidden = true;
  const menu = el('div', 'fr-menu fr-fab fr-station');
  root.append(kicker, el('h2', 'fr-title', title), head, message, preview, menu);
  return { root, kicker, head, message, preview, menu };
}
