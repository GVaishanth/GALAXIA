/**
 * The GALAXIA main theme, "Beyond the Beacon" (Finale P2): the authored score.
 *
 * Original music written for GALAXIA in this repository (see
 * docs/development/MUSIC_THEME.md for the design notes and the licence). No
 * melody, progression or arrangement is taken from any other work, and no
 * sample or recording is used: every sound is synthesised at runtime by
 * galaxiaTheme.ts from the events below.
 *
 * Pure data and pure functions (no Web Audio, no DOM, no clock, no random), so
 * the score is deterministic and testable: the same events every time.
 *
 * Form: D minor, 84 BPM, 4/4, 32 bars (about 91 s), looping seamlessly.
 *   A  bars  1-8   intro: pad and bass, a bell arpeggio enters, a hint of the motif
 *   B  bars  9-16  main theme: the full motif over a pulsing bass and soft drums
 *   C  bars 17-24  development: the motif in F, a countermelody, fuller rhythm, climb to a peak
 *   D  bars 25-32  return: the motif reharmonised up high, then a wind-down that leads back to A
 * The motif (D F A Bb A, rising 3+4+1 semitones) opens sections A, B and D.
 */

export type ThemeLayer = 'pad' | 'counter' | 'lead' | 'arp' | 'bass' | 'kick' | 'hat' | 'snap' | 'swell' | 'boom' | 'tone';
export type SectionId = 'A' | 'B' | 'C' | 'D';

export interface ThemeEvent {
  /** Start, in beats from the top of the loop (quarter notes). */
  readonly beat: number;
  /** Length in beats (0 for 'tone'). */
  readonly dur: number;
  readonly layer: ThemeLayer;
  /** MIDI note (69 = A4 = 440 Hz); for 'tone', the pad filter cutoff in Hz. */
  readonly note: number;
  /** 0..1 */
  readonly vel: number;
}

export const THEME = Object.freeze({
  title: 'BEYOND THE BEACON',
  key: 'D minor',
  bpm: 84,
  beatsPerBar: 4,
  bars: 32,
});
/** A string only the theme chunk carries (the build verifier's marker for the lazy music chunk). */
export const THEME_ID = 'galaxia-theme:beyond-the-beacon';
export const LOOP_BEATS = THEME.bars * THEME.beatsPerBar;
export const SECONDS_PER_BEAT = 60 / THEME.bpm;

export const SECTIONS: readonly { readonly id: SectionId; readonly bar: number; readonly cutoff: number }[] = [
  { id: 'A', bar: 1, cutoff: 900 },
  { id: 'B', bar: 9, cutoff: 1400 },
  { id: 'C', bar: 17, cutoff: 2000 },
  { id: 'D', bar: 25, cutoff: 1150 },
];

/** Upper-structure voicings (the bass carries the root); chosen for smooth voice leading. */
const VOICING: Readonly<Record<string, readonly number[]>> = {
  Dm9: [53, 57, 60, 64], // F3 A3 C4 E4
  Dm: [53, 57, 62, 65], // F3 A3 D4 F4
  Bbmaj9: [53, 57, 60, 62], // F3 A3 C4 D4
  Bb: [53, 58, 62, 65], // F3 Bb3 D4 F4
  Gm9: [53, 58, 62, 69], // F3 Bb3 D4 A4
  Gm7: [55, 58, 62, 65], // G3 Bb3 D4 F4
  Asus4: [52, 57, 62, 64], // E3 A3 D4 E4
  A7: [52, 55, 61, 64], // E3 G3 C#4 E4
  F: [53, 57, 60, 64], // F3 A3 C4 E4 (Fmaj7)
  Cadd9: [55, 60, 62, 64], // G3 C4 D4 E4
  Csus4: [55, 60, 65, 67], // G3 C4 F4 G4
  C: [55, 60, 64, 67], // G3 C4 E4 G4
};

/** [voicing, bass MIDI note, beats]; the 32 bars in order. */
export const CHORDS: readonly (readonly [string, number, number])[] = [
  // A
  ['Dm9', 38, 4], ['Dm9', 38, 4], ['Bbmaj9', 34, 4], ['Bbmaj9', 34, 4], ['Gm9', 31, 4], ['Gm9', 31, 4], ['Asus4', 33, 4], ['A7', 33, 4],
  // B (bar 11 is Dm over C: the bass walks D, Bb, C, A)
  ['Dm', 38, 4], ['Bbmaj9', 34, 4], ['Dm', 36, 4], ['A7', 33, 4], ['Bbmaj9', 34, 4], ['Gm9', 31, 4], ['A7', 33, 4], ['Dm', 38, 4],
  // C (C/E, F/A: inversions keep the bass stepwise)
  ['F', 41, 4], ['Cadd9', 40, 4], ['Dm', 38, 4], ['Bb', 34, 4], ['F', 33, 4], ['Gm7', 31, 4], ['Bb', 34, 4], ['Csus4', 36, 2], ['C', 36, 2],
  // D
  ['Bbmaj9', 34, 4], ['C', 36, 4], ['Dm9', 38, 4], ['Dm9', 38, 4], ['Bbmaj9', 34, 4], ['Gm9', 31, 4], ['Asus4', 33, 4], ['A7', 33, 4],
];

