/**
 * Pause / CONTINUE in both modes (release fixes, FR-TD-82).
 *
 * The intermittent Firefox "CONTINUE (Enter)" failure was an input-routing
 * defect: a steering key pressed as the recovery screen appeared was read as
 * menu navigation (focus moved to SECTOR MAP), so the following Enter opened
 * the sector map. These tests pin the pure pieces with synthetic times and
 * fixed seeds: the arming gate, the key / pad mapping, pause and resume of
 * the simulation (including mid-attack and repeated cycles), the clock after
 * a long pause (no dt jump) and the single frame loop. The DOM flows (button,
 * Enter, Escape, blur while paused) run in the browser harness
 * docs/development/playtest/pause-resume.mjs on three engines.
 */
import { describe, expect, it } from 'vitest';
import { FixedStepClock } from '../src/core/clock.ts';
import { ENGINE } from '../src/config/engine.ts';
import { applyMenuAction } from '../src/game/menuActions.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { panelKeyCommands, panelPadCommands } from '../src/modes/freeroam/input.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, pauseSector, resumeSector, stepSector, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { armingDelayMs, InputArming, PANEL_SETTLE_MS } from '../src/modes/freeroam/ui/panelArming.ts';
import { DisposableScope, type Schedulers } from '../src/shared/lifecycle/scope.ts';
import { makeEngine, PAUSE, run as runClassic, runUntil, score, startPlaying } from './helpers/engine.ts';
import { NO_INPUT, type InputFrame } from '../src/core/game/input.ts';

/* ------------------------------------------------------------ Free Roam setup */
const graph = buildNavGraph();
const ALL: readonly SectorLayout[] = getCatalogue().systems.map((s) => generateSector(s, sectorContext(graph, s.id)));
/** A cleared copy of a difficulty-3 sector: only the exit, no rocks, patrols, sites or hazards. */
function arena(): SectorLayout {
  const L = ALL.find((x) => x.difficulty === 3)!;
  return { ...L, rocks: [], landmarks: [], regions: [], patrols: [], sites: [], hazards: [], pois: L.pois.filter((p) => p.kind === 'exit') };
}
const P = { x: 1400, y: 1400 };
/** A run in an active fight: two raiders close by, grace over, the pilot cannot die (the test is about pausing, not losing). */
function fight(seed = 7): SectorRun {
  const r = createSectorRun(arena(), { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed });
  r.grace = 0;
  r.invuln = 1e9;
  Object.assign(r.ship, { x: P.x, y: P.y, px: P.x, py: P.y, vx: 0, vy: 0 });
  for (const dx of [260, -300]) if (!spawnAgent(r, 'raider', 'red-tally', 'test', 'guard', P.x + dx, P.y + 40)) throw new Error('spawn refused');
  return r;
}
/** Steering and firing that changes over time (so a skipped or doubled tick would show). */
const pilot = (t: number): SectorInput => ({ moveX: t % 90 < 45 ? 1 : -1, moveY: t % 60 < 30 ? 0.5 : -0.5, fire: t % 7 < 3 });
/** Everything a pause must not change. */
function snap(r: SectorRun): string {
  const n = (v: number): string => v.toFixed(4);
  return JSON.stringify({
    tick: r.tick,
    ship: [n(r.ship.x), n(r.ship.y), n(r.ship.vx), n(r.ship.vy)],
    hull: r.hull,
    shield: n(r.shield),
    energy: n(r.energy),
    heat: n(r.heat),
    recalls: r.recalls,
    hostiles: r.hostiles.map((h) => [h.id, n(h.x), n(h.y), n(h.vx), n(h.vy), h.state, h.stateTicks]),
    enemyShots: r.enemyShots.map((s) => [s.id, n(s.x), n(s.y)]),
    shots: r.shots.map((s) => [s.id, n(s.x), n(s.y)]),
  });
}
/** Step a live (flight) run `n` ticks with the pilot script starting at script tick `t0`. */
function fly(r: SectorRun, t0: number, n: number): number {
  for (let i = 0; i < n; i++) stepSector(r, pilot(t0 + i));
  return t0 + n;
}

