/**
 * Home-page music director (Finale P2). Entry code, small: it decides when the
 * theme should play and loads the theme player (audio/music/galaxiaTheme.ts,
 * its own lazy chunk) only when the home page wants music. It never plays
 * anywhere else: a mode starting stops it, a `?mode=` deep link never shows
 * the home page, and Free Roam does not import it.
 *
 * Policy:
 *   - Plays while the home page is shown, the page is visible, and the music
 *     is enabled (SOUND on, Mute Music off, music volume above 0).
 *   - Autoplay: the AudioContext is created only by a user gesture (the
 *     project rule, SoundSystem.unlock) unless the browser itself reports that
 *     autoplay is allowed (navigator.getAutoplayPolicy, where it exists). Until
 *     then the status is 'locked' and the home page offers PLAY MUSIC. A
 *     context that stays suspended after a gesture, or whose resume() is
 *     rejected, is 'blocked': no retry loop, PLAY MUSIC tries again on the next
 *     press. Gameplay never waits for any of this.
 *   - Leaving the home page (a mode starts) fades the theme out over 0.6 s; the
 *     mode's start is not delayed. Coming back starts it again from the top
 *     with a fade-in. A hidden tab holds the theme and suspends the context;
 *     visible again, it continues where it was.
 *   - Settings: changes apply at once through the SoundSystem's music bus
 *     (volume, Mute Music, master, SOUND); muting or a volume of 0 stops the
 *     theme (nothing runs silently), unmuting starts it from the top.
 *   - A load or setup failure is 'unavailable', reported once (no console
 *     spam), and never disables the settings; PLAY MUSIC can retry the load.
 *
 * Statuses are truthful: 'playing' only while the context is running and the
 * player is scheduling.
 */
import type { AudioPrefs } from '../../persistence/saveData.ts';
import type { MusicContext, ThemePlayer, ThemeStats } from '../../audio/music/galaxiaTheme.ts';

export type MusicStatus = 'idle' | 'sound-off' | 'muted' | 'silent' | 'loading' | 'locked' | 'blocked' | 'playing' | 'paused' | 'unavailable';

export interface ThemeModule {
  createThemePlayer(ctx: MusicContext, out: unknown): ThemePlayer;
  musicSupported(ctx: unknown): boolean;
}

interface CtxLike {
  readonly state: string;
  resume(): Promise<void>;
  addEventListener?(type: 'statechange', fn: () => void): void;
  removeEventListener?(type: 'statechange', fn: () => void): void;
}

export interface TitleMusicDeps {
  readonly sound: {
    readonly unlocked: boolean;
    readonly isPaused: boolean;
    unlock(): void;
    pause(): void;
    resume(): void;
    musicOutput(): { readonly ctx: unknown; readonly bus: unknown } | null;
  };
  /** The saved audio preferences (committed values). */
  readonly prefs: () => AudioPrefs;
  /** Load the theme chunk (a dynamic import). */
  readonly load: () => Promise<ThemeModule>;
  /** True when the browser reports that audio may start without a gesture. */
  readonly autoplayAllowed?: () => boolean;
  readonly onChange?: (status: MusicStatus) => void;
}

export interface TitleMusicDebug {
  readonly status: MusicStatus;
  readonly visible: boolean;
  readonly hidden: boolean;
  readonly loaded: boolean;
  readonly loads: number;
  readonly failure: string | null;
  readonly gesture: boolean;
  readonly resumeRejected: boolean;
  readonly context: string;
  /** The music bus gain node's current value (the eased level), null before the context exists. */
  readonly bus: number | null;
  readonly listeners: number;
  readonly player: ThemeStats | null;
}

export interface TitleMusic {
  /** The home page is shown. */
  enter(): void;
  /** The home page is hidden (a mode starts): fade out, never block. */
  leave(): void;
  /** A real user gesture on the home page (pointerdown / keydown / PLAY MUSIC). */
  gesture(): void;
  /** The saved music settings changed. */
  prefsChanged(): void;
  /** The page became hidden / visible. */
  visibility(hidden: boolean): void;
  status(): MusicStatus;
  debug(): TitleMusicDebug;
}

/** navigator.getAutoplayPolicy('audiocontext') === 'allowed' (only some browsers have it). */
export function browserAllowsAutoplay(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  try {
    const f = (nav as { getAutoplayPolicy?: (t: string) => string } | undefined)?.getAutoplayPolicy;
    return typeof f === 'function' && f.call(nav, 'audiocontext') === 'allowed';
  } catch {
    return false;
  }
}

