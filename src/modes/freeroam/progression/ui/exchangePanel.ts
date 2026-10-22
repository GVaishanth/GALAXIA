/**
 * Station exchange panel (Free Roam Prompt 11). DOM only: prices, quotes and
 * validation come from progression/economy.ts and station.ts; the shell
 * commits the wallet a confirmed quote returns and saves.
 *
 * Every paid line is two presses: the first shows the quote (cost and the
 * resulting balances) in the preview box, the second confirms. Repairs are
 * free and listed with what they restore. Local configuration only.
 */
import { MenuList } from '../../../../shared/ui/menuList.ts';
import { EQUIPMENT_BY_ID } from '../../ships/equipment.ts';
import type { FleetState, LicenceCheck } from '../../ships/hangar.ts';
import { SHIPS } from '../../ships/roster.ts';
import type { ShipDef, ShipId } from '../../ships/types.ts';
import { holdUnits } from '../../inventory/inventory.ts';
import { resourceName } from '../../inventory/resources.ts';
import { ECONOMY, MODULE_PRICES, moduleStock, quoteBuyCells, quoteBuyModule, quoteSell, repairLine, sellPrice, stationDemand, UNSELLABLE, type Quote, type Wallet } from '../economy.ts';
import { quoteShip } from '../station.ts';
import { btn, el, focusedKey, panelShell, quoteTable, restoreFocus } from './common.ts';

export interface ExchangeDeps {
  readonly station: () => { readonly id: string; readonly name: string };
  readonly wallet: () => Wallet;
  readonly ship: () => ShipDef;
  readonly fleet: () => FleetState;
  readonly licenceMet: LicenceCheck;
  readonly condition: () => { readonly hull: number; readonly hullMax: number; readonly shield: number; readonly shieldMax: number };
  /** Free emergency cells due now (0 = none). */
  readonly emergency: () => number;
  readonly claimEmergency: () => string;
  readonly commit: (w: Wallet, what: string) => void;
  readonly commitShip: (fleet: FleetState, w: Wallet, id: ShipId) => void;
  readonly back: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
}

export interface ExchangePanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  open(): void;
  back(): void;
  status(): { readonly pending: string | null; readonly message: string; readonly keys: readonly string[]; readonly preview: readonly string[] };
}

const CATEGORY_NAME: Readonly<Record<string, string>> = { alloys: 'alloys', reactor: 'reactor', circuitry: 'circuitry', crystals: 'crystals', samples: 'samples', navdata: 'navigation data', artefacts: 'artefacts', components: 'components' };

