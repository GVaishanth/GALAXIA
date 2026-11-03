/**
 * Finale P2: the home-page music director (shared/audio/titleMusic.ts), the
 * Music Volume / Mute Music preferences, and the SoundSystem's music bus.
 * Fakes: a sound service with a scriptable AudioContext (autoplay allowed,
 * suspended, resume rejected, no Web Audio), a fake theme module and player,
 * and an in-memory store. No timers, no polling: promises are flushed.
 */
import { describe, expect, it } from 'vitest';
import { browserAllowsAutoplay, createTitleMusic, type MusicStatus, type ThemeModule } from '../src/shared/audio/titleMusic.ts';
import { DEFAULT_SAVE, sanitizeV1, type AudioPrefs } from '../src/persistence/saveData.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import { PREFS_SPEC, PreferencesStore } from '../src/shared/persistence/preferences.ts';
import { SoundSystem, type AudioContextLike, type BufferLike, type GainNodeLike, type SourceLike } from '../src/audio/soundSystem.ts';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/* ---- fakes for the director ---- */

class DirCtx {
  state: 'suspended' | 'running' | 'closed';
  resumes = 0;
  listeners = new Set<() => void>();
  private readonly onResume: 'ok' | 'reject' | 'stay';
  constructor(state: 'suspended' | 'running', onResume: 'ok' | 'reject' | 'stay') {
    this.state = state;
    this.onResume = onResume;
  }
  resume(): Promise<void> {
    this.resumes += 1;
    if (this.onResume === 'reject') return Promise.reject(new Error('NotAllowedError'));
    if (this.onResume === 'stay') return Promise.resolve();
    return Promise.resolve().then(() => this.to('running'));
  }
  to(s: 'suspended' | 'running'): void {
    if (this.state === s) return;
    this.state = s;
    for (const l of [...this.listeners]) l();
  }
  addEventListener(_t: string, fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_t: string, fn: () => void): void {
    this.listeners.delete(fn);
  }
}

interface Opts {
  readonly prefs?: Partial<AudioPrefs>;
  readonly autoplay?: boolean;
  /** the state of a context created by unlock() */
  readonly created?: 'suspended' | 'running';
  readonly resume?: 'ok' | 'reject' | 'stay';
  readonly noAudio?: boolean;
  readonly loadFails?: number;
  readonly setupThrows?: boolean;
  readonly unsupported?: boolean;
}

