/**
 * Stage 5 unified input: InputHub arbitration, keyboard guards, the touch-pad
 * pointer model, and source-independence of the engine.
 */
import { describe, expect, it } from 'vitest';
import { TOUCH_PAD } from '../src/config/devices.ts';
import { NO_INPUT, type InputFrame } from '../src/core/game/input.ts';
import { applyMenuAction } from '../src/game/menuActions.ts';
import { InputHub } from '../src/input/inputHub.ts';
import { isEditableTarget, KeyboardInput, type KeyLike } from '../src/input/keyboard.ts';
import { moveDirFor, normaliseX, TouchPadModel } from '../src/input/touchPad.ts';
import { makeEngine, run, runUntil, startPlaying } from './helpers/engine.ts';

/* ---------- helpers ---------- */

const BODY = { tagName: 'BODY' } as unknown as EventTarget;
function key(code: string, o: Partial<{ repeat: boolean; target: EventTarget; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}): KeyLike & { prevented: boolean } {
  const e = {
    code,
    repeat: o.repeat ?? false,
    target: o.target ?? BODY,
    ctrlKey: o.ctrlKey ?? false,
    metaKey: o.metaKey ?? false,
    altKey: o.altKey ?? false,
    isComposing: o.isComposing ?? false,
    prevented: false,
    preventDefault() {
      e.prevented = true;
    },
  };
  return e;
}

function rig(): { hub: InputHub; kb: KeyboardInput; pad: TouchPadModel } {
  const hub = new InputHub();
  return { hub, kb: new KeyboardInput(hub), pad: new TouchPadModel(hub) };
}

/* ---------- hub ---------- */

describe('InputHub', () => {
  it('latches edge presses until one tick consumes them (one press = one action)', () => {
    const hub = new InputHub();
    hub.press('fire', 'touch');
    hub.press('fire', 'keyboard'); // same tick: still one shot
    expect(hub.frame()).toEqual({ moveX: 0, fire: true, pause: false, start: true, fireHeld: false }); // presses alone are taps, not holds
    expect(hub.frame()).toEqual(NO_INPUT);
  });

  it('fire confirms only where allowed (title), so it cannot skip game over', () => {
    const hub = new InputHub();
    hub.press('fire');
    expect(hub.frame({ fireConfirms: false })).toEqual({ moveX: 0, fire: true, pause: false, start: false, fireHeld: false });
    hub.press('start');
    expect(hub.frame({ fireConfirms: false }).start).toBe(true);
  });

  it('newest movement source wins; releasing it falls back to the other', () => {
    const hub = new InputHub();
    hub.setMove('keyboard', -1);
    expect(hub.moveX).toBe(-1);
    hub.setMove('touch', 1);
    expect(hub.moveX).toBe(1);
    hub.setMove('touch', 0); // finger lifted: the held key still counts
    expect(hub.moveX).toBe(-1);
    hub.setMove('keyboard', 0);
    expect(hub.moveX).toBe(0);
  });

  it('re-sending an unchanged hold keeps its priority (key auto-repeat cannot steal control)', () => {
    const hub = new InputHub();
    hub.setMove('touch', 1);
    hub.setMove('keyboard', -1);
    hub.setMove('touch', 1); // repeated, unchanged
    expect(hub.moveX).toBe(-1);
  });

  it('clear() drops every hold and latch; clearSource() only one source', () => {
    const hub = new InputHub();
    hub.setMove('keyboard', 1);
    hub.setMove('touch', -1);
    hub.press('pause');
    hub.clearSource('touch');
    expect(hub.moveX).toBe(1);
    hub.clear();
    expect(hub.frame()).toEqual(NO_INPUT);
  });
});

/* ---------- keyboard ---------- */