export function createTitleMusic(d: TitleMusicDeps): TitleMusic {
  let visible = false;
  let hidden = false;
  let mod: ThemeModule | null = null;
  let loading = false;
  let loads = 0;
  let failure: string | null = null;
  let player: ThemePlayer | null = null;
  let playerCtx: unknown = null;
  let gestured = false;
  let resumeRejected = false;
  /** The theme has played on this page: a later suspension is the browser / system pausing it, not autoplay. */
  let ran = false;
  let pausedByUs = false;
  let watched: CtxLike | null = null;
  let status: MusicStatus = 'idle';

  const onState = (): void => sync();
  const watch = (ctx: CtxLike | null): void => {
    if (watched === ctx) return;
    watched?.removeEventListener?.('statechange', onState);
    watched = ctx;
    watched?.addEventListener?.('statechange', onState);
  };

  const set = (s: MusicStatus): void => {
    if (s === status) return;
    status = s;
    d.onChange?.(s);
  };

  const off = (): MusicStatus | null => {
    const a = d.prefs();
    if (a.muted) return 'sound-off';
    if (a.musicMuted === true) return 'muted';
    if (!(a.music > 0) || !(a.master > 0)) return 'silent';
    return null;
  };

  function stopPlayer(fade?: number): void {
    if (!player) return;
    try {
      player.stop(fade);
    } catch {
      /* already torn down */
    }
  }

  function fail(why: string): void {
    failure = why;
    stopPlayer(0);
  }

  function load(): void {
    if (loading || mod) return;
    loading = true;
    loads += 1;
    d.load().then(
      (m) => {
        loading = false;
        mod = m;
        sync(); // a stale result is harmless: sync starts nothing unless the home page still wants music
      },
      () => {
        loading = false;
        fail('load');
        sync();
      },
    );
  }

  function sync(): void {
    const why = !visible ? 'idle' : off();
    if (why) {
      stopPlayer(why === 'idle' ? undefined : 0.3);
      set(why);
      return;
    }
    if (hidden) {
      player?.hold();
      set('paused');
      return;
    }
    if (failure) {
      set('unavailable');
      return;
    }
    if (!mod) {
      load();
      set('loading');
      return;
    }
    if (!d.sound.unlocked && !gestured && d.autoplayAllowed?.()) d.sound.unlock();
    const out = d.sound.musicOutput();
    if (!out) {
      // no context: before a gesture that is the autoplay rule; after one, Web Audio is missing
      set(gestured ? 'unavailable' : 'locked');
      return;
    }
    const ctx = out.ctx as CtxLike;
    if (!mod.musicSupported(ctx)) {
      fail('unsupported');
      set('unavailable');
      return;
    }
    watch(ctx);
    if (ctx.state !== 'running') {
      player?.hold();
      set(gestured || resumeRejected || ran ? 'blocked' : 'locked');
      return;
    }
    try {
      if (!player || playerCtx !== ctx) {
        player?.dispose();
        player = mod.createThemePlayer(ctx as unknown as MusicContext, out.bus);
        playerCtx = ctx;
      }
      if (!player.stats().playing) player.start();
      player.release();
    } catch {
      fail('setup');
      set('unavailable');
      return;
    }
    ran = true;
    set('playing');
  }

  return {
    enter() {
      visible = true;
      sync();
    },
    leave() {
      visible = false;
      watch(null);
      if (pausedByUs) {
        pausedByUs = false;
        d.sound.resume(); // never hand a mode a context suspended by the home page
      }
      sync();
    },
    gesture() {
      if (!visible) return;
      gestured = true;
      if (failure === 'load') failure = null; // PLAY MUSIC retries a failed load (one try per press, no loop)
      if (!off() && !hidden) {
        d.sound.unlock();
        const ctx = d.sound.musicOutput()?.ctx as CtxLike | undefined;
        if (ctx && ctx.state !== 'running' && !d.sound.isPaused) {
          try {
            ctx.resume().then(
              () => {
                resumeRejected = false;
                sync();
              },
              () => {
                resumeRejected = true;
                sync();
              },
            );
          } catch {
            resumeRejected = true;
          }
        }
      }
      sync();
    },
    prefsChanged() {
      sync();
    },
    visibility(h) {
      if (h === hidden) return;
      hidden = h;
      if (visible) {
        if (h && player?.stats().playing && !d.sound.isPaused) {
          player.hold();
          d.sound.pause();
          pausedByUs = true;
        } else if (!h && pausedByUs) {
          pausedByUs = false;
          d.sound.resume();
        }
      }
      sync();
    },
    status: () => status,
    debug() {
      return {
        status,
        visible,
        hidden,
        loaded: mod !== null,
        loads,
        failure,
        gesture: gestured,
        resumeRejected,
        context: (d.sound.musicOutput()?.ctx as CtxLike | undefined)?.state ?? 'none',
        bus: (d.sound.musicOutput()?.bus as { gain?: { value?: number } } | undefined)?.gain?.value ?? null,
        listeners: watched ? 1 : 0,
        player: player ? player.stats() : null,
      };
    },
  };
}
