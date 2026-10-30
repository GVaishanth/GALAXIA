/**
 * Admin Access panel (P04). DOM only: every decision is made by the mode
 * through AdminPanelDeps (which calls admin/session.ts). The panel is built
 * only after a successful activation, so ordinary players never have it in
 * the page.
 *
 * Modal over any Free Roam screen (like the save slots panel): a status
 * block that says the session is a sandbox (nothing saved, costs bypassed,
 * the real balance untouched), the Admin Navigator (galaxies -> systems,
 * search, details, TRAVEL to the arrival or the station), the ship list
 * (every roster ship with its real stats and weapon mounts, SELECT), and
 * HANGAR / CLOSE / EXIT ADMIN. EXIT asks for a confirmation with CANCEL
 * focused, so a repeated Enter never ends the session by accident.
 *
 * No timers, frame loops or global listeners: element-owned listeners only.
 */
import { MenuList } from '../../../shared/ui/menuList.ts';
import type { GalaxyId } from '../catalogue/types.ts';
import { btn, el, focusedKey } from '../progression/ui/common.ts';
import { NORMAL_TEXT, type NavGalaxyRow, type NavSystemRow } from './navigator.ts';
import type { DestinationRef } from './session.ts';

export interface AdminShipRow {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  /** flying = the ship flown; owned = really owned; admin = usable only through admin access. */
  readonly access: 'flying' | 'owned' | 'admin';
  /** Real numbers the ship flies with (hangar view model). */
  readonly stats: string;
  /** Weapons its mounts accept (catalogue). */
  readonly weapons: string;
}

export interface AdminPanelView {
  /** "Petrel at Sol · Milky Way" (the normal save, restored on exit). */
  readonly origin: string;
  /** Where the sandbox is now. */
  readonly here: string;
  readonly hereGalaxy: GalaxyId;
  /** Ship switching is possible now (docked, on a map or in a briefing); otherwise why not. */
  readonly shipSwitch: { readonly ok: boolean; readonly why: string };
}

export interface AdminPanelDeps {
  readonly view: () => AdminPanelView;
  readonly galaxies: () => readonly NavGalaxyRow[];
  readonly systems: (galaxy: GalaxyId, query: string) => readonly NavSystemRow[];
  readonly ships: () => readonly AdminShipRow[];
  /** Travel there now. '' = travelling (the mode closes the panel), otherwise an error line. */
  readonly travel: (ref: DestinationRef) => string;
  /** Switch to a ship; returns the feedback line. */
  readonly selectShip: (id: string) => string;
  /** Open the hangar (docked) or go to the nearest station. '' = done (panel closed), otherwise a line. */
  readonly hangar: () => string;
  /** End the session (confirmed already): the mode restores the normal save. */
  readonly exit: () => void;
  readonly close: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect') => void;
}

export type AdminCommand = 'prev' | 'next' | 'confirm' | 'back';
export type AdminTab = 'navigator' | 'ships';

export interface AdminPanel {
  readonly root: HTMLElement;
  isOpen(): boolean;
  open(message?: string): void;
  hide(): void;
  refresh(): void;
  command(c: AdminCommand): void;
  status(): { readonly open: boolean; readonly tab: AdminTab; readonly galaxy: GalaxyId | null; readonly selected: string | null; readonly query: string; readonly confirmExit: boolean; readonly message: string; readonly systems: number; readonly ships: number };
}

const ACCESS_TEXT: Readonly<Record<AdminShipRow['access'], string>> = { flying: 'FLYING', owned: 'OWNED', admin: 'ADMIN ACCESS · NOT OWNED' };