describe('Free Roam: pause during an active attack', () => {
  it('the fight is really active before pausing (hostiles closing, shots in the air)', () => {
    const r = fight();
    let fired = 0;
    for (let t = 0; t < 600 && r.enemyShots.length === 0; t++) for (const e of stepSector(r, pilot(t))) if (e.type === 'enemyFired') fired += 1;
    expect(fired).toBeGreaterThan(0);
    expect(r.enemyShots.length).toBeGreaterThan(0);
    expect(r.hostiles.length).toBe(2);
  });

  it('pausing freezes ship, hostiles, enemy shots, player shots, hull, heat and the tick; input is ignored', () => {
    const r = fight();
    let t = 0;
    while (r.enemyShots.length === 0 && t < 600) t = fly(r, t, 1);
    expect(r.enemyShots.length).toBeGreaterThan(0); // paused mid-attack, with shots on the way
    expect(pauseSector(r)).toEqual([{ type: 'phase', phase: 'paused' }]);
    const before = snap(r);
    for (let i = 0; i < 300; i++) expect(stepSector(r, pilot(i))).toEqual([]);
    expect(snap(r)).toBe(before);
    expect(r.phase).toBe('paused');
    expect(r.ship.thrusting).toBe(false);
  });

  it('CONTINUE resumes the same fight: the next step advances hostiles and shots by exactly one tick', () => {
    const r = fight();
    let t = 0;
    while (r.enemyShots.length === 0 && t < 600) t = fly(r, t, 1);
    pauseSector(r);
    const tick = r.tick;
    const hull = r.hull;
    const shot = r.enemyShots[0]!;
    const [sx, sy] = [shot.x, shot.y];
    expect(resumeSector(r)).toEqual([{ type: 'phase', phase: 'flight' }]);
    expect(r.phase).toBe('flight');
    expect(r.hull).toBe(hull); // nothing reset by resuming
    stepSector(r, pilot(t));
    expect(r.tick).toBe(tick + 1);
    const moved = r.enemyShots.find((s) => s.id === shot.id);
    if (moved) expect(Math.hypot(moved.x - sx, moved.y - sy)).toBeGreaterThan(0); // the projectile flies on (or hit / expired this tick)
  });

  it('repeated pause / resume is transparent: 40 cycles give exactly the state of an uninterrupted run', () => {
    const a = fight(21);
    const b = fight(21);
    let ta = 0;
    let tb = 0;
    for (let c = 0; c < 40; c++) {
      ta = fly(a, ta, 15);
      expect(pauseSector(a).length).toBe(1);
      for (let i = 0; i < 1 + (c % 5) * 20; i++) stepSector(a, pilot(999 + i)); // paused frames with input held
      expect(resumeSector(a).length).toBe(1);
      tb = fly(b, tb, 15);
    }
    expect(ta).toBe(tb);
    expect(a.tick).toBe(b.tick);
    expect(snap(a)).toBe(snap(b));
  });

  it('no stale pause flag: a second pause or resume is a no-op, and a paused run resumes once', () => {
    const r = fight();
    fly(r, 0, 30);
    expect(resumeSector(r)).toEqual([]); // already flying
    expect(pauseSector(r).length).toBe(1);
    expect(pauseSector(r)).toEqual([]); // e.g. blur while the pause panel is already open
    expect(resumeSector(r).length).toBe(1);
    expect(resumeSector(r)).toEqual([]);
    expect(r.phase).toBe('flight');
    const tick = r.tick;
    fly(r, 30, 10);
    expect(r.tick).toBe(tick + 10);
  });
});

