/**
 * Admin login (P04 refinement). Pure: no DOM, no storage, no clock and no
 * unseeded randomness (callers pass the time and a seed).
 *
 *   isAdminPassword   the gate: exactly one ASCII space (U+0020), compared
 *                     as received (never trimmed or normalised)
 *   createGlitch      the unstable operator name shown on the login screen:
 *                     drifting substitutions, noise bursts and short
 *                     "decoding" runs that resolve into a pseudo handle
 *   revealSlots       the frozen name resolving glyph by glyph into the
 *                     owner identity
 *   revealTimeline    every animated value of the identity reveal at a
 *                     given elapsed time (full and reduced motion)
 *
 * Client-side only: the password is in the shipped JavaScript. It is a
 * stylised hidden gate, not authentication.
 */

/** The single accepted password: one ordinary ASCII space. */
const PASSWORD = '\u0020';

/** Exactly one U+0020. Empty, two spaces, a space with anything else, tabs, NBSP and every other whitespace fail. */
export function isAdminPassword(value: string): boolean {
  return value === PASSWORD;
}

export const OWNER_IDENTITY = 'G.Vaishanth';
export const WELCOME_LINE = 'WELCOME, MASTER';

/* ------------------------------------------------------------- randomness */

/** mulberry32: a small seeded generator (deterministic for tests). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const GLYPHS = `${LETTERS}${DIGITS}${LETTERS}${DIGITS}/_-.:#`;
/** Overlay / strike / underline combining marks (one per character at most: legible, no vertical towers). */
export const GLITCH_MARKS: readonly string[] = Object.freeze(['\u0337', '\u0338', '\u0335', '\u0334', '\u0336', '\u035F', '\u035E', '\u0332']);
/** Pseudo handles a decoding run resolves into (L letter, D digit; anything else literal). */
const HANDLE_TEMPLATES: readonly string[] = Object.freeze(['LDL-DLD', '//LLL_DD', 'LLLDLL_D', 'L.LLL-DDD', 'DLL//LDL', 'LLLL_DD', 'L-DLDL.D', 'LLDLLL_D']);

const pick = (rng: () => number, s: string): string => s[Math.floor(rng() * s.length)] ?? s[0]!;
const pickMark = (rng: () => number): string => GLITCH_MARKS[Math.floor(rng() * GLITCH_MARKS.length)] ?? '';

/** One character cell of the displayed name. */
export interface Slot {
  readonly ch: string;
  /** A combining mark drawn on the character ('' or one mark). */
  readonly mark: string;
}

export const renderSlots = (slots: readonly Slot[]): string => slots.map((s) => s.ch + s.mark).join('');
/** The characters without marks. */
export const baseOf = (slots: readonly Slot[]): string => slots.map((s) => s.ch).join('');

/** Fixed cell count: the display width never changes (shorter handles pad with spaces). Same length as the identity. */
export const NAME_CELLS = OWNER_IDENTITY.length;

/** Update intervals (ms): the text changes at most this often (bounded: <= 20 changes per second). */
export const GLITCH_TIMING = Object.freeze({ driftMs: 85, noiseMs: 50, decodeMs: 70, holdMs: 120 });

