/**
 * SOUND panel (Prompt 12): mute and the master / effects / music volumes,
 * reachable from the pause menu and the sector briefing. DOM only. Every
 * press writes the shared preferences (`galaxia:prefs`, the same settings
 * Classic shows) and plays a short preview through the new levels, so the
 * effect is heard at once. FULLSCREEN (TD-72) uses the same shared helper as
 * Classic's SETTINGS and is hidden where the browser has no fullscreen. Audio still starts only after a user gesture
 * (the shared SoundSystem's lock); these buttons are such gestures.
 */
import { MenuList } from '../../../shared/ui/menuList.ts';
import type { AudioPrefs } from '../../../persistence/saveData.ts';
import { BUS_LABEL, stepVolume, volumeText, type VolumeBus } from '../audio/audioSettings.ts';
import { btn, el } from '../progression/ui/common.ts';

export interface SoundDeps {
  readonly get: () => AudioPrefs;
  /** Persist a change (shared prefs) and apply it to the SoundSystem. */
  readonly set: (change: Partial<AudioPrefs>) => void;
  /** Preview a bus at its new level. */
  readonly preview: (bus: VolumeBus) => void;
  readonly back: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus') => void;
  /** Page fullscreen (TD-72, shared/ui/fullscreen.ts); the button is hidden where unsupported. */
  readonly fullscreen?: {
    readonly supported: () => boolean;
    readonly on: () => boolean;
    readonly toggle: () => void;
  };
}

export interface SoundPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  open(): void;
  back(): void;
  status(): AudioPrefs;
  /** Re-read the fullscreen state (fullscreenchange). */
  syncFullscreen(): void;
}

export function createSoundPanel(d: SoundDeps): SoundPanel {
  const root = el('section', 'fr-panel fr-panel-sound');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Sound settings');
  root.hidden = true;
  const note = el('p', 'fr-text fr-text-dim', 'Shared with Classic. Sounds are synthesised in the game: nothing is downloaded.');
  const menu = el('div', 'fr-menu fr-sound');
  root.append(el('p', 'fr-kicker', 'SETTINGS'), el('h2', 'fr-title', 'SOUND & DISPLAY'), menu, note);
  const menuList = new MenuList(menu, () => d.sound('uiMove'));

  const muteBtn = btn('fr-sound-mute', 'SOUND: ON', 'mute', () => {
    d.set({ muted: !d.get().muted });
    refresh();
    if (!d.get().muted) d.preview('sfx');
  });
  const rows = new Map<VolumeBus, { readonly value: HTMLElement; readonly down: HTMLButtonElement; readonly up: HTMLButtonElement }>();
  const rowEls: HTMLElement[] = [];
  for (const bus of ['master', 'sfx', 'music'] as const) {
    const row = el('div', `fr-sound-row fr-sound-${bus}`);
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', `${BUS_LABEL[bus]} volume`);
    const value = el('span', 'fr-sound-value', '');
    value.setAttribute('aria-live', 'polite');
    const change = (dir: 1 | -1): void => {
      const next = stepVolume(d.get()[bus], dir);
      if (next === d.get()[bus]) return;
      d.set({ [bus]: next });
      refresh();
      d.preview(bus);
    };
    const down = btn('fr-sound-step', '−', `${bus}:down`, () => change(-1));
    down.setAttribute('aria-label', `${BUS_LABEL[bus]} quieter`);
    const up = btn('fr-sound-step', '+', `${bus}:up`, () => change(1));
    up.setAttribute('aria-label', `${BUS_LABEL[bus]} louder`);
    row.append(el('span', 'fr-sound-label', BUS_LABEL[bus]), down, value, up);
    rows.set(bus, { value, down, up });
    rowEls.push(row);
  }
  const fs = d.fullscreen;
  const fullBtn = btn('fr-sound-fullscreen', 'FULLSCREEN: OFF', 'fullscreen', () => fs?.toggle());
  const back = btn('fr-sound-back', 'BACK', 'back', () => d.back());
  menu.append(muteBtn, ...rowEls, fullBtn, back);

  function syncFullscreen(): void {
    const supported = !!fs && fs.supported();
    fullBtn.hidden = !supported;
    fullBtn.disabled = !supported;
    const on = supported && fs!.on();
    fullBtn.textContent = on ? 'FULLSCREEN: ON' : 'FULLSCREEN: OFF';
    fullBtn.setAttribute('aria-pressed', String(on));
  }

  function refresh(): void {
    const a = d.get();
    muteBtn.textContent = a.muted ? 'SOUND: OFF (MUTED)' : 'SOUND: ON';
    muteBtn.setAttribute('aria-pressed', String(a.muted));
    for (const [bus, r] of rows) {
      r.value.textContent = volumeText(a[bus]);
      // at the ends the step does nothing: shown, never hidden (the layout does not jump)
      r.down.setAttribute('aria-disabled', String(a[bus] <= 0));
      r.up.setAttribute('aria-disabled', String(a[bus] >= 1));
      r.value.closest('.fr-sound-row')?.classList.toggle('is-muted', a.muted);
    }
  }

  return {
    root,
    menu: menuList,
    open() {
      refresh();
      syncFullscreen();
      menuList.focus(0);
    },
    back() {
      d.back();
    },
    status: () => d.get(),
    syncFullscreen,
  };
}