describe('Free Roam: panel input routing (the Firefox CONTINUE race)', () => {
  it('Enter and Space confirm, Escape backs out (the recovery screen maps BACK to CONTINUE), arrows navigate', () => {
    expect(panelKeyCommands(['Enter'])).toEqual(['confirm']);
    expect(panelKeyCommands(['Space'])).toEqual(['confirm']);
    expect(panelKeyCommands(['Escape'])).toEqual(['back']);
    expect(panelKeyCommands(['ArrowDown'])).toEqual(['next']);
    expect(panelKeyCommands(['ArrowUp'])).toEqual(['prev']);
    expect(panelPadCommands({ presses: ['a'] } as unknown as Parameters<typeof panelPadCommands>[0])).toEqual(['confirm']);
    expect(panelPadCommands({ presses: ['b'] } as unknown as Parameters<typeof panelPadCommands>[0])).toEqual(['back']);
  });

  it('a game-opened panel stays unarmed for its entrance delay plus the settle time (reduced motion: settle only)', () => {
    expect(armingDelayMs(650, true)).toBe(650 + PANEL_SETTLE_MS);
    expect(armingDelayMs(650, false)).toBe(PANEL_SETTLE_MS); // no animation: visible at once
    expect(armingDelayMs(0, false)).toBe(PANEL_SETTLE_MS);
    expect(armingDelayMs(-5, true)).toBe(PANEL_SETTLE_MS);
  });

  it('the steering key that raced the recovery screen is dropped; Enter after it settles is admitted', () => {
    const g = new InputArming();
    const opened = 10_000;
    g.arm(opened, armingDelayMs(650, true));
    // the harness / player: ArrowDown 4 ms after the panel opened (a steering key from flight)
    expect(g.admit(opened + 4)).toBe(false);
    expect(g.admit(opened + 649)).toBe(false); // still invisible (entrance delay)
    expect(g.admit(opened + 650 + PANEL_SETTLE_MS - 1)).toBe(false);
    expect(g.droppedCount).toBe(3);
    expect(g.ready(opened + 650 + PANEL_SETTLE_MS)).toBe(true);
    expect(g.admit(opened + 2000)).toBe(true); // Enter on CONTINUE
    expect(g.droppedCount).toBe(3);
  });

  it('a panel the player opens (pause, map) is ready at once: any panel change clears the gate', () => {
    const g = new InputArming();
    g.arm(0, 950);
    g.clear(); // showPanel('pause') / showPanel(null)
    expect(g.admit(1)).toBe(true);
    expect(new InputArming().ready(0)).toBe(true);
  });
});

describe('timing across a pause (no dt jump)', () => {
  it('after resetTiming, a 30 s pause (hidden tab) runs no catch-up ticks; play resumes at the normal rate', () => {
    const clock = new FixedStepClock({ hz: ENGINE.tickHz, maxFrameMs: ENGINE.maxFrameMs });
    let ticks = 0;
    const tick = (): void => {
      ticks += 1;
    };
    let ts = 1000;
    for (let i = 0; i < 60; i++) clock.advance((ts += 1000 / 60), tick);
    const live = ticks;
    expect(live).toBeGreaterThanOrEqual(58);
    // paused: the frame loop keeps running but the run does not step; on CONTINUE the mode resets timing
    ts += 30_000;
    clock.resetTiming();
    ticks = 0;
    clock.advance(ts, tick);
    expect(ticks).toBe(0); // the first frame after CONTINUE only re-anchors the clock
    for (let i = 0; i < 60; i++) clock.advance((ts += 1000 / 60), tick);
    expect(ticks).toBeGreaterThanOrEqual(59);
    expect(ticks).toBeLessThanOrEqual(61);
  });

  it('even without a reset, one long frame is capped (maxFrameMs), never 30 s of simulation', () => {
    const clock = new FixedStepClock({ hz: ENGINE.tickHz, maxFrameMs: ENGINE.maxFrameMs });
    let ticks = 0;
    clock.advance(0, () => (ticks += 1));
    clock.advance(30_000, () => (ticks += 1));
    expect(ticks).toBeLessThanOrEqual(Math.ceil(ENGINE.maxFrameMs / (1000 / ENGINE.tickHz)));
  });
});

