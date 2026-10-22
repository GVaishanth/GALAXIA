/**
 * Cargo hold panel (Free Roam Prompt 10). DOM only: every rule comes from
 * inventory/inventory.ts (rows, stacks, sorting, filtering), every word and
 * number from inventory/resources.ts. The flight is paused while it is open.
 *
 *  - Capacity bar of the ship flown (used / capacity, FULL marked by text and
 *    a pattern, not colour alone).
 *  - SORT and FILTER cycle through their options (one button each: the same
 *    with keys, a pad or touch).
 *  - One row per resource: icon, name, rarity, amount, stacks. Focusing or
 *    clicking a row shows its details: description, category, rarity, value,
 *    where it comes from and what it is used for.
 *  - JETTISON takes two presses; the stack floats out behind the ship as a
 *    pod that can be picked up again for a minute (nothing is destroyed).
 *  - Stored modules (built at a station fabricator) are listed read-only;
 *    fitting happens at a station.
 */
import { MenuList } from '../../../../shared/ui/menuList.ts';
import { EQUIPMENT_BY_ID } from '../../ships/equipment.ts';
import { categoryCounts, holdUnits, inventoryRows, SORT_KEYS, SORT_LABEL, type CategoryFilter, type Hold, type ModuleStore, type SortKey } from '../inventory.ts';
import { CATEGORY_INFO, LOOT_SOURCES, RARITY_LABEL, RESOURCE_CATEGORIES, RESOURCES, type LootSource } from '../resources.ts';
import type { ResourceId } from '../../catalogue/types.ts';
import { iconImg } from './iconImages.ts';

export interface InventoryDeps {
  readonly cargo: () => Hold;
  readonly capacity: () => number;
  readonly shipName: () => string;
  readonly modules: () => ModuleStore;
  /** Throw a whole stack out; returns the message to show (the shell commits the profile). */
  readonly jettison: (resource: string) => string;
  readonly resume: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect') => void;
}

export interface InventoryPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  /** Refresh contents (after the panel is shown, or after a change). */
  refresh(message?: string): void;
  /** Reset transient state (pending jettison, selection) when opened. */
  open(): void;
  status(): { readonly sort: SortKey; readonly filter: CategoryFilter; readonly selected: string | null; readonly pending: string | null; readonly rows: readonly string[]; readonly message: string };
}

