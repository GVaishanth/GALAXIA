/**
 * Missions panel (Free Roam Prompt 11). DOM only: rows come from
 * progression/view.ts and every action goes back to the shell, which runs the
 * mission manager and saves. Docked: turn in, deliver, the Guild dispatch
 * (story) and the station's contract board. In flight (pause menu): the log
 * of active and completed missions.
 *
 * Accepting, abandoning and turning in are two presses (the first shows what
 * it means: rewards, deadline, or what is lost).
 */
import { MenuList } from '../../../../shared/ui/menuList.ts';
import { HEAT_HELP, type HeatView } from '../../combat/factionHeat.ts';
import type { MissionRow, MissionsModel } from '../view.ts';
import { btn, el, focusedKey, panelShell, restoreFocus } from './common.ts';

export interface MissionsDeps {
  /** Station name when docked (null = log only, from the pause menu). */
  readonly docked: () => string | null;
  /** Display name of the station docked at. */
  readonly stationName: () => string;
  readonly model: () => MissionsModel;
  /** P09.2: the four factions' heat (read-only snapshot). */
  readonly standing: () => readonly HeatView[];
  readonly accept: (id: string) => string;
  readonly abandon: (id: string) => string;
  readonly claim: (id: string) => { readonly ok: boolean; readonly text: string };
  readonly deliver: (id: string) => string;
  readonly back: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
}

export interface MissionsPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  open(): void;
  back(): void;
  refresh(): void;
  status(): { readonly pending: string | null; readonly message: string; readonly keys: readonly string[] };
}

/** P09.2: a chain stage's status in words (the real MissionStatus; never colour or a glyph alone). */
const STAGE: Readonly<Record<string, string>> = { locked: 'LOCKED', available: 'ON THE GUILD DISPATCH', active: 'ACTIVE', ready: 'TURN IN AT ANY STATION', claimed: 'TURNED IN', failed: 'FAILED' };

