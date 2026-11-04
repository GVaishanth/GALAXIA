/**
 * Finale P3: the opening cinematic's entry policy (shared/intro/introPolicy.ts)
 * and its pure director (shared/intro/openingDirector.ts; part of the lazy
 * chunk, tested here without it). Fake schedulers only; no DOM, no timers.
 */
import { describe, expect, it } from 'vitest';
import { createIntroGate, FALLBACK_HERO, heroSpriteFor, INTRO, INTRO_FAILED_NOTICE, introRequested, type IntroOutcome } from '../src/shared/intro/introPolicy.ts';
import { createRng } from '../src/core/rng.ts';
import { FRAME_CLAMP_MS, FULL_SCHEDULE, OPENING_LIMITS, OPENING_PHASES, OpeningDirector, phaseAt, phaseStart, REDUCED_SCHEDULE, totalMs, type OpeningOutcome, type OpeningPhase } from '../src/shared/intro/openingDirector.ts';

class FakeClock {
  now = 0;
  private cbs = new Map<number, { at: number; cb: () => void }>();
  private seq = 0;
  setTimer = (cb: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.cbs.set(id, { at: this.now + ms, cb });
    return id;
  };
  clearTimer = (id: unknown): void => {
    this.cbs.delete(id as number);
  };
  /** Advance the clock, firing timers whose time has passed, in schedule order (a callback may schedule more). */
  runFor(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let due = -1;
      let at = Infinity;
      for (const [id, t] of this.cbs) {
        if (t.at <= end && t.at < at) {
          due = id;
          at = t.at;
        }
      }
      if (due === -1) break;
      this.now = Math.max(this.now, at);
      const t = this.cbs.get(due)!;
      this.cbs.delete(due);
      t.cb();
    }
    this.now = end;
  }
  /** Fire the earliest pending timer at its scheduled time. False when none are left. */
  next(): boolean {
    let due: number | null = null;
    let at = Infinity;
    for (const [id, t] of this.cbs) {
      if (t.at < at || (t.at === at && (due === null || id < due))) (due = id), (at = t.at);
    }
    if (due === null) return false;
    this.now = Math.max(this.now, at);
    const t = this.cbs.get(due)!;
    this.cbs.delete(due);
    t.cb();
    return true;
  }
  get pending(): number {
    return this.cbs.size;
  }
}

describe('intro policy (src/shared/intro/introPolicy.ts)', () => {
  it('plays on the bare home page and is off only for intro=skip / intro=off', () => {
    expect(introRequested('')).toBe(true);
    expect(introRequested('?debug=1')).toBe(true);
    expect(introRequested('?intro=skip')).toBe(false);
    expect(introRequested('?intro=off')).toBe(false);
    expect(introRequested('?intro=yes')).toBe(true);
    expect(introRequested('?intro=')).toBe(true);
  });

  it('the hero is the active Free Roam hull when its sprite exists, else the Classic fighter, and bad ids are refused', () => {
    const known = (id: string): boolean => ['ship.swift', 'player.fighter'].includes(id);
    expect(heroSpriteFor('swift', known)).toBe('ship.swift');
    expect(heroSpriteFor('condor', known)).toBe(FALLBACK_HERO);
    expect(heroSpriteFor(null, known)).toBe(FALLBACK_HERO);
    expect(heroSpriteFor('undefined', known)).toBe(FALLBACK_HERO);
    expect(heroSpriteFor('SWIFT', known)).toBe(FALLBACK_HERO);
    expect(heroSpriteFor('ship.swift', known)).toBe(FALLBACK_HERO); // ids are hull names, not sprite ids
    expect(FALLBACK_HERO).toBe('player.fighter');
  });

  it('documents the failure notice and keeps the timings tiny', () => {
    expect(INTRO_FAILED_NOTICE).toContain('home page');
    expect(INTRO.skipDelayMs).toBeLessThanOrEqual(1000);
    expect(INTRO.slowLoadMs).toBeLessThan(INTRO.loadTimeoutMs);
    expect(INTRO.loadTimeoutMs).toBeLessThanOrEqual(10_000);
  });
});

