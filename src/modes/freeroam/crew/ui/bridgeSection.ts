/**
 * BRIDGE section of the station hangar (P05.1). DOM only: the words and
 * every enabled / refused state come from crew/bridgeView.ts, and every
 * change goes through the shell (`act`), which runs the crew rules and
 * saves. This file never decides a rule, never pays and never stores.
 *
 *  - Real buttons only (no drag): Tab, arrows (the hangar's MenuList),
 *    Enter / Space, the pad and a tap all work.
 *  - A refused action stays focusable (aria-disabled), shows its reason
 *    under it and repeats the reason when pressed.
 *  - Paid hires and dismissals take two presses: the first arms and says
 *    what will happen, the second confirms (a mouse double-click never
 *    confirms). Back / ESC cancels an armed action first.
 *  - Rendering reads the model only: opening the Bridge never changes state.
 */
import { el, focusedKey, restoreFocus, strayRepeat } from '../../progression/ui/common.ts';
import type { ShipId } from '../../ships/types.ts';
import type { BridgeAction, BridgeModel, MemberCard } from '../bridgeView.ts';
import type { NavDoctrine } from '../types.ts';

declare const __GALAXIA_TEST_HOOKS__: boolean; // vite.config.ts `define` (TD-78: automation hooks, absent from release builds)

export type BridgeAct =
  | { readonly kind: 'hire'; readonly id: string }
  | { readonly kind: 'assign'; readonly id: string; readonly ship: ShipId }
  | { readonly kind: 'unassign'; readonly id: string }
  | { readonly kind: 'dismiss'; readonly id: string }
  | { readonly kind: 'doctrine'; readonly doctrine: NavDoctrine };

export interface BridgeDeps {
  readonly model: (ship: ShipId) => BridgeModel;
  /** Run one crew action (rules, payment, save) and say what happened. */
  readonly act: (a: BridgeAct) => { readonly ok: boolean; readonly text: string };
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus' | 'pause') => void;
}

export interface BridgeStatus {
  readonly ship: ShipId | null;
  readonly summary: string;
  readonly seats: readonly (string | null)[];
  readonly roster: readonly string[];
  readonly recruits: readonly { readonly id: string; readonly state: string; readonly enabled: boolean; readonly reason: string }[];
  readonly pending: string | null;
  readonly message: string;
  /** P05.2: duty status per seat, and the doctrine (null = no Navigator signed on). */
  readonly duty: readonly string[];
  readonly doctrine: NavDoctrine | null;
}

export interface BridgeSection {
  readonly root: HTMLElement;
  /** Draw the Bridge of `ship` (keeps the focused action when it still exists). */
  render(ship: ShipId): void;
  /** Forget panel state (armed action, expanded cards, message): a fresh hangar visit. */
  reset(): void;
  /** Cancel an armed action; true if there was one (Back / ESC uses it first). */
  cancel(): boolean;
  /** The status line (the hangar shows it in its own footer). */
  message(): string;
  status(): BridgeStatus;
}