function rig(o: Opts = {}) {
  const store = new MemoryStore();
  const prefs = new PreferencesStore(store);
  if (o.prefs) prefs.setAudio(o.prefs);
  let ctx: DirCtx | null = null;
  const sound = {
    unlocks: 0,
    pauses: 0,
    resumes: 0,
    isPaused: false,
    get unlocked() {
      return ctx !== null;
    },
    unlock() {
      this.unlocks += 1;
      if (!ctx && !o.noAudio) ctx = new DirCtx(o.created ?? 'running', o.resume ?? 'ok');
      // like SoundSystem.unlock: resume a suspended context (fire and forget)
      if (ctx && !this.isPaused && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    },
    pause() {
      this.pauses += 1;
      this.isPaused = true;
      ctx?.to('suspended');
    },
    resume() {
      this.resumes += 1;
      this.isPaused = false;
      ctx?.to('running');
    },
    musicOutput() {
      return ctx ? { ctx, bus: { id: 'music-bus' } } : null;
    },
  };
  const players: { starts: number; stops: (number | undefined)[]; holds: number; releases: number; disposed: number; playing: boolean }[] = [];
  let loads = 0;
  const mod: ThemeModule = {
    musicSupported: () => !o.unsupported,
    createThemePlayer: () => {
      if (o.setupThrows) throw new Error('setup failed');
      const p = { starts: 0, stops: [] as (number | undefined)[], holds: 0, releases: 0, disposed: 0, playing: false };
      players.push(p);
      return {
        start: () => {
          if (p.playing) return false;
          p.starts += 1;
          p.playing = true;
          return true;
        },
        stop: (f?: number) => {
          p.stops.push(f);
          p.playing = false;
        },
        hold: () => void (p.holds += 1),
        release: () => void (p.releases += 1),
        dispose: () => void (p.disposed += 1),
        stats: () => ({ playing: p.playing }) as never,
      };
    },
  };
  const changes: MusicStatus[] = [];
  const music = createTitleMusic({
    sound,
    prefs: () => prefs.get().audio,
    load: () => {
      loads += 1;
      return loads <= (o.loadFails ?? 0) ? Promise.reject(new Error('offline')) : Promise.resolve(mod);
    },
    autoplayAllowed: () => o.autoplay === true,
    onChange: (s) => changes.push(s),
  });
  return { music, sound, prefs, store, players, changes, loads: () => loads, ctx: () => ctx };
}

describe('home-page music: autoplay and start', () => {
  it('available: where the browser reports autoplay allowed, the theme starts when the home page shows (no gesture needed)', async () => {
    const r = rig({ autoplay: true });
    r.music.enter();
    expect(r.music.status()).toBe('loading');
    await flush();
    expect(r.music.status()).toBe('playing');
    expect(r.players).toHaveLength(1);
    expect(r.players[0]!.starts).toBe(1);
    expect(r.loads()).toBe(1);
  });

  it('blocked by autoplay rules: no AudioContext before a gesture; PLAY MUSIC (a gesture) starts it', async () => {
    const r = rig();
    r.music.enter();
    await flush();
    expect(r.music.status()).toBe('locked');
    expect(r.sound.unlocks).toBe(0);
    expect(r.ctx()).toBeNull();
    expect(r.players).toHaveLength(0);
    r.music.gesture();
    await flush();
    expect(r.music.status()).toBe('playing');
    expect(r.players[0]!.starts).toBe(1);
  });

  it('a context created suspended: blocked until resume() resolves, then playing (one start)', async () => {
    const r = rig({ created: 'suspended', resume: 'ok' });
    r.music.enter();
    await flush();
    r.music.gesture();
    expect(r.music.status()).toBe('blocked');
    await flush();
    expect(r.music.status()).toBe('playing');
    expect(r.players[0]!.starts).toBe(1);
  });

  it('resume rejected: truthfully blocked, no retry loop (one resume per press), the next press tries again', async () => {
    const r = rig({ created: 'suspended', resume: 'reject' });
    r.music.enter();
    await flush();
    r.music.gesture();
    await flush();
    expect(r.music.status()).toBe('blocked');
    const after = r.ctx()!.resumes;
    await flush();
    await flush();
    expect(r.ctx()!.resumes).toBe(after); // nothing retries on its own
    expect(r.players).toHaveLength(0);
    r.music.gesture();
    await flush();
    expect(r.ctx()!.resumes).toBeGreaterThan(after);
    expect(r.music.status()).toBe('blocked');
    expect(r.music.debug().resumeRejected).toBe(true);
  });

  it('a context suspended while playing (the system took audio): blocked and held; running again: continues, no second start', async () => {
    const r = rig({ autoplay: true });
    r.music.enter();
    await flush();
    r.ctx()!.to('suspended');
    expect(r.music.status()).toBe('blocked');
    expect(r.players[0]!.holds).toBeGreaterThan(0);
    r.ctx()!.to('running');
    expect(r.music.status()).toBe('playing');
    expect(r.players[0]!.starts).toBe(1);
  });

  it('no Web Audio: a gesture creates no context -> unavailable; the settings still save', async () => {
    const r = rig({ noAudio: true });
    r.music.enter();
    await flush();
    expect(r.music.status()).toBe('locked');
    r.music.gesture();
    expect(r.music.status()).toBe('unavailable');
    expect(r.prefs.setAudio({ music: 0.3, musicMuted: true })).toBe(true);
    r.music.prefsChanged();
    expect(r.prefs.get().audio).toMatchObject({ music: 0.3, musicMuted: true });
    expect(r.music.status()).toBe('muted');
  });

  it('setup failed (the player throws) and a context without the node types: unavailable, no throw, settings unaffected', async () => {
    const a = rig({ autoplay: true, setupThrows: true });
    a.music.enter();
    await flush();
    expect(a.music.status()).toBe('unavailable');
    expect(a.music.debug().failure).toBe('setup');
    expect(() => a.music.prefsChanged()).not.toThrow();
    const b = rig({ autoplay: true, unsupported: true });
    b.music.enter();
    await flush();
    expect(b.music.status()).toBe('unavailable');
    expect(b.music.debug().failure).toBe('unsupported');
  });

  it('the chunk fails to load (offline): unavailable once, no automatic retry; PLAY MUSIC retries (one load per press)', async () => {
    const r = rig({ autoplay: true, loadFails: 1 });
    r.music.enter();
    await flush();
    expect(r.music.status()).toBe('unavailable');
    expect(r.loads()).toBe(1);
    await flush();
    expect(r.loads()).toBe(1);
    r.music.gesture();
    await flush();
    expect(r.loads()).toBe(2);
    expect(r.music.status()).toBe('playing');
  });
});

describe('home-page music: settings and mute', () => {
  it('muted on the first visit: nothing loads, nothing plays, a gesture does not start it', async () => {
    const r = rig({ prefs: { musicMuted: true }, autoplay: true });
    r.music.enter();
    r.music.gesture();
    await flush();
    expect(r.music.status()).toBe('muted');
    expect(r.loads()).toBe(0);
    expect(r.players).toHaveLength(0);
  });

  it('unmute starts the theme from the top; mute stops it (short fade); the volume is kept throughout', async () => {
    const r = rig({ prefs: { musicMuted: true, music: 0.45 }, autoplay: true });
    r.music.enter();
    await flush();
    r.prefs.setAudio({ musicMuted: false });
    r.music.prefsChanged();
    await flush();
    expect(r.music.status()).toBe('playing');
    r.prefs.setAudio({ musicMuted: true });
    r.music.prefsChanged();
    expect(r.music.status()).toBe('muted');
    expect(r.players[0]!.stops.at(-1)).toBe(0.3);
    expect(r.prefs.get().audio.music).toBe(0.45);
    r.prefs.setAudio({ musicMuted: false });
    r.music.prefsChanged();
    expect(r.players[0]!.starts).toBe(2);
  });

  it('volume while playing does not restart or rebuild; volume while muted is saved and stays silent', async () => {
    const r = rig({ autoplay: true });
    r.music.enter();
    await flush();
    r.prefs.setAudio({ music: 0.2 });
    r.music.prefsChanged();
    expect(r.players).toHaveLength(1);
    expect(r.players[0]!.starts).toBe(1);
    r.prefs.setAudio({ musicMuted: true });
    r.music.prefsChanged();
    r.prefs.setAudio({ music: 0.9 });
    r.music.prefsChanged();
    expect(r.music.status()).toBe('muted');
    expect(r.prefs.get().audio).toMatchObject({ music: 0.9, musicMuted: true });
  });

  it('a volume of 0 is silent, not muted: the theme stops, Mute Music is untouched; raising it starts again', async () => {
    const r = rig({ autoplay: true });
    r.music.enter();
    await flush();
    r.prefs.setAudio({ music: 0 });
    r.music.prefsChanged();
    expect(r.music.status()).toBe('silent');
    expect(r.prefs.get().audio.musicMuted).toBe(false);
    r.prefs.setAudio({ music: 0.05 });
    r.music.prefsChanged();
    expect(r.music.status()).toBe('playing');
  });

  it('SOUND off (all audio) is its own state; blocked is never reported as muted', async () => {
    const r = rig({ prefs: { muted: true } });
    r.music.enter();
    await flush();
    expect(r.music.status()).toBe('sound-off');
    const b = rig();
    b.music.enter();
    await flush();
    expect(b.music.status()).toBe('locked');
    expect(b.prefs.get().audio.musicMuted).toBe(false);
  });

  it('mute stays effective when the context resumes later (no auto-unmute)', async () => {
    const r = rig({ created: 'suspended', resume: 'stay' });
    r.music.enter();
    await flush();
    r.music.gesture();
    r.prefs.setAudio({ musicMuted: true });
    r.music.prefsChanged();
    r.ctx()!.to('running');
    await flush();
    expect(r.music.status()).toBe('muted');
    expect(r.players.every((p) => !p.playing)).toBe(true);
  });
});

describe('home-page music: lifecycle', () => {
  it('entering gameplay fades it out (0.6 s default) at once; returning home starts it again from the top', async () => {
    const r = rig({ autoplay: true });
    r.music.enter();
    await flush();
    r.music.leave();
    expect(r.music.status()).toBe('idle');
    expect(r.players[0]!.stops.at(-1)).toBeUndefined(); // the player's default fade-out
    r.music.enter();
    expect(r.music.status()).toBe('playing');
    expect(r.players[0]!.starts).toBe(2);
    expect(r.players).toHaveLength(1); // the same player and graph, reused
  });

  it('repeated game entry and rapid transitions: never two starts without a stop, one player, no listener leak', async () => {
    const r = rig({ autoplay: true });
    for (let i = 0; i < 25; i++) {
      r.music.enter();
      if (i % 2) await flush();
      r.music.leave();
    }
    await flush();
    expect(r.music.status()).toBe('idle');
    expect(r.players.length).toBeLessThanOrEqual(1);
    for (const p of r.players) expect(p.playing).toBe(false);
    expect(r.music.debug().listeners).toBe(0);
    expect(r.ctx()?.listeners.size ?? 0).toBe(0);
  });

  it('leaving before the chunk arrives: the late load starts nothing', async () => {
    const r = rig({ autoplay: true });
    r.music.enter();
    r.music.leave();
    await flush();
    expect(r.music.status()).toBe('idle');
    expect(r.players).toHaveLength(0);
  });

  it('gameplay before music: a player who leaves before any gesture creates nothing; a deep link never loads it', async () => {
    const r = rig();
    r.music.enter();
    r.music.leave();
    await flush();
    expect(r.ctx()).toBeNull();
    expect(r.players).toHaveLength(0);
    const deep = rig();
    expect(deep.loads()).toBe(0); // the home page never showed
    expect(deep.music.status()).toBe('idle');
  });

  it('hidden tab: holds and suspends; visible: resumes in place; leaving while hidden never hands a mode a suspended context', async () => {
    const r = rig({ autoplay: true });
    r.music.enter();
    await flush();
    r.music.visibility(true);
    expect(r.music.status()).toBe('paused');
    expect(r.sound.pauses).toBe(1);
    expect(r.players[0]!.holds).toBeGreaterThan(0);
    r.music.visibility(false);
    expect(r.music.status()).toBe('playing');
    expect(r.sound.resumes).toBe(1);
    expect(r.players[0]!.starts).toBe(1);
    r.music.visibility(true);
    r.music.leave();
    expect(r.sound.isPaused).toBe(false);
    expect(r.sound.resumes).toBe(2);
  });

  it('gestures off the home page do nothing', async () => {
    const r = rig();
    r.music.gesture();
    await flush();
    expect(r.sound.unlocks).toBe(0);
    expect(r.music.status()).toBe('idle');
  });

  it('autoplay detection reads navigator.getAutoplayPolicy only where it exists, and never throws', () => {
    expect(browserAllowsAutoplay({ getAutoplayPolicy: (t: string) => (t === 'audiocontext' ? 'allowed' : 'disallowed') })).toBe(true);
    expect(browserAllowsAutoplay({ getAutoplayPolicy: () => 'allowed-muted' })).toBe(false);
    expect(browserAllowsAutoplay({})).toBe(false);
    expect(browserAllowsAutoplay(undefined)).toBe(false);
    expect(
      browserAllowsAutoplay({
        getAutoplayPolicy: () => {
          throw new Error('x');
        },
      }),
    ).toBe(false);
  });
});

/* ---- preferences ---- */

describe('Music Volume and Mute Music preferences (galaxia:prefs, no version bump)', () => {
  it('documented defaults: music volume 0.7 (70 %), Mute Music off; the prefs schema stays at version 1', () => {
    expect(DEFAULT_SAVE.audio).toEqual({ muted: false, master: 0.8, sfx: 1, music: 0.7, musicMuted: false });
    expect(PREFS_SPEC.version).toBe(1);
  });

  it('a legacy profile (no musicMuted) loads unchanged, reads Mute Music off, and is not marked repaired', () => {
    const legacy = sanitizeV1({ version: 1, highScore: 0, bestStage: 1, audio: { muted: false, master: 0.6, sfx: 0.4, music: 0.3 }, display: {} });
    expect(legacy.data.audio).toEqual({ muted: false, master: 0.6, sfx: 0.4, music: 0.3, musicMuted: false });
    const store = new MemoryStore();
    store.write('galaxia:prefs', JSON.stringify({ version: 1, audio: { muted: false, master: 0.6, sfx: 0.4, music: 0.3 }, display: { glow: false, pixelPerfect: true, reducedMotion: 'on', arcadeDisplay: true } }));
    const p = new PreferencesStore(store);
    expect(p.get().audio).toEqual({ muted: false, master: 0.6, sfx: 0.4, music: 0.3, musicMuted: false });
    expect(p.get().display).toMatchObject({ glow: false, pixelPerfect: true, reducedMotion: 'on', arcadeDisplay: true });
    expect(p.backedUp).toBe(false);
  });

  it('malformed values fall back to the defaults (repaired), the valid neighbours survive', () => {
    for (const bad of ['yes', 1, null, {}]) {
      const r = sanitizeV1({ audio: { muted: false, master: 0.5, sfx: 0.5, music: 0.25, musicMuted: bad } });
      expect(r.data.audio).toMatchObject({ musicMuted: false, music: 0.25, master: 0.5 });
      expect(r.repaired).toBe(true);
    }
    for (const bad of [-0.1, 1.5, Number.NaN, '50', null]) {
      const r = sanitizeV1({ audio: { muted: false, master: 0.5, sfx: 0.5, music: bad, musicMuted: true } });
      expect(r.data.audio).toMatchObject({ music: DEFAULT_SAVE.audio.music, musicMuted: true });
      expect(r.repaired).toBe(true);
    }
  });

  it('zero is a valid volume (kept, not replaced by the default); 1 is the top', () => {
    expect(sanitizeV1({ audio: { music: 0 } }).data.audio.music).toBe(0);
    expect(sanitizeV1({ audio: { music: 1 } }).data.audio.music).toBe(1);
  });

  it('both persist independently across a reload and never reset the other settings', () => {
    const store = new MemoryStore();
    const a = new PreferencesStore(store);
    a.setAudio({ master: 0.4, sfx: 0.6 });
    a.setDisplay({ glow: false, reducedMotion: 'on' });
    a.setAudio({ musicMuted: true });
    a.setAudio({ music: 0.35 });
    const b = new PreferencesStore(store); // a reload
    expect(b.get().audio).toEqual({ muted: false, master: 0.4, sfx: 0.6, music: 0.35, musicMuted: true });
    expect(b.get().display).toMatchObject({ glow: false, reducedMotion: 'on' });
    b.setAudio({ musicMuted: false });
    const c = new PreferencesStore(store);
    expect(c.get().audio).toEqual({ muted: false, master: 0.4, sfx: 0.6, music: 0.35, musicMuted: false });
  });

  it('a route change or reload never unmutes: only an explicit change does', () => {
    const store = new MemoryStore();
    new PreferencesStore(store).setAudio({ musicMuted: true });
    for (let i = 0; i < 3; i++) expect(new PreferencesStore(store).get().audio.musicMuted).toBe(true);
  });
});

/* ---- the SoundSystem music bus ---- */

class Param {
  value = 1;
  targets: number[] = [];
  setTargetAtTime(v: number) {
    this.targets.push(v);
    this.value = v;
  }
}
class Ctx implements AudioContextLike {
  state = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = {};
  gains: { gain: Param }[] = [];
  sources = 0;
  createGain(): GainNodeLike {
    const g = { gain: new Param(), connect: () => undefined };
    this.gains.push(g);
    return g;
  }
  createBuffer(_c: number, length: number, rate: number): BufferLike {
    return { duration: length / rate, copyToChannel: () => undefined };
  }
  createBufferSource(): SourceLike {
    this.sources += 1;
    return { buffer: null, loop: false, onended: null, start: () => undefined, stop: () => undefined, connect: () => undefined };
  }
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
}

describe('SoundSystem: Mute Music is the music bus only', () => {
  const base: AudioPrefs = { muted: false, master: 0.8, sfx: 1, music: 0.7, musicMuted: false };
  const make = () => {
    const ctx = new Ctx();
    const sys = new SoundSystem(() => ctx, base);
    sys.unlock();
    // gains: [master, sfx, music] (creation order in unlock)
    return { ctx, sys, master: ctx.gains[0]!.gain, sfx: ctx.gains[1]!.gain, music: ctx.gains[2]!.gain };
  };

  it('mutes the music bus (theme and jingles), never the effects or the master', () => {
    const { sys, master, sfx, music } = make();
    sys.setPrefs({ ...base, musicMuted: true });
    expect(music.value).toBe(0);
    expect(sfx.value).toBe(1);
    expect(master.value).toBe(0.8);
    expect(sys.busGain('music')).toBe(0);
    expect(sys.busGain('sfx')).toBeCloseTo(0.8, 9);
    expect(sys.play('stageStart')).toBe(false); // a music-bus jingle
    expect(sys.play('shot')).toBe(true); // an effect
  });

  it('unmute restores the kept volume exactly; volume changes while muted are kept', () => {
    const { sys, music } = make();
    sys.setPrefs({ ...base, musicMuted: true, music: 0.4 });
    expect(music.value).toBe(0);
    sys.setPrefs({ ...base, musicMuted: false, music: 0.4 });
    expect(music.value).toBe(0.4);
    expect(sys.busGain('music')).toBeCloseTo(0.32, 9);
  });

  it('after unlock, changes ease (setTargetAtTime: no zipper noise); the first levels at unlock are exact', () => {
    const { sys, music } = make();
    expect(music.targets).toEqual([]); // unlock set .value directly
    expect(music.value).toBe(0.7);
    sys.setPrefs({ ...base, music: 0.2 });
    expect(music.targets).toEqual([0.2]);
  });

  it('a profile without musicMuted (older shape) plays music as before', () => {
    const ctx = new Ctx();
    const sys = new SoundSystem(() => ctx, { muted: false, master: 1, sfx: 1, music: 0.5 });
    sys.unlock();
    expect(sys.busGain('music')).toBe(0.5);
  });

  it('musicOutput(): null before unlock; afterwards the one context and the music bus (no second context)', () => {
    let created = 0;
    const ctx = new Ctx();
    const sys = new SoundSystem(() => {
      created += 1;
      return ctx;
    }, base);
    expect(sys.musicOutput()).toBeNull();
    sys.unlock();
    const out = sys.musicOutput()!;
    expect(out.ctx).toBe(ctx);
    expect(out.bus).toBe(ctx.gains[2]);
    sys.unlock();
    expect(created).toBe(1);
  });
});
