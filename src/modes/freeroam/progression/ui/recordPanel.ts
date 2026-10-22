/**
 * Exploration record panel (Free Roam Prompt 11). DOM only: counters from
 * progression/discovery.ts explorationStats, entries from discoveryEntries.
 * ASTRONOMY entries (real, cited) and GALAXIA FICTION entries are separate
 * lists with their own labels, so an invented find is never shown as science.
 */
import { MenuList } from '../../../../shared/ui/menuList.ts';
import type { DiscoveryEntry, StatRow } from '../discovery.ts';
import { btn, el, panelShell } from './common.ts';

export interface RecordDeps {
  readonly stats: () => readonly StatRow[];
  readonly entries: () => readonly DiscoveryEntry[];
  readonly progressLine: () => string;
  readonly back: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
}

export interface RecordPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  open(): void;
  back(): void;
  status(): { readonly stats: Readonly<Record<string, number>>; readonly facts: number; readonly fiction: number };
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
      return { stats: Object.fromEntries(d.stats().map((r) => [r.id, r.value])), facts: all.filter((e) => e.kind === 'fact').length, fiction: all.filter((e) => e.kind === 'fiction').length };
    },
  };
}