const SOURCE_TEXT: Readonly<Record<LootSource, string>> = {
  enemy: 'enemy salvage pods',
  container: 'caches',
  wreck: 'derelict wrecks',
  mining: 'ore veins',
  salvage: 'salvage fields',
  anomaly: 'anomalies',
  outpost: 'outposts',
  encounter: 'encounters',
  mission: 'missions',
  milestone: 'milestones',
};
const USE_TEXT = { fabrication: 'station fabricator', licence: 'ship licences' } as const;
const DEFAULT_NOTE = 'Finds that do not fit open a choice in flight: take what fits, swap cheaper cargo out, or leave it marked on the map.';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function createInventoryPanel(d: InventoryDeps): InventoryPanel {
  const root = el('section', 'fr-panel fr-panel-cargo');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Cargo hold');
  root.hidden = true;
  const cap = el('p', 'fr-stats fr-cargo-cap');
  const bar = el('span', 'fr-inv-bar');
  const fill = el('span', 'fr-inv-fill');
  bar.append(fill);
  bar.setAttribute('aria-hidden', 'true');
  const body = el('div', 'fr-inv');
  const list = el('ul', 'fr-cargo');
  list.setAttribute('aria-label', 'Resources in the hold');
  const detail = el('div', 'fr-inv-detail');
  detail.setAttribute('aria-live', 'polite');
  const mods = el('div', 'fr-inv-modules');
  body.append(list, detail);
  const note = el('p', 'fr-text fr-text-dim fr-cargo-note');
  note.setAttribute('role', 'status');
  const menu = el('div', 'fr-menu');
  const tools = el('div', 'fr-inv-tools');
  const sortBtn = el('button', 'fr-btn fr-inv-sort', '');
  sortBtn.type = 'button';
  const filterBtn = el('button', 'fr-btn fr-inv-filter', '');
  filterBtn.type = 'button';
  tools.append(sortBtn, filterBtn);
  const resumeBtn = el('button', 'fr-btn', 'RESUME');
  resumeBtn.type = 'button';
  resumeBtn.addEventListener('click', () => d.resume());
  // the tools, the rows' buttons and RESUME form one roving menu
  menu.append(tools, body, mods, resumeBtn);
  root.append(el('p', 'fr-kicker', 'FREE ROAM'), el('h2', 'fr-title', 'CARGO HOLD'), cap, bar, note, menu);
  const menuList = new MenuList(menu, () => d.sound('uiMove'));

  let sort: SortKey = 'category';
  let filter: CategoryFilter = 'all';
  let selected: string | null = null;
  let pending: string | null = null;
  let message = '';

  const filters = (): CategoryFilter[] => {
    const counts = categoryCounts(d.cargo());
    return ['all', ...RESOURCE_CATEGORIES.filter((c) => counts[c] > 0)];
  };

  const showDetail = (id: string | null): void => {
    detail.replaceChildren();
    const def = id ? RESOURCES[id as ResourceId] : undefined;
    if (!def) {
      detail.append(el('p', 'fr-text fr-text-dim', 'Select a resource to see what it is, where it comes from and what it is for.'));
      return;
    }
    const head = el('h3', 'fr-inv-name');
    head.append(iconImg(def.id, 'fr-icon fr-icon-big'), document.createTextNode(def.name.toUpperCase()));
    const meta = el('p', 'fr-inv-meta', `${CATEGORY_INFO[def.category].label} · ${RARITY_LABEL[def.rarity]} · value ${def.value} · stacks of ${def.stack}`);
    const desc = el('p', 'fr-text fr-inv-desc', def.description);
    const from = el('p', 'fr-text fr-text-dim fr-inv-from', `From: ${LOOT_SOURCES.filter((s) => def.sources.includes(s)).map((s) => SOURCE_TEXT[s]).join(', ')}.`);
    const use = el('p', 'fr-text fr-text-dim fr-inv-use', `Used for: ${def.uses.map((u) => USE_TEXT[u]).join(', ')}.`);
    detail.append(head, meta, desc, from, use);
  };

  const refresh = (msg?: string): void => {
    if (msg !== undefined) message = msg;
    const hold = d.cargo();
    const capacity = d.capacity();
    const used = holdUnits(hold);
    const full = used >= capacity;
    cap.textContent = `${d.shipName().toUpperCase()} HOLD ${used} / ${capacity}${full ? ' · FULL' : ''}`;
    cap.classList.toggle('is-full', full);
    bar.classList.toggle('is-full', full);
    fill.style.width = `${Math.min(100, Math.round((100 * used) / Math.max(1, capacity)))}%`;
    if (!filters().includes(filter)) filter = 'all';
    sortBtn.textContent = `SORT: ${SORT_LABEL[sort]}`;
    sortBtn.setAttribute('aria-label', `Sort by ${SORT_LABEL[sort].toLowerCase()} (press to change)`);
    filterBtn.textContent = `SHOW: ${filter === 'all' ? 'ALL' : CATEGORY_INFO[filter].short}`;
    filterBtn.setAttribute('aria-label', `Showing ${filter === 'all' ? 'all categories' : CATEGORY_INFO[filter].label} (press to change)`);

    const focusedRes = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset['resource'] : undefined;
    const focusedRole = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['role'] : undefined;
    list.replaceChildren();
    const rows = inventoryRows(hold, capacity, sort, filter);
    if (rows.length === 0) list.append(el('li', 'fr-cargo-empty', used === 0 ? 'The hold is empty. Fly through salvage, open caches and wrecks, chip ore veins and collect salvage pods.' : 'Nothing in this category.'));
    for (const r of rows) {
      const id = r.def.id;
      const li = el('li', `fr-cargo-row${selected === id ? ' is-selected' : ''}`);
      const pick = el('button', 'fr-inv-row');
      pick.type = 'button';
      pick.dataset['resource'] = id;
      pick.dataset['role'] = 'row';
      pick.dataset['rarity'] = r.def.rarity;
      pick.append(iconImg(id), el('span', 'fr-cargo-name', r.def.name.toUpperCase()), el('span', 'fr-inv-rarity', r.def.rarity === 'common' ? '' : RARITY_LABEL[r.def.rarity].toUpperCase()), el('span', 'fr-cargo-amount', String(r.amount)), el('span', 'fr-inv-stacks', r.stacks > 1 ? `${r.stacks} STACKS` : ''));
      pick.setAttribute('aria-label', `${r.def.name}: ${r.amount}, ${RARITY_LABEL[r.def.rarity].toLowerCase()}, ${r.stacks} ${r.stacks === 1 ? 'stack' : 'stacks'}`);
      pick.addEventListener('focus', () => {
        if (selected === id) return;
        selected = id;
        showDetail(id);
        for (const x of list.querySelectorAll('.fr-cargo-row')) x.classList.toggle('is-selected', x.contains(pick));
      });
      pick.addEventListener('click', () => {
        selected = id;
        showDetail(id);
      });
      const jb = el('button', `fr-btn fr-jettison${pending === id ? ' is-armed' : ''}`, pending === id ? 'CONFIRM' : 'JETTISON');
      jb.type = 'button';
      jb.dataset['resource'] = id;
      jb.dataset['role'] = 'jettison';
      jb.setAttribute('aria-label', pending === id ? `Confirm: jettison all ${r.amount} ${r.def.name} as a pod behind the ship` : `Jettison ${r.def.name}`);
      jb.addEventListener('click', () => {
        if (pending !== id) {
          pending = id;
          d.sound('uiMove');
          refresh(`Press again to jettison all ${r.amount} ${r.def.name.toUpperCase()}. It floats behind the ship as a pod for a minute.`);
          return;
        }
        pending = null;
        const m = d.jettison(id);
        d.sound('uiSelect');
        refresh(m);
      });
      li.append(pick, jb);
      list.append(li);
    }
    if (selected && !rows.some((r) => r.def.id === selected)) selected = null;
    showDetail(selected);

    mods.replaceChildren();
    const stored = Object.entries(d.modules()).filter(([, n]) => n > 0);
    mods.hidden = stored.length === 0;
    if (stored.length) {
      mods.append(el('p', 'fr-kicker fr-inv-mods-title', 'STORED MODULES · FIT THEM AT A STATION FABRICATOR'));
      const ul = el('ul', 'fr-inv-mods');
      for (const [id, n] of stored) {
        const item = EQUIPMENT_BY_ID.get(id);
        if (!item) continue;
        const li = el('li', 'fr-inv-mod');
        li.append(iconImg(`slot:${item.slot}`), el('span', 'fr-inv-mod-name', `${item.name.toUpperCase()}${n > 1 ? ` ×${n}` : ''}`), el('span', 'fr-inv-mod-slot', item.slot.toUpperCase()));
        li.title = item.description;
        ul.append(li);
      }
      mods.append(ul);
    }
    note.textContent = message || DEFAULT_NOTE;
    // keep focus on the same control after a rebuild
    if (focusedRes) list.querySelector<HTMLButtonElement>(`button[data-resource="${focusedRes}"][data-role="${focusedRole ?? 'row'}"]`)?.focus({ preventScroll: true });
  };

  sortBtn.addEventListener('click', () => {
    sort = SORT_KEYS[(SORT_KEYS.indexOf(sort) + 1) % SORT_KEYS.length]!;
    pending = null;
    d.sound('uiMove');
    refresh('');
  });
  filterBtn.addEventListener('click', () => {
    const f = filters();
    filter = f[(f.indexOf(filter) + 1) % f.length]!;
    pending = null;
    d.sound('uiMove');
    refresh('');
  });

  return {
    root,
    menu: menuList,
    refresh,
    open() {
      pending = null;
      message = '';
      refresh();
    },
    status() {
      return { sort, filter, selected, pending, rows: [...list.querySelectorAll<HTMLElement>('.fr-inv-row')].map((b) => b.dataset['resource'] ?? ''), message: note.textContent ?? '' };
    },
  };
}
