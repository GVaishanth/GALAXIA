/**
 * P11.2 Fleet panel (docs/freeroam/FLEET_COMMAND.md "Fleet panel"): the lazy chunk the shell
 * imports, with the fleet kit, the first time the FLEET station tab or the pause menu's FLEET
 * ORDERS is opened. DOM only: rows come from ui/fleetView.ts (the kit's own checks), every change
 * goes through the shell's fleetAct (the one P11.1 entry point), and nothing here holds fleet state:
 * each refresh re-reads the shell's snapshot. No timers, frame loops or document listeners.
 *
 * Docked (station tab): the vessels with captain, status and service actions, captain choice for a
 * vessel, and commissioning a new hull (choose the hull, choose its captain, CONFIRM). In flight
 * (pause menu): the same vessels with hull, state and order, and the four orders for one vessel or
 * all of them. Opening the panel reads; it never deploys, steps or saves anything.
 */
import { MenuList } from '../../../shared/ui/menuList.ts';
import type { UnlockRequirement } from '../catalogue/types.ts';
import { FLEET_COMMAND, type FleetAct, type FleetKit, type Vessels } from '../fleet/vessels.ts';
import type { PurchaseWorld } from '../fleet/command.ts';
import type { RequirementInfo } from '../galaxy/progress.ts';
import { btn, el, focusedKey, panelShell, restoreFocus, strayRepeat } from '../progression/ui/common.ts';
import type { ShipId } from '../ships/types.ts';
import { crewRows, fleetHead, hullRows, hullsNotBuilt, ORDER_HELP, orderChoices, vesselRows, type FleetContext, type FleetFlight, type OrderKind } from './fleetView.ts';

/** Admin Access test fleet (only while a session is on; the shell's sandbox, never saved). */
export interface FleetAdmin {
  readonly lines: () => readonly string[];
  readonly prepare: () => string;
  readonly reset: () => string;
  /** Disable a flying vessel through the wing's own damage path. */
  readonly disable: (vessel: string) => string;
}

export interface FleetPanelDeps {
  readonly kit: FleetKit;
  readonly vessels: () => Vessels;
  readonly world: () => PurchaseWorld;
  readonly flight: () => FleetFlight | null;
  readonly crewName: (id: string) => string;
  readonly crewRole: (id: string) => string;
  readonly describe: (req: UnlockRequirement) => RequirementInfo;
  /** Station name when docked (station tab), null in flight (pause menu). */
  readonly station: () => string | null;
  readonly act: (a: FleetAct) => Promise<{ readonly ok: boolean; readonly text: string; readonly reason?: string }>;
  /** The empty state's link: the Hangar tab (docked). */
  readonly hangar: () => void;
  readonly back: () => void;
  readonly admin: () => FleetAdmin | null;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus' | 'refused') => void;
}

export interface FleetPanelStatus {
  readonly mode: 'docked' | 'flight';
  readonly step: 'list' | 'hull' | 'captain';
  readonly pending: string | null;
  readonly busy: boolean;
  readonly buyShip: string | null;
  readonly buyCaptain: string | null;
  readonly captainFor: string | null;
  readonly message: string;
  readonly rows: readonly { readonly id: string; readonly name: string; readonly state: string; readonly order: string; readonly captain: string | null; readonly hull: string | null }[];
  readonly buttons: readonly { readonly key: string; readonly text: string; readonly disabled: boolean }[];
}

export interface FleetPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  open(): void;
  back(): void;
  refresh(): void;
  status(): FleetPanelStatus;
}

