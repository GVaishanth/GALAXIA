/**
 * Hold-to-fire and weapon heat (owner request): Classic TD-74 and the Free
 * Roam weapon heat FR-TD-79, plus the input holds that drive them.
 * Deterministic: fixed ticks, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE } from '../src/config/engine.ts';
import { GAMEPAD } from '../src/config/devices.ts';
import { NO_INPUT, type InputFrame } from '../src/core/game/input.ts';
import type { GameEvent } from '../src/core/game/events.ts';
import { GamepadModel, type PadSnapshot } from '../src/input/gamepad.ts';
import { InputHub } from '../src/input/inputHub.ts';
import { KeyboardInput, type KeyLike } from '../src/input/keyboard.ts';
import { TouchPadModel } from '../src/input/touchPad.ts';
import { sectorCue } from '../src/modes/freeroam/audio/frCues.ts';
import { FR_SOUNDS } from '../src/modes/freeroam/audio/frSounds.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, RUN, stepSector, type SectorEvent, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { HEAT_HOT_AT, shipCard } from '../src/modes/freeroam/ui/hudModel.ts';
import { makeEngine, run, startPlaying } from './helpers/engine.ts';

const TICK_MS = 1000 / 60;
const HOLD: InputFrame = { ...NO_INPUT, fireHeld: true };
const ticksFor = (ms: number): number => Math.ceil(ms / TICK_MS);

function key(code: string, extra: Partial<KeyLike> = {}): KeyLike {
  return { code, repeat: false, target: null, ctrlKey: false, metaKey: false, altKey: false, preventDefault: () => {}, ...extra } as KeyLike;
}

function pad(fire: boolean): PadSnapshot {
  const pressed: boolean[] = new Array(17).fill(false);
  if (fire) pressed[GAMEPAD.buttons.a] = true;
  return { axes: [0, 0, 0, 0], pressed };
}

/** A playing Classic engine with attacks silenced, and its event log. */
function classic(): { h: ReturnType<typeof makeEngine>; log: GameEvent[]; step: (n: number, f?: InputFrame) => void } {
  const h = makeEngine({ seed: 7 });
  startPlaying(h, { quiet: true });
  h.engine.drainEvents();
  const log: GameEvent[] = [];
  const step = (n: number, f: InputFrame = HOLD): void => {
    run(h.engine, n, f);
    log.push(...h.engine.drainEvents());
  };
  return { h, log, step };
}

const count = (log: readonly GameEvent[], type: GameEvent['type']): number => log.filter((e) => e.type === type).length;

/* ---------- input: every adapter reports a hold, separate from the press ---------- */

describe('fire holds (InputHub and adapters)', () => {
  it('the hub holds fire while any source holds it; clear() and clearSource() drop holds', () => {
    const hub = new InputHub();
    hub.setFireHeld('keyboard', true);
    hub.setFireHeld('touch', true);
    expect(hub.frame().fireHeld).toBe(true);
    hub.setFireHeld('keyboard', false);
    expect(hub.frame().fireHeld).toBe(true); // touch still holds
    hub.clearSource('touch');
    expect(hub.frame().fireHeld).toBe(false);
    hub.setFireHeld('gamepad', true);
    hub.clear();
    expect(hub.frame().fireHeld).toBe(false);
  });

  it('keyboard: Space down = one press plus a hold; key up or reset() ends the hold', () => {
    const hub = new InputHub();
    const kb = new KeyboardInput(hub);
    kb.keyDown(key('Space'));
    expect(hub.frame({ fireConfirms: false })).toMatchObject({ fire: true, fireHeld: true });
    expect(hub.frame({ fireConfirms: false })).toMatchObject({ fire: false, fireHeld: true }); // one press, still held
    kb.keyDown(key('KeyZ'));
    kb.keyUp({ code: 'Space' });
    expect(hub.frame({ fireConfirms: false }).fireHeld).toBe(true); // Z still down
    kb.keyUp({ code: 'KeyZ' });
    expect(hub.frame({ fireConfirms: false }).fireHeld).toBe(false);
    kb.keyDown(key('Space'));
    kb.reset();
    expect(hub.frame({ fireConfirms: false }).fireHeld).toBe(false);
  });

  it('keyboard: an auto-repeat alone never starts a hold', () => {
    const hub = new InputHub();
    const kb = new KeyboardInput(hub);
    kb.keyDown(key('Space', { repeat: true }));
    expect(hub.frame()).toEqual(NO_INPUT);
  });

  it('touch: a finger on FIRE holds until the last fire finger lifts', () => {
    const hub = new InputHub();
    const tp = new TouchPadModel(hub);
    tp.down(1, 'fire');
    tp.down(2, 'fire');
    expect(hub.frame({ fireConfirms: false })).toMatchObject({ fire: true, fireHeld: true });
    tp.up(1);
    expect(hub.frame({ fireConfirms: false }).fireHeld).toBe(true);
    tp.up(2);
    expect(hub.frame({ fireConfirms: false }).fireHeld).toBe(false);
  });

  it('gamepad: A held reports a hold; after reset() a still-held A is ignored until released', () => {
    const m = new GamepadModel();
    expect(m.update(pad(true), 0)).toMatchObject({ presses: ['a'], fireHeld: true });
    expect(m.update(pad(true), 16).fireHeld).toBe(true);
    m.reset();
    expect(m.update(pad(true), 32).fireHeld).toBe(false);
    m.update(pad(false), 48);
    expect(m.update(pad(true), 64).fireHeld).toBe(true);
  });
});

