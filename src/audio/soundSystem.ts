/**
 * Web Audio playback for the synthesised sounds.
 *
 * - Autoplay-safe: no AudioContext exists until unlock() is called from a
 *   user gesture (key / pointer). Before that every play request is a no-op.
 * - Buses: master -> destination; sfx and music gains feed master. Mute sets
 *   master to 0 (and skips starting new voices).
 * - Bounded: per-sound voice limits with stealing, a minimum repeat gap, a
 *   global voice cap and one-at-a-time jingles on the music bus.
 * - Loops (tractor beam hum) are keyed and always stoppable; stopLoops()
 *   silences them all (game over, quit, restart).
 * - pause()/resume() suspend the context, so nothing plays or runs while the
 *   game is paused or hidden.
 * - define(): a mode may register its own recipes at runtime (ids with a dot,
 *   e.g. `fr.engine`), so they ship in that mode's chunk; they share the
 *   buses, limits, mute and volume of the built-in sounds.
 * - Each loop has its own gain node: setLoopGain() eases it (an engine hum
 *   that follows thrust), without restarting the loop.
 *
 * The context is injected (`createContext`) so tests use a fake.
 */
import { AUDIO, SOUNDS, type SoundId, type SoundRecipe } from '../config/audio.ts';
import type { AudioPrefs } from '../persistence/saveData.ts';
import type { Cue } from './cues.ts';
import { recipeDurationMs, renderSound } from './synth.ts';

export interface AudioParamLike {
  value: number;
  setTargetAtTime?(target: number, startTime: number, timeConstant: number): unknown;
}
export interface NodeLike {
  connect(destination: unknown): unknown;
  disconnect?(): void;
}
export interface GainNodeLike extends NodeLike {
  readonly gain: AudioParamLike;
}
export interface BufferLike {
  readonly duration: number;
  copyToChannel(source: Float32Array, channel: number): void;
}
export interface SourceLike extends NodeLike {
  buffer: BufferLike | null;
  loop: boolean;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}
/** DynamicsCompressorNode subset used as the master safety limiter. */
export interface CompressorLike extends NodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
}
export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: unknown;
  createGain(): GainNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): BufferLike;
  createBufferSource(): SourceLike;
  /** Optional: without it the master bus feeds the destination directly. */
  createDynamicsCompressor?(): CompressorLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
}

/** A runtime-registered sound (always namespaced with a dot: `fr.engine`). */
export type CustomSoundId = `${string}.${string}`;
export type AnySoundId = SoundId | CustomSoundId;

interface ActiveVoice {
  readonly sound: AnySoundId;
  readonly source: SourceLike;
  readonly endsAt: number;
  readonly bus: 'sfx' | 'music';
}

export interface SoundStats {
  readonly unlocked: boolean;
  readonly played: number;
  readonly skipped: number;
  readonly active: number;
  readonly loops: number;
  readonly buffers: number;
  /** Runtime-registered recipes. */
  readonly defined: number;
  /** Suspended by a mode (pause menu, auto-pause). */
  readonly paused: boolean;
  /** Master bus runs through the safety limiter. */
  readonly limited: boolean;
  /** Browser AudioContext state ('none' before unlock; else suspended/running/closed). Diagnostics. */
  readonly context: string;
}

