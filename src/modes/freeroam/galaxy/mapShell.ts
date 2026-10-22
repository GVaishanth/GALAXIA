/**
 * Shared DOM shell for the Free Roam map screens (galaxy map and system map):
 * header with back button, a canvas field with a layer of real <button> nodes,
 * a details panel with an action menu, a confirmation dialog and a polite live
 * region. Each screen fills in its own content; the shell owns no game logic.
 *
 * Ids differ per screen (details panel, dialog title) because both screens
 * live in the DOM at the same time (one is hidden).
 */
import type { ModeContext } from '../../types.ts';
import type { DisposableScope } from '../../../shared/lifecycle/scope.ts';
import { CanvasSurface } from '../../../shared/rendering/canvasSurface.ts';
import { MenuList } from '../../../shared/ui/menuList.ts';
import type { RequirementInfo } from './progress.ts';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Requirement checklist (✓ met / ✗ unmet, progress, composite parts). */
export function reqList(infos: readonly RequirementInfo[]): HTMLElement {
  const ul = el('ul', 'fr-req-list');
  for (const info of infos) {
    const li = el('li', 'fr-req');
    li.dataset['met'] = String(info.met);
    const top = el('div', 'fr-req-top');
    top.append(el('span', 'fr-req-mark', info.met ? '✓' : '✗'), el('span', 'fr-req-title', info.title.toUpperCase()));
    if (info.progress) top.append(el('span', 'fr-req-progress', info.progress));
    li.append(top, el('p', 'fr-req-detail', info.detail));
    if (info.parts.length) {
      const parts = el('ul', 'fr-req-parts');
      for (const p of info.parts) {
        const pl = el('li', '', `${p.met ? '✓' : '·'} ${p.text}${p.progress ? ` (${p.progress})` : ''}`);
        pl.dataset['met'] = String(p.met);
        parts.append(pl);
      }
      li.append(parts);
    }
    ul.append(li);
  }
  return ul;
}

export interface MapShellOptions {
  readonly scope: DisposableScope;
  readonly parent: HTMLElement;
  readonly services: ModeContext['services'];
  /** Extra root classes after `fr-map`. */
  readonly rootClass?: string;
  readonly label: string;
  readonly kicker?: string;
  readonly title: string;
  /** `menu`: this button leaves to the GALAXIA main menu (yellow ◀ MENU style, as in Classic). */
  readonly back: { readonly text: string; readonly aria: string; readonly onClick: () => void; readonly menu?: boolean };
  readonly note: string;
  readonly hintKeys: string;
  readonly hintTouch: string;
  readonly navLabel: string;
  readonly detailsId: string;
  readonly detailsLabel: string;
  readonly confirm: { readonly titleId: string; readonly kicker: string; readonly note: string; readonly onEngage: () => void; readonly onCancel: () => void };
}

export interface MapShell {
  readonly root: HTMLElement;
  readonly head: HTMLElement;
  readonly back: HTMLButtonElement;
  readonly title: HTMLElement;
  readonly sub: HTMLElement;
  readonly fieldBox: HTMLElement;
  readonly surface: CanvasSurface;
  readonly nodesNav: HTMLElement;
  readonly details: HTMLElement;
  readonly detArt: HTMLCanvasElement;
  readonly detKicker: HTMLElement;
  readonly detName: HTMLElement;
  readonly detClass: HTMLElement;
  readonly detBody: HTMLElement;
  readonly detActions: HTMLElement;
  readonly actionMenu: MenuList;
  readonly confirmLayer: HTMLElement;
  readonly cTitle: HTMLElement;
  readonly cRoute: HTMLElement;
  readonly cStats: HTMLElement;
  readonly cNote: HTMLElement;
  readonly confirmMenu: MenuList;
  announce(text: string): void;
  /** Make everything behind the dialog inert (or not). */
  setInert(on: boolean): void;
}

export const DET_ART_SIZE = 48;

