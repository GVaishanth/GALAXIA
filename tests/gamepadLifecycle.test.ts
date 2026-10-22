/**
 * Controller review (TD-81): detection, standard mapping, release, disconnect
 * and reconnect, focus loss and several pads, through GamepadInput with a
 * simulated navigator.getGamepads(). Physical controllers were not tested.
 */
import { describe, expect, it } from 'vitest';
import { GAMEPAD } from '../src/config/devices.ts';
import { GamepadInput } from '../src/input/gamepad.ts';

type FakePad = { connected: boolean; axes: number[]; buttons: { pressed: boolean; value: number }[] };
const pad = (): FakePad => ({ connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });
const press = (p: FakePad, i: number, on = true): void => {
  p.buttons[i] = { pressed: on, value: on ? 1 : 0 };
};
const B = GAMEPAD.buttons;

function rig(): { slots: (FakePad | null)[]; input: GamepadInput; poll: () => ReturnType<GamepadInput['poll']> } {
  const slots: (FakePad | null)[] = [null, null, null, null];
  const input = new GamepadInput(() => slots);
  let t = 0;
  return { slots, input, poll: () => input.poll((t += 16)) };
}

describe('controller lifecycle (simulated getGamepads)', () => {
  it('uses the W3C standard mapping', () => {
    expect(B).toEqual({ a: 0, b: 1, x: 2, y: 3, select: 8, start: 9, up: 12, down: 13, left: 14, right: 15 });
  });

  it('detects a pad when it appears; its first press counts once', () => {
    const r = rig();
    expect(r.poll()).toMatchObject({ active: false, presses: [] });
    const p = pad();
    press(p, B.start);
    r.slots[0] = p; // browsers expose a pad on its first press
    expect(r.poll().presses).toEqual(['start']);
    expect(r.input.connected).toBe(1);
    expect(r.poll().presses).toEqual([]); // held: no repeat
  });

  it('disconnect mid-move and mid-fire releases everything; an idle reconnect adds nothing', () => {
    const r = rig();
    const p = pad();
    r.slots[0] = p;
    r.poll();
    p.axes[0] = 1;
    press(p, B.a);
    expect(r.poll()).toMatchObject({ moveX: 1, fireHeld: true, presses: ['a', 'right'] }); // a stick past menuAxis is also a menu direction press
    r.slots[0] = null;
    expect(r.poll()).toMatchObject({ moveX: 0, fireHeld: false, presses: [], active: false });
    const q = pad();
    r.slots[1] = q; // comes back in another slot
    expect(r.poll()).toMatchObject({ moveX: 0, fireHeld: false, presses: [] });
    press(q, B.a);
    expect(r.poll().presses).toEqual(['a']);
  });

  it('focus loss (reset) with a button and the stick held: no press and no fire until released', () => {
    const r = rig();
    const p = pad();
    r.slots[0] = p;
    r.poll();
    press(p, B.a);
    r.poll();
    r.input.reset(); // window blur / hidden tab
    let u = r.poll();
    expect(u.presses).toEqual([]);
    expect(u.fireHeld).toBe(false);
    u = r.poll();
    expect(u.fireHeld).toBe(false); // still held from before the blur
    press(p, B.a, false);
    r.poll();
    press(p, B.a);
    u = r.poll();
    expect(u.presses).toEqual(['a']);
    expect(u.fireHeld).toBe(true);
  });

  it('two pads: either plays; unplugging one leaves the other in control', () => {
    const r = rig();
    const one = pad();
    const two = pad();
    r.slots[0] = one;
    r.slots[2] = two;
    r.poll();
    two.axes[0] = -1;
    expect(r.poll().moveX).toBe(-1);
    r.slots[0] = null;
    expect(r.poll().moveX).toBe(-1);
    expect(r.input.connected).toBe(1);
    r.slots[2] = null;
    expect(r.poll()).toMatchObject({ moveX: 0, active: false });
  });

  it('a disconnected pad object still listed (connected:false) is ignored', () => {
    const r = rig();
    const p = pad();
    p.axes[0] = 1;
    p.connected = false;
    r.slots[0] = p;
    expect(r.poll()).toMatchObject({ moveX: 0, active: false });
    expect(r.input.connected).toBe(0);
  });

  it('menu directions repeat while held and stop on release', () => {
    const r = rig();
    const p = pad();
    r.slots[0] = p;
    r.poll();
    press(p, B.down);
    let downs = 0;
    for (let i = 0; i < 60; i += 1) downs += r.poll().presses.filter((x) => x === 'down').length; // about 1 s
    expect(downs).toBeGreaterThanOrEqual(3);
    press(p, B.down, false);
    let after = 0;
    for (let i = 0; i < 30; i += 1) after += r.poll().presses.length;
    expect(after).toBe(0);
  });
});