export function createBridgeSection(d: BridgeDeps, onMessage: (text: string) => void): BridgeSection {
  const root = el('div', 'fr-bridge');
  root.setAttribute('aria-label', 'Bridge: crew seats, roster and recruitment');
  let ship: ShipId | null = null;
  let pending: string | null = null;
  let msg = '';
  const expanded = new Set<string>();
  let last: BridgeModel | null = null;

  const say = (text: string): void => {
    msg = text;
    onMessage(text);
  };

  const action = (cls: string, a: BridgeAction, key: string, run: (e: MouseEvent) => void): HTMLElement => {
    const wrap = el('div', 'fr-bridge-act');
    const b = el('button', `fr-btn fr-bridge-btn ${cls}`, a.label);
    b.type = 'button';
    b.dataset['key'] = key;
    if (!a.enabled) {
      b.setAttribute('aria-disabled', 'true');
      b.classList.add('is-refused');
    }
    b.setAttribute('aria-label', a.enabled ? a.label : `${a.label}: unavailable. ${a.reason}`);
    b.addEventListener('click', (e) => {
      if (!a.enabled) {
        d.sound('pause');
        say(a.reason);
        return;
      }
      run(e);
    });
    wrap.append(b);
    if (!a.enabled && a.reason) wrap.append(el('p', 'fr-bridge-reason', a.reason));
    return wrap;
  };

  const attrs = (c: MemberCard): HTMLElement => {
    const list = el('ul', 'fr-bridge-attrs');
    list.setAttribute('aria-label', 'Attributes');
    for (const a of c.attributes) {
      const li = el('li', 'fr-bridge-attr');
      li.setAttribute('aria-label', `${a.label.toLowerCase()} ${a.value} of ${a.max}`);
      const pips = el('span', 'fr-bridge-pips', `${'■'.repeat(a.value)}${'□'.repeat(Math.max(0, a.max - a.value))}`);
      pips.setAttribute('aria-hidden', 'true');
      li.append(el('span', 'fr-bridge-attr-k', a.label), pips, el('span', 'fr-bridge-attr-v', `${a.value}/${a.max}`));
      list.append(li);
    }
    return list;
  };

  /** Name, role, rank, attributes; INSPECT expands the bio and the intended contribution. */
  const card = (c: MemberCard, keyPrefix: string): HTMLElement => {
    const box = el('div', 'fr-bridge-card');
    const head = el('div', 'fr-bridge-card-head');
    head.append(el('span', 'fr-bridge-name', c.name.toUpperCase()), el('span', 'fr-bridge-role', `${c.roleLabel} · ${c.rankLabel}`));
    const open = expanded.has(c.id);
    const more = el('button', 'fr-btn fr-bridge-inspect', open ? 'HIDE' : 'INSPECT');
    more.type = 'button';
    more.dataset['key'] = `${keyPrefix}:inspect:${c.id}`;
    more.setAttribute('aria-expanded', String(open));
    more.setAttribute('aria-label', `${open ? 'Hide' : 'Inspect'} ${c.name}: background and intended duties`);
    more.addEventListener('click', () => {
      if (expanded.has(c.id)) expanded.delete(c.id);
      else expanded.add(c.id);
      d.sound('uiMove');
      redraw();
    });
    head.append(more);
    box.append(head, el('p', 'fr-bridge-duty', `${c.duty} ${c.background}.`), attrs(c));
    if (open) {
      const det = el('div', 'fr-bridge-more');
      det.append(el('p', 'fr-bridge-bio', c.bio));
      if (c.traits.length) {
        det.append(el('p', 'fr-bridge-sub', 'HOW THEY ADVISE'));
        const tl = el('ul', 'fr-bridge-contrib fr-bridge-traits');
        for (const line of c.traits) tl.append(el('li', '', line));
        det.append(tl);
      }
      det.append(el('p', 'fr-bridge-sub', 'DUTIES'));
      const ul = el('ul', 'fr-bridge-contrib');
      for (const line of c.contribution) ul.append(el('li', '', line));
      det.append(ul);
      box.append(det);
    }
    return box;
  };

  const sec = (title: string): HTMLElement => el('h4', 'fr-hangar-sec fr-bridge-sec', title);

  const run = (a: { readonly kind: 'hire' | 'assign' | 'unassign' | 'dismiss'; readonly id: string }, armKey: string | null, armText: string, e: MouseEvent | undefined): void => {
    if (armKey && pending !== armKey) {
      pending = armKey;
      d.sound('uiMove');
      say(armText);
      redraw(armKey);
      return;
    }
    if (armKey && strayRepeat(e)) return; // a double-click arms; confirming takes a deliberate second press
    pending = null;
    const r = d.act(a.kind === 'assign' ? { kind: 'assign', id: a.id, ship: ship! } : (a as BridgeAct));
    d.sound(r.ok ? (a.kind === 'hire' ? 'bonus' : 'uiSelect') : 'pause');
    say(r.text);
    redraw();
  };

  function redraw(focusKey?: string): void {
    if (!ship) return;
    const keep = focusKey ?? focusedKey(root);
    const m = d.model(ship);
    last = m;
    const kids: HTMLElement[] = [];

    // summary
    const sum = el('div', 'fr-bridge-summary');
    const line = el('p', 'fr-bridge-line', m.summary);
    line.setAttribute('role', 'note');
    sum.append(line);
    for (const n of m.notes) sum.append(el('p', 'fr-bridge-note', n));
    kids.push(sum);

    // P05.2: Navigator doctrine (a standing advisory preference, saved with the crew)
    if (m.doctrine) {
      const dr = m.doctrine;
      const row = el('div', 'fr-bridge-doctrine');
      const next = dr.next;
      const b = action('fr-bridge-doctrine-btn', dr.toggle, 'doctrine:toggle', () => {
        const r = d.act({ kind: 'doctrine', doctrine: next });
        d.sound(r.ok ? 'uiSelect' : 'pause');
        say(r.text);
        redraw('doctrine:toggle');
      });
      const btn = b.querySelector('button');
      if (btn) {
        btn.setAttribute('aria-pressed', String(dr.value === 'safety'));
        btn.setAttribute('aria-label', `Navigator doctrine: ${dr.label.toLowerCase()}. Press to switch to ${next === 'safety' ? 'safety-first' : 'balanced'}.`);
      }
      row.append(b, el('p', 'fr-bridge-note fr-bridge-doctrine-text', dr.text));
      kids.push(row);
    }

    // seats
    kids.push(sec(`SEATS · ${m.occupied}/${m.seats}`));
    const seats = el('div', 'fr-bridge-seats');
    if (m.seats === 0) seats.append(el('p', 'fr-bridge-empty', 'This hull has no crew seats.'));
    for (const s of m.seatCards) {
      const box = el('div', `fr-bridge-seat${s.member ? '' : ' is-empty'}`);
      box.append(el('p', 'fr-bridge-seat-no', `SEAT ${s.index + 1}`));
      if (s.member) {
        box.append(card(s.member, 'seat'), el('p', 'fr-bridge-note fr-bridge-status', s.status));
        if (s.unassign) {
          const id = s.member.id;
          box.append(action('fr-bridge-unassign', s.unassign, `unassign:${id}`, (e) => run({ kind: 'unassign', id }, null, '', e)));
        }
      } else box.append(el('p', 'fr-bridge-empty', m.owned ? 'EMPTY SEAT · assign someone from the roster below, or fly without.' : 'EMPTY SEAT'));
      seats.append(box);
    }
    kids.push(seats);

    // roster
    kids.push(sec(`ROSTER · ${m.hired} SIGNED ON · ${m.unassigned} UNASSIGNED`));
    const roster = el('div', 'fr-bridge-list');
    if (m.roster.length === 0) roster.append(el('p', 'fr-bridge-empty', m.hired === 0 ? 'No crew signed on yet. Recruits are listed below.' : `Everyone on your roster is aboard the ${m.shipName}.`));
    for (const r of m.roster) {
      const box = el('div', 'fr-bridge-entry');
      box.append(el('p', 'fr-bridge-where', r.where), card(r.card, 'roster'));
      const acts = el('div', 'fr-bridge-acts');
      const id = r.card.id;
      const dismissKey = `dismiss:${id}`;
      acts.append(
        action('fr-bridge-assign', r.assign, `assign:${id}`, (e) => run({ kind: 'assign', id }, null, '', e)),
        action(`fr-bridge-dismiss${pending === dismissKey ? ' is-armed' : ''}`, pending === dismissKey ? { ...r.dismiss, label: `CONFIRM · DISMISS ${r.card.name.toUpperCase()}` } : r.dismiss, dismissKey, (e) =>
          run({ kind: 'dismiss', id }, dismissKey, `Press again to end ${r.card.name}'s contract. They return to the station where they signed on, and can sign on again later without a second fee.`, e),
        ),
      );
      box.append(acts);
      roster.append(box);
    }
    kids.push(roster);

    // recruitment
    kids.push(sec('RECRUITMENT'));
    const wallet = el('p', 'fr-bridge-wallet', `GUILD MARKS ${m.balance}`);
    kids.push(wallet);
    const recruits = el('div', 'fr-bridge-list');
    if (m.recruits.length === 0) recruits.append(el('p', 'fr-bridge-empty', m.recruitEmpty));
    for (const r of m.recruits) {
      const box = el('div', `fr-bridge-entry is-${r.state}`);
      box.append(el('p', 'fr-bridge-where', r.location), card(r.card, 'recruit'));
      const terms = el('ul', 'fr-hangar-terms fr-bridge-terms');
      for (const q of r.requirements) {
        const li = el('li', `fr-hangar-term${q.met ? ' is-met' : ''}`);
        li.append(el('span', 'fr-hangar-term-mark', q.met ? '✓' : '✗'), el('span', 'fr-hangar-term-text', `REQUIRES · ${q.text}`));
        terms.append(li);
      }
      if (r.requirements.length === 0) terms.append(el('li', 'fr-hangar-term is-met fr-bridge-noreq', 'NO REQUIREMENT'));
      box.append(terms, el('p', 'fr-bridge-fee', r.feeText), el('p', 'fr-bridge-balance', r.balanceText));
      const id = r.card.id;
      const hireKey = `hire:${id}`;
      const paid = r.fee > 0;
      const armed = paid && pending === hireKey;
      box.append(
        action(`fr-bridge-hire${armed ? ' is-armed' : ''}`, armed ? { ...r.hire, label: `CONFIRM · PAY ${r.feeText.split(' · ')[0]}` } : r.hire, hireKey, (e) =>
          run({ kind: 'hire', id }, paid ? hireKey : null, `Press again to pay the one-time berth fee and sign ${r.card.name} on. ${r.balanceText}.`, e),
        ),
      );
      recruits.append(box);
    }
    kids.push(recruits);

    root.replaceChildren(...kids);
    if (keep) restoreFocus(root, keep);
  }

  return {
    root,
    render(s) {
      if (s !== ship) {
        pending = null;
        ship = s;
      }
      redraw();
    },
    reset() {
      ship = null;
      pending = null;
      msg = '';
      expanded.clear();
      last = null;
      root.replaceChildren();
    },
    cancel() {
      if (!pending) return false;
      pending = null;
      say('Cancelled.');
      redraw();
      return true;
    },
    message: () => msg,
    status() {
      if (!__GALAXIA_TEST_HOOKS__) return null as never; // P08.1 (TD-78): a browser-check reader only; release builds keep a stub
      const m = last;
      return {
        ship,
        summary: m?.summary ?? '',
        seats: m ? m.seatCards.map((s) => s.member?.id ?? null) : [],
        roster: m ? m.roster.map((r) => r.card.id) : [],
        recruits: m ? m.recruits.map((r) => ({ id: r.card.id, state: r.state, enabled: r.hire.enabled, reason: r.hire.reason })) : [],
        pending,
        message: msg,
        duty: m ? m.seatCards.map((s) => s.status) : [],
        doctrine: m?.doctrine?.value ?? null,
      };
    },
  };
}
