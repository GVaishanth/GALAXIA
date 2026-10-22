/**
 * Save slots panel (Free Roam Prompt 13). DOM only; every decision is made by
 * the mode (freeRoamMode.ts) through SavesDeps, and the card text comes from
 * the pure slotCard() below.
 *
 * It opens over whichever Free Roam screen is showing (galaxy map, system map
 * or a paused flight) as a modal layer, shows each slot's progress before it
 * is loaded or overwritten, and asks for an explicit confirmation before any
 * destructive action (NEW GAME over a used slot, DELETE). The confirmation
 * opens with CANCEL focused, so a repeated Enter never destroys anything.
 */
import { MenuList } from '../../../shared/ui/menuList.ts';
import { btn, el } from '../progression/ui/common.ts';
import { formatPlayTime, type SlotInfo, type SlotNo } from '../saveSlots.ts';

/** Names for the ids a slot stores (resolved by the chunk against the catalogue). */
export interface SlotNames {
  galaxy(id: string): string;
  /** id '' = the galaxy's gateway. */
  system(galaxyId: string, id: string): string;
  ship(id: string): string;
}

export interface SlotCard {
  readonly n: SlotNo;
  readonly state: SlotInfo['state'];
  readonly inUse: boolean;
  readonly title: string;
  readonly lines: readonly string[];
  /** One-line progress summary (also shown in the confirmation). */
  readonly summary: string;
}

const two = (n: number): string => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "21 Oct 2026, 14:32" in the player's local time. */
export function formatSavedAt(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The card for one slot (pure; exported for tests). */
export function slotCard(info: SlotInfo, active: SlotNo, names: SlotNames): SlotCard {
  const inUse = info.n === active;
  const title = `SLOT ${info.n}${inUse ? ' · IN USE' : ''}`;
  if (info.state === 'empty') return { n: info.n, state: info.state, inUse, title, lines: ['Empty slot.'], summary: 'empty' };
  if (info.state === 'damaged' || !info.facts) {
    return {
      n: info.n,
      state: info.state,
      inUse,
      title,
      lines: ['This slot could not be read. Starting a new game here keeps the damaged data as a backup copy in this browser.'],
      summary: 'unreadable save data',
    };
  }
  const f = info.facts;
  const where = `${names.system(f.galaxy, f.system)} · ${names.galaxy(f.galaxy)}`;
  const lines = [
    where,
    `${names.ship(f.ship)} · ${f.ships} ${f.ships === 1 ? 'ship' : 'ships'} owned`,
    `${f.marks.toLocaleString('en-US')} marks · missions ${f.missionsDone} done, ${f.missionsActive} active`,
    `${f.systemsVisited} ${f.systemsVisited === 1 ? 'system' : 'systems'} visited · ${f.charted} charted · ${f.galaxies} ${f.galaxies === 1 ? 'galaxy' : 'galaxies'}`,
    `Flight time ${formatPlayTime(f.flightSeconds).toLowerCase()} · ${f.savedAt > 0 ? `saved ${formatSavedAt(f.savedAt)}` : 'saved before save slots existed'}`,
  ];
  if (info.state === 'newer') lines.push('Saved by a newer version of GALAXIA: it can be played here but is never overwritten.');
  const summary = `${where}, ${f.marks.toLocaleString('en-US')} marks, ${f.missionsDone} missions done, ${formatPlayTime(f.flightSeconds).toLowerCase()} flown`;
  return { n: info.n, state: info.state, inUse, title, lines, summary };
}

export interface SavesView {
  readonly slots: readonly SlotInfo[];
  readonly active: SlotNo;
  /** Browser storage works (false: memory only, lost when the tab closes). */
  readonly persistent: boolean;
  /** The slot in use may be written (false: newer-version data, or a needed backup failed). */
  readonly writable: boolean;
  /** Last save of the slot in use: ms (0 = not yet this session) and whether it failed. */
  readonly lastSaveAt: number;
  readonly lastSaveFailed: boolean;
}

export interface SavesDeps {
  readonly view: () => SavesView;
  readonly names: SlotNames;
  /** Save the slot in use now; returns the feedback line. */
  readonly saveNow: () => string;
  /** Open another slot (the current one is saved first). Returns an error line, or '' when switching. */
  readonly load: (n: SlotNo) => string;
  /** Start a new game in slot n (confirmed already when it was used). Error line or ''. */
  readonly newGame: (n: SlotNo) => string;
  /** Delete slot n (confirmed already; never the slot in use). Feedback line. */
  readonly remove: (n: SlotNo) => string;
  readonly close: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
}

export type SavesCommand = 'prev' | 'next' | 'confirm' | 'back';

export interface SavesPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  isOpen(): boolean;
  /** Show it; `message` (e.g. a problem found while loading) appears in the status line. */
  open(message?: string): void;
  /** Hide it (the mode calls this from SavesDeps.close). */
  hide(): void;
  /** Re-read the slots (after a save). */
  refresh(): void;
  command(c: SavesCommand): void;
  status(): { readonly open: boolean; readonly confirm: string | null; readonly message: string; readonly storage: string; readonly cards: readonly { readonly n: number; readonly title: string; readonly text: string; readonly actions: readonly string[] }[] };
}

