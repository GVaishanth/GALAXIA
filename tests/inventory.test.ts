/**
 * Free Roam Prompt 10: resource catalogue, central loot tables, inventory
 * rules (stacking, capacity, partial takes, swap, invalid quantities), the
 * fabricator and module fitting, milestones, profile v8 and the persistence
 * interface. Pure; deterministic seeds only.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { FACTION_IDS, RESOURCE_IDS, type ResourceId } from '../src/modes/freeroam/catalogue/types.ts';
import { FAMILY_IDS } from '../src/modes/freeroam/combat/families.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { fabricate, fitFromStorage, missingResources, RECIPES, storageRoom } from '../src/modes/freeroam/inventory/fabricator.ts';
import { ICON_SIZE, MODULE_ICONS, RESOURCE_ICONS } from '../src/modes/freeroam/inventory/icons.ts';
import { addLoot, categoryCounts, freeSpace, holdUnits, inventoryRows, MAX_MODULE_COUNT, MAX_STORED_MODULES, normalizeLoot, planSwap, planTake, removeLoot, storeModule, takeModule, unknownCargo, validQty } from '../src/modes/freeroam/inventory/inventory.ts';
import { commonPicks, FACTION_LOOT_BIAS, FAMILY_LOOT_BIAS, KILL_DROPS, LOOT_TABLE_IDS, LOOT_TABLES, missionReward, RARE_CAP, rareChanceOf, rarePool, rollKillDrop, rollLoot, type LootContext } from '../src/modes/freeroam/inventory/lootTables.ts';
import { claimableMilestones, MILESTONES, milestoneState } from '../src/modes/freeroam/inventory/milestones.ts';
import { applySnapshot, deserializeSnapshot, memoryRepository, parseSnapshot, profileRepository, serializeSnapshot, snapshotOf } from '../src/modes/freeroam/inventory/persistence.ts';
import { CATEGORY_INFO, LOOT_SOURCES, RARE_IDS, RESOURCE_CATEGORIES, RESOURCE_LIST, RESOURCES, type LootSource } from '../src/modes/freeroam/inventory/resources.ts';
import { EMPTY_PROFILE, FREEROAM_VERSION, loadProfile, saveProfile, withLeftLoot, withMilestone, withModules, withSectorProgress } from '../src/modes/freeroam/profile.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { RARE_RESOURCES } from '../src/modes/freeroam/sector/model.ts';
import { validateSector } from '../src/modes/freeroam/sector/validate.ts';
import { deriveStats, EQUIPMENT_BY_ID } from '../src/modes/freeroam/ships/equipment.ts';
import { SHIP_BY_ID, SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const catalogue = getCatalogue();
const graph = buildNavGraph();
const ctx = (difficulty: number, primary: ResourceId | null = 'scrap', secondary: ResourceId | null = 'alloy', richness = 1): LootContext => ({ difficulty, richness, primary, secondary });
const bySort = (l: readonly { resource: string; amount: number }[]): string[] => l.map((e) => `${e.resource}:${e.amount}`).sort();
const SYSTEM_RESOURCES = new Set<ResourceId>(catalogue.systems.flatMap((s) => [s.resources.primary, ...(s.resources.secondary ? [s.resources.secondary] : [])]));

/* ------------------------------------------------------------ catalogue */
describe('resource catalogue', () => {
  it('defines every saved resource id once, with valid fields', () => {
    expect(RESOURCE_LIST.map((r) => r.id)).toEqual([...RESOURCE_IDS]);
    for (const r of RESOURCE_LIST) {
      expect(r.name.length, r.id).toBeGreaterThan(2);
      expect(r.short.length, r.id).toBeLessThanOrEqual(10);
      expect(r.description.length, r.id).toBeGreaterThan(30);
      expect(RESOURCE_CATEGORIES).toContain(r.category);
      expect(Number.isInteger(r.stack) && r.stack >= 1 && r.stack <= 99, r.id).toBe(true);
      expect(Number.isInteger(r.value) && r.value >= 1 && r.value <= 100, r.id).toBe(true);
      expect(r.sources.length, r.id).toBeGreaterThan(0);
      expect(new Set(r.sources).size).toBe(r.sources.length);
    }
    // the eight categories the design asks for are all used
    expect(new Set(RESOURCE_LIST.map((r) => r.category))).toEqual(new Set(RESOURCE_CATEGORIES));
    expect(Object.keys(CATEGORY_INFO)).toEqual([...RESOURCE_CATEGORIES]);
    // the old Prompt 4-9 ids keep their place (saved profiles refer to them)
    expect(RESOURCE_IDS.slice(0, 8)).toEqual(['scrap', 'alloy', 'circuits', 'fuel', 'ice', 'crystal', 'core-shard', 'relic']);
  });

  it('presents fictional resources as game fiction, never as real science', () => {
    for (const r of RESOURCE_LIST) expect(`${r.name} ${r.description}`, r.id).not.toMatch(/\b(discover(?:ed|y)|scientists?|NASA|ESA|real(?:-world)? (?:material|mineral|element|sample)|element \d+|isotope)\b/i);
    // the invented ones say so
    expect(RESOURCES.crystal.description).toMatch(/game-invented/i);
    expect(RESOURCES.relic.description).toMatch(/invented for GALAXIA/i);
  });

  it('rare resources are the same set everywhere and rank above every common one', () => {
    expect([...RARE_IDS].sort()).toEqual([...RARE_RESOURCES].sort());
    const minRare = Math.min(...RARE_IDS.map((id) => RESOURCES[id].value));
    for (const r of RESOURCE_LIST) if (r.rarity !== 'rare') expect(r.value, r.id).toBeLessThan(minRare);
  });

  it('acquisition sources match what the loot tables, veins and milestones can actually produce', () => {
    const produced = new Map<LootSource, Set<ResourceId>>(LOOT_SOURCES.map((s) => [s, new Set<ResourceId>()]));
    for (const id of LOOT_TABLE_IDS) {
      const t = LOOT_TABLES[id];
      const set = produced.get(t.source)!;
      for (const p of t.picks) {
        if (p.item === 'primary' || p.item === 'secondary') for (const r of SYSTEM_RESOURCES) (RARE_IDS.includes(r) ? null : set.add(r));
        else set.add(p.item);
      }
      for (const r of t.rare) set.add(r.item);
      if (id === 'enemy') for (const b of [...Object.values(FACTION_LOOT_BIAS), ...Object.values(FAMILY_LOOT_BIAS)]) for (const r of Object.keys(b ?? {}) as ResourceId[]) set.add(r);
    }
    for (const m of MILESTONES) for (const e of m.loot) produced.get('milestone')!.add(e.resource);
    for (const r of RESOURCE_LIST) {
      const want = LOOT_SOURCES.filter((s) => produced.get(s)!.has(r.id));
      expect([...r.sources].sort(), r.id).toEqual([...want].sort());
    }
  });

  it('permitted uses match the fabricator recipes and ship licence prices', () => {
    const fab = new Set(RECIPES.flatMap((r) => r.cost.map((c) => c.resource)));
    const lic = new Set(SHIPS.flatMap((s) => s.cost.map((c) => c.resource)));
    for (const r of RESOURCE_LIST) {
      expect(r.uses.includes('fabrication'), r.id).toBe(fab.has(r.id));
      expect(r.uses.includes('licence'), r.id).toBe(lic.has(r.id));
    }
    // every resource is good for something (loot is never decorative)
    for (const r of RESOURCE_LIST) expect(r.uses.length, r.id).toBeGreaterThan(0);
  });

  it('every icon is a valid 12x12 grid, with a distinct silhouette per resource and slot type', () => {
    const all = [...Object.entries(RESOURCE_ICONS), ...Object.entries(MODULE_ICONS)];
    expect(Object.keys(RESOURCE_ICONS).sort()).toEqual([...RESOURCE_IDS].sort());
    for (const [id, art] of all) {
      expect(art.grid.length, id).toBe(ICON_SIZE);
      for (const row of art.grid) expect(row, id).toMatch(/^[.abcd]{12}$/);
      for (const c of Object.values(art.colors)) expect(c, id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(art.grid.join('').replace(/\./g, '').length, `${id} is visible`).toBeGreaterThan(24);
    }
    // shapes (ignoring colour) are all different
    const masks = all.map(([, a]) => a.grid.map((r) => r.replace(/[abcd]/g, '#')).join('/'));
    expect(new Set(masks).size).toBe(all.length);
  });
});

/* ---------------------------------------------------------------- tables */
describe('central loot tables', () => {
  it('are well formed: positive weights, valid amounts, rare chances capped below one half and 0 at difficulty 1', () => {
    for (const id of LOOT_TABLE_IDS) {
      const t = LOOT_TABLES[id];
      expect(t.rolls[0]).toBeGreaterThanOrEqual(0);
      expect(t.rolls[1]).toBeGreaterThanOrEqual(t.rolls[0]);
      for (const p of t.picks) {
        expect(p.weight, id).toBeGreaterThan(0);
        expect(p.amount[0]).toBeGreaterThanOrEqual(1);
        expect(p.amount[1]).toBeGreaterThanOrEqual(p.amount[0]);
      }
      expect(t.rareCap).toBeLessThanOrEqual(RARE_CAP);
      expect(RARE_CAP).toBeLessThan(0.5);
      for (const rich of [null, 'core-shard', 'relic'] as const) {
        expect(rareChanceOf(t, ctx(1, rich ?? 'scrap')), id).toBe(0);
        for (let d = 1; d <= 5; d++) expect(rareChanceOf(t, ctx(d, rich ?? 'scrap'))).toBeLessThanOrEqual(Math.min(t.rareCap, RARE_CAP));
      }
    }
    // relics need deep space unless the sector is relic-rich
    expect(rarePool(LOOT_TABLES.container, ctx(3)).map(([r]) => r)).toEqual(['core-shard']);
    expect(rarePool(LOOT_TABLES.container, ctx(4)).map(([r]) => r)).toEqual(['core-shard', 'relic']);
    expect(rarePool(LOOT_TABLES.container, ctx(2, 'relic')).map(([r]) => r)).toEqual(['core-shard', 'relic']);
    // a rare token is never a common pick
    expect(commonPicks(LOOT_TABLES.container, ctx(3, 'core-shard')).map(([x]) => x.id)).not.toContain('core-shard');
  });

  it('rolls are deterministic per seed, merged, ordered, integer and within 1..99', () => {
    for (const id of LOOT_TABLE_IDS) {
      for (let seed = 1; seed <= 40; seed++) {
        const a = rollLoot(id, createRng(seed), ctx(1 + (seed % 5), 'alloy', 'ice', 1 + (seed % 3)));
        const b = rollLoot(id, createRng(seed), ctx(1 + (seed % 5), 'alloy', 'ice', 1 + (seed % 3)));
        expect(a).toEqual(b);
        expect(a.map((e) => e.resource)).toEqual(RESOURCE_IDS.filter((r) => a.some((e) => e.resource === r)));
        for (const e of a) expect(Number.isInteger(e.amount) && e.amount >= 1 && e.amount <= 99).toBe(true);
      }
    }
  });

  it('rare drops follow their configured probability (Monte Carlo, seeded) and never appear at difficulty 1', () => {
    const N = 20000;
    for (const [id, d] of [['enemy', 5], ['container', 3], ['outpost', 4], ['capital', 5]] as const) {
      const t = LOOT_TABLES[id];
      const p = rareChanceOf(t, ctx(d));
      const rng = createRng(1234 + d);
      let withRare = 0;
      for (let i = 0; i < N; i++) if (rollLoot(id, rng, ctx(d)).some((e) => RARE_IDS.includes(e.resource))) withRare += 1;
      // P(at least one rare) = average over the roll count n of 1 - (1 - p)^n
      let expected = 0;
      for (let n = t.rolls[0]; n <= t.rolls[1]; n++) expected += 1 - (1 - p) ** n;
      expected /= t.rolls[1] - t.rolls[0] + 1;
      expect(Math.abs(withRare / N - expected), `${id} d${d}: ${withRare / N} vs ${expected}`).toBeLessThan(0.012);
      expect(withRare).toBeLessThan(N); // never guaranteed
    }
    const rng = createRng(9);
    for (const id of LOOT_TABLE_IDS) for (let i = 0; i < 500; i++) expect(rollLoot(id, rng, ctx(1, 'core-shard', 'relic')).some((e) => RARE_IDS.includes(e.resource)), id).toBe(false);
  });

  it('enemy salvage pods carry faction flavour, follow the family odds, and mission rewards are ready', () => {
    for (const f of FAMILY_IDS) {
      expect(KILL_DROPS.chance[f]).toBeGreaterThan(0);
      expect(KILL_DROPS.chance[f]).toBeLessThanOrEqual(1);
    }
    const count = (faction: (typeof FACTION_IDS)[number], res: ResourceId): number => {
      const rng = createRng(77);
      let n = 0;
      for (let i = 0; i < 4000; i++) n += rollKillDrop(rng, ctx(3), 'raider', faction).find((e) => e.resource === res)?.amount ?? 0;
      return n;
    };
    expect(count('tessellate', 'circuits')).toBeGreaterThan(count('red-tally', 'circuits') * 2);
    expect(count('red-tally', 'fuel')).toBeGreaterThan(count('tessellate', 'fuel'));
    expect(missionReward(createRng(5), ctx(2)).length).toBeGreaterThan(0);
  });

  it('every generated sector: loot valid, no rares at difficulty 1, ore veins on real rocks with stable ids', () => {
    let veins = 0;
    for (const s of catalogue.systems) {
      const L = generateSector(s, sectorContext(graph, s.id));
      expect(validateSector(L, s, sectorContext(graph, s.id)), s.id).toEqual([]);
      expect(L.resources).toEqual({ primary: s.resources.primary, secondary: s.resources.secondary, richness: s.resources.richness });
      for (const v of L.veins) {
        expect(L.rocks[v.rock]).toMatchObject({ x: v.x, y: v.y, r: v.r });
        for (const c of v.chips) for (const e of c) expect(RARE_IDS).not.toContain(e.resource);
      }
      veins += L.veins.length;
      // regenerating gives the same veins
      expect(generateSector(s, sectorContext(graph, s.id)).veins).toEqual(L.veins);
    }
    expect(veins).toBeGreaterThan(catalogue.systems.length); // mining is common, not decorative
  });
});

/* ------------------------------------------------------------- inventory */
describe('inventory rules', () => {
  it('drops invalid quantities and unknown ids; merges duplicates', () => {
    for (const bad of [0, -3, 1.5, NaN, Infinity, -Infinity, 1e12, '4' as unknown as number]) expect(validQty(bad), String(bad)).toBe(false);
    expect(normalizeLoot([{ resource: 'scrap', amount: 2 }, { resource: 'scrap', amount: 3 }, { resource: 'alloy', amount: -1 }, { resource: 'unobtainium', amount: 4 }, { resource: 'fuel', amount: 0.5 }, { resource: 'ice', amount: NaN }])).toEqual([{ resource: 'scrap', amount: 5 }]);
    expect(holdUnits({ scrap: 4, alloy: -2, fuel: 1.5, ice: 3 })).toBe(7);
  });

  it('stacks by the resource stack size and reports rows sorted and filtered', () => {
    const hold = { scrap: 120, crystal: 20, relic: 1, components: 7 };
    const rows = inventoryRows(hold, 200);
    expect(rows.map((r) => r.def.id)).toEqual(['scrap', 'relic', 'crystal', 'components'].sort((a, b) => RESOURCE_CATEGORIES.indexOf(RESOURCES[a as ResourceId].category) - RESOURCE_CATEGORIES.indexOf(RESOURCES[b as ResourceId].category)));
    const scrap = rows.find((r) => r.def.id === 'scrap')!;
    expect(scrap.stacks).toBe(3); // 50 + 50 + 20
    expect(scrap.lastStack).toBe(20);
    expect(rows.find((r) => r.def.id === 'crystal')!).toMatchObject({ stacks: 1, lastStack: 20 });
    expect(inventoryRows(hold, 200, 'value').map((r) => r.def.id)).toEqual(['relic', 'components', 'crystal', 'scrap']);
    expect(inventoryRows(hold, 200, 'amount').map((r) => r.def.id)[0]).toBe('scrap');
    expect(inventoryRows(hold, 200, 'name').map((r) => r.def.name)).toEqual([...rows.map((r) => r.def.name)].sort((a, b) => a.localeCompare(b)));
    expect(inventoryRows(hold, 200, 'category', 'artefacts').map((r) => r.def.id)).toEqual(['relic']);
    expect(categoryCounts(hold)).toMatchObject({ alloys: 120, crystals: 20, artefacts: 1, components: 7, reactor: 0 });
    expect(unknownCargo({ scrap: 1, mystery: 4 })).toEqual(['mystery']);
  });

  it('never exceeds the capacity: the rest comes back, most valuable units taken first', () => {
    const r = addLoot({ scrap: 75 }, [{ resource: 'scrap', amount: 4 }, { resource: 'crystal', amount: 3 }, { resource: 'core-shard', amount: 1 }], 80);
    expect(holdUnits(r.hold)).toBe(80);
    expect(r.taken.find((e) => e.resource === 'core-shard')?.amount).toBe(1);
    expect(r.taken.find((e) => e.resource === 'crystal')?.amount).toBe(3);
    expect(r.taken.find((e) => e.resource === 'scrap')?.amount).toBe(1);
    expect(r.left).toEqual([{ resource: 'scrap', amount: 3 }]);
    // taken + left = the original find (nothing vanishes, nothing is duplicated)
    const sum = (l: readonly { resource: string; amount: number }[], id: string): number => l.filter((e) => e.resource === id).reduce((n, e) => n + e.amount, 0);
    for (const id of ['scrap', 'crystal', 'core-shard']) expect(sum(r.taken, id) + sum(r.left, id)).toBe(id === 'scrap' ? 4 : id === 'crystal' ? 3 : 1);
    // a hold already over capacity keeps everything and takes nothing
    const over = addLoot({ scrap: 90 }, [{ resource: 'alloy', amount: 2 }], 80);
    expect(over.hold).toEqual({ scrap: 90 });
    expect(over.taken).toEqual([]);
    expect(over.left).toEqual([{ resource: 'alloy', amount: 2 }]);
    expect(freeSpace({ scrap: 90 }, 80)).toBe(0);
    // infinite space takes all
    expect(planTake([{ resource: 'scrap', amount: 9 }], Infinity).left).toEqual([]);
  });

  it('removes only what is there (no negative stacks, nothing removed on failure)', () => {
    expect(removeLoot({ scrap: 5, alloy: 2 }, [{ resource: 'scrap', amount: 5 }, { resource: 'alloy', amount: 1 }])).toEqual({ alloy: 1 });
    expect(removeLoot({ scrap: 5 }, [{ resource: 'scrap', amount: 6 }])).toBeNull();
    expect(removeLoot({ scrap: 5 }, [{ resource: 'scrap', amount: -1 }])).toBeNull();
    expect(removeLoot({ scrap: 5 }, [{ resource: 'scrap', amount: 1.5 }])).toBeNull();
  });

  it('SWAP throws out only cheaper cargo, unit for unit, and gains nothing when nothing is cheaper', () => {
    const plan = planSwap({ scrap: 78, alloy: 2 }, [{ resource: 'crystal', amount: 3 }, { resource: 'scrap', amount: 2 }], 80)!;
    // scrap is incoming, so it is never thrown out for itself; the cheapest other cargo (alloy 4) goes for crystal (7)
    expect(plan.jettison).toEqual([{ resource: 'alloy', amount: 2 }]);
    expect(plan.take).toEqual([{ resource: 'crystal', amount: 2 }]);
    expect(plan.left).toEqual([{ resource: 'scrap', amount: 2 }, { resource: 'crystal', amount: 1 }]);
    expect(planSwap({ relic: 5 }, [{ resource: 'scrap', amount: 2 }], 5)).toBeNull(); // nothing cheaper than scrap
    // with free space, the free space is used first
    const p2 = planSwap({ scrap: 79 }, [{ resource: 'components', amount: 3 }], 80)!;
    expect(p2.jettison).toEqual([{ resource: 'scrap', amount: 2 }]);
    expect(p2.take).toEqual([{ resource: 'components', amount: 3 }]);
  });

  it('module storage is bounded and never goes negative', () => {
    let m: Record<string, number> = {};
    for (let i = 0; i < MAX_MODULE_COUNT; i++) m = { ...storeModule(m, 'cargo-pod')! };
    expect(storeModule(m, 'cargo-pod')).toBeNull();
    expect(takeModule({}, 'cargo-pod')).toBeNull();
    expect(takeModule({ 'cargo-pod': 1 }, 'cargo-pod')).toEqual({});
    let big: Record<string, number> = {};
    for (const id of ['a-one', 'b-two', 'c-three']) big[id] = MAX_MODULE_COUNT;
    expect(storageRoom(big, 'cargo-pod')).toBe(Math.max(0, MAX_STORED_MODULES - 27));
    big = { ...big, 'd-four': 0 };
    expect(storeModule({ 'a-one': 9, 'b-two': 9, 'c-three': 6 }, 'd-four')).toBeNull(); // 24 stored = full
  });
});

/* ------------------------------------------------------------ fabricator */
describe('fabricator and module fitting', () => {
  it('builds a module once per payment; refuses when short or storage is full', () => {
    const hold = { scrap: 12, alloy: 4, components: 2 };
    const r = fabricate(hold, {}, 'cargo-pod');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hold).toEqual({ scrap: 2 });
    expect(r.modules).toEqual({ 'cargo-pod': 1 });
    expect(fabricate(r.hold, r.modules, 'cargo-pod')).toEqual({ ok: false, reason: 'unaffordable' });
    expect(fabricate(hold, { 'cargo-pod': MAX_MODULE_COUNT }, 'cargo-pod')).toEqual({ ok: false, reason: 'storage-full' });
    expect(fabricate(hold, {}, 'pulse-cannon')).toEqual({ ok: false, reason: 'unknown' }); // stock modules are not built
    expect(missingResources(RECIPES[0]!.cost, {})).toEqual(RECIPES[0]!.cost);
    // every recipe makes a real module, and the rare ones need a rare resource
    for (const rec of RECIPES) {
      expect(EQUIPMENT_BY_ID.has(rec.module), rec.module).toBe(true);
      expect(bySort(normalizeLoot(rec.cost))).toEqual(bySort(rec.cost));
    }
    expect(RECIPES.filter((x) => x.cost.some((c) => RARE_IDS.includes(c.resource))).map((x) => x.module).sort()).toEqual(['bastion-array', 'deep-array', 'lance-driver']);
  });

  it('fits only compatible modules into the flown ship, swapping the old one into storage', () => {
    const petrel = SHIP_BY_ID.get('petrel')!;
    const ok = fitFromStorage(petrel, petrel.stock, { 'twin-pulse': 1 }, {}, 'weapon', 0, 'twin-pulse');
    expect(ok).toMatchObject({ ok: true, removed: 'pulse-cannon', modules: { 'pulse-cannon': 1 } });
    if (ok.ok) expect(ok.loadout.weapon).toEqual(['twin-pulse']);
    // heavy weapons do not fit the Petrel's hardpoints; slot types must match; it must be stored
    expect(fitFromStorage(petrel, petrel.stock, { 'lance-driver': 1 }, {}, 'weapon', 0, 'lance-driver')).toEqual({ ok: false, reason: 'incompatible' });
    expect(fitFromStorage(petrel, petrel.stock, { 'cargo-pod': 1 }, {}, 'engine', 0, 'cargo-pod')).toEqual({ ok: false, reason: 'incompatible' });
    expect(fitFromStorage(petrel, petrel.stock, {}, {}, 'weapon', 0, 'twin-pulse')).toEqual({ ok: false, reason: 'not-stored' });
    expect(fitFromStorage(petrel, petrel.stock, { 'cargo-pod': 1 }, {}, 'cargo', 0, 'cargo-pod')).toEqual({ ok: false, reason: 'same' });
    // a bigger hold module raises the cargo stat (loot buys real gameplay)
    const rig = fitFromStorage(petrel, petrel.stock, { 'salvage-rig': 1 }, {}, 'cargo', 0, 'salvage-rig');
    expect(rig.ok).toBe(true);
    if (rig.ok) expect(deriveStats(petrel, rig.loadout).cargo).toBe(deriveStats(petrel, petrel.stock).cargo + 20);
    // the Magpie's empty third cargo slot takes a spare pod
    const magpie = SHIP_BY_ID.get('magpie')!;
    const third = fitFromStorage(magpie, magpie.stock, { 'cargo-pod': 1 }, {}, 'cargo', 2, 'cargo-pod');
    expect(third).toMatchObject({ ok: true, removed: null, modules: {} });
    // never shrink the hold below the cargo carried
    const full = { scrap: deriveStats(petrel, rig.ok ? rig.loadout : petrel.stock).cargo };
    if (rig.ok) expect(fitFromStorage(petrel, rig.loadout, rig.modules, full, 'cargo', 0, 'cargo-pod')).toEqual({ ok: false, reason: 'cargo-overflow' });
  });
});