/**
 * The lead: one string per bar, notes as NAME:EIGHTHS ("r" is a rest). Each
 * bar adds up to 8 eighths.
 */
export const LEAD: readonly string[] = [
  // A: silence, then a hint of the motif and a lead-in to B (the C#4 resolves to the D4 of bar 9)
  'r:8', 'r:8', 'r:8', 'r:8',
  'D4:2 F4:1 A4:1 Bb4:4', 'A4:6 r:2', 'r:2 E4:2 D4:4', 'E4:4 C#4:4',
  // B: the main theme
  'D4:2 F4:1 A4:1 Bb4:3 A4:1', 'G4:2 F4:1 E4:1 F4:4', 'D4:2 F4:1 A4:1 C5:3 Bb4:1', 'A4:2 G4:1 E4:1 A4:4',
  'D5:3 C5:1 Bb4:2 A4:2', 'G4:2 Bb4:1 A4:1 F4:4', 'E4:2 F4:1 G4:1 A4:2 E4:2', 'D4:8',
  // C: the motif in F, then a climb to the peak (G5 over C)
  'F4:2 A4:1 C5:1 D5:3 C5:1', 'G4:2 A4:1 G4:1 E4:4', 'F4:2 A4:1 D5:1 E5:3 D5:1', 'C5:2 Bb4:1 A4:1 Bb4:4',
  'C5:3 D5:1 C5:2 A4:2', 'Bb4:3 C5:1 D5:2 F5:2', 'E5:4 D5:2 F5:2', 'G5:8',
  // D: the motif up an octave over Bb (a new harmony for the old tune), then the wind-down (same tail as A, so the loop is seamless)
  'D5:2 F5:1 A5:1 Bb5:4', 'A5:4 G5:2 E5:2', 'F5:8', 'E5:4 D5:4',
  'r:8', 'r:8', 'r:2 E4:2 D4:4', 'E4:4 C#4:4',
];

/** Countermelody (section C only): long notes under the lead. */
const COUNTER: readonly [number, string][] = [
  [17, 'A3'], [18, 'G3'], [19, 'A3'], [20, 'F3'], [21, 'A3'], [22, 'Bb3'], [23, 'D4'], [24, 'E4'],
];