export function createExchangePanel(d: ExchangeDeps): ExchangePanel {
  const s = panelShell('exchange', 'Station exchange', 'EXCHANGE');
  const menuList = new MenuList(s.menu, () => d.sound('uiMove'));
  let pending: string | null = null;
  let previewLines: string[] = [];
  const keys: string[] = [];
  const say = (t: string): void => {
    s.message.textContent = t;
  };
  const showPreview = (q: Quote | null): void => {
    if (!q) {
      s.preview.hidden = true;
      s.preview.replaceChildren();
      previewLines = [];
      return;
    }
    s.preview.hidden = false;
    s.preview.replaceChildren(quoteTable(q.lines), el('p', `fr-fab-desc ${q.ok ? '' : 'fr-fuel-warn'}`, q.ok ? q.summary : q.reason));
    previewLines = q.lines.map((l) => `${l.label}: ${l.before} -> ${l.after}`);
  };

  /** A paid line: the first press quotes, the second commits the re-quoted transaction. */
  const trade = (cls: string, label: string, key: string, quote: () => Quote, commit: (q: Extract<Quote, { ok: true }>) => void): HTMLButtonElement => {
    keys.push(key);
    const q0 = quote();
    const b = btn(`${cls}${pending === key ? ' is-armed' : ''}`, pending === key ? 'CONFIRM' : label, key, () => {
      const q = quote();
      if (pending !== key) {
        pending = key;
        d.sound('uiMove');
        showPreview(q);
        say(q.ok ? 'Press CONFIRM to complete the trade, or BACK to cancel.' : q.reason);
        refresh();
        return;
      }
      pending = null;
      showPreview(null);
      if (!q.ok) say(q.reason);
      else {
        commit(q);
        d.sound('bonus');
        say(`Done. ${q.summary}`);
      }
      refresh();
    });
    b.disabled = !q0.ok && pending !== key;
    if (b.disabled) b.title = q0.ok ? '' : q0.reason;
    return b;
  };

  const row = (name: string, desc: string, buttons: HTMLElement[], why?: string): HTMLElement => {
    const li = el('li', 'fr-fab-row');
    const info = el('div', 'fr-fab-info');
    info.append(el('span', 'fr-fab-name', name), el('span', 'fr-fab-desc', desc));
    if (why) info.append(el('span', 'fr-fab-why', why));
    const acts = el('div', 'fr-mission-acts');
    acts.append(...buttons);
    info.append(acts);
    // a disabled trade says why (never a silent dead button)
    const reasons = [...new Set(buttons.filter((x): x is HTMLButtonElement => x instanceof HTMLButtonElement && x.disabled && !!x.title).map((x) => x.title))];
    for (const r of reasons) info.append(el('span', 'fr-fab-why', r));
    li.append(info);
    return li;
  };
  const list = (title: string, rows: HTMLElement[], empty: string): HTMLElement[] => {
    const ul = el('ul', 'fr-fab-list');
    ul.append(...(rows.length ? rows : [el('li', 'fr-fab-empty', empty)]));
    return [el('p', 'fr-kicker fr-fab-head', title), ul];
  };

  function refresh(): void {
    const focus = focusedKey(s.root);
    keys.length = 0;
    const w = d.wallet();
    const st = d.station();
    const ship = d.ship();
    s.head.textContent = `MARKS ${w.marks} · HOLD ${holdUnits(w.hold)}/${w.holdCap} · CELLS ${w.hold['fuel'] ?? 0}`;
    const out: HTMLElement[] = [];

    const due = d.emergency();
    if (due > 0) {
      keys.push('aid');
      out.push(
        ...list('EMERGENCY CELLS · FREE', [row(`+${due} REACTOR CELLS`, 'The Guild tops your cells up to the dearest lane out of this system, once per arrival. Stations never buy cells back.', [btn('fr-fab-claim', 'TAKE FREE CELLS', 'aid', () => {
          say(d.claimEmergency());
          d.sound('bonus');
          refresh();
        })])], ''),
      );
    }

    // sell
    const dem = stationDemand(st.id);
    const sellRows: HTMLElement[] = [];
    for (const [res, n] of Object.entries(w.hold)) {
      if (!(n > 0)) continue;
      const price = sellPrice(res, st.id);
      if (price <= 0) {
        sellRows.push(row(`${resourceName(res).toUpperCase()} · ${n} ABOARD`, UNSELLABLE.includes(res) ? 'Stations do not buy reactor cells.' : 'Not traded here.', []));
        continue;
      }
      sellRows.push(
        row(`${resourceName(res).toUpperCase()} · ${n} ABOARD`, `${price} marks each`, [
          trade('fr-fab-fit', 'SELL 1', `sell1:${res}`, () => quoteSell(d.wallet(), st.id, res, 1), (q) => d.commit(q.result, `sold 1 ${res}`)),
          ...(n > 1 ? [trade('fr-fab-fit', `SELL ALL ${n}`, `sellall:${res}`, () => quoteSell(d.wallet(), st.id, res, d.wallet().hold[res] ?? 0), (q) => d.commit(q.result, `sold ${res}`))] : []),
        ]),
      );
    }
    out.push(...list(`SELL · PAYS MORE FOR ${CATEGORY_NAME[dem.demand]?.toUpperCase()} · LESS FOR ${CATEGORY_NAME[dem.surplus]?.toUpperCase()}`, sellRows, 'The hold is empty.'));

    // buy
    const buyRows: HTMLElement[] = [
      row('REACTOR CELLS', `${ECONOMY.cellPrice} marks each. Every lane hop burns cells.`, [
        trade('fr-fab-build', 'BUY 1', 'cells:1', () => quoteBuyCells(d.wallet(), 1), (q) => d.commit(q.result, 'bought cells')),
        trade('fr-fab-build', 'BUY 5', 'cells:5', () => quoteBuyCells(d.wallet(), 5), (q) => d.commit(q.result, 'bought cells')),
      ]),
    ];
    for (const id of moduleStock(ship)) {
      const item = EQUIPMENT_BY_ID.get(id)!;
      const p = MODULE_PRICES[id]!;
      const price = [`${p.marks} marks`, ...p.materials.map((m) => `${m.amount} ${resourceName(m.resource)}`)].join(' + ');
      buyRows.push(row(`${item.name.toUpperCase()} · ${item.slot.toUpperCase()}`, `${item.description} · ${price}`, [trade('fr-fab-build', 'BUY', `module:${id}`, () => quoteBuyModule(d.wallet(), d.ship(), id), (q) => d.commit(q.result, `bought ${id}`))]));
    }
    out.push(...list(`BUY · EQUIPMENT FOR THE ${ship.name.toUpperCase()} GOES TO STORAGE`, buyRows, ''));

    // ships
    const fleet = d.fleet();
    const shipRows = SHIPS.filter((x) => !fleet.owned.includes(x.id)).map((x) => {
      const price = x.cost.map((c) => `${c.amount} ${resourceName(c.resource)}`).join(' + ');
      let pendingFleet: FleetState | null = null;
      return row(`${x.name.toUpperCase()} · ${x.role.toUpperCase()}`, `${x.description} · ${price}`, [
        trade(
          'fr-fab-build',
          'ACQUIRE',
          `ship:${x.id}`,
          () => {
            const r = quoteShip(d.wallet(), d.fleet(), x.id, d.licenceMet);
            pendingFleet = r.fleet;
            return r.quote;
          },
          (q) => {
            if (pendingFleet) d.commitShip(pendingFleet, q.result, x.id);
          },
        ),
      ]);
    });
    out.push(...list('SHIPS', shipRows, 'You own every ship.'));

    // repairs
    const c = d.condition();
    const rep = repairLine(c.hull, c.hullMax, c.shield, c.shieldMax);
    out.push(...list('REPAIRS · FREE', [row(`REPAIRS · FREE`, `${rep.before} → ${rep.after}. Docking repairs the hull and recharges the shield at no cost.`, [])], ''));

    const actions = el('div', 'fr-fab-actions');
    actions.append(btn('', 'HANGAR', 'back', () => d.back()));
    out.push(actions);
    s.menu.replaceChildren(...out);
    restoreFocus(s.root, focus);
  }

  return {
    root: s.root,
    menu: menuList,
    open() {
      pending = null;
      showPreview(null);
      s.kicker.textContent = `STATION EXCHANGE · ${d.station().name.toUpperCase()}`;
      say('Sell salvage for Guild marks; buy cells, equipment and ships. Every trade shows its result before you confirm.');
      refresh();
      menuList.focus(0);
    },
    back() {
      if (pending) {
        pending = null;
        showPreview(null);
        say('Cancelled.');
        refresh();
      } else d.back();
    },
    status() {
      return { pending, message: s.message.textContent ?? '', keys: [...keys], preview: [...previewLines] };
    },
  };
}
