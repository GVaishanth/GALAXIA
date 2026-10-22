/**
 * Stage 4 integration: the real engine driving the presentation stack
 * (Presenter -> FxDirector / TransitionDirector / SoundSystem / drawGame)
 * through a recording canvas. Proves animations never change game logic,
 * pause, restart or progression, and that enemy shots are drawn last in
 * live play.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SoundSystem, type AudioContextLike, type SourceLike } from '../src/audio/soundSystem.ts';
import { ENGINE } from '../src/config/engine.ts';
import { FX } from '../src/config/effects.ts';
import { TRANSITIONS } from '../src/config/presentation.ts';
import type { GameEngine } from '../src/core/game/engine.ts';
import { NO_INPUT, type InputFrame } from '../src/core/game/input.ts';
import { Presenter } from '../src/game/presenter.ts';
import { applyMenuAction } from '../src/game/menuActions.ts';
import { isControlKey } from '../src/input/keyboard.ts';
import { DEFAULT_SAVE } from '../src/persistence/saveData.ts';
import { SpaceBackdrop } from '../src/render/backdrop.ts';
import { FxDirector } from '../src/render/fx/fxDirector.ts';
import { drawGame, type Layer } from '../src/render/gameRenderer.ts';
import type { CanvasLike } from '../src/render/sprite/spriteCache.ts';
import { SpriteCache } from '../src/render/sprite/spriteCache.ts';
import { TransitionDirector } from '../src/render/transitions.ts';
import { fitViewport } from '../src/render/viewport.ts';
import { MENUS, overlayForPhase, screenFor } from '../src/ui/screenModel.ts';
import { makeEngine, type Harness, run, runUntil, shootPlayer, startPlaying } from './helpers/engine.ts';

/* ---------- headless canvas ---------- */