function handle(rng: () => number): string {
  const t = HANDLE_TEMPLATES[Math.floor(rng() * HANDLE_TEMPLATES.length)]!;
  const s = [...t].map((c) => (c === 'L' ? pick(rng, LETTERS) : c === 'D' ? pick(rng, DIGITS) : c)).join('');
  const pad = Math.max(0, NAME_CELLS - s.length);
  // centred in the fixed field (the display box never changes width)
  return (' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(Math.ceil(pad / 2))).slice(0, NAME_CELLS);
}

export type GlitchMode = 'drift' | 'noise' | 'decode' | 'hold';

export interface Glitch {
  /** Advance to `now` (ms). Returns true when the displayed text changed (at most once per update interval). */
  step(now: number): boolean;
  /** A short heavy-noise burst (a rejected password). */
  burst(now: number): void;
  readonly slots: readonly Slot[];
  readonly text: string;
  readonly mode: GlitchMode;
  /** 0..1: how unstable the name currently is (drives the CSS distortion). */
  readonly intensity: number;
  /** Text changes so far (tests: the name keeps changing). */
  readonly changes: number;
}

/**
 * The unstable operator name. Modes cycle: drift (a few cells change, light
 * marks) -> sometimes a noise burst -> a decoding run (cells lock one by one
 * into a pseudo handle) -> a short hold -> drift again. A slow random walk
 * varies the intensity so it never settles into a fixed rhythm.
 */
export function createGlitch(seed: number, start = 0): Glitch {
  const rng = seededRng(seed);
  let slots: Slot[] = Array.from({ length: NAME_CELLS }, () => ({ ch: pick(rng, GLYPHS), mark: rng() < 0.3 ? pickMark(rng) : '' }));
  let mode: GlitchMode = 'drift';
  let modeUntil = start + 900 + rng() * 900;
  let next = start;
  let drift = 0.35;
  let target = '';
  let lockAt: number[] = [];
  let changes = 0;
  const interval = (): number => GLITCH_TIMING[`${mode}Ms`];

  const enter = (m: GlitchMode, now: number): void => {
    mode = m;
    if (m === 'drift') modeUntil = now + 1100 + rng() * 1500;
    else if (m === 'noise') modeUntil = now + 220 + rng() * 320;
    else if (m === 'hold') modeUntil = now + 450 + rng() * 650;
    else {
      target = handle(rng);
      const span = 650 + rng() * 450;
      // cells lock roughly left to right with jitter (a decoder sweeping across)
      lockAt = Array.from({ length: NAME_CELLS }, (_, i) => now + (span * (i + rng() * 1.6)) / (NAME_CELLS + 1.6));
      modeUntil = now + span + 60;
    }
  };

  const update = (now: number): void => {
    drift = Math.min(0.85, Math.max(0.15, drift + (rng() - 0.5) * 0.18));
    if (mode === 'drift') {
      const n = 1 + Math.floor(rng() * (1 + drift * 3));
      const copy = [...slots];
      for (let k = 0; k < n; k++) {
        const i = Math.floor(rng() * NAME_CELLS);
        copy[i] = { ch: rng() < 0.08 ? ' ' : pick(rng, GLYPHS), mark: rng() < 0.18 + drift * 0.3 ? pickMark(rng) : '' };
      }
      // marks fade on untouched cells
      slots = copy.map((s) => (s.mark && rng() < 0.25 ? { ch: s.ch, mark: '' } : s));
    } else if (mode === 'noise') {
      slots = slots.map((s) => (rng() < 0.55 + drift * 0.35 ? { ch: pick(rng, GLYPHS), mark: rng() < 0.6 ? pickMark(rng) : '' } : s));
    } else if (mode === 'decode') {
      slots = slots.map((_, i) => (now >= lockAt[i]! ? { ch: target[i]!, mark: rng() < 0.12 ? pickMark(rng) : '' } : { ch: pick(rng, GLYPHS), mark: rng() < 0.45 ? pickMark(rng) : '' }));
    } else {
      // hold: the handle stays readable; an occasional mark flickers on one cell
      slots = slots.map((s) => ({ ch: s.ch, mark: rng() < 0.07 ? pickMark(rng) : '' }));
    }
  };

  return {
    step(now) {
      if (now < next) return false;
      if (now >= modeUntil) {
        if (mode === 'drift') enter(rng() < 0.35 ? 'noise' : 'decode', now);
        else if (mode === 'noise') enter(rng() < 0.6 ? 'decode' : 'drift', now);
        else if (mode === 'decode') enter('hold', now);
        else enter(rng() < 0.5 ? 'noise' : 'drift', now);
      }
      const before = renderSlots(slots);
      update(now);
      next = now + interval();
      const changed = renderSlots(slots) !== before;
      if (changed) changes += 1;
      return changed;
    },
    burst(now) {
      enter('noise', now);
      modeUntil = now + 420;
      next = now;
    },
    get slots() {
      return slots;
    },
    get text() {
      return renderSlots(slots);
    },
    get mode() {
      return mode;
    },
    get intensity() {
      return mode === 'noise' ? 0.9 : mode === 'decode' ? 0.55 : mode === 'hold' ? 0.12 : drift * 0.6;
    },
    get changes() {
      return changes;
    },
  };
}

/* ---------------------------------------------------------------- reveal */

/** The order cells resolve in: outside-in toward the centre, with a little seeded jitter. */
export function revealOrder(seed: number, n = NAME_CELLS): number[] {
  const rng = seededRng(seed);
  const mid = (n - 1) / 2;
  return Array.from({ length: n }, (_, i) => ({ i, k: Math.abs(i - mid) * -1 + rng() * 1.2 }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.i);
}

/**
 * The name at reveal progress `t` (0..1): cell `order[j]` locks onto the
 * target at t = 0.1 + 0.8 * j / (n - 1). Unlocked cells keep scrambling with
 * fewer marks as t grows; at t >= 1 the result is exactly `target`, no marks.
 */
export function revealSlots(frozen: readonly Slot[], target: string, t: number, order: readonly number[], rng: () => number): Slot[] {
  const n = target.length;
  if (t >= 1) return [...target].map((ch) => ({ ch, mark: '' }));
  const lockT = new Array<number>(n).fill(1);
  order.forEach((cell, j) => {
    if (cell < n) lockT[cell] = 0.1 + (0.8 * j) / Math.max(1, n - 1);
  });
  return Array.from({ length: n }, (_, i) => {
    if (t >= lockT[i]!) return { ch: target[i]!, mark: t - lockT[i]! < 0.06 && rng() < 0.5 ? pickMark(rng) : '' };
    if (t <= 0) return frozen[i] ?? { ch: ' ', mark: '' };
    return { ch: pick(rng, GLYPHS), mark: rng() < 0.55 * (1 - t) ? pickMark(rng) : '' };
  });
}

/** Phase boundaries (ms from the successful Enter). Adjust here; tests check the ordering, not the numbers. */
export const REVEAL_TIMING = Object.freeze({
  full: Object.freeze({ lockEnd: 380, cardFadeEnd: 650, moveStart: 380, moveEnd: 1500, nameIn: 1300, flyerOut: 1650, resolveStart: 1300, resolveEnd: 2350, welcomeStart: 2050, welcomeEnd: 2650, arrive: 2900, outStart: 3650, total: 4450 }),
  reduced: Object.freeze({ lockEnd: 300, cardFadeEnd: 600, moveStart: 300, moveEnd: 700, nameIn: 500, flyerOut: 700, resolveStart: 500, resolveEnd: 1500, welcomeStart: 1300, welcomeEnd: 1700, arrive: 1950, outStart: 2550, total: 3150 }),
});

export interface RevealFrame {
  /** The login card (title, password, captions) fading out. */
  readonly card: number;
  /** The frozen name in its field jittering before it lifts off (0..1, 0 after the lock phase). */
  readonly lockShake: number;
  /** The travelling name: 0..1 along its path (eased), its opacity, scale and blur (px). */
  readonly flyer: { readonly p: number; readonly opacity: number; readonly scale: number; readonly blur: number; readonly spacing: number };
  /** The central identity. */
  readonly name: { readonly opacity: number; readonly scale: number; readonly blur: number; readonly spacing: number; readonly resolve: number };
  readonly welcome: { readonly opacity: number; readonly dy: number; readonly spacing: number };
  /** Whole overlay opacity (fading out onto the hangar). */
  readonly overlay: number;
  readonly arrive: boolean;
  readonly done: boolean;
}

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const span = (t: number, a: number, b: number): number => clamp01((t - a) / Math.max(1, b - a));
const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number): number => 1 - (1 - x) ** 3;
const lerp = (a: number, b: number, x: number): number => a + (b - a) * x;

/**
 * Every animated value at `ms` after the successful Enter. Full motion: the
 * name is pulled to the centre while compressing, then resolves larger and
 * sharp. Reduced motion: no travel or scale, only fades and the glyph
 * resolution.
 */
export function revealTimeline(ms: number, reduced: boolean): RevealFrame {
  const T = reduced ? REVEAL_TIMING.reduced : REVEAL_TIMING.full;
  const move = easeInOut(span(ms, T.moveStart, T.moveEnd));
  const nameIn = easeOut(span(ms, T.nameIn, T.nameIn + 350));
  const resolve = span(ms, T.resolveStart, T.resolveEnd);
  const settle = easeOut(span(ms, T.nameIn, T.resolveEnd));
  const welcome = easeOut(span(ms, T.welcomeStart, T.welcomeEnd));
  const out = easeInOut(span(ms, T.outStart, T.total));
  return {
    card: 1 - easeOut(span(ms, 0, T.cardFadeEnd)),
    lockShake: ms < T.lockEnd ? 1 - span(ms, 0, T.lockEnd) * 0.5 : 0,
    flyer: reduced
      ? { p: 0, opacity: 1 - easeOut(span(ms, T.moveStart, T.flyerOut)), scale: 1, blur: 0, spacing: 0 }
      : {
          p: move,
          opacity: 1 - easeOut(span(ms, T.nameIn + 50, T.flyerOut)),
          scale: lerp(1, 0.58, move),
          blur: Math.sin(Math.PI * move) * 1.6,
          spacing: lerp(0.12, -0.02, move),
        },
    name: reduced
      ? { opacity: nameIn, scale: 1, blur: 0, spacing: 0.06, resolve }
      : { opacity: nameIn, scale: lerp(0.8, 1, settle), blur: lerp(5, 0, settle), spacing: lerp(0.42, 0.06, settle), resolve },
    welcome: { opacity: welcome, dy: reduced ? 0 : lerp(8, 0, welcome), spacing: reduced ? 0.38 : lerp(0.62, 0.38, welcome) },
    overlay: 1 - out,
    arrive: ms >= T.arrive,
    done: ms >= T.total,
  };
}
