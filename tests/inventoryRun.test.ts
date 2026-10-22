/**
 * Free Roam Prompt 10: collection in flight. Stable ids and states, no
 * duplicate awards from repeated contact, the full-hold choice (TAKE WHAT
 * FITS / SWAP / LEAVE IT) never losing anything, partly taken containers,
 * reward caches, ore veins, salvage pods from kills, jettisoned cargo, and the
 * events -> profile -> save -> re-entry round trip. Deterministic seeds only.
 */
import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import { COMBAT } from '../src/modes/freeroam/combat/difficulty.ts';
import { damageAgent } from '../src/modes/freeroam/combat/world.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { fabricate, fitFromStorage } from '../src/modes/freeroam/inventory/fabricator.ts';
import { holdUnits, lootUnits, planSwap, removeLoot } from '../src/modes/freeroam/inventory/inventory.ts';
import { dropBudget, JETTISON_LIFE_TICKS, KILL_DROPS, MINING } from '../src/modes/freeroam/inventory/lootTables.ts';
import { applyCollection, rewardCacheId, type CollectionEvent } from '../src/modes/freeroam/inventory/persistence.ts';
import { EMPTY_PROFILE, loadProfile, saveProfile, withCargo, withModules, withSectorProgress, type FreeRoamProfile } from '../src/modes/freeroam/profile.ts';
import { cacheId, chipId, initialDropBudget, killDrop, MAX_PICKUPS } from '../src/modes/freeroam/sector/collect.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import type { EncounterSite, LootEntry, Poi, SectorLayout, SectorSave } from '../src/modes/freeroam/sector/model.ts';
import { chipsLeft, createSectorRun, interact, jettison, leaveOffer, lootOf, stepSector, takeOffer, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { deriveShip, deriveStats } from '../src/modes/freeroam/ships/equipment.ts';
import { SHIP_BY_ID } from '../src/modes/freeroam/ships/roster.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const graph = buildNavGraph();
const SYSTEMS = getCatalogue().systems;
const gen = (id: string): SectorLayout => generateSector(SYSTEMS.find((s) => s.id === id)!, sectorContext(graph, id));
const ALL: readonly SectorLayout[] = SYSTEMS.map((s) => generateSector(s, sectorContext(graph, s.id)));
const SOL = gen('milky-way/sol');
const idle: SectorInput = { moveX: 0, moveY: 0 };
const SURVEYED: SectorSave = { done: [], surveyed: true };

/** A calm, empty copy of a sector: only the given POIs (and rocks); no veins unless given. */
function open(L: SectorLayout, pois: readonly Poi[] = [], extra: Partial<SectorLayout> = {}): SectorLayout {
  return { ...L, landmarks: [], regions: [], rocks: [], patrols: [], sites: [], hazards: [], veins: [], pois, ...extra };
}
const poiLike = (kind: Poi['kind'], over: Partial<Poi>): Poi => ({ ...SOL.pois.find((p) => p.kind === kind)!, ...over }) as Poi;
const mid = (L: SectorLayout) => ({ x: L.width / 2, y: L.height / 2 });
const place = (r: SectorRun, x: number, y: number): void => {
  Object.assign(r.ship, { x, y, px: x, py: y, vx: 0, vy: 0 });
};
/** Step `ticks` with the pilot pinned at `p` (null = free). Returns every event. */
function fly(r: SectorRun, ticks: number, p: { x: number; y: number } | null, input: SectorInput = idle): SectorEvent[] {
  const out: SectorEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    if (p) place(r, p.x, p.y);
    out.push(...stepSector(r, input));
  }
  return out;
}
const of = <T extends SectorEvent['type']>(ev: readonly SectorEvent[], type: T): Extract<SectorEvent, { type: T }>[] => ev.filter((e): e is Extract<SectorEvent, { type: T }> => e.type === type);
const totals = (...lists: readonly (readonly { readonly resource: string; readonly amount: number }[])[]): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const l of lists) for (const e of l) m[e.resource] = (m[e.resource] ?? 0) + e.amount;
  return m;
};
/** The sector save the shell passes on entry (surveyed, so every POI is known in these tests). */
const saveOf = (p: FreeRoamProfile, sys: string): SectorSave => ({ ...(p.sectors[sys] ?? { done: [] }), surveyed: true });
/** The shell's bookkeeping: every collection event into the profile (the same function freeRoamMode uses). */
function persistAll(p: FreeRoamProfile, sys: string, ev: readonly SectorEvent[]): FreeRoamProfile {
  for (const e of ev) if (e.type === 'collected' || e.type === 'looted' || e.type === 'picked' || e.type === 'recovered' || e.type === 'encounter') p = applyCollection(p, sys, e as CollectionEvent);
  return p;
}
const roundTrip = (p: FreeRoamProfile): FreeRoamProfile => {
  const store = new MemoryStore();
  saveProfile(store, p);
  return loadProfile(store).data;
};

