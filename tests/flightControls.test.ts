/**
 * Free Roam Prompt 7: movement, orientation, camera, bindings, pointers,
 * combat and the v5 profile. Pure modules only (no DOM); browser behaviour is
 * covered by docs/development/playtest/freeroam-p7.mjs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_INPUT } from '../src/core/game/input.ts';
import { ACTION_LABEL, clearBinding, DEFAULT_BINDINGS, FLIGHT_ACTIONS, findBinding, isBindable, keyLabel, rebind, sanitizeBindings, trackedCodes, type Bindings } from '../src/modes/freeroam/bindings.ts';
import { CAMERA, cameraView, cameraZoom, clampCamera, clampZoom, clientToDevice, screenToWorld, snapCamera, stepCamera, stepZoom, worldToScreen, type CameraState } from '../src/modes/freeroam/camera.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { combineFlight, flightKeyCommands, keyboardFire, keyboardVector, padAim, padFire, panelKeyCommands } from '../src/modes/freeroam/input.ts';
import { FlightPointers } from '../src/modes/freeroam/pointers.ts';
import { DEFAULT_CONTROLS, EMPTY_PROFILE, loadProfile } from '../src/modes/freeroam/profile.ts';
import { loadFreeRoamPrefs, saveFreeRoamPrefs } from '../src/modes/freeroam/saveSlots.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, disposeSectorRun, restartSector, RUN, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { freshShip, headingOf, noseOf, SHIP, stepShip, wrapAngle, type FlightInput, type ShipState, type ShipTuning } from '../src/modes/freeroam/sim.ts';
import { KeyTracker } from '../src/shared/input/keyTracker.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import type { PadSnapshot } from '../src/input/gamepad.ts';

const W = 4000;
const H = 4000;
const run = (sh: ShipState, input: FlightInput, ticks: number, tune: ShipTuning = SHIP): void => {
  for (let i = 0; i < ticks; i++) stepShip(sh, input, W, H, {}, tune);
};
const speed = (sh: ShipState): number => Math.hypot(sh.vx, sh.vy);
const angleBetween = (ax: number, ay: number, bx: number, by: number): number => Math.abs(wrapAngle(Math.atan2(ay, ax) - Math.atan2(by, bx)));

/* ------------------------------------------------------------- movement */
describe('Free Roam movement (sim.ts, FR-TD-40)', () => {
  const DIRS: [string, number, number][] = [
    ['up', 0, -1],
    ['down', 0, 1],
    ['left', -1, 0],
    ['right', 1, 0],
    ['up-left', -Math.SQRT1_2, -Math.SQRT1_2],
    ['up-right', Math.SQRT1_2, -Math.SQRT1_2],
    ['down-left', -Math.SQRT1_2, Math.SQRT1_2],
    ['down-right', Math.SQRT1_2, Math.SQRT1_2],
  ];
  for (const [name, x, y] of DIRS) {
    it(`flies ${name} along the input, at the same top speed in every direction`, () => {
      const sh = freshShip(2000, 2000);
      run(sh, { moveX: x, moveY: y }, 90);
      const dx = sh.x - 2000;
      const dy = sh.y - 2000;
      expect(angleBetween(dx, dy, x, y)).toBeLessThan(1e-6);
      expect(speed(sh)).toBeGreaterThan(SHIP.maxSpeed * 0.95);
      expect(speed(sh)).toBeLessThanOrEqual(SHIP.maxSpeed + 1e-9);
    });
  }

  it('is responsive: most of the top speed within a third of a second, and settles by itself (no long drift)', () => {
    const sh = freshShip(2000, 2000);
    run(sh, { moveX: 1, moveY: 0 }, 20);
    expect(speed(sh)).toBeGreaterThan(SHIP.maxSpeed * 0.75);
    run(sh, { moveX: 1, moveY: 0 }, 60);
    run(sh, { moveX: 0, moveY: 0 }, 60); // let go for one second
    expect(speed(sh)).toBeLessThan(SHIP.maxSpeed * 0.06);
    run(sh, { moveX: 0, moveY: 0 }, 60);
    expect(speed(sh)).toBeLessThan(2);
  });

  it('turns around quickly: thrust against the motion is boosted', () => {
    const boosted = freshShip(2000, 2000);
    const plain = freshShip(2000, 2000);
    run(boosted, { moveX: 1, moveY: 0 }, 90);
    run(plain, { moveX: 1, moveY: 0 }, 90, { ...SHIP, reverseBoost: 1 });
    let tb = 0;
    let tp = 0;
    while (boosted.vx > 0 && tb < 600) {
      stepShip(boosted, { moveX: -1, moveY: 0 }, W, H);
      tb += 1;
    }
    while (plain.vx > 0 && tp < 600) {
      stepShip(plain, { moveX: -1, moveY: 0 }, W, H, {}, { ...SHIP, reverseBoost: 1 });
      tp += 1;
    }
    expect(tb).toBeLessThan(tp);
    expect(tb).toBeLessThanOrEqual(12); // reversing from full speed takes about a fifth of a second
  });

  it('is tunable: acceleration, top speed and damping come from a ShipTuning object', () => {
    const slow: ShipTuning = { ...SHIP, maxSpeed: 150, accel: 400 };
    const a = freshShip(2000, 2000);
    run(a, { moveX: 1, moveY: 0 }, 120, slow);
    expect(speed(a)).toBeLessThanOrEqual(150 + 1e-9);
    expect(speed(a)).toBeGreaterThan(140);
    const slippery: ShipTuning = { ...SHIP, brakeDrag: 0.2 };
    const b = freshShip(2000, 2000);
    const c = freshShip(2000, 2000);
    run(b, { moveX: 1, moveY: 0 }, 60, slippery);
    run(c, { moveX: 1, moveY: 0 }, 60);
    run(b, { moveX: 0, moveY: 0 }, 60, slippery);
    run(c, { moveX: 0, moveY: 0 }, 60);
    expect(speed(b)).toBeGreaterThan(speed(c) * 5);
  });

  it('rejects non-finite input and clamps over-long input to full deflection', () => {
    const sh = freshShip(2000, 2000);
    stepShip(sh, { moveX: Number.NaN, moveY: Number.POSITIVE_INFINITY }, W, H);
    expect(Number.isFinite(sh.x) && Number.isFinite(sh.vx)).toBe(true);
    const a = freshShip(2000, 2000);
    const b = freshShip(2000, 2000);
    run(a, { moveX: 5, moveY: 0 }, 30);
    run(b, { moveX: 1, moveY: 0 }, 30);
    expect(a.x).toBeCloseTo(b.x, 9);
  });

  it('is deterministic for the same input sequence', () => {
    const seq = (sh: ShipState): void => {
      for (let i = 0; i < 400; i++) stepShip(sh, { moveX: Math.sin(i / 17), moveY: Math.cos(i / 23), aimX: i % 50 < 25 ? 1 : undefined, aimY: i % 50 < 25 ? 0.5 : undefined }, W, H);
    };
    const a = freshShip(1000, 1000);
    const b = freshShip(1000, 1000);
    seq(a);
    seq(b);
    expect(a).toEqual(b);
  });
});

