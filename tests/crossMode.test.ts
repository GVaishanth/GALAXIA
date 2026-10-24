/**
 * Combat P03C: the cross-mode ship registry (modes/crossMode.ts) — the Classic
 * Wave 20 gate, migration from existing saves, merging in both directions and
 * fail-safe handling. MemoryStore only (no DOM).
 */
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/persistence/storage.ts';
import { SAVE_KEY } from '../src/persistence/saveData.ts';
import {
  CLASSIC_GATE_STAGE,
  classicFleet,
  classicOption,
  markClassicComplete,
  mergeOwned,
  recordOwned,
  setClassicShip,
  syncFleet,
} from '../src/modes/crossMode.ts';
import { EMPTY_PROFILE, withFleet } from '../src/modes/freeroam/profile.ts';
import { saveSlot, setActiveSlot, slotKey } from '../src/modes/freeroam/saveSlots.ts';
import type { ShipId } from '../src/modes/freeroam/ships/types.ts';
import { STORAGE_KEYS } from '../src/shared/persistence/namespaces.ts';

const FLEET = STORAGE_KEYS.fleet;

function classicRecord(store: MemoryStore, bestStage: number): void {
  store.write(SAVE_KEY, JSON.stringify({ version: 1, highScore: 1000, bestStage }));
}

function slot(store: MemoryStore, n: 1 | 2 | 3, owned: ShipId[], weapons?: Record<string, { start: string; rotation: string[] }>): void {
  const fleet = { active: owned[0]!, owned, loadouts: {}, ...(weapons ? { weapons } : {}) };
  expect(saveSlot(store, n, withFleet(EMPTY_PROFILE, fleet as never))).toBe(true);
}

const reg = (store: MemoryStore): { classicComplete: boolean; ships: string[]; classicShip: string | null } | null => {
  const raw = store.read(FLEET);
  return raw ? JSON.parse(raw) : null;
};

describe('the Classic Wave 20 gate', () => {
  it('is closed on a fresh install, and nothing is written', () => {
    const store = new MemoryStore();
    expect(classicFleet(store)).toEqual({ open: false, ships: [], selected: null });
    expect(store.read(FLEET)).toBeNull();
  });

  it('entering stage 20 is not completing it: bestStage 20 keeps the gate closed (and slots independent)', () => {
    const store = new MemoryStore();
    classicRecord(store, CLASSIC_GATE_STAGE);
    slot(store, 1, ['petrel', 'swift']);
    expect(classicFleet(store).open).toBe(false);
    expect(mergeOwned(store, ['petrel'])).toEqual(['petrel']);
    recordOwned(store, ['petrel', 'condor']);
    expect(store.read(FLEET)).toBeNull();
  });

  it('migration: a Classic record past stage 20 opens it and merges every slot without loss', () => {
    const store = new MemoryStore();
    classicRecord(store, CLASSIC_GATE_STAGE + 1);
    slot(store, 1, ['petrel', 'swift']);
    slot(store, 3, ['petrel', 'condor']);
    const f = classicFleet(store);
    expect(f.open).toBe(true);
    expect(f.ships.map((s) => s.id)).toEqual(['petrel', 'swift', 'condor']);
    expect(reg(store)).toMatchObject({ classicComplete: true, ships: ['petrel', 'swift', 'condor'], classicShip: null });
  });

  it('completing the stage live persists the milestone (monotonic, idempotent)', () => {
    const store = new MemoryStore();
    markClassicComplete(store);
    expect(reg(store)!.classicComplete).toBe(true);
    const before = store.read(FLEET);
    markClassicComplete(store);
    expect(store.read(FLEET)).toBe(before);
    // a later Classic record below the gate never closes it again
    classicRecord(store, 3);
    expect(classicFleet(store).open).toBe(true);
  });

  it('with no Free Roam save at all the starter is the one roster ship offered', () => {
    const store = new MemoryStore();
    markClassicComplete(store);
    expect(classicFleet(store).ships.map((s) => s.id)).toEqual(['petrel']);
  });
});

