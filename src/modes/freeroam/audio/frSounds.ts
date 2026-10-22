/**
 * Free Roam sound set (Prompt 12). Every sound is synthesised at runtime by
 * GALAXIA's own offline synth (src/audio/synth.ts) from the parameters below:
 * oscillators and seeded noise only, no recordings, nothing downloaded, no
 * licence needed. The motifs are original to GALAXIA.
 *
 * The recipes are registered with the shared SoundSystem (`define`) when Free
 * Roam starts, so they ship in the Free Roam chunk and obey the same mute,
 * master / effects / music volumes, voice limits and autoplay lock as Classic.
 *
 * Mix intent: Free Roam is busier than Classic (an engine under everything,
 * more simultaneous ships), so its one-shots are a little quieter and shorter,
 * and repeated combat sounds have minimum gaps. Jingles (mission complete,
 * survey complete) use the music bus, so they never overlap each other.
 */
import { deepFreeze } from '../../../config/freeze.ts';
import { noteHz, type SoundRecipe, type Voice, type Wave } from '../../../config/audio.ts';

/** A short note sequence, one voice per note ('-' = rest). */
function notes(seq: readonly string[], stepMs: number, wave: Wave, gain: number, lastMs = stepMs): Voice[] {
  const out: Voice[] = [];
  seq.forEach((n, i) => {
    if (n === '-') return;
    const len = i === seq.length - 1 ? lastMs : stepMs;
    out.push({ wave, duty: 0.3, f0: noteHz(n), atMs: i * stepMs, attackMs: 3, holdMs: len * 0.5, decayMs: len * 0.5, gain });
  });
  return out;
}

