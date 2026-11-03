/**
 * Finale P2: the home-page theme. The score (pure data) and the player's
 * scheduler and lifecycle, against a recording fake AudioContext with a manual
 * clock and manual timers. These prove timing, cleanup and bounds; they cannot
 * prove how the music sounds (the browser harness measures a real render).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHORDS, LEAD, LOOP_BEATS, SECONDS_PER_BEAT, SECTIONS, THEME, THEME_EVENTS, THEME_ID, hz, noteNumber, sectionAt } from '../src/audio/music/themeScore.ts';
import { FADE_IN_S, FADE_OUT_S, LOOKAHEAD_S, TICK_MS, createThemePlayer, musicSupported, scheduleSpan, type MusicContext } from '../src/audio/music/galaxiaTheme.ts';

/* ---- a recording fake Web Audio context ---- */

interface Ev {
  readonly kind: string;
  readonly v: number;
  readonly t: number;
}
class FakeParam {
  value: number;
  events: Ev[] = [];
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v: number, t: number) {
    this.events.push({ kind: 'set', v, t });
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push({ kind: 'lin', v, t });
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (v <= 0) throw new RangeError('exponential ramp to a non-positive value');
    this.events.push({ kind: 'exp', v, t });
  }
  setTargetAtTime(v: number, t: number, c: number) {
    this.events.push({ kind: 'target', v, t: t + c * 0 });
  }
  cancelScheduledValues(t: number) {
    this.events.push({ kind: 'cancel', v: 0, t });
  }
}
class FakeNode {
  connected: unknown[] = [];
  disconnected = false;
  readonly ctx: FakeCtx;
  readonly kind: string;
  constructor(ctx: FakeCtx, kind: string) {
    this.ctx = ctx;
    this.kind = kind;
    ctx.nodes.push(this);
  }
  connect(d: unknown) {
    this.connected.push(d);
    return d;
  }
  disconnect() {
    this.disconnected = true;
  }
}
class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  startAt: number | null = null;
  stopAt: number | null = null;
  ended = false;
  frequency = new FakeParam(440);
  detune = new FakeParam(0);
  type = 'sine';
  buffer: unknown = null;
  loop = false;
  start(t: number) {
    if (this.startAt !== null) throw new Error('InvalidStateError: start twice');
    this.startAt = t;
    this.ctx.sources.push(this);
  }
  stop(t: number) {
    if (this.startAt === null) throw new Error('InvalidStateError: stop before start');
    this.stopAt = t;
  }
  setPeriodicWave() {}
}
class FakeCtx implements MusicContext {
  currentTime = 0;
  readonly sampleRate = 8000;
  nodes: FakeNode[] = [];
  sources: FakeSource[] = [];
  createGain() {
    const n = new FakeNode(this, 'gain') as FakeNode & { gain: FakeParam };
    n.gain = new FakeParam(1);
    return n as never;
  }
  createOscillator() {
    return new FakeSource(this, 'osc') as never;
  }
  createBufferSource() {
    return new FakeSource(this, 'buffer') as never;
  }
  createBiquadFilter() {
    const n = new FakeNode(this, 'filter') as FakeNode & { frequency: FakeParam; Q: FakeParam; type: string };
    n.frequency = new FakeParam(350);
    n.Q = new FakeParam(1);
    return n as never;
  }
  createDelay() {
    const n = new FakeNode(this, 'delay') as FakeNode & { delayTime: FakeParam };
    n.delayTime = new FakeParam(0);
    return n as never;
  }
  createConvolver() {
    return new FakeNode(this, 'convolver') as never;
  }
  createBuffer(channels: number, length: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: (c: number) => data[c]! };
  }
  createPeriodicWave() {
    return {};
  }
  /** Advance the clock; sources whose stop time has passed end (onended), like the browser. */
  advance(s: number) {
    this.currentTime += s;
    for (const src of this.sources) {
      if (!src.ended && src.stopAt !== null && src.stopAt <= this.currentTime + 1e-9) {
        src.ended = true;
        src.onended?.();
      }
    }
  }
}
function fakeTimers() {
  let now = 0;
  let id = 0;
  const q: { at: number; fn: () => void; id: number }[] = [];
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        q.push({ at: now + ms, fn, id: ++id });
        return id;
      },
      clear: (x: unknown) => {
        const i = q.findIndex((e) => e.id === x);
        if (i >= 0) q.splice(i, 1);
      },
    },
    pending: () => q.length,
    /** run the timers due within `ms`, moving `ctx` time with them */
    run(ms: number, ctx: FakeCtx) {
      const end = now + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const next = q[0];
        if (!next || next.at > end) break;
        ctx.advance((next.at - now) / 1000);
        now = next.at;
        q.shift();
        next.fn();
      }
      ctx.advance((end - now) / 1000);
      now = end;
    },
  };
}
const setup = () => {
  const ctx = new FakeCtx();
  const out = { connect() {} };
  const t = fakeTimers();
  const player = createThemePlayer(ctx, out, t.timers);
  return { ctx, out, t, player };
};
const started = (ctx: FakeCtx) => ctx.sources.filter((s) => s.startAt !== null);

