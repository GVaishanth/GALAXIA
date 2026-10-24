/**
 * P04.1 control mapping: Q = next weapon (unchanged path), wheel = camera zoom
 * (never weapons), X = ship target lock (a rebindable flight action), LOCK
 * touch button (its own pointer role). The ship lock itself is covered by
 * shipLock.test.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTION_LABEL, DEFAULT_BINDINGS, FLIGHT_ACTIONS, rebind, sanitizeBindings, trackedCodes } from '../src/modes/freeroam/bindings.ts';
import { CAMERA, clampZoom, easeZoom, stepZoom, wheelPixels, wheelZoom, WHEEL_ZOOM } from '../src/modes/freeroam/camera.ts';
import { FlightPointers } from '../src/modes/freeroam/pointers.ts';
import { cycleWeapon, createArsenal } from '../src/core/weapons/arsenal.ts';
import { KeyTracker } from '../src/shared/input/keyTracker.ts';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const read = (p: string): string => readFileSync(resolve(src, p), 'utf8');

describe('wheel = camera zoom (bounded, forward = in)', () => {
  it('one mouse notch forward zooms in by one key step; back zooms out by one', () => {
    expect(wheelZoom(1, -100, 0, false)).toBeCloseTo(CAMERA.zoomStep, 10);
    expect(wheelZoom(1, 100, 0, false)).toBeCloseTo(1 / CAMERA.zoomStep, 10);
    // line and page delta modes are converted to px first
    expect(wheelPixels(-3, 1)).toBe(-120);
    expect(wheelPixels(1, 2)).toBe(WHEEL_ZOOM.maxEventPx); // a page is capped to one event's maximum
  });

  it('never leaves the zoom bounds, whatever the gesture', () => {
    let z = 1;
    for (let i = 0; i < 100; i++) z = wheelZoom(z, -240, 0, false);
    expect(z).toBe(CAMERA.zoomMax);
    for (let i = 0; i < 100; i++) z = wheelZoom(z, 240, 0, false);
    expect(z).toBe(CAMERA.zoomMin);
    expect(wheelZoom(1, Number.NaN, 0, false)).toBe(1);
    expect(wheelZoom(Number.NaN, -100, 0, false)).toBeCloseTo(CAMERA.zoomStep, 10); // a bad stored value restarts at 1
    expect(wheelZoom(1, -1e9, 0, false)).toBeLessThanOrEqual(CAMERA.zoomMax);
  });

  it('trackpad deltas move it continuously; a pinch (Ctrl + wheel) uses its finer gain', () => {
    let z = 1;
    for (let i = 0; i < 25; i++) z = wheelZoom(z, -4, 0, false); // 100 px in small steps = one notch
    expect(z).toBeCloseTo(CAMERA.zoomStep, 10);
    expect(wheelZoom(1, -10, 0, true)).toBeCloseTo(Math.exp(10 * WHEEL_ZOOM.perPinchPx), 10);
    expect(wheelZoom(1, -10, 0, true)).toBeGreaterThan(1);
  });

  it('the displayed zoom eases to the target quickly, monotonic, without overshoot; instant with reduced motion', () => {
    let shown = 1;
    const target = 1.4;
    let t = 0;
    let prev = shown;
    while (shown !== target && t < 2) {
      shown = easeZoom(shown, target, 1 / 60, false);
      t += 1 / 60;
      expect(shown).toBeGreaterThanOrEqual(prev);
      expect(shown).toBeLessThanOrEqual(target);
      prev = shown;
    }
    expect(shown).toBe(target);
    expect(t).toBeLessThan(0.35); // never a laggy drift
    expect(easeZoom(1, 1.4, 1 / 60, true)).toBe(1.4);
    expect(easeZoom(Number.NaN, 1.2, 1 / 60, false)).toBe(1.2);
    expect(easeZoom(1.1, 1.2, 0, false)).toBe(1.1);
    expect(easeZoom(1, 99, 1 / 60, false)).toBeLessThanOrEqual(CAMERA.zoomMax);
    // the keys keep their exact steps (and the snap back to 1)
    expect(stepZoom(1 / CAMERA.zoomStep, 1)).toBe(1);
    expect(clampZoom(3)).toBe(CAMERA.zoomMax);
  });

  it('the Free Roam wheel listener zooms only: it never touches the weapon step, and only during flight with no panel', () => {
    const mode = read('modes/freeroam/freeRoamMode.ts');
    const i = mode.indexOf("'wheel',");
    const body = mode.slice(i, mode.indexOf('{ passive: false }', i));
    expect(body).toContain("if (panel || run?.phase !== 'flight') return;");
    expect(body.indexOf('e.preventDefault()')).toBeGreaterThan(body.indexOf("if (panel || run?.phase !== 'flight') return;")); // never before the gameplay check
    expect(body).toContain('wheelZoom(');
    expect(body).not.toMatch(/cyclePending|cycle:|switchWeapon/);
    // exactly one wheel listener, on the flight canvas (menus, panels, hangar, armory and fields keep their scrolling)
    expect(mode.match(/'wheel'/g)?.length).toBe(1);
    expect(mode.slice(mode.lastIndexOf('scope.on<WheelEvent>(', i), i)).toContain('surface.canvas');
  });

  it('Classic has no wheel handler any more (no weapon step, no zoom for the fixed arcade camera)', () => {
    const app = read('game/app.ts');
    expect(app).not.toMatch(/'wheel'/);
    expect(app).not.toMatch(/press\(\s*wheelAcc|'prev', 'pointer'/);
    // Q still steps forward through the roster ship's rotation
    expect(read('input/keyboard.ts')).toMatch(/KeyQ: 'next'/);
  });
});

describe('Q = next weapon (Armory rotation, compatible only, wraps; one weapon = nothing)', () => {
  it('follows the rotation order, skips incompatible weapons and wraps around', () => {
    const a = createArsenal({ compatible: ['plasma', 'lock-missile', 'heavy-missile'], rotation: ['plasma', 'nuke', 'heavy-missile', 'lock-missile'], start: 'plasma' });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      expect(cycleWeapon(a, 1)).toBe(true);
      seen.push(a.selected);
    }
    expect(seen).toEqual(['heavy-missile', 'lock-missile', 'plasma', 'heavy-missile']); // nuke is not fitted: skipped
  });

  it('with one usable weapon nothing changes (no switch, so no event or sound)', () => {
    const a = createArsenal({ compatible: ['plasma'], rotation: ['plasma'], start: 'plasma' });
    expect(cycleWeapon(a, 1)).toBe(false);
    expect(a.selected).toBe('plasma');
  });

  it('the keyboard path is one step per press (repeats never reach it) and the default key is Q', () => {
    expect(DEFAULT_BINDINGS.missile[0]).toBe('KeyQ');
    const mode = read('modes/freeroam/freeRoamMode.ts');
    expect(mode).toContain("if (run?.phase === 'flight' && (binds.missile[0] === code || binds.missile[1] === code)) cyclePending = 1;");
    // auto-repeat never becomes a press: holding Q (or X) is one step (one toggle)
    const keys = new KeyTracker(['KeyQ', 'KeyX']);
    const ev = (code: string, repeat: boolean) => ({ code, repeat, ctrlKey: false, altKey: false, metaKey: false, target: null, preventDefault: () => undefined });
    keys.down(ev('KeyQ', false));
    for (let i = 0; i < 10; i++) keys.down(ev('KeyQ', true));
    keys.down(ev('KeyX', false));
    keys.down(ev('KeyX', true));
    expect(keys.takePresses()).toEqual(['KeyQ', 'KeyX']);
  });
});

describe('X = LOCK TARGET, a rebindable flight action', () => {
  it('is bound to X by default, labelled, tracked and listed with the other actions', () => {
    expect(FLIGHT_ACTIONS).toContain('lock');
    expect(DEFAULT_BINDINGS.lock).toEqual(['KeyX', null]);
    expect(ACTION_LABEL.lock).toBe('Lock target');
    expect(trackedCodes(DEFAULT_BINDINGS)).toContain('KeyX');
    // no other default action uses X
    const others = FLIGHT_ACTIONS.filter((a) => a !== 'lock').flatMap((a) => DEFAULT_BINDINGS[a]);
    expect(others).not.toContain('KeyX');
  });

  it('a save from before P04.1 gets X if it is free, else a spare key; nothing is reset', () => {
    const { lock: _drop, ...old } = DEFAULT_BINDINGS;
    const a = sanitizeBindings(JSON.parse(JSON.stringify(old)));
    expect(a.repaired).toBe(false);
    expect(a.bindings.lock).toEqual(['KeyX', null]);
    expect(a.bindings.missile).toEqual(DEFAULT_BINDINGS.missile);
    const taken = sanitizeBindings(JSON.parse(JSON.stringify({ ...old, fire: ['Space', 'KeyX'] })));
    expect(taken.repaired).toBe(false);
    expect(taken.bindings.fire).toEqual(['Space', 'KeyX']);
    expect(taken.bindings.lock[0]).not.toBe('KeyX');
    expect(taken.bindings.lock[0]).toMatch(/^Key[A-Z]$|^(Semicolon|Quote|Comma|Period|Slash)$/);
  });

  it('can be rebound like every action (and X can be given to something else)', () => {
    const r = rebind(DEFAULT_BINDINGS, 'lock', 0, 'KeyT');
    expect(r.ok && r.bindings.lock).toEqual(['KeyT', null]);
    const r2 = rebind(DEFAULT_BINDINGS, 'fire', 1, 'KeyX');
    // X moves to fire; lock would be left with no key, so the two swap (lock takes J)
    expect(r2.ok && r2.bindings.fire).toEqual(['Space', 'KeyX']);
    expect(r2.ok && r2.bindings.lock).toEqual(['KeyJ', null]);
  });

  it('the shell sends one lock toggle per press and drops it outside flight', () => {
    const mode = read('modes/freeroam/freeRoamMode.ts');
    expect(mode).toContain("if (run?.phase === 'flight' && (binds.lock[0] === code || binds.lock[1] === code)) lockPending = !lockPending;");
    expect(mode).toContain('if (pointers.takeLockPress() && live) lockPending = !lockPending;');
    expect(mode).toMatch(/if \(!live\) \{\n\s+cyclePending = 0;\n\s+firePending = false;\n\s+lockPending = false;/);
    expect(mode).toContain('if (lockPending) f = { ...f, lockToggle: true };');
  });
});

describe('LOCK touch button: its own pointer role', () => {
  it('one press per touch; a second finger while held is ignored; release frees it', () => {
    const p = new FlightPointers();
    p.lockDown(1);
    p.lockDown(2);
    expect(p.snapshot().lockTouches).toBe(2);
    expect(p.takeLockPress()).toBe(true);
    expect(p.takeLockPress()).toBe(false);
    p.release(1);
    p.release(2);
    expect(p.snapshot().lockTouches).toBe(0);
    p.lockDown(3);
    expect(p.takeLockPress()).toBe(true);
  });

  it('never takes or drags the stick, and the stick finger can never press LOCK', () => {
    const p = new FlightPointers();
    p.lockDown(1);
    expect(p.stickDown(1, 10, 10)).toBe(false); // the LOCK finger cannot become the stick
    p.move(1, 200, 0);
    expect(p.snapshot().stickActive).toBe(false);
    expect(p.stickDown(2, 0, 0)).toBe(true);
    p.lockDown(2); // the stick finger sliding over LOCK
    p.takeLockPress(); // (drop finger 1's press)
    expect(p.takeLockPress()).toBe(false);
    p.move(2, 40, 0);
    expect(p.snapshot().stick.x).toBeGreaterThan(0);
    // FIRE, BOOST and WPN fingers cannot press it either
    p.fireDown(5);
    p.lockDown(5);
    expect(p.takeLockPress()).toBe(false);
  });
});

describe('P04.1 polish: C = NEXT TARGET, a rebindable flight action', () => {
  it('is bound to C by default, labelled, tracked, used by no other action and not part of any hidden key sequence', async () => {
    expect(FLIGHT_ACTIONS).toContain('target');
    expect(DEFAULT_BINDINGS.target).toEqual(['KeyC', null]);
    expect(ACTION_LABEL.target).toBe('Next target');
    expect(trackedCodes(DEFAULT_BINDINGS)).toContain('KeyC');
    const others = FLIGHT_ACTIONS.filter((a) => a !== 'target').flatMap((a) => DEFAULT_BINDINGS[a]);
    expect(others).not.toContain('KeyC');
    const { ADMIN_SEQUENCE } = await import('../src/modes/freeroam/admin/activation.ts');
    expect(ADMIN_SEQUENCE).not.toContain('KeyC');
  });

  it('a save from before it gets C if free, else a spare key; nothing is reset', () => {
    const { target: _drop, ...old } = DEFAULT_BINDINGS;
    const a = sanitizeBindings(JSON.parse(JSON.stringify(old)));
    expect(a.repaired).toBe(false);
    expect(a.bindings.target).toEqual(['KeyC', null]);
    expect(a.bindings.lock).toEqual(DEFAULT_BINDINGS.lock);
    const taken = sanitizeBindings(JSON.parse(JSON.stringify({ ...old, interact: ['KeyE', 'KeyC'] })));
    expect(taken.repaired).toBe(false);
    expect(taken.bindings.interact).toEqual(['KeyE', 'KeyC']);
    expect(taken.bindings.target[0]).not.toBe('KeyC');
    expect(Object.values(taken.bindings).flat().filter((k) => k === taken.bindings.target[0])).toHaveLength(1);
    // a P04.1 save without lock and target: both get their defaults
    const { lock: _l, ...older } = old;
    const b = sanitizeBindings(JSON.parse(JSON.stringify(older)));
    expect([b.bindings.lock[0], b.bindings.target[0]]).toEqual(['KeyX', 'KeyC']);
  });

  it('can be rebound like every action', () => {
    const r = rebind(DEFAULT_BINDINGS, 'target', 0, 'KeyT');
    expect(r.ok && r.bindings.target).toEqual(['KeyT', null]);
    const r2 = rebind(DEFAULT_BINDINGS, 'fire', 1, 'KeyC');
    expect(r2.ok && r2.bindings.fire).toEqual(['Space', 'KeyC']);
    expect(r2.ok && r2.bindings.target).toEqual(['KeyJ', null]); // swapped, never keyless
  });

  it('the shell sends one step per press (repeat never reaches takePresses), only in flight, from one place', () => {
    const mode = read('modes/freeroam/freeRoamMode.ts');
    expect(mode).toContain("if (run?.phase === 'flight' && (binds.target[0] === code || binds.target[1] === code)) targetPending = true;");
    expect(mode).toContain('if (pointers.takeTargetPress() && live) targetPending = true;');
    expect(mode).toMatch(/if \(!live\) \{\n\s+cyclePending = 0;\n\s+firePending = false;\n\s+lockPending = false;\n\s+targetPending = false;/);
    expect(mode).toContain('if (targetPending) f = { ...f, targetCycle: true };');
    // the binding is read in exactly one place, and the latch is cleared after the first tick of the frame
    expect(mode.match(/binds\.target\[/g)?.length).toBe(2);
    expect(mode.match(/targetCycle: true/g)?.length).toBe(1);
    // released with everything else on blur, hidden tab, rotation and panels
    const intr = mode.slice(mode.indexOf('const interrupt = '), mode.indexOf('clock.resetTiming();', mode.indexOf('const interrupt = ')));
    expect(intr).toContain('targetPending = false;');
    // the keyboard tracker never reports a held key's auto-repeat as a press
    const t = new KeyTracker(['KeyC']);
    const ev = (code: string, repeat: boolean) => ({ code, repeat, ctrlKey: false, altKey: false, metaKey: false, target: null, preventDefault: () => undefined });
    t.down(ev('KeyC', false));
    for (let i = 0; i < 10; i++) t.down(ev('KeyC', true));
    expect(t.takePresses()).toEqual(['KeyC']);
  });

  it('the touch button: its own pointer role, one step per touch, never the stick, FIRE or BOOST', () => {
    const p = new FlightPointers();
    p.targetDown(1);
    p.targetDown(2);
    expect(p.snapshot().targetTouches).toBe(2);
    expect(p.takeTargetPress()).toBe(true);
    expect(p.takeTargetPress()).toBe(false);
    expect(p.stickDown(1, 10, 10)).toBe(false); // the button finger cannot become the stick
    p.fireDown(1);
    p.boostDown(2);
    expect(p.firing).toBe(false);
    expect(p.boosting).toBe(false);
    p.release(1);
    p.release(2);
    // a stick, FIRE, BOOST or LOCK finger sliding over it presses nothing
    expect(p.stickDown(3, 0, 0)).toBe(true);
    p.fireDown(4);
    p.boostDown(5);
    p.lockDown(6);
    p.takeLockPress();
    for (const id of [3, 4, 5, 6]) p.targetDown(id);
    expect(p.takeTargetPress()).toBe(false);
    expect(p.snapshot().targetTouches).toBe(0);
    p.move(3, 40, 0);
    expect(p.snapshot().stick.x).toBeGreaterThan(0);
    expect(p.firing && p.boosting).toBe(true);
  });
});

describe('P04.1 polish: zoom stays on the follow camera and settles at transitions', () => {
  it('the wheel never reads the pointer position: the view stays centred on the follow camera', () => {
    const mode = read('modes/freeroam/freeRoamMode.ts');
    const i = mode.indexOf("'wheel',");
    const body = mode.slice(i, mode.indexOf('{ passive: false }', i));
    expect(body).not.toMatch(/clientX|clientY|offsetX|offsetY|pageX|pageY|screenToWorld|cam\.x|cam\.y/);
    // the camera centre is moved only by the follow step and the snaps, never by a zoom change
    expect(read('modes/freeroam/camera.ts')).not.toMatch(/export function wheelZoom[^}]*cam/);
  });

  it('new sector, restart and recovery show the saved zoom at once (no half-eased or combat-framed carry-over); never per frame', () => {
    const mode = read('modes/freeroam/freeRoamMode.ts');
    const fn = mode.slice(mode.indexOf('const settleZoom = (): void => {'), mode.indexOf('};', mode.indexOf('const settleZoom = (): void => {')));
    expect(fn).toContain('shownZoom = controls.zoom;');
    expect(fn).toContain('framing = 1;');
    expect(fn).toContain('if (zoomSaveAt !== null) setControls({ zoom: controls.zoom });');
    expect(mode).toContain("snapCamera(cam, run.ship.x, run.ship.y); // a new sector: no glide from the old camera position\n    settleZoom();");
    expect(mode.match(/settleZoom\(\);/g)?.length).toBe(4);
    // the frame loop eases toward the saved zoom; it does not reset it
    const frame = mode.slice(mode.indexOf('const realDt = lastTs === null'), mode.indexOf('view = cameraView(cam, zoom, b.width, b.height);'));
    expect(frame).toContain('shownZoom = easeZoom(shownZoom, controls.zoom, realDt, reduced);');
    expect(frame).not.toContain('settleZoom');
  });
});
