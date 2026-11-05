/**
 * Post-release per-vessel cargo holds (docs/freeroam/FLEET_COMMAND.md): persistence (the additive
 * `holds` field, clean-up, round-trip), authoritative capacity and transfer rules, the collective
 * cargo summary (counted once) and atomicity: failed transfers change nothing, repeated commands
 * cannot duplicate units.
 */
import { describe, expect, it } from 'vitest';
import type { CrewState } from '../src/modes/freeroam/crew/types.ts';
import * as Kit from '../src/modes/freeroam/fleet/fleetKit.ts';
import { transfer, transferRefusal, transferRefusalText, type CommandWorld } from '../src/modes/freeroam/fleet/command.ts';
import { cleanVessels, fleetHull, serviceAtDock, vesselCapacity, vesselHold, vesselsToSaved, type FleetVessel, type Vessels } from '../src/modes/freeroam/fleet/vessels.ts';
import { collectiveCargo, holdUnits, type Hold } from '../src/modes/freeroam/inventory/inventory.ts';
import { EMPTY_PROFILE, loadProfile, saveProfile } from '../src/modes/freeroam/profile.ts';
import { SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import { upgradedShip } from '../src/modes/freeroam/ships/upgrades.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const MAREN = 'maren-sato';
const roster = (): CrewState => ({ hired: [MAREN], paid: [MAREN], seats: {} });

const specs: readonly FleetVessel[] = [
  { id: 'fv-1', ship: 'swift', captain: MAREN, status: 'active' },
  { id: 'fv-2', ship: 'shrike', captain: null, status: 'active' },
];
const vessels = (holds: Record<string, Hold> = {}): Vessels => ({ seq: 2, list: specs.map((s) => ({ ...s })), holds });
const SWIFT = vesselCapacity('swift');
const SHRIKE = vesselCapacity('shrike');
/** Calm space, docked: the transfer gate this block of tests keeps satisfied. */
const DOCKED: CommandWorld = { docked: 'milky-way/sol', safe: true, admin: false, crew: { hired: [MAREN], seats: {} }, knownCrew: (id) => id === MAREN };
/** The saved record a legacy file holds: captain omitted when uncrewed. */
const savedSpecs = () => [
  { id: 'fv-1' as const, ship: 'swift' as const, captain: MAREN, status: 'active' as const },
  { id: 'fv-2' as const, ship: 'shrike' as const, status: 'active' as const },
];

describe('per-vessel holds: persistence and clean-up', () => {
  it('a legacy save (a plain v10 fleet record without holds) loads with empty holds and grants nothing', () => {
    const r = cleanVessels({ seq: 2, list: savedSpecs() }, roster());
    expect(r.state.list).toHaveLength(2);
    expect(r.state.holds).toEqual({});
  });
  it('keeps well-formed holds, drops holds of unknown vessels, skips empty and malformed entries', () => {
    const r = cleanVessels({ seq: 2, list: savedSpecs(), holds: {
      'fv-1': { scrap: 5, fuel: 2 },
      'fv-9': { scrap: 99 }, // unknown vessel: a malformed record never grants cargo
      'fv-2': { scrap: 0, fuel: -3, ice: 1.5, crystal: 4 },
    } as never }, roster());
    expect(r.state.holds['fv-1']).toEqual({ scrap: 5, fuel: 2 });
    expect(r.state.holds['fv-9']).toBeUndefined();
    expect(r.state.holds['fv-2']).toEqual({ crystal: 4 });
    expect(r.changes).toBeGreaterThan(0);
  });
  it('an all-empty hold map cleans to empty; holds round-trip through the real profile store', () => {
    expect(cleanVessels({ seq: 2, list: savedSpecs(), holds: { 'fv-1': {}, 'fv-2': { scrap: 0 } } as never }, roster()).state.holds).toEqual({});
    const store = new MemoryStore();
    saveProfile(store, { ...EMPTY_PROFILE, vessels: vesselsToSaved(vessels({ 'fv-1': { scrap: 7 } }))! });
    const r = loadProfile(store);
    expect(r.data.vessels?.holds?.['fv-1']).toEqual({ scrap: 7 });
  });
  it('vessel records keep storing only id, archetype, captain and status (never the cargo)', () => {
    const saved = vesselsToSaved(vessels({ 'fv-1': { scrap: 9 } }))!;
    expect(Object.keys(saved.list[0]!).sort()).toEqual(['captain', 'id', 'ship', 'status']);
    expect(saved.holds).toEqual({ 'fv-1': { scrap: 9 } });
    expect(vesselsToSaved(vessels())!.holds).toBeUndefined(); // empty holds are not written
  });
  it('docking service (disabled vessels back in service) never touches the holds', () => {
    const v = vessels({ 'fv-1': { scrap: 3 } });
    const parked: Vessels = { ...v, list: [v.list[0]!, { ...v.list[1]!, status: 'disabled' }] };
    const after = serviceAtDock(parked);
    expect(after.list[1]!.status).toBe('active');
    expect(after.holds).toEqual({ 'fv-1': { scrap: 3 } });
  });
});

describe('per-vessel holds: capacity and the collective summary', () => {
  it('every fleet archetype has an explicit catalogue cargo capacity (> 0), the stock archetype exactly', () => {
    expect(SHIPS).toHaveLength(10);
    for (const s of SHIPS.filter((x) => !x.salvage && fleetHull(x.id))) {
      expect(vesselCapacity(s.id)).toBeGreaterThan(0);
      expect(vesselCapacity(s.id)).toBe(Math.max(0, Math.floor(upgradedShip(s.id, undefined, {}).stats.cargo)));
    }
  });
  it('vesselHold reads only that vessel; the collective sums the ship and every owned vessel exactly once', () => {
    const v = vessels({ 'fv-1': { scrap: 5, fuel: 2 }, 'fv-2': { ice: 3 } });
    expect(vesselHold(v, 'fv-1')).toEqual({ scrap: 5, fuel: 2 });
    expect(vesselHold(v, 'fv-9')).toEqual({});
    const cc = collectiveCargo('AURORA', { scrap: 10 }, 20, [
      { name: 'SWIFT · ESCORT 1', hold: vesselHold(v, 'fv-1'), capacity: SWIFT },
      { name: 'SHRIKE · ESCORT 2', hold: vesselHold(v, 'fv-2'), capacity: SHRIKE },
    ]);
    expect(cc.used).toBe(10 + 7 + 3);
    expect(cc.capacity).toBe(20 + SWIFT + SHRIKE);
    expect(cc.free).toBe(cc.capacity - cc.used);
    expect(cc.holds).toHaveLength(3);
    expect(cc.byType.map((r) => r.resource).sort()).toEqual(['fuel', 'ice', 'scrap']); // summed across holds, no zeroes
    expect(cc.byType.find((r) => r.resource === 'scrap')!.amount).toBe(15);
    expect(cc.byType.find((r) => r.resource === 'fuel')!.amount).toBe(2);
    expect(cc.byType.find((r) => r.resource === 'ice')!.amount).toBe(3);
    expect(holdUnits(v.holds['fv-1'] ?? {})).toBe(7);
    expect(holdUnits({})).toBe(0);
    expect(collectiveCargo('A', {}, -5, []).capacity).toBe(0); // capacities never go negative
  });
  it('moving cargo between holds leaves the collective count unchanged (no double count, no loss)', () => {
    const v = vessels({ 'fv-1': { scrap: 8 } });
    const holdsOf = (x: Vessels) => [{ name: 'V1', hold: vesselHold(x, 'fv-1'), capacity: SWIFT }];
    const before = collectiveCargo('A', { scrap: 2 }, 20, holdsOf(v));
    const r = transfer(v, 'fv-1', 'hold', 'scrap', 8, { scrap: 2 }, 20, DOCKED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = collectiveCargo('A', r.hold, 20, holdsOf(r.vessels));
    expect(after.used).toBe(before.used);
    expect(after.capacity).toBe(before.capacity);
  });
});

describe('per-vessel holds: the authoritative transfer', () => {
  it('moves exact units both ways; a fully-moved stack leaves no zero entry in the source', () => {
    const v = vessels({ 'fv-1': { scrap: 8, fuel: 4 } });
    const out = transfer(v, 'fv-1', 'hold', 'scrap', 8, {}, 20, DOCKED);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.moved).toEqual([{ resource: 'scrap', amount: 8 }]);
    expect(out.left).toEqual([]);
    expect(out.hold).toEqual({ scrap: 8 });
    expect(vesselHold(out.vessels, 'fv-1')).toEqual({ fuel: 4 }); // the source hold object was not mutated
    expect(vesselHold(v, 'fv-1')).toEqual({ scrap: 8, fuel: 4 });
    const back = transfer(out.vessels, 'hold', 'fv-2', 'scrap', 3, out.hold, 20, DOCKED);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(vesselHold(back.vessels, 'fv-2')).toEqual({ scrap: 3 });
    expect(back.hold).toEqual({ scrap: 5 });
  });
  it('a tight hold takes what fits and the rest stays; when nothing fits it refuses, changing nothing', () => {
    const v = vessels({ 'fv-1': { scrap: SHRIKE + 15 } });
    const full = transfer(v, 'fv-1', 'fv-2', 'scrap', SHRIKE + 15, {}, SWIFT, DOCKED);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.moved).toEqual([{ resource: 'scrap', amount: SHRIKE }]); // moved: what fits
    expect(full.left).toEqual([{ resource: 'scrap', amount: 15 }]); // left: the rest stays aboard
    expect(vesselHold(full.vessels, 'fv-1')).toEqual({ scrap: 15 });
    expect(vesselHold(full.vessels, 'fv-2')).toEqual({ scrap: SHRIKE });
    const again = transfer(full.vessels, 'fv-1', 'fv-2', 'scrap', 5, {}, SWIFT, DOCKED);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('no-room');
    // a failure changes nothing: the source state is untouched (the move is pure, the caller commits)
    expect(vesselHold(full.vessels, 'fv-1')).toEqual({ scrap: 15 });
    expect(vesselHold(full.vessels, 'fv-2')).toEqual({ scrap: SHRIKE });
  });
  it('refuses and changes nothing: unknown vessel, same ends, unknown resource, bad or unavailable amount', () => {
    const v = vessels({ 'fv-1': { scrap: 8 } });
    const bad: [string, string, string, number][] = [
      ['fv-1', 'fv-9', 'scrap', 1],
      ['fv-1', 'fv-1', 'scrap', 1],
      ['fv-1', 'hold', 'kyber', 1],
      ['fv-1', 'hold', 'scrap', 0],
      ['fv-1', 'hold', 'scrap', 2.5],
      ['fv-1', 'hold', 'scrap', -3],
      ['fv-1', 'hold', 'scrap', 9], // stale UI amount: more than the hold has
    ];
    for (const [from, to, res, n] of bad) {
      const r = transfer(v, from, to, res, n, {}, 20, DOCKED);
      expect(r.ok).toBe(false);
      if (r.ok) return; // every refusal below must be one
      expect(r.reason).toBeTruthy();
      expect(vesselHold(v, 'fv-1')).toEqual({ scrap: 8 }); // the very same contents; nothing moved
    }
  });
  it('transferRefusal labels an infeasible move and stays silent on a feasible one', () => {
    const v = vessels({ 'fv-1': { scrap: 8 } });
    expect(transferRefusal(v, 'fv-1', 'hold', 'scrap', 5, {}, 20, DOCKED)).toBeNull();
    expect(transferRefusal(v, 'fv-1', 'hold', 'kyber', 5, {}, 20, DOCKED)).toBe('unknown-resource');
    expect(transferRefusal(v, 'fv-1', 'hold', 'scrap', 0, {}, 20, DOCKED)).toBe('bad-amount');
    expect(transferRefusal(v, 'fv-1', 'hold', 'scrap', 9, {}, 20, DOCKED)).toBe('short');
    expect(transferRefusal(v, 'fv-1', 'hold', 'scrap', 1, {}, 0, DOCKED)).toBe('no-room');
    expect(transferRefusal(v, 'hold', 'fv-9', 'scrap', 1, { scrap: 1 }, 20, DOCKED)).toBe('unknown-vessel');
    expect(transferRefusal(v, 'fv-1', 'fv-1', 'scrap', 1, {}, 20, DOCKED)).toBe('same-end');
    for (const code of ['unknown-resource', 'bad-amount', 'short', 'no-room', 'same-end', 'unknown-vessel', 'not-docked', 'unsafe', 'admin'] as const) {
      expect(transferRefusalText(code).length).toBeGreaterThan(0); // every refusal is explained in words
    }
  });
});