export function createAdminPanel(d: AdminPanelDeps): AdminPanel {
  const root = el('section', 'fr-admin');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'fr-admin-title');
  root.hidden = true;
  const box = el('div', 'fr-panel fr-admin-box');
  const kicker = el('p', 'fr-kicker', 'OWNER SANDBOX');
  const title = el('h2', 'fr-title', 'ADMIN\u00a0ACCESS \u00b7\u00a0ACTIVE');
  title.id = 'fr-admin-title';
  const statusBox = el('div', 'fr-admin-status');
  const message = el('p', 'fr-text fr-admin-msg');
  message.setAttribute('aria-live', 'polite');
  const tabs = el('div', 'fr-admin-tabs');
  tabs.setAttribute('role', 'tablist');
  const body = el('div', 'fr-admin-body');
  const foot = el('div', 'fr-menu fr-admin-foot');
  box.append(kicker, title, statusBox, message, tabs, body, foot);
  root.append(box);
  const menu = new MenuList(box, () => d.sound('uiMove'));

  let open = false;
  let tab: AdminTab = 'navigator';
  let galaxy: GalaxyId | null = null;
  let selected: string | null = null;
  let query = '';
  let confirmExit = false;
  let msg = '';
  let systemCount = 0;
  let shipCount = 0;

  const say = (text: string): void => {
    msg = text;
    message.textContent = text;
    message.hidden = text === '';
  };
  const focusKey = (key: string | undefined): void => {
    if (!key) return;
    const b = box.querySelector<HTMLButtonElement>(`button[data-key="${CSS.escape(key)}"]:not([disabled])`);
    if (b) {
      b.focus({ preventScroll: true });
      b.scrollIntoView({ block: 'nearest' });
    }
  };
  const currentKey = (): string | undefined => focusedKey(box);

  // the search field: element-owned listener; typing never reaches the game (the key tracker ignores text fields)
  const search = el('input', 'fr-admin-search');
  search.type = 'search';
  search.placeholder = 'Search systems';
  search.setAttribute('aria-label', 'Search systems in every galaxy');
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.addEventListener('input', () => {
    query = search.value;
    selected = null;
    renderBody();
  });

  const renderStatus = (): void => {
    const v = d.view();
    statusBox.replaceChildren(
      el('p', 'fr-text', 'Sandbox session: nothing done here is saved. Travel and ship access cost nothing; your reactor cells, cargo and marks are not changed.'),
      el('p', 'fr-text fr-text-dim', `Normal save: ${v.origin}. Restored when you exit.`),
      el('p', 'fr-text fr-text-dim fr-admin-here', `Sandbox position: ${v.here}`),
    );
  };

  const renderTabs = (): void => {
    const mk = (id: AdminTab, label: string): HTMLButtonElement => {
      const b = btn('fr-admin-tab', label, `tab-${id}`, () => {
        if (tab === id) return;
        d.sound('uiMove');
        tab = id;
        confirmExit = false;
        render(`tab-${id}`);
      });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(tab === id));
      b.classList.toggle('is-on', tab === id);
      return b;
    };
    tabs.replaceChildren(mk('navigator', 'NAVIGATOR'), mk('ships', 'SHIPS'));
  };

  const renderNavigator = (): HTMLElement[] => {
    const gals = d.galaxies();
    if (!galaxy || !gals.some((g) => g.id === galaxy)) galaxy = d.view().hereGalaxy;
    const galBox = el('div', 'fr-admin-galaxies');
    galBox.setAttribute('aria-label', 'Galaxies');
    for (const g of gals) {
      const b = btn('fr-admin-gal', `${g.short.toUpperCase()}${g.here ? ' · HERE' : ''}`, `gal-${g.id}`, () => {
        d.sound('uiMove');
        galaxy = g.id;
        selected = null;
        query = '';
        search.value = '';
        render(`gal-${g.id}`);
      });
      b.classList.toggle('is-on', g.id === galaxy && !query.trim());
      b.title = `${g.name}: ${g.systems} systems, ${g.stations} with a station${g.normallyLocked ? ' · locked in normal play' : ''}`;
      b.setAttribute('aria-label', `${g.name}, ${g.systems} systems${g.normallyLocked ? ', locked in normal play' : ''}${g.here ? ', you are here' : ''}`);
      if (g.normallyLocked) b.dataset['locked'] = 'true';
      galBox.append(b);
    }
    const rows = d.systems(galaxy, query);
    systemCount = rows.length;
    const g = gals.find((x) => x.id === galaxy)!;
    const head = el('p', 'fr-admin-listhead', query.trim() ? `${rows.length} MATCHING ${rows.length === 1 ? 'SYSTEM' : 'SYSTEMS'} · ALL GALAXIES` : `${g.name.toUpperCase()} · ${rows.length} SYSTEMS${g.normallyLocked ? ' · LOCKED IN NORMAL PLAY' : ''}`);
    const list = el('div', 'fr-admin-systems');
    for (const r of rows) {
      const tags = [r.here ? 'HERE' : '', r.station ? 'STATION' : '', r.gateway ? 'GATEWAY' : '', r.normal !== 'open' ? r.normal === 'undiscovered' ? 'UNDISCOVERED' : 'LOCKED' : ''].filter(Boolean);
      const b = btn('fr-admin-sys', '', `sys-${r.id}`, () => {
        d.sound('uiMove');
        selected = r.id;
        render(`sys-${r.id}`);
      });
      b.append(el('span', 'fr-admin-sys-name', query.trim() ? `${r.name} · ${r.galaxyName}` : r.name), el('span', 'fr-admin-sys-meta', `${r.category} · D${r.difficulty}${tags.length ? ` · ${tags.join(' · ')}` : ''}`));
      b.classList.toggle('is-on', r.id === selected);
      b.setAttribute('aria-pressed', String(r.id === selected));
      list.append(b);
    }
    if (rows.length === 0) list.append(el('p', 'fr-text fr-text-dim', 'No system matches that search.'));
    const out: HTMLElement[] = [search, galBox, head, list];
    const sel = rows.find((r) => r.id === selected);
    if (sel) {
      const det = el('div', 'fr-admin-detail');
      det.append(
        el('h3', 'fr-admin-det-title', sel.name.toUpperCase()),
        el('p', 'fr-text', `${sel.galaxyName} · ${sel.category} · difficulty ${sel.difficulty}${sel.station ? ' · station' : ''}${sel.gateway ? ' · gateway' : ''}`),
        el('p', 'fr-text fr-text-dim', `${NORMAL_TEXT[sel.normal]}. Admin travel ignores unlocks, routes and fuel; the sector is generated from the game data as usual.`),
      );
      const acts = el('div', 'fr-admin-det-actions');
      const go = (arrival: 'arrival' | 'station'): void => {
        d.sound('uiSelect');
        const err = d.travel({ galaxy: sel.galaxy, system: sel.id, arrival });
        if (err) {
          say(err);
          render(currentKey());
        }
      };
      acts.append(btn('', 'TRAVEL · ARRIVAL', `go-${sel.id}`, () => go('arrival')));
      if (sel.station) acts.append(btn('', 'TRAVEL · STATION', `dock-${sel.id}`, () => go('station')));
      det.append(acts);
      out.push(det);
    }
    return out;
  };

  const renderShips = (): HTMLElement[] => {
    const v = d.view();
    const rows = d.ships();
    shipCount = rows.length;
    const note = el('p', `fr-text ${v.shipSwitch.ok ? 'fr-text-dim' : 'fr-admin-warn'}`, v.shipSwitch.ok ? 'Every ship in the roster, with its real stats and weapon mounts. Admin access does not change what a ship can mount.' : v.shipSwitch.why);
    const list = el('div', 'fr-admin-ships');
    for (const r of rows) {
      const card = el('article', `fr-admin-ship fr-admin-ship-${r.access}`);
      card.dataset['ship'] = r.id;
      card.append(el('h3', 'fr-admin-ship-name', `${r.name.toUpperCase()} · ${r.role.toUpperCase()}`), el('p', 'fr-admin-ship-access', ACCESS_TEXT[r.access]), el('p', 'fr-text fr-text-dim', r.stats), el('p', 'fr-text fr-text-dim', `Weapons: ${r.weapons}`));
      const b = btn('', r.access === 'flying' ? 'FLYING' : 'SELECT', `ship-${r.id}`, () => {
        d.sound('uiSelect');
        say(d.selectShip(r.id));
        render(`ship-${r.id}`);
      });
      b.disabled = r.access === 'flying' || !v.shipSwitch.ok;
      card.append(b);
      list.append(card);
    }
    return [note, list];
  };

  const renderFoot = (): void => {
    if (confirmExit) {
      foot.replaceChildren(
        el('p', 'fr-text', 'Exit Admin Access? The sandbox (ship, place and everything since activation) is discarded and Free Roam reloads your normal save.'),
        btn('', 'CANCEL', 'exit-cancel', () => {
          d.sound('uiMove');
          confirmExit = false;
          say('Admin Access stays active.');
          render('exit');
        }),
        btn('fr-btn-danger', 'EXIT AND RESTORE', 'exit-confirm', () => {
          d.sound('uiSelect');
          confirmExit = false;
          d.exit();
        }),
      );
      return;
    }
    foot.replaceChildren(
      btn('', 'HANGAR', 'hangar', () => {
        d.sound('uiSelect');
        const r = d.hangar();
        if (r) {
          say(r);
          render('hangar');
        }
      }),
      btn('', 'CLOSE', 'close', () => {
        d.sound('uiMove');
        d.close();
      }),
      btn('fr-btn-danger', 'EXIT ADMIN', 'exit', () => {
        d.sound('uiSelect');
        confirmExit = true;
        render('exit-cancel');
      }),
    );
  };

  function renderBody(): void {
    body.replaceChildren(...(tab === 'navigator' ? renderNavigator() : renderShips()));
  }

  function render(focus?: string): void {
    renderStatus();
    renderTabs();
    renderBody();
    renderFoot();
    if (focus) focusKey(focus);
  }

  return {
    root,
    isOpen: () => open,
    open(text = '') {
      open = true;
      confirmExit = false;
      selected = null;
      say(text);
      root.hidden = false;
      render();
      if (!box.contains(document.activeElement)) menu.focus(0);
    },
    hide() {
      open = false;
      confirmExit = false;
      root.hidden = true;
    },
    refresh() {
      if (open) render(currentKey());
    },
    command(c) {
      if (!open) return;
      if (c === 'prev') menu.move(-1);
      else if (c === 'next') menu.move(1);
      else if (c === 'confirm') menu.activate();
      else if (confirmExit) {
        confirmExit = false;
        d.sound('uiMove');
        say('Admin Access stays active.');
        render('exit');
      } else {
        d.sound('uiMove');
        d.close();
      }
      const a = document.activeElement;
      if (a instanceof HTMLElement && box.contains(a)) a.scrollIntoView({ block: 'nearest' });
    },
    status() {
      return { open, tab, galaxy, selected, query, confirmExit, message: msg, systems: systemCount, ships: shipCount };
    },
  };
}
