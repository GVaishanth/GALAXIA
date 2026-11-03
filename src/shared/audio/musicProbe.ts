/**
 * QA only (Finale P2): renders the real theme player into an
 * OfflineAudioContext and measures the result, for the music harness. Loaded
 * by a dynamic import inside the `__GALAXIA_TEST_HOOKS__` branch of the host,
 * so release builds contain none of it.
 *
 * This is a signal measurement (levels, silence, continuity), not a listening
 * test: it cannot tell whether the music sounds good.
 */
import { createThemePlayer, scheduleSpan, type MusicContext } from '../../audio/music/galaxiaTheme.ts';
import { LOOP_BEATS, SECONDS_PER_BEAT, type ThemeLayer } from '../../audio/music/themeScore.ts';

export interface ProbeSpec {
  /** 'span': schedule beats [from, to) at once. 'live': start the real scheduler, stepped every 0.1 s. */
  readonly kind: 'span' | 'live';
  readonly from?: number;
  readonly to?: number;
  readonly layers?: readonly ThemeLayer[];
  readonly seconds?: number;
  /** live: stop() at this time (s); restartAt: start() again. */
  readonly stopAt?: number;
  readonly restartAt?: number;
  readonly sampleRate?: number;
  /** RMS window, seconds. */
  readonly window?: number;
}

export interface ProbeResult {
  readonly seconds: number;
  readonly notes: number;
  readonly peak: number;
  readonly rms: number;
  readonly nonFinite: number;
  readonly windows: readonly number[];
  readonly window: number;
  readonly maxVoices: number;
  readonly endVoices: number;
  readonly endRuns: number;
  readonly endTimers: number;
}

export async function probe(spec: ProbeSpec): Promise<ProbeResult> {
  const sr = spec.sampleRate ?? 22050;
  const from = spec.from ?? 0;
  const to = spec.to ?? from + 16;
  const seconds = spec.kind === 'span' ? (to - from) * SECONDS_PER_BEAT + 2.5 : (spec.seconds ?? 8);
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  let notes = 0;
  let maxVoices = 0;
  let endVoices = 0;
  let endRuns = 0;
  let endTimers = 0;
  if (spec.kind === 'span') {
    notes = scheduleSpan(ctx as unknown as MusicContext, ctx.destination, from, to, spec.layers);
  } else {
    // a manual clock: timers run when rendering reaches them (0.1 s steps)
    let due: { at: number; fn: () => void; id: number }[] = [];
    let ids = 0;
    const timers = {
      set: (fn: () => void, ms: number) => {
        const id = ++ids;
        due.push({ at: ctx.currentTime + ms / 1000, fn, id });
        return id;
      },
      clear: (id: unknown) => {
        due = due.filter((d) => d.id !== id);
      },
    };
    const player = createThemePlayer(ctx as unknown as MusicContext, ctx.destination, timers);
    const step = 0.1;
    for (let t = step; t < seconds - 0.05; t += step) {
      const at = Math.round(t * 1000) / 1000;
      void ctx.suspend(at).then(() => {
        const now = ctx.currentTime;
        if (spec.stopAt !== undefined && Math.abs(now - spec.stopAt) < step / 2) player.stop();
        if (spec.restartAt !== undefined && Math.abs(now - spec.restartAt) < step / 2) player.start();
        const run = due.filter((d) => d.at <= now + 1e-6);
        due = due.filter((d) => d.at > now + 1e-6);
        for (const d of run) d.fn();
        const s = player.stats();
        maxVoices = Math.max(maxVoices, s.voices);
        endVoices = s.voices;
        endRuns = s.runs;
        endTimers = s.timers;
        void ctx.resume();
      });
    }
    player.start();
    notes = -1;
  }
  const buf = await ctx.startRendering();
  const win = spec.window ?? 0.25;
  const per = Math.max(1, Math.round(win * sr));
  const chans = [buf.getChannelData(0), buf.getChannelData(1)];
  let peak = 0;
  let sum = 0;
  let nonFinite = 0;
  const windows: number[] = [];
  let wsum = 0;
  let wn = 0;
  for (let i = 0; i < buf.length; i++) {
    let s2 = 0;
    for (const c of chans) {
      const v = c[i]!;
      if (!Number.isFinite(v)) {
        nonFinite += 1;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      s2 += v * v;
    }
    sum += s2 / 2;
    wsum += s2 / 2;
    wn += 1;
    if (wn === per) {
      windows.push(Math.sqrt(wsum / wn));
      wsum = 0;
      wn = 0;
    }
  }
  return { seconds, notes, peak, rms: Math.sqrt(sum / buf.length), nonFinite, windows, window: win, maxVoices, endVoices, endRuns, endTimers };
}

export const LOOP_SECONDS = LOOP_BEATS * SECONDS_PER_BEAT;