/* ----------------------------------------------------------- the offer */
describe('full hold: the pilot decides, nothing vanishes', () => {
  it('salvage that does not fit: TAKE WHAT FITS takes the most valuable units; the rest stays, without nagging', () => {
    const m = mid(SOL);
    const salvage = poiLike('salvage', { id: 'salvage-1', x: m.x, y: m.y, loot: [{ resource: 'scrap', amount: 3 }, { resource: 'crystal', amount: 3 }] });
    const L = open(SOL, [salvage]);
    const r = createSectorRun(L, SURVEYED, { seed: 3, cargoSpace: 4 });
    const first = fly(r, 1, m);
    expect(first).toContainEqual({ type: 'holdFull', id: 'salvage-1', need: 6, space: 4 });
    expect(r.offer).toMatchObject({ id: 'salvage-1', kind: 'poi', need: 6, space: 4 });
    // flight goes on while the offer is open; no repeat notice
    expect(of(fly(r, 20, m), 'holdFull')).toHaveLength(0);
    const got = takeOffer(r);
    const c = of(got, 'collected');
    expect(c).toHaveLength(1);
    expect(totals(c[0]!.loot)).toEqual({ crystal: 3, scrap: 1 });
    expect(c[0]!.left).toEqual([{ resource: 'scrap', amount: 2 }]);
    expect(r.cargoSpace).toBe(0);
    expect(r.done.has('salvage-1')).toBe(false);
    expect(lootOf(r, salvage)).toEqual([{ resource: 'scrap', amount: 2 }]);
    // already decided: still hovering over it does not prompt again
    expect(of(fly(r, 30, m), 'holdFull')).toHaveLength(0);
    expect(r.offer).toBeNull();
    // a new approach asks again; LEAVE IT keeps it, quietly
    fly(r, 1, { x: m.x + 600, y: m.y });
    expect(of(fly(r, 1, m), 'holdFull')).toEqual([{ type: 'holdFull', id: 'salvage-1', need: 2, space: 0 }]);
    leaveOffer(r);
    expect(of(fly(r, 30, m), 'holdFull')).toHaveLength(0);
    expect(lootOf(r, salvage)).toEqual([{ resource: 'scrap', amount: 2 }]);
    // room made (jettison elsewhere) -> flying over takes it without a prompt
    r.cargoSpace = 2;
    expect(of(fly(r, 1, m), 'collected')).toEqual([{ type: 'collected', id: 'salvage-1', loot: [{ resource: 'scrap', amount: 2 }], left: [] }]);
    expect(r.done.has('salvage-1')).toBe(true);
    expect(of(fly(r, 60, m), 'collected')).toHaveLength(0);
  });

  it('TAKE WHAT FITS with no room at all takes nothing and keeps the offer state honest', () => {
    const m = mid(SOL);
    const cache = poiLike('cache', { id: 'cache-1', x: m.x, y: m.y, loot: [{ resource: 'alloy', amount: 4 }] });
    const r = createSectorRun(open(SOL, [cache]), SURVEYED, { seed: 3, cargoSpace: 0 });
    place(r, m.x + cache.solidR + r.tune.radius + 2, m.y);
    stepSector(r, idle);
    expect(interact(r)).toEqual([{ type: 'holdFull', id: 'cache-1', need: 4, space: 0 }]);
    expect(takeOffer(r)).toEqual([{ type: 'holdFull', id: 'cache-1', need: 4, space: 0 }]);
    expect(r.done.has('cache-1')).toBe(false);
    leaveOffer(r);
    // pressing INTERACT again asks again (a deliberate press is never ignored)
    expect(interact(r)).toEqual([{ type: 'holdFull', id: 'cache-1', need: 4, space: 0 }]);
  });

  it('SWAP: cheaper cargo is jettisoned as a pod (still collectable), the better find is taken', () => {
    const m = mid(SOL);
    const cache = poiLike('cache', { id: 'cache-1', x: m.x, y: m.y, loot: [{ resource: 'components', amount: 3 }] });
    const L = open(SOL, [cache]);
    const cap = 10;
    let profile = withCargo(EMPTY_PROFILE, { scrap: 10 });
    const r = createSectorRun(L, SURVEYED, { seed: 3, cargoSpace: cap - holdUnits(profile.cargo) });
    place(r, m.x + cache.solidR + r.tune.radius + 2, m.y);
    stepSector(r, idle);
    interact(r);
    expect(r.offer?.id).toBe('cache-1');
    // the shell: plan, remove from the hold, jettison, take
    const plan = planSwap(profile.cargo, r.offer!.loot, cap)!;
    expect(plan.jettison).toEqual([{ resource: 'scrap', amount: 3 }]);
    const jet = jettison(r, plan.jettison);
    expect(of(jet, 'jettisoned')).toHaveLength(1);
    profile = withCargo(profile, removeLoot(profile.cargo, plan.jettison)!);
    profile = persistAll(profile, L.systemId, takeOffer(r));
    expect(profile.cargo).toEqual({ scrap: 7, components: 3 });
    expect(r.done.has('cache-1')).toBe(true);
    // the scrap floats nearby as jettisoned cargo; nothing has vanished
    const pod = r.pickups.find((p) => p.kind === 'jettison')!;
    expect(pod.loot).toEqual([{ resource: 'scrap', amount: 3 }]);
    expect(holdUnits(profile.cargo) + lootUnits(pod.loot)).toBe(13);
  });

  it('a cargo wreck with a known manifest can be partly recovered; the rest stays in the wreck', () => {
    const L = open(SOL);
    const m = mid(L);
    let profile: FreeRoamProfile = { ...EMPTY_PROFILE, lostCargo: { systemId: L.systemId, x: m.x, y: m.y, cargo: { scrap: 4, alloy: 2 } } };
    const r = createSectorRun(L, SURVEYED, { seed: 5, cargoSpace: 3, cargoWreck: { x: m.x, y: m.y, units: 6, loot: [{ resource: 'scrap', amount: 4 }, { resource: 'alloy', amount: 2 }] } });
    expect(of(fly(r, 2, m), 'holdFull')).toEqual([{ type: 'holdFull', id: 'wreck', need: 6, space: 3 }]);
    const got = of(takeOffer(r), 'recovered');
    expect(got).toHaveLength(1);
    expect(totals(got[0]!.loot)).toEqual({ alloy: 2, scrap: 1 });
    expect(got[0]!.left).toEqual([{ resource: 'scrap', amount: 3 }]);
    expect(r.cargoWreck).toMatchObject({ units: 3 });
    profile = persistAll(profile, L.systemId, got);
    expect(profile.cargo).toEqual({ alloy: 2, scrap: 1 });
    expect(profile.lostCargo?.cargo).toEqual({ scrap: 3 });
    // the rest later
    r.cargoSpace = 5;
    fly(r, 1, { x: m.x + 500, y: m.y });
    profile = persistAll(profile, L.systemId, fly(r, 2, m));
    expect(profile.cargo).toEqual({ alloy: 2, scrap: 4 });
    expect(profile.lostCargo).toBeNull();
    expect(r.cargoWreck).toBeNull();
  });
});

