/**
 * Finale P3: the opening cinematic's shell (entry chunk, DOM). It owns the
 * overlay over the home page from the first frame, before the cinematic chunk
 * exists: a dark cover, SKIP INTRO, a polite status line and (only when the
 * chunk is slow) an indeterminate LOADING line. Inline styles only: nothing is
 * added to the global stylesheet.
 *
 * Exactly one resolution (createIntroGate): completion, SKIP INTRO (button or
 * Escape, once it is shown), a load or render failure, the load watchdog, or a
 * cancel (a mode started). Resolving disposes the cinematic, removes the
 * overlay, clears the home page's transform and calls onDone once; a chunk
 * that arrives after that is ignored. The shell never touches storage, music
 * or the title's controls: the host does that in onDone.
 */
import { browserSchedulers, DisposableScope } from '../lifecycle/scope.ts';
import type { SpriteCache } from '../../render/sprite/spriteCache.ts';
import { createIntroGate, type CinematicDebug, type CinematicHandle, type CinematicModule, type CinematicPhase, type IntroOutcome, type IntroState } from './introPolicy.ts';

export interface IntroShellDeps {
  /** The host root (.galaxia-root): the overlay is appended here, over the title screen. */
  readonly root: HTMLElement;
  /** The live home page (TitleScreen root). */
  readonly target: HTMLElement;
  readonly sprites: SpriteCache;
  readonly hero: string;
  readonly seed: number;
  readonly reduced: boolean;
  readonly load: () => Promise<CinematicModule>;
  /** Exactly once, after the overlay is gone and the home page's transform is cleared. */
  readonly onDone: (outcome: IntroOutcome) => void;
}

export interface IntroDebug {
  readonly state: IntroState;
  readonly outcome: IntroOutcome | null;
  readonly skippable: boolean;
  readonly phase: CinematicPhase;
  readonly overlay: boolean;
  readonly listeners: number;
  readonly timers: number;
  readonly loads: number;
  readonly status: string;
  readonly cinematic: CinematicDebug | null;
}

export interface IntroRun {
  readonly active: boolean;
  /** SKIP INTRO (ignored before the button is shown). Always safe to repeat. */
  skip(): void;
  /** The home page went away: end without the handoff. */
  cancel(): void;
  debug(): IntroDebug;
}

const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