/* ---------------------------------------------------------- orientation */
describe('Free Roam orientation rule (FR-TD-41)', () => {
  it('noseOf / headingOf agree: heading 0 is up, clockwise positive', () => {
    expect(noseOf(0).x).toBeCloseTo(0, 12);
    expect(noseOf(0).y).toBeCloseTo(-1, 12);
    expect(noseOf(Math.PI / 2).x).toBeCloseTo(1, 12);
    for (let a = -3; a <= 3; a += 0.37) {
      const n = noseOf(a);
      expect(wrapAngle(headingOf(n.x, n.y) - a)).toBeCloseTo(0, 9);
    }
    expect(headingOf(0, 0)).toBe(0);
  });

  it('the nose follows the direction of travel, turning at a capped rate (no jumps)', () => {
    const sh = freshShip(2000, 2000, 0);
    let maxStep = 0;
    for (let i = 0; i < 120; i++) {
      const before = sh.heading;
      stepShip(sh, { moveX: 0, moveY: 1 }, W, H); // reverse: the nose must swing 180 degrees
      maxStep = Math.max(maxStep, Math.abs(wrapAngle(sh.heading - before)));
    }
    expect(maxStep).toBeLessThanOrEqual(SHIP.turnRate / 60 + 1e-9);
    expect(Math.abs(wrapAngle(sh.heading - Math.PI))).toBeLessThan(0.02);
    expect(angleBetween(noseOf(sh.heading).x, noseOf(sh.heading).y, sh.vx, sh.vy)).toBeLessThan(0.02);
  });

  it('crosses the ±π seam the short way and keeps interpolation continuous', () => {
    const sh = freshShip(2000, 2000, Math.PI - 0.05);
    sh.vx = -1; // a tiny drift does not matter below the face-velocity threshold
    for (let i = 0; i < 30; i++) {
      stepShip(sh, { moveX: -0.2, moveY: 1 }, W, H); // target just past the seam (down-left)
      expect(Math.abs(wrapAngle(sh.heading - sh.pheading))).toBeLessThanOrEqual(SHIP.turnRate / 60 + 1e-9);
      expect(Math.abs(sh.heading - sh.pheading)).toBeLessThanOrEqual(SHIP.turnRate / 60 + 1e-9); // no 2π jump for the renderer
    }
  });

  it('with an aim the nose turns toward the aim, not the travel direction; strafing keeps it there', () => {
    const sh = freshShip(2000, 2000, 0);
    for (let i = 0; i < 90; i++) stepShip(sh, { moveX: 1, moveY: 0, aimX: 0, aimY: 1 }, W, H);
    expect(Math.abs(wrapAngle(sh.heading - Math.PI))).toBeLessThan(0.01); // aims down
    expect(sh.vx).toBeGreaterThan(SHIP.maxSpeed * 0.9); // while flying right
    let maxStep = 0;
    for (let i = 0; i < 30; i++) {
      const before = sh.heading;
      stepShip(sh, { moveX: 0, moveY: 0, aimX: 0, aimY: -1 }, W, H);
      maxStep = Math.max(maxStep, Math.abs(wrapAngle(sh.heading - before)));
    }
    expect(maxStep).toBeLessThanOrEqual(SHIP.aimTurnRate / 60 + 1e-9);
  });

  it('records the applied thrust for the engine effects', () => {
    const sh = freshShip(2000, 2000);
    stepShip(sh, { moveX: 0.6, moveY: 0 }, W, H);
    expect(sh.thrusting).toBe(true);
    expect(sh.thrustX).toBeCloseTo(0.6, 9);
    stepShip(sh, { moveX: 0, moveY: 0 }, W, H);
    expect(sh.thrusting).toBe(false);
    expect(sh.thrustX).toBe(0);
  });
});