export function createMapShell(o: MapShellOptions): MapShell {
  const moveSound = (): void => {
    o.services.sound.play('uiMove');
  };
  const root = el('section', o.rootClass ? `fr-map ${o.rootClass}` : 'fr-map');
  root.hidden = true;
  root.setAttribute('aria-label', o.label);

  const head = el('header', 'fr-map-head');
  // the main-menu exit wears the shared yellow ◀ MENU style (both modes); in-map 'back' links stay plain
  const back = button(o.back.menu ? 'fr-map-back menu-btn' : 'fr-map-back', o.back.text, o.back.onClick);
  back.setAttribute('aria-label', o.back.aria);
  const titleBox = el('div', 'fr-map-titles');
  const title = el('h1', 'fr-map-title', o.title);
  const sub = el('p', 'fr-map-sub');
  if (o.kicker) titleBox.append(el('p', 'fr-map-kicker', o.kicker));
  titleBox.append(title, sub);
  const meta = el('div', 'fr-map-meta');
  const hint = el('p', 'fr-map-hint');
  hint.append(el('span', 'fr-hint-keys', o.hintKeys), el('span', 'fr-hint-touch', o.hintTouch));
  meta.append(el('p', 'fr-map-note', o.note), hint);
  head.append(back, titleBox, meta);

  const fieldBox = el('div', 'fr-map-field');
  const surface = new CanvasSurface(fieldBox, o.scope, o.label, 'fr-map-canvas');
  surface.canvas.setAttribute('aria-hidden', 'true');
  const nodesNav = el('nav', 'fr-map-nodes');
  nodesNav.setAttribute('aria-label', o.navLabel);
  fieldBox.append(nodesNav);

  const details = el('aside', 'fr-map-details');
  details.id = o.detailsId;
  details.setAttribute('aria-label', o.detailsLabel);
  const detHead = el('div', 'fr-det-head');
  const detArt = el('canvas', 'fr-det-art');
  detArt.width = DET_ART_SIZE;
  detArt.height = DET_ART_SIZE;
  detArt.setAttribute('aria-hidden', 'true');
  const detTitles = el('div', 'fr-det-titles');
  const detKicker = el('p', 'fr-det-kicker');
  const detName = el('h2', 'fr-det-name');
  const detClass = el('p', 'fr-det-class');
  detTitles.append(detKicker, detName, detClass);
  detHead.append(detArt, detTitles);
  const detBody = el('div', 'fr-det-body');
  const detActions = el('div', 'fr-det-actions');
  details.append(detHead, detBody, detActions);
  const actionMenu = new MenuList(detActions, moveSound);

  const confirmLayer = el('div', 'fr-map-confirm');
  confirmLayer.hidden = true;
  const confirmPanel = el('section', 'fr-panel fr-confirm');
  confirmPanel.setAttribute('role', 'dialog');
  confirmPanel.setAttribute('aria-modal', 'true');
  confirmPanel.setAttribute('aria-labelledby', o.confirm.titleId);
  const cTitle = el('h2', 'fr-title');
  cTitle.id = o.confirm.titleId;
  const cRoute = el('p', 'fr-text');
  const cStats = el('p', 'fr-stats');
  const cNote = el('p', 'fr-text fr-text-dim', o.confirm.note);
  const cMenu = el('div', 'fr-menu');
  cMenu.append(button('fr-btn', 'ENGAGE', o.confirm.onEngage), button('fr-btn', 'CANCEL', o.confirm.onCancel));
  confirmPanel.append(el('p', 'fr-kicker', o.confirm.kicker), cTitle, cRoute, cStats, cNote, cMenu);
  confirmLayer.append(confirmPanel);
  const confirmMenu = new MenuList(cMenu, moveSound);

  const live = el('p', 'fr-sr-only');
  live.setAttribute('aria-live', 'polite');

  root.append(head, fieldBox, details, confirmLayer, live);
  o.parent.append(root);

  return {
    root,
    head,
    back,
    title,
    sub,
    fieldBox,
    surface,
    nodesNav,
    details,
    detArt,
    detKicker,
    detName,
    detClass,
    detBody,
    detActions,
    actionMenu,
    confirmLayer,
    cTitle,
    cRoute,
    cStats,
    cNote,
    confirmMenu,
    announce(text) {
      live.textContent = text;
    },
    setInert(on) {
      for (const n of [head, fieldBox, details]) n.inert = on;
    },
  };
}
