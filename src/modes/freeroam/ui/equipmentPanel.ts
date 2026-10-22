/**
 * Equipment screen (Prompt 12): the ship's slots and the stored modules, in
 * one place. DOM only. It presents the fitting rule that already existed
 * (inventory/fabricator.ts fitFromStorage: slot type, weapon class, the hold
 * never shrunk below the cargo carried, storage room for the replaced module)
 * and commits through the same `commitFit` as the fabricator did before; the
 * fabricator now builds, and this screen fits. Nothing about fitting changed.
 */
import { MenuList } from '../../../shared/ui/menuList.ts';
import { fitFromStorage } from '../inventory/fabricator.ts';
import type { Hold, ModuleStore } from '../inventory/inventory.ts';
import { iconImg } from '../inventory/ui/iconImages.ts';
import { btn, el, focusedKey, panelShell, restoreFocus } from '../progression/ui/common.ts';
import { EQUIPMENT_BY_ID } from '../ships/equipment.ts';
import { SLOT_TYPES, type Loadout, type ShipDef, type ShipStats, type SlotType } from '../ships/types.ts';

export interface EquipmentDeps {
  readonly ship: () => ShipDef;
  readonly loadout: () => Loadout;
  readonly modules: () => ModuleStore;
  readonly cargo: () => Hold;
  /** The ship's derived stats with the current loadout and upgrades. */
  readonly stats: () => ShipStats;
  readonly commitFit: (loadout: Loadout, modules: ModuleStore) => void;
  readonly back: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
  /** Presentation hook: a module was fitted (row element), for the install animation and sound. */
  readonly installed?: ((row: HTMLElement) => void) | undefined;
}

export interface EquipmentPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  open(station: string): void;
  back(): void;
  status(): { readonly slots: readonly string[]; readonly stored: readonly string[]; readonly fits: readonly string[]; readonly message: string };
}

const SLOT_LABEL: Readonly<Record<SlotType, string>> = { weapon: 'WEAPON', shield: 'SHIELD', engine: 'ENGINE', sensor: 'SENSOR', cargo: 'CARGO' };
const nameOf = (id: string): string => EQUIPMENT_BY_ID.get(id)?.name ?? id;

/** Compact stat line of the ship as fitted (the numbers the derive step already produced). */
export function statLine(s: ShipStats): string {
  return `HULL ${s.hull} · SHIELD ${s.shield} · ENERGY ${s.energy} · SPEED ${Math.round(s.maxSpeed)} · HOLD ${s.cargo}`;
}