describe('KeyboardInput', () => {
  it('maps arrows and A/D to movement with last-pressed priority, released on key-up', () => {
    const { hub, kb } = rig();
    kb.keyDown(key('ArrowLeft'));
    expect(hub.moveX).toBe(-1);
    kb.keyDown(key('KeyD'));
    expect(hub.moveX).toBe(1);
    kb.keyUp({ code: 'KeyD' });
    expect(hub.moveX).toBe(-1);
    kb.keyUp({ code: 'ArrowLeft' });
    expect(hub.moveX).toBe(0);
  });

  it('Space fires, Enter confirms, P and Escape pause; default prevented (no page scroll)', () => {
    const { hub, kb } = rig();
    const space = key('Space');
    kb.keyDown(space);
    expect(space.prevented).toBe(true);
    expect(hub.frame({ fireConfirms: false })).toMatchObject({ fire: true, start: false });
    kb.keyDown(key('Enter'));
    expect(hub.frame()).toMatchObject({ start: true, fire: false });
    kb.keyDown(key('KeyP'));
    expect(hub.frame().pause).toBe(true);
    kb.keyDown(key('Escape'));
    expect(hub.frame().pause).toBe(true);
  });

  it('auto-repeat never re-triggers pause, fire or confirm', () => {
    const { hub, kb } = rig();
    kb.keyDown(key('KeyP'));
    expect(hub.frame().pause).toBe(true);
    for (let i = 0; i < 10; i++) {
      kb.keyDown(key('KeyP', { repeat: true }));
      kb.keyDown(key('Space', { repeat: true }));
      kb.keyDown(key('Enter', { repeat: true }));
      expect(hub.frame()).toEqual(NO_INPUT);
    }
  });

  it('holding P through real engine ticks pauses once and stays paused', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const { hub, kb } = rig();
    kb.keyDown(key('KeyP'));
    h.engine.step(hub.frame());
    expect(h.engine.phase).toBe('paused');
    for (let i = 0; i < 30; i++) {
      kb.keyDown(key('KeyP', { repeat: true }));
      h.engine.step(hub.frame());
    }
    expect(h.engine.phase).toBe('paused');
  });

  it('typing into an editable field never reaches the game', () => {
    const { hub, kb } = rig();
    const fields = [{ tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT', type: 'search' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }];
    for (const f of fields) {
      const target = f as unknown as EventTarget;
      for (const code of ['KeyA', 'KeyD', 'ArrowLeft', 'Space', 'KeyZ', 'KeyP', 'Escape', 'Enter']) {
        const e = key(code, { target });
        expect(kb.keyDown(e)).toBe(false);
        expect(e.prevented).toBe(false); // the field still receives the key
      }
    }
    expect(hub.frame()).toEqual(NO_INPUT);
    expect(hub.moveX).toBe(0);
  });

  it('IME composition and Ctrl/Cmd/Alt shortcuts are left alone', () => {
    const { hub, kb } = rig();
    expect(kb.keyDown(key('KeyD', { ctrlKey: true }))).toBe(false); // bookmark
    expect(kb.keyDown(key('KeyA', { metaKey: true }))).toBe(false); // select all
    expect(kb.keyDown(key('KeyP', { altKey: true }))).toBe(false);
    expect(kb.keyDown(key('Space', { isComposing: true }))).toBe(false);
    expect(hub.frame()).toEqual(NO_INPUT);
  });

  it('key-up releases even when focus moved into a field meanwhile (no stuck movement)', () => {
    const { hub, kb } = rig();
    kb.keyDown(key('ArrowRight'));
    kb.keyUp({ code: 'ArrowRight' }); // target irrelevant
    expect(hub.moveX).toBe(0);
  });

  it('reset() (blur) forgets held keys', () => {
    const { hub, kb } = rig();
    kb.keyDown(key('ArrowLeft'));
    kb.reset();
    expect(hub.moveX).toBe(0);
  });

  it('isEditableTarget: text-like inputs only', () => {
    const t = (o: object): EventTarget => o as unknown as EventTarget;
    expect(isEditableTarget(t({ tagName: 'INPUT' }))).toBe(true); // default type text
    expect(isEditableTarget(t({ tagName: 'INPUT', type: 'email' }))).toBe(true);
    expect(isEditableTarget(t({ tagName: 'INPUT', type: 'range' }))).toBe(false);
    expect(isEditableTarget(t({ tagName: 'INPUT', type: 'checkbox' }))).toBe(false);
    expect(isEditableTarget(t({ tagName: 'BUTTON' }))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

/* ---------- touch pad ---------- */

describe('touch pad model', () => {
  it('normalises the finger x to -1..1 of the pad half-width', () => {
    const r = { left: 100, width: 200 };
    expect(normaliseX(200, r)).toBe(0);
    expect(normaliseX(100, r)).toBe(-1);
    expect(normaliseX(300, r)).toBe(1);
    expect(normaliseX(-500, r)).toBe(-1); // outside: clamped
    expect(normaliseX(150, { left: 0, width: 0 })).toBe(0);
  });

  it('dead zone stops the ship; hysteresis prevents jitter at the edge', () => {
    const dz = TOUCH_PAD.deadZone;
    expect(moveDirFor(0, 0)).toBe(0);
    expect(moveDirFor(dz + 0.01, 0)).toBe(1);
    expect(moveDirFor(dz - 0.01, 1)).toBe(1); // already moving: keep
    expect(moveDirFor(dz - TOUCH_PAD.hysteresis - 0.01, 1)).toBe(0);
    expect(moveDirFor(-0.9, 1)).toBe(-1); // slide straight across
  });

  it('move and fire at the same time (multi-touch)', () => {
    const { hub, pad } = rig();
    pad.down(1, 'move', 0.8);
    pad.down(2, 'fire');
    expect(hub.frame({ fireConfirms: false })).toEqual({ moveX: 1, fire: true, pause: false, start: false, fireHeld: true }); // finger still on FIRE
    pad.down(3, 'fire'); // second tap while still steering: another shot
    expect(hub.frame()).toMatchObject({ moveX: 1, fire: true });
    pad.up(2);
    pad.up(3);
    expect(hub.frame()).toMatchObject({ moveX: 1, fire: false });
    expect(pad.state().pressed).toEqual({ move: true, fire: false, pause: false });
  });

  it('holding FIRE is one shot (no auto-fire)', () => {
    const { hub, pad } = rig();
    pad.down(1, 'fire');
    expect(hub.frame().fire).toBe(true);
    for (let i = 0; i < 20; i++) expect(hub.frame().fire).toBe(false);
  });

  it('sliding across the pad switches direction without lifting', () => {
    const { hub, pad } = rig();
    pad.down(1, 'move', 0.6);
    expect(hub.moveX).toBe(1);
    pad.move(1, -0.6);
    expect(hub.moveX).toBe(-1);
    pad.move(1, 0);
    expect(hub.moveX).toBe(0);
  });

  it('lifting, cancelling or releasing outside always stops the ship', () => {
    const { hub, pad } = rig();
    pad.down(1, 'move', -0.9);
    pad.move(1, -5); // dragged far outside the control: clamped, still steering
    expect(hub.moveX).toBe(-1);
    pad.up(1); // pointerup anywhere (window listener) / pointercancel / lostpointercapture
    expect(hub.moveX).toBe(0);
    pad.up(1); // duplicate release (cancel + lostpointercapture) is harmless
    expect(pad.activePointers).toBe(0);
  });

  it('reset() on blur drops all fingers', () => {
    const { hub, pad } = rig();
    pad.down(1, 'move', 0.9);
    pad.down(2, 'fire');
    pad.reset();
    expect(hub.moveX).toBe(0);
    expect(pad.activePointers).toBe(0);
  });

  it('two fingers on the pad: the newest steers, lifting it falls back', () => {
    const { hub, pad } = rig();
    pad.down(1, 'move', -0.8);
    pad.down(2, 'move', 0.8);
    expect(hub.moveX).toBe(1);
    pad.up(2);
    expect(hub.moveX).toBe(-1);
  });

  it('touch and keyboard together: newest wins, each release falls back', () => {
    const { hub, kb, pad } = rig();
    kb.keyDown(key('ArrowLeft'));
    pad.down(5, 'move', 0.9);
    expect(hub.moveX).toBe(1);
    pad.up(5);
    expect(hub.moveX).toBe(-1); // key still held
    pad.down(6, 'fire');
    expect(hub.frame()).toMatchObject({ moveX: -1, fire: true });
  });

  it('re-asserts the held direction after a menu click cleared the hub', () => {
    const { hub, pad } = rig();
    pad.down(1, 'move', 0.9);
    hub.clear();
    pad.move(1, 0.92);
    expect(hub.moveX).toBe(1);
  });

  it('pause zone toggles pause with one press per touch', () => {
    const { hub, pad } = rig();
    pad.down(1, 'pause');
    expect(hub.frame().pause).toBe(true);
    expect(hub.frame().pause).toBe(false);
  });
});

/* ---------- engine independence ---------- */

describe('the engine sees one input model', () => {
  it('keyboard and touch adapters driving the same intents give an identical game', () => {
    const script = (t: number): { dir: -1 | 0 | 1; fire: boolean } => ({ dir: t % 240 < 100 ? -1 : t % 240 < 200 ? 1 : 0, fire: t % 13 === 0 });
    const viaKeyboard = makeEngine({ seed: 21 });
    const viaTouch = makeEngine({ seed: 21 });
    startPlaying(viaKeyboard);
    startPlaying(viaTouch);
    const k = rig();
    const tp = rig();
    let kDir = 0;
    for (let t = 0; t < 60 * 40; t++) {
      const { dir, fire } = script(t);
      // keyboard adapter
      if (dir !== kDir) {
        if (kDir === -1) k.kb.keyUp({ code: 'ArrowLeft' });
        if (kDir === 1) k.kb.keyUp({ code: 'ArrowRight' });
        if (dir === -1) k.kb.keyDown(key('ArrowLeft'));
        if (dir === 1) k.kb.keyDown(key('ArrowRight'));
        kDir = dir;
      }
      if (fire) {
        k.kb.keyDown(key('Space'));
        k.kb.keyUp({ code: 'Space' }); // a tap: press and release (holding now autofires, TD-74)
      }
      // touch adapter
      if (dir === 0) tp.pad.up(1);
      else if (tp.pad.has(1)) tp.pad.move(1, dir * 0.9);
      else tp.pad.down(1, 'move', dir * 0.9);
      if (fire) {
        tp.pad.down(2, 'fire');
        tp.pad.up(2);
      }
      viaKeyboard.engine.step(k.hub.frame({ fireConfirms: false }));
      viaTouch.engine.step(tp.hub.frame({ fireConfirms: false }));
    }
    expect(viaTouch.engine.digest()).toBe(viaKeyboard.engine.digest());
    expect(viaTouch.rewards.snapshot()).toEqual(viaKeyboard.rewards.snapshot());
  });

  it('pause menu RESTART abandons the run and starts a fresh one', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    run(h.engine, 30, { ...NO_INPUT, fire: true } as InputFrame);
    h.engine.pause();
    expect(applyMenuAction(h.engine, 'restart', null)).toEqual({ overlay: null, ok: true });
    expect(['ready', 'restarting']).toContain(h.engine.phase);
    runUntil(h.engine, () => h.engine.phase === 'playing');
    expect(h.rewards.snapshot()).toMatchObject({ score: 0, reserves: 2, stage: 1, status: 'running' });
    // restart is refused mid-play (only from pause or game over)
    expect(applyMenuAction(h.engine, 'restart', null).ok).toBe(false);
  });
});
