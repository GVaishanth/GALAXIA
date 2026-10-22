/**
 * Stage 4 audio: offline synth, event cue map, and the Web Audio wrapper
 * (driven through a fake AudioContext): autoplay lock, mute, volume, voice
 * limits, loops, pause, and persisted preferences.
 */
import { describe, expect, it } from 'vitest';
import { cuesForGameEvent, cuesForRewardEvent } from '../src/audio/cues.ts';
import { SoundSystem, type AudioContextLike, type BufferLike, type GainNodeLike, type SourceLike } from '../src/audio/soundSystem.ts';
import { recipeDurationMs, renderSound } from '../src/audio/synth.ts';
import { noteHz, SOUNDS, type SoundId, type SoundRecipe } from '../src/config/audio.ts';
import { DEFAULT_SAVE, SaveManager, type AudioPrefs } from '../src/persistence/saveData.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const IDS = Object.keys(SOUNDS) as SoundId[];

class FakeSource implements SourceLike {
  buffer: BufferLike | null = null;
  loop = false;
  onended: (() => void) | null = null;
  started = 0;
  stopped = 0;
  connect(): void {}
  disconnect(): void {}
  start(): void {
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
}

class FakeCtx implements AudioContextLike {
  state = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = {};
  sources: FakeSource[] = [];
  gains: GainNodeLike[] = [];
  suspends = 0;
  resumes = 0;
  createGain(): GainNodeLike {
    const g = { gain: { value: 1 }, connect: () => undefined };
    this.gains.push(g);
    return g;
  }
  createBuffer(_c: number, length: number, rate: number): BufferLike {
    return { duration: length / rate, copyToChannel: () => undefined };
  }
  createBufferSource(): SourceLike {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  resume(): Promise<void> {
    this.resumes += 1;
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspends += 1;
    this.state = 'suspended';
    return Promise.resolve();
  }
}

function system(prefs: Partial<AudioPrefs> = {}): { sys: SoundSystem; ctx: FakeCtx; created: () => number } {
  const ctx = new FakeCtx();
  let created = 0;
  const sys = new SoundSystem(
    () => {
      created += 1;
      return ctx;
    },
    { ...DEFAULT_SAVE.audio, ...prefs },
  );
  return { sys, ctx, created: () => created };
}

describe('synth', () => {
  it.each(IDS)('%s renders finite samples within [-1, 1]', (id) => {
    const r = SOUNDS[id] as SoundRecipe;
    const s = renderSound(r, 8000);
    expect(s.length).toBe(Math.max(1, Math.round((recipeDurationMs(r) / 1000) * 8000)));
    let peak = 0;
    for (const v of s) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.01); // audible
    if (!r.loop) {
      expect(s[0]).toBe(0); // click-free start
      expect(Math.abs(s[s.length - 1]!)).toBeLessThan(0.02); // and end
    }
  });

  it('is deterministic (seeded noise)', () => {
    const a = renderSound(SOUNDS.enemyBoom as SoundRecipe, 8000);
    const b = renderSound(SOUNDS.enemyBoom as SoundRecipe, 8000);
    expect(a).toEqual(b);
  });

  it('keeps one-shots short and loops seamless (whole cycles per loop)', () => {
    for (const id of IDS) {
      const r = SOUNDS[id] as SoundRecipe;
      if (r.loop) {
        const sec = (r.loopMs ?? 0) / 1000;
        for (const v of r.voices) {
          expect(Math.abs(v.f0 * sec - Math.round(v.f0 * sec)), `${id} f0`).toBeLessThan(1e-9);
          if (v.vibHz) expect(Math.abs(v.vibHz * sec - Math.round(v.vibHz * sec)), `${id} vib`).toBeLessThan(1e-9);
          expect(v.f1, `${id} loops must not sweep`).toBeUndefined();
        }
      } else expect(recipeDurationMs(r), id).toBeLessThan(2000);
    }
  });

  it('noteHz uses equal temperament', () => {
    expect(noteHz('A4')).toBe(440);
    expect(noteHz('A5')).toBeCloseTo(880, 6);
    expect(noteHz('C4')).toBeCloseTo(261.6256, 3);
    expect(() => noteHz('H2')).toThrow();
  });
});

describe('cue map', () => {
  it('maps every required moment to a sound', () => {
    const play = (e: Parameters<typeof cuesForGameEvent>[0]): string[] => cuesForGameEvent(e).map((c) => (c.kind === 'play' ? c.sound : c.kind));
    expect(play({ type: 'playerShot', x: 0, y: 0 })).toEqual(['shot']);
    expect(play({ type: 'enemyDestroyed', id: 'a', kind: 'scout', x: 0, y: 0 })).toEqual(['enemyBoom']);
    expect(play({ type: 'enemyDestroyed', id: 'a', kind: 'commander', x: 0, y: 0 })).toEqual(['bossBoom']);
    expect(play({ type: 'playerDestroyed', x: 0, y: 0, dualHalf: false })).toEqual(['playerBoom']);
    expect(play({ type: 'beamStarted', captorId: 'c' })).toEqual(['loopStart']);
    expect(play({ type: 'beamEnded', captorId: 'c', captured: true })).toEqual(['loopStop']);
    expect(play({ type: 'captiveFreed', fighterId: 'f' })).toEqual(['rescueFree']);
    expect(play({ type: 'dualFighterFormed', fighterId: 'f' })).toEqual(['dual']);
    expect(play({ type: 'stageStarted', stage: 1, challenge: false })).toEqual(['stageStart']);
    expect(play({ type: 'stageStarted', stage: 3, challenge: true })).toEqual(['challengeStart']);
    expect(play({ type: 'stageCleared', stage: 1 })).toEqual(['stageClear']);
    expect(play({ type: 'gameOver' })).toEqual(['stopLoops', 'gameOver']);
    expect(play({ type: 'phaseChanged', from: 'paused', to: 'title' })).toEqual(['stopLoops']);
    expect(play({ type: 'enemyShot', x: 0, y: 0 })).toEqual([]);
  });

  it('beam loops are keyed per captor', () => {
    const start = cuesForGameEvent({ type: 'beamStarted', captorId: 'e7' })[0]!;
    const stop = cuesForGameEvent({ type: 'beamEnded', captorId: 'e7', captured: false })[0]!;
    expect(start.kind === 'loopStart' && stop.kind === 'loopStop' && start.key === stop.key).toBe(true);
  });

  it('maps bonus completion and extra lives', () => {
    const s = (e: Parameters<typeof cuesForRewardEvent>[0]): string[] => cuesForRewardEvent(e).map((c) => (c.kind === 'play' ? c.sound : c.kind));
    expect(s({ type: 'extraLifeAwarded', index: 0, threshold: 20000, reserves: 3, nextThreshold: 70000 })).toEqual(['extraLife']);
    expect(s({ type: 'transformGroupCleared', groupId: 'g', transformKind: 'stinger', bonus: 1000 })).toEqual(['bonus']);
    expect(s({ type: 'challengeStageResult', stage: 3, challengeNumber: 1, hits: 40, total: 40, perfect: true, perHitBonus: 100, perfectBonus: 10000, bonus: 10000 })).toEqual(['perfect']);
    expect(s({ type: 'challengeStageResult', stage: 3, challengeNumber: 1, hits: 0, total: 40, perfect: false, perHitBonus: 100, perfectBonus: 10000, bonus: 0 })).toEqual([]);
  });
});

describe('SoundSystem', () => {
  it('creates no audio context and plays nothing before a user gesture unlocks it', () => {
    const { sys, ctx, created } = system();
    for (const id of IDS) sys.play(id);
    sys.startLoop('beam:x', 'beam');
    expect(created()).toBe(0);
    expect(ctx.sources).toHaveLength(0);
    expect(sys.unlocked).toBe(false);
    expect(sys.stats().skipped).toBeGreaterThan(0);
    sys.unlock();
    sys.unlock();
    expect(created()).toBe(1);
    expect(sys.play('shot')).toBe(true);
    expect(ctx.sources[0]!.started).toBe(1);
  });

  it('stays silent (no throw) when the browser has no Web Audio', () => {
    const sys = new SoundSystem(() => {
      throw new Error('unsupported');
    }, DEFAULT_SAVE.audio);
    expect(() => sys.unlock()).not.toThrow();
    expect(sys.play('shot')).toBe(false);
  });

  it('mute: master gain 0 and no new voices; volumes clamp to 0..1', () => {
    const { sys, ctx } = system();
    sys.unlock();
    sys.setPrefs({ muted: true, master: 0.8, sfx: 1, music: 1 });
    expect(ctx.gains[0]!.gain.value).toBe(0);
    expect(sys.play('shot')).toBe(false);
    sys.setPrefs({ muted: false, master: 7, sfx: -1, music: Number.NaN });
    expect(ctx.gains[0]!.gain.value).toBe(1);
    expect(sys.busGain('sfx')).toBe(0);
    expect(sys.busGain('music')).toBe(0);
    expect(sys.play('shot')).toBe(false); // effects bus at 0
  });

  it('limits voices per sound (stealing the oldest) and skips rapid repeats', () => {
    const { sys, ctx } = system();
    sys.unlock();
    const max = (SOUNDS.enemyBoom as SoundRecipe).maxVoices;
    for (let i = 0; i < max + 3; i++) {
      ctx.currentTime += 0.03; // past minGapMs
      sys.play('enemyBoom');
    }
    expect(ctx.sources.filter((s) => s.stopped > 0).length).toBe(3);
    expect(sys.stats().active).toBe(max);
    const before = ctx.sources.length;
    sys.play('enemyBoom'); // same instant: inside minGapMs
    expect(ctx.sources.length).toBe(before);
  });

  it('plays one jingle at a time on the music bus', () => {
    const { sys, ctx } = system();
    sys.unlock();
    expect(sys.play('perfect')).toBe(true);
    expect(sys.play('stageClear')).toBe(false);
    ctx.currentTime += 5;
    expect(sys.play('stageClear')).toBe(true);
  });

  it('loops start once per key and always stop', () => {
    const { sys, ctx } = system();
    sys.unlock();
    expect(sys.startLoop('beam:a', 'beam')).toBe(true);
    expect(sys.startLoop('beam:a', 'beam')).toBe(false);
    sys.startLoop('beam:b', 'beam');
    expect(ctx.sources.every((s) => s.loop)).toBe(true);
    sys.stopLoop('beam:a');
    expect(sys.stats().loops).toBe(1);
    sys.handle({ kind: 'stopLoops' });
    expect(sys.stats().loops).toBe(0);
    expect(ctx.sources.every((s) => s.stopped === 1)).toBe(true);
    expect(sys.play('beam')).toBe(false); // loops cannot be fired as one-shots
  });

  it('pause suspends the context and blocks new sounds; resume restores', () => {
    const { sys, ctx } = system();
    sys.unlock();
    sys.pause();
    expect(ctx.suspends).toBe(1);
    expect(sys.play('shot')).toBe(false);
    sys.unlock(); // a key press while paused must not wake audio
    expect(ctx.state).toBe('suspended');
    sys.resume();
    expect(ctx.state).toBe('running');
    expect(sys.play('shot')).toBe(true);
  });

  it('renders each buffer once and reuses it', () => {
    const { sys, ctx } = system();
    sys.unlock();
    for (let i = 0; i < 5; i++) {
      ctx.currentTime += 1;
      sys.play('shot');
    }
    expect(sys.stats().buffers).toBe(1);
    expect(new Set(ctx.sources.map((s) => s.buffer)).size).toBe(1);
  });
});

describe('audio preferences persistence', () => {
  it('persists mute and volumes across reloads; invalid volumes fall back to defaults', () => {
    const store = new MemoryStore();
    const a = new SaveManager(store);
    a.setAudio({ muted: true, master: 0.35, sfx: 0.5 });
    a.setAudio({ music: -2 });
    const b = new SaveManager(store);
    expect(b.get().audio).toEqual({ muted: true, master: 0.35, sfx: 0.5, music: DEFAULT_SAVE.audio.music });
  });

  it('display prefs (glow, reduced motion) persist and reject invalid values', () => {
    const store = new MemoryStore();
    const a = new SaveManager(store);
    a.setDisplay({ reducedMotion: 'on', glow: false });
    a.setDisplay({ reducedMotion: 'sideways' as never });
    const b = new SaveManager(store);
    expect(b.get().display.glow).toBe(false);
    expect(['system', 'on', 'off']).toContain(b.get().display.reducedMotion);
  });
});
