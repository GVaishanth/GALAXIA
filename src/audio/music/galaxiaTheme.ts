/**
 * The home-page theme player (Finale P2): synthesises "Beyond the Beacon"
 * (themeScore.ts) with native Web Audio nodes and plays it with a look-ahead
 * scheduler. Its own lazy chunk: the entry loads it only when the home page
 * wants music, and Free Roam never imports it.
 *
 *   - Scheduler: a timer every TICK_MS schedules the notes due in the next
 *     LOOKAHEAD_S of AudioContext time (sample-accurate, steady tempo; the
 *     timer only has to run often enough, never on time). Late after a stall,
 *     the timeline moves forward instead of firing the missed notes at once.
 *   - A run per start(): its own fade-in gains and voice set. stop() fades the
 *     run out, cancels every note that has not started yet (it never sounds),
 *     and disconnects all of its nodes after the fade. A start() during that
 *     fade begins a new run (from the top) while the old one fades: never two
 *     full instances, and never more than one fading run beside the new one
 *     (an older fade is ramped to silence in 30 ms and released).
 *   - Shared, built once on the first start and reused: a deterministic
 *     generated reverb, a feedback delay, the noise and bell waveforms. The
 *     output is the SoundSystem's music bus, so the music volume, Mute Music,
 *     the master volume and SOUND OFF apply without touching this graph.
 *   - No Math.random, no Date: the reverb and noise come from a seeded PRNG.
 *
 * The chunk has no runtime import from the entry (types only); the context is
 * typed locally (the subset used).
 */
import { LOOP_BEATS, SECONDS_PER_BEAT, THEME, THEME_EVENTS, THEME_ID, hz, sectionAt, type ThemeEvent, type ThemeLayer } from './themeScore.ts';

interface Param {
  value: number;
  setValueAtTime(v: number, t: number): unknown;
  linearRampToValueAtTime(v: number, t: number): unknown;
  exponentialRampToValueAtTime(v: number, t: number): unknown;
  setTargetAtTime(v: number, t: number, c: number): unknown;
  cancelScheduledValues(t: number): unknown;
}
interface ANode {
  connect(d: unknown): unknown;
  disconnect(): void;
}
interface Gain extends ANode {
  readonly gain: Param;
}
interface Source extends ANode {
  onended: (() => void) | null;
  start(t: number, offset?: number): void;
  stop(t: number): void;
}
interface Osc extends Source {
  type: string;
  readonly frequency: Param;
  readonly detune: Param;
  setPeriodicWave(w: unknown): void;
}
interface Filter extends ANode {
  type: string;
  readonly frequency: Param;
  readonly Q: Param;
}
interface BufSource extends Source {
  buffer: unknown;
  loop: boolean;
}
interface Buf {
  getChannelData(c: number): Float32Array;
}
interface Delay extends ANode {
  readonly delayTime: Param;
}
interface Convolver extends ANode {
  buffer: unknown;
}
/** The Web Audio subset the theme uses (an AudioContext or OfflineAudioContext). */
export interface MusicContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  createGain(): Gain;
  createOscillator(): Osc;
  createBiquadFilter(): Filter;
  createBufferSource(): BufSource;
  createBuffer(channels: number, length: number, sampleRate: number): Buf;
  createDelay(max: number): Delay;
  createConvolver(): Convolver;
  createPeriodicWave(real: Float32Array, imag: Float32Array): unknown;
}
export interface MusicTimers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

export const TICK_MS = 100;
export const LOOKAHEAD_S = 0.9;
export const FADE_IN_S = 1.5;
export const FADE_OUT_S = 0.6;
/**
 * Overall theme level into the music bus. Measured offline (44.1 kHz, Chromium, music and
 * master 100 %, before the bus): sections A/B/C/D peak 0.33/0.40/0.46/0.31 of full scale and sit
 * at -24.5/-23.6/-22.3/-24.6 dBFS RMS. That is under the limiter's -3 dBFS (0.71), so the theme
 * alone is never limited, and the default 70 % music volume lowers it a further 3 dB.
 */