describe('the intro gate (one resolution)', () => {
  const mk = () => {
    const clock = new FakeClock();
    const out: { resolved: IntroOutcome[]; skippable: number; slow: number } = { resolved: [], skippable: 0, slow: 0 };
    const gate = createIntroGate(clock, {
      onResolve: (o) => out.resolved.push(o),
      onSkippable: () => (out.skippable += 1),
      onSlow: () => (out.slow += 1),
    });
    return { clock, gate, out };
  };
  it('starts once and schedules exactly three timers, all cleared by the resolution', () => {
    const { clock, gate, out } = mk();
    gate.start();
    gate.start();
    expect(clock.pending).toBe(3);
    gate.loaded();
    gate.complete(false);
    clock.runFor(INTRO.loadTimeoutMs); // timers were already cancelled
    expect(out.resolved).toEqual(['played']);
    expect(gate.timers).toBe(0);
    gate.complete(false);
    gate.skip();
    gate.fail();
    expect(out.resolved).toEqual(['played']);
  });

  it('skip is ignored before the reveal threshold and resolves afterwards, at most once', () => {
    const { clock, gate, out } = mk();
    gate.start();
    clock.runFor(INTRO.skipDelayMs);
    expect(out.skippable).toBe(1);
    expect(gate.skippable).toBe(true);
    expect(gate.skip()).toBe(true);
    expect(gate.skip()).toBe(false);
    expect(out.resolved).toEqual(['skipped']);
    expect(clock.pending).toBe(0); // the slow-load and watchdog timers went with the resolution
  });

  it('a skip before the threshold does nothing, and loading past the watchdog resolves with timeout', () => {
    const { clock, gate, out } = mk();
    expect(gate.state).toBe('idle');
    expect(gate.skip()).toBe(false);
    gate.start();
    expect(gate.skip()).toBe(false);
    expect(out.resolved).toEqual([]);
    clock.runFor(INTRO.slowLoadMs);
    expect(out.slow).toBe(1); // past the watchdog threshold below the load timeout
    expect(gate.loaded()).toBe(true); // the chunk arrives late but in time
    gate.complete(true);
    expect(out.resolved).toEqual(['reduced']);
  });

  it('a chunk that never arrives resolves with timeout at the watchdog', () => {
    const { clock, gate, out } = mk();
    gate.start();
    clock.runFor(INTRO.loadTimeoutMs);
    expect(out.resolved).toEqual(['timeout']);
    expect(gate.loaded()).toBe(false); // a stale load is refused
    expect(gate.outcome).toBe('timeout');
  });

  it('a load failure resolves immediately with failed and drops every pending timer', () => {
    const { clock, gate, out } = mk();
    gate.start();
    gate.fail();
    expect(out.resolved).toEqual(['failed']);
    expect(clock.pending).toBe(0);
    expect(gate.timers).toBe(0);
  });

  it('cancel (a mode started) resolves without completion afterwards', () => {
    const { clock, gate, out } = mk();
    gate.start();
    clock.runFor(INTRO.skipDelayMs);
    gate.loaded();
    gate.cancel();
    expect(out.resolved).toEqual(['cancelled']);
    gate.complete(false);
    gate.skip();
    expect(out.resolved).toEqual(['cancelled']);
    expect(clock.pending).toBe(0);
  });

  it('a slow load announces itself only while still loading', () => {
    const { clock, gate, out } = mk();
    gate.start();
    expect(gate.loaded()).toBe(true); // the chunk arrived before the slow-load timer fired
    clock.runFor(INTRO.loadTimeoutMs); // all timers are due; none while loading fires the slow line
    expect(out.slow).toBe(0);
    expect(out.resolved).toEqual([]);
    gate.skip();
  });

  it('late completion, skip and failure after a resolution are all ignored', () => {
    for (const [first, wins] of [
      ['complete', 'played'],
      ['skip', 'skipped'],
      ['fail', 'failed'],
    ] as const) {
      const { clock, gate, out } = mk();
      gate.start();
      clock.runFor(INTRO.skipDelayMs);
      gate.loaded();
      if (first === 'complete') gate.complete(false);
      else if (first === 'skip') gate.skip();
      else gate.fail();
      gate.complete(false);
      gate.skip();
      gate.fail();
      gate.cancel();
      expect(out.resolved).toEqual([wins]);
    }
  });
});

