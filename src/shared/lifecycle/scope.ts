/**
 * DisposableScope: one owner for everything a mode (or a menu) registers on
 * long-lived objects: event listeners on window / document / media queries,
 * observers, timers and a requestAnimationFrame loop. `dispose()` releases all
 * of it in reverse order, exactly once, so switching modes can never leave a
 * listener, timer or frame loop of the previous mode running.
 *
 * DOM-free at the type level (structural targets, injectable schedulers) so it
 * is unit-tested in node with Node's own EventTarget.
 */

export interface ListenerTarget {
  addEventListener(type: string, listener: (e: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (e: Event) => void, options?: boolean | EventListenerOptions): void;
}

export interface Schedulers {
  requestFrame(cb: (ts: number) => void): number;
  cancelFrame(id: number): void;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
}

export const browserSchedulers = (): Schedulers => ({
  requestFrame: (cb) => globalThis.requestAnimationFrame(cb),
  cancelFrame: (id) => globalThis.cancelAnimationFrame(id),
  setTimer: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimer: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
});

/** A frame loop owned by a scope: at most one pending frame at any time. */
export interface FrameLoop {
  readonly running: boolean;
  stop(): void;
}

export class DisposableScope {
  private readonly disposers: (() => void)[] = [];
  private readonly sched: Schedulers;
  private isDisposed = false;
  /** Listeners currently registered through this scope (diagnostics and tests). */
  activeListeners = 0;
  /** Frame loops currently running (diagnostics and tests). */
  activeLoops = 0;

  constructor(schedulers: Schedulers = browserSchedulers()) {
    this.sched = schedulers;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  /** Register a cleanup callback (run in reverse order on dispose). After dispose it runs immediately. */
  add(disposer: () => void): void {
    if (this.isDisposed) {
      disposer();
      return;
    }
    this.disposers.push(disposer);
  }

  /** addEventListener that is removed on dispose. Returns a function that removes it early. */
  on<E = Event>(target: ListenerTarget, type: string, listener: (e: E) => void, options?: boolean | AddEventListenerOptions): () => void {
    if (this.isDisposed) return () => undefined;
    const fn = listener as unknown as (e: Event) => void;
    target.addEventListener(type, fn, options);
    this.activeListeners += 1;
    let removed = false;
    const remove = (): void => {
      if (removed) return;
      removed = true;
      const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
      target.removeEventListener(type, fn, { capture });
      this.activeListeners -= 1;
    };
    this.disposers.push(remove);
    return remove;
  }

  /** setTimeout that never fires after dispose. */
  timeout(cb: () => void, ms: number): void {
    if (this.isDisposed) return;
    let done = false;
    const id = this.sched.setTimer(() => {
      done = true;
      if (!this.isDisposed) cb();
    }, ms);
    this.disposers.push(() => {
      if (!done) this.sched.clearTimer(id);
    });
  }

  /** Track any object with a disconnect() (ResizeObserver, MutationObserver). */
  observer<T extends { disconnect(): void }>(o: T): T {
    this.add(() => o.disconnect());
    return o;
  }

  /**
   * Start a requestAnimationFrame loop. `tick` runs once per frame until the
   * loop is stopped, the scope is disposed, or `tick` returns false. The guard
   * flag means a frame already queued by the browser does nothing after stop.
   */
  frameLoop(tick: (ts: number) => boolean | void): FrameLoop {
    if (this.isDisposed) return { running: false, stop: () => undefined };
    let id: number | null = null;
    let running = true;
    this.activeLoops += 1;
    const stop = (): void => {
      if (!running) return;
      running = false;
      if (id !== null) this.sched.cancelFrame(id);
      id = null;
      this.activeLoops -= 1;
    };
    const frame = (ts: number): void => {
      id = null;
      if (!running || this.isDisposed) return;
      let again: boolean | void = true;
      try {
        again = tick(ts);
      } finally {
        // re-check: tick may have stopped the loop or disposed the scope
        if (running && !this.isDisposed && again !== false) id = this.sched.requestFrame(frame);
        else if (running) stop();
      }
    };
    id = this.sched.requestFrame(frame);
    this.disposers.push(stop);
    return {
      get running() {
        return running;
      },
      stop,
    };
  }

  /** Release everything (reverse registration order). Safe to call more than once. */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    const errors: unknown[] = [];
    while (this.disposers.length > 0) {
      const d = this.disposers.pop()!;
      try {
        d();
      } catch (err) {
        errors.push(err); // keep releasing the rest
      }
    }
    if (errors.length > 0) throw errors[0];
  }
}