export function createMissionsPanel(d: MissionsDeps): MissionsPanel {
  const s = panelShell('missions', 'Missions', 'MISSIONS');
  const menuList = new MenuList(s.menu, () => d.sound('uiMove'));
  let pending: string | null = null;
  const keys: string[] = [];
  const say = (t: string): void => {
    s.message.textContent = t;
  };

  const rowEl = (r: MissionRow, extra: HTMLElement[]): HTMLElement => {
    const li = el('li', `fr-fab-row fr-mission is-${r.source}`);
    li.dataset['mission'] = r.id;
    const info = el('div', 'fr-fab-info');
    info.append(el('span', 'fr-fab-name', `${r.title.toUpperCase()} · ${r.chain ?? (r.source === 'story' ? 'GUILD STORY' : 'CONTRACT')}`), el('span', 'fr-mission-type', r.type), el('span', 'fr-fab-desc', r.description));
    const obj = el('ul', 'fr-mission-obj');
    for (const o of r.objectives) obj.append(el('li', o.value >= o.count ? 'is-done' : '', `${o.value >= o.count ? '✓' : '○'} ${o.label} ${o.value}/${o.count} · ${o.where}`));
    info.append(obj);
    if (r.jumpsLeft !== null) info.append(el('span', 'fr-mission-deadline', `DEADLINE · ${r.jumpsLeft} JUMP${r.jumpsLeft === 1 ? '' : 'S'}${r.objectives.every((o) => o.value === 0) ? ' AFTER ACCEPTING' : ' LEFT'}`));
    if (r.rewards.length) info.append(el('span', 'fr-mission-reward', `REWARD · ${r.rewards.join(' · ')}`));
    if (r.delivery) info.append(el('span', 'fr-fab-why', `${r.delivery.left} ${r.delivery.resource} still to deliver · ${r.delivery.have} aboard${r.delivery.here ? '' : ' · hand over at the named station'}`));
    const acts = el('div', 'fr-mission-acts');
    acts.append(...extra);
    info.append(acts);
    li.append(info);
    return li;
  };

  /** Two-press button: first press arms it with an explanation, the second runs it. */
  const armed = (cls: string, label: string, confirm: string, key: string, explain: string, run: () => void): HTMLButtonElement => {
    keys.push(key);
    const b = btn(`${cls}${pending === key ? ' is-armed' : ''}`, pending === key ? confirm : label, key, () => {
      if (pending !== key) {
        pending = key;
        d.sound('uiMove');
        say(explain);
        refresh();
        return;
      }
      pending = null;
      run();
      refresh();
    });
    return b;
  };

  const section = (title: string, rows: HTMLElement[], empty: string): HTMLElement[] => {
    const ul = el('ul', 'fr-fab-list');
    if (rows.length) ul.append(...rows);
    else ul.append(el('li', 'fr-fab-empty', empty));
    return [el('p', 'fr-kicker fr-fab-head', title), ul];
  };

  function refresh(): void {
    const focus = focusedKey(s.root);
    const m = d.model();
    const station = d.docked();
    keys.length = 0;
    s.head.textContent = station ? `DOCKED · ${d.stationName().toUpperCase()} · ${m.active.length} ACTIVE · ${m.completed.length} COMPLETED` : `${m.active.length} ACTIVE · ${m.ready.length} TO TURN IN · ${m.completed.length} COMPLETED`;
    const out: HTMLElement[] = [];
    if (m.ready.length || station) {
      out.push(
        ...section(
          'READY TO TURN IN',
          m.ready.map((r) =>
            rowEl(
              r,
              station
                ? [
                    armed('fr-fab-claim', 'TURN IN', 'CONFIRM · COLLECT REWARD', `claim:${r.id}`, `Turn in ${r.title}: ${r.rewards.join(', ')}.`, () => {
                      const res = d.claim(r.id);
                      if (res.ok) d.sound('bonus');
                      say(res.text);
                    }),
                  ]
                : [el('span', 'fr-fab-why', 'Turn it in at any station.')],
            ),
          ),
          'Nothing to turn in.',
        ),
      );
    }
    out.push(
      ...section(
        'ACTIVE',
        m.active.map((r) => {
          const extra: HTMLElement[] = [];
          if (station && r.delivery?.here && r.delivery.have > 0) {
            const n = Math.min(r.delivery.left, r.delivery.have);
            extra.push(armed('fr-fab-build', `DELIVER ${n}`, `CONFIRM · HAND OVER ${n}`, `deliver:${r.id}`, `Hand over ${n} ${r.delivery.resource} from your hold.`, () => say(d.deliver(r.id))));
          }
          extra.push(armed('fr-fab-fit', 'ABANDON', 'CONFIRM · ABANDON', `abandon:${r.id}`, r.source === 'story' ? `Abandon ${r.title}? Its progress is lost; the Guild dispatch offers it again.` : `Abandon ${r.title}? The contract fails and this board will not post it again.`, () => say(d.abandon(r.id))));
          return rowEl(r, extra);
        }),
        station ? 'No active missions. Accept one below.' : 'No active missions. Dock at a station to take one.',
      ),
    );
    if (station) {
      out.push(
        ...section(
          'GUILD DISPATCH · STORY',
          m.dispatch.map((r) => rowEl(r, [armed('fr-fab-build', 'ACCEPT', 'CONFIRM · ACCEPT', `accept:${r.id}`, `Accept ${r.title}? Reward: ${r.rewards.join(', ')}.`, () => say(d.accept(r.id)))])),
          'No new story mission right now: finish the active one first.',
        ),
      );
      const boardRows = section(
        'STATION BOARD · CONTRACTS',
        m.board.map((r) => rowEl(r, [armed('fr-fab-build', 'ACCEPT', 'CONFIRM · ACCEPT', `accept:${r.id}`, `Accept ${r.title}?${r.jumpsLeft !== null ? ` It fails after ${r.jumpsLeft} jumps.` : ''} Reward: ${r.rewards.join(', ')}.`, () => say(d.accept(r.id)))])),
        m.boardNote || 'No contracts here.',
      );
      if (m.board.length && m.boardNote) boardRows.splice(1, 0, el('p', 'fr-fab-desc fr-board-note', m.boardNote));
      out.push(...boardRows);
    }
    // P09.2: connected chains (stage, status, lock reason; details for the current stage) and faction standing
    const card = (key: string, name: string, ...body: HTMLElement[]): HTMLElement => {
      const li = el('li', 'fr-fab-row');
      li.dataset['key'] = key;
      const info = el('div', 'fr-fab-info');
      info.append(el('span', 'fr-fab-name', name), ...body);
      li.append(info);
      return li;
    };
    out.push(
      ...section(
        'GUILD CHAINS',
        m.chains.map((c) => {
          const ul = el('ul', 'fr-mission-obj');
          c.stages.forEach((st, i) => {
            const cur = st.id === c.current;
            ul.append(el('li', st.status === 'claimed' ? 'is-done' : '', `${st.status === 'claimed' ? '✓' : cur ? '▸' : '○'} ${i + 1} · ${st.title.toUpperCase()} · ${STAGE[st.status]}${st.why ? `: ${st.why}` : ''}`));
            if (cur) ul.append(el('li', '', `${st.objective} · REWARD ${st.rewards.join(' · ')}${st.consequence ? ` · ${st.consequence} ON TURN-IN` : ''}`));
          });
          return card(c.id, `${c.title.toUpperCase()} · ${c.current ? `STAGE ${c.completed + 1}` : 'COMPLETE'} OF ${c.stages.length}`, ul);
        }),
        '',
      ),
      ...section(
        'FACTION STANDING',
        d.standing().map((h) => {
          const bar = el('meter', '');
          bar.max = 100;
          bar.value = h.value;
          bar.setAttribute('aria-label', `${h.label} heat`);
          return card(h.faction, `${h.label.toUpperCase()} · HEAT ${h.value}/100 · ${h.tierName.toUpperCase()}`, bar, el('span', 'fr-fab-desc', h.effect));
        }),
        '',
      ),
      el('p', 'fr-fab-desc', HEAT_HELP),
    );
    if (m.completed.length) out.push(el('p', 'fr-kicker fr-fab-head', 'COMPLETED'), el('p', 'fr-fab-desc fr-mission-done', m.completed.slice(-8).reverse().join(' · ')));
    const actions = el('div', 'fr-fab-actions');
    actions.append(btn('', station ? 'HANGAR' : 'BACK', 'back', () => d.back()));
    out.push(actions);
    s.menu.replaceChildren(...out);
    restoreFocus(s.root, focus);
  }

  return {
    root: s.root,
    menu: menuList,
    open() {
      pending = null;
      const station = d.docked();
      s.kicker.textContent = station ? `MISSIONS · ${d.stationName().toUpperCase()}` : 'MISSIONS · LOG';
      say(station ? 'Turn in finished missions, take story work from the Guild dispatch or contracts from this board.' : 'Mission log. Targets are marked on the system map; dock at a station to accept or turn in.');
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
    refresh,
    status() {
      return { pending, message: s.message.textContent ?? '', keys: [...keys] };
    },
  };
}