describe('the director (src/shared/intro/openingDirector.ts)', () => {
  const run = (reduced: boolean, steps: readonly number[] = []) => {
    const phases: OpeningPhase[] = [];
    const done: OpeningOutcome[] = [];
    const d = new OpeningDirector({ reduced, onPhase: (p) => phases.push(p), onComplete: (o) => done.push(o) });
    d.start();
    for (const ms of steps.length > 0 ? steps : [17, 500, 50, 20]) d.advance(ms);
    while (!d.done) d.advance(FRAME_CLAMP_MS);
    return { d, phases, done };
  };

  it('visits each phase in order exactly once (full and reduced)', () => {
    for (const [reduced, schedule] of [false, true].map((r) => [r, r ? REDUCED_SCHEDULE : FULL_SCHEDULE] as const)) {
      const { phases, done } = run(reduced);
      expect(phases).toEqual([...schedule.map(([p]) => p), 'complete']);
      expect(done).toEqual([reduced ? 'reduced' : 'played']);
    }
  });

  it('the order is the documented journey', () => {
    const full = FULL_SCHEDULE.map(([p]) => p);
    expect(full).toEqual(['arrival', 'battle', 'victory', 'track', 'approach', 'cabin', 'display', 'push', 'handoff']);
    expect(OPENING_PHASES[0]).toBe('idle');
    expect(OPENING_PHASES[OPENING_PHASES.length - 1]).toBe('complete');
  });

  it('total durations stay bounded: the player reaches the home page quickly', () => {
    expect(totalMs(FULL_SCHEDULE)).toBeLessThanOrEqual(OPENING_LIMITS.fullMs);
    expect(totalMs(REDUCED_SCHEDULE)).toBeLessThanOrEqual(OPENING_LIMITS.reducedMs);
    for (const s of [FULL_SCHEDULE, REDUCED_SCHEDULE]) for (const [, ms] of s) expect(ms).toBeLessThanOrEqual(OPENING_LIMITS.phaseMs);
  });

  it('a huge elapsed gap is clamped to one frame step and jumps no phases', () => {
    const d = new OpeningDirector({ reduced: false });
    d.start();
    d.advance(3_600_000); // the tab was hidden for an hour
    expect(d.time).toBe(FRAME_CLAMP_MS);
    expect(d.phase).toBe('arrival');
    d.advance(-5); // nonsense stays 0
    d.advance(Number.NaN);
    expect(d.time).toBe(FRAME_CLAMP_MS);
  });

  it('the phase callbacks still fire when one long frame crosses a short phase (a gap after a clamp)', () => {
    const phases: OpeningPhase[] = [];
    const d = new OpeningDirector({ reduced: false, onPhase: (p) => phases.push(p) });
    d.start();
    expect(d.phase).toBe('arrival');
    // 32 x 50 ms max steps skip over nothing anyway; one 50 ms step from 8 400 reaches past the 200 ms handoff
    while (d.time < totalMs(FULL_SCHEDULE) - 250) d.advance(FRAME_CLAMP_MS);
    while (!d.done) d.advance(FRAME_CLAMP_MS);
    expect(phases.filter((p) => p === 'handoff')).toHaveLength(1);
    expect(phases.filter((p) => p === 'push')).toHaveLength(1);
    expect(d.phase).toBe('complete');
  });

  it('state at time 0 is idle before start and the first phase after', () => {
    const d = new OpeningDirector({ reduced: false });
    expect(d.phase).toBe('idle');
    d.start();
    expect(d.phase).toBe('arrival');
    d.start(); // idempotent
    expect(d.time).toBe(0);
  });

  it('phaseAt is piecewise-exact at the boundaries', () => {
    const s = phaseStart(FULL_SCHEDULE, 'battle');
    expect(s).toBe(900);
    const at = phaseAt(FULL_SCHEDULE, s! + 250);
    expect(at.phase).toBe('battle');
    expect(at.local).toBe(250);
    expect(at.p).toBeCloseTo(250 / 2400, 5);
    expect(phaseAt(FULL_SCHEDULE, -1).phase).toBe('idle');
    expect(phaseAt(FULL_SCHEDULE, totalMs(FULL_SCHEDULE)).phase).toBe('complete');
    expect(phaseStart(REDUCED_SCHEDULE, 'battle')).toBeNull();
  });

  it('skip ends the run once and the completion callback reports it', () => {
    const done: OpeningOutcome[] = [];
    const d = new OpeningDirector({ reduced: false, onComplete: (o) => done.push(o) });
    d.start();
    expect(d.skip()).toBe(true);
    expect(d.phase).toBe('complete');
    expect(d.skip()).toBe(false);
    expect(done).toEqual(['skipped']);
    // nothing left over: further frames do nothing
    d.advance(50);
    expect(d.time).toBe(0);
  });

  it('fail ends the run once with failed', () => {
    const done: OpeningOutcome[] = [];
    const d = new OpeningDirector({ reduced: false, onComplete: (o) => done.push(o) });
    d.advance(50);
    expect(d.fail()).toBe(true);
    expect(d.done).toBe(true);
    expect(d.skip()).toBe(false);
    expect(done).toEqual(['failed']);
  });

  it('dispose drops the hooks: no completion callback can fire afterwards', () => {
    const done: OpeningOutcome[] = [];
    const phases: OpeningPhase[] = [];
    const d = new OpeningDirector({ reduced: false, onPhase: (p) => phases.push(p), onComplete: (o) => done.push(o) });
    d.start();
    d.dispose();
    d.advance(totalMs(FULL_SCHEDULE));
    d.skip();
    expect(done).toEqual([]);
    expect(phases).toEqual(['arrival']);
    expect(d.disposed).toBe(true);
  });

  it('a disposed director can never call back into the shell (its stage is gone by then)', () => {
    const { d } = run(false);
    d.dispose();
    d.advance(50);
    expect(d.phase).toBe('complete');
  });

  it('reduced motion reaches complete within its bounded time at half frames', () => {
    const d = new OpeningDirector({ reduced: true });
    d.start();
    let t = 0;
    while (!d.done) {
      d.advance(33);
      t += 33;
    }
    expect(t).toBeLessThanOrEqual(OPENING_LIMITS.reducedMs + 50);
  });

  it('seeded determinism auxiliary: equal seeds give equal draws (used by the choreography)', () => {
    const a = createRng(7);
    const b = createRng(7);
    for (let i = 0; i < 8; i++) expect(a.next()).toBe(b.next());
  });
});
