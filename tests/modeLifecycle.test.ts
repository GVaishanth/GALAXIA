import { describe, expect, it, vi } from 'vitest';
import { DisposableScope, type Schedulers } from '../src/shared/lifecycle/scope.ts';
import { launchFailureMessage, ModeController, type SessionBinding } from '../src/modes/controller.ts';
import type { GameMode, ModeContext, ModeId, ModeLifecycle, ModeRegistry, SharedServices } from '../src/modes/types.ts';

/* ------------------------------------------------------------------ helpers */

/** Manual frame + timer scheduler: nothing runs until the test says so. */
function fakeSchedulers() {
  let nextId = 1;
  const frames = new Map<number, (ts: number) => void>();
  const timers = new Map<number, () => void>();
  const sched: Schedulers = {
    requestFrame: (cb) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
    setTimer: (cb) => {
      const id = nextId++;
      timers.set(id, cb);
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
  };
  return {
    sched,
    frames,
    timers,
    /** Run every queued frame once (frames queued during the run wait for the next call). */
    flushFrame(ts = 16) {
      const batch = [...frames.entries()];
      frames.clear();
      for (const [, cb] of batch) cb(ts);
    },
    flushTimers() {
      const batch = [...timers.values()];
      timers.clear();
      for (const cb of batch) cb();
    },
  };
}

/** EventTarget that counts live listeners (Node's EventTarget, real add/remove semantics). */
class CountingTarget extends EventTarget {
  live = 0;
  override addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions): void {
    this.live += 1;
    super.addEventListener(type, cb, opts);
  }
  override removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions): void {
    this.live -= 1;
    super.removeEventListener(type, cb, opts);
  }
}

/* ------------------------------------------------------- DisposableScope */

describe('DisposableScope', () => {
  it('removes every listener on dispose, so events no longer reach the old owner', () => {
    const target = new CountingTarget();
    const scope = new DisposableScope(fakeSchedulers().sched);
    const seen: string[] = [];
    scope.on(target, 'keydown', () => seen.push('a'));
    scope.on(target, 'keyup', () => seen.push('b'), { capture: true });
    expect(scope.activeListeners).toBe(2);
    target.dispatchEvent(new Event('keydown'));
    scope.dispose();
    target.dispatchEvent(new Event('keydown'));
    target.dispatchEvent(new Event('keyup'));
    expect(seen).toEqual(['a']);
    expect(scope.activeListeners).toBe(0);
    expect(target.live).toBe(0);
  });

  it('lets a listener be removed early, exactly once', () => {
    const target = new CountingTarget();
    const scope = new DisposableScope(fakeSchedulers().sched);
    const off = scope.on(target, 'x', () => undefined);
    off();
    off();
    scope.dispose();
    expect(target.live).toBe(0);
    expect(scope.activeListeners).toBe(0);
  });

  it('stops its frame loop: a frame already queued does nothing after dispose', () => {
    const f = fakeSchedulers();
    const scope = new DisposableScope(f.sched);
    const tick = vi.fn();
    scope.frameLoop(tick);
    f.flushFrame();
    f.flushFrame();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(scope.activeLoops).toBe(1);
    const queued = [...f.frames.values()];
    scope.dispose();
    for (const cb of queued) cb(99); // the browser delivers a frame requested before cancel
    f.flushFrame();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(scope.activeLoops).toBe(0);
    expect(f.frames.size).toBe(0);
  });

  it('ends a loop when tick returns false, and keeps running after a tick that throws only if asked', () => {
    const f = fakeSchedulers();
    const scope = new DisposableScope(f.sched);
    let n = 0;
    const loop = scope.frameLoop(() => ++n < 3);
    for (let i = 0; i < 5; i++) f.flushFrame();
    expect(n).toBe(3);
    expect(loop.running).toBe(false);
    expect(scope.activeLoops).toBe(0);
  });

  it('cancels pending timers and never fires them after dispose', () => {
    const f = fakeSchedulers();
    const scope = new DisposableScope(f.sched);
    const cb = vi.fn();
    scope.timeout(cb, 100);
    scope.dispose();
    expect(f.timers.size).toBe(0);
    f.flushTimers();
    expect(cb).not.toHaveBeenCalled();
  });

  it('disposes in reverse order, is idempotent, and runs late registrations immediately', () => {
    const scope = new DisposableScope(fakeSchedulers().sched);
    const order: number[] = [];
    scope.add(() => order.push(1));
    scope.add(() => order.push(2));
    scope.observer({ disconnect: () => order.push(3) });
    scope.dispose();
    scope.dispose();
    expect(order).toEqual([3, 2, 1]);
    scope.add(() => order.push(4));
    expect(order).toEqual([3, 2, 1, 4]);
    expect(scope.on(new CountingTarget(), 'x', () => undefined)).toBeTypeOf('function');
    expect(scope.activeListeners).toBe(0);
    expect(scope.frameLoop(() => undefined).running).toBe(false);
  });

  it('keeps releasing after one disposer throws, then reports the error', () => {
    const scope = new DisposableScope(fakeSchedulers().sched);
    const released: string[] = [];
    scope.add(() => released.push('first'));
    scope.add(() => {
      throw new Error('boom');
    });
    scope.add(() => released.push('last'));
    expect(() => scope.dispose()).toThrow('boom');
    expect(released).toEqual(['last', 'first']);
  });
});