/* --------------------------------------------------------------- camera */
describe('Free Roam camera (camera.ts, FR-TD-42)', () => {
  it('world -> screen -> world round-trips at any zoom and canvas size', () => {
    for (const [w, h, z] of [
      [1280, 720, 1],
      [390 * 3, 844 * 3, 1.5],
      [568, 320, 0.75],
      [1, 1, 1],
    ] as const) {
      const v = cameraView({ x: 1234.5, y: 987.25 }, cameraZoom(w, h, z), w, h);
      for (const [x, y] of [
        [0, 0],
        [1234.5, 987.25],
        [3000, 50],
      ] as const) {
        const s = worldToScreen(v, x, y);
        const back = screenToWorld(v, s.x, s.y);
        expect(back.x).toBeCloseTo(x, 6);
        expect(back.y).toBeCloseTo(y, 6);
      }
      expect(worldToScreen(v, v.x, v.y)).toEqual({ x: w / 2, y: h / 2 });
    }
  });

  it('maps client (CSS) px to device px through the canvas box and pixel ratio', () => {
    expect(clientToDevice(110, 70, { left: 10, top: 20 }, 3)).toEqual({ x: 300, y: 150 });
    const v = cameraView({ x: 500, y: 500 }, 2, 800, 600);
    const d = clientToDevice(10 + 400 / 2, 20 + 300 / 2, { left: 10, top: 20 }, 2); // CSS centre of an 400x300 CSS canvas at ratio 2
    expect(screenToWorld(v, d.x, d.y)).toEqual({ x: 500, y: 500 });
  });

  it('shows the same world area whatever the pixel ratio (crisp, not bigger)', () => {
    const a = cameraZoom(390, 844);
    const b = cameraZoom(390 * 3, 844 * 3);
    expect(390 / a).toBeCloseTo((390 * 3) / b, 9);
    expect(844 / a).toBeCloseTo(CAMERA.longSideMaxArt, 9); // portrait phone: the long side limits the view
    expect(720 / cameraZoom(1280, 720)).toBe(CAMERA.shortSideArt);
    expect((720 * 2) / cameraZoom(1280 * 2, 720 * 2)).toBe(CAMERA.shortSideArt); // DPR 2: twice the pixels, same world
  });

  it('player zoom is bounded, steps back to exactly 1 and ignores junk', () => {
    expect(clampZoom(10)).toBe(CAMERA.zoomMax);
    expect(clampZoom(0.1)).toBe(CAMERA.zoomMin);
    expect(clampZoom(Number.NaN)).toBe(1);
    let z = 1;
    for (let i = 0; i < 20; i++) z = stepZoom(z, 1);
    expect(z).toBe(CAMERA.zoomMax);
    for (let i = 0; i < 20; i++) z = stepZoom(z, -1);
    expect(z).toBe(CAMERA.zoomMin);
    z = stepZoom(stepZoom(1, 1), -1);
    expect(z).toBe(1);
    expect(cameraZoom(1280, 720, 1.5) / cameraZoom(1280, 720, 1)).toBeCloseTo(1.5, 9);
  });

  it('follows smoothly, frame-rate independently, and snaps when the ship jumps far', () => {
    const a: CameraState = { x: 0, y: 0 };
    const b: CameraState = { x: 0, y: 0 };
    for (let i = 0; i < 60; i++) stepCamera(a, 300, 0, 0, 0, 1 / 60, false);
    for (let i = 0; i < 30; i++) stepCamera(b, 300, 0, 0, 0, 1 / 30, false);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.x).toBeGreaterThan(250);
    expect(a.x).toBeLessThan(300);
    const c: CameraState = { x: 0, y: 0 };
    stepCamera(c, CAMERA.snapDistance + 100, 0, 0, 0, 1 / 60, false);
    expect(c).toEqual({ x: CAMERA.snapDistance + 100, y: 0 });
    snapCamera(c, 5, 6);
    expect(c).toEqual({ x: 5, y: 6 });
  });

  it('keeps the view inside the sector plus a margin', () => {
    const c: CameraState = { x: -500, y: 99999 };
    clampCamera(c, 640, 360, 2400, 2400);
    expect(c).toEqual({ x: 320 - CAMERA.edgeMargin, y: 2400 - 180 + CAMERA.edgeMargin });
  });

  it('never alters the simulation: identical flights under different cameras, zooms and canvas sizes', () => {
    const L = generateSector(getCatalogue().systems.find((s) => s.id === 'milky-way/sol')!, sectorContext(buildNavGraph(), 'milky-way/sol'));
    const fly = (w: number, h: number, z: number): SectorRun => {
      const r = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 9 });
      const cam: CameraState = { x: 0, y: 0 };
      for (let i = 0; i < 600; i++) {
        stepSector(r, { moveX: Math.cos(i / 40), moveY: Math.sin(i / 55), fire: i % 3 === 0 });
        const zoom = cameraZoom(w, h, z);
        stepCamera(cam, r.ship.x, r.ship.y, r.ship.vx, r.ship.vy, 1 / 60, false);
        clampCamera(cam, w / zoom, h / zoom, L.width, L.height);
        const v = cameraView(cam, zoom, w, h);
        screenToWorld(v, w / 3, h / 3); // pointer mapping is read-only too
      }
      return r;
    };
    const a = fly(1280, 720, 1);
    const b = fly(390 * 3, 844 * 3, 1.5);
    const c = fly(568, 320, 0.75);
    for (const r of [b, c]) {
      expect(r.ship).toEqual(a.ship);
      expect(r.shots.map((s) => [s.x, s.y])).toEqual(a.shots.map((s) => [s.x, s.y]));
      expect(r.tick).toBe(a.tick);
    }
  });
});

