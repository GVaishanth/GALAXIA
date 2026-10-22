/**
 * Station hub (Prompt 12): the overview opened on docking and the tab strip
 * shared by every docked panel. DOM only; the words come from
 * ui/stationModel.ts and the actions are the shell's existing ones.
 *
 * The tab strip is a single element that the shell moves into whichever
 * station panel is showing, so there is never more than one (and never more
 * than one open overlay). Tabs are real buttons (role="tab"): reachable with
 * Tab, operable with Enter / Space / a tap, and switched with [ and ] (or
 * PageUp / PageDown, or the pad's X) from anywhere in a station panel. On
 * narrow screens the strip scrolls sideways (full names, never abbreviated)
 * and keeps the current tab in view.
 */
import { MenuList } from '../../../shared/ui/menuList.ts';
import { btn, el } from '../progression/ui/common.ts';
import { STATION_TABS, TAB_LABEL, stationOverview, type StationSummary, type StationTab } from './stationModel.ts';

export interface StationDeps {
  readonly summary: () => StationSummary;
  readonly open: (tab: StationTab) => void;
  readonly launch: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
}

export interface StationPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  /** The shared tab strip (the shell mounts it into the showing station panel). */
  readonly tabs: HTMLElement;
  open(): void;
  /** Mark the current tab and mount the strip at the top of `panel`. */
  mountTabs(panel: HTMLElement, current: StationTab): void;
  /** Focus the current tab button (after a tab was chosen with the pointer or keys). */
  focusTab(): void;
  status(): { readonly title: string; readonly lines: readonly string[]; readonly services: readonly string[]; readonly tab: StationTab | null };
}

export function createStationPanel(d: StationDeps): StationPanel {
  const root = el('section', 'fr-panel fr-panel-station-hub fr-panel-station');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Station');
  root.hidden = true;
  const kicker = el('p', 'fr-kicker', 'STATION');
  const title = el('h2', 'fr-title', 'STATION');
  const statusLine = el('p', 'fr-text fr-station-msg');
  statusLine.setAttribute('role', 'status');
  const facts = el('dl', 'fr-hub-facts');
  const menu = el('div', 'fr-menu fr-hub');
  root.append(kicker, title, statusLine, facts, menu);
  const menuList = new MenuList(menu, () => d.sound('uiMove'));

  // the tab strip (one element, moved between panels)
  const tabs = el('nav', 'fr-tabs');
  tabs.setAttribute('aria-label', 'Station sections');
  const tabList = el('div', 'fr-tablist');
  tabList.setAttribute('role', 'tablist');
  // the strip has its own shortcuts ([ ] / PageUp / PageDown / pad X): arrows move in the content
  tabs.dataset['menuSkip'] = '';
  const tabBtns = new Map<StationTab, HTMLButtonElement>();
  for (const t of STATION_TABS) {
    const b = el('button', `fr-tab fr-tab-${t}`, TAB_LABEL[t]);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', 'false');
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-selected') === 'true') return;
      d.open(t);
      b.focus({ preventScroll: true });
    });
    tabBtns.set(t, b);
    tabList.append(b);
  }
  const launchTab = el('button', 'fr-tab fr-tab-launch', 'LAUNCH');
  launchTab.type = 'button';
  launchTab.setAttribute('aria-label', 'Launch: undock and fly on');
  launchTab.addEventListener('click', () => d.launch());
  tabs.append(tabList, launchTab);
  let current: StationTab | null = null;
  let lines: string[] = [];
  let services: string[] = [];

  function refresh(): void {
    const o = stationOverview(d.summary());
    kicker.textContent = o.kicker;
    title.textContent = o.title;
    statusLine.textContent = o.status;
    facts.replaceChildren();
    lines = [];
    for (const l of o.lines) {
      const dt = el('dt', '', l.label);
      const dd = el('dd', l.accent ? 'is-accent' : '', l.value);
      facts.append(dt, dd);
      lines.push(`${l.label} ${l.value}`);
    }
    const grid = el('div', 'fr-hub-services');
    services = [];
    for (const sv of o.services) {
      const b = btn(`fr-hub-card fr-hub-${sv.tab}`, '', `hub:${sv.tab}`, () => d.open(sv.tab));
      b.setAttribute('aria-label', `${sv.title}: ${sv.detail}${sv.badge ? ` (${sv.badge})` : ''}`);
      const head = el('span', 'fr-hub-card-head');
      head.append(el('span', 'fr-hub-card-title', sv.title));
      if (sv.badge) head.append(el('span', 'fr-hub-badge', sv.badge));
      b.append(head, el('span', 'fr-hub-card-detail', sv.detail));
      grid.append(b);
      services.push(sv.tab);
    }
    const actions = el('div', 'fr-fab-actions');
    actions.append(btn('fr-hub-launch', 'LAUNCH', 'launch', () => d.launch()));
    menu.replaceChildren(grid, actions);
  }

  return {
    root,
    menu: menuList,
    tabs,
    open() {
      refresh();
      menuList.focus(0);
    },
    mountTabs(panel, tab) {
      current = tab;
      for (const [t, b] of tabBtns) {
        const on = t === tab;
        b.setAttribute('aria-selected', String(on));
        b.classList.toggle('is-current', on);
      }
      // at the top of the panel: the title below stays the panel's own
      if (tabs.parentElement !== panel) panel.prepend(tabs);
      const b = tabBtns.get(tab);
      if (b) tabList.scrollLeft = Math.max(0, b.offsetLeft - tabList.offsetLeft - (tabList.clientWidth - b.offsetWidth) / 2);
      tabList.classList.toggle('is-scrollable', tabList.scrollWidth > tabList.clientWidth + 1);
    },
    focusTab() {
      if (current) tabBtns.get(current)?.focus({ preventScroll: true });
    },
    status() {
      return { title: title.textContent ?? '', lines: [...lines], services: [...services], tab: current };
    },
  };
}