/* -------------------------------------------------------- ModeController */

interface FakeMode extends GameMode {
  calls: string[];
  state: ModeLifecycle;
  ctx: ModeContext;
}

function harness(opts: { initDelay?: Partial<Record<ModeId, Promise<void>>>; initError?: ModeId; loadDelay?: Partial<Record<ModeId, Promise<void>>> } = {}) {
  const created: FakeMode[] = [];
  const menuShows: (string | undefined)[] = [];
  let menuVisible = false;
  const contexts = new Set<ModeContext>();
  const deferred: (() => void)[] = [];
  const target = new CountingTarget();

  const factory =
    (id: ModeId) =>
    (ctx: ModeContext): FakeMode => {
      const scope = new DisposableScope(fakeSchedulers().sched);
      const m: FakeMode = {
        id,
        ctx,
        calls: [],
        state: 'created',
        async init() {
          m.calls.push('init');
          scope.on(target, 'keydown', () => m.calls.push('key'));
          if (opts.initDelay?.[id]) await opts.initDelay[id];
          // work after an await goes through the scope: a no-op once the host disposed this mode
          scope.on(target, 'keyup', () => m.calls.push('keyup'));
          if (opts.initError === id) throw new Error('no canvas');
          if (m.state === 'created') m.state = 'initialized';
        },
        activate() {
          m.calls.push('activate');
          m.state = 'active';
        },
        pause(r) {
          m.calls.push(`pause:${r}`);
        },
        resume() {
          m.calls.push('resume');
        },
        dispose() {
          m.calls.push('dispose');
          scope.dispose();
          m.state = 'disposed';
        },
        debug() {
          return { lifecycle: m.state, listeners: scope.activeListeners, loops: 0 };
        },
      };
      created.push(m);
      return m;
    };

  const registry: ModeRegistry = {
    classic: async () => {
      if (opts.loadDelay?.classic) await opts.loadDelay.classic;
      return factory('classic');
    },
    freeroam: async () => {
      if (opts.loadDelay?.freeroam) await opts.loadDelay.freeroam;
      return factory('freeroam');
    },
  };
  const services = {} as SharedServices;
  const controller = new ModeController({
    registry,
    menu: {
      show: (e) => {
        menuVisible = true;
        menuShows.push(e);
      },
      hide: () => {
        menuVisible = false;
      },
    },
    makeContext: (_id, binding: SessionBinding) => {
      const ctx: ModeContext = { container: {} as HTMLElement, services, ...binding };
      contexts.add(ctx);
      return ctx;
    },
    releaseContext: (ctx) => void contexts.delete(ctx),
    defer: (fn) => void deferred.push(fn),
  });
  return {
    controller,
    created,
    menuShows,
    menuVisible: () => menuVisible,
    contexts,
    target,
    runDeferred: () => {
      while (deferred.length) deferred.shift()!();
    },
  };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

describe('ModeController', () => {
  it('launches each mode through init -> activate and hides the menu', async () => {
    const h = harness();
    expect(await h.controller.launch('classic')).toBe(true);
    expect(h.controller.state).toBe('active');
    expect(h.controller.modeId).toBe('classic');
    expect(h.created[0]!.id).toBe('classic');
    expect(h.created[0]!.calls).toEqual(['init', 'activate']);
    expect(h.menuVisible()).toBe(false);

    h.controller.returnToMenu();
    expect(await h.controller.launch('freeroam')).toBe(true);
    expect(h.created[1]!.id).toBe('freeroam');
    expect(h.controller.modeId).toBe('freeroam');
  });

  it('returns to the menu: disposes the mode and releases its container', async () => {
    const h = harness();
    await h.controller.launch('freeroam');
    h.controller.returnToMenu();
    expect(h.created[0]!.calls.at(-1)).toBe('dispose');
    expect(h.controller.state).toBe('menu');
    expect(h.controller.mode).toBeNull();
    expect(h.contexts.size).toBe(0);
    expect(h.menuVisible()).toBe(true);
  });

  it('repeated switching never accumulates listeners, contexts or live modes', async () => {
    const h = harness();
    for (let i = 0; i < 25; i++) {
      await h.controller.launch(i % 2 ? 'classic' : 'freeroam');
      expect(h.target.live).toBe(2); // only the active mode's listeners
      expect(h.contexts.size).toBe(1);
      h.controller.returnToMenu();
      expect(h.target.live).toBe(0);
      expect(h.contexts.size).toBe(0);
    }
    expect(h.created.filter((m) => m.state !== 'disposed')).toHaveLength(0);
    expect(h.controller.stats).toMatchObject({ launches: 25, activations: 25, disposals: 25, failures: 0 });
    // launching directly from one mode to another also disposes the first
    await h.controller.launch('classic');
    await h.controller.launch('freeroam');
    expect(h.created.filter((m) => m.state !== 'disposed').map((m) => m.id)).toEqual(['freeroam']);
    expect(h.target.live).toBe(2);
  });

  it('defers requestExit, then ignores it (and every other callback) once the session ended', async () => {
    const h = harness();
    await h.controller.launch('classic');
    const old = h.created[0]!.ctx;
    old.requestExit();
    expect(h.controller.state).toBe('active'); // not disposed mid-callback
    h.runDeferred();
    expect(h.controller.state).toBe('menu');

    await h.controller.launch('freeroam');
    old.requestExit();
    old.fail('late error from the old mode');
    h.runDeferred();
    expect(old.isCurrent()).toBe(false);
    expect(h.controller.state).toBe('active');
    expect(h.controller.modeId).toBe('freeroam');
    expect(h.controller.stats.staleCallbacks).toBe(2);
    expect(h.menuShows.every((e) => e === undefined)).toBe(true);
  });

  it('drops an exit queued by a mode that was replaced before the deferral ran', async () => {
    const h = harness();
    await h.controller.launch('classic');
    h.created[0]!.ctx.requestExit(); // queued
    await h.controller.launch('freeroam'); // replaced before the microtask
    h.runDeferred();
    expect(h.controller.modeId).toBe('freeroam');
    expect(h.controller.state).toBe('active');
  });

  it('ignores a second launch while a mode is still loading (double click)', async () => {
    const g = gate();
    const h = harness({ loadDelay: { freeroam: g.promise } });
    const first = h.controller.launch('freeroam');
    expect(h.controller.state).toBe('loading');
    expect(await h.controller.launch('classic')).toBe(false);
    g.open();
    expect(await first).toBe(true);
    expect(h.created.map((m) => m.id)).toEqual(['freeroam']);
    expect(h.controller.stats.ignoredLaunches).toBe(1);
  });

  it('disposes a mode whose async init finishes after the player already went back', async () => {
    const g = gate();
    const h = harness({ initDelay: { freeroam: g.promise } });
    const pending = h.controller.launch('freeroam');
    await Promise.resolve();
    await Promise.resolve();
    h.controller.returnToMenu();
    g.open();
    expect(await pending).toBe(false);
    const m = h.created[0]!;
    expect(m.calls).not.toContain('activate');
    expect(m.state).toBe('disposed');
    expect(h.target.live).toBe(0);
    expect(h.controller.state).toBe('menu');
  });

  it('never instantiates a lazily loaded mode that resolves after returning to the menu', async () => {
    const g = gate();
    const h = harness({ loadDelay: { freeroam: g.promise } });
    const pending = h.controller.launch('freeroam');
    h.controller.returnToMenu();
    g.open();
    expect(await pending).toBe(false);
    expect(h.created).toHaveLength(0);
    expect(h.contexts.size).toBe(0);
  });

  it('a failing init disposes the partial mode and shows the menu with a message', async () => {
    const h = harness({ initError: 'freeroam' });
    expect(await h.controller.launch('freeroam')).toBe(false);
    expect(h.created[0]!.calls).toEqual(['init', 'dispose']);
    expect(h.target.live).toBe(0);
    expect(h.controller.state).toBe('menu');
    expect(h.menuShows.at(-1)).toBe('Free Roam could not start: no canvas');
    expect(await h.controller.launch('classic')).toBe(true); // the page stays usable
  });

  it('a chunk that cannot be fetched (stale tab after a redeploy, offline) asks for a reload', () => {
    for (const msg of [
      'Failed to fetch dynamically imported module: https://u.github.io/galaxia/assets/freeRoamMode-OLD.js', // Chromium
      'error loading dynamically imported module: https://u.github.io/galaxia/assets/freeRoamMode-OLD.js', // Firefox
      'Importing a module script failed.', // Safari
      'Unable to preload CSS for /galaxia/assets/x.css', // Vite preload helper
    ]) {
      expect(launchFailureMessage('freeroam', new TypeError(msg))).toMatch(/^Free Roam could not load\..*reload the page/);
    }
    expect(launchFailureMessage('classic', new Error('no canvas'))).toBe('Classic Mode could not start: no canvas');
    expect(launchFailureMessage('freeroam', 'boom')).toBe('Free Roam could not start: boom');
  });

  it('fail() from the running mode ends it and shows the error on the menu', async () => {
    const h = harness();
    await h.controller.launch('classic');
    h.created[0]!.ctx.fail('The game stopped after an unexpected error.');
    expect(h.created[0]!.state).toBe('disposed');
    expect(h.menuShows.at(-1)).toBe('The game stopped after an unexpected error.');
    expect(h.controller.stats.failures).toBe(1);
  });

  it('forwards pause / resume only to an active mode', async () => {
    const h = harness();
    h.controller.pause('blur'); // menu: nothing to pause
    await h.controller.launch('freeroam');
    h.controller.pause('hidden');
    h.controller.resume();
    expect(h.created[0]!.calls).toEqual(['init', 'activate', 'pause:hidden', 'resume']);
  });
});
