/**
 * Home-page music controls (Finale P2): PLAY MUSIC (only while the browser is
 * holding the music), MUTE MUSIC and the music volume, with a short status
 * line. The same saved settings as Classic's SETTINGS and Free Roam's SOUND
 * panel (`galaxia:prefs`); they work and save even when the theme never loads
 * (blocked, unavailable). Entry code, DOM only, no frame loop.
 *
 *   - MUTE MUSIC: a toggle button (aria-pressed). Music only; effects stay.
 *   - Music volume: a native range input 0-100 (pointer, touch and keyboard),
 *     the value shown beside it. Dragging changes the level live; the value is
 *     saved once, on release (`change`), not on every step of a drag.
 */
import type { AudioPrefs } from '../../persistence/saveData.ts';
import type { MusicStatus } from '../audio/titleMusic.ts';

export interface TitleMusicControlsDeps {
  readonly get: () => AudioPrefs;
  /** Save a change (shared prefs) and apply it to the SoundSystem. */
  readonly save: (change: Partial<AudioPrefs>) => void;
  /** Apply a level live without saving (a drag in progress). */
  readonly preview: (prefs: AudioPrefs) => void;
  readonly play: () => void;
  readonly status: () => MusicStatus;
}

export interface TitleMusicControls {
  readonly root: HTMLElement;
  refresh(): void;
}

const STATUS: Readonly<Record<MusicStatus, string>> = {
  idle: '',
  'sound-off': 'SOUND IS OFF IN SETTINGS',
  muted: 'MUSIC MUTED',
  silent: 'MUSIC VOLUME 0',
  loading: 'LOADING MUSIC…',
  locked: 'MUSIC STARTS WHEN YOU PRESS PLAY MUSIC',
  blocked: 'THE BROWSER PAUSED THE MUSIC: PRESS PLAY MUSIC',
  playing: '♪ MUSIC: BEYOND THE BEACON',
  paused: 'MUSIC PAUSED',
  unavailable: 'MUSIC UNAVAILABLE IN THIS BROWSER',
};

const pct = (v: number): number => Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 100);

export function createTitleMusicControls(d: TitleMusicControlsDeps): TitleMusicControls {
  const root = document.createElement('div');
  root.className = 'title-music';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Music');

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'title-music-play';
  play.textContent = '▶ PLAY MUSIC';
  play.addEventListener('click', () => d.play());

  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'title-music-mute';
  mute.textContent = 'MUTE MUSIC';
  mute.addEventListener('click', () => {
    d.save({ musicMuted: d.get().musicMuted !== true });
    refresh();
  });

  const vol = document.createElement('label');
  vol.className = 'title-music-vol';
  const name = document.createElement('span');
  name.textContent = 'MUSIC';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.step = '5';
  range.setAttribute('aria-label', 'Music volume');
  const value = document.createElement('output');
  const show = (n: number): void => {
    value.textContent = `${n}%`;
    range.setAttribute('aria-valuetext', `${n} percent`);
  };
  range.addEventListener('input', () => {
    const n = Number(range.value);
    show(n);
    d.preview({ ...d.get(), music: n / 100 });
  });
  range.addEventListener('change', () => {
    d.save({ music: Number(range.value) / 100 });
    refresh();
  });
  vol.append(name, range, value);

  const line = document.createElement('p');
  line.className = 'title-music-status';
  line.setAttribute('role', 'status');

  root.append(play, mute, vol, line);

  function refresh(): void {
    const a = d.get();
    const s = d.status();
    const wasFocused = document.activeElement === play;
    // hidden keeps its box (styles.css): starting the music mid-tap never moves the page under the finger
    play.hidden = !(s === 'locked' || s === 'blocked');
    // keyboard focus never falls to the page; moved in a later task, because Enter on PLAY MUSIC starts the
    // music in its keydown and the key's own activation (keypress -> click) would otherwise land on MUTE MUSIC
    if (play.hidden && wasFocused) {
      setTimeout(() => {
        const f = document.activeElement;
        if (root.isConnected && play.hidden && (f === play || f === document.body || f === null)) mute.focus();
      }, 0);
    }
    mute.setAttribute('aria-pressed', String(a.musicMuted === true));
    const n = pct(a.music);
    if (document.activeElement !== range) range.value = String(n); // never yank a slider being dragged
    show(Number(range.value));
    line.textContent = STATUS[s];
  }

  refresh();
  return { root, refresh };
}