/** Storage lines shown at the top of the panel (exported for tests). */
export function storageLines(v: SavesView): readonly { readonly text: string; readonly warn: boolean }[] {
  const out: { text: string; warn: boolean }[] = [];
  if (!v.persistent) out.push({ text: 'Browser storage is unavailable: progress lasts only until this tab closes.', warn: true });
  else if (!v.writable) out.push({ text: 'The slot in use is read-only here (newer save data, or no backup copy could be made): progress is not saved.', warn: true });
  else if (v.lastSaveFailed) out.push({ text: 'The last save FAILED (browser storage full or blocked). The game keeps running and tries again at the next save.', warn: true });
  else if (v.lastSaveAt > 0) out.push({ text: `Slot ${v.active} saved ${formatSavedAt(v.lastSaveAt)}.`, warn: false });
  out.push({ text: 'Saves stay in this browser on this device only: they do not sync to other devices or browsers, and clearing site data erases them.', warn: false });
  return out;
}

type Pending = { readonly kind: 'new' | 'delete'; readonly card: SlotCard } | null;

export function createSavesPanel(d: SavesDeps): SavesPanel {
  const root = el('section', 'fr-saves');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'fr-saves-title');
  root.hidden = true;
  const box = el('div', 'fr-panel fr-saves-box');
  const kicker = el('p', 'fr-kicker', 'FREE ROAM');
  const title = el('h2', 'fr-title', 'SAVE SLOTS');
  title.id = 'fr-saves-title';
  const storage = el('div', 'fr-saves-storage');
  const message = el('p', 'fr-text fr-saves-msg');
  message.setAttribute('aria-live', 'polite');
  const body = el('div', 'fr-saves-body');
  box.append(kicker, title, storage, body, message);
  root.append(box);
  const menu = new MenuList(body, () => d.sound('uiMove'));

  let open = false;
  let pending: Pending = null;
  let msg = '';

  const focusIn = (i: number): void => {
    menu.focus(i);
    const a = document.activeElement;
    if (a instanceof HTMLElement && body.contains(a)) a.scrollIntoView({ block: 'nearest' });
  };
  const say = (text: string): void => {
    msg = text;
    message.textContent = text;
  };

  const render = (focusKey?: string): void => {
    const v = d.view();
    storage.replaceChildren(...storageLines(v).map((l) => el('p', l.warn ? 'fr-text fr-saves-warn' : 'fr-text fr-text-dim', l.text)));
    if (pending) {
      const p = pending;
      title.textContent = p.kind === 'new' ? `NEW GAME IN SLOT ${p.card.n}?` : `DELETE SLOT ${p.card.n}?`;
      const what =
        p.kind === 'new'
          ? `This erases the progress saved in slot ${p.card.n} (${p.card.summary}) and starts a new pilot there.`
          : `This erases the progress saved in slot ${p.card.n} (${p.card.summary}).`;
      const menuBox = el('div', 'fr-menu');
      menuBox.append(
        btn('', 'CANCEL', 'cancel', () => {
          d.sound('uiMove');
          pending = null;
          say('Nothing was changed.');
          render(`${p.kind}-${p.card.n}`);
        }),
        btn('fr-btn-danger', p.kind === 'new' ? 'ERASE AND START NEW' : 'DELETE SLOT', 'confirm', () => {
          pending = null;
          if (p.kind === 'new') {
            d.sound('uiSelect');
            const err = d.newGame(p.card.n);
            if (err) {
              say(err);
              render();
            }
          } else {
            d.sound('uiSelect');
            say(d.remove(p.card.n));
            render(`new-${p.card.n}`);
          }
        }),
      );
      body.replaceChildren(el('p', 'fr-text', what), el('p', 'fr-text fr-saves-warn', 'This cannot be undone.'), menuBox);
      focusIn(0); // CANCEL
      return;
    }
    title.textContent = 'SAVE SLOTS';
    const cards = v.slots.map((s) => slotCard(s, v.active, d.names));
    const nodes: HTMLElement[] = [];
    for (const c of cards) {
      const card = el('article', `fr-slot fr-slot-${c.state}${c.inUse ? ' fr-slot-active' : ''}`);
      card.dataset['slot'] = String(c.n);
      card.setAttribute('aria-label', `Slot ${c.n}`);
      card.append(el('h3', 'fr-slot-title', c.title), ...c.lines.map((l, i) => el('p', i === 0 && c.state === 'ready' ? 'fr-slot-line fr-slot-where' : 'fr-slot-line', l)));
      const actions = el('div', 'fr-slot-actions');
      if (c.inUse) {
        actions.append(btn('', 'CONTINUE', `continue-${c.n}`, () => d.close()));
      } else if (c.state === 'ready' || c.state === 'newer') {
        actions.append(
          btn('', 'LOAD', `load-${c.n}`, () => {
            d.sound('uiSelect');
            const err = d.load(c.n);
            if (err) say(err);
          }),
        );
      }
      const used = c.state !== 'empty';
      actions.append(
        btn('', 'NEW GAME', `new-${c.n}`, () => {
          if (!used) {
            d.sound('uiSelect');
            const err = d.newGame(c.n);
            if (err) say(err);
            return;
          }
          d.sound('uiSelect');
          pending = { kind: 'new', card: c };
          render();
        }),
      );
      if (used && !c.inUse) {
        actions.append(
          btn('', 'DELETE', `delete-${c.n}`, () => {
            d.sound('uiSelect');
            pending = { kind: 'delete', card: c };
            render();
          }),
        );
      }
      if (used && c.inUse) actions.append(el('p', 'fr-slot-line fr-text-dim', 'To delete this slot, load another one first.'));
      card.append(actions);
      nodes.push(card);
    }
    const foot = el('div', 'fr-menu fr-saves-foot');
    const save = btn('', 'SAVE NOW', 'save', () => {
      d.sound('uiSelect');
      say(d.saveNow());
      render('save');
    });
    save.disabled = !v.writable;
    foot.append(
      save,
      btn('', 'BACK', 'back', () => {
        d.sound('uiMove');
        d.close();
      }),
    );
    body.replaceChildren(...nodes, foot);
    const items = menu.buttons();
    const at = focusKey ? items.findIndex((b) => b.dataset['key'] === focusKey) : -1;
    focusIn(at >= 0 ? at : Math.max(0, items.findIndex((b) => b.dataset['key'] === `continue-${v.active}`)));
  };

  return {
    root,
    menu,
    isOpen: () => open,
    open(message = '') {
      open = true;
      pending = null;
      say(message);
      root.hidden = false;
      render();
    },
    hide() {
      open = false;
      pending = null;
      root.hidden = true;
    },
    refresh() {
      if (open) render(document.activeElement instanceof HTMLElement ? document.activeElement.dataset['key'] : undefined);
    },
    command(c) {
      if (!open) return;
      if (c === 'prev') menu.move(-1);
      else if (c === 'next') menu.move(1);
      else if (c === 'confirm') menu.activate();
      else if (pending) {
        const p = pending;
        pending = null;
        d.sound('uiMove');
        say('Nothing was changed.');
        render(`${p.kind}-${p.card.n}`);
      } else {
        d.sound('uiMove');
        d.close();
      }
      const a = document.activeElement;
      if (a instanceof HTMLElement && body.contains(a)) a.scrollIntoView({ block: 'nearest' });
    },
    status() {
      return {
        open,
        confirm: pending ? `${pending.kind}-${pending.card.n}` : null,
        message: msg,
        storage: storage.textContent ?? '',
        cards: [...body.querySelectorAll<HTMLElement>('.fr-slot')].map((c) => ({
          n: Number(c.dataset['slot']),
          title: c.querySelector('.fr-slot-title')?.textContent ?? '',
          text: c.textContent ?? '',
          actions: [...c.querySelectorAll('button')].map((b) => b.textContent ?? ''),
        })),
      };
    },
  };
}