export const FR_SOUNDS = deepFreeze({
  /**
   * Engine hum: a 1 s loop whose level follows thrust (SoundSystem.setLoopGain).
   * Whole cycles per loop: 55 Hz x 1 s = 55, 110 Hz = 110, vibrato 3 Hz = 3.
   */
  'fr.engine': {
    bus: 'sfx',
    gain: 0.2,
    maxVoices: 1,
    minGapMs: 0,
    loop: true,
    loopMs: 1000,
    voices: [
      { wave: 'triangle', f0: 55, attackMs: 0, holdMs: 1000, decayMs: 0, gain: 0.7, vibHz: 3, vibDepth: 0.012 },
      { wave: 'square', duty: 0.2, f0: 110, attackMs: 0, holdMs: 1000, decayMs: 0, gain: 0.1, vibHz: 3, vibDepth: 0.012 },
      { wave: 'noise', f0: 700, attackMs: 0, holdMs: 1000, decayMs: 0, gain: 0.22 },
    ],
  },
  /** The player's bolt: a soft falling blip (softer than Classic's shot). */
  'fr.shot': {
    bus: 'sfx',
    gain: 0.16,
    maxVoices: 3,
    minGapMs: 45,
    voices: [
      { wave: 'square', duty: 0.5, f0: 980, f1: 360, sweep: 'exp', attackMs: 1, holdMs: 5, decayMs: 55, gain: 0.7 },
      { wave: 'triangle', f0: 490, f1: 180, sweep: 'exp', attackMs: 1, holdMs: 5, decayMs: 60, gain: 0.5 },
    ],
  },
  /** Weapon overheated (FR-TD-79): a falling vent hiss over a low rattle. */
  'fr.overheat': {
    bus: 'sfx',
    gain: 0.3,
    maxVoices: 1,
    minGapMs: 400,
    voices: [
      { wave: 'noise', f0: 6000, f1: 800, sweep: 'exp', attackMs: 4, holdMs: 140, decayMs: 560, gain: 0.6 },
      { wave: 'triangle', f0: 120, f1: 60, sweep: 'exp', attackMs: 4, holdMs: 180, decayMs: 320, gain: 0.45, vibHz: 16, vibDepth: 0.06 },
    ],
  },
  /** The weapon cooled and is ready again: a soft rising pair. */
  'fr.cooled': {
    bus: 'sfx',
    gain: 0.16,
    maxVoices: 1,
    minGapMs: 300,
    voices: [
      { wave: 'triangle', f0: 660, attackMs: 1, holdMs: 35, decayMs: 50, gain: 0.7 },
      { wave: 'triangle', f0: 990, atMs: 90, attackMs: 1, holdMs: 35, decayMs: 70, gain: 0.7 },
    ],
  },
  /** A bolt strikes a target. */
  'fr.impact': {
    bus: 'sfx',
    gain: 0.2,
    maxVoices: 3,
    minGapMs: 35,
    voices: [
      { wave: 'noise', f0: 6000, f1: 2500, sweep: 'exp', attackMs: 1, holdMs: 4, decayMs: 40, gain: 0.6 },
      { wave: 'square', duty: 0.25, f0: 1200, f1: 900, sweep: 'lin', attackMs: 1, holdMs: 4, decayMs: 30, gain: 0.35 },
    ],
  },
  /** The player's shield absorbs a hit: a bright shimmer. */
  'fr.shieldHit': {
    bus: 'sfx',
    gain: 0.22,
    maxVoices: 2,
    minGapMs: 70,
    voices: [
      { wave: 'sine', f0: 1800, f1: 900, sweep: 'exp', attackMs: 2, holdMs: 10, decayMs: 140, gain: 0.7, vibHz: 30, vibDepth: 0.04 },
      { wave: 'triangle', f0: 900, attackMs: 2, holdMs: 10, decayMs: 120, gain: 0.35 },
    ],
  },
  /** The shield collapses: a falling buzz. */
  'fr.shieldDown': {
    bus: 'sfx',
    gain: 0.28,
    maxVoices: 1,
    minGapMs: 300,
    voices: [
      { wave: 'saw', f0: 600, f1: 120, sweep: 'exp', attackMs: 2, holdMs: 30, decayMs: 360, gain: 0.55 },
      { wave: 'square', duty: 0.5, f0: 300, f1: 80, sweep: 'exp', attackMs: 2, holdMs: 20, decayMs: 300, gain: 0.25 },
    ],
  },
  /** A hit on the bare hull: a dull thud. */
  'fr.hullHit': {
    bus: 'sfx',
    gain: 0.34,
    maxVoices: 2,
    minGapMs: 70,
    voices: [
      { wave: 'noise', f0: 2200, f1: 400, sweep: 'exp', attackMs: 1, holdMs: 10, decayMs: 160, gain: 0.7 },
      { wave: 'triangle', f0: 140, f1: 60, sweep: 'exp', attackMs: 1, holdMs: 10, decayMs: 140, gain: 0.6 },
    ],
  },
  /** A ship or mine destroyed. */
  'fr.boom': {
    bus: 'sfx',
    gain: 0.32,
    maxVoices: 4,
    minGapMs: 30,
    voices: [
      { wave: 'noise', f0: 4200, f1: 500, sweep: 'exp', attackMs: 1, holdMs: 15, decayMs: 300, gain: 0.8 },
      { wave: 'triangle', f0: 180, f1: 50, sweep: 'exp', attackMs: 1, holdMs: 10, decayMs: 260, gain: 0.5 },
    ],
  },
  /** A large ship destroyed: longer, lower, with a second crack. */
  'fr.bigBoom': {
    bus: 'sfx',
    gain: 0.4,
    maxVoices: 2,
    minGapMs: 80,
    voices: [
      { wave: 'noise', f0: 3000, f1: 160, sweep: 'exp', attackMs: 2, holdMs: 60, decayMs: 700, gain: 0.8 },
      { wave: 'triangle', f0: 120, f1: 35, sweep: 'exp', attackMs: 2, holdMs: 40, decayMs: 650, gain: 0.6 },
      { wave: 'noise', f0: 5000, f1: 900, sweep: 'exp', atMs: 180, attackMs: 1, holdMs: 10, decayMs: 260, gain: 0.45 },
    ],
  },
  /** The player's ship destroyed. */
  'fr.playerBoom': {
    bus: 'sfx',
    gain: 0.48,
    maxVoices: 1,
    minGapMs: 400,
    voices: [
      { wave: 'noise', f0: 2000, f1: 90, sweep: 'exp', attackMs: 2, holdMs: 90, decayMs: 1100, gain: 0.85 },
      { wave: 'saw', f0: 220, f1: 30, sweep: 'exp', attackMs: 2, holdMs: 40, decayMs: 900, gain: 0.35 },
      { wave: 'triangle', f0: 90, f1: 30, sweep: 'exp', atMs: 120, attackMs: 2, holdMs: 30, decayMs: 700, gain: 0.5 },
    ],
  },
  /** A pickup or salvage collected: two quick rising notes. */
  'fr.collect': {
    bus: 'sfx',
    gain: 0.2,
    maxVoices: 2,
    minGapMs: 60,
    voices: notes(['E6', 'B6'], 45, 'triangle', 0.7, 80),
  },
  /** A container, cache or wreck opened with loot inside. */
  'fr.loot': {
    bus: 'sfx',
    gain: 0.2,
    maxVoices: 1,
    minGapMs: 120,
    voices: notes(['E5', 'G#5', 'B5', 'E6'], 50, 'triangle', 0.65, 120),
  },
  /** Mining: a fragment chipped from an ore vein. */
  'fr.chip': {
    bus: 'sfx',
    gain: 0.16,
    maxVoices: 2,
    minGapMs: 60,
    voices: [
      { wave: 'noise', f0: 8000, attackMs: 1, holdMs: 4, decayMs: 30, gain: 0.5 },
      { wave: 'square', duty: 0.25, f0: 2400, f1: 1800, sweep: 'lin', attackMs: 1, holdMs: 4, decayMs: 40, gain: 0.4 },
    ],
  },
  /** A discovery: a survey mark, a new site or a logged station. */
  'fr.discover': {
    bus: 'sfx',
    gain: 0.2,
    maxVoices: 1,
    minGapMs: 200,
    voices: [...notes(['A5', 'E6', 'C#6', 'A6'], 75, 'sine', 0.7, 220), ...notes(['A4', '-', '-', 'A5'], 75, 'triangle', 0.25, 220)],
  },
  /** Docked: a two-note clamp with a soft thump. */
  'fr.dock': {
    bus: 'sfx',
    gain: 0.24,
    maxVoices: 1,
    minGapMs: 200,
    voices: [
      { wave: 'noise', f0: 1200, f1: 300, sweep: 'exp', attackMs: 1, holdMs: 10, decayMs: 90, gain: 0.4 },
      ...notes(['G4', 'D5'], 70, 'square', 0.35, 160),
    ],
  },
  /** Jump travel: a rising rush. */
  'fr.jump': {
    bus: 'sfx',
    gain: 0.28,
    maxVoices: 1,
    minGapMs: 400,
    voices: [
      { wave: 'noise', f0: 300, f1: 6000, sweep: 'exp', attackMs: 260, holdMs: 80, decayMs: 260, gain: 0.55 },
      { wave: 'sine', f0: 80, f1: 900, sweep: 'exp', attackMs: 300, holdMs: 40, decayMs: 220, gain: 0.5 },
    ],
  },
  /** Arrival in a system: a falling sweep that settles on a tone. */
  'fr.arrive': {
    bus: 'sfx',
    gain: 0.24,
    maxVoices: 1,
    minGapMs: 400,
    voices: [
      { wave: 'sine', f0: 1200, f1: 220, sweep: 'exp', attackMs: 4, holdMs: 40, decayMs: 360, gain: 0.55 },
      { wave: 'triangle', f0: noteHz('A4'), atMs: 220, attackMs: 10, holdMs: 120, decayMs: 300, gain: 0.4 },
    ],
  },
  /** A module installed, a ship bought, an upgrade fitted. */
  'fr.upgrade': {
    bus: 'sfx',
    gain: 0.22,
    maxVoices: 1,
    minGapMs: 150,
    voices: [
      { wave: 'saw', f0: 300, f1: 1200, sweep: 'exp', attackMs: 4, holdMs: 110, decayMs: 70, gain: 0.35 },
      ...notes(['-', '-', 'C6', 'G6'], 70, 'triangle', 0.6, 200),
    ],
  },
  /** Combat alert (an attack starting, a capital ship, a heavy weapon telegraph). */
  'fr.alert': {
    bus: 'sfx',
    gain: 0.15,
    maxVoices: 1,
    minGapMs: 600,
    voices: [
      { wave: 'square', duty: 0.5, f0: 880, attackMs: 2, holdMs: 70, decayMs: 20, gain: 0.6 },
      { wave: 'square', duty: 0.5, f0: 660, atMs: 150, attackMs: 2, holdMs: 90, decayMs: 30, gain: 0.6 },
    ],
  },
  /** Refused (docking refused, hold full, a dormant gate). */
  'fr.deny': {
    bus: 'sfx',
    gain: 0.17,
    maxVoices: 1,
    minGapMs: 200,
    voices: [{ wave: 'square', duty: 0.5, f0: 200, f1: 150, sweep: 'lin', attackMs: 2, holdMs: 90, decayMs: 60, gain: 0.6 }],
  },
  /** A sector encounter cleared. */
  'fr.clear': {
    bus: 'sfx',
    gain: 0.22,
    maxVoices: 1,
    minGapMs: 300,
    voices: notes(['C5', 'G5', 'C6'], 80, 'triangle', 0.7, 240),
  },
  /** Mission complete (music bus: jingles never overlap). */
  'fr.mission': {
    bus: 'music',
    gain: 0.26,
    maxVoices: 1,
    minGapMs: 400,
    voices: [...notes(['D5', 'F#5', 'A5', 'D6', '-', 'A5', 'D6'], 85, 'square', 0.45, 260), ...notes(['D4', '-', '-', 'A4', '-', '-', 'D5'], 85, 'triangle', 0.35, 260)],
  },
  /** Survey complete (music bus). */
  'fr.complete': {
    bus: 'music',
    gain: 0.26,
    maxVoices: 1,
    minGapMs: 400,
    voices: [...notes(['G4', 'D5', 'G5', 'B5', 'D6'], 95, 'square', 0.45, 300), ...notes(['G3', '-', 'D4', '-', 'G4'], 95, 'triangle', 0.35, 300)],
  },
} satisfies Record<`fr.${string}`, SoundRecipe>);

export type FrSoundId = keyof typeof FR_SOUNDS;
export const FR_SOUND_IDS = Object.freeze(Object.keys(FR_SOUNDS) as FrSoundId[]);

/** The key of the engine loop in the SoundSystem. */
export const ENGINE_LOOP = 'fr-engine';
