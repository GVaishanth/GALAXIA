/**
 * Sound recipes (Stage 4). Every sound is synthesised locally at runtime from
 * these parameters (square / triangle / saw / sine oscillators and seeded
 * noise); there are no recorded samples and nothing is downloaded. All
 * motifs are original to GALAXIA (no melodies or recordings from any
 * existing game).
 *
 * bus 'sfx'   = gameplay sounds (Effects volume)
 * bus 'music' = jingles / motifs (Music volume)
 */
import { deepFreeze } from './freeze.ts';

export type Wave = 'square' | 'triangle' | 'saw' | 'sine' | 'noise';

export interface Voice {
  readonly wave: Wave;
  /** Square duty cycle (0..1), default 0.5. */
  readonly duty?: number;
  /** Start / end frequency in Hz (noise: sample-and-hold rate). */
  readonly f0: number;
  readonly f1?: number;
  readonly sweep?: 'lin' | 'exp';
  /** Offset from the sound start. */
  readonly atMs?: number;
  readonly attackMs: number;
  readonly holdMs: number;
  readonly decayMs: number;
  readonly gain: number;
  /** Vibrato rate (Hz) and depth (fraction of frequency). */
  readonly vibHz?: number;
  readonly vibDepth?: number;
}

export interface SoundRecipe {
  readonly bus: 'sfx' | 'music';
  readonly voices: readonly Voice[];
  readonly gain: number;
  /** Simultaneous instances of this sound (oldest is stolen). */
  readonly maxVoices: number;
  /** Repeats closer than this are skipped (prevents machine-gun stacking). */
  readonly minGapMs: number;
  /** Looping sound: rendered as exactly loopMs with no envelope (frequencies complete whole cycles). */
  readonly loop?: boolean;
  readonly loopMs?: number;
}

const NOTE_INDEX: Readonly<Record<string, number>> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

/** 'A4' -> 440, 'C#5' -> 554.37 (equal temperament). */
export function noteHz(name: string): number {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const semis = NOTE_INDEX[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) - 4) * 12;
  return 440 * 2 ** (semis / 12);
}

/** A sequence of short square/triangle notes (one voice per note). */
function motif(notes: readonly string[], stepMs: number, o: { wave?: Wave; duty?: number; gain?: number; lastMs?: number; layer?: Wave; layerGain?: number } = {}): Voice[] {
  const out: Voice[] = [];
  notes.forEach((n, i) => {
    if (n === '-') return;
    const last = i === notes.length - 1;
    const len = last && o.lastMs ? o.lastMs : stepMs;
    const f = noteHz(n);
    out.push({ wave: o.wave ?? 'square', duty: o.duty ?? 0.25, f0: f, atMs: i * stepMs, attackMs: 2, holdMs: len * 0.55, decayMs: len * 0.45, gain: o.gain ?? 0.5 });
    if (o.layer) out.push({ wave: o.layer, f0: f / 2, atMs: i * stepMs, attackMs: 2, holdMs: len * 0.6, decayMs: len * 0.4, gain: o.layerGain ?? 0.3 });
  });
  return out;
}