describe('one frame loop', () => {
  it('pause / resume cycles inside the loop never queue a second frame; dispose stops the only loop', () => {
    const frames = new Map<number, (ts: number) => void>();
    let next = 1;
    const sched: Schedulers = {
      requestFrame: (cb) => {
        const id = next++;
        frames.set(id, cb);
        return id;
      },
      cancelFrame: (id) => void frames.delete(id),
      setTimer: () => 0,
      clearTimer: () => undefined,
    };
    const flush = (ts: number): void => {
      const due = [...frames.entries()];
      frames.clear();
      for (const [, cb] of due) cb(ts);
    };
    const scope = new DisposableScope(sched);
    const r = fight(3);
    const clock = new FixedStepClock({ hz: ENGINE.tickHz, maxFrameMs: ENGINE.maxFrameMs });
    let bodies = 0;
    let t = 0;
    // the mode's frame body: the run steps only while flying (a pause only flips the phase)
    scope.frameLoop((ts) => {
      bodies += 1;
      clock.advance(ts, () => {
        stepSector(r, pilot(t++));
      });
    });
    let ts = 0;
    for (let c = 0; c < 25; c++) {
      for (let f = 0; f < 6; f++) {
        flush((ts += 1000 / 60));
        expect(frames.size).toBe(1); // exactly one frame requested at any time
      }
      pauseSector(r);
      flush((ts += 1000 / 60));
      ts += 5000; // long pause
      resumeSector(r);
      clock.resetTiming(); // what the mode's resume does
      flush(ts);
      expect(frames.size).toBe(1);
      expect(scope.activeLoops).toBe(1);
    }
    expect(bodies).toBe(25 * 8); // one body per frame, never doubled
    expect(r.tick).toBeLessThanOrEqual(25 * 7); // no catch-up after the 5 s pauses
    scope.dispose();
    expect(scope.activeLoops).toBe(0);
    expect(frames.size).toBe(0);
  });
});

/* ------------------------------------------------------------ Classic */
describe('Classic: pause and CONTINUE', () => {
  /** Run until an enemy is diving at the player (an active attack). */
  function midAttack(seed: number): ReturnType<typeof makeEngine> {
    const h = makeEngine({ seed });
    startPlaying(h);
    runUntil(h.engine, () => h.engine.world.enemies.some((e) => e.state === 'attacking'), 60 * 30);
    return h;
  }

  it('pausing mid-attack freezes the world; score, lives and stage are kept', () => {
    const h = midAttack(5);
    const lives = h.rewards.snapshot().reserves;
    const stage = h.engine.world.stage;
    const s0 = score(h);
    expect(h.engine.pause()).toBe(true);
    const d = h.engine.digest();
    runClassic(h.engine, 240, { ...NO_INPUT, moveX: 1, fire: true });
    expect(h.engine.digest()).toBe(d);
    expect(h.engine.phase).toBe('paused');
    expect(score(h)).toBe(s0);
    expect(h.engine.world.stage).toBe(stage);
    expect(h.rewards.snapshot().reserves).toBe(lives);
  });

  it('CONTINUE (menu button) and the pause key both resume, and the attack carries on', () => {
    for (const via of ['button', 'key'] as const) {
      const h = midAttack(9);
      expect(h.engine.pause()).toBe(true);
      const tick = h.engine.world.tick;
      if (via === 'button') expect(applyMenuAction(h.engine, 'resume', null)).toEqual({ overlay: null, ok: true });
      else h.engine.step(PAUSE); // P / Escape toggles back to play inside a normal fixed step
      expect(h.engine.phase).not.toBe('paused');
      // no jump: the button resumes without stepping; the key's own step is one ordinary 1/60 s tick
      expect(h.engine.world.tick, via).toBe(tick + (via === 'key' ? 1 : 0));
      const resumed = h.engine.world.tick;
      runClassic(h.engine, 30);
      expect(h.engine.world.tick).toBe(resumed + 30);
      expect(h.engine.world.enemies.some((e) => e.state === 'attacking' || e.state === 'returning' || e.state === 'destroyed'), via).toBe(true);
    }
  });

  it('repeated pause / CONTINUE (30 cycles, input held while paused) equals an uninterrupted run', () => {
    const a = makeEngine({ seed: 77, instantFormation: false });
    const b = makeEngine({ seed: 77, instantFormation: false });
    startPlaying(a);
    startPlaying(b);
    const script = (i: number): InputFrame => ({ ...NO_INPUT, moveX: i % 80 < 40 ? -1 : 1, fire: i % 11 === 0 });
    let i = 0;
    for (let c = 0; c < 30; c++) {
      for (let k = 0; k < 20; k++) a.engine.step(script(i + k));
      expect(a.engine.pause()).toBe(true);
      runClassic(a.engine, 10 + c, { ...NO_INPUT, moveX: 1, fire: true });
      expect(a.engine.pause()).toBe(false); // blur while already paused: no second pause
      expect(a.engine.resume()).toBe(true);
      for (let k = 0; k < 20; k++) b.engine.step(script(i + k));
      i += 20;
    }
    expect(a.engine.digest()).toBe(b.engine.digest());
    expect(score(a)).toBe(score(b));
  });
});
