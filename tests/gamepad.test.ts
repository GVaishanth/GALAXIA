/**
 * Stage 8 gamepad input: GamepadModel (pure) and the GamepadInput adapter
 * with a fake navigator.getGamepads. Deterministic: time is passed in.
 */
import { describe, expect, it } from 'vitest';
import { GAMEPAD } from '../src/config/devices.ts';
import { GamepadInput, GamepadModel, mergeSnapshots, type PadSnapshot } from '../src/input/gamepad.ts';
import { InputHub } from '../src/input/inputHub.ts';

const B = GAMEPAD.buttons;
/** Snapshot helper: stick (x, y) and named buttons held. */
function pad(x = 0, y = 0, ...held: (keyof typeof B)[]): PadSnapshot {
  const pressed: boolean[] = new Array(17).fill(false);
  for (const h of held) pressed[B[h]] = true;
  return { axes: [x, y, 0, 0], pressed };
}

describe('GamepadModel: movement', () => {
  it('stick X uses a dead zone with hysteresis', () => {
    const m = new GamepadModel();
    expect(m.update(pad(GAMEPAD.deadZone - 0.05), 0).moveX).toBe(0);
    expect(m.update(pad(GAMEPAD.deadZone + 0.05), 16).moveX).toBe(1);
    // inside the hysteresis band: keeps moving
    expect(m.update(pad(GAMEPAD.deadZone - GAMEPAD.hysteresis / 2), 32).moveX).toBe(1);
    // below it: stops
    expect(m.update(pad(GAMEPAD.deadZone - GAMEPAD.hysteresis - 0.02), 48).moveX).toBe(0);
    expect(m.update(pad(-0.9), 64).moveX).toBe(-1);
  });

  it('D-pad overrides the stick; both D-pad directions cancel out to the stick', () => {
    const m = new GamepadModel();
    expect(m.update(pad(0.9, 0, 'left'), 0).moveX).toBe(-1);
    expect(m.update(pad(0.9, 0, 'left', 'right'), 16).moveX).toBe(1);
    expect(m.update(pad(0, 0, 'right'), 32).moveX).toBe(1);
  });

  it('hysteresis never latches onto a released D-pad direction (stick drift stays ignored)', () => {
    const m = new GamepadModel();
    m.update(pad(0, 0, 'right'), 0);
    expect(m.update(pad(GAMEPAD.deadZone - 0.05), 16).moveX).toBe(0);
  });

  it('non-finite axis values are treated as centred', () => {
    const m = new GamepadModel();
    expect(m.update({ axes: [Number.NaN, Number.POSITIVE_INFINITY], pressed: [] }, 0)).toMatchObject({ moveX: 0, presses: [] });
  });
});

