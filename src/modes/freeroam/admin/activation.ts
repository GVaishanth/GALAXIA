/**
 * Admin Access activation (P04). Pure: no DOM, no storage, no clock (callers
 * pass event times), so both detectors are deterministic under test.
 *
 * Admin Access is a hidden owner sandbox (docs/development/ADMIN_ACCESS.md).
 * Nothing in the player-facing UI mentions it; these detectors are the only
 * intended way in. They are concealment, not security: anyone can read the
 * shipped JavaScript. No password, token or query parameter is involved.
 *
 * Desktop: a deliberate key sequence, every key pressed with Shift held and
 * no Ctrl / Alt / Meta (so no browser shortcut is involved). The keys are
 * physical key codes, chosen so none of them is a menu or map key (arrows,
 * WASD, Enter, Space, R, [ ], Esc, M, I) or a default flight binding; the
 * detector only observes, it never consumes a key that is not part of a
 * completed sequence. A wrong key, a released Shift, auto-repeat or a pause
 * longer than `stepMs` resets it; the whole sequence must fit in `totalMs`.
 *
 * Touch: press and hold the GALAXIA logo on the title screen, release, then
 * tap it several times quickly. Moving the finger, a second finger or a slow
 * tap cancels, so scrolling, ordinary taps and the starfield look-around never
 * trigger it.
 *
 * The title screen lives in the main bundle and Free Roam loads on demand, so
 * a title-screen activation is handed over as a one-shot request that the
 * next Free Roam instance takes at start-up (and that expires on its own).
 * The request lives in module scope only: nothing is put on the global object.
 */

/** Physical keys, typed with Shift held: G L X 0 4. */
export const ADMIN_SEQUENCE: readonly string[] = Object.freeze(['KeyG', 'KeyL', 'KeyX', 'Digit0', 'Digit4']);
export const ADMIN_KEY_TIMING = Object.freeze({ stepMs: 1500, totalMs: 6000 });

/** Modifier keys alone never advance or reset the sequence. */
const MODIFIER_CODES: ReadonlySet<string> = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'Fn']);

export interface KeyStroke {
  readonly code: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  /** Event time in ms (any monotonic clock). */
  readonly t: number;
}

/** The stroke of a keydown event (one copy for the title screen and Free Roam). */
export const keyStroke = (e: KeyboardEvent): KeyStroke => ({ code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat, t: e.timeStamp });

export interface SequenceDetector {
  /** Feed one keydown; true exactly once, on the key that completes the sequence. */
  feed(k: KeyStroke): boolean;
  reset(): void;
  /** Keys matched so far (0 = idle). */
  readonly progress: number;
}

export function createSequenceDetector(seq: readonly string[] = ADMIN_SEQUENCE, timing: { readonly stepMs: number; readonly totalMs: number } = ADMIN_KEY_TIMING): SequenceDetector {
  let n = 0;
  let startedAt = 0;
  let lastAt = 0;
  const reset = (): void => {
    n = 0;
  };
  return {
    feed(k) {
      if (MODIFIER_CODES.has(k.code)) return false;
      if (k.repeat) {
        reset();
        return false;
      }
      const clean = k.shiftKey && !k.ctrlKey && !k.altKey && !k.metaKey;
      if (n > 0 && (k.t - lastAt > timing.stepMs || k.t - startedAt > timing.totalMs)) reset();
      if (clean && k.code === seq[n]) {
        if (n === 0) startedAt = k.t;
        n += 1;
        lastAt = k.t;
        if (n === seq.length) {
          reset();
          return true;
        }
        return false;
      }
      // a wrong key: start over (it may itself be the first key of a new attempt)
      reset();
      if (clean && k.code === seq[0]) {
        n = 1;
        startedAt = lastAt = k.t;
      }
      return false;
    },
    reset,
    get progress() {
      return n;
    },
  };
}

/* ------------------------------------------------------------------ touch */

export const ADMIN_GESTURE = Object.freeze({
  /** The opening press must last at least this long. */
  holdMs: 1500,
  /** ...and not much longer (a forgotten finger is not a gesture). */
  holdMaxMs: 6000,
  /** Quick taps after the hold. */
  taps: 4,
  /** A tap is a press shorter than this. */
  tapMaxMs: 350,
  /** All taps must land within this time after the hold ends. */
  windowMs: 2500,
  /** Moving further than this (CSS px) cancels: it is a drag or a scroll. */
  slopPx: 16,
});

export interface GestureDetector {
  down(id: number, x: number, y: number, t: number): void;
  move(id: number, x: number, y: number): void;
  /** True exactly once, on the release that completes the gesture. */
  up(id: number, t: number): boolean;
  cancel(): void;
  readonly stage: 'idle' | 'holding' | 'tapping';
}

export function createGestureDetector(g: typeof ADMIN_GESTURE = ADMIN_GESTURE): GestureDetector {
  let stage: 'idle' | 'holding' | 'tapping' = 'idle';
  /** The pointer currently pressed (one at a time), where and when it went down. */
  let press: { id: number; x: number; y: number; t: number } | null = null;
  let holdEndedAt = 0;
  let taps = 0;
  const cancel = (): void => {
    stage = 'idle';
    press = null;
    taps = 0;
  };
  return {
    down(id, x, y, t) {
      if (press) {
        cancel(); // a second finger: not this gesture
        return;
      }
      if (stage === 'tapping' && t - holdEndedAt > g.windowMs) cancel();
      press = { id, x, y, t };
      if (stage === 'idle') stage = 'holding';
    },
    move(id, x, y) {
      if (!press || press.id !== id) return;
      if (Math.hypot(x - press.x, y - press.y) > g.slopPx) cancel();
    },
    up(id, t) {
      if (!press || press.id !== id) return false;
      const held = t - press.t;
      press = null;
      if (stage === 'holding') {
        if (held >= g.holdMs && held <= g.holdMaxMs) {
          stage = 'tapping';
          holdEndedAt = t;
          taps = 0;
        } else cancel();
        return false;
      }
      if (stage === 'tapping') {
        if (held > g.tapMaxMs || t - holdEndedAt > g.windowMs) {
          cancel();
          return false;
        }
        taps += 1;
        if (taps >= g.taps) {
          cancel();
          return true;
        }
      }
      return false;
    },
    cancel,
    get stage() {
      return stage;
    },
  };
}

/* ---------------------------------------------------------------- hand-off */

/** A title-screen activation must be taken by Free Roam within this time, or it lapses. */
export const ADMIN_REQUEST_TTL_MS = 15000;

let pendingRequestAt: number | null = null;

/** The title screen recognised the gesture / sequence: the next Free Roam start opens Admin Access. */
export function requestAdminLaunch(now: number): void {
  pendingRequestAt = now;
}

/** One-shot: true when a fresh request is waiting (it is consumed either way). */
export function takeAdminRequest(now: number): boolean {
  const at = pendingRequestAt;
  pendingRequestAt = null;
  return at !== null && now - at >= 0 && now - at <= ADMIN_REQUEST_TTL_MS;
}

/** Drop a pending request (e.g. the player chose Classic instead). */
export function dropAdminRequest(): void {
  pendingRequestAt = null;
}