/* ---------- Classic (TD-74) ---------- */

describe('Classic hold-to-fire and heat (TD-74)', () => {
  it('a hold keeps firing; the shots-on-screen cap still applies', () => {
    const { h, log, step } = classic();
    step(1, { ...HOLD, fire: true });
    let maxOnScreen = 0;
    for (let i = 0; i < 90; i++) {
      step(1);
      maxOnScreen = Math.max(maxOnScreen, h.engine.world.playerShots.length);
    }
    expect(count(log, 'playerShot')).toBeGreaterThan(3);
    expect(maxOnScreen).toBeLessThanOrEqual(ENGINE.shots.maxSingle);
  });

  it('taps never heat the weapon', () => {
    const { h, step } = classic();
    for (let i = 0; i < 40; i++) {
      step(1, { ...NO_INPUT, fire: true, fireHeld: true });
      step(ticksFor(ENGINE.heat.graceMs) - 2, HOLD); // released just inside the grace
      step(6, NO_INPUT);
    }
    expect(h.engine.world.heat.level).toBe(0);
    expect(h.engine.world.heat.overheated).toBe(false);
  });

  it('a long hold overheats once, locks the weapon, then cools and resumes', () => {
    const { h, log, step } = classic();
    const c = ENGINE.heat;
    step(ticksFor(c.graceMs + c.riseMs) - 3);
    expect(h.engine.world.heat.overheated).toBe(false);
    step(6);
    expect(h.engine.world.heat.overheated).toBe(true);
    expect(count(log, 'weaponOverheated')).toBe(1);
    // locked: holding or pressing does not fire
    const shotsBefore = count(log, 'playerShot');
    step(1, { ...HOLD, fire: true });
    step(ticksFor((1 - c.resumeAt) * c.coolMs) - 4);
    expect(count(log, 'playerShot')).toBe(shotsBefore);
    expect(h.engine.world.heat.overheated).toBe(true);
    // cools to resumeAt even while held, then fires again
    step(8);
    expect(count(log, 'weaponCooled')).toBe(1);
    expect(h.engine.world.heat.overheated).toBe(false);
    step(30);
    expect(count(log, 'playerShot')).toBeGreaterThan(shotsBefore);
  });

  it('released fire cools from full to cold in coolMs', () => {
    const { h, step } = classic();
    step(ticksFor(ENGINE.heat.graceMs + ENGINE.heat.riseMs * 0.5));
    const level = h.engine.world.heat.level;
    expect(level).toBeGreaterThan(0.4);
    step(ticksFor(level * ENGINE.heat.coolMs) + 1, NO_INPUT);
    expect(h.engine.world.heat.level).toBe(0);
  });
});

/* ---------- Free Roam (FR-TD-79) ---------- */