export const THEME_GAIN = 0.75;
/** A run cut short (an older fade when another start comes): ramp to silence over this long, never an abrupt stop. */
const CUT_S = 0.03;
/** At most this many notes per tick (a guard; a normal tick schedules 2-12). */
const MAX_PER_TICK = 64;

/** Per-layer levels (calibrated with the offline render: the theme peaks well under the limiter). */
const LEVEL: Readonly<Record<Exclude<ThemeLayer, 'tone'>, number>> = {
  pad: 0.0375,
  counter: 0.072,
  lead: 0.14,
  arp: 0.25,
  bass: 0.092,
  kick: 0.31,
  hat: 0.12,
  snap: 0.25,
  swell: 0.12,
  boom: 0.24,
};
const REVERB_SEND: Partial<Record<ThemeLayer, number>> = { pad: 0.5, counter: 0.5, lead: 0.4, arp: 0.55, snap: 0.3, swell: 0.6, boom: 0.25 };
const DELAY_SEND: Partial<Record<ThemeLayer, number>> = { lead: 0.22, arp: 0.3 };

export interface ThemeStats {
  readonly id: string;
  readonly title: string;
  readonly built: boolean;
  /** A run is playing (started and not stopped). */
  readonly playing: boolean;
  /** Runs alive, including one still fading out (at most 2, and only during a fade). */
  readonly runs: number;
  /** Notes scheduled and not yet cleaned up. */
  readonly voices: number;
  /** Position of the playing run: loop count and beat in the loop. */
  readonly loop: number;
  readonly beat: number;
  readonly section: string;
  readonly held: boolean;
  readonly timers: number;
  readonly scheduled: number;
  readonly cancelled: number;
  readonly starts: number;
  readonly disposed: boolean;
}

export interface ThemePlayer {
  /** Start from the top with a fade-in. False (nothing new) if already playing or disposed. */
  start(): boolean;
  /** Fade out, cancel future notes, then disconnect. Safe to call at any time. */
  stop(fadeS?: number): void;
  /** Stop scheduling (the page is hidden and the context is suspended); release() resumes in place. */
  hold(): void;
  release(): void;
  /** Stop at once and disconnect everything, shared nodes included. */
  dispose(): void;
  stats(): ThemeStats;
}

/** True when the context has every node type the theme needs. */
export function musicSupported(ctx: unknown): ctx is MusicContext {
  const c = ctx as Record<string, unknown> | null;
  return !!c && ['createGain', 'createOscillator', 'createBiquadFilter', 'createBufferSource', 'createBuffer', 'createDelay', 'createConvolver', 'createPeriodicWave'].every((k) => typeof c[k] === 'function');
}

/** mulberry32: a tiny seeded PRNG (the chunk imports nothing from the entry). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Shared {
  readonly main: Gain;
  readonly reverbIn: Gain;
  readonly delayIn: Gain;
  readonly noise: unknown;
  readonly bell: unknown;
  readonly nodes: ANode[];
}

interface Voice {
  readonly sources: Source[];
  readonly nodes: ANode[];
  readonly start: number;
  readonly end: number;
  done: boolean;
}

interface Run {
  readonly id: number;
  readonly fades: Gain[];
  readonly bus: Map<ThemeLayer, Gain>;
  readonly padFilter: Filter;
  readonly nodes: ANode[];
  readonly voices: Set<Voice>;
  t0: number;
  idx: number;
  loop: number;
  stopped: boolean;
  timer: unknown;
}

const defaultTimers: MusicTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* a node already stopped or disconnected */
  }
}

export function createThemePlayer(ctx: MusicContext, out: unknown, timers: MusicTimers = defaultTimers): ThemePlayer {
  return makePlayer(ctx, out, timers);
}