/* ------------------------------------------------------------- bindings */
describe('Free Roam key bindings (bindings.ts, FR-TD-43)', () => {
  it('defaults: WASD + arrows fly, Space / J fire, E / Enter interact, M map, I cargo, P pause; no key is used twice', () => {
    const b = DEFAULT_BINDINGS;
    expect(b.up).toEqual(['KeyW', 'ArrowUp']);
    expect(b.fire[0]).toBe('Space');
    expect(b.interact).toContain('KeyE');
    expect(b.map[0]).toBe('KeyM');
    expect(b.cargo[0]).toBe('KeyI');
    const all = FLIGHT_ACTIONS.flatMap((a) => b[a].filter((k): k is string => k !== null));
    expect(new Set(all).size).toBe(all.length);
    for (const a of FLIGHT_ACTIONS) expect(ACTION_LABEL[a].length).toBeGreaterThan(0);
  });

  it('rebinding moves a key that another action uses; the other action keeps a key', () => {
    const r = rebind(DEFAULT_BINDINGS, 'fire', 0, 'KeyW');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bindings.fire[0]).toBe('KeyW');
    expect(r.displaced).toBe('up');
    expect(r.bindings.up).toEqual(['ArrowUp', null]); // still flyable
    expect(findBinding(r.bindings, 'KeyW')).toEqual({ action: 'fire', slot: 0 });
  });

  it('swaps when moving the key would leave the other action with none', () => {
    const one: Bindings = { ...DEFAULT_BINDINGS, map: ['KeyM', null], cargo: ['KeyI', null] };
    const r = rebind(one, 'cargo', 0, 'KeyM');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bindings.cargo[0]).toBe('KeyM');
    expect(r.bindings.map[0]).toBe('KeyI');
  });

  it('refuses reserved / unbindable keys and never leaves an action without a key', () => {
    expect(rebind(DEFAULT_BINDINGS, 'fire', 0, 'Escape')).toEqual({ ok: false, reason: 'not-bindable' });
    expect(isBindable('Tab')).toBe(false);
    expect(isBindable('F5')).toBe(false);
    expect(isBindable('KeyQ')).toBe(true);
    const c = clearBinding(DEFAULT_BINDINGS, 'up', 1);
    expect(c.ok && c.bindings.up).toEqual(['KeyW', null]);
    if (c.ok) expect(clearBinding(c.bindings, 'up', 0)).toEqual({ ok: false, reason: 'last-key' });
  });

  it('sanitises stored bindings: duplicates, junk and missing actions fall back safely', () => {
    expect(sanitizeBindings(undefined)).toEqual({ bindings: DEFAULT_BINDINGS, repaired: false });
    expect(sanitizeBindings('x').repaired).toBe(true);
    const dup = sanitizeBindings({ ...DEFAULT_BINDINGS, fire: ['KeyW', null] });
    expect(dup.repaired).toBe(true);
    expect(dup.bindings).toEqual(DEFAULT_BINDINGS); // fire would have no key -> defaults
    const ok = rebind(DEFAULT_BINDINGS, 'fire', 1, 'KeyK');
    if (ok.ok) expect(sanitizeBindings(JSON.parse(JSON.stringify(ok.bindings)))).toEqual({ bindings: ok.bindings, repaired: false });
  });

  it('flight reads the bindings; panels keep fixed navigation keys', () => {
    const r = rebind(DEFAULT_BINDINGS, 'up', 0, 'KeyI'); // I moves from cargo to up; cargo swaps to W
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(keyboardVector(new Set(['KeyI']), r.bindings)).toEqual({ x: 0, y: -1 });
    expect(keyboardVector(new Set(['KeyI']))).toEqual({ x: 0, y: 0 });
    expect(flightKeyCommands(['KeyW'], r.bindings)).toEqual(['cargo']);
    expect(panelKeyCommands(['KeyW'], r.bindings)).toEqual(['prev']); // menus: W still moves up
    expect(keyboardFire(new Set(['KeyJ']))).toBe(true);
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel(null)).toBe('—');
  });

  it('the key tracker follows rebinding and drops held keys when its codes change', () => {
    const k = new KeyTracker(trackedCodes(DEFAULT_BINDINGS));
    const ev = (code: string) => ({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: null, preventDefault: () => undefined }) as never;
    // KeyF is bound to nothing by default (KeyQ became the missile key in Combat P03)
    expect(k.down(ev('KeyF'))).toBe(false);
    k.down(ev('KeyW'));
    const r = rebind(DEFAULT_BINDINGS, 'fire', 1, 'KeyF');
    if (r.ok) k.setCodes(trackedCodes(r.bindings));
    expect(k.heldCodes.size).toBe(0);
    expect(k.down(ev('KeyF'))).toBe(true);
  });
});

