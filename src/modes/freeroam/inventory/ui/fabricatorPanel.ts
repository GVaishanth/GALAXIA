/**
 * Station fabricator panel (Free Roam Prompt 10). DOM only: recipes and
 * payment rules come from inventory/fabricator.ts, milestone rules from
 * inventory/milestones.ts. Opened from the station tabs while docked; the
 * shell commits what it returns to the profile.
 *
 *  - BUILD takes two presses (the second names the exact price) and pays
 *    once: the module goes into station storage.
 *  - Stored modules are listed; fitting them happens on the EQUIPMENT screen
 *    (ui/equipmentPanel.ts, Prompt 12), with the same fitFromStorage rule.
 *  - CLAIM pays a reached milestone once, when the whole reward fits.
 */
import { MenuList } from '../../../../shared/ui/menuList.ts';
import { EQUIPMENT_BY_ID } from '../../ships/equipment.ts';
import type { Loadout, ShipDef } from '../../ships/types.ts';
import { fabricate, missingResources, RECIPES, storageRoom } from '../fabricator.ts';
import { addLoot, holdUnits, lootUnits, type Hold, type ModuleStore } from '../inventory.ts';
import { MILESTONES, milestoneState, type MilestoneProgress } from '../milestones.ts';
import { resourceName } from '../resources.ts';
import { iconImg } from './iconImages.ts';

export interface FabricatorDeps {
  readonly cargo: () => Hold;
  readonly modules: () => ModuleStore;
  readonly capacity: () => number;
  readonly ship: () => ShipDef;
  readonly loadout: () => Loadout;
  readonly progress: () => MilestoneProgress;
  readonly claimed: () => readonly string[];
  readonly commitFabricate: (hold: Hold, modules: ModuleStore, id: string) => void;
  readonly commitClaim: (id: string, hold: Hold) => void;
  readonly back: () => void;
  readonly launch: () => void;
  /** Prompt 12: open the equipment screen (stored modules are fitted there). */
  readonly equipment?: (() => void) | undefined;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
}

export interface FabricatorPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  open(station: string): void;
  back(): void;
  status(): { readonly pending: string | null; readonly message: string; readonly buildable: readonly string[]; readonly fits: readonly string[]; readonly claimable: readonly string[] };
}

