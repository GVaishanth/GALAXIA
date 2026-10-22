/**
 * Offline sound renderer: SoundRecipe -> mono Float32Array samples.
 * Pure and deterministic (seeded noise, no Web Audio, no DOM), so it is
 * unit-tested directly; the audio engine copies the result into buffers.
 */
import { AUDIO, type SoundRecipe, type Voice } from '../config/audio.ts';
import { createRng } from '../core/rng.ts';

export function recipeDurationMs(r: SoundRecipe): number {
  if (r.loop) return r.loopMs ?? 500;
  let end = 0;
  for (const v of r.voices) end = Math.max(end, (v.atMs ?? 0) + v.attackMs + v.holdMs + v.decayMs);
  return end + AUDIO.endFadeMs;
}

function envelope(v: Voice, t: number, loop: boolean): number {
  if (loop) return 1;
  if (t < 0) return 0;
  if (t < v.attackMs) return v.attackMs > 0 ? t / v.attackMs : 1;
  const tHold = t - v.attackMs;
  if (tHold < v.holdMs) return 1;
  const tDec = tHold - v.holdMs;
  if (tDec >= v.decayMs || v.decayMs <= 0) return 0;
  const k = 1 - tDec / v.decayMs;
  return k * k;
}

/** Render a recipe at `sampleRate`. Output is clamped to [-1, 1]. */
export function renderSound(r: SoundRecipe, sampleRate: number = AUDIO.sampleRate, seed: number = AUDIO.noiseSeed): Float32Array {
  const durMs = recipeDurationMs(r);
  const n = Math.max(1, Math.round((durMs / 1000) * sampleRate));
  const out = new Float32Array(n);
  const loop = r.loop === true;
  r.voices.forEach((v, vi) => {
    const rng = createRng((seed + vi * 7919) >>> 0);
    const start = Math.round((((v.atMs ?? 0) / 1000) * sampleRate));
    const span = v.attackMs + v.holdMs + v.decayMs;
    const len = loop ? n : Math.min(n - start, Math.ceil((span / 1000) * sampleRate) + 1);
    let phase = 0;
    let hold = rng.next() * 2 - 1;
    const duty = v.duty ?? 0.5;
    for (let i = 0; i < len; i++) {
      const tMs = (i / sampleRate) * 1000;
      const k = span > 0 ? Math.min(1, tMs / span) : 0;
      let f = v.f0;
      if (v.f1 !== undefined) f = v.sweep === 'lin' ? v.f0 + (v.f1 - v.f0) * k : v.f0 * (v.f1 / v.f0) ** k;
      if (v.vibHz && v.vibDepth) f *= 1 + v.vibDepth * Math.sin((2 * Math.PI * v.vibHz * i) / sampleRate);
      phase += f / sampleRate;
      let wrapped = false;
      if (phase >= 1) {
        phase -= Math.floor(phase);
        wrapped = true;
      }
      let s: number;
      switch (v.wave) {
        case 'square':
          s = phase < duty ? 1 : -1;
          break;
        case 'triangle':
          s = 1 - 4 * Math.abs(phase - 0.5);
          break;
        case 'saw':
          s = 2 * phase - 1;
          break;
        case 'sine':
          s = Math.sin(2 * Math.PI * phase);
          break;
        case 'noise':
          if (wrapped) hold = rng.next() * 2 - 1;
          s = hold;
          break;
      }
      const idx = start + i;
      out[idx] = out[idx]! + s * v.gain * envelope(v, tMs, loop);
    }
  });
  const fade = loop ? 0 : Math.round((AUDIO.endFadeMs / 1000) * sampleRate);
  for (let i = 0; i < n; i++) {
    let s = out[i]! * r.gain;
    if (fade > 0 && i >= n - fade) s *= (n - 1 - i) / fade;
    out[i] = s > 1 ? 1 : s < -1 ? -1 : s;
  }
  if (!loop) out[0] = 0;
  return out;
}
