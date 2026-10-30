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
import type { MapCommand } from '../input.ts';
import type { Direction } from './layout.ts';
import type { RequirementInfo } from './progress.ts';

import { el } from '../progression/ui/common.ts';

export { el };

/** The fuel advice both maps give when a jump costs more cells than the hold carries. */
export const DOCK_FOR_CELLS = 'Dock at a station for free emergency cells or buy cells at an exchange.';

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
  /** Show or hide the travel confirmation (closing with `restore` returns focus to the detail actions). */
  confirm(open: boolean, restore?: boolean): void;
  /** The travel animation: the node list and details stay inert while it plays. */
  travelling(on: boolean): void;
  /** Hide the map: confirmation closed, travel animation dropped, hover cleared. */
  hide(): void;
  /** The node under the mouse (null when none). */
  hovered: string | null;
  /** A map node button: click / focus select it through `n` (never while travelling), mouse hover sets `hovered`. */
  node(className: string, attr: string, id: string, name: string, n: MapNav): HTMLButtonElement;
  /** The one keyboard / pad command router of both maps (FR-TD-98). */
  route(c: MapCommand, confirming: boolean, close: (restore: boolean) => void, n: MapNav): void;
}

/** What the shared router needs from a map screen (node ids are the screen's own). */
export interface MapNav {
  readonly selected: () => string | null;
  readonly focused: () => string | null;
  readonly select: (id: string) => void;
  readonly focusNode: (id: string | null) => void;
  readonly exit: () => void;
  /** CONFIRM on a node with no action: announce why it cannot be reached. */
  readonly unreachable: (id: string) => void;
  /** The neighbour in that direction (undefined before the first layout). */
  readonly next: (from: string, c: Direction) => string | null | undefined;
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

  const setInert = (on: boolean): void => {
    for (const n of [head, fieldBox, details]) n.inert = on;
  };
  root.append(head, fieldBox, details, confirmLayer, live);
  o.parent.append(root);

  const api: MapShell = {
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
    setInert,
    confirm(open, restore) {
      confirmLayer.hidden = !open;
      if (open) root.dataset['confirm'] = 'open';
      else delete root.dataset['confirm'];
      setInert(open);
      if (open) confirmMenu.focus(0);
      else if (restore) {
        moveSound();
        actionMenu.focus(0);
      }
    },
    hide() {
      api.confirm(false);
      api.travelling(false);
      root.hidden = true;
      api.hovered = null;
    },
    hovered: null,
    node(className, attr, id, name, n) {
      const b = button(className, '', () => {
        if (nodesNav.inert) return;
        if (n.selected() !== id) moveSound();
        n.select(id);
        b.focus({ preventScroll: true }); // Safari does not focus buttons on click
      });
      b.dataset[attr] = id;
      b.setAttribute('aria-controls', details.id);
      b.append(el('span', 'fr-node-name', name), el('span', 'fr-node-sub'));
      b.addEventListener('focus', () => {
        if (!nodesNav.inert && n.selected() !== id) n.select(id);
      });
      b.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') api.hovered = id;
      });
      b.addEventListener('pointerleave', () => {
        if (api.hovered === id) api.hovered = null;
      });
      return b;
    },
    travelling(on) {
      if (on) root.dataset['travel'] = 'on';
      else delete root.dataset['travel'];
      nodesNav.inert = on;
      details.inert = on;
    },
    route(c, confirming, close, n) {
      if (confirming) {
        if (c === 'up' || c === 'left') confirmMenu.move(-1);
        else if (c === 'down' || c === 'right') confirmMenu.move(1);
        else if (c === 'confirm') confirmMenu.activate();
        else if (c === 'back') close(true);
        return;
      }
      const a = document.activeElement;
      // a focused header control (◀ MENU, SAVES, the Admin chip) or detail action: Enter / Space / A presses it
      if (a instanceof HTMLElement && (details.contains(a) || (a !== head && head.contains(a)))) {
        if (c === 'back') {
          n.focusNode(n.selected());
          moveSound();
        } else if (c === 'confirm') a.click();
        else if (detActions.contains(a) && actionMenu.buttons().length > 1 && (c === 'up' || c === 'down')) actionMenu.move(c === 'up' ? -1 : 1);
        else n.focusNode(n.selected());
        return;
      }
      if (c === 'back') return n.exit();
      const id = n.focused() ?? n.selected();
      if (!id) return;
      if (c === 'confirm') {
        if (id !== n.selected()) n.select(id);
        if (actionMenu.buttons().length > 0) {
          moveSound();
          actionMenu.focus(0);
        } else {
          n.unreachable(id);
          n.focusNode(id);
        }
        return;
      }
      const next = n.next(id, c);
      if (next === undefined) return;
      if (next) {
        moveSound();
        n.select(next);
        n.focusNode(next);
      } else n.focusNode(id);
    },
  };
  return api;
}
