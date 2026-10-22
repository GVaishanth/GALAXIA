/**
 * ModeController (DOM-free, unit-tested): the single owner of "which mode is
 * running". It serialises switches, drives the lifecycle in order
 * (init -> activate ... dispose), and guards against stale work:
 *
 *  - every launch starts a new session number; a lazy factory or async init()
 *    that resolves after the player already went back is disposed, not shown;
 *  - a mode's requestExit / fail callbacks are bound to its session and do
 *    nothing once that session ended (no late callback can affect the next mode);
 *  - exits are deferred (microtask) so a mode is never disposed in the middle
 *    of its own frame or click handler;
 *  - a failing init/activate/dispose never leaves the page without a menu.
 */
import type { GameMode, ModeContext, ModeId, ModeRegistry, PauseReason } from './types.ts';

export type HostState = 'menu' | 'loading' | 'active';

export interface SessionBinding {
  readonly requestExit: () => void;
  readonly requestRestart: () => void;
  readonly fail: (message: string) => void;
  readonly isCurrent: () => boolean;
}

export interface ControllerDeps {
  readonly registry: ModeRegistry;
  readonly menu: { show(error?: string | undefined): void; hide(): void };
  /** Create the context (and its container) for a new session. */
  readonly makeContext: (id: ModeId, binding: SessionBinding) => ModeContext;
  /** Remove the session's container after the mode was disposed. */
  readonly releaseContext: (ctx: ModeContext) => void;
  readonly defer?: ((fn: () => void) => void) | undefined;
  readonly onFatal?: ((message: string) => void) | undefined;
  readonly onError?: ((err: unknown) => void) | undefined;
  readonly onState?: ((state: HostState, mode: ModeId | null) => void) | undefined;
}

interface Session {
  readonly id: ModeId;
  readonly number: number;
  readonly ctx: ModeContext;
  mode: GameMode | null;
}

export class ModeController {
  private readonly deps: ControllerDeps;
  private sessionNo = 0;
  private current: Session | null = null;
  private hostState: HostState = 'menu';
  readonly stats = { launches: 0, activations: 0, disposals: 0, failures: 0, staleCallbacks: 0, ignoredLaunches: 0 };

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  get state(): HostState {
    return this.hostState;
  }

  get modeId(): ModeId | null {
    return this.current?.id ?? null;
  }

  get mode(): GameMode | null {
    return this.current?.mode ?? null;
  }

  /** Dispose whatever runs, then load, init and activate `id`. Resolves true once active. */
  async launch(id: ModeId): Promise<boolean> {
    if (this.hostState === 'loading') {
      this.stats.ignoredLaunches += 1; // double click / key repeat while a mode is starting
      return false;
    }
    this.endSession();
    this.deps.menu.hide();
    const number = ++this.sessionNo;
    const isCurrent = (): boolean => this.sessionNo === number && this.current?.number === number;
    const binding: SessionBinding = {
      isCurrent,
      requestExit: () => {
        if (!isCurrent()) {
          this.stats.staleCallbacks += 1;
          return;
        }
        this.defer(() => {
          if (isCurrent()) this.returnToMenu();
          else this.stats.staleCallbacks += 1;
        });
      },
      requestRestart: () => {
        if (!isCurrent()) {
          this.stats.staleCallbacks += 1;
          return;
        }
        // deferred like requestExit: the mode is disposed, then a fresh instance of the same mode starts
        this.defer(() => {
          if (isCurrent()) void this.launch(id);
          else this.stats.staleCallbacks += 1;
        });
      },
      fail: (message) => {
        if (!isCurrent()) {
          this.stats.staleCallbacks += 1;
          return;
        }
        this.stats.failures += 1;
        this.endSession();
        this.setState('menu');
        if (this.deps.onFatal) this.deps.onFatal(message);
        else this.deps.menu.show(message);
      },
    };
    const session: Session = { id, number, ctx: this.deps.makeContext(id, binding), mode: null };
    this.current = session;
    this.stats.launches += 1;
    this.setState('loading');
    try {
      const factory = await this.deps.registry[id]();
      if (!isCurrent()) return false;
      session.mode = factory(session.ctx);
      await session.mode.init();
      if (!isCurrent()) {
        // the player left while init was pending: endSession() already disposed the mode; dispose
        // again for anything init allocated after that (dispose is idempotent by contract)
        this.safely(() => session.mode!.dispose());
        return false;
      }
      session.mode.activate();
      this.stats.activations += 1;
      this.setState('active');
      return true;
    } catch (err) {
      this.deps.onError?.(err);
      if (!isCurrent()) return false;
      this.stats.failures += 1;
      this.endSession();
      this.setState('menu');
      this.deps.menu.show(launchFailureMessage(id, err));
      return false;
    }
  }

  /** Dispose the current mode (if any) and show the title screen. */
  returnToMenu(): void {
    this.endSession();
    this.sessionNo += 1; // anything still pending from the old session is now stale
    this.setState('menu');
    this.deps.menu.show();
  }

  pause(reason: PauseReason): void {
    if (this.hostState === 'active') this.safely(() => this.current?.mode?.pause(reason));
  }

  resume(): void {
    if (this.hostState === 'active') this.safely(() => this.current?.mode?.resume());
  }

  private endSession(): void {
    const s = this.current;
    if (!s) return;
    this.current = null;
    if (s.mode) {
      this.safely(() => s.mode!.dispose());
      this.stats.disposals += 1;
    }
    this.safely(() => this.deps.releaseContext(s.ctx));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.onError?.(err);
    }
  }

  private defer(fn: () => void): void {
    (this.deps.defer ?? queueMicrotask)(fn);
  }

  private setState(state: HostState): void {
    this.hostState = state;
    this.deps.onState?.(state, this.current?.id ?? null);
  }
}

/**
 * Browser messages for a lazily loaded chunk that could not be fetched: Chromium, Firefox, Safari,
 * and Vite's CSS preload helper. After a redeploy, a tab opened on the old version asks for chunk
 * names that no longer exist; only a reload fixes that (FR-TD-80).
 */
const CHUNK_LOAD_ERROR = /dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** The title-screen message when a mode fails to load or start. */
export function launchFailureMessage(id: ModeId, err: unknown): string {
  const name = id === 'classic' ? 'Classic Mode' : 'Free Roam';
  const detail = err instanceof Error ? err.message : String(err);
  if (CHUNK_LOAD_ERROR.test(detail)) {
    return `${name} could not load. The game may have been updated since this page opened, or the connection dropped: reload the page to continue.`;
  }
  return `${name} could not start: ${detail}`;
}
