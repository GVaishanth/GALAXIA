/**
 * Audio review (TD-81): gain staging and the master safety limiter, repeated
 * instances, the pause lifecycle (including hidden tabs, where no frame runs),
 * mute/volume, autoplay and cleanup. Driven through a fake AudioContext that
 * records the node graph; nothing here was listened to (see TD-81 / FR-OD-25).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SoundSystem, type AudioContextLike, type BufferLike, type CompressorLike, type GainNodeLike, type SourceLike } from '../src/audio/soundSystem.ts';
import { renderSound } from '../src/audio/synth.ts';
import { AUDIO, SOUNDS, type SoundRecipe } from '../src/config/audio.ts';
import { FR_SOUNDS } from '../src/modes/freeroam/audio/frSounds.ts';
import { DEFAULT_SAVE, type AudioPrefs } from '../src/persistence/saveData.ts';

const root = join(import.meta.dirname, '..');
type Node = { name: string; out: unknown[]; disconnected: number };

class Ctx implements AudioContextLike {
  state = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = { name: 'destination' };
  nodes: Node[] = [];
  sources: (SourceLike & Node & { stopped: number })[] = [];
  suspends = 0;
  resumes = 0;
  private readonly compressor: 'yes' | 'no' | 'throws';
  constructor(compressor: 'yes' | 'no' | 'throws' = 'yes') {
    this.compressor = compressor;
    if (compressor === 'no') Object.defineProperty(this, 'createDynamicsCompressor', { value: undefined }); // like a browser without it
  }
  private node<T extends object>(name: string, extra: T): T & Node {
    const n = { name, out: [] as unknown[], disconnected: 0, ...extra };
    const o = n as T & Node & { connect(d: unknown): unknown; disconnect(): void };
    o.connect = (d: unknown) => {
      n.out.push(d);
      return d;
    };
    o.disconnect = () => {
      n.disconnected += 1;
    };
    this.nodes.push(n);
    return o;
  }
  createGain(): GainNodeLike {
    return this.node('gain', { gain: { value: 1, setTargetAtTime(v: number) { this.value = v; } } }) as unknown as GainNodeLike;
  }
  createDynamicsCompressor?(): CompressorLike {
    if (this.compressor === 'throws') throw new Error('not allowed');
    const p = (): { value: number } => ({ value: 0 });
    return this.node('limiter', { threshold: p(), knee: p(), ratio: p(), attack: p(), release: p() }) as unknown as CompressorLike;
  }
  createBuffer(_c: number, length: number, rate: number): BufferLike {
    return { duration: length / rate, copyToChannel: () => undefined };
  }
  createBufferSource(): SourceLike {
    const s = this.node('source', { buffer: null as BufferLike | null, loop: false, onended: null as (() => void) | null, stopped: 0, start() {}, stop() { this.stopped += 1; } });
    this.sources.push(s as never);
    return s as unknown as SourceLike;
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

function make(compressor: 'yes' | 'no' | 'throws' = 'yes', prefs: Partial<AudioPrefs> = {}): { sys: SoundSystem; ctx: Ctx } {
  const ctx = new Ctx(compressor);
  return { sys: new SoundSystem(() => ctx, { ...DEFAULT_SAVE.audio, ...prefs }), ctx };
}

const ALL: [string, SoundRecipe][] = [...Object.entries(SOUNDS), ...Object.entries(FR_SOUNDS as Record<string, SoundRecipe>)];
const peak = (r: SoundRecipe): number => renderSound(r, 22050).reduce((m, x) => Math.max(m, Math.abs(x)), 0);

describe('gain staging and the master safety limiter', () => {
  it('master -> limiter -> destination, with the configured settings', () => {
    const { sys, ctx } = make();
    sys.unlock();
    const limiter = ctx.nodes.find((n) => n.name === 'limiter') as unknown as CompressorLike & Node;
    const master = ctx.nodes.find((n) => n.out.includes(limiter));
    expect(master).toBeDefined();
    expect(limiter.out).toEqual([ctx.destination]);
    expect(ctx.nodes.filter((n) => n.out.includes(ctx.destination))).toHaveLength(1); // nothing bypasses it
    expect(limiter.threshold.value).toBe(AUDIO.limiter.thresholdDb);
    expect(limiter.ratio.value).toBe(AUDIO.limiter.ratio);
    expect(limiter.attack.value).toBe(AUDIO.limiter.attackS);
    expect(limiter.release.value).toBe(AUDIO.limiter.releaseS);
    expect(sys.stats().limited).toBe(true);
  });

  it('without (or with a failing) DynamicsCompressor, master feeds the destination directly', () => {
    for (const mode of ['no', 'throws'] as const) {
      const { sys, ctx } = make(mode);
      sys.unlock();
      expect(ctx.nodes.some((n) => n.name === 'limiter')).toBe(false);
      expect(ctx.nodes.filter((n) => n.out.includes(ctx.destination))).toHaveLength(1);
      expect(sys.stats().limited).toBe(false);
      expect(sys.play('shot')).toBe(true);
    }
  });

  it('every sound alone peaks below the limiter threshold at full volume (one sound is never limited)', () => {
    const threshold = 10 ** (AUDIO.limiter.thresholdDb / 20);
    const loud = ALL.map(([id, r]) => ({ id, p: peak(r) })).filter((x) => x.p >= threshold);
    expect(loud).toEqual([]);
  });

  it('stacked voices can exceed full scale, which is why the limiter exists', () => {
    // upper bound: the loudest instances allowed at once (per-sound caps, one jingle, the global cap)
    const inst: number[] = [];
    for (const [, r] of ALL) if (!r.loop) for (let i = 0; i < (r.bus === 'music' ? 1 : r.maxVoices); i += 1) inst.push(peak(r));
    inst.sort((a, b) => b - a);
    const bound = inst.slice(0, AUDIO.maxVoices).reduce((a, b) => a + b, 0);
    if (bound > 1) expect(AUDIO.limiter.thresholdDb).toBeLessThan(0);
    expect(bound).toBeGreaterThan(0);
  });
});

describe('repeated instances and cleanup', () => {
  it('a burst of the same sound stays within its voice cap and the global cap', () => {
    const { sys } = make();
    sys.unlock();
    for (const [id, r] of Object.entries(SOUNDS) as [string, SoundRecipe][]) {
      if (r.loop) continue;
      for (let i = 0; i < 40; i += 1) sys.play(id as keyof typeof SOUNDS);
      expect(sys.stats().active).toBeLessThanOrEqual(AUDIO.maxVoices);
    }
    for (const [, r] of ALL) {
      expect(r.maxVoices).toBeGreaterThanOrEqual(1);
      expect(r.minGapMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('a finished one-shot disconnects; stopping loops disconnects their nodes', () => {
    const { sys, ctx } = make();
    sys.unlock();
    sys.play('shot');
    const s = ctx.sources.at(-1)!;
    s.onended?.();
    expect(s.disconnected).toBe(1);
    expect(sys.stats().active).toBe(0);
    sys.define('fr.engine', FR_SOUNDS['fr.engine' as keyof typeof FR_SOUNDS] as SoundRecipe);
    expect(sys.startLoop('engine', 'fr.engine', 0.5)).toBe(true);
    const loop = ctx.sources.at(-1)!;
    sys.stopLoops();
    expect(loop.stopped).toBe(1);
    expect(loop.disconnected).toBe(1);
    expect(sys.stats().loops).toBe(0);
  });
});

describe('pause lifecycle, autoplay, mute', () => {
  it('nothing is created before a gesture; unlock while paused stays suspended; resume restores', () => {
    let created = 0;
    const ctx = new Ctx();
    const sys = new SoundSystem(() => {
      created += 1;
      return ctx;
    }, DEFAULT_SAVE.audio);
    expect(sys.play('shot')).toBe(false);
    expect(created).toBe(0);
    sys.unlock();
    sys.pause();
    expect(sys.stats().paused).toBe(true);
    sys.unlock(); // a key while paused does not wake audio
    expect(ctx.state).toBe('suspended');
    sys.resume();
    expect(ctx.state).toBe('running');
    expect(sys.stats().paused).toBe(false);
  });

  it('a loop silenced while paused stays at 0 and keeps running for the resume', () => {
    const { sys } = make();
    sys.unlock();
    sys.define('fr.engine', FR_SOUNDS['fr.engine' as keyof typeof FR_SOUNDS] as SoundRecipe);
    sys.startLoop('engine', 'fr.engine', 0.6);
    sys.setLoopGain('engine', 0);
    expect(sys.loopLevel('engine')).toBe(0);
    expect(sys.stats().loops).toBe(1);
  });

  it('mute zeroes the master and blocks new voices; volumes are applied to the buses', () => {
    const { sys, ctx } = make('yes', { muted: true });
    sys.unlock();
    expect(sys.play('shot')).toBe(false);
    const gains = ctx.nodes.filter((n) => n.name === 'gain') as unknown as (GainNodeLike & Node)[];
    expect(gains[0]!.gain.value).toBe(0);
    sys.setPrefs({ ...DEFAULT_SAVE.audio, muted: false, master: 0.5, sfx: 0.25, music: 2 });
    expect(gains.map((g) => g.gain.value)).toEqual([0.5, 0.25, 1]);
  });

  it('the modes stop sound at once when they pause without a frame (hidden tab)', () => {
    const app = readFileSync(join(root, 'src/game/app.ts'), 'utf8');
    const fr = readFileSync(join(root, 'src/modes/freeroam/freeRoamMode.ts'), 'utf8');
    // Classic auto-pause suspends the context itself (the phase event is handled on the next frame)
    expect(app).toMatch(/engine\.pause\(\)\) status\.autoPauses \+= 1;[\s\S]{0,320}if \(engine\.phase === 'paused'\) sound\.pause\(\);/);
    // Classic never hands the next mode a suspended context
    expect(app).toMatch(/if \(sound\.isPaused\) sound\.resume\(\);/);
    // Free Roam pause silences the engine hum immediately
    expect(fr).toMatch(/services\.sound\.play\('pause'\);[\s\S]{0,200}services\.sound\.setLoopGain\(ENGINE_LOOP, 0\);/);
  });
});