export function createEquipmentPanel(d: EquipmentDeps): EquipmentPanel {
  const s = panelShell('equipment', 'Equipment', 'EQUIPMENT');
  s.kicker.textContent = 'STATION · EQUIPMENT';
  const menuList = new MenuList(s.menu, () => d.sound('uiMove'));
  let slotKeys: string[] = [];
  let storedKeys: string[] = [];
  let fitKeys: string[] = [];
  const say = (t: string): void => {
    s.message.textContent = t;
  };

  function refresh(): void {
    const keep = focusedKey(s.root);
    const ship = d.ship();
    const lo = d.loadout();
    const m = d.modules();
    const h = d.cargo();
    s.head.textContent = `${ship.name.toUpperCase()} · ${statLine(d.stats())}`;

    // fitted: one row per slot the hull has
    const slots = el('ul', 'fr-fab-list fr-equip-slots');
    slots.setAttribute('aria-label', 'Fitted modules by slot');
    slotKeys = [];
    for (const slot of SLOT_TYPES) {
      for (let i = 0; i < ship.slots[slot]; i++) {
        const id = lo[slot][i];
        slotKeys.push(`${slot}:${i}:${id ?? ''}`);
        const li = el('li', `fr-fab-row fr-equip-slot${id ? '' : ' is-empty'}`);
        li.dataset['slot'] = `${slot}:${i}`;
        const info = el('div', 'fr-fab-info');
        info.append(el('span', 'fr-equip-slotname', `${SLOT_LABEL[slot]} ${i + 1}`), el('span', 'fr-fab-name', id ? nameOf(id).toUpperCase() : 'EMPTY'));
        const item = id ? EQUIPMENT_BY_ID.get(id) : undefined;
        if (item) info.append(el('span', 'fr-fab-desc', item.description));
        li.append(iconImg(`slot:${slot}`), info);
        slots.append(li);
      }
    }

    // stored: what can go where (the same rule as before), or why not
    const storage = el('ul', 'fr-fab-list fr-fab-storage');
    storage.setAttribute('aria-label', 'Stored modules');
    storedKeys = [];
    fitKeys = [];
    const stored = Object.entries(m).filter(([, n]) => n > 0);
    if (stored.length === 0) storage.append(el('li', 'fr-fab-empty', 'No modules stored. Build them in the FABRICATOR; a module you replace is stored here.'));
    for (const [id, n] of stored) {
      const item = EQUIPMENT_BY_ID.get(id);
      if (!item) continue;
      storedKeys.push(id);
      const li = el('li', 'fr-fab-row');
      const info = el('div', 'fr-fab-info');
      info.append(el('span', 'fr-fab-name', `${item.name.toUpperCase()}${n > 1 ? ` ×${n}` : ''} · ${item.slot.toUpperCase()}`), el('span', 'fr-fab-desc', item.description));
      li.append(iconImg(`slot:${item.slot}`), info);
      const slot = item.slot as SlotType;
      const reasons = new Set<string>();
      let offered = 0;
      for (let i = 0; i < ship.slots[slot] && i <= lo[slot].length; i++) {
        const r = fitFromStorage(ship, lo, m, h, slot, i, id);
        if (!r.ok) {
          reasons.add(r.reason);
          continue;
        }
        offered += 1;
        const current = lo[slot][i] ? nameOf(lo[slot][i]!) : null;
        fitKeys.push(`${id}:${slot}:${i}`);
        const b = btn('fr-fab-fit', `FIT · ${slot.toUpperCase()} ${i + 1}${current ? ` (STORES ${current.toUpperCase()})` : ' (EMPTY)'}`, `fit:${id}:${i}`, () => {
          const again = fitFromStorage(d.ship(), d.loadout(), d.modules(), d.cargo(), slot, i, id);
          if (!again.ok) {
            say('That fit is no longer possible.');
            refresh();
            return;
          }
          d.commitFit(again.loadout, again.modules);
          say(`${item.name} fitted to the ${d.ship().name}${again.removed ? `; ${nameOf(again.removed)} stored` : ''}.`);
          refresh();
          const row = s.menu.querySelector<HTMLElement>(`.fr-equip-slot[data-slot="${slot}:${i}"]`);
          if (row && d.installed) d.installed(row);
          else d.sound('uiSelect');
          s.menu.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus({ preventScroll: true });
        });
        info.append(b);
      }
      if (offered === 0) {
        const why = reasons.has('cargo-overflow') ? 'Fitting it would shrink the hold below the cargo you carry.' : reasons.has('storage-full') ? 'Storage is full: no room for the module it would replace.' : reasons.has('same') ? 'Already fitted.' : `Does not fit the ${ship.name} (slot or weapon class).`;
        info.append(el('span', 'fr-fab-why', why));
      }
      storage.append(li);
    }
    const actions = el('div', 'fr-fab-actions');
    actions.append(btn('fr-equip-back', 'STATION', 'back', () => d.back()));
    s.menu.replaceChildren(el('p', 'fr-kicker fr-fab-head', 'FITTED'), slots, el('p', 'fr-kicker fr-fab-head', 'STORED · FIT TO YOUR SHIP'), storage, actions);
    restoreFocus(s.root, keep);
  }

  return {
    root: s.root,
    menu: menuList,
    open(station) {
      s.kicker.textContent = `${station.toUpperCase()} · EQUIPMENT`;
      say('Fit stored modules to the ship you fly. A module you replace goes to storage.');
      refresh();
      menuList.focus(0);
    },
    back() {
      d.back();
    },
    status() {
      return { slots: [...slotKeys], stored: [...storedKeys], fits: [...fitKeys], message: s.message.textContent ?? '' };
    },
  };
}