describe('per-vessel holds: docked-only rules with the fleet world', () => {
  it('transfers need to be docked, in calm space and not in the sandbox; a failed transfer changes nothing', () => {
    const v = vessels({ 'fv-1': { scrap: 8 } });
    const blocked: [CommandWorld, string][] = [
      [{ ...DOCKED, docked: null }, 'not-docked'],
      [{ ...DOCKED, safe: false }, 'unsafe'],
      [{ ...DOCKED, admin: true }, 'admin'],
    ];
    for (const [w, reason] of blocked) {
      const r = Kit.transfer(v, 'fv-1', 'hold', 'scrap', 2, {}, 20, w);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe(reason);
        expect(Kit.transferRefusalText(r.reason).length).toBeGreaterThan(0); // the reason is explained, never silent
      }
    }
    expect(vesselHold(v, 'fv-1')).toEqual({ scrap: 8 }); // pure: the inputs were never written to
    const good = Kit.transfer(v, 'fv-1', 'hold', 'scrap', 2, {}, 20, DOCKED);
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.moved).toEqual([{ resource: 'scrap', amount: 2 }]);
    expect(good.left).toEqual([]);
    expect(good.hold).toEqual({ scrap: 2 });
    expect(vesselHold(good.vessels, 'fv-1')).toEqual({ scrap: 6 });
  });
  it('repeating the command on the result is safe: only what is actually there moves, never more', () => {
    const v = vessels({ 'fv-1': { scrap: 3 } });
    const once = Kit.transfer(v, 'fv-1', 'hold', 'scrap', 3, {}, 20, DOCKED);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(once.hold).toEqual({ scrap: 3 });
    const again = Kit.transfer(once.vessels, 'fv-1', 'hold', 'scrap', 3, once.hold, 20, DOCKED);
    expect(again.ok).toBe(false); // a second click on a stale model refuses instead of inventing units
    if (!again.ok) expect(again.reason).toBe('short');
    expect(vesselHold(once.vessels, 'fv-1')).toEqual({});
    expect(once.hold).toEqual({ scrap: 3 });
  });
});