export const SOUNDS = deepFreeze({
  shot: {
    bus: 'sfx',
    gain: 0.28,
    maxVoices: 3,
    minGapMs: 30,
    voices: [
      { wave: 'square', duty: 0.25, f0: 1500, f1: 420, sweep: 'exp', attackMs: 1, holdMs: 6, decayMs: 70, gain: 0.8 },
      { wave: 'noise', f0: 9000, attackMs: 1, holdMs: 4, decayMs: 22, gain: 0.25 },
    ],
  },
  enemyHit: {
    bus: 'sfx',
    gain: 0.3,
    maxVoices: 2,
    minGapMs: 40,
    voices: [{ wave: 'square', duty: 0.5, f0: 700, f1: 1400, sweep: 'exp', attackMs: 1, holdMs: 10, decayMs: 60, gain: 0.7 }],
  },
  enemyBoom: {
    bus: 'sfx',
    gain: 0.36,
    maxVoices: 4,
    minGapMs: 25,
    voices: [
      { wave: 'noise', f0: 5000, f1: 700, sweep: 'exp', attackMs: 1, holdMs: 20, decayMs: 230, gain: 0.8 },
      { wave: 'square', duty: 0.5, f0: 320, f1: 70, sweep: 'exp', attackMs: 1, holdMs: 10, decayMs: 160, gain: 0.35 },
    ],
  },
  bossBoom: {
    bus: 'sfx',
    gain: 0.42,
    maxVoices: 2,
    minGapMs: 60,
    voices: [
      { wave: 'noise', f0: 3500, f1: 250, sweep: 'exp', attackMs: 1, holdMs: 40, decayMs: 440, gain: 0.85 },
      { wave: 'triangle', f0: 220, f1: 45, sweep: 'exp', attackMs: 1, holdMs: 30, decayMs: 400, gain: 0.6 },
      { wave: 'square', duty: 0.25, f0: 880, f1: 220, sweep: 'exp', atMs: 30, attackMs: 1, holdMs: 10, decayMs: 160, gain: 0.25 },
    ],
  },
  playerBoom: {
    bus: 'sfx',
    gain: 0.5,
    maxVoices: 2,
    minGapMs: 80,
    voices: [
      { wave: 'noise', f0: 2600, f1: 120, sweep: 'exp', attackMs: 2, holdMs: 80, decayMs: 900, gain: 0.85 },
      { wave: 'triangle', f0: 330, f1: 38, sweep: 'exp', attackMs: 2, holdMs: 40, decayMs: 820, gain: 0.55 },
      { wave: 'noise', f0: 1400, f1: 200, sweep: 'exp', atMs: 140, attackMs: 2, holdMs: 30, decayMs: 420, gain: 0.45 },
    ],
  },
  dive: {
    bus: 'sfx',
    gain: 0.12,
    maxVoices: 2,
    minGapMs: 220,
    voices: [{ wave: 'square', duty: 0.5, f0: 1250, f1: 360, sweep: 'lin', attackMs: 10, holdMs: 220, decayMs: 160, gain: 0.7, vibHz: 22, vibDepth: 0.035 }],
  },
  /** Weapon overheated (TD-74): a falling steam hiss over a low buzz. */
  overheat: {
    bus: 'sfx',
    gain: 0.34,
    maxVoices: 1,
    minGapMs: 400,
    voices: [
      { wave: 'noise', f0: 7000, f1: 900, sweep: 'exp', attackMs: 4, holdMs: 120, decayMs: 520, gain: 0.6 },
      { wave: 'saw', f0: 140, f1: 70, sweep: 'exp', attackMs: 4, holdMs: 160, decayMs: 300, gain: 0.35, vibHz: 18, vibDepth: 0.05 },
    ],
  },
  /** Weapon cooled and ready again: two short rising blips. */
  cooled: {
    bus: 'sfx',
    gain: 0.2,
    maxVoices: 1,
    minGapMs: 300,
    voices: [
      { wave: 'square', duty: 0.25, f0: 880, attackMs: 1, holdMs: 30, decayMs: 40, gain: 0.6 },
      { wave: 'square', duty: 0.25, f0: 1320, atMs: 80, attackMs: 1, holdMs: 30, decayMs: 60, gain: 0.6 },
    ],
  },
  /** Tractor beam hum: 600 ms loop; 330 Hz x 0.6 s = 198 cycles, 495 Hz = 297, vibrato 5 Hz = 3. */
  beam: {
    bus: 'sfx',
    gain: 0.16,
    maxVoices: 1,
    minGapMs: 0,
    loop: true,
    loopMs: 600,
    voices: [
      { wave: 'triangle', f0: 330, attackMs: 0, holdMs: 600, decayMs: 0, gain: 0.7, vibHz: 5, vibDepth: 0.06 },
      { wave: 'square', duty: 0.5, f0: 495, attackMs: 0, holdMs: 600, decayMs: 0, gain: 0.18, vibHz: 5, vibDepth: 0.06 },
    ],
  },
  captured: { bus: 'music', gain: 0.3, maxVoices: 1, minGapMs: 300, voices: motif(['A5', 'F5', 'D5', 'Bb4', 'A4'], 110, { lastMs: 360, layer: 'triangle' }) },
  rescueFree: { bus: 'sfx', gain: 0.3, maxVoices: 1, minGapMs: 200, voices: motif(['C6', 'E6', 'G6', 'C7'], 60, { duty: 0.125, lastMs: 140 }) },
  dual: { bus: 'music', gain: 0.32, maxVoices: 1, minGapMs: 300, voices: motif(['G5', 'C6', 'D6', 'G6', '-', 'E6', 'G6'], 70, { lastMs: 320, layer: 'triangle' }) },
  stageStart: { bus: 'music', gain: 0.3, maxVoices: 1, minGapMs: 500, voices: motif(['E5', 'G5', 'B5', 'E6', '-', 'D6', 'E6', 'B5', 'E6'], 95, { lastMs: 420, layer: 'triangle', layerGain: 0.35 }) },
  challengeStart: { bus: 'music', gain: 0.3, maxVoices: 1, minGapMs: 500, voices: motif(['C6', 'G5', 'C6', 'E6', 'D6', 'G6', '-', 'E6', 'C7'], 85, { lastMs: 420, layer: 'triangle', layerGain: 0.35 }) },
  stageClear: { bus: 'music', gain: 0.28, maxVoices: 1, minGapMs: 500, voices: motif(['G5', 'B5', 'D6', 'G6'], 75, { lastMs: 260, duty: 0.125 }) },
  bonus: { bus: 'sfx', gain: 0.28, maxVoices: 2, minGapMs: 120, voices: motif(['B5', 'E6', 'B6'], 55, { duty: 0.125, lastMs: 160 }) },
  extraLife: { bus: 'sfx', gain: 0.3, maxVoices: 1, minGapMs: 400, voices: motif(['E6', 'B6', 'E6', 'B6', 'E7'], 70, { duty: 0.125, lastMs: 220 }) },
  perfect: { bus: 'music', gain: 0.32, maxVoices: 1, minGapMs: 800, voices: motif(['C6', 'E6', 'G6', 'C7', '-', 'A6', 'C7', 'E7', '-', 'D7', 'E7', 'G7'], 80, { lastMs: 480, layer: 'triangle' }) },
  gameOver: { bus: 'music', gain: 0.32, maxVoices: 1, minGapMs: 800, voices: motif(['G4', 'D4', 'Eb4', 'Bb3', '-', 'C4', 'G3'], 190, { wave: 'triangle', lastMs: 700, layer: 'square', layerGain: 0.12 }) },
  /* Combat P03C (Classic, post-Wave-20 roster ships only) */
  missileLaunch: {
    bus: 'sfx',
    gain: 0.26,
    maxVoices: 2,
    minGapMs: 60,
    voices: [
      { wave: 'noise', f0: 2400, f1: 6000, sweep: 'exp', attackMs: 4, holdMs: 60, decayMs: 160, gain: 0.55 },
      { wave: 'square', duty: 0.25, f0: 220, f1: 520, sweep: 'exp', attackMs: 2, holdMs: 40, decayMs: 120, gain: 0.3 },
    ],
  },
  missileBlast: {
    bus: 'sfx',
    gain: 0.4,
    maxVoices: 3,
    minGapMs: 40,
    voices: [
      { wave: 'noise', f0: 3000, f1: 300, sweep: 'exp', attackMs: 1, holdMs: 40, decayMs: 380, gain: 0.85 },
      { wave: 'triangle', f0: 160, f1: 50, sweep: 'exp', attackMs: 1, holdMs: 30, decayMs: 300, gain: 0.5 },
    ],
  },
  nukeBlast: {
    bus: 'sfx',
    gain: 0.38, // peaks under the limiter threshold on its own (audioLifecycle test)
    maxVoices: 1,
    minGapMs: 300,
    voices: [
      { wave: 'noise', f0: 1800, f1: 90, sweep: 'exp', attackMs: 3, holdMs: 160, decayMs: 1300, gain: 0.9 },
      { wave: 'triangle', f0: 110, f1: 30, sweep: 'exp', attackMs: 3, holdMs: 120, decayMs: 1200, gain: 0.7 },
      { wave: 'square', duty: 0.5, f0: 440, f1: 110, sweep: 'exp', atMs: 90, attackMs: 2, holdMs: 30, decayMs: 500, gain: 0.2 },
    ],
  },
  lockTone: { bus: 'sfx', gain: 0.16, maxVoices: 1, minGapMs: 120, voices: motif(['A6', 'E7'], 50, { duty: 0.125, lastMs: 70 }) },
  weaponSwitch: { bus: 'sfx', gain: 0.18, maxVoices: 1, minGapMs: 40, voices: motif(['E6', 'B6'], 30, { duty: 0.25, lastMs: 50 }) },
  refused: { bus: 'sfx', gain: 0.16, maxVoices: 1, minGapMs: 150, voices: [{ wave: 'square', duty: 0.5, f0: 180, f1: 140, sweep: 'lin', attackMs: 2, holdMs: 60, decayMs: 60, gain: 0.6 }] },
  uiMove: { bus: 'sfx', gain: 0.16, maxVoices: 1, minGapMs: 40, voices: [{ wave: 'square', duty: 0.25, f0: 990, attackMs: 1, holdMs: 14, decayMs: 22, gain: 0.6 }] },
  uiSelect: { bus: 'sfx', gain: 0.2, maxVoices: 1, minGapMs: 60, voices: motif(['A5', 'E6'], 45, { duty: 0.25, lastMs: 80 }) },
  pause: { bus: 'sfx', gain: 0.18, maxVoices: 1, minGapMs: 100, voices: motif(['E6', 'A5'], 60, { duty: 0.25, lastMs: 70 }) },
} satisfies Record<string, SoundRecipe>);

export type SoundId = keyof typeof SOUNDS;

export const AUDIO = deepFreeze({
  sampleRate: 44100,
  /** Global cap on simultaneously playing one-shot voices. */
  maxVoices: 14,
  /** Seed for noise generators (deterministic rendering). */
  noiseSeed: 0x5f3759df,
  /** Short fade at the end of one-shots (click-free). */
  endFadeMs: 4,
  /**
   * Master safety limiter (TD-81). The loudest single sound peaks at 0.70 of
   * full scale, under the -3 dBFS (0.71) threshold, so one sound is never
   * touched; 14 voices started in the same frame can sum past full scale
   * (measured 2.3 at master 1.0), and those peaks are limited instead of clipped.
   */
  limiter: { thresholdDb: -3, kneeDb: 3, ratio: 20, attackS: 0.002, releaseS: 0.15 },
});