export function createFleetPanel(d: FleetPanelDeps): FleetPanel {
  const s = panelShell('fleet', 'Fleet command', 'FLEET');
  const menuList = new MenuList(s.menu, () => d.sound('uiMove'));
  /** The armed two-press action (its key), or null. */
  let pending: string | null = null;
  /** A fleetAct is in progress: every action waits (no double purchase by click, key or tap). */
  let busy = false;
  /** The action focused when a fleetAct started (every action is disabled meanwhile), restored afterwards. */
  let keep: string | undefined;
  let buyShip: ShipId | null = null;
  let buyCaptain: string | null = null;
  let captainFor: string | null = null;
  const ctx = (): FleetContext => ({ kit: d.kit, vessels: d.vessels(), world: d.world(), flight: d.flight(), crewName: d.crewName, crewRole: d.crewRole, describe: d.describe });
  const say = (t: string): void => {
    s.message.textContent = t;
  };
  const reset = (): void => {
    pending = null;
    buyShip = null;
    buyCaptain = null;
    captainFor = null;
  };
  /** Run one fleetAct; the panel re-reads the shell afterwards. */
  const run = (a: FleetAct, done: (ok: boolean, text: string) => void): void => {
    if (busy) return;
    keep = focusedKey(s.root);
    busy = true;
    refresh();
    void d.act(a).then(
      (r) => {
        busy = false;
        d.sound(r.ok ? 'bonus' : 'refused');
        done(r.ok, r.text);
        refresh();
        keep = undefined;
      },
      () => {
        busy = false;
        say('Fleet systems unavailable. Nothing was changed.');
        refresh();
        keep = undefined;
      },
    );
  };
  const row = (name: string, ...lines: (string | null)[]): { li: HTMLLIElement; info: HTMLElement } => {
    const li = el('li', 'fr-fab-row fr-fleet-row');
    const info = el('div', 'fr-fab-info');
    info.append(el('span', 'fr-fab-name', name));
    for (const l of lines) if (l) info.append(el('span', 'fr-fab-desc', l));
    li.append(info);
    return { li, info };
  };
  const button = (key: string, text: string, label: string, why: string | null, onClick: (e: MouseEvent) => void, armed = false): HTMLButtonElement => {
    const b = btn(`fr-fab-build${armed ? ' is-armed' : ''}`, text, key, (e) => {
      // a double click's second click never acts: it would land on whatever the first click put under the pointer
      if (busy || strayRepeat(e)) return;
      onClick(e);
    });
    b.setAttribute('aria-label', why ? `${label}: unavailable. ${why}` : label);
    b.disabled = busy || !!why;
    return b;
  };
  const actions = (...bs: HTMLElement[]): HTMLElement => {
    const a = el('div', 'fr-fab-actions');
    a.append(...bs);
    return a;
  };

  /* ------------------------------------------------------------ sections */
  function vesselList(c: FleetContext, docked: boolean): HTMLElement[] {
    const rows = vesselRows(c);
    if (!rows.length) {
      const where = docked
        ? 'Commission an escort hull below: it costs hull materials plus a Guild commission, and a recruited crew member must captain it (crew are signed on at the Hangar\u2019s BRIDGE).'
        : 'You have no fleet vessel. Escort hulls are commissioned at a station: dock, then open the FLEET tab.';
      const out: HTMLElement[] = [el('p', 'fr-fab-desc fr-fleet-empty', `NO FLEET VESSELS YET. ${where}`)];
      if (docked) out.push(actions(button('hangar', 'HANGAR · BRIDGE', 'Open the Hangar, where crew are signed on at the Bridge', null, () => d.hangar())));
      return out;
    }
    const ul = el('ul', 'fr-fab-list fr-fleet-list');
    for (const r of rows) {
      const { li, info } = row(r.name, `${r.role.toUpperCase()} · ${r.captainText}`, r.stateText, r.hull, `ORDER ${r.order}`);
      li.dataset['vessel'] = r.id;
      li.dataset['state'] = r.state;
      if (docked) {
        const bs: HTMLElement[] = [button(`captain:${r.id}`, r.captain ? 'CHANGE CAPTAIN' : 'ASSIGN CAPTAIN', `Choose a captain for ${r.name}`, null, () => {
          pending = null;
          captainFor = r.id;
          d.sound('uiSelect');
          say(`Choose a captain for the ${r.name}. Only recruited crew who are not seated aboard your ships can command.`);
          refresh();
          menuList.focus(0);
        })];
        if (r.captain) {
          const key = `release:${r.id}`;
          const armed = pending === key;
          bs.push(button(key, armed ? 'CONFIRM RELEASE' : 'RELEASE CAPTAIN', `Return ${d.crewName(r.captain)} to the crew roster`, null, (e) => {
            if (!armed) {
              pending = key;
              d.sound('uiMove');
              say(`Release ${d.crewName(r.captain!)} to the crew roster? The ${r.name} stays yours, uncrewed: it cannot launch until it has a captain. Press CONFIRM RELEASE, or BACK to cancel.`);
              refresh();
              return;
            }
            if (strayRepeat(e)) return;
            pending = null;
            run({ kind: 'release', vessel: r.id }, (ok, text) => say(ok ? `${d.crewName(r.captain!)} returned to the crew roster. Seat them aboard a ship at the Hangar\u2019s BRIDGE, or give them another vessel.` : text));
          }, armed));
        }
        if (r.status !== 'disabled') {
          const to = r.status === 'reserve' ? 'active' : 'reserve';
          bs.push(button(`service:${r.id}`, to === 'active' ? 'RETURN TO SERVICE' : 'TAKE OUT OF SERVICE', to === 'active' ? `Return ${r.name} to service` : `Take ${r.name} out of service (it stays at the station)`, null, () => {
            pending = null;
            run({ kind: 'service', vessel: r.id, status: to }, (ok, text) => say(ok ? (to === 'active' ? `${r.name} is back in service.` : `${r.name} is out of service: it stays at the station until you return it.`) : text));
          }));
        }
        info.append(actions(...bs));
      } else {
        info.append(orderRow(c, r.id, r.name));
        const adm = d.admin();
        if (adm && r.state === 'flying') info.append(actions(button(`admin-disable:${r.id}`, 'ADMIN · DISABLE', `Admin test: disable ${r.name} through the wing damage path`, null, () => say(adm.disable(r.id)))));
      }
      ul.append(li);
    }
    return [ul];
  }

  function orderRow(c: FleetContext, who: string, name: string): HTMLElement {
    const bs = orderChoices(c, who).map((o) =>
      button(`order:${who}:${o.kind}`, o.label, `${o.label} · ${name}: ${ORDER_HELP[o.kind]}${o.kind === 'attack' && c.flight?.targetName ? ` Target: ${c.flight.targetName}` : ''}`, o.why, () => order(who, o.kind, name)),
    );
    const a = actions(...bs);
    a.classList.add('fr-fleet-orders');
    a.setAttribute('role', 'group');
    a.setAttribute('aria-label', `Orders for ${name}`);
    return a;
  }

  function order(who: string, kind: OrderKind, name: string): void {
    pending = null;
    const f = d.flight();
    const req = kind === 'attack' ? { kind, target: f?.target ?? null } : { kind };
    run({ kind: 'order', who, order: req }, (ok, text) => say(ok ? `${name}: ${text}` : text));
  }

  function hullList(c: FleetContext): HTMLElement[] {
    const out: HTMLElement[] = [el('p', 'fr-kicker fr-fab-head', `COMMISSION AN ESCORT HULL · UP TO ${FLEET_COMMAND.maxVessels} VESSELS`)];
    const ul = el('ul', 'fr-fab-list');
    for (const h of hullRows(c)) {
      const { li, info } = row(`${h.name} · ${h.role.toUpperCase()}`, h.description, h.cost, h.licence);
      li.dataset['ship'] = h.ship;
      info.append(actions(button(`hull:${h.ship}`, 'CHOOSE HULL', `Choose the ${h.name} hull, ${h.cost}`, h.why, () => {
        pending = null;
        buyShip = h.ship;
        buyCaptain = null;
        d.sound('uiSelect');
        say(`Choose a captain for the new ${h.name}.`);
        refresh();
        menuList.focus(0);
      })));
      if (h.why) info.append(el('span', 'fr-fab-why', h.why));
      ul.append(li);
    }
    out.push(ul, el('p', 'fr-fab-desc', `${hullsNotBuilt(c).join(' and ')}: ${d.kit.refusalText('ineligible')} An escort is a second hull flown by its captain; switching your own ship is done at the Hangar.`));
    return out;
  }

  function captainList(c: FleetContext, vessel: string | null): HTMLElement[] {
    const rows = crewRows(c, vessel);
    const ul = el('ul', 'fr-fab-list');
    if (!rows.length) ul.append(row('NO RECRUITED CREW', 'Crew are signed on at the Hangar\u2019s BRIDGE. Only recruited crew can captain a vessel.').li);
    for (const r of rows) {
      const ambiguous = !!(r.moveFrom || r.replaces);
      const note = r.moveFrom ? `Moves from the ${r.moveFrom}, which is left uncrewed.` : r.replaces ? `${r.replaces} returns to the crew roster.` : null;
      const { li, info } = row(r.name.toUpperCase(), r.role.toUpperCase(), note);
      li.dataset['crew'] = r.id;
      const key = `cap:${r.id}`;
      const armed = pending === key;
      const chosen = vessel === null && buyCaptain === r.id;
      info.append(actions(button(key, chosen ? 'CHOSEN' : armed ? 'CONFIRM CAPTAIN' : 'CHOOSE CAPTAIN', `Choose ${r.name} as captain${note ? `. ${note}` : ''}`, r.why, (e) => {
        if (vessel === null) {
          buyCaptain = r.id;
          pending = null;
          d.sound('uiSelect');
          say(`Review the commission, then press CONFIRM COMMISSION.`);
          refresh();
          restoreFocus(s.root, 'confirm');
          return;
        }
        if (ambiguous && !armed) {
          pending = key;
          d.sound('uiMove');
          say(`${note} Press CONFIRM CAPTAIN, or BACK to cancel.`);
          refresh();
          return;
        }
        if (armed && strayRepeat(e)) return;
        pending = null;
        const vname = vesselRows(c).find((x) => x.id === vessel)?.name ?? 'vessel';
        run({ kind: 'captain', vessel, crew: r.id }, (ok, text) => {
          if (ok) captainFor = null;
          say(ok ? `${r.name} now captains the ${vname}.` : text);
        });
      }, armed || chosen)));
      if (r.why) info.append(el('span', 'fr-fab-why', r.why));
      ul.append(li);
    }
    return [ul];
  }

  function purchaseStep(c: FleetContext): HTMLElement[] {
    const h = hullRows(c).find((x) => x.ship === buyShip);
    if (!h) {
      buyShip = null;
      return [];
    }
    const out: HTMLElement[] = [el('p', 'fr-kicker fr-fab-head', `NEW HULL · ${h.name}`), el('p', 'fr-fab-desc', `${h.description} ${h.cost} · ${h.licence}`)];
    out.push(el('p', 'fr-kicker fr-fab-head', 'CAPTAIN'), ...captainList(c, null));
    const r = buyCaptain ? c.kit.purchaseRefusal(c.vessels, h.ship, buyCaptain, c.world) : null;
    const why = !buyCaptain ? 'Choose a captain first.' : r ? c.kit.refusalText(r) : null;
    const confirm = button('confirm', busy ? 'COMMISSIONING…' : 'CONFIRM COMMISSION', `Confirm: commission the ${h.name} for ${h.cost}${buyCaptain ? `, captained by ${d.crewName(buyCaptain)}` : ''}`, why, (e) => {
      if (strayRepeat(e) || !buyShip || !buyCaptain) return; // a double click never also confirms
      const ship = buyShip;
      const cap = buyCaptain;
      run({ kind: 'buy', ship, captain: cap }, (ok, text) => {
        if (ok) {
          reset();
          // focus lands on the new vessel's own row, never on whatever slid under the old CONFIRM
          keep = `captain:${d.vessels().list.at(-1)?.id ?? ''}`;
        }
        say(text);
      });
    }, !!buyCaptain);
    out.push(actions(confirm, button('cancel', 'CANCEL', 'Cancel the commission', null, () => cancel())));
    if (buyCaptain && why) out.push(el('span', 'fr-fab-why', why));
    return out;
  }

  function adminBlock(c: FleetContext, adm: FleetAdmin): HTMLElement[] {
    const docked = d.station() !== null;
    const lines = adm.lines();
    const out: HTMLElement[] = [el('p', 'fr-kicker fr-fab-head', 'ADMIN ACCESS · TEST FLEET (SANDBOX, NEVER SAVED)')];
    for (const l of lines) out.push(el('p', 'fr-fab-desc', l));
    out.push(actions(
      button('admin-prepare', 'PREPARE TEST FLEET', 'Admin test: prepare a three-vessel test fleet in the sandbox', null, () => say(adm.prepare())),
      button('admin-reset', 'RESET TEST FLEET', 'Admin test: restore the fleet the session started with', null, () => say(adm.reset())),
    ));
    if (docked) {
      // the purchase cases as a normal session would see them (read-only: the kit's checks with Admin off; nothing is bought)
      const plain = { ...c.world, admin: false };
      const cases = hullRows({ ...c, world: plain }).map((h) => `${h.name}: ${h.why ?? 'would be accepted'}`);
      out.push(el('p', 'fr-fab-desc', `PURCHASE CHECK (normal rules, read-only) · ${cases.join(' · ')}`));
    }
    return out;
  }

  /* ------------------------------------------------------------- refresh */
  function refresh(): void {
    const focus = keep ?? focusedKey(s.root);
    const c = ctx();
    const docked = d.station() !== null;
    s.head.textContent = fleetHead(c, FLEET_COMMAND.maxVessels);
    const body: HTMLElement[] = [];
    if (docked && captainFor) {
      const v = vesselRows(c).find((x) => x.id === captainFor);
      if (!v) captainFor = null;
      else body.push(el('p', 'fr-kicker fr-fab-head', `CAPTAIN · ${v.name}`), ...captainList(c, v.id), actions(button('cancel', 'CANCEL', 'Cancel the captain choice', null, () => cancel())));
    }
    if (docked && !captainFor && buyShip) body.push(...purchaseStep(c));
    if (!body.length) {
      body.push(el('p', 'fr-kicker fr-fab-head', docked ? 'YOUR FLEET' : 'YOUR FLEET · ORDERS'), ...vesselList(c, docked));
      if (!docked && c.vessels.list.length) {
        body.push(el('p', 'fr-kicker fr-fab-head', `ALL ESCORTS${c.flight?.targetName ? ` · LOCKED: ${c.flight.targetName}` : ''}`), orderRow(c, 'all', 'All escorts'));
        body.push(el('p', 'fr-fab-desc', 'Captains, service and new hulls are handled docked, at a station\u2019s FLEET tab.'));
      }
      if (docked) body.push(...hullList(c));
      const adm = d.admin();
      if (adm) body.push(...adminBlock(c, adm));
    }
    const back = btn('', docked ? 'STATION' : 'PAUSE MENU', 'back', () => {
      if (!busy) d.back();
    });
    back.disabled = busy;
    body.push(actions(back));
    s.menu.replaceChildren(...body);
    restoreFocus(s.root, focus);
    // the focused action was replaced (a step finished): focus the first action instead of dropping to the page
    if (focus && !busy && !s.root.hidden && !s.root.contains(document.activeElement)) menuList.focus(0);
  }

  function cancel(): void {
    const had = pending || buyShip || captainFor;
    reset();
    if (had) {
      d.sound('uiMove');
      say('Cancelled. Nothing was changed.');
    }
    refresh();
    menuList.focus(0);
  }

  return {
    root: s.root,
    menu: menuList,
    open() {
      reset();
      busy = false;
      const at = d.station();
      s.kicker.textContent = at ? `FLEET COMMAND · ${at.toUpperCase()}` : 'FLEET COMMAND · IN FLIGHT (PAUSED)';
      say(at ? 'Escort hulls fly beside you, each commanded by a recruited captain. Orders are given in flight from the pause menu.' : 'Orders take effect when you resume. ATTACK uses your locked target (LOCK).');
      refresh();
      menuList.focus(0);
    },
    back() {
      if (busy) return;
      if (pending || buyShip || captainFor) cancel();
      else d.back();
    },
    refresh,
    status() {
      const c = ctx();
      return {
        mode: d.station() !== null ? 'docked' : 'flight',
        step: captainFor ? 'captain' : buyShip ? 'hull' : 'list',
        pending,
        busy,
        buyShip,
        buyCaptain,
        captainFor,
        message: s.message.textContent ?? '',
        rows: vesselRows(c).map((r) => ({ id: r.id, name: r.name, state: r.state, order: r.order, captain: r.captain, hull: r.hull })),
        buttons: [...s.root.querySelectorAll<HTMLButtonElement>('button[data-key]')].map((b) => ({ key: b.dataset['key']!, text: b.textContent ?? '', disabled: b.disabled })),
      };
    },
  };
}