/* ------------------------------------------------------- gamepad + combine */
describe('Free Roam gamepad aim and fire', () => {
  const snap = (axes: number[], pressed: boolean[] = []): PadSnapshot => ({ axes, pressed });
  it('the right stick aims past its dead zone; RT / RB / X fire', () => {
    expect(padAim(snap([0, 0, 0.1, 0.1]))).toBeNull();
    expect(padAim(snap([0, 0, 0.8, -0.2]))).toEqual({ x: 0.8, y: -0.2 });
    expect(padAim(null)).toBeNull();
    const p: boolean[] = [];
    expect(padFire(snap([], p))).toBe(false);
    p[7] = true;
    expect(padFire(snap([], p))).toBe(true);
    expect(padFire(snap([], Object.assign([], { 5: true })))).toBe(true);
    expect(padFire(snap([], Object.assign([], { 2: true })))).toBe(true);
  });

  it('keyboard, stick and pad combine without exceeding full thrust', () => {
    const f = combineFlight(keyboardVector(new Set(['KeyD', 'KeyS'])), { x: 1, y: 0 }, { x: 0, y: 1 });
    expect(Math.hypot(f.moveX, f.moveY)).toBeCloseTo(1, 9);
  });
});

/* ------------------------------------------------------------- pointers */
describe('Free Roam pointers (pointers.ts, FR-TD-44)', () => {
  it('moving and firing work at the same time; releasing one finger never cancels the other', () => {
    const p = new FlightPointers(56);
    expect(p.stickDown(1, 100, 300)).toBe(true);
    p.move(1, 156, 300);
    p.fireDown(2);
    expect(p.firing).toBe(true);
    expect(p.snapshot().stick.x).toBeCloseTo(1, 6);
    p.release(2); // lift the FIRE finger: still steering
    expect(p.firing).toBe(false);
    expect(p.snapshot().stickActive).toBe(true);
    expect(p.snapshot().stick.x).toBeCloseTo(1, 6);
    p.fireDown(3);
    p.release(1); // lift the steering finger: still firing
    expect(p.snapshot().stickActive).toBe(false);
    expect(p.firing).toBe(true);
  });

  it('a second finger on the canvas does not steal the stick; the FIRE finger cannot become the stick', () => {
    const p = new FlightPointers(56);
    p.stickDown(1, 100, 300);
    expect(p.stickDown(4, 500, 300)).toBe(false);
    p.move(4, 600, 300); // moves of a non-stick pointer are ignored
    expect(p.snapshot().stick).toEqual({ x: 0, y: 0 });
    p.fireDown(5);
    p.release(1);
    expect(p.stickDown(5, 10, 10)).toBe(false);
  });

  it('two FIRE fingers: firing continues until both are lifted', () => {
    const p = new FlightPointers();
    p.fireDown(7);
    p.fireDown(8);
    p.release(7);
    expect(p.firing).toBe(true);
    p.release(8);
    expect(p.firing).toBe(false);
  });

  it('reset (blur, hidden tab, rotation, panel) releases every role; the cursor survives unless asked', () => {
    const p = new FlightPointers();
    p.stickDown(1, 0, 0);
    p.move(1, 50, 0);
    p.fireDown(2);
    p.weaponDown(3);
    p.lockDown(4); // P04.1 LOCK
    p.targetDown(5); // P04.1 polish NEXT TARGET
    p.stopDown(6); // P04.3 STOP (REALISTIC flight)
    p.silentDown(9); // P07.2 SILENT
    expect(p.snapshot().stopTouches).toBe(1);
    expect(p.snapshot().silentTouches).toBe(1);
    p.setCursor(30, 40);
    p.setMouseFire(true);
    p.reset();
    expect(p.snapshot()).toEqual({ stickActive: false, stick: { x: 0, y: 0 }, fireTouches: 0, boostTouches: 0, weaponTouches: 0, lockTouches: 0, targetTouches: 0, stopTouches: 0, silentTouches: 0, mouseFire: false, cursor: { x: 30, y: 40 } });
    expect(p.takeLockPress()).toBe(false); // a latched LOCK press does not survive a reset
    expect(p.takeSilentPress()).toBe(false); // nor a latched SILENT press
    expect(p.takeStopPress()).toBe(false); // nor a latched STOP press (STOP is never left engaged by a stale press)
    expect(p.takeTargetPress()).toBe(false); // nor a latched NEXT TARGET press
    expect(p.firing).toBe(false);
    expect(p.weaponHeld).toBe(false);
    expect(p.takeWeaponPress()).toBe(false); // a latched press does not survive a reset
    p.reset(true);
    expect(p.snapshot().cursor).toBeNull();
    // a pointerup that arrives after the reset is harmless
    p.release(1);
    p.release(2);
    expect(p.firing).toBe(false);
  });
});