function makePlayer(ctx: MusicContext, out: unknown, timers: MusicTimers): ThemePlayer & { span(from: number, to: number, layers?: readonly ThemeLayer[]): number } {
  let shared: Shared | null = null;
  const runs = new Set<Run>();
  let current: Run | null = null;
  let held = false;
  let disposed = false;
  let nextId = 0;
  let timerCount = 0;
  let scheduled = 0;
  let cancelled = 0;
  let starts = 0;
  const pending = new Set<unknown>();

  const later = (fn: () => void, ms: number): unknown => {
    const id = timers.set(() => {
      pending.delete(id);
      timerCount = pending.size;
      fn();
    }, ms);
    pending.add(id);
    timerCount = pending.size;
    return id;
  };
  const cancelTimer = (id: unknown): void => {
    if (id === null || id === undefined || !pending.has(id)) return;
    pending.delete(id);
    timerCount = pending.size;
    timers.clear(id);
  };

  function gain(v: number, nodes: ANode[]): Gain {
    const g = ctx.createGain();
    g.gain.value = v;
    nodes.push(g);
    return g;
  }

  function build(): Shared {
    const nodes: ANode[] = [];
    const main = gain(THEME_GAIN, nodes);
    main.connect(out);
    // reverb: a generated stereo impulse (exponential decay, about 2.4 s), seeded so every build is identical
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 2.4);
    const ir = ctx.createBuffer(2, len, sr);
    const rnd = prng(0x6a1a);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        d[i] = (rnd() * 2 - 1) * Math.exp(-t / 0.55) * (1 - Math.exp(-t / 0.008));
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    nodes.push(conv);
    const reverbIn = gain(1, nodes);
    const reverbOut = gain(0.55, nodes);
    reverbIn.connect(conv);
    conv.connect(reverbOut);
    reverbOut.connect(main);
    // a dotted-eighth feedback delay, darkened on every repeat
    const delayIn = gain(1, nodes);
    const delay = ctx.createDelay(2);
    delay.delayTime.value = SECONDS_PER_BEAT * 0.75;
    nodes.push(delay);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2200;
    nodes.push(tone);
    const feedback = gain(0.3, nodes);
    const delayOut = gain(0.3, nodes);
    delayIn.connect(delay);
    delay.connect(tone);
    tone.connect(feedback);
    feedback.connect(delay);
    tone.connect(delayOut);
    delayOut.connect(main);
    delayOut.connect(reverbIn);
    // one second of seeded white noise (hats, snaps, swells)
    const noise = ctx.createBuffer(1, sr, sr);
    const nd = noise.getChannelData(0);
    const nr = prng(0x5eed);
    for (let i = 0; i < nd.length; i++) nd[i] = nr() * 2 - 1;
    // a soft bell: a few sine partials, falling off quickly
    const real = new Float32Array([0, 0, 0, 0, 0, 0, 0]);
    const imag = new Float32Array([0, 1, 0.42, 0.2, 0.1, 0.05, 0.03]);
    const bell = ctx.createPeriodicWave(real, imag);
    return { main, reverbIn, delayIn, noise, bell, nodes };
  }

  function newRun(fadeIn: number, at: number): Run {
    const s = (shared ??= build());
    const nodes: ANode[] = [];
    const fadeDry = gain(0, nodes);
    const fadeRev = gain(0, nodes);
    const fadeDel = gain(0, nodes);
    fadeDry.connect(s.main);
    fadeRev.connect(s.reverbIn);
    fadeDel.connect(s.delayIn);
    const fades = [fadeDry, fadeRev, fadeDel];
    for (const f of fades) {
      if (fadeIn > 0) {
        f.gain.setValueAtTime(0, at);
        f.gain.linearRampToValueAtTime(1, at + fadeIn);
      } else f.gain.value = 1;
    }
    const bus = new Map<ThemeLayer, Gain>();
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 900;
    padFilter.Q.value = 0.6;
    nodes.push(padFilter);
    padFilter.connect(fadeDry);
    const filtered = (type: string, f: number, q: number): Filter => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      nodes.push(n);
      n.connect(fadeDry);
      return n;
    };
    const post: Partial<Record<ThemeLayer, ANode>> = {
      pad: padFilter,
      counter: filtered('lowpass', 1700, 0.5),
      lead: filtered('lowpass', 2800, 0.5),
      arp: filtered('lowpass', 4200, 0.4),
      bass: filtered('lowpass', 280, 1.2),
    };
    for (const layer of Object.keys(LEVEL) as (keyof typeof LEVEL)[]) {
      const b = gain(LEVEL[layer], nodes);
      b.connect(post[layer] ?? fadeDry);
      const rs = REVERB_SEND[layer];
      if (rs) {
        const g = gain(rs, nodes);
        b.connect(g);
        g.connect(fadeRev);
      }
      const ds = DELAY_SEND[layer];
      if (ds) {
        const g = gain(ds, nodes);
        b.connect(g);
        g.connect(fadeDel);
      }
      bus.set(layer, b);
    }
    const run: Run = { id: ++nextId, fades, bus, padFilter, nodes, voices: new Set(), t0: at + 0.06, idx: 0, loop: 0, stopped: false, timer: null };
    runs.add(run);
    return run;
  }

  // --- voices -------------------------------------------------------------

  function finish(run: Run, v: Voice): void {
    if (v.done) return;
    v.done = true;
    for (const n of v.nodes) safe(() => n.disconnect());
    run.voices.delete(v);
  }

  function voice(run: Run, sources: Source[], nodes: ANode[], start: number, end: number): void {
    const v: Voice = { sources, nodes, start, end, done: false };
    run.voices.add(v);
    let left = sources.length;
    for (const s of sources) {
      s.onended = () => {
        left -= 1;
        if (left <= 0) finish(run, v);
      };
      s.start(start);
      s.stop(end);
    }
    scheduled += 1;
  }

  /** attack -> decay to sustain -> hold -> release, all linear (exact zero at both ends: no clicks). */
  function adsr(p: Param, t: number, a: number, peak: number, d: number, sus: number, off: number, r: number): number {
    p.setValueAtTime(0, t);
    const ta = Math.min(t + a, off);
    p.linearRampToValueAtTime(peak, ta);
    const td = Math.min(ta + d, off);
    if (td > ta) p.linearRampToValueAtTime(sus, td);
    if (off > td) p.linearRampToValueAtTime(sus, off);
    p.linearRampToValueAtTime(0, off + r);
    return off + r;
  }

  /** a fast attack and an exponential decay, ending at exactly zero */
  function pluck(p: Param, t: number, a: number, peak: number, decay: number): number {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.exponentialRampToValueAtTime(Math.max(1e-4, peak * 1e-3), t + a + decay);
    p.linearRampToValueAtTime(0, t + a + decay + 0.02);
    return t + a + decay + 0.02;
  }

  function osc(type: string, f: number, detune = 0): Osc {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    if (detune) o.detune.value = detune;
    return o;
  }

  function noiseSource(): BufSource {
    const src = ctx.createBufferSource();
    src.buffer = shared!.noise;
    src.loop = true;
    return src;
  }

  function play(run: Run, ev: ThemeEvent, t: number, n: number): void {
    const dur = ev.dur * SECONDS_PER_BEAT;
    const bus = run.bus.get(ev.layer);
    if (ev.layer === 'tone') {
      run.padFilter.frequency.setTargetAtTime(ev.note, t, 1.2); // the pad opens up section by section
      return;
    }
    if (!bus) return;
    const env = ctx.createGain();
    env.gain.value = 0;
    env.connect(bus);
    const f = hz(ev.note);
    let end: number;
    let sources: Source[];
    const nodes: ANode[] = [env];
    switch (ev.layer) {
      case 'pad':
      case 'counter': {
        const a = ev.layer === 'pad' ? 1.1 : 0.7;
        const r = ev.layer === 'pad' ? 1.8 : 1.2;
        const spread = ev.layer === 'pad' ? 7 : 5;
        sources = [osc('sawtooth', f, -spread), osc('sawtooth', f, spread)];
        if (ev.layer === 'pad') sources.push(osc('triangle', f / 2));
        end = adsr(env.gain, t, a, ev.vel, 0.6, ev.vel * 0.85, t + dur, r);
        break;
      }
      case 'lead': {
        const tri = osc('triangle', f);
        const saw = osc('sawtooth', f);
        const sawGain = ctx.createGain();
        sawGain.gain.value = 0.22;
        saw.connect(sawGain);
        sawGain.connect(env);
        // vibrato that blooms after the attack (a held note sings, a short one stays plain)
        const lfo = osc('sine', 5.1);
        const depth = ctx.createGain();
        depth.gain.value = 0;
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(0, t + 0.25);
        depth.gain.linearRampToValueAtTime(9, t + 0.8);
        lfo.connect(depth);
        depth.connect(tri.detune);
        depth.connect(saw.detune);
        nodes.push(sawGain, depth);
        tri.connect(env);
        sources = [tri, saw, lfo];
        end = adsr(env.gain, t, 0.05, ev.vel, 0.3, ev.vel * 0.72, t + Math.max(0.12, dur - 0.04), 0.4);
        for (const s of sources) nodes.push(s);
        voice(run, sources, nodes, t, end);
        return;
      }
      case 'arp': {
        const o = ctx.createOscillator();
        o.setPeriodicWave(shared!.bell);
        o.frequency.value = f;
        sources = [o];
        end = pluck(env.gain, t, 0.005, ev.vel, 0.9);
        break;
      }
      case 'bass': {
        sources = [osc('sawtooth', f), osc('sine', f)];
        end = dur >= 1.5 ? adsr(env.gain, t, 0.08, ev.vel, 0.4, ev.vel * 0.8, t + dur - 0.05, 0.45) : adsr(env.gain, t, 0.012, ev.vel, 0.15, ev.vel * 0.6, t + dur * 0.85, 0.08);
        break;
      }
      case 'kick':
      case 'boom': {
        const kick = ev.layer === 'kick';
        const o = osc('sine', kick ? 120 : 62);
        o.frequency.setValueAtTime(kick ? 120 : 62, t);
        o.frequency.exponentialRampToValueAtTime(kick ? 44 : 34, t + (kick ? 0.12 : 0.9));
        sources = [o];
        end = pluck(env.gain, t, kick ? 0.003 : 0.02, ev.vel, kick ? 0.32 : 2.2);
        break;
      }
      case 'hat':
      case 'snap':
      case 'swell': {
        const src = noiseSource();
        const filt = ctx.createBiquadFilter();
        nodes.push(filt);
        src.connect(filt);
        filt.connect(env);
        if (ev.layer === 'hat') {
          filt.type = 'highpass';
          filt.frequency.value = 7000;
          end = pluck(env.gain, t, 0.001, ev.vel, 0.045);
        } else if (ev.layer === 'snap') {
          filt.type = 'bandpass';
          filt.frequency.value = 1700;
          filt.Q.value = 0.9;
          end = pluck(env.gain, t, 0.002, ev.vel, 0.12);
        } else {
          filt.type = 'bandpass';
          filt.Q.value = 1.4;
          filt.frequency.setValueAtTime(250, t);
          filt.frequency.exponentialRampToValueAtTime(3200, t + dur);
          env.gain.setValueAtTime(0, t);
          env.gain.linearRampToValueAtTime(ev.vel, t + dur - 0.05);
          env.gain.linearRampToValueAtTime(0, t + dur + 0.25);
          end = t + dur + 0.25;
        }
        // each hit reads a different, fixed part of the noise (deterministic)
        src.onended = null;
        nodes.push(src);
        const v: Voice = { sources: [src], nodes, start: t, end, done: false };
        run.voices.add(v);
        src.onended = () => finish(run, v);
        src.start(t, (n * 0.137) % 0.9);
        src.stop(end);
        scheduled += 1;
        return;
      }
      default:
        return;
    }
    for (const s of sources) {
      s.connect(env);
      nodes.push(s);
    }
    voice(run, sources, nodes, t, end);
  }

  // --- scheduler ----------------------------------------------------------

  function eventTime(run: Run, i: number, loop: number): number {
    return run.t0 + (loop * LOOP_BEATS + THEME_EVENTS[i]!.beat) * SECONDS_PER_BEAT;
  }

  function tick(run: Run): void {
    if (run.stopped) return; // a stopped run's timer is its release: never touch it here
    run.timer = null;
    if (disposed || held) return;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD_S;
    let count = 0;
    while (count < MAX_PER_TICK) {
      let t = eventTime(run, run.idx, run.loop);
      if (t >= horizon) break;
      if (t < now - 0.02) {
        // late (a stalled page): move the timeline forward rather than fire the missed notes together
        run.t0 += now + 0.05 - t;
        t = eventTime(run, run.idx, run.loop);
      }
      play(run, THEME_EVENTS[run.idx]!, t, run.loop * THEME_EVENTS.length + run.idx);
      count += 1;
      run.idx += 1;
      if (run.idx >= THEME_EVENTS.length) {
        run.idx = 0;
        run.loop += 1;
      }
    }
    run.timer = later(() => tick(run), TICK_MS);
  }

  function endRun(run: Run, fade: number): void {
    if (run.stopped) return;
    run.stopped = true;
    cancelTimer(run.timer);
    run.timer = null;
    const now = ctx.currentTime;
    const off = now + Math.max(0, fade);
    for (const f of run.fades) {
      safe(() => {
        f.gain.cancelScheduledValues(now);
        f.gain.setValueAtTime(f.gain.value, now);
        f.gain.linearRampToValueAtTime(0, off);
      });
    }
    for (const v of [...run.voices]) {
      if (v.start >= now) {
        // not started yet: it never sounds
        cancelled += 1;
        for (const s of v.sources) safe(() => s.stop(now));
        finish(run, v);
      } else if (v.end > off) for (const s of v.sources) safe(() => s.stop(off + 0.02));
    }
    // a stopped run's timer is its release (the tick timer was cancelled above)
    if (fade <= 0) releaseRun(run);
    else run.timer = later(() => releaseRun(run), (fade + 0.1) * 1000);
  }

  /** Stop what is left of a stopped run and disconnect its nodes (idempotent: an early cut and the fade timer may both call it). */
  function releaseRun(run: Run): void {
    if (!runs.has(run)) return;
    cancelTimer(run.timer);
    run.timer = null;
    for (const v of [...run.voices]) {
      for (const s of v.sources) safe(() => s.stop(ctx.currentTime));
      finish(run, v);
    }
    for (const n of run.nodes) safe(() => n.disconnect());
    runs.delete(run);
  }

  /** An older run still fading when another start() comes (rapid home <-> game trips): a short ramp to silence (no click), then release. */
  function cutRun(run: Run): void {
    const now = ctx.currentTime;
    for (const f of run.fades) {
      safe(() => {
        f.gain.cancelScheduledValues(now);
        f.gain.setValueAtTime(f.gain.value, now);
        f.gain.linearRampToValueAtTime(0, now + CUT_S);
      });
    }
    for (const v of run.voices) for (const src of v.sources) safe(() => src.stop(now + CUT_S + 0.01));
    cancelTimer(run.timer);
    run.timer = later(() => releaseRun(run), (CUT_S + 0.05) * 1000);
  }

  /** schedule absolute beats [from, to) at once, no fade, no timer (offline render) */
  function span(from: number, to: number, layers?: readonly ThemeLayer[]): number {
    const run = newRun(0, ctx.currentTime);
    run.stopped = true; // never ticks
    run.t0 = ctx.currentTime + 0.05 - from * SECONDS_PER_BEAT;
    let count = 0;
    for (let L = Math.floor(from / LOOP_BEATS); L * LOOP_BEATS < to; L++) {
      THEME_EVENTS.forEach((ev, i) => {
        const abs = L * LOOP_BEATS + ev.beat;
        if (abs < from || abs >= to) return;
        if (layers && ev.layer !== 'tone' && !layers.includes(ev.layer)) return;
        play(run, ev, run.t0 + abs * SECONDS_PER_BEAT, L * THEME_EVENTS.length + i);
        count += 1;
      });
    }
    return count;
  }

  return {
    span,
    start() {
      if (disposed || (current && !current.stopped)) return false;
      const now = ctx.currentTime;
      const s = (shared ??= build());
      safe(() => {
        s.main.gain.cancelScheduledValues(now);
        s.main.gain.setValueAtTime(THEME_GAIN, now);
      });
      held = false;
      // at most one run fades beside the new one: the last one stopped keeps its fade, older ones are cut short
      for (const r of runs) if (r !== current && r.stopped) cutRun(r);
      current = newRun(FADE_IN_S, now);
      starts += 1;
      tick(current);
      return true;
    },
    stop(fadeS = FADE_OUT_S) {
      if (!current || current.stopped) return;
      const run = current;
      endRun(run, fadeS);
      // the shared reverb and delay tails fade with the last run (nothing rings on under gameplay)
      if (shared && ![...runs].some((r) => !r.stopped)) {
        const now = ctx.currentTime;
        const m = shared.main.gain;
        safe(() => {
          m.cancelScheduledValues(now);
          m.setValueAtTime(m.value, now);
          m.linearRampToValueAtTime(0, now + Math.max(0.01, fadeS));
        });
      }
    },
    hold() {
      if (held) return;
      held = true;
      if (current && !current.stopped) {
        cancelTimer(current.timer);
        current.timer = null;
      }
    },
    release() {
      if (!held) return;
      held = false;
      if (current && !current.stopped && !disposed) tick(current);
    },
    dispose() {
      if (disposed) return;
      for (const r of [...runs]) endRun(r, 0);
      for (const r of [...runs]) runs.delete(r);
      for (const id of [...pending]) cancelTimer(id);
      if (shared) for (const n of shared.nodes) safe(() => n.disconnect());
      shared = null;
      current = null;
      disposed = true;
    },
    stats() {
      const r = current && !current.stopped ? current : null;
      let voices = 0;
      for (const x of runs) voices += x.voices.size;
      const beat = r ? Math.max(0, (ctx.currentTime - r.t0) / SECONDS_PER_BEAT) : 0;
      return {
        id: THEME_ID,
        title: THEME.title,
        built: shared !== null,
        playing: r !== null,
        runs: runs.size,
        voices,
        loop: r ? Math.floor(beat / LOOP_BEATS) : 0,
        beat: r ? beat % LOOP_BEATS : 0,
        section: r ? sectionAt(beat) : '',
        held,
        timers: timerCount,
        scheduled,
        cancelled,
        starts,
        disposed,
      };
    },
  };
}

/**
 * Offline render support (tests and the QA music harness): schedule a span of
 * the score, in absolute beats (may cross the loop point), into a context,
 * with no timers and no fade. Returns the number of notes scheduled.
 */
export function scheduleSpan(ctx: MusicContext, out: unknown, fromBeat: number, toBeat: number, layers?: readonly ThemeLayer[]): number {
  return makePlayer(ctx, out, { set: () => 0, clear: () => undefined }).span(fromBeat, toBeat, layers);
}