interface LoopVoice {
  readonly source: SourceLike;
  readonly gain: GainNodeLike;
  level: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export class SoundSystem {
  private ctx: AudioContextLike | null = null;
  private master: GainNodeLike | null = null;
  private buses: Record<'sfx' | 'music', GainNodeLike> | null = null;
  private readonly buffers = new Map<AnySoundId, BufferLike>();
  private voices: ActiveVoice[] = [];
  private readonly loops = new Map<string, LoopVoice>();
  private readonly lastStart = new Map<AnySoundId, number>();
  private readonly extra = new Map<CustomSoundId, SoundRecipe>();
  private prefs: AudioPrefs;
  private paused = false;
  private readonly createContext: () => AudioContextLike | null;
  played = 0;
  skipped = 0;
  /** True when the master bus runs through the safety limiter. */
  limited = false;

  constructor(createContext: () => AudioContextLike | null, prefs: AudioPrefs) {
    this.createContext = createContext;
    this.prefs = prefs;
  }

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** True while a mode has suspended audio (pause menu, auto-pause). */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Create/resume the context. Call only from a user-gesture handler. */
  unlock(): void {
    if (!this.ctx) {
      let ctx: AudioContextLike | null = null;
      try {
        ctx = this.createContext();
      } catch {
        ctx = null; // audio unsupported: stay silent
      }
      if (!ctx) return;
      this.ctx = ctx;
      this.master = ctx.createGain();
      // master -> safety limiter -> destination (TD-81): every sound alone peaks below the
      // threshold, so only stacked peaks (many voices in one frame) are limited
      let limiter: CompressorLike | null = null;
      try {
        limiter = ctx.createDynamicsCompressor?.() ?? null;
      } catch {
        limiter = null;
      }
      if (limiter) {
        const L = AUDIO.limiter;
        limiter.threshold.value = L.thresholdDb;
        limiter.knee.value = L.kneeDb;
        limiter.ratio.value = L.ratio;
        limiter.attack.value = L.attackS;
        limiter.release.value = L.releaseS;
        this.master.connect(limiter);
        limiter.connect(ctx.destination);
        this.limited = true;
      } else {
        this.master.connect(ctx.destination);
      }
      const sfx = ctx.createGain();
      const music = ctx.createGain();
      sfx.connect(this.master);
      music.connect(this.master);
      this.buses = { sfx, music };
      this.applyGains();
    }
    if (!this.paused && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  setPrefs(prefs: AudioPrefs): void {
    this.prefs = prefs;
    this.applyGains();
  }

  get currentPrefs(): AudioPrefs {
    return this.prefs;
  }

  /** Effective gain of a bus (0 when muted). */
  busGain(bus: 'sfx' | 'music'): number {
    if (this.prefs.muted) return 0;
    return clamp01(this.prefs.master) * clamp01(bus === 'sfx' ? this.prefs.sfx : this.prefs.music);
  }

  pause(): void {
    this.paused = true;
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
  }

  resume(): void {
    this.paused = false;
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  handle(cue: Cue): void {
    switch (cue.kind) {
      case 'play':
        this.play(cue.sound);
        break;
      case 'loopStart':
        this.startLoop(cue.key, cue.sound);
        break;
      case 'loopStop':
        this.stopLoop(cue.key);
        break;
      case 'stopLoops':
        this.stopLoops();
        break;
    }
  }

  /**
   * Register a recipe under a namespaced id (idempotent for the same recipe;
   * a different recipe under a used id replaces it and drops its cached buffer).
   */
  define(id: CustomSoundId, recipe: SoundRecipe): void {
    if (!id.includes('.')) throw new Error(`custom sound ids need a namespace: ${id}`);
    if (this.extra.get(id) === recipe) return;
    this.extra.set(id, recipe);
    this.buffers.delete(id);
  }

  /** The recipe for an id (built-in first), or undefined when unknown. */
  recipe(id: AnySoundId): SoundRecipe | undefined {
    return (SOUNDS as Readonly<Record<string, SoundRecipe>>)[id] ?? this.extra.get(id as CustomSoundId);
  }

  /** Start a one-shot. Returns false when skipped (locked, muted, limited, unknown). */
  play(id: AnySoundId): boolean {
    const ctx = this.ctx;
    const recipe = this.recipe(id);
    if (!ctx || !this.buses || !recipe || this.paused || this.prefs.muted || recipe.loop || this.busGain(recipe.bus) === 0) {
      this.skipped += 1;
      return false;
    }
    const now = ctx.currentTime;
    this.voices = this.voices.filter((v) => v.endsAt > now);
    const last = this.lastStart.get(id);
    if (last !== undefined && (now - last) * 1000 < recipe.minGapMs) {
      this.skipped += 1;
      return false;
    }
    // jingles never overlap: the first one plays out
    if (recipe.bus === 'music' && this.voices.some((v) => v.bus === 'music')) {
      this.skipped += 1;
      return false;
    }
    const mine = this.voices.filter((v) => v.sound === id);
    if (mine.length >= recipe.maxVoices) this.stopVoice(mine[0]!);
    if (this.voices.length >= AUDIO.maxVoices) {
      this.skipped += 1;
      return false;
    }
    const source = ctx.createBufferSource();
    source.buffer = this.buffer(id, recipe);
    source.connect(this.buses[recipe.bus]);
    const voice: ActiveVoice = { sound: id, source, endsAt: now + recipeDurationMs(recipe) / 1000, bus: recipe.bus };
    source.onended = () => {
      this.voices = this.voices.filter((v) => v !== voice);
      source.disconnect?.();
    };
    source.start(now);
    this.voices.push(voice);
    this.lastStart.set(id, now);
    this.played += 1;
    return true;
  }

  /** Start a keyed loop at a level (0..1, default 1). False when locked, already running or not a loop. */
  startLoop(key: string, id: AnySoundId, level = 1): boolean {
    const ctx = this.ctx;
    const recipe = this.recipe(id);
    if (!ctx || !this.buses || !recipe || this.loops.has(key) || !recipe.loop) return false;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer(id, recipe);
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = clamp01(level);
    source.connect(gain);
    gain.connect(this.buses[recipe.bus]);
    source.start(ctx.currentTime);
    this.loops.set(key, { source, gain, level: clamp01(level) });
    return true;
  }

  /** Ease a running loop's level (about 60 ms); a no-op for unknown keys or an unchanged level. */
  setLoopGain(key: string, level: number): void {
    const l = this.loops.get(key);
    const ctx = this.ctx;
    if (!l || !ctx) return;
    const v = clamp01(level);
    if (Math.abs(v - l.level) < 0.005) return;
    l.level = v;
    const p = l.gain.gain;
    if (p.setTargetAtTime) p.setTargetAtTime(v, ctx.currentTime, 0.06);
    else p.value = v;
  }

  /** A running loop's target level, or null when it is not running. */
  loopLevel(key: string): number | null {
    return this.loops.get(key)?.level ?? null;
  }

  stopLoop(key: string): void {
    const l = this.loops.get(key);
    if (!l) return;
    this.loops.delete(key);
    try {
      l.source.stop();
    } catch {
      /* already stopped */
    }
    l.source.disconnect?.();
    l.gain.disconnect?.();
  }

  stopLoops(): void {
    for (const key of [...this.loops.keys()]) this.stopLoop(key);
  }

  stats(): SoundStats {
    return { unlocked: this.unlocked, played: this.played, skipped: this.skipped, active: this.voices.length, loops: this.loops.size, buffers: this.buffers.size, defined: this.extra.size, paused: this.paused, limited: this.limited, context: this.ctx?.state ?? 'none' };
  }

  private stopVoice(v: ActiveVoice): void {
    this.voices = this.voices.filter((o) => o !== v);
    try {
      v.source.stop();
    } catch {
      /* already stopped */
    }
  }

  /** Render on first use and cache (a few KB each). */
  private buffer(id: AnySoundId, recipe: SoundRecipe = this.recipe(id)!): BufferLike {
    let b = this.buffers.get(id);
    if (!b) {
      const ctx = this.ctx!;
      const samples = renderSound(recipe, ctx.sampleRate);
      b = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      b.copyToChannel(samples, 0);
      this.buffers.set(id, b);
    }
    return b;
  }

  private applyGains(): void {
    if (!this.ctx || !this.master || !this.buses) return;
    const master = this.prefs.muted ? 0 : clamp01(this.prefs.master);
    const set = (p: AudioParamLike, v: number): void => {
      p.value = v;
    };
    set(this.master.gain, master);
    set(this.buses.sfx.gain, clamp01(this.prefs.sfx));
    set(this.buses.music.gain, clamp01(this.prefs.music));
  }
}
