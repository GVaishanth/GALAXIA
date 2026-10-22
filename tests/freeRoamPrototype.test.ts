import { describe, expect, it } from 'vitest';
import { EDGE, freshShip, SHIP, stepShip, wrapAngle, type FlightInput, type ShipState } from '../src/modes/freeroam/sim.ts';
import { CAMERA, cameraZoom, clampCamera, stepCamera } from '../src/modes/freeroam/camera.ts';
import { combineFlight, flightKeyCommands, flightPadCommands, keyboardVector, padVector, panelKeyCommands, panelPadCommands } from '../src/modes/freeroam/input.ts';
import { DEFAULT_BINDINGS, trackedCodes } from '../src/modes/freeroam/bindings.ts';
const FREEROAM_CODES = trackedCodes(DEFAULT_BINDINGS);
import { KeyTracker } from '../src/shared/input/keyTracker.ts';
import { PointerStick } from '../src/shared/input/pointerStick.ts';
import { DisposableScope } from '../src/shared/lifecycle/scope.ts';
import type { PadSnapshot, PadUpdate } from '../src/input/gamepad.ts';

const W = 2400;
const H = 2400;
const fly = (sh: ShipState, input: FlightInput, ticks: number, mods = {}): number => {
  let pushes = 0;
  for (let i = 0; i < ticks; i++) if (stepShip(sh, input, W, H, mods).pushed) pushes += 1;
  return pushes;
};

/* Sector content, interactions and persistence: tests/sector.test.ts. */
describe('Free Roam ship physics (sim.ts)', () => {
  it('moves in any direction, including vertically and diagonally (unlike Classic)', () => {
    const s = freshShip(W / 2, H / 2);
    fly(s, { moveX: 0, moveY: -1 }, 60);
    expect(s.y).toBeLessThan(H / 2 - 100);
    const x0 = s.x;
    fly(s, { moveX: 0.7071, moveY: 0.7071 }, 90);
    expect(s.x).toBeGreaterThan(x0 + 50);
    expect(Math.abs(s.heading - Math.PI * 0.75)).toBeLessThan(0.2); // nose follows travel (0 = up, clockwise)
  });

  it('respects the speed cap, coasts to a stop and ignores non-finite input', () => {
    const s = freshShip(W / 2, H / 2);
    fly(s, { moveX: 5, moveY: 5 }, 300);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(SHIP.maxSpeed + 1e-6);
    fly(s, { moveX: Number.NaN, moveY: Infinity }, 600);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThan(1);
    expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
  });

  it('never leaves the sector: the soft edge pushes the ship back', () => {
    const s = freshShip(300, H / 2);
    expect(fly(s, { moveX: -1, moveY: 0 }, 60 * 20)).toBeGreaterThan(0);
    expect(s.x).toBeGreaterThanOrEqual(0);
    expect(s.x).toBeLessThan(EDGE.band);
  });

  it('applies hazard modifiers: ion storms cap speed, dust adds drag, shear pulls', () => {
    const ion = freshShip(W / 2, H / 2);
    fly(ion, { moveX: 1, moveY: 0 }, 240, { speedMul: 0.7 });
    expect(Math.hypot(ion.vx, ion.vy)).toBeLessThanOrEqual(SHIP.maxSpeed * 0.7 + 1e-6);
    const clear = freshShip(W / 2, H / 2);
    const dust = freshShip(W / 2, H / 2);
    fly(clear, { moveX: 1, moveY: 0 }, 30);
    fly(dust, { moveX: 1, moveY: 0 }, 30, { extraDrag: 2 });
    expect(dust.x - W / 2).toBeLessThan(clear.x - W / 2);
    const shear = freshShip(W / 2, H / 2);
    fly(shear, { moveX: 0, moveY: 0 }, 60, { pullX: 200 });
    expect(shear.x).toBeGreaterThan(W / 2 + 10);
  });

  it('is deterministic: same inputs -> same state; interpolation keeps the previous pose', () => {
    const go = (): ShipState => {
      const s = freshShip(W / 2, H / 2);
      for (let i = 0; i < 900; i++) stepShip(s, { moveX: Math.sin(i / 40), moveY: Math.cos(i / 55) }, W, H, {});
      return s;
    };
    expect(go()).toEqual(go());
    const s = freshShip(100, 100);
    stepShip(s, { moveX: 1, moveY: 0 }, W, H, {});
    expect(s.px).toBe(100);
    expect(s.x).toBeGreaterThan(100);
    expect(Math.abs(wrapAngle(3 * Math.PI) - Math.PI)).toBeLessThan(1e-9);
  });
});