/* ---- the score ---- */

describe('the theme score (original, deterministic)', () => {
  it('has an explicit tempo and form: D minor, 84 BPM, 4/4, 32 bars, about 91 s, four sections', () => {
    expect(THEME).toMatchObject({ bpm: 84, beatsPerBar: 4, bars: 32, key: 'D minor' });
    expect(LOOP_BEATS).toBe(128);
    expect(SECONDS_PER_BEAT).toBeCloseTo(60 / 84, 12);
    expect(LOOP_BEATS * SECONDS_PER_BEAT).toBeCloseTo(91.43, 2);
    expect(SECTIONS.map((s) => [s.id, s.bar])).toEqual([['A', 1], ['B', 9], ['C', 17], ['D', 25]]);
    expect([0, 32, 64, 96, 127.9].map(sectionAt)).toEqual(['A', 'B', 'C', 'D', 'D']);
  });

  it('is pure data: the same events every time, in time order, all inside one loop, every layer present', () => {
    expect(Object.isFrozen(THEME_EVENTS)).toBe(true);
    for (let i = 1; i < THEME_EVENTS.length; i++) expect(THEME_EVENTS[i]!.beat).toBeGreaterThanOrEqual(THEME_EVENTS[i - 1]!.beat);
    for (const e of THEME_EVENTS) {
      expect(e.beat).toBeGreaterThanOrEqual(0);
      expect(e.beat).toBeLessThan(LOOP_BEATS);
      expect(e.vel).toBeGreaterThan(0);
      expect(e.vel).toBeLessThanOrEqual(1);
    }
    const layers = new Set(THEME_EVENTS.map((e) => e.layer));
    for (const l of ['pad', 'lead', 'bass', 'arp', 'counter', 'kick', 'hat', 'snap', 'swell', 'boom', 'tone']) expect(layers.has(l as never)).toBe(true);
    // the source has no randomness or clock (deterministic authored sequence)
    for (const f of ['themeScore.ts', 'galaxiaTheme.ts']) {
      const code = readFileSync(new URL(`../src/audio/music/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code).not.toMatch(/Math\.random|Date\.now|performance\.now|new Date/);
    }
  });

  it('every bar of the lead and the chords adds up (32 bars, 128 beats); note names parse', () => {
    expect(LEAD).toHaveLength(32);
    expect(CHORDS.reduce((s, c) => s + c[2], 0)).toBe(128);
    expect(noteNumber('A4')).toBe(69);
    expect(noteNumber('Bb4')).toBe(70);
    expect(noteNumber('C#4')).toBe(61);
    expect(() => noteNumber('H2')).toThrow();
    expect(hz(69)).toBe(440);
  });

  it('the motif (D F A Bb: up 3, 4, 1 semitones) returns: hinted in A, stated in B, reharmonised in D', () => {
    const lead = THEME_EVENTS.filter((e) => e.layer === 'lead');
    const starts = (bar: number) => lead.filter((e) => e.beat >= (bar - 1) * 4 && e.beat < bar * 4).map((e) => e.note);
    const steps = (n: number[]) => n.slice(1, 4).map((x, i) => x - n[i]!);
    expect(steps(starts(5))).toEqual([3, 4, 1]); // A: the hint
    expect(steps(starts(9))).toEqual([3, 4, 1]); // B: the theme
    expect(steps(starts(25))).toEqual([3, 4, 1]); // D: up an octave, over Bb
    expect(starts(25)[0]! - starts(9)[0]!).toBe(12);
    // C develops it (in F): the same rhythm, a new contour
    expect(lead.filter((e) => e.beat >= 64 && e.beat < 68).map((e) => e.dur)).toEqual(lead.filter((e) => e.beat >= 32 && e.beat < 36).map((e) => e.dur));
  });

  it('loops seamlessly: the end of D is the end of A (the lead-in), the last chord is the dominant (A7 -> Dm9), nothing runs past the loop', () => {
    expect(LEAD[30]).toBe(LEAD[6]);
    expect(LEAD[31]).toBe(LEAD[7]);
    expect(CHORDS[CHORDS.length - 1]![0]).toBe('A7');
    expect(CHORDS[0]![0]).toBe('Dm9');
    for (const e of THEME_EVENTS) if (e.layer !== 'pad' && e.layer !== 'boom') expect(e.beat + e.dur).toBeLessThanOrEqual(LOOP_BEATS);
  });

  it('section dynamics: drums only in B, C and early D; C is the fullest; the end winds down', () => {
    const count = (layer: string, from: number, to: number) => THEME_EVENTS.filter((e) => e.layer === layer && e.beat >= from && e.beat < to).length;
    expect(count('kick', 0, 32)).toBe(0);
    expect(count('kick', 32, 64)).toBeGreaterThan(0);
    expect(count('hat', 64, 96)).toBeGreaterThan(count('hat', 32, 64));
    expect(count('snap', 64, 96)).toBeGreaterThan(0);
    expect(count('kick', 112, 128) + count('hat', 112, 128)).toBe(0);
    expect(count('counter', 64, 96)).toBe(8);
  });

  it('carries its chunk marker (the build verifier finds the music chunk by it)', () => {
    expect(THEME_ID.startsWith('galaxia-theme:')).toBe(true);
  });
});

/* ---- the player ---- */

describe('the theme player (look-ahead scheduler)', () => {
  it('needs the full node set; a context without it is not supported', () => {
    expect(musicSupported(new FakeCtx())).toBe(true);
    expect(musicSupported({ createGain() {} })).toBe(false);
    expect(musicSupported(null)).toBe(false);
  });

  it('builds nothing until start(); starts once (a second start while playing does nothing)', () => {
    const { ctx, player } = setup();
    expect(ctx.nodes).toHaveLength(0);
    expect(player.stats()).toMatchObject({ built: false, playing: false, runs: 0, timers: 0 });
    expect(player.start()).toBe(true);
    expect(player.start()).toBe(false);
    expect(player.stats()).toMatchObject({ built: true, playing: true, runs: 1, starts: 1, timers: 1 });
  });

  it('schedules on the explicit tempo, only inside the look-ahead window, never twice', () => {
    const { ctx, t, player } = setup();
    player.start();
    const t0 = started(ctx)[0]!.startAt!;
    for (const s of started(ctx)) expect(s.startAt!).toBeLessThan(ctx.currentTime + LOOKAHEAD_S + 1e-9);
    t.run(20_000, ctx);
    // every started note sits on the grid: t0 + beat * 60/84
    const beats = new Set(THEME_EVENTS.map((e) => Math.round(e.beat * 1000)));
    const voiced = new Set(started(ctx).map((s) => s.startAt!));
    for (const at of voiced) expect(beats.has(Math.round(((at - t0) / SECONDS_PER_BEAT) * 1000))).toBe(true);
    // no event scheduled twice: the notes started equal the score's notes up to now
    const due = THEME_EVENTS.filter((e) => e.layer !== 'tone' && t0 + e.beat * SECONDS_PER_BEAT < ctx.currentTime + LOOKAHEAD_S).length;
    expect(player.stats().scheduled).toBe(due);
  });

  it('a tick schedules a bounded handful of notes; the timer is the only one (TICK_MS), never a busy loop', () => {
    const { ctx, t, player } = setup();
    player.start();
    let last = player.stats().scheduled;
    let most = 0;
    for (let i = 0; i < 300; i++) {
      t.run(TICK_MS, ctx);
      const s = player.stats();
      most = Math.max(most, s.scheduled - last);
      last = s.scheduled;
      expect(s.timers).toBe(1);
    }
    expect(most).toBeLessThanOrEqual(16);
  });

  it('loops seamlessly: the second loop starts exactly one loop length after the first', () => {
    const { ctx, t, player } = setup();
    player.start();
    const t0 = started(ctx)[0]!.startAt!;
    t.run((LOOP_BEATS * SECONDS_PER_BEAT + 2) * 1000, ctx);
    const loop = LOOP_BEATS * SECONDS_PER_BEAT;
    const second = started(ctx).filter((s) => Math.abs(s.startAt! - (t0 + loop)) < 1e-6);
    const first = started(ctx).filter((s) => Math.abs(s.startAt! - t0) < 1e-6);
    expect(second.length).toBe(first.length);
    expect(player.stats().loop).toBe(1);
  });

  it('fades in from silence; every note envelope starts and ends at exactly 0 (no clicks)', () => {
    const { ctx, player, t } = setup();
    player.start();
    t.run(10_000, ctx);
    const gains = ctx.nodes.filter((n) => n.kind === 'gain') as unknown as { gain: FakeParam }[];
    const fades = gains.filter((g) => g.gain.events[0]?.kind === 'set' && g.gain.events[1]?.kind === 'lin' && Math.abs(g.gain.events[1].t - g.gain.events[0].t - FADE_IN_S) < 1e-9);
    expect(fades.length).toBe(3); // dry, reverb and delay of the run
    for (const g of gains) {
      const ev = g.gain.events.filter((e) => e.kind !== 'cancel' && e.kind !== 'target');
      if (ev.length < 3 || ev[0]!.kind !== 'set' || ev[0]!.v !== 0 || ev.some((e) => e.v > 1)) continue; // (the vibrato depth is in cents)
      expect(ev[ev.length - 1]!.v).toBe(0);
    }
  });

  it('stop(): cancels every note that has not started (it never sounds), fades out, then disconnects the run', () => {
    const { ctx, t, player } = setup();
    player.start();
    t.run(5_000, ctx);
    const now = ctx.currentTime;
    const future = started(ctx).filter((s) => s.startAt! > now);
    expect(future.length).toBeGreaterThan(0);
    player.stop();
    for (const s of future) expect(s.stopAt!).toBeLessThanOrEqual(now + 1e-9); // stop before start: silent
    expect(player.stats()).toMatchObject({ playing: false, timers: 1 }); // the cleanup timer only
    // cancelled counts notes (a pad note has three oscillators, a lead note three sources): at least one per start time
    expect(player.stats().cancelled).toBeGreaterThanOrEqual(new Set(future.map((f) => f.startAt)).size);
    expect(player.stats().cancelled).toBeLessThanOrEqual(future.length);
    const before = player.stats().scheduled;
    t.run((FADE_OUT_S + 0.2) * 1000, ctx);
    expect(player.stats().scheduled).toBe(before); // nothing new after stop
    expect(player.stats()).toMatchObject({ runs: 0, voices: 0, timers: 0 });
    // every per-note node and every run node is disconnected; only the shared graph stays (reused)
    const live = ctx.nodes.filter((n) => !n.disconnected);
    expect(live.length).toBeLessThanOrEqual(12);
  });

  it('start -> stop -> start reuses the shared graph (no second reverb), the new run starts from the top', () => {
    const { ctx, t, player } = setup();
    player.start();
    t.run(3_000, ctx);
    player.stop();
    t.run(1_000, ctx);
    const convolvers = () => ctx.nodes.filter((n) => n.kind === 'convolver').length;
    expect(convolvers()).toBe(1);
    expect(player.start()).toBe(true);
    expect(convolvers()).toBe(1);
    expect(player.stats()).toMatchObject({ playing: true, runs: 1, starts: 2 });
    expect(player.stats().beat).toBeLessThan(0.1);
  });

  it('rapid transitions: 50 start/stop cycles never leave more than one run playing and leak nothing', () => {
    const { ctx, t, player } = setup();
    for (let i = 0; i < 50; i++) {
      player.start();
      t.run(30 + (i % 7) * 40, ctx);
      expect(player.stats().runs).toBeLessThanOrEqual(2); // the playing run and at most one still fading
      player.stop();
      t.run(i % 3 === 0 ? 10 : 700, ctx);
    }
    t.run(2_000, ctx);
    expect(player.stats()).toMatchObject({ playing: false, runs: 0, voices: 0, timers: 0 });
    expect(ctx.nodes.filter((n) => n.kind === 'convolver')).toHaveLength(1);
    // at any time at most one run schedules: a start during a fade begins a new run, the old one only fades
    player.start();
    player.start();
    expect(player.stats().starts).toBe(51);
  });

  it('back-to-back trips (start/stop every 25 ms, faster than a fade): older fades are cut short; soon only the new run and one fade remain', () => {
    const { ctx, t, player } = setup();
    for (let i = 0; i < 10; i++) {
      player.start();
      t.run(20, ctx);
      player.stop();
      t.run(5, ctx);
    }
    player.start();
    t.run(100, ctx); // a cut run ramps to silence in 30 ms and is released 50 ms later
    expect(player.stats()).toMatchObject({ playing: true, starts: 11 });
    expect(player.stats().runs).toBeLessThanOrEqual(2);
    expect(player.stats().timers).toBeLessThanOrEqual(2); // the playing run's tick and the last fade's release
    player.stop();
    t.run(2_000, ctx);
    expect(player.stats()).toMatchObject({ playing: false, runs: 0, voices: 0, timers: 0 });
    expect(ctx.nodes.filter((n) => n.kind === 'convolver')).toHaveLength(1);
  });

  it('a stalled page: late notes are not fired together; the timeline moves on', () => {
    const { ctx, t, player } = setup();
    player.start();
    t.run(2_000, ctx);
    const before = player.stats().scheduled;
    ctx.advance(10); // the context ran on while no timer fired
    t.run(TICK_MS, ctx);
    const burst = player.stats().scheduled - before;
    expect(burst).toBeLessThanOrEqual(16);
    for (const s of started(ctx).slice(-burst)) expect(s.startAt!).toBeGreaterThanOrEqual(ctx.currentTime - TICK_MS / 1000 - 0.03);
  });

  it('hold() stops scheduling (hidden page, suspended context); release() continues in place', () => {
    const { ctx, t, player } = setup();
    player.start();
    t.run(3_000, ctx);
    player.hold();
    expect(player.stats()).toMatchObject({ held: true, timers: 0, playing: true });
    const n = player.stats().scheduled;
    t.run(5_000, ctx);
    expect(player.stats().scheduled).toBe(n);
    player.release();
    expect(player.stats()).toMatchObject({ held: false, timers: 1 });
  });

  it('dispose(): stops at once, disconnects everything (shared nodes too), idempotent, start() refused after', () => {
    const { ctx, t, player } = setup();
    player.start();
    t.run(2_000, ctx);
    player.dispose();
    player.dispose();
    expect(ctx.nodes.every((n) => n.disconnected || n instanceof FakeSource)).toBe(true);
    expect(player.stats()).toMatchObject({ disposed: true, runs: 0, timers: 0, playing: false });
    expect(player.start()).toBe(false);
  });

  it('offline span (the harness render) schedules exactly the score, across the loop point', () => {
    const ctx = new FakeCtx();
    const n = scheduleSpan(ctx, { connect() {} }, LOOP_BEATS - 8, LOOP_BEATS + 8);
    const expected = THEME_EVENTS.filter((e) => e.beat >= LOOP_BEATS - 8).length + THEME_EVENTS.filter((e) => e.beat < 8).length;
    expect(n).toBe(expected);
  });
});

/* ---- where the music code may be reached from ---- */

describe('the music chunk boundary (source rules)', () => {
  const root = new URL('../src/', import.meta.url);
  const all = (dir: URL): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? all(new URL(`${d.name}/`, dir)) : d.name.endsWith('.ts') ? [new URL(d.name, dir).pathname] : []));
  const files = all(root);
  const rel = (f: string) => f.slice(root.pathname.length);
  const src = (f: string) => readFileSync(f, 'utf8');

  it('only the host (by dynamic import) and the QA probe load the theme player; the director imports types only', () => {
    const users = files.filter((f) => !rel(f).startsWith('audio/music/') && /audio\/music\/galaxiaTheme/.test(src(f))).map(rel).sort();
    expect(users).toEqual(['modes/host.ts', 'shared/audio/musicProbe.ts', 'shared/audio/titleMusic.ts']);
    expect(src(new URL('modes/host.ts', root).pathname)).toMatch(/import\('\.\.\/audio\/music\/galaxiaTheme\.ts'\)/);
    expect(src(new URL('modes/host.ts', root).pathname)).not.toMatch(/^import [^;]*galaxiaTheme/m);
    expect(src(new URL('shared/audio/titleMusic.ts', root).pathname)).toMatch(/^import type [^;]*galaxiaTheme/m);
    // the probe is reached only inside the test-hook branch
    expect(src(new URL('modes/host.ts', root).pathname)).toMatch(/if \(__GALAXIA_TEST_HOOKS__\) window\.__galaxiaMusicProbe = [^\n]*musicProbe/);
  });

  it('the theme modules import nothing outside audio/music (no entry code pulled into the chunk)', () => {
    for (const f of ['audio/music/galaxiaTheme.ts', 'audio/music/themeScore.ts']) {
      const specs = [...src(new URL(f, root).pathname).matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
      for (const s of specs) expect(s.startsWith('./')).toBe(true);
    }
  });

  it('Free Roam never references the music modules (gameplay never downloads the theme)', () => {
    const fr = files.filter((f) => rel(f).startsWith('modes/freeroam/'));
    expect(fr.length).toBeGreaterThan(50);
    for (const f of fr) expect(src(f)).not.toMatch(/audio\/music\/|titleMusic|musicProbe/);
  });
});