/* ------------------------------------------------------------ milestones */
describe('milestones', () => {
  it('are reached from progress, claimable once, and pay fixed valid rewards', () => {
    const none = { surveys: 0, charted: 0, galaxies: 1 };
    expect(claimableMilestones(none, [])).toEqual([]);
    const some = { surveys: 1, charted: 10, galaxies: 2 };
    expect(claimableMilestones(some, []).map((m) => m.id)).toEqual(['first-survey', 'charted-10', 'galaxies-2']);
    expect(milestoneState(MILESTONES[0]!, some, ['first-survey'])).toBe('claimed');
    expect(claimableMilestones(some, ['first-survey']).map((m) => m.id)).toEqual(['charted-10', 'galaxies-2']);
    expect(new Set(MILESTONES.map((m) => m.id)).size).toBe(MILESTONES.length);
    for (const m of MILESTONES) expect(bySort(normalizeLoot(m.loot))).toEqual(bySort(m.loot));
    let p = withMilestone(EMPTY_PROFILE, 'first-survey');
    expect(withMilestone(p, 'first-survey')).toBe(p);
    p = withMilestone(p, 'BAD ID');
    expect(p.milestones).toEqual(['first-survey']);
  });
});

/* ----------------------------------------------------------- persistence */
describe('profile v8 and the persistence interface', () => {
  it('migrates v7 saves (cargo kept, empty storage), sanitizes leftovers and storage', () => {
    expect(FREEROAM_VERSION).toBe(10);
    const store = new MemoryStore();
    store.write('galaxia:freeroam', JSON.stringify({ ...EMPTY_PROFILE, version: 7, cargo: { scrap: 90 }, modules: undefined, milestones: undefined }));
    const m = loadProfile(store);
    expect(m.status).toBe('migrated');
    expect(m.data.cargo).toEqual({ scrap: 90 }); // over any capacity: kept, never trimmed
    expect(m.data.modules).toEqual({});
    expect(m.data.milestones).toEqual([]);
    const sys = 'milky-way/sol';
    store.write(
      'galaxia:freeroam',
      JSON.stringify({ ...EMPTY_PROFILE, version: 10, modules: { 'cargo-pod': 2, 'BAD ID': 1, 'twin-pulse': -1, 'deep-array': 1.5 }, milestones: ['first-survey', 7, 'first-survey'], sectors: { [sys]: { done: ['cache-1'], surveyed: true, left: { 'cache-1': { scrap: 2 }, 'derelict-2': { alloy: 3, fuel: -1 }, 'BAD ID': { scrap: 1 }, 'cache-3': { scrap: 0 } } } } }),
    );
    const r = loadProfile(store);
    expect(r.status).toBe('repaired');
    expect(r.data.modules).toEqual({ 'cargo-pod': 2 });
    expect(r.data.milestones).toEqual(['first-survey']);
    // a done id never also holds loot; invalid quantities are dropped
    expect(r.data.sectors[sys]).toEqual({ done: ['cache-1'], surveyed: true, left: { 'derelict-2': { alloy: 3 } } });
  });

  it('leftover loot completes the id once empty, and can never be put back on a done id', () => {
    const sys = 'milky-way/sol';
    let p = withLeftLoot(EMPTY_PROFILE, sys, 'cache-1', [{ resource: 'scrap', amount: 3 }]);
    expect(p.sectors[sys]).toEqual({ done: [], surveyed: false, left: { 'cache-1': { scrap: 3 } } });
    p = withLeftLoot(p, sys, 'cache-1', []);
    expect(p.sectors[sys]).toEqual({ done: ['cache-1'], surveyed: false });
    expect(withLeftLoot(p, sys, 'cache-1', [{ resource: 'scrap', amount: 9 }])).toBe(p);
    // completing an id through progress also clears its leftovers
    const q = withSectorProgress(withLeftLoot(EMPTY_PROFILE, sys, 'derelict-1', [{ resource: 'alloy', amount: 1 }]), sys, ['derelict-1']);
    expect(q.sectors[sys]).toEqual({ done: ['derelict-1'], surveyed: false });
    expect(withLeftLoot(EMPTY_PROFILE, 'BAD', 'cache-1', [{ resource: 'scrap', amount: 1 }])).toBe(EMPTY_PROFILE);
    expect(withModules(EMPTY_PROFILE, { 'cargo-pod': 3, 'Bad': 1, 'twin-pulse': 0 }).modules).toEqual({ 'cargo-pod': 3 });
  });

  it('snapshots round-trip through memory and local storage without touching navigation, controls or the fleet', () => {
    const sys = 'milky-way/sol';
    const p0 = withMilestone(withModules(withLeftLoot({ ...EMPTY_PROFILE, cargo: { scrap: 5, crystal: 2 }, sessions: 4 }, sys, 'cache-2', [{ resource: 'alloy', amount: 2 }]), { 'cargo-pod': 1 }), 'first-survey');
    const snap = snapshotOf(p0);
    expect(snap).toMatchObject({ format: 1, cargo: { scrap: 5, crystal: 2 }, modules: { 'cargo-pod': 1 }, milestones: ['first-survey'] });
    expect(snap.sectors[sys]!.left).toEqual({ 'cache-2': { alloy: 2 } });
    const mem = memoryRepository();
    expect(mem.save(snap)).toBe(true);
    expect(mem.load()).toEqual(snap);
    expect(mem.writes).toBe(1);
    const store = new MemoryStore();
    saveProfile(store, { ...EMPTY_PROFILE, sessions: 9, currentGalaxy: 'lmc' });
    const repo = profileRepository(store);
    expect(repo.save(snap)).toBe(true);
    const back = loadProfile(store).data;
    expect(back.sessions).toBe(9); // untouched
    expect(back.currentGalaxy).toBe('lmc');
    expect(snapshotOf(back)).toEqual(snap);
    expect(repo.load()).toEqual(snap);
    expect(applySnapshot(EMPTY_PROFILE, snap).cargo).toEqual({ scrap: 5, crystal: 2 });
    // untrusted input: invalid quantities and ids are repaired, garbage gives an empty snapshot
    const parsed = parseSnapshot({ format: 1, cargo: { scrap: -4, alloy: 3, 'x y': 2 }, modules: { 'cargo-pod': 100 }, milestones: ['ok-one', 3], sectors: {} });
    expect(parsed.repaired).toBe(true);
    expect(parsed.snapshot.cargo).toEqual({ alloy: 3 });
    expect(parsed.snapshot.modules).toEqual({});
    expect(parsed.snapshot.milestones).toEqual(['ok-one']);
    expect(deserializeSnapshot('{nope').repaired).toBe(true);
    expect(deserializeSnapshot(serializeSnapshot(snap)).snapshot).toEqual(snap);
    expect(parseSnapshot({ format: 99 }).snapshot.cargo).toEqual({});
  });
});