describe('Free Roam camera', () => {
  it('scales uniformly so every screen shape sees a comparable area (never stretched)', () => {
    for (const [w, h] of [
      [1280, 720],
      [390, 844],
      [2560, 1080],
      [568, 320],
      [3840, 2160],
    ] as const) {
      const z = cameraZoom(w, h);
      expect(Math.min(w, h) / z).toBeLessThanOrEqual(CAMERA.shortSideArt + 1e-9);
      expect(Math.max(w, h) / z).toBeLessThanOrEqual(CAMERA.longSideMaxArt + 1e-9);
    }
    expect(cameraZoom(0, 0)).toBeGreaterThan(0);
  });

  it('follows the ship frame-rate independently and clamps to the sector', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    stepCamera(a, 100, 50, 0, 0, 1 / 30, false);
    stepCamera(b, 100, 50, 0, 0, 1 / 60, false);
    stepCamera(b, 100, 50, 0, 0, 1 / 60, false);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    const c = { x: -500, y: 99999 };
    clampCamera(c, 640, 360, 2400, 2400, 160);
    expect(c).toEqual({ x: 320 - 160, y: 2400 - 180 + 160 });
    const tiny = { x: 5, y: 5 };
    clampCamera(tiny, 5000, 5000, 2400, 2400, 0);
    expect(tiny).toEqual({ x: 1200, y: 1200 });
  });
});