function fakeContext(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = {
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(state, {
    get: (t, k) => (k in t ? t[k] : () => undefined),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}
const fakeCanvas = (width: number, height: number): CanvasLike => ({ width, height, getContext: () => fakeContext() }) as unknown as CanvasLike;

beforeAll(() => {
  vi.stubGlobal(
    'ImageData',
    class {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  );
});
afterAll(() => vi.unstubAllGlobals());

/* ---------- fake audio ---------- */

class Ctx implements AudioContextLike {
  state = 'running';
  currentTime = 0;
  sampleRate = 4000;
  destination = {};
  createGain() {
    return { gain: { value: 1 }, connect: () => undefined };
  }
  createBuffer(_c: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel: () => undefined };
  }
  createBufferSource(): SourceLike {
    return { buffer: null, loop: false, onended: null, connect: () => undefined, disconnect: () => undefined, start: () => undefined, stop: () => undefined };
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
}

/* ---------- rig ---------- */

interface Rig extends Harness {
  presenter: Presenter;
  sound: SoundSystem;
  audio: Ctx;
  cache: SpriteCache;
  uiMs: number;
  layers: Layer[];
  /** One rendered frame: engine ticks, events, presentation update, draw. */
  frame(input?: InputFrame, ticks?: number): void;
}

function rig(seed = 7, opts: { instantFormation?: boolean } = {}): Rig {
  const h = makeEngine({ seed, instantFormation: opts.instantFormation ?? true });
  const audio = new Ctx();
  const sound = new SoundSystem(() => audio, DEFAULT_SAVE.audio);
  sound.unlock();
  const presenter = new Presenter({ fx: new FxDirector({ seed }), transitions: new TransitionDirector(), backdrop: new SpaceBackdrop(fakeCanvas, 3), sound });
  h.rewards.events.onAny((e) => presenter.handleRewardEvent(e));
  presenter.transitions.boot(0);
  const cache = new SpriteCache(fakeCanvas);
  const v = fitViewport(448 * 2, 576 * 2);
  const ctx = fakeContext();
  const r: Rig = {
    ...h,
    presenter,
    sound,
    audio,
    cache,
    uiMs: 0,
    layers: [],
    frame(input = NO_INPUT, ticks = 1) {
      for (let i = 0; i < ticks; i++) h.engine.step(input);
      const dt = (ticks * 1000) / ENGINE.tickHz;
      r.uiMs += dt;
      audio.currentTime += dt / 1000;
      presenter.handleGameEvents(h.engine.drainEvents(), h.engine.world, r.uiMs);
      const tr = presenter.frame(dt, r.uiMs, h.engine.world, h.engine.phaseClock(), h.engine.isStageIntro);
      r.layers = [];
      drawGame(ctx, { cache, backdrop: presenter.backdrop!, fx: presenter.fx }, v, h.engine.world, { alpha: 1, timeMs: r.uiMs, phase: h.engine.phase, activePhase: h.engine.machine.activePhase, glow: true, motion: 1, transition: tr }, (l) => r.layers.push(l));
    },
  };
  return r;
}

/** Deterministic aim-and-fire bot (pure function of the world). */
function bot(engine: GameEngine): (tick: number) => InputFrame {
  return (tick) => {
    const w = engine.world;
    const p = w.player;
    let target: number | null = null;
    let best = -Infinity;
    for (const e of w.enemies) if (e.state !== 'destroyed' && e.y > best) [best, target] = [e.y, e.x];
    const moveX = target === null || Math.abs(target - p.x) < 4 ? 0 : target < p.x ? -1 : 1;
    return { ...NO_INPUT, moveX, fire: tick % 9 === 0, start: engine.phase === 'title' || engine.phase === 'gameOver' };
  };
}

/* ---------- tests ---------- */

describe('presentation never changes game logic', () => {
  it('the same seed and inputs give an identical engine with or without the full presentation stack', () => {
    const plain = makeEngine({ seed: 7 });
    const show = rig(7);
    const drivePlain = bot(plain.engine);
    const driveShow = bot(show.engine);
    for (let t = 0; t < 60 * 90; t++) {
      plain.engine.step(drivePlain(t));
      plain.engine.drainEvents();
      show.frame(driveShow(t));
      if (t % 600 === 0) expect(show.engine.digest()).toBe(plain.engine.digest());
    }
    expect(show.engine.digest()).toBe(plain.engine.digest());
    expect(show.rewards.snapshot()).toEqual(plain.rewards.snapshot());
    expect(show.presenter.counts.get('enemyDestroyed') ?? 0).toBeGreaterThan(10);
  });
});

describe('effects stay bounded through real play', () => {
  it('a long bot session never exceeds any cap; effects settle on the title', () => {
    const r = rig(5);
    const drive = bot(r.engine);
    let stagesSeen = 1;
    for (let t = 0; t < 60 * 150; t++) {
      r.frame(drive(t));
      stagesSeen = Math.max(stagesSeen, r.engine.world.stage);
      const s = r.presenter.fx.stats();
      expect(s.debris).toBeLessThanOrEqual(FX.caps.debris);
      expect(s.trails).toBeLessThanOrEqual(FX.caps.trails);
      expect(s.rings + s.flashes + s.popups).toBeLessThanOrEqual(FX.caps.rings + FX.caps.flashes + FX.caps.popups);
      expect(r.sound.stats().active).toBeLessThanOrEqual(24);
    }
    expect(stagesSeen).toBeGreaterThanOrEqual(2); // progression intact
    r.engine.pause();
    r.frame();
    applyMenuAction(r.engine, 'quit', null);
    r.frame();
    expect(r.engine.phase).toBe('title');
    expect(r.presenter.fx.idle).toBe(true);
    expect(r.sound.stats().loops).toBe(0);
  });
});

describe('pause', () => {
  it('freezes effects, backdrop, audio and the world; resume continues where it stopped', () => {
    const r = rig(3);
    r.frame({ ...NO_INPUT, start: true });
    runUntil(r.engine, () => r.engine.phase === 'playing');
    r.frame();
    r.engine.world.attackTimerMs = Number.POSITIVE_INFINITY;
    // something to freeze
    const victim = r.engine.world.enemies[0]!;
    r.engine.world.playerShots.push({ id: -5, x: victim.x, y: victim.y + 4, prevX: victim.x, prevY: victim.y + 10, vx: 0, vy: -720 });
    r.frame();
    r.frame();
    expect(r.presenter.fx.idle).toBe(false);
    expect(r.engine.pause()).toBe(true);
    r.frame();
    expect(r.audio.state).toBe('suspended');
    const fx0 = JSON.stringify(r.presenter.fx.stats());
    const bd0 = r.presenter.backdrop!.elapsedMs;
    const dg0 = r.engine.digest();
    for (let i = 0; i < 120; i++) r.frame({ ...NO_INPUT, fire: true, moveX: 1, start: true });
    expect(JSON.stringify(r.presenter.fx.stats())).toBe(fx0);
    expect(r.presenter.backdrop!.elapsedMs).toBe(bd0);
    expect(r.engine.digest()).toBe(dg0);
    expect(r.engine.phase).toBe('paused'); // fire / start never resume
    expect(r.presenter.lastFrame!.dim).toBeCloseTo(TRANSITIONS.pauseDim, 5);
    // paused frames draw shots under the dim layer (menu readability), never on top
    expect(r.layers.indexOf('dim')).toBeGreaterThan(r.layers.indexOf('enemyShots'));

    expect(applyMenuAction(r.engine, 'resume', null).ok).toBe(true);
    r.frame();
    expect(r.audio.state).toBe('running');
    expect(r.presenter.backdrop!.elapsedMs).toBeGreaterThan(bd0);
    expect(r.presenter.lastFrame!.dim).toBe(0);
    expect(r.presenter.lastFrame!.live).toBe(true);
  });
});

describe('draw order in live play', () => {
  it('enemy shots are the last world layer drawn, after every effect; nothing covers the field', () => {
    const r = rig(4);
    r.frame({ ...NO_INPUT, start: true });
    runUntil(r.engine, () => r.engine.phase === 'playing');
    r.engine.world.attackTimerMs = Number.POSITIVE_INFINITY;
    for (const e of r.engine.world.enemies.slice(0, 6)) r.engine.world.playerShots.push({ id: -1, x: e.x, y: e.y + 4, prevX: e.x, prevY: e.y + 10, vx: 0, vy: -720 });
    r.engine.world.enemyShots.push({ id: -9, x: 100, y: 300, prevX: 100, prevY: 296, vx: 0, vy: 200 });
    r.frame();
    expect(r.presenter.fx.stats().debris).toBeGreaterThan(0);
    expect(r.layers.at(-1)).toBe('enemyShots');
    for (const l of ['fxUnder', 'beams', 'enemies', 'player', 'explosions', 'fxOver', 'flash', 'playerShots'] as const) {
      expect(r.layers.indexOf(l), l).toBeLessThan(r.layers.indexOf('enemyShots'));
    }
    for (const l of ['dim', 'fade', 'captions', 'title'] as const) expect(r.layers).not.toContain(l);
  });
});

describe('state-driven sequences through the presenter', () => {
  it('capture: beam effect and sound loop start with the beam and stop when it ends', () => {
    const r = rig(1);
    r.frame({ ...NO_INPUT, start: true });
    runUntil(r.engine, () => r.engine.phase === 'playing');
    r.engine.world.attackTimerMs = Number.POSITIVE_INFINITY;
    const cmd = r.engine.world.enemies.find((e) => e.slot?.id === '0:4')!;
    r.engine.debugLaunch('commanderBeam', cmd.id);
    let sawLoop = false;
    let sawEmitter = false;
    for (let i = 0; i < 60 * 20 && r.engine.world.player.state !== 'gone'; i++) {
      r.engine.world.enemyShots = [];
      r.frame();
      sawLoop ||= r.sound.stats().loops === 1;
      sawEmitter ||= r.presenter.fx.stats().emitters > 0;
    }
    expect(r.engine.world.player.state).toBe('gone');
    expect(sawLoop && sawEmitter).toBe(true);
    for (let i = 0; i < 60 * 3; i++) {
      r.engine.world.enemyShots = [];
      r.frame();
    }
    expect(r.sound.stats().loops).toBe(0);
    expect(r.presenter.counts.get('beamStarted')).toBe(r.presenter.counts.get('beamEnded'));
    expect(r.presenter.counts.get('fighterCaptured')).toBe(1);
    expect(r.rewards.snapshot().reserves).toBe(1);
  });

  it('loss, respawn blink, game over, restart: transitions follow the engine and restart is clean', () => {
    const r = rig(2);
    r.frame({ ...NO_INPUT, start: true });
    runUntil(r.engine, () => r.engine.phase === 'playing');
    r.engine.world.attackTimerMs = Number.POSITIVE_INFINITY;
    let blinked = false;
    for (let life = 0; life < 3; life++) {
      runUntil(r.engine, () => r.engine.phase === 'playing', 60 * 10);
      shootPlayer(r.engine);
      for (let i = 0; i < 60 * 6 && r.engine.phase !== 'gameOver' && r.engine.phase !== 'playing' || i < 2; i++) {
        r.frame();
        if (r.engine.phase === 'ready' && !r.presenter.lastFrame!.playerVisible) blinked = true;
      }
    }
    expect(blinked).toBe(true);
    runUntil(r.engine, () => r.engine.phase === 'gameOver', 60 * 10);
    r.frame();
    expect(r.presenter.counts.get('gameOver')).toBe(1);
    for (let i = 0; i < 90; i++) r.frame();
    expect(r.presenter.lastFrame!.dim).toBeGreaterThan(0);
    expect(r.sound.stats().loops).toBe(0);
    expect(screenFor({ phase: r.engine.phase, gameOverElapsedMs: r.engine.phaseClock().elapsedMs, overlay: null })).toBe('gameOver');

    expect(applyMenuAction(r.engine, 'restart', null).ok).toBe(true);
    r.frame();
    runUntil(r.engine, () => r.engine.phase === 'ready', 60 * 5);
    r.frame();
    expect(r.rewards.snapshot().score).toBe(0);
    expect(r.rewards.snapshot().reserves).toBe(2);
    expect(r.presenter.fx.idle || r.presenter.fx.stats().debris === 0).toBe(true);
    runUntil(r.engine, () => r.engine.phase === 'playing', 60 * 5);
    r.frame();
    expect(r.presenter.lastFrame!.live).toBe(true);
    expect(r.presenter.lastFrame!.fade).toBe(0);
  });

  it('stage clear -> next stage intro (warp, banner) -> live play, with progression intact', () => {
    const r = rig(9);
    r.frame({ ...NO_INPUT, start: true });
    runUntil(r.engine, () => r.engine.phase === 'playing');
    r.engine.debugDestroyAll();
    let warped = false;
    let bannered = false;
    for (let i = 0; i < 60 * 8 && !(r.engine.phase === 'playing' && r.engine.world.stage === 2); i++) {
      r.frame();
      warped ||= r.presenter.lastFrame!.warp > 0;
      bannered ||= r.presenter.lastFrame!.banner > 0;
    }
    expect(r.engine.world.stage).toBe(2);
    expect(r.engine.phase).toBe('playing');
    expect(warped && bannered).toBe(true);
    expect(r.presenter.counts.get('stageCleared')).toBe(1);
  });
});

describe('menu actions on the real engine', () => {
  it('only valid lifecycle requests are accepted; sub-panels only on title and pause', () => {
    const { engine } = makeEngine();
    expect(applyMenuAction(engine, 'resume', null).ok).toBe(false);
    expect(applyMenuAction(engine, 'restart', null).ok).toBe(false);
    expect(applyMenuAction(engine, 'howTo', null)).toEqual({ overlay: 'howTo', ok: true });
    expect(applyMenuAction(engine, 'back', 'howTo')).toEqual({ overlay: null, ok: true });
    expect(applyMenuAction(engine, 'start', null).ok).toBe(true);
    expect(applyMenuAction(engine, 'start', null).ok).toBe(false); // no double start
    expect(applyMenuAction(engine, 'settings', null).ok).toBe(false); // not during play
    run(engine, 2);
    engine.pause();
    expect(applyMenuAction(engine, 'settings', null)).toEqual({ overlay: 'settings', ok: true });
    expect(applyMenuAction(engine, 'quit', 'settings')).toEqual({ overlay: null, ok: true });
    expect(engine.phase).toBe('title');
  });

  it('game over -> TITLE SCREEN returns to the title', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    for (let i = 0; i < 3; i++) {
      runUntil(h.engine, () => h.engine.phase === 'playing', 60 * 10);
      shootPlayer(h.engine);
      run(h.engine, 2);
    }
    runUntil(h.engine, () => h.engine.phase === 'gameOver', 60 * 10);
    expect(applyMenuAction(h.engine, 'title', null).ok).toBe(true);
    expect(h.engine.phase).toBe('title');
  });
});

describe('screen model', () => {
  it('maps phases to screens; game-over menu waits for the caption', () => {
    expect(screenFor({ phase: 'title', gameOverElapsedMs: 0, overlay: null })).toBe('title');
    expect(screenFor({ phase: 'title', gameOverElapsedMs: 0, overlay: 'settings' })).toBe('settings');
    expect(screenFor({ phase: 'paused', gameOverElapsedMs: 0, overlay: null })).toBe('pause');
    expect(screenFor({ phase: 'gameOver', gameOverElapsedMs: TRANSITIONS.gameOverMenuDelayMs - 1, overlay: null })).toBe('none');
    expect(screenFor({ phase: 'gameOver', gameOverElapsedMs: TRANSITIONS.gameOverMenuDelayMs, overlay: null })).toBe('gameOver');
    for (const phase of ['ready', 'playing', 'challenge', 'playerHit', 'stageCleared', 'restarting'] as const) {
      expect(screenFor({ phase, gameOverElapsedMs: 0, overlay: 'howTo' })).toBe('none');
      expect(overlayForPhase('howTo', phase)).toBeNull();
    }
  });

  it('every menu has unique actions and a first item to focus', () => {
    for (const items of Object.values(MENUS)) {
      expect(items.length).toBeGreaterThan(1);
      expect(new Set(items.map((i) => i.action)).size).toBe(items.length);
    }
    expect(MENUS.pause[0]!.action).toBe('resume');
  });
});

describe('isControlKey', () => {
  it('lets focused buttons keep Enter/Space/arrows, but never steals game keys elsewhere', () => {
    const button = { tagName: 'BUTTON' } as unknown as EventTarget;
    const body = { tagName: 'BODY' } as unknown as EventTarget;
    expect(isControlKey({ code: 'Enter', target: button })).toBe(true);
    expect(isControlKey({ code: 'Space', target: button })).toBe(true);
    expect(isControlKey({ code: 'ArrowLeft', target: { tagName: 'INPUT' } as unknown as EventTarget })).toBe(true);
    expect(isControlKey({ code: 'KeyP', target: button })).toBe(false); // pause still works from a menu
    expect(isControlKey({ code: 'KeyZ', target: button })).toBe(false);
    expect(isControlKey({ code: 'Space', target: body })).toBe(false);
    expect(isControlKey({ code: 'Enter', target: null })).toBe(false);
  });
});