const costText = (cost: readonly { readonly resource: string; readonly amount: number }[]): string => cost.map((c) => `${resourceName(c.resource).toUpperCase()} ${c.amount}`).join(' + ');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function createFabricatorPanel(d: FabricatorDeps): FabricatorPanel {
  const root = el('section', 'fr-panel fr-panel-fabricator');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Station fabricator');
  root.hidden = true;
  const kicker = el('p', 'fr-kicker', 'STATION FABRICATOR');
  const hold = el('p', 'fr-stats fr-fab-hold');
  const message = el('p', 'fr-text fr-fab-msg');
  message.setAttribute('role', 'status');
  const menu = el('div', 'fr-menu fr-fab');
  const recipes = el('ul', 'fr-fab-list fr-fab-recipes');
  recipes.setAttribute('aria-label', 'Modules the fabricator can build');
  const storage = el('ul', 'fr-fab-list fr-fab-storage');
  storage.setAttribute('aria-label', 'Stored modules');
  const miles = el('ul', 'fr-fab-list fr-fab-miles');
  miles.setAttribute('aria-label', 'Exploration milestones');
  const backBtn = el('button', 'fr-btn', 'STATION');
  backBtn.type = 'button';
  backBtn.addEventListener('click', () => d.back());
  const launchBtn = el('button', 'fr-btn', 'LAUNCH');
  launchBtn.type = 'button';
  launchBtn.addEventListener('click', () => d.launch());
  const actions = el('div', 'fr-fab-actions');
  actions.append(backBtn, launchBtn);
  menu.append(el('p', 'fr-kicker fr-fab-head', 'BUILD'), recipes, el('p', 'fr-kicker fr-fab-head', 'STORAGE'), storage, el('p', 'fr-kicker fr-fab-head', 'MILESTONES'), miles, actions);
  root.append(kicker, el('h2', 'fr-title', 'FABRICATOR'), hold, message, menu);
  const menuList = new MenuList(menu, () => d.sound('uiMove'));

  let pending: string | null = null;
  const buildable: string[] = [];
  const claimable: string[] = [];

  const say = (t: string): void => {
    message.textContent = t;
  };

  const refresh = (): void => {
    const h = d.cargo();
    const m = d.modules();
    const ship = d.ship();
    const cap = d.capacity();
    hold.textContent = `HOLD ${holdUnits(h)} / ${cap} · ${ship.name.toUpperCase()}`;
    const focusKey = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset['key'] : undefined;

    // recipes
    recipes.replaceChildren();
    buildable.length = 0;
    for (const r of RECIPES) {
      const item = EQUIPMENT_BY_ID.get(r.module);
      if (!item) continue;
      const missing = missingResources(r.cost, h);
      const room = storageRoom(m, r.module) > 0;
      if (missing.length === 0 && room) buildable.push(r.module);
      const li = el('li', `fr-fab-row${missing.length ? ' is-short' : ''}`);
      const info = el('div', 'fr-fab-info');
      info.append(el('span', 'fr-fab-name', `${item.name.toUpperCase()} · ${item.slot.toUpperCase()}`), el('span', 'fr-fab-desc', item.description));
      const cost = el('span', 'fr-fab-cost');
      for (const c of r.cost) {
        const ok = (h[c.resource] ?? 0) >= c.amount;
        const tag = el('span', `fr-fab-part${ok ? ' is-met' : ''}`);
        tag.append(iconImg(c.resource, 'fr-icon fr-icon-small'), document.createTextNode(`${ok ? '✓' : '✗'} ${c.amount} ${resourceName(c.resource).toUpperCase()} (${h[c.resource] ?? 0})`));
        cost.append(tag);
      }
      info.append(cost);
      const b = el('button', `fr-btn fr-fab-build${pending === r.module ? ' is-armed' : ''}`);
      b.type = 'button';
      b.dataset['key'] = `build:${r.module}`;
      b.disabled = missing.length > 0 || !room;
      b.textContent = !room ? 'STORAGE FULL' : missing.length ? 'NEED RESOURCES' : pending === r.module ? `CONFIRM · PAY ${costText(r.cost)}` : 'BUILD';
      b.setAttribute('aria-label', b.disabled ? `${item.name}: ${b.textContent.toLowerCase()}` : pending === r.module ? `Confirm: build ${item.name} for ${costText(r.cost).toLowerCase()}` : `Build ${item.name}`);
      b.addEventListener('click', () => {
        if (pending !== r.module) {
          pending = r.module;
          d.sound('uiMove');
          say(`Press again to build the ${item.name} for ${costText(r.cost)}.`);
          refresh();
          return;
        }
        pending = null;
        const res = fabricate(d.cargo(), d.modules(), r.module);
        if (res.ok) {
          d.commitFabricate(res.hold, res.modules, r.module);
          d.sound('bonus');
          say(`${item.name} built and stored. Fit it in EQUIPMENT.`);
        } else say(res.reason === 'storage-full' ? 'Station storage is full.' : res.reason === 'unaffordable' ? 'Not enough resources.' : 'That module cannot be built.');
        refresh();
      });
      li.append(iconImg(`slot:${item.slot}`), info, b);
      recipes.append(li);
    }

    // storage: fitting lives on the EQUIPMENT screen (Prompt 12); same rule, same commit
    storage.replaceChildren();
    const stored = Object.entries(m).filter(([, n]) => n > 0);
    const units = stored.reduce((a, [, n]) => a + n, 0);
    const li = el('li', 'fr-fab-row fr-fab-stored');
    const info = el('div', 'fr-fab-info');
    info.append(el('span', 'fr-fab-name', units ? `${units} MODULE${units === 1 ? '' : 'S'} STORED` : 'NOTHING STORED'), el('span', 'fr-fab-desc', units ? stored.map(([id, n]) => `${EQUIPMENT_BY_ID.get(id)?.name ?? id}${n > 1 ? ` ×${n}` : ''}`).join(' · ') : 'Built modules are stored here until you fit them.'));
    if (d.equipment) {
      const b = el('button', 'fr-btn fr-fab-equip', 'FIT IN EQUIPMENT');
      b.type = 'button';
      b.dataset['key'] = 'equipment';
      b.addEventListener('click', () => d.equipment?.());
      info.append(b);
    }
    li.append(iconImg('slot:weapon'), info);
    storage.append(li);

    // milestones
    miles.replaceChildren();
    claimable.length = 0;
    const prog = d.progress();
    for (const ms of MILESTONES) {
      const st = milestoneState(ms, prog, d.claimed());
      const li = el('li', `fr-fab-row is-${st}`);
      const info = el('div', 'fr-fab-info');
      info.append(el('span', 'fr-fab-name', `${ms.label.toUpperCase()} · ${st === 'claimed' ? 'CLAIMED' : st === 'claimable' ? 'REACHED' : 'LOCKED'}`), el('span', 'fr-fab-desc', `${ms.detail} Reward: ${costText(ms.loot)}.`));
      li.append(iconImg(ms.loot[0]?.resource ?? 'components'), info);
      if (st === 'claimable') {
        const fits = lootUnits(ms.loot) <= cap - holdUnits(h);
        if (fits) claimable.push(ms.id);
        const b = el('button', 'fr-btn fr-fab-claim', fits ? 'CLAIM' : `MAKE ROOM · ${lootUnits(ms.loot)} UNITS`);
        b.type = 'button';
        b.dataset['key'] = `claim:${ms.id}`;
        b.disabled = !fits;
        b.addEventListener('click', () => {
          const r = addLoot(d.cargo(), ms.loot, d.capacity());
          if (r.left.length > 0) {
            say('The whole reward must fit in the hold. Make room first.');
            refresh();
            return;
          }
          d.commitClaim(ms.id, r.hold);
          d.sound('bonus');
          say(`${ms.label}: ${costText(ms.loot)} stowed.`);
          refresh();
        });
        info.append(b);
      }
      miles.append(li);
    }
    if (focusKey) root.querySelector<HTMLButtonElement>(`button[data-key="${focusKey}"]:not([disabled])`)?.focus({ preventScroll: true });
  };

  return {
    root,
    menu: menuList,
    open(station: string) {
      pending = null;
      kicker.textContent = `STATION FABRICATOR · ${station.toUpperCase()}`;
      say('Build equipment from your resources; fit what you build in EQUIPMENT.');
      refresh();
      menuList.focus(0);
    },
    back() {
      if (pending) {
        pending = null;
        say('Cancelled.');
        refresh();
      } else d.back();
    },
    status() {
      return { pending, message: message.textContent ?? '', buildable: [...buildable], fits: [], claimable: [...claimable] };
    },
  };
}
