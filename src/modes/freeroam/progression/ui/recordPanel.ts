/**
 * Exploration record panel (Free Roam Prompt 11). DOM only: counters from
 * progression/discovery.ts explorationStats, entries from discoveryEntries.
 * ASTRONOMY entries (real, cited) and GALAXIA FICTION entries are separate
 * lists with their own labels, so an invented find is never shown as science.
 *
 * Economy pass: a GUILD MARKS section lists the balance and the bounded recent
 * history (ledger.ts; newest first, kept in the profile only, never sent).
 */
import { MenuList } from '../../../../shared/ui/menuList.ts';
import type { DiscoveryEntry, StatRow } from '../discovery.ts';
import { formatDelta, formatMarks, type LedgerEntry } from '../ledger.ts';
import { btn, el, panelShell } from './common.ts';

export interface RecordDeps {
  readonly stats: () => readonly StatRow[];
  readonly entries: () => readonly DiscoveryEntry[];
  readonly progressLine: () => string;
  /** Economy pass: the wallet balance and its recent history (oldest first, as stored). */
  readonly marks?: (() => { readonly balance: number; readonly history: readonly LedgerEntry[]; readonly note: string | null }) | undefined;
  readonly back: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
}

export interface RecordPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  open(): void;
  back(): void;
  status(): { readonly stats: Readonly<Record<string, number>>; readonly facts: number; readonly fiction: number; readonly history: readonly string[] };
}

export function createRecordPanel(d: RecordDeps): RecordPanel {
  const s = panelShell('record', 'Exploration record', 'EXPLORATION RECORD');
  const menuList = new MenuList(s.menu, () => d.sound('uiMove'));

  const entryList = (items: readonly DiscoveryEntry[], empty: string, tag: string): HTMLElement => {
    const ul = el('ul', 'fr-fab-list fr-record-list');
    if (!items.length) ul.append(el('li', 'fr-fab-empty', empty));
    for (const e of items) {
      const li = el('li', `fr-fab-row fr-record is-${e.kind}`);
      const info = el('div', 'fr-fab-info');
      info.append(el('span', 'fr-record-tag', tag), el('span', 'fr-fab-name', e.title.toUpperCase()), el('span', 'fr-fab-desc', e.text));
      if (e.sources.length) info.append(el('span', 'fr-record-src', `Source: ${e.sources.join('; ')}`));
      li.append(info);
      ul.append(li);
    }
    return ul;
  };

  const KIND_TAG: Readonly<Record<string, string>> = { mission: 'MISSION', bounty: 'BOUNTY', encounter: 'ENCOUNTER', discovery: 'DISCOVERY', sale: 'SALE', purchase: 'PURCHASE', upgrade: 'UPGRADE', ship: 'SHIP', travel: 'TRAVEL', refund: 'REFUND' };
  const historyText = (e: LedgerEntry): string => `${formatDelta(e.delta)} · ${KIND_TAG[e.kind] ?? e.kind.toUpperCase()} · ${e.label}${e.refunded ? ' · REFUNDED' : ''}`;
  const marksSection = (): HTMLElement[] => {
    if (!d.marks) return [];
    const m = d.marks();
    const ul = el('ul', 'fr-fab-list fr-ledger');
    ul.setAttribute('aria-label', 'Recent Guild marks changes, newest first');
    const rows = [...m.history].reverse();
    if (!rows.length) ul.append(el('li', 'fr-fab-empty', 'No marks earned or spent yet. Missions, bounties, cleared encounters, first discoveries and salvage sales pay Guild marks.'));
    for (const e of rows) {
      const li = el('li', `fr-ledger-row ${e.delta >= 0 ? 'is-gain' : 'is-loss'}`);
      li.append(el('span', 'fr-ledger-delta', formatDelta(e.delta)), el('span', 'fr-ledger-text', `${KIND_TAG[e.kind] ?? e.kind.toUpperCase()} · ${e.label}${e.refunded ? ' · REFUNDED' : ''}`), el('span', 'fr-ledger-bal', formatMarks(e.balance)));
      ul.append(li);
    }
    return [el('p', 'fr-kicker fr-fab-head', `GUILD MARKS · ${formatMarks(m.balance)}`), ...(m.note ? [el('p', 'fr-fab-desc', m.note)] : []), ul];
  };

  function refresh(): void {
    s.head.textContent = d.progressLine();
    const grid = el('dl', 'fr-record-stats');
    for (const r of d.stats()) grid.append(el('dt', '', r.label.toUpperCase()), el('dd', '', String(r.value)));
    const all = d.entries();
    const facts = all.filter((e) => e.kind === 'fact');
    const fiction = all.filter((e) => e.kind === 'fiction');
    const actions = el('div', 'fr-fab-actions');
    actions.append(btn('', 'BACK', 'back', () => d.back()));
    s.menu.replaceChildren(
      grid,
      ...marksSection(),
      el('p', 'fr-kicker fr-fab-head', `ASTRONOMY · REAL, CITED · ${facts.length}`),
      entryList(facts, 'Reach galaxies and real objects (verified systems) to log what astronomers know about them.', 'ASTRONOMY'),
      el('p', 'fr-kicker fr-fab-head', `GALAXIA FICTION · IN-GAME FINDS · ${fiction.length}`),
      el('p', 'fr-fab-desc', 'Invented for the game. These are not real astronomical discoveries.'),
      entryList(fiction, 'Investigate anomalies to log in-game finds.', 'FICTION'),
      actions,
    );
  }

  return {
    root: s.root,
    menu: menuList,
    open() {
      s.message.textContent = 'What you have explored so far.';
      refresh();
      menuList.focus(0);
    },
    back() {
      d.back();
    },
    status() {
      const all = d.entries();
      return { stats: Object.fromEntries(d.stats().map((r) => [r.id, r.value])), facts: all.filter((e) => e.kind === 'fact').length, fiction: all.filter((e) => e.kind === 'fiction').length, history: d.marks ? [...d.marks().history].reverse().map(historyText) : [] };
    },
  };
}