describe('sync in both directions (after the gate)', () => {
  it('every slot gets the merged set on load; a purchase in one slot reaches the others and Classic', () => {
    const store = new MemoryStore();
    markClassicComplete(store);
    slot(store, 1, ['petrel', 'shrike']);
    slot(store, 2, ['petrel']);
    // slot 2 loads: it gains slot 1's Shrike
    expect(mergeOwned(store, ['petrel'])).toEqual(['petrel', 'shrike']);
    // slot 2 buys the Albatross
    recordOwned(store, ['petrel', 'shrike', 'albatross']);
    expect(mergeOwned(store, ['petrel', 'shrike'])).toEqual(['petrel', 'shrike', 'albatross']);
    expect(classicFleet(store).ships.map((s) => s.id)).toEqual(['petrel', 'shrike', 'albatross']);
  });

  it('merge never removes: a ship only the registry knows stays after a slot without it loads', () => {
    const store = new MemoryStore();
    markClassicComplete(store);
    recordOwned(store, ['petrel', 'magpie']);
    slot(store, 1, ['petrel']);
    expect(mergeOwned(store, ['petrel'])).toEqual(['petrel', 'magpie']);
    expect(reg(store)!.ships).toEqual(['petrel', 'magpie']);
  });

  it('Classic only remembers an unlocked ship; it grants nothing', () => {
    const store = new MemoryStore();
    markClassicComplete(store);
    recordOwned(store, ['petrel', 'condor']);
    expect(setClassicShip(store, 'albatross').classicShip).toBeNull();
    expect(reg(store)!.ships).toEqual(['petrel', 'condor']);
    expect(setClassicShip(store, 'condor').classicShip).toBe('condor');
    expect(classicFleet(store).selected).toBe('condor');
    expect(setClassicShip(store, null).classicShip).toBeNull();
  });

  it('before the gate Classic cannot store a ship either', () => {
    const store = new MemoryStore();
    expect(setClassicShip(store, 'petrel').classicShip).toBeNull();
    expect(store.read(FLEET)).toBeNull();
  });
});

describe('Classic ship options come from the shared catalogue and the active slot', () => {
  it('nuke only on Condor and Albatross; heavy only on medium hardpoints', () => {
    const store = new MemoryStore();
    const opt = (id: ShipId) => classicOption(store, id);
    expect(opt('condor').compatible).toContain('nuke');
    expect(opt('albatross').compatible).toContain('nuke');
    for (const id of ['petrel', 'swift', 'shrike', 'magpie'] as const) expect(opt(id).compatible).not.toContain('nuke');
    expect(opt('swift').compatible).not.toContain('heavy-missile');
    expect(opt('magpie').compatible).not.toContain('heavy-missile');
  });

  it("uses the active slot's saved rotation and start weapon, with fallbacks for invalid data", () => {
    const store = new MemoryStore();
    slot(store, 2, ['condor'], { condor: { start: 'heavy-missile', rotation: ['plasma', 'heavy-missile', 'nuke'] } });
    expect(setActiveSlot(store, 2)).toBe(true);
    const c = classicOption(store, 'condor');
    expect(c.rotation).toEqual(['plasma', 'heavy-missile', 'nuke']);
    expect(c.start).toBe('heavy-missile');
    expect(c.weapons).toBe('PLASMA · HEAVY · NUKE');
    slot(store, 2, ['petrel'], { petrel: { start: 'nuke', rotation: ['nuke', 'bogus'] } });
    const p = classicOption(store, 'petrel');
    expect(p.rotation).toEqual(['plasma']);
    expect(p.start).toBe('plasma');
  });
});

describe('fail-safe registry handling', () => {
  it('an unreadable registry is rebuilt from the slots (the gate re-detected from Classic)', () => {
    const store = new MemoryStore();
    classicRecord(store, 30);
    slot(store, 1, ['petrel', 'swift']);
    store.write(FLEET, '{broken');
    const f = syncFleet(store);
    expect(f.classicComplete).toBe(true);
    expect(f.ships).toEqual(['petrel', 'swift']);
    expect(store.read(`${FLEET}:backup`)).toBe('{broken');
  });

  it('unknown ids and duplicates are dropped; roster order kept', () => {
    const store = new MemoryStore();
    store.write(FLEET, JSON.stringify({ version: 1, classicComplete: true, ships: ['condor', 'x-wing', 'petrel', 'condor', 7], classicShip: 'x-wing' }));
    const f = syncFleet(store);
    expect(f.ships).toEqual(['petrel', 'condor']);
    expect(f.classicShip).toBeNull();
  });

  it("a newer build's registry is read but never overwritten", () => {
    const store = new MemoryStore();
    const future = JSON.stringify({ version: 9, classicComplete: true, ships: ['petrel'], classicShip: null, extra: 1 });
    store.write(FLEET, future);
    slot(store, 1, ['petrel', 'condor']);
    expect(mergeOwned(store, ['petrel'])).toEqual(['petrel', 'condor']);
    expect(store.read(FLEET)).toBe(future);
  });

  it('a damaged slot is skipped, other data is untouched', () => {
    const store = new MemoryStore();
    markClassicComplete(store);
    slot(store, 1, ['petrel', 'shrike']);
    store.write(slotKey(2), 'NaN{');
    const classicBefore = store.read(SAVE_KEY);
    expect(syncFleet(store).ships).toEqual(['petrel', 'shrike']);
    expect(store.read(slotKey(2))).toBe('NaN{');
    expect(store.read(SAVE_KEY)).toBe(classicBefore);
  });
});
