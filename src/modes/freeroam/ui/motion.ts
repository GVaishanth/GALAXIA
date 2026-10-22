/**
 * UI motion (Prompt 12): one small helper over the Web Animations API for the
 * DOM interface (panels, notice cards, tabs, the recovery screen). Canvas keeps
 * every world animation (bursts, wrecks, the arrival ring).
 *
 * Contract:
 *  - presentation only: nothing waits on an animation and no gameplay reads
 *    one; the final state is always set first (the element is already where
 *    it ends), and the animation only plays *from* an offset back to it, so a
 *    cancelled or skipped animation leaves exactly the same result;
 *  - reduced motion (OS setting or the game's own preference): nothing plays;
 *  - bounded: one running animation per element and channel (a new one
 *    cancels the old), and cancelAll() stops everything (panel close, mode
 *    dispose), so `document.getAnimations()` is empty afterwards;
 *  - short: every preset is 120 to 260 ms.
 *
 * The `animate` function is injected, so unit tests use a fake.
 */

export interface AnimationLike {
  cancel(): void;
  onfinish: ((this: AnimationLike, ev: unknown) => unknown) | null;
  oncancel?: ((this: AnimationLike, ev: unknown) => unknown) | null;
}

export type AnimateFn = (target: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => AnimationLike;

export type MotionPreset = 'enter' | 'rise' | 'pop' | 'flash' | 'slide' | 'shake' | 'fade';

/** Keyframes and timing per preset: each starts away from the resting state and ends on it. */
export const PRESETS: Readonly<Record<MotionPreset, { readonly frames: Keyframe[]; readonly ms: number; readonly easing: string }>> = Object.freeze({
  /** Panels and screens: a short fade and lift. */
  enter: { frames: [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], ms: 160, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
  /** Notice cards: drop in from above. */
  rise: { frames: [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], ms: 180, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
  /** Something gained (an install, a completed mission): a small scale settle. */
  pop: { frames: [{ transform: 'scale(1.06)' }, { transform: 'none' }], ms: 200, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
  /** A value changed (objective progress, a cargo change): a brief highlight. */
  flash: { frames: [{ backgroundColor: 'rgba(92, 239, 255, 0.28)' }, { backgroundColor: 'rgba(92, 239, 255, 0)' }], ms: 260, easing: 'ease-out' },
  /** Tab switch: slide in from the side of the tab chosen. */
  slide: { frames: [{ opacity: 0, transform: 'translateX(var(--fr-slide, 10px))' }, { opacity: 1, transform: 'none' }], ms: 150, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
  /** Refused: a small horizontal nudge (no colour-only cue). */
  shake: { frames: [{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-2px)' }, { transform: 'none' }], ms: 180, easing: 'linear' },
  /** Plain fade (overlays over a busy scene). */
  fade: { frames: [{ opacity: 0 }, { opacity: 1 }], ms: 120, easing: 'linear' },
});

export interface MotionOptions {
  readonly animate: AnimateFn | null;
  /** Read on every call: the OS setting or the game's own preference. */
  readonly reduced: () => boolean;
}

export interface Motion {
  /** Play a preset on an element (a no-op under reduced motion or without WAAPI). */
  play(el: Element, preset: MotionPreset, o?: { readonly channel?: string; readonly delayMs?: number }): boolean;
  /** Cancel the running animations under a root (or all of them). */
  cancelWithin(root: Element): void;
  cancelAll(): void;
  /** Running animations started here. */
  active(): number;
  /** Animations started in total (diagnostics). */
  started(): number;
}

export function createMotion(o: MotionOptions): Motion {
  const running = new Map<string, { readonly el: Element; readonly anim: AnimationLike }>();
  const ids = new WeakMap<Element, number>();
  let nextId = 1;
  let started = 0;
  const keyOf = (el: Element, channel: string): string => {
    let id = ids.get(el);
    if (id === undefined) {
      id = nextId++;
      ids.set(el, id);
    }
    return `${id}:${channel}`;
  };
  const stop = (key: string): void => {
    const r = running.get(key);
    if (!r) return;
    running.delete(key);
    try {
      r.anim.cancel();
    } catch {
      /* already gone */
    }
  };
  return {
    play(el, preset, opt = {}) {
      if (!o.animate || o.reduced()) return false;
      const p = PRESETS[preset];
      const key = keyOf(el, opt.channel ?? 'main');
      stop(key);
      let anim: AnimationLike;
      try {
        anim = o.animate(el, p.frames, { duration: p.ms, easing: p.easing, delay: opt.delayMs ?? 0, fill: 'backwards' });
      } catch {
        return false; // an engine without the property: no motion, same result
      }
      started += 1;
      running.set(key, { el, anim });
      const done = (): void => {
        if (running.get(key)?.anim === anim) running.delete(key);
      };
      anim.onfinish = done;
      anim.oncancel = done;
      return true;
    },
    cancelWithin(root) {
      for (const [key, r] of [...running]) if (root === r.el || root.contains(r.el)) stop(key);
    },
    cancelAll() {
      for (const key of [...running.keys()]) stop(key);
    },
    active: () => running.size,
    started: () => started,
  };
}

/** The browser's WAAPI, when present (older engines: null, so nothing animates). */
export function browserAnimate(): AnimateFn | null {
  if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return null;
  return (target, keyframes, options) => target.animate(keyframes, options) as unknown as AnimationLike;
}