/* --------------------------------------------------------------- combat */
describe('Free Roam basic combat (sector/run.ts, FR-TD-45)', () => {
  const graph = buildNavGraph();
  const systems = getCatalogue().systems;
  const all = systems.map((s) => generateSector(s, sectorContext(graph, s.id)));
  const withInstallation = all.find((L) => L.pois.some((p) => p.kind === 'installation') && L.patrols.length > 0)!;
  /** A cleared copy of a sector (no solids, no patrols) for exact shot geometry. */
  const open = (L: SectorLayout): SectorLayout => ({ ...L, rocks: [], landmarks: [], patrols: [], pois: L.pois.filter((p) => p.kind === 'exit') });
  const still = (r: SectorRun, x: number, y: number, heading: number): void => {
    Object.assign(r.ship, { x, y, px: x, py: y, vx: 0, vy: 0, heading, pheading: heading });
  };
  const idle: SectorInput = { moveX: 0, moveY: 0 };
  /** Aim with lead, as a pilot does: where the target will be when a bolt arrives. */
  const leadAim = (r: SectorRun, t: { x: number; y: number; vx: number; vy: number }): SectorInput => {
    let x = t.x;
    let y = t.y;
    for (let i = 0; i < 3; i++) {
      const tt = Math.hypot(x - r.ship.x, y - r.ship.y) / r.craft.weapon.shotSpeed;
      x = t.x + t.vx * tt;
      y = t.y + t.vy * tt;
    }
    return { moveX: 0, moveY: 0, aimX: x - r.ship.x, aimY: y - r.ship.y, fire: true };
  };
  /** Survey already done: test layouts without survey marks must not end the run on the first tick. */
  const SURVEYED = { ...EMPTY_SECTOR_SAVE, surveyed: true };

  it('bolts leave the nose tip along the nose, with the forward speed added', () => {
    const r = createSectorRun(open(withInstallation), SURVEYED, { seed: 1 });
    for (const h of [0, 1, -2.5, Math.PI]) {
      r.shots.length = 0;
      r.fireCooldown = 0;
      still(r, 1500, 1500, h);
      r.ship.vx = noseOf(h).x * 200;
      r.ship.vy = noseOf(h).y * 200;
      const ev = stepSector(r, { moveX: 0, moveY: 0, aimX: noseOf(h).x, aimY: noseOf(h).y, fire: true });
      expect(ev).toContainEqual({ type: 'fired' });
      const s = r.shots[0]!;
      const n = noseOf(r.ship.heading);
      expect(angleBetween(s.vx, s.vy, n.x, n.y)).toBeLessThan(1e-9);
      expect(Math.hypot(s.vx, s.vy)).toBeGreaterThan(r.craft.weapon.shotSpeed);
      expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(r.craft.weapon.shotSpeed + SHIP.maxSpeed + 1e-9);
    }
  });

  it('holding fire respects the cooldown; bolts expire; the pool is bounded', () => {
    const r = createSectorRun(open(withInstallation), SURVEYED, { seed: 2 });
    still(r, 1500, 1500, 0);
    let fired = 0;
    for (let i = 0; i < 120; i++) {
      fired += stepSector(r, { ...idle, fire: true }).filter((e) => e.type === 'fired').length;
      expect(r.shots.length).toBeLessThanOrEqual(RUN.maxShots);
      still(r, 1500, 1500, 0);
    }
    expect(fired).toBe(Math.ceil(120 / r.craft.weapon.cooldownTicks));
    for (let i = 0; i < r.craft.weapon.lifeTicks + 2; i++) stepSector(r, idle);
    expect(r.shots).toHaveLength(0);
  });

  it('bolts stop on rocks and stars', () => {
    const L = withInstallation;
    const rock = L.rocks.find((k) => k.r > 14 && k.x > 300 && k.y > 300 && k.x < L.width - 300 && k.y < L.height - 300)!;
    const r = createSectorRun({ ...L, patrols: [], pois: L.pois.filter((p) => p.kind === 'exit'), rocks: [rock], landmarks: [] }, SURVEYED, { seed: 3 });
    still(r, rock.x, rock.y + rock.r + 120, 0); // below the rock, nose up
    stepSector(r, { ...idle, fire: true });
    expect(r.shots).toHaveLength(1);
    let ticks = 0;
    while (r.shots.length > 0 && ticks < r.craft.weapon.lifeTicks) {
      still(r, rock.x, rock.y + rock.r + 120, 0);
      stepSector(r, idle);
      ticks += 1;
    }
    expect(r.shots).toHaveLength(0);
    expect(ticks).toBeLessThan(15); // stopped by the rock long before its lifetime ends
  });

  it('bolts damage hostiles; a destroyed ship is removed, counted and pays nothing', () => {
    const L = withInstallation;
    const inst = L.pois.find((p) => p.kind === 'installation')!;
    const r = createSectorRun({ ...L, rocks: [], landmarks: [], patrols: [], sites: [], hazards: [] }, EMPTY_SECTOR_SAVE, { seed: 4 });
    r.grace = 0; // past the arrival grace (no encounter starts during it)
    still(r, inst.x + inst.alertR - 20, inst.y, 0);
    stepSector(r, idle); // wake the installation's wave
    expect(r.hostiles.length).toBe(inst.wave);
    const target = r.hostiles[0]!;
    // continuous fire never lets the shield regenerate: hull + shield in whole bolts
    const hits = Math.ceil((target.maxHull + target.maxShield) / r.craft.weapon.damage);
    const events: SectorEvent[] = [];
    for (let i = 0; i < 400 && r.hostiles.includes(target); i++) {
      r.shield = r.craft.stats.shield;
      r.invuln = 10;
      r.heat = 0; // this check is about damage per impact, not weapon heat (FR-TD-79, tested separately)
      const px = r.ship.x;
      const py = r.ship.y;
      events.push(...stepSector(r, { moveX: 0, moveY: 0, aimX: target.x - px, aimY: target.y - py, fire: true }));
      r.ship.x = px;
      r.ship.y = py;
      r.ship.vx = 0;
      r.ship.vy = 0;
    }
    const struck = events.filter((e) => e.type === 'struck' && e.hostile === target.id);
    const destroyed = events.filter((e) => e.type === 'destroyed' && e.hostile === target.id);
    expect(destroyed).toHaveLength(1);
    expect(struck).toHaveLength(hits - 1); // one struck event per bolt that hit: damage applies once per impact
    expect(r.kills).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'looted' || e.type === 'collected')).toBe(false);
  });

  it("destroying an installation's whole wave clears it early, once, with its reward", () => {
    const L = withInstallation;
    const inst = L.pois.find((p) => p.kind === 'installation')!;
    const r = createSectorRun({ ...L, rocks: [], landmarks: [], patrols: [], sites: [], hazards: [] }, EMPTY_SECTOR_SAVE, { seed: 5 });
    r.grace = 0;
    const hx = inst.x + inst.alertR - 20;
    still(r, hx, inst.y, 0);
    const events: SectorEvent[] = [...stepSector(r, idle)];
    // a long hold timer, so only destroying the wave can clear it within the test
    const enc = r.encounters.find((e) => e.id === inst.id)!;
    expect(enc.state).toBe('active');
    enc.holdLeft = 100_000;
    let ticks = 0;
    for (; ticks < 6000 && !r.done.has(inst.id); ticks++) {
      r.shield = r.craft.stats.shield;
      r.invuln = 10;
      const t = r.hostiles.filter((h) => h.source === inst.id).sort((a, b) => Math.hypot(a.x - hx, a.y - inst.y) - Math.hypot(b.x - hx, b.y - inst.y))[0];
      events.push(...stepSector(r, t ? leadAim(r, t) : idle));
      Object.assign(r.ship, { x: hx, y: inst.y, vx: 0, vy: 0 });
    }
    const cleared = events.filter((e) => e.type === 'encounter' && e.state === 'cleared');
    expect(cleared).toHaveLength(1);
    expect(enc.holdLeft).toBeGreaterThan(0); // cleared by the kills, not by the hold timer
    expect(r.hostiles.filter((h) => h.source === inst.id)).toHaveLength(0);
    expect(r.done.has(inst.id)).toBe(true);
    if (cleared[0]?.type === 'encounter') expect(cleared[0].loot).toEqual(inst.loot);
    for (let i = 0; i < 60; i++) expect(stepSector(r, idle).some((e) => e.type === 'encounter')).toBe(false);
  });

  it('a wiped-out patrol stays gone while the pilot is near, and returns on its next wake', () => {
    const L = withInstallation;
    const pr = L.patrols[0]!;
    const r = createSectorRun({ ...L, rocks: [], landmarks: [], pois: L.pois.filter((p) => p.kind === 'exit') }, SURVEYED, { seed: 6 });
    const at = pr.points[0]!;
    still(r, at.x, at.y, 0);
    stepSector(r, idle);
    expect(r.hostiles.filter((h) => h.source === pr.id)).toHaveLength(pr.ships);
    r.hostiles.length = 0; // as if all were shot down
    for (let i = 0; i < 120; i++) {
      still(r, at.x, at.y, 0);
      stepSector(r, idle);
    }
    expect(r.hostiles.filter((h) => h.source === pr.id)).toHaveLength(0);
    // leave (beyond the sleep radius), then come back
    const far = { x: at.x < L.width / 2 ? L.width - 200 : 200, y: at.y < L.height / 2 ? L.height - 200 : 200 };
    for (let i = 0; i < 5; i++) {
      still(r, far.x, far.y, 0);
      stepSector(r, idle);
    }
    for (let i = 0; i < 5; i++) {
      still(r, at.x, at.y, 0);
      stepSector(r, idle);
    }
    expect(r.hostiles.filter((h) => h.source === pr.id).length).toBeGreaterThan(0);
  });

  it('restart, recall and dispose clear every bolt', () => {
    const r = createSectorRun(open(withInstallation), SURVEYED, { seed: 7 });
    still(r, 1500, 1500, 0);
    stepSector(r, { ...idle, fire: true });
    expect(r.shots.length).toBe(1);
    restartSector(r);
    expect(r.shots).toHaveLength(0);
    stepSector(r, { ...idle, fire: true });
    disposeSectorRun(r);
    expect(r.shots).toHaveLength(0);
  });
});

