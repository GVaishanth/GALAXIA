/**
 * Generation stability. Saves refer to POI, site and hazard ids, so every
 * persistent layout element must keep its id and position.
 *
 * Fixture v2 was written from the Prompt 9 generator (commit 4a231fa) before
 * any Prompt 10 change. It covers spawns, landmarks, regions, rocks, POIs,
 * patrols, encounter sites, hazard zones and mines, and deliberately excludes
 * loot: Prompt 10 moved every reward to the central loot tables
 * (inventory/lootTables.ts), so amounts may change while positions and ids may
 * not. The v1 fixture (Prompt 8, loot included) was retired with that change.
 * Ore veins (Prompt 10) are added after everything else and are not part of
 * the fingerprint; tests/inventory*.test.ts check them.
 */
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { layoutFingerprint } from './sectorFingerprint.ts';

it('keeps every Prompt 6-9 layout element (ids and positions) identical in all 170 sectors', () => {
  const graph = buildNavGraph();
  const want = JSON.parse(readFileSync('tests/fixtures/sector-layout-v2.json', 'utf8')) as Record<string, string>;
  const systems = getCatalogue().systems;
  expect(systems.length).toBe(Object.keys(want).length);
  const changed = systems.filter((s) => layoutFingerprint(generateSector(s, sectorContext(graph, s.id))) !== want[s.id]).map((s) => s.id);
  expect(changed).toEqual([]);
});