describe('GamepadModel: presses', () => {
  it('a held button is exactly one press (no auto-fire)', () => {
    const m = new GamepadModel();
    const got = [0, 16, 32, 48, 1000].map((t) => m.update(pad(0, 0, 'a'), t).presses);
    expect(got.flat()).toEqual(['a']);
    m.update(pad(), 1016);
    expect(m.update(pad(0, 0, 'a'), 1032).presses).toEqual(['a']);
  });

  it('menu directions auto-repeat while held (delay, then interval)', () => {
    const m = new GamepadModel();
    const at = (t: number) => m.update(pad(0, 0, 'down'), t).presses.filter((p) => p === 'down').length;
    expect(at(0)).toBe(1);
    expect(at(GAMEPAD.repeatDelayMs - 1)).toBe(0);
    expect(at(GAMEPAD.repeatDelayMs)).toBe(1);
    expect(at(GAMEPAD.repeatDelayMs + GAMEPAD.repeatIntervalMs - 1)).toBe(0);
    expect(at(GAMEPAD.repeatDelayMs + GAMEPAD.repeatIntervalMs)).toBe(1);
  });

  it('stick Y beyond menuAxis navigates menus', () => {
    const m = new GamepadModel();
    expect(m.update(pad(0, -0.9), 0).presses).toContain('up');
    expect(m.update(pad(0, 0), 16).presses).toEqual([]);
    expect(m.update(pad(0, 0.9), 32).presses).toContain('down');
  });

  it('after reset() (blur) a button still held is ignored until released', () => {
    const m = new GamepadModel();
    m.update(pad(0, 0, 'a', 'down'), 0);
    m.reset();
    expect(m.update(pad(0, 0, 'a', 'down'), 16).presses).toEqual([]);
    expect(m.update(pad(0, 0, 'a', 'down'), 5000).presses).toEqual([]); // no repeat either
    m.update(pad(), 5016);
    expect(m.update(pad(0, 0, 'a'), 5032).presses).toEqual(['a']);
  });

  it('a pad appearing (first press reveals it) counts its first press', () => {
    const m = new GamepadModel();
    m.update(null, 0);
    m.update(null, 16);
    expect(m.update(pad(0, 0, 'start'), 32).presses).toEqual(['start']);
  });

  it('a disconnect releases movement', () => {
    const m = new GamepadModel();
    expect(m.update(pad(-1), 0).moveX).toBe(-1);
    expect(m.update(null, 16)).toEqual({ moveX: 0, presses: [], active: false, fireHeld: false });
  });

  it('active reports use (any button, stick past the dead zone), not an idle pad', () => {
    const m = new GamepadModel();
    expect(m.update(pad(0.1, 0.1), 0).active).toBe(false);
    expect(m.update(pad(0, 0, 'b'), 16).active).toBe(true);
    expect(m.update(pad(0.8), 32).active).toBe(true);
  });
});

describe('GamepadInput adapter', () => {
  const fake = (buttons: number[], axes = [0, 0]) => ({
    connected: true,
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: buttons.includes(i), value: buttons.includes(i) ? 1 : 0 })),
  });

  it('merges every connected pad and ignores empty slots', () => {
    let pads: (ReturnType<typeof fake> | null)[] = [null, fake([], [0.9, 0]), fake([B.a])];
    const g = new GamepadInput(() => pads);
    const u = g.poll(0);
    expect(g.connected).toBe(2);
    expect(u).toMatchObject({ moveX: 1, active: true });
    expect(u.presses).toEqual(['a', 'right']); // stick past menuAxis is also a menu 'right' (ignored in play)
    pads = [];
    expect(g.poll(16)).toMatchObject({ moveX: 0, active: false });
    expect(g.connected).toBe(0);
  });

  it('analogue triggers count past half travel', () => {
    const p = fake([]);
    p.buttons[B.x] = { pressed: false, value: 0.7 };
    expect(new GamepadInput(() => [p]).poll(0).presses).toEqual(['x']);
  });

  it('survives a getGamepads that throws (permissions policy) or is missing', () => {
    const g = new GamepadInput(() => {
      throw new Error('blocked');
    });
    expect(g.poll(0)).toEqual({ moveX: 0, presses: [], active: false, fireHeld: false });
    expect(new GamepadInput().poll(0).presses).toEqual([]); // node: no navigator.getGamepads
  });

  it('mergeSnapshots keeps the strongest axis and ORs buttons', () => {
    expect(mergeSnapshots([])).toBeNull();
    const m = mergeSnapshots([pad(0.2, -0.9), pad(-0.6, 0.1, 'start')])!;
    expect(m.axes.slice(0, 2)).toEqual([-0.6, -0.9]);
    expect(m.pressed[B.start]).toBe(true);
  });
});

describe('InputHub with a gamepad source', () => {
  it('gamepad and keyboard holds mix: newest wins, releasing falls back', () => {
    const hub = new InputHub();
    hub.setMove('keyboard', -1);
    hub.setMove('gamepad', 1);
    expect(hub.moveX).toBe(1);
    hub.setMove('gamepad', 0);
    expect(hub.moveX).toBe(-1);
    hub.press('fire', 'gamepad');
    expect(hub.pressCount.gamepad).toBe(1);
    expect(hub.frame({ fireConfirms: false })).toMatchObject({ fire: true, start: false });
  });
});
