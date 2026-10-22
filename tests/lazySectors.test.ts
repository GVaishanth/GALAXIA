/**
 * FR Prompt 16: sector maps are generated on demand, never all up front.
 *
 * Counts real generateSector calls (the module is wrapped, not replaced)
 * while the mission system builds a fresh pilot's station board and resolves
 * every story objective, the work Free Roam does when it starts and when the
 * mission board opens.
 */
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../src/modes/freeroam/sector/generate.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/modes/freeroam/sector/generate.ts')>();
  return {
    ...real,
    generateSector: (...args: Parameters<typeof real.generateSector>) => {
      calls.ids.push(args[0].id);
      return real.generateSector(...args);
    },
  };
});

const { buildNavGraph } = await import('../src/modes/freeroam/galaxy/graph.ts');
const { progressFromSaved } = await import('../src/modes/freeroam/galaxy/progress.ts');
const { EMPTY_PROFILE } = await import('../src/modes/freeroam/profile.ts');
const { buildMissionWorld, layoutOf } = await import('../src/modes/freeroam/progression/missionWorld.ts');
const { stationBoard, BOARD } = await import('../src/modes/freeroam/progression/contracts.ts');
const { resolveTarget } = await import('../src/modes/freeroam/progression/missions.ts');
const { STORY_BY_ID } = await import('../src/modes/freeroam/progression/missionData.ts');
const { EMPTY_MISSIONS } = await import('../src/modes/freeroam/progression/missionTypes.ts');

describe('lazy sector generation', () => {
  const graph = buildNavGraph();
  const total = graph.catalogue.systems.length;

  it('loading the catalogue and the galaxy graph generates no sector maps', () => {
    expect(total).toBeGreaterThan(100);
    expect(calls.ids).toEqual([]);
  });

  it('a fresh pilot\'s mission board and story targets generate only nearby sectors, each once', () => {
    const progress = progressFromSaved(graph, EMPTY_PROFILE);
    const world = buildMissionWorld(graph, progress, {});
    expect(calls.ids).toEqual([]); // building the world is free; sites are read lazily
    stationBoard(EMPTY_MISSIONS, progress.system, world);
    for (const def of STORY_BY_ID.values()) for (const o of def.objectives) resolveTarget(o, '', world, new Set());
    const unique = new Set(calls.ids);
    expect(unique.size).toBe(calls.ids.length); // the layout cache works
    expect(unique.size).toBeGreaterThan(0);
    expect(unique.size).toBeLessThan(total / 4); // nowhere near "every system"
    // every generated sector is inside the contract board radius of the starting system
    for (const id of unique) expect(world.hops(progress.system, id)).toBeLessThanOrEqual(BOARD.radius);
  });

  it('the layout cache is bounded, so visiting many systems cannot grow memory without limit', () => {
    const before = calls.ids.length;
    const ids = graph.catalogue.systems.slice(0, 120).map((s) => s.id);
    for (const id of ids) layoutOf(graph, id);
    const generated = calls.ids.length - before;
    expect(generated).toBeGreaterThan(0);
    // asking again for the oldest entries regenerates them: they were evicted (cap 96)
    const again = calls.ids.length;
    layoutOf(graph, ids[0]!);
    expect(calls.ids.length).toBe(again + 1);
    // the newest entry is still cached
    layoutOf(graph, ids[ids.length - 1]!);
    expect(calls.ids.length).toBe(again + 1);
  });
});
