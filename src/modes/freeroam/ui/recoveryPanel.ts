/**
 * Ship destroyed / recovery screen (Prompt 12). DOM only. It explains what the
 * recall (Prompt 9) already did: the ship is back at the arrival zone, hull,
 * shield and energy are restored, and half of each common cargo stack waits in
 * a marked wreck where the ship fell. The flight stays paused while it shows;
 * CONTINUE resumes it and SECTOR MAP shows where the wreck is.
 *
 * The recall itself happened in the simulation before this opens; the screen's
 * entrance delay (so the wreck burst is seen first) is presentation only.
 */
import { MenuList } from '../../../shared/ui/menuList.ts';
import { btn, el } from '../progression/ui/common.ts';

export interface RecoveryInfo {
  readonly ship: string;
  /** Units left in the cargo wreck (0 = no cargo lost). */
  readonly wreckUnits: number;
  /** Recalls in this visit (including this one). */
  readonly recalls: number;
}

export interface RecoveryDeps {
  readonly resume: () => void;
  readonly sectorMap: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
}

export interface RecoveryPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  open(info: RecoveryInfo): void;
  status(): { readonly title: string; readonly text: string };
}

/** The recovery text (exported for tests and the playtest). */
export function recoveryText(i: RecoveryInfo): { readonly title: string; readonly lines: readonly string[] } {
  const lines = [
    'The Guild recalled you to the arrival zone. Hull, shield and energy are restored.',
    i.wreckUnits > 0
      ? `${i.wreckUnits} unit${i.wreckUnits === 1 ? '' : 's'} of cargo stayed in a wreck where you fell. It is marked on the sector map: fly back to recover it. Lose the ship again first and that cargo is gone.`
      : 'No cargo was lost.',
  ];
  if (i.recalls > 1) lines.push(`Recalls this visit: ${i.recalls}.`);
  return { title: `${i.ship.toUpperCase()} DESTROYED`, lines };
}

export function createRecoveryPanel(d: RecoveryDeps): RecoveryPanel {
  const root = el('section', 'fr-panel fr-panel-recovery');
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-label', 'Ship destroyed');
  root.hidden = true;
  const kicker = el('p', 'fr-kicker', 'RECALLED');
  const title = el('h2', 'fr-title', 'SHIP DESTROYED');
  const body = el('div', 'fr-recovery-body');
  const menu = el('div', 'fr-menu');
  menu.append(btn('fr-recovery-continue', 'CONTINUE', 'continue', () => d.resume()), btn('fr-recovery-map', 'SECTOR MAP', 'map', () => d.sectorMap()));
  root.append(kicker, title, body, menu);
  const menuList = new MenuList(menu, () => d.sound('uiMove'));
  return {
    root,
    menu: menuList,
    open(info) {
      const t = recoveryText(info);
      title.textContent = t.title;
      body.replaceChildren(...t.lines.map((l, i) => el('p', i === 1 && info.wreckUnits > 0 ? 'fr-text fr-recovery-wreck' : 'fr-text', l)));
      menuList.focus(0);
    },
    status() {
      return { title: title.textContent ?? '', text: body.textContent ?? '' };
    },
  };
}