describe('Free Roam input interpretation', () => {
  it('builds an 8-way keyboard vector with normalised diagonals', () => {
    expect(keyboardVector(new Set(['KeyW']))).toEqual({ x: 0, y: -1 });
    const d = keyboardVector(new Set(['ArrowRight', 'ArrowDown']));
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 9);
    expect(keyboardVector(new Set(['KeyA', 'KeyD']))).toEqual({ x: 0, y: 0 });
  });

  it('reads the left stick with a dead zone and the D-pad as digital input', () => {
    const snap = (axes: number[], pressed: boolean[] = []): PadSnapshot => ({ axes, pressed });
    expect(padVector(null)).toEqual({ x: 0, y: 0 });
    expect(padVector(snap([0.1, -0.1]))).toEqual({ x: 0, y: 0 });
    const v = padVector(snap([1, 0]));
    expect(v.x).toBeCloseTo(1, 6);
    expect(Math.hypot(...Object.values(padVector(snap([1, 1]))))).toBeLessThanOrEqual(1 + 1e-9);
    const dpad = [];
    dpad[12] = true; // up
    dpad[15] = true; // right
    const dv = padVector(snap([0, 0], dpad));
    expect(dv.x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(dv.y).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it('combines devices without exceeding full deflection', () => {
    const f = combineFlight({ x: 1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 });
    expect(Math.hypot(f.moveX, f.moveY)).toBeCloseTo(1, 9);
    expect(combineFlight({ x: 0.3, y: 0 })).toEqual({ moveX: 0.3, moveY: 0 });
  });

  it('maps keys and pad buttons to flight and panel commands', () => {
    // flight: from the bindings (Space fires: held, not a command)
    expect(flightKeyCommands(['Escape', 'KeyP', 'Enter', 'Space', 'KeyE', 'KeyM', 'KeyI', 'Equal', 'Minus', 'KeyR'])).toEqual(['back', 'pause', 'interact', 'interact', 'map', 'cargo', 'zoomIn', 'zoomOut']);
    // panels: fixed navigation keys
    expect(panelKeyCommands(['Escape', 'KeyP', 'Enter', 'Space', 'KeyR', 'ArrowUp', 'ArrowRight', 'KeyM', 'KeyI'])).toEqual(['back', 'pause', 'confirm', 'confirm', 'restart', 'prev', 'next', 'map', 'cargo']);
    const update = { moveX: 0, presses: ['start', 'a', 'b', 'up', 'down', 'select', 'y'] } as unknown as PadUpdate;
    expect(panelPadCommands(update)).toEqual(['pause', 'confirm', 'back', 'prev', 'next', 'map', 'cargo']);
    expect(flightPadCommands(update)).toEqual(['pause', 'interact', 'back', 'map', 'cargo']);
  });
});

describe('shared input devices', () => {
  const key = (code: string, extra: Partial<{ repeat: boolean; ctrlKey: boolean; target: unknown }> = {}) => {
    let prevented = false;
    const e = { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra, preventDefault: () => (prevented = true) };
    return { e: e as never, prevented: () => prevented };
  };

  it('KeyTracker tracks only its codes, edge-triggers presses and clears on demand', () => {
    const k = new KeyTracker(FREEROAM_CODES);
    const w = key('KeyW');
    expect(k.down(w.e)).toBe(true);
    expect(w.prevented()).toBe(true);
    expect(k.down(key('KeyW', { repeat: true }).e)).toBe(true);
    const tab = key('Tab');
    expect(k.down(tab.e)).toBe(false);
    expect(tab.prevented()).toBe(false); // browser keys (Tab) keep working
    expect(k.down(key('KeyW', { ctrlKey: true }).e)).toBe(false);
    expect(k.down(key('KeyD', { target: { tagName: 'INPUT', type: 'text' } }).e)).toBe(false);
    expect(k.takePresses()).toEqual(['KeyW']);
    expect(k.takePresses()).toEqual([]);
    expect(k.isDown('KeyW')).toBe(true);
    const up = key('KeyW');
    k.up(up.e);
    expect(up.prevented()).toBe(true); // no native Space/Enter click after the mode handled it
    expect(k.isDown('KeyW')).toBe(false);
    k.down(key('Space').e);
    k.clear();
    expect(k.heldCodes.size).toBe(0);
    expect(k.takePresses()).toEqual([]);
  });

  it('KeyTracker listeners die with their scope and held keys are released', () => {
    const target = new EventTarget();
    const scope = new DisposableScope();
    const k = new KeyTracker(['KeyW']);
    k.attach(scope, target);
    const ev = Object.assign(new Event('keydown'), { code: 'KeyW', repeat: false, ctrlKey: false, metaKey: false, altKey: false });
    target.dispatchEvent(ev);
    expect(k.isDown('KeyW')).toBe(true);
    scope.dispose();
    expect(k.isDown('KeyW')).toBe(false);
    target.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyW', repeat: false, ctrlKey: false, metaKey: false, altKey: false }));
    expect(k.isDown('KeyW')).toBe(false);
  });

  it('PointerStick: one owner pointer, dead zone, full deflection at the radius', () => {
    const s = new PointerStick(50, 0.1);
    expect(s.down(1, 100, 100)).toBe(true);
    expect(s.down(2, 0, 0)).toBe(false); // a second finger does not steal it
    s.move(2, 500, 500);
    expect(s.state().vector).toEqual({ x: 0, y: 0 });
    s.move(1, 103, 100);
    expect(s.state().vector).toEqual({ x: 0, y: 0 });
    s.move(1, 250, 100);
    expect(s.state().vector.x).toBeCloseTo(1, 9);
    s.move(1, 100, 75);
    expect(s.state().vector.y).toBeLessThan(0);
    expect(Math.hypot(s.state().vector.x, s.state().vector.y)).toBeLessThan(1);
    s.up(2);
    expect(s.state().active).toBe(true);
    s.up(1);
    expect(s.state()).toMatchObject({ active: false, vector: { x: 0, y: 0 } });
  });
});