/* ---------------------------------------------------- once and only once */
describe('stable ids: every find pays once', () => {
  it('repeated contact with a find that fits awards it once', () => {
    const m = mid(SOL);
    const salvage = poiLike('salvage', { id: 'salvage-2', x: m.x, y: m.y, loot: [{ resource: 'ice', amount: 2 }] });
    const r = createSectorRun(open(SOL, [salvage]), SURVEYED, { seed: 1 });
    const ev = fly(r, 120, m);
    expect(of(ev, 'collected')).toHaveLength(1);
    // replaying the event into the profile pays once too
    let p = persistAll(EMPTY_PROFILE, SOL.systemId, ev);
    p = persistAll(p, SOL.systemId, ev);
    expect(p.cargo).toEqual({ ice: 2 });
    expect(p.sectors[SOL.systemId]?.done).toEqual(['salvage-2']);
  });

  it('a partly taken container is saved with its remainder; re-entry offers only that; a done container never pays again', () => {
    const m = mid(SOL);
    const cache = poiLike('cache', { id: 'cache-1', x: m.x, y: m.y, loot: [{ resource: 'alloy', amount: 5 }, { resource: 'components', amount: 2 }] });
    const L = open(SOL, [cache]);
    const sys = L.systemId;
    const by = { x: m.x + cache.solidR + 20, y: m.y };
    // visit 1: 3 units of room
    const r1 = createSectorRun(L, SURVEYED, { seed: 1, cargoSpace: 3 });
    fly(r1, 1, by);
    interact(r1);
    const ev1 = interact(r1); // a second press takes what fits
    const looted = of(ev1, 'looted');
    expect(totals(looted[0]!.loot)).toEqual({ components: 2, alloy: 1 });
    let p = roundTrip(persistAll(EMPTY_PROFILE, sys, ev1));
    expect(p.sectors[sys]?.left).toEqual({ 'cache-1': { alloy: 4 } });
    // a replayed partial event pays nothing (its loot + left no longer match the save)
    expect(persistAll(p, sys, ev1)).toBe(p);
    // visit 2: only the remainder is there
    const r2 = createSectorRun(L, saveOf(p, sys), { seed: 2, cargoSpace: 50 });
    expect(lootOf(r2, cache)).toEqual([{ resource: 'alloy', amount: 4 }]);
    fly(r2, 1, by);
    const ev2 = interact(r2);
    expect(of(ev2, 'looted')).toMatchObject([{ id: 'cache-1', loot: [{ resource: 'alloy', amount: 4 }], left: [] }]);
    p = roundTrip(persistAll(p, sys, ev2));
    expect(p.cargo).toEqual({ alloy: 5, components: 2 }); // exactly the container, over two visits
    expect(p.sectors[sys]).toEqual({ done: ['cache-1'], surveyed: false }); // no leftovers kept
    // visit 3: done, nothing to take
    const r3 = createSectorRun(L, saveOf(p, sys), { seed: 3, cargoSpace: 50 });
    fly(r3, 1, by);
    expect(interact(r3)).toEqual([]);
    expect(persistAll(p, sys, ev2)).toBe(p);
  });
});