export function runIntro(d: IntroShellDeps): IntroRun {
  const scope = new DisposableScope();
  const overlay = document.createElement('div');
  overlay.className = 'intro-overlay';
  overlay.style.cssText = 'position:absolute;inset:0;z-index:70;overflow:hidden;background:#030409;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent';
  const status = document.createElement('p');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const loading = document.createElement('p');
  loading.className = 'intro-loading';
  loading.hidden = true;
  loading.textContent = 'LOADING…';
  loading.style.cssText = `position:absolute;left:max(16px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom));margin:0;color:#8d96b8;font:700 12px/44px ${FONT};letter-spacing:.18em`;
  loading.setAttribute('aria-hidden', 'true');
  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'intro-skip';
  skipBtn.textContent = 'SKIP INTRO';
  skipBtn.hidden = true;
  skipBtn.style.cssText = `position:absolute;z-index:1;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));min-width:44px;min-height:44px;padding:0 18px;border:1px solid #5cefff;border-radius:6px;background:rgba(6,7,15,.78);color:#eaffff;font:700 13px/1 ${FONT};letter-spacing:.16em;cursor:pointer`;
  overlay.append(status, loading, skipBtn);
  d.root.append(overlay);
  d.root.dataset['intro'] = 'loading';
  delete d.root.dataset['introOutcome'];

  let handle: CinematicHandle | null = null;
  /** The cinematic's last debug snapshot, taken after its dispose (QA reads loops / listeners = 0). */
  let final: CinematicDebug | null = null;
  let phase: CinematicPhase = 'idle';
  let loads = 0;
  let pulse: Animation | null = null;
  const say = (text: string): void => {
    if (status.textContent !== text) status.textContent = text;
  };

  const finish = (outcome: IntroOutcome): void => {
    const h = handle;
    handle = null;
    try {
      h?.dispose();
      if (h) final = h.debug();
    } catch {
      /* a broken cinematic must not keep the home page covered */
    }
    scope.dispose();
    pulse?.cancel();
    d.target.style.transform = '';
    d.target.style.transformOrigin = '';
    d.target.style.willChange = '';
    d.root.dataset['intro'] = 'done';
    d.root.dataset['introOutcome'] = outcome;
    const fade = outcome === 'skipped' && !d.reduced && typeof overlay.animate === 'function';
    if (fade) {
      // the cover fades over the (already released) home page; it no longer takes any input
      overlay.style.pointerEvents = 'none';
      overlay.style.background = '#030409'; // the cinematic's canvas is gone: fade from the dark cover
      skipBtn.remove();
      status.remove();
      const a = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
      a.onfinish = () => overlay.remove();
      a.oncancel = () => overlay.remove();
    } else {
      overlay.remove();
    }
    d.onDone(outcome);
  };

  const gate = createIntroGate(browserSchedulers(), {
    onSkippable: () => {
      skipBtn.hidden = false;
      // the only control on screen: focus it so Enter / Space skip and screen readers announce it
      if (!overlay.contains(document.activeElement)) skipBtn.focus({ preventScroll: true });
    },
    onSlow: () => {
      loading.hidden = false;
      say('Loading the opening cinematic.');
      if (!d.reduced && typeof loading.animate === 'function') {
        pulse = loading.animate([{ opacity: 0.35 }, { opacity: 1 }, { opacity: 0.35 }], { duration: 1600, iterations: Infinity });
      }
    },
    onResolve: finish,
  });

  const skip = (): boolean => gate.skip();
  skipBtn.addEventListener('click', () => void skip()); // element-owned: removed with the overlay
  scope.on<KeyboardEvent>(
    window,
    'keydown',
    (e) => {
      if (e.code !== 'Escape' || e.repeat) return;
      if (gate.skip()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
  scope.timeout(() => say('Opening cinematic. SKIP INTRO goes straight to the home page.'), 50);

  gate.start();
  loads += 1;
  d.load().then(
    (m) => {
      if (!gate.loaded()) return; // skipped, timed out or cancelled meanwhile: a stale load does nothing
      loading.hidden = true;
      pulse?.cancel();
      try {
        handle = m.createOpeningCinematic({
          host: overlay,
          target: d.target,
          sprites: d.sprites,
          hero: d.hero,
          seed: d.seed,
          reduced: d.reduced,
          onPhase: (p) => {
            phase = p;
            if (p === 'display') say("The home page is on the ship's display.");
          },
          onComplete: () => gate.complete(d.reduced),
          onError: (err) => {
            console.error(err);
            gate.fail();
          },
        });
        if (gate.state === 'playing') {
          d.root.dataset['intro'] = 'playing';
          // the canvas paints its own (opaque) scene from here; the cover must not hide the home page behind the display
          overlay.style.background = 'transparent';
        }
      } catch (err) {
        console.error(err);
        gate.fail();
      }
    },
    () => gate.fail(),
  );

  let clicking = false;
  const click = (): void => {
    if (clicking) return; // the second press of a double-tap lands while the first task is running
    clicking = true;
    Promise.resolve()
      .then(skip)
      .finally(() => (clicking = false));
  };
  return {
    get active() {
      return gate.state !== 'resolved';
    },
    skip: click,
    cancel: () => gate.cancel(),
    debug: () => ({
      state: gate.state,
      outcome: gate.outcome,
      skippable: gate.skippable,
      phase,
      overlay: overlay.isConnected,
      listeners: scope.activeListeners,
      timers: gate.timers,
      loads,
      status: status.textContent ?? '',
      cinematic: handle?.debug() ?? final,
    }),
  };
}