describe('Free Roam weapon heat (FR-TD-79)', () => {
  const quietSector = (): SectorRun => {
    const sys = getCatalogue().systems[0]!;
    const L = generateSector(sys, sectorContext(buildNavGraph(), sys.id));
    const open = { ...L, rocks: [], landmarks: [], patrols: [], sites: [], hazards: [], pois: L.pois.filter((p) => p.kind !== 'installation') }; // survey marks keep the sector in flight
    const r = createSectorRun(open, EMPTY_SECTOR_SAVE, { seed: 3 });
    r.grace = 1e9;
    return r;
  };

  it('about fullTicks of continuous fire overheats any module; locked until resumeAt', () => {
    const r = quietSector();
    const events: SectorEvent[] = [];
    let ticks = 0;
    while (!r.overheated && ticks < RUN.heat.fullTicks * 2) {
      events.push(...stepSector(r, { moveX: 0, moveY: 0, fire: true }));
      r.shots.length = 0; // keep the bolt pool from capping the cadence
      ticks += 1;
    }
    expect(r.overheated).toBe(true);
    expect(ticks).toBeGreaterThan(RUN.heat.fullTicks * 0.8);
    expect(ticks).toBeLessThanOrEqual(RUN.heat.fullTicks + r.craft.weapon.cooldownTicks);
    expect(events.filter((e) => e.type === 'overheated')).toHaveLength(1);
    const fired = r.shotsFired;
    const lockTicks = Math.ceil((1 - RUN.heat.resumeAt) * RUN.heat.coolTicks);
    for (let i = 0; i < lockTicks - 2; i++) events.push(...stepSector(r, { moveX: 0, moveY: 0, fire: true }));
    expect(r.shotsFired).toBe(fired); // no bolts while locked, even with fire held
    for (let i = 0; i < 4; i++) events.push(...stepSector(r, { moveX: 0, moveY: 0, fire: true }));
    expect(r.overheated).toBe(false);
    expect(events.filter((e) => e.type === 'weaponCooled')).toHaveLength(1);
    for (let i = 0; i < 30; i++) stepSector(r, { moveX: 0, moveY: 0, fire: true });
    expect(r.shotsFired).toBeGreaterThan(fired);
  });

  it('releasing fire cools the weapon; holding it never cools between shots', () => {
    const r = quietSector();
    for (let i = 0; i < RUN.heat.fullTicks / 2; i++) stepSector(r, { moveX: 0, moveY: 0, fire: true }); // about half full
    const hot = r.heat;
    expect(hot).toBeGreaterThan(0.3);
    for (let i = 0; i < Math.ceil(hot * RUN.heat.coolTicks) + 1; i++) stepSector(r, { moveX: 0, moveY: 0 });
    expect(r.heat).toBe(0);
  });

  it('overheat and cooled have sounds; the ship card shows HEAT, HOT and OVERHEAT in text', () => {
    expect(sectorCue({ type: 'overheated' }, { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.overheat');
    expect(sectorCue({ type: 'weaponCooled' }, { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.cooled');
    expect(FR_SOUNDS['fr.overheat']).toBeDefined();
    expect(FR_SOUNDS['fr.cooled']).toBeDefined();
    const base = { ship: 'kestrel', weapon: 'pulse', docked: false, firing: true, shield: 50, shieldMax: 100, hull: 80, hullMax: 100, energy: 60, energyMax: 100, boosting: false } as const;
    const cold = shipCard({ ...base } as never);
    expect(cold.heat).toEqual({ pct: 0, text: '0%', low: false });
    const hot = shipCard({ ...base, heat: HEAT_HOT_AT + 0.05 } as never);
    expect(hot.heat.text).toMatch(/^HOT \d+%$/);
    expect(hot.heat.low).toBe(true);
    const locked = shipCard({ ...base, heat: 0.9, overheated: true } as never);
    expect(locked.weaponState).toBe('overheated');
    expect(locked.heat.text).toBe('OVERHEAT');
    expect(locked.label).toMatch(/weapon heat overheat/);
    expect(locked.key).not.toBe(hot.key);
    expect(shipCard({ ...base, docked: true, heat: 1, overheated: true } as never).weaponState).toBe('safe');
  });
});