/* ------------------------------------------------------ reward caches */
function siteLayout(kind: EncounterSite['kind']): { L: SectorLayout; s: EncounterSite } {
  for (const L of ALL) {
    const s = L.sites.find((x) => x.kind === kind && lootUnits(x.loot) >= 3);
    if (s) return { L: { ...L, patrols: [], hazards: [], sites: [s], landmarks: [], regions: [] }, s };
  }
  throw new Error(`no ${kind} site`);
}

describe('encounter rewards that do not fit', () => {
  it('the overflow floats as a reward cache <encounter>.1, saved, collected once on any later visit', () => {
    const { L, s } = siteLayout('ambush');
    const sys = L.systemId;
    const r = createSectorRun(L, SURVEYED, { seed: 61, cargoSpace: 1 });
    r.grace = 0;
    r.invuln = 1e9;
    const ev = fly(r, COMBAT.ambushWarnTicks + 3, s);
    for (const h of r.hostiles.filter((x) => x.source === s.id)) damageAgent(r, h, 1e6, 'player', []);
    ev.push(...fly(r, 3, s));
    const cleared = of(ev, 'encounter').filter((e) => e.state === 'cleared');
    expect(cleared).toHaveLength(1);
    expect(lootUnits(cleared[0]!.loot)).toBe(1);
    expect(totals(cleared[0]!.loot, cleared[0]!.left)).toEqual(totals(s.loot)); // nothing lost
    const cache = r.pickups.find((p) => p.id === cacheId(s.id))!;
    expect(cache).toMatchObject({ kind: 'cache', persistent: true });
    expect(cacheId(s.id)).toBe(rewardCacheId(s.id));
    let p = roundTrip(persistAll(EMPTY_PROFILE, sys, ev));
    expect(p.sectors[sys]?.done).toContain(s.id);
    expect(p.sectors[sys]?.left?.[cacheId(s.id)]).toEqual(totals(cleared[0]!.left));
    // re-entry: the encounter does not restart, the cache is back
    const r2 = createSectorRun(L, saveOf(p, sys), { seed: 7, cargoSpace: 99 });
    expect(r2.encounters.find((e) => e.id === s.id)?.state ?? 'done').toBe('done');
    const c2 = r2.pickups.find((q) => q.id === cacheId(s.id))!;
    expect(c2).toBeDefined();
    const got = fly(r2, 2, { x: c2.x, y: c2.y });
    expect(of(got, 'picked')).toMatchObject([{ id: cacheId(s.id), kind: 'cache', persistent: true, left: [] }]);
    p = roundTrip(persistAll(p, sys, got));
    expect(totals(Object.entries(p.cargo).map(([resource, amount]) => ({ resource, amount })))).toEqual(totals(s.loot));
    expect(p.sectors[sys]?.done).toContain(cacheId(s.id));
    // and it is gone for good
    expect(createSectorRun(L, saveOf(p, sys), { seed: 8 }).pickups).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- mining */
function veinLayout(): { L: SectorLayout; v: SectorLayout['veins'][number] } {
  const src = ALL.find((L) => L.veins.some((v) => v.chips.length >= 3))!;
  const v = src.veins.find((x) => x.chips.length >= 3)!;
  return { L: open(src, src.pois.filter((p) => p.kind === 'exit'), { rocks: [src.rocks[v.rock]!], veins: [{ ...v, rock: 0 }] }), v: { ...v, rock: 0 } };
}

const FIRE: SectorInput = { moveX: 0, moveY: 0, fire: true };
/** Fly over every floating ore fragment. */
function collectOre(r: SectorRun): SectorEvent[] {
  const out: SectorEvent[] = [];
  for (const q of r.pickups.filter((x) => x.kind === 'ore')) out.push(...fly(r, 2, { x: q.x, y: q.y }));
  return out;
}

describe('marked ore veins', () => {
  it('every third hit chips one fragment; each chip is collected once; the vein depletes and stays depleted', () => {
    const { L, v } = veinLayout();
    const sys = L.systemId;
    const r = createSectorRun(L, SURVEYED, { seed: 9 });
    const at = { x: v.x, y: v.y + v.r + 110 };
    r.ship.heading = 0; // nose up, at the rock
    const ev = fly(r, 900, at, FIRE);
    const chips = of(ev, 'chipped');
    // the fragments float loose near the rock; the pilot flies over them
    expect(r.pickups.filter((q) => q.kind === 'ore')).toHaveLength(v.chips.length);
    ev.push(...collectOre(r));
    expect(chips.map((c) => c.id)).toEqual(v.chips.map((_, i) => chipId(v, i + 1)));
    expect(of(ev, 'veinHit')).toHaveLength(v.chips.length * (MINING.hitsPerChip - 1));
    const picked = of(ev, 'picked');
    expect(picked.map((x) => x.id).sort()).toEqual(chips.map((c) => c.id).sort()); // each fragment once
    expect(totals(...picked.map((x) => x.loot))).toEqual(totals(...v.chips));
    expect(chipsLeft(r, v)).toBe(0);
    const p = roundTrip(persistAll(EMPTY_PROFILE, sys, ev));
    expect(p.sectors[sys]?.done).toEqual(expect.arrayContaining(chips.map((c) => c.id)));
    // depleted for good: shooting it on a later visit chips nothing
    const r2 = createSectorRun(L, saveOf(p, sys), { seed: 10 });
    r2.ship.heading = 0;
    expect(chipsLeft(r2, v)).toBe(0);
    const again = fly(r2, 300, at, FIRE);
    expect(of(again, 'chipped')).toHaveLength(0);
    expect(of(again, 'veinHit')).toHaveLength(0);
  });

  it('a fragment that does not fit floats; its remainder is saved and chipped again later, never doubled', () => {
    const { L, v } = veinLayout();
    const sys = L.systemId;
    const big = v.chips.findIndex((c) => lootUnits(c) >= 2);
    expect(big).toBeGreaterThanOrEqual(0);
    // earlier chips already collected
    const before = v.chips.slice(0, big).map((_, i) => chipId(v, i + 1));
    let p = withSectorProgress(EMPTY_PROFILE, sys, before, true);
    const r = createSectorRun(L, saveOf(p, sys), { seed: 11, cargoSpace: 1 });
    const at = { x: v.x, y: v.y + v.r + 110 };
    r.ship.heading = 0;
    const ev: SectorEvent[] = [];
    for (let t = 0; t < 600 && !r.pickups.length; t++) ev.push(...fly(r, 1, at, FIRE));
    const frag = r.pickups[0]!;
    expect(frag.id).toBe(chipId(v, big + 1));
    ev.push(...fly(r, 1, { x: frag.x, y: frag.y }));
    expect(r.offer?.id).toBe(frag.id);
    ev.push(...takeOffer(r));
    const part = of(ev, 'picked')[0]!;
    expect(lootUnits(part.loot)).toBe(1);
    // still floating, lighter; shooting the rock does not chip it again meanwhile
    expect(r.pickups.find((q) => q.id === part.id)?.loot).toEqual(part.left);
    expect(of(fly(r, 300, at, FIRE), 'chipped').map((c) => c.id)).not.toContain(part.id);
    p = roundTrip(persistAll(p, sys, ev));
    expect(p.sectors[sys]?.left?.[part.id]).toEqual(totals(part.left));
    // next visit: the chip comes loose again with only its remainder
    const r2 = createSectorRun(L, saveOf(p, sys), { seed: 12 });
    r2.ship.heading = 0;
    const ev2 = fly(r2, 60, at, FIRE);
    expect(of(ev2, 'chipped')[0]?.id).toBe(part.id);
    ev2.push(...collectOre(r2));
    const again = of(ev2, 'picked').find((x) => x.id === part.id)!;
    expect(again.loot).toEqual(part.left);
    p = persistAll(p, sys, ev2);
    expect(totals(Object.entries(p.cargo).map(([resource, amount]) => ({ resource, amount })))).toMatchObject(totals(v.chips[big]!));
  });
});

/* ------------------------------------------------------------ kill drops */
describe('salvage pods from kills (capped)', () => {
  const kill = (hostile: number, over: Partial<Parameters<typeof killDrop>[1]> = {}) => ({ hostile, family: 'capital' as const, faction: 'red-tally' as const, by: 'player' as const, role: 'guard' as const, x: 300 + (hostile % 8) * 400, y: 300 + Math.floor(hostile / 8) * 400, ...over });
  const arena = (d: number): SectorLayout => open(ALL.find((L) => L.difficulty === d && L.threat > 0)!, []);

  it('player kills only, one roll per ship, never launched craft, at most the visit budget', () => {
    const L = arena(3);
    const r = createSectorRun(L, SURVEYED, { seed: 4 });
    expect(r.dropBudget).toBe(dropBudget(3));
    const ev: SectorEvent[] = [];
    killDrop(r, kill(1, { by: 'npc' }), ev);
    killDrop(r, kill(2, { role: 'launched' }), ev);
    expect(ev).toEqual([]);
    for (let i = 10; i < 60; i++) {
      killDrop(r, kill(i), ev);
      killDrop(r, kill(i), ev); // the same ship again: no second roll
    }
    expect(of(ev, 'dropped')).toHaveLength(dropBudget(3)); // capital: chance 1, so exactly the budget
    expect(new Set(of(ev, 'dropped').map((e) => e.id)).size).toBe(dropBudget(3));
    expect(r.dropBudget).toBe(0);
    // a calm sector has no kill-drop budget at all
    expect(initialDropBudget({ ...L, threat: 0 })).toBe(0);
  });

  it('drop odds follow the central table, seeded and reproducible', () => {
    const L = arena(2);
    const count = (seed: number): { n: number; loot: string } => {
      const r = createSectorRun(L, SURVEYED, { seed });
      r.dropBudget = 1e9;
      const ev: SectorEvent[] = [];
      const loot: string[] = [];
      for (let i = 0; i < 400; i++) {
        killDrop(r, kill(i, { family: 'raider' }), ev);
        loot.push(...r.pickups.map((p) => JSON.stringify(p.loot)));
        r.pickups.length = 0; // collected; keeps the bounded list from refusing pods
      }
      return { n: of(ev, 'dropped').length, loot: loot.join('|') };
    };
    const a = count(21);
    expect(count(21)).toEqual(a);
    expect(Math.abs(a.n / 400 - KILL_DROPS.chance.raider)).toBeLessThan(0.08);
  });

  it('a pod is collected once by flying over it, or expires with an event (marked, not silent)', () => {
    const L = arena(2);
    const r = createSectorRun(L, SURVEYED, { seed: 4 });
    const ev: SectorEvent[] = [];
    killDrop(r, kill(1), ev);
    killDrop(r, kill(2), ev);
    const [a, b] = r.pickups;
    expect(a!.life).toBe(KILL_DROPS.lifeTicks);
    const got = fly(r, 30, { x: a!.x, y: a!.y });
    expect(of(got, 'picked').filter((e) => e.id === a!.id)).toHaveLength(1);
    const p = persistAll(EMPTY_PROFILE, L.systemId, got);
    expect(holdUnits(p.cargo)).toBe(lootUnits(of(got, 'picked')[0]!.loot));
    expect(p.sectors[L.systemId]).toBeUndefined(); // temporary: no id saved
    const later = fly(r, KILL_DROPS.lifeTicks + 5, { x: 100, y: 100 });
    expect(of(later, 'expired')).toEqual([{ type: 'expired', id: b!.id, kind: 'pod' }]);
    expect(r.pickups).toHaveLength(0);
  });

  it('in flight: a ship the pilot shoots down rolls its pod once', () => {
    const L = arena(2);
    const r = createSectorRun(L, SURVEYED, { seed: 31 });
    r.grace = 0;
    r.invuln = 1e9;
    const P = { x: L.width / 2, y: L.height / 2 };
    const a = spawnAgent(r, 'hauler', 'red-tally', 'test', 'guard', P.x, P.y - 140)!;
    a.hull = 1;
    a.shield = 0;
    r.ship.heading = 0;
    const ev: SectorEvent[] = [];
    for (let t = 0; t < 240 && a.state !== 'destroyed'; t++) {
      Object.assign(a, { x: P.x, y: P.y - 140, vx: 0, vy: 0 });
      ev.push(...fly(r, 1, P, { moveX: 0, moveY: 0, fire: true }));
    }
    expect(of(ev, 'destroyed').filter((e) => e.by === 'player')).toHaveLength(1);
    expect(r.dropRolled.has(a.id)).toBe(true);
    expect(of(ev, 'dropped').length).toBeLessThanOrEqual(1);
  });
});

/* -------------------------------------------------------------- jettison */
describe('jettisoned cargo', () => {
  it('floats behind the ship, is not scooped straight back up, and can be picked up after leaving its reach', () => {
    const L = open(SOL);
    const m = mid(L);
    const r = createSectorRun(L, SURVEYED, { seed: 2, cargoSpace: 0 });
    place(r, m.x, m.y);
    expect(jettison(r, [{ resource: 'scrap', amount: -2 }])).toEqual([]);
    expect(jettison(r, [{ resource: 'mystery', amount: 2 } as unknown as LootEntry])).toEqual([]);
    const ev = jettison(r, [{ resource: 'scrap', amount: 3 }]);
    expect(of(ev, 'jettisoned')).toEqual([{ type: 'jettisoned', id: 'jet-1', units: 3 }]);
    expect(r.cargoSpace).toBe(3);
    const pod = r.pickups[0]!;
    expect(pod).toMatchObject({ kind: 'jettison', armed: false, life: JETTISON_LIFE_TICKS });
    expect(of(fly(r, 60, { x: pod.x, y: pod.y }), 'picked')).toHaveLength(0);
    fly(r, 1, { x: m.x + 400, y: m.y });
    expect(pod.armed).toBe(true);
    expect(of(fly(r, 2, { x: pod.x, y: pod.y }), 'picked')).toMatchObject([{ id: 'jet-1', kind: 'jettison', persistent: false, loot: [{ resource: 'scrap', amount: 3 }] }]);
    expect(r.cargoSpace).toBe(0);
  });

  it('floating pickups are bounded; nothing already floating is evicted and a refused jettison keeps the cargo', () => {
    const L = open(SOL);
    const r = createSectorRun(L, SURVEYED, { seed: 2, cargoSpace: 0 });
    for (let i = 0; i < MAX_PICKUPS; i++) expect(jettison(r, [{ resource: 'scrap', amount: 1 }])).toHaveLength(1);
    const ids = r.pickups.map((p) => p.id);
    expect(jettison(r, [{ resource: 'scrap', amount: 1 }])).toEqual([]);
    expect(r.cargoSpace).toBe(MAX_PICKUPS); // the refused unit was never counted out of the hold
    r.dropBudget = 9;
    const ev: SectorEvent[] = [];
    killDrop(r, { hostile: 1, family: 'capital', faction: 'red-tally', by: 'player', role: 'guard', x: 10, y: 10 }, ev);
    expect(ev).toEqual([]);
    expect(r.pickups.map((p) => p.id)).toEqual(ids);
  });
});

/* ------------------------------------------------------------ acceptance */
describe('acceptance: loot changes what the ship can do', () => {
  it('collect salvage in Sol and Alpha Centauri, fabricate a Salvage Rig, fit it: the hold grows and carries more', () => {
    const petrel = SHIP_BY_ID.get('petrel')!;
    let p = EMPTY_PROFILE;
    let cap = deriveStats(petrel, petrel.stock).cargo;
    for (const id of ['milky-way/sol', 'milky-way/alpha-centauri']) {
      const src = gen(id);
      const L: SectorLayout = { ...src, patrols: [], sites: [], hazards: [] };
      const r = createSectorRun(L, SURVEYED, { seed: 1, ship: deriveShip('petrel'), cargoSpace: cap - holdUnits(p.cargo) });
      for (const poi of L.pois) {
        if (poi.kind === 'salvage') p = persistAll(p, id, fly(r, 1, poi));
        else if (poi.kind === 'cache' || poi.kind === 'derelict' || poi.kind === 'anomaly') {
          fly(r, 1, { x: poi.x + poi.solidR + r.tune.radius + 2, y: poi.y });
          r.focus = poi.id;
          p = persistAll(p, id, interact(r));
        }
      }
      expect(holdUnits(p.cargo)).toBeLessThanOrEqual(cap);
    }
    p = roundTrip(p);
    const made = fabricate(p.cargo, p.modules, 'salvage-rig');
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    p = withModules(withCargo(p, made.hold), made.modules);
    const fit = fitFromStorage(petrel, petrel.stock, p.modules, p.cargo, 'cargo', 0, 'salvage-rig');
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    const bigger = deriveStats(petrel, fit.loadout).cargo;
    expect(bigger).toBe(cap + 20);
    expect(fit.modules).toEqual({ 'cargo-pod': 1 }); // the old pod is stored, not destroyed
    // the bigger hold really takes more: a find that did not fit before now fits
    const free = cap - holdUnits(p.cargo);
    const m = mid(SOL);
    const find = poiLike('salvage', { id: 'salvage-1', x: m.x, y: m.y, loot: [{ resource: 'scrap', amount: free + 10 }] });
    const before = createSectorRun(open(SOL, [find]), SURVEYED, { seed: 1, cargoSpace: free });
    expect(of(fly(before, 1, m), 'holdFull')).toHaveLength(1);
    cap = bigger;
    const after = createSectorRun(open(SOL, [find]), SURVEYED, { seed: 1, cargoSpace: cap - holdUnits(p.cargo) });
    expect(of(fly(after, 1, m), 'collected')).toHaveLength(1);
  });
});
