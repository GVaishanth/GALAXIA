/**
 * Upgrades panel (Free Roam Prompt 11). DOM only: tracks, caps, licences and
 * costs come from ships/upgrades.ts, the quote (cost and stat changes) from
 * progression/station.ts quoteUpgrade; the shell commits.
 *
 * One row per track for the ship flown: installed level, the next level's
 * price and effect, or why it cannot be installed (incompatible frame, fully
 * upgraded, licence missing, not enough marks or materials). INSTALL is two
 * presses; the first shows the before -> after preview.
 */
import { MenuList } from '../../../../shared/ui/menuList.ts';
import { resourceName } from '../../inventory/resources.ts';
import type { Loadout, ShipDef } from '../../ships/types.ts';
import { LEVEL_NAME, maxLevel, UPGRADES, type UpgradeLevels } from '../../ships/upgrades.ts';
import type { Quote, Wallet } from '../economy.ts';
import { quoteUpgrade } from '../station.ts';
import { btn, el, focusedKey, panelShell, quoteTable, restoreFocus, strayRepeat } from './common.ts';
import { formatMarks } from '../ledger.ts';

export interface UpgradesDeps {
  readonly station: () => string;
  readonly ship: () => ShipDef;
  readonly loadout: () => Loadout;
  readonly levels: () => UpgradeLevels;
  readonly licences: () => readonly string[];
  readonly wallet: () => Wallet;
  readonly commit: (levels: UpgradeLevels, w: Wallet, track: string) => void;
  /** Admin Access: the marks price resolves to 0 (materials and licences still apply; the balance never changes). */
  readonly free?: (() => boolean) | undefined;
  readonly back: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
}

export interface UpgradesPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  open(): void;
  back(): void;
  status(): { readonly pending: string | null; readonly message: string; readonly installable: readonly string[]; readonly levels: UpgradeLevels };
}

export function createUpgradesPanel(d: UpgradesDeps): UpgradesPanel {
  const s = panelShell('upgrades', 'Ship upgrades', 'UPGRADES');
  const menuList = new MenuList(s.menu, () => d.sound('uiMove'));
  let pending: string | null = null;
  const installable: string[] = [];
  const say = (t: string): void => {
    s.message.textContent = t;
  };
  const preview = (q: Quote | null): void => {
    s.preview.hidden = !q;
    s.preview.replaceChildren(...(q ? [quoteTable(q.lines), el('p', `fr-fab-desc ${q.ok ? '' : 'fr-fuel-warn'}`, q.ok ? q.summary : q.reason)] : []));
  };

  function refresh(): void {
    const focus = focusedKey(s.root);
    installable.length = 0;
    const ship = d.ship();
    const levels = d.levels();
    const w = d.wallet();
    const lic = d.licences();
    const free = d.free?.() ?? false;
    s.head.textContent = `${ship.name.toUpperCase()} · ${formatMarks(w.marks)}${free ? ' · ADMIN ACCESS: NO MARKS CHARGED' : ''} · LICENCES ${lic.length ? lic.map((l) => (l === 'mk2' ? 'MK II' : 'MK III')).join(' + ') : 'NONE (MK I ONLY)'}`;
    const ul = el('ul', 'fr-fab-list');
    for (const u of UPGRADES) {
      const cap = maxLevel(ship.id, u.id);
      const lv = levels[u.id] ?? 0;
      const q = quoteUpgrade(w, ship.id, d.loadout(), levels, u.id, lic, free);
      const li = el('li', `fr-fab-row fr-upgrade${cap === 0 ? ' is-locked' : ''}`);
      li.dataset['track'] = u.id;
      const info = el('div', 'fr-fab-info');
      const pips = Array.from({ length: 3 }, (_, i) => (i < lv ? '■' : i < cap ? '□' : '·')).join('');
      info.append(el('span', 'fr-fab-name', `${u.name.toUpperCase()} · ${pips} ${lv ? LEVEL_NAME(lv) : 'STOCK'}${cap < 3 ? ` · MAX ${cap ? LEVEL_NAME(cap) : 'NONE'} ON THIS FRAME` : ''}`), el('span', 'fr-fab-desc', u.description));
      const next = lv < cap ? u.steps[lv] : undefined;
      if (next) {
        const cost = [free ? 'FREE (ADMIN ACCESS)' : formatMarks(next.cost.marks), ...next.cost.materials.map((m) => `${m.amount} ${resourceName(m.resource)}`)].join(' + ');
        info.append(el('span', 'fr-fab-desc', `NEXT ${LEVEL_NAME(next.level)} · ${cost}${next.licence ? ` · needs the ${next.licence === 'mk2' ? 'Mk II' : 'Mk III'} licence` : ''}`));
      }
      const key = `install:${u.id}`;
      if (q.quote.ok) installable.push(u.id);
      if (next) {
        const b = btn(`fr-fab-build${pending === key ? ' is-armed' : ''}`, pending === key ? `CONFIRM · ${LEVEL_NAME(next.level)}` : `INSTALL ${LEVEL_NAME(next.level)}`, key, (e) => {
          if (pending === key && strayRepeat(e)) return; // a double-click arms; it never also installs
          const again = quoteUpgrade(d.wallet(), d.ship().id, d.loadout(), d.levels(), u.id, d.licences(), d.free?.() ?? false);
          if (pending !== key) {
            pending = key;
            d.sound('uiMove');
            preview(again.quote);
            say(again.quote.ok ? 'Press CONFIRM to install, or BACK to cancel.' : again.quote.reason);
            refresh();
            return;
          }
          pending = null;
          preview(null);
          if (!again.quote.ok || !again.levels) say(again.quote.ok ? 'Cannot install now.' : again.quote.reason);
          else {
            d.commit(again.levels, again.quote.result, u.id);
            d.sound('bonus');
            say(`Installed. ${again.quote.summary}`);
          }
          refresh();
        });
        b.disabled = !q.quote.ok && pending !== key;
        info.append(b);
        if (!q.quote.ok) info.append(el('span', 'fr-fab-why', q.quote.reason));
      } else info.append(el('span', 'fr-fab-why', cap === 0 ? `The ${ship.name} cannot take this upgrade.` : 'Fully upgraded on this ship.'));
      li.append(info);
      ul.append(li);
    }
    const actions = el('div', 'fr-fab-actions');
    actions.append(btn('', 'HANGAR', 'back', () => d.back()));
    s.menu.replaceChildren(el('p', 'fr-kicker fr-fab-head', 'ONE LEVEL PER TRACK · INSTALLED ON THE SHIP FLOWN'), ul, actions);
    restoreFocus(s.root, focus);
  }

  return {
    root: s.root,
    menu: menuList,
    open() {
      pending = null;
      preview(null);
      s.kicker.textContent = `SHIP UPGRADES · ${d.station().toUpperCase()}`;
      say('Upgrades stay with the ship they are installed on. Each level replaces the one before; effects never stack beyond the ship limits.');
      refresh();
      menuList.focus(0);
    },
    back() {
      if (pending) {
        pending = null;
        preview(null);
        say('Cancelled.');
        refresh();
      } else d.back();
    },
    status() {
      return { pending, message: s.message.textContent ?? '', installable: [...installable], levels: d.levels() };
    },
  };
}