/* -------------------------------------------------------------- profile */
describe('Free Roam controls (v5 in the profile; v10: shared Free Roam prefs)', () => {
  it('v4 saves migrate with default controls; nothing else changes', () => {
    const store = new MemoryStore();
    const v4 = { ...EMPTY_PROFILE, version: 4, sessions: 7, cargo: { scrap: 3 } };
    store.write('galaxia:freeroam', JSON.stringify(v4));
    const r = loadProfile(store);
    expect(r.status).toBe('migrated');
    expect(loadFreeRoamPrefs(store).data.controls).toEqual(DEFAULT_CONTROLS);
    expect(r.data.sessions).toBe(7);
    expect(r.data.cargo).toEqual({ scrap: 3 });
  });

  it('round-trips bindings, mouse aim and zoom through the prefs record; repairs junk', () => {
    const store = new MemoryStore();
    const b = rebind(DEFAULT_BINDINGS, 'fire', 0, 'KeyK');
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    saveFreeRoamPrefs(store, { controls: { bindings: b.bindings, mouseAim: true, zoom: 1.3225, flightMode: 'normal' } });
    const back = loadFreeRoamPrefs(store);
    expect(back.status).toBe('ok');
    expect(back.data.controls).toEqual({ bindings: b.bindings, mouseAim: true, zoom: 1.3225, flightMode: 'normal' });
    store.write('galaxia:freeroam:prefs', JSON.stringify({ version: 1, controls: { bindings: { up: ['Escape'] }, mouseAim: 'yes', zoom: 99 } }));
    const bad = loadFreeRoamPrefs(store);
    expect(bad.status).toBe('repaired');
    expect(bad.data.controls).toEqual(DEFAULT_CONTROLS);
  });

  it('a v9 profile\'s controls carry over into the prefs record once; the slot keeps the rest', () => {
    const store = new MemoryStore();
    const b = rebind(DEFAULT_BINDINGS, 'fire', 0, 'KeyK');
    if (!b.ok) throw new Error('rebind');
    store.write('galaxia:freeroam', JSON.stringify({ ...EMPTY_PROFILE, version: 9, sessions: 4, controls: { bindings: b.bindings, mouseAim: true, zoom: 1.5 } }));
    const fp = loadFreeRoamPrefs(store);
    expect(fp.seeded).toBe(true);
    expect(fp.data.controls).toEqual({ bindings: b.bindings, mouseAim: true, zoom: 1.5, flightMode: 'normal' }); // P04.3: an older save flies NORMAL
    expect(JSON.parse(store.read('galaxia:freeroam:prefs')!).controls.zoom).toBe(1.5);
    const slot = loadProfile(store);
    expect(slot.status).toBe('migrated');
    expect(slot.data.sessions).toBe(4);
    expect('controls' in slot.data).toBe(false);
    // later loads read the prefs record (no second carry-over)
    expect(loadFreeRoamPrefs(store).seeded).toBe(false);
  });
});

/* ------------------------------------------------------------- Classic */
describe('Classic controls are unchanged by Free Roam', () => {
  it('Classic input is still horizontal-only: an edge fire press plus a held flag (owner request, TD-74)', () => {
    // Free Roam added nothing here; the only change is the owner-requested fire hold (autofire with heat)
    expect(Object.keys(NO_INPUT).sort()).toEqual(['fire', 'fireHeld', 'moveX', 'pause', 'start']);
  });

  it('no Classic module imports Free Roam input, bindings, pointers or flight code', () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    for (const d of ['src/core', 'src/input', 'src/ui', 'src/modes/classic']) {
      try {
        walk(d);
      } catch {
        /* directory absent */
      }
    }
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toMatch(/freeroam\//);
  });
});