const NAMES: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "Bb4" -> 70, "C#4" -> 61; throws on a malformed name (a score typo fails the tests). */
export function noteNumber(name: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note name ${name}`);
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NAMES[m[1]!]! + acc;
}

export function hz(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

const sectionOf = (bar: number): SectionId => (bar >= 25 ? 'D' : bar >= 17 ? 'C' : bar >= 9 ? 'B' : 'A');

/** Bass rhythm per section (eighth offsets, semitone offsets, eighth lengths, velocities). */
function bassBar(bar: number): [number, number, number, number][] {
  const s = sectionOf(bar);
  if (s === 'A') return bar === 8 ? [[0, 0, 4, 0.7], [4, 12, 2, 0.55], [6, 0, 2, 0.6]] : [[0, 0, 8, 0.7]];
  if (s === 'B') {
    const offs = [0, 0, 12, 0, 0, 0, 7, 12];
    const vels = [0.9, 0.5, 0.7, 0.5, 0.8, 0.5, 0.65, 0.55];
    return offs.map((o, i) => [i, o, 1, vels[i]!] as [number, number, number, number]);
  }
  if (s === 'C') return [[0, 0, 3, 0.9], [3, 0, 3, 0.75], [6, 12, 2, 0.7]]; // 3+3+2
  return bar <= 28 ? [[0, 0, 4, 0.7], [4, 7, 4, 0.6]] : [[0, 0, 8, 0.6]];
}

/** Arpeggio patterns over the voicing an octave up (indexes into its 4 notes). */
const ARP_A = [0, 2, 1, 3, 2, 1, 3, 2];
const ARP_B = [0, 2, 3, 2, 1, 2, 3, 2];
const ARP_C = [3, 2, 0, 2, 3, 2, 1, 2];

function compile(): ThemeEvent[] {
  const ev: ThemeEvent[] = [];
  const push = (beat: number, dur: number, layer: ThemeLayer, note: number, vel: number): void => {
    ev.push(Object.freeze({ beat, dur, layer, note, vel }));
  };
  const E = 0.5; // an eighth, in beats

  for (const s of SECTIONS) push((s.bar - 1) * 4, 0, 'tone', s.cutoff, 1);

  // pad + bass + arp follow the chords
  let beat = 0;
  for (const [name, bass, beats] of CHORDS) {
    const v = VOICING[name];
    if (!v) throw new Error(`no voicing ${name}`);
    const bar = Math.floor(beat / 4) + 1;
    const sec = sectionOf(bar);
    const padVel = sec === 'C' ? 0.8 : sec === 'A' ? 0.65 : 0.72;
    for (const n of v) push(beat, beats, 'pad', n, padVel);
    if (beat % 4 === 0) {
      for (const [at, off, len, vel] of bassBar(bar)) push(beat + at * E, len * E, 'bass', bass + off, vel);
      const tones = [...v].map((n) => n + 12).sort((a, b) => a - b);
      if (sec === 'A' && bar >= 3) ARP_A.forEach((i, k) => push(beat + k * E, E, 'arp', tones[i]!, k % 2 ? 0.35 : 0.5));
      else if (sec === 'B') ARP_B.forEach((i, k) => push(beat + k * E, E, 'arp', tones[i]!, k % 2 ? 0.25 : 0.38));
      else if (sec === 'C') ARP_C.forEach((i, k) => push(beat + k * E, E, 'arp', tones[i]!, k % 2 ? 0.3 : 0.42));
      else if (sec === 'D' && bar <= 28) ARP_A.forEach((i, k) => push(beat + k * E, E, 'arp', tones[i]!, k % 2 ? 0.25 : 0.36));
      else if (sec === 'D') [0, 2, 1, 3].forEach((i, k) => push(beat + k, 1, 'arp', tones[i]!, 0.34 - (bar - 29) * 0.05));
    }
    beat += beats;
  }
  if (beat !== LOOP_BEATS) throw new Error(`chords cover ${beat} beats, not ${LOOP_BEATS}`);

  // lead
  LEAD.forEach((line, i) => {
    let at = i * 4;
    for (const tok of line.split(' ')) {
      const [name, len] = tok.split(':');
      const d = Number(len) * E;
      if (name !== 'r') push(at, d, 'lead', noteNumber(name!), i >= 16 && i < 24 ? 0.85 : 0.75);
      at += d;
    }
    if (at !== (i + 1) * 4) throw new Error(`lead bar ${i + 1} has ${at - i * 4} beats`);
  });
  for (const [bar, name] of COUNTER) push((bar - 1) * 4, 4, 'counter', noteNumber(name), 0.6);

  // percussion and transitions (restrained: soft kick, quiet hats, one swell into each section)
  for (let bar = 1; bar <= THEME.bars; bar++) {
    const b0 = (bar - 1) * 4;
    const sec = sectionOf(bar);
    if (sec === 'B') {
      for (const k of [0, 4]) push(b0 + k * E, E, 'kick', 36, k === 0 ? 0.85 : 0.65);
      for (const k of [1, 3, 5, 7]) push(b0 + k * E, E, 'hat', 0, 0.5);
    } else if (sec === 'C') {
      for (const k of [0, 3, 4]) push(b0 + k * E, E, 'kick', 36, k === 3 ? 0.5 : 0.85);
      for (const k of [2, 6]) push(b0 + k * E, E, 'snap', 0, 0.5);
      for (let k = 0; k < 8; k++) push(b0 + k * E, E, 'hat', 0, k % 2 ? 0.55 : 0.3);
    } else if (sec === 'D' && bar <= 28) {
      push(b0, E, 'kick', 36, 0.6);
      for (const k of [3, 7]) push(b0 + k * E, E, 'hat', 0, 0.35);
    }
  }
  for (const bar of [8, 16, 24]) push((bar - 1) * 4, 4, 'swell', 0, bar === 24 ? 0.9 : 0.7);
  for (const [bar, vel] of [[1, 0.6], [9, 0.8], [17, 0.9], [25, 0.55]] as const) push((bar - 1) * 4, 4, 'boom', 31, vel);

  // stable order: by time, then a fixed layer order (so equal-time events never shuffle)
  const order: readonly ThemeLayer[] = ['tone', 'boom', 'bass', 'pad', 'counter', 'lead', 'arp', 'kick', 'snap', 'hat', 'swell'];
  return ev.sort((a, b) => a.beat - b.beat || order.indexOf(a.layer) - order.indexOf(b.layer) || a.note - b.note);
}

/** Every event of one loop, in time order. Built once, frozen. */
export const THEME_EVENTS: readonly ThemeEvent[] = /* @__PURE__ */ Object.freeze(compile());

export function sectionAt(beat: number): SectionId {
  const b = ((beat % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS;
  return sectionOf(Math.floor(b / 4) + 1);
}
