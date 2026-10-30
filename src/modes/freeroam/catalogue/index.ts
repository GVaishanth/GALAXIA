/**
 * Free Roam catalogue entry point: wires the authored data modules to the pure
 * builder and exposes read-only lookups. Static, bundled data: nothing is
 * fetched at startup and no online astronomy service is needed.
 *
 * Imported only by the lazily loaded Free Roam chunk (the galaxy map,
 * src/modes/freeroam/galaxy/), so Classic never pays for it.
 */
import { buildCatalogue } from './build.ts';
import { ARCHETYPES } from './data/archetypes.ts';
import { GALAXIES } from './data/galaxies.ts';
import { MILESTONES, PROGRESSION } from './data/milestones.ts';
import { ROUTES } from './data/routes.ts';
import { SOURCES } from './data/sources.ts';
import { SOURCE_TITLES } from './data/sourceTitles.ts';
import { SYSTEM_DATA } from './data/systems/index.ts';
import type { Catalogue, GalaxyId, GalaxyRecord, MilestoneRecord, RouteRecord, SourceRef, SystemRecord } from './types.ts';
import { validateCatalogue, type CatalogueIssue } from './validate.ts';

let cached: Catalogue | null = null;

/** The built catalogue (memoised; deterministic and deep-frozen). */
export function getCatalogue(): Catalogue {
  cached ??= buildCatalogue({ sources: SOURCE_TITLES, galaxies: GALAXIES, systems: SYSTEM_DATA, archetypes: ARCHETYPES, routes: ROUTES, milestones: MILESTONES, progression: PROGRESSION });
  return cached;
}

/** Every validation problem in the shipped catalogue (empty when healthy). */
export function catalogueIssues(): CatalogueIssue[] {
  // the shipped catalogue holds source ids and titles; the full records (publisher, URL, date, tier) are validated here
  return validateCatalogue({ ...getCatalogue(), sources: SOURCES });
}

export interface CatalogueIndex {
  readonly catalogue: Catalogue;
  galaxy(id: string): GalaxyRecord | undefined;
  system(id: string): SystemRecord | undefined;
  source(id: string): SourceRef | undefined;
  systemsIn(galaxyId: GalaxyId): readonly SystemRecord[];
  route(id: string): RouteRecord | undefined;
  milestone(id: string): MilestoneRecord | undefined;
}

export function indexCatalogue(catalogue: Catalogue = getCatalogue()): CatalogueIndex {
  const galaxies = new Map(catalogue.galaxies.map((g) => [g.id as string, g]));
  const systems = new Map(catalogue.systems.map((s) => [s.id, s]));
  const sources = new Map(catalogue.sources.map((s) => [s.id, s]));
  const byGalaxy = new Map<string, SystemRecord[]>();
  const routes = new Map(catalogue.routes.map((r) => [r.id, r]));
  const milestones = new Map(catalogue.milestones.map((m) => [m.id, m]));
  for (const s of catalogue.systems) byGalaxy.set(s.galaxyId, [...(byGalaxy.get(s.galaxyId) ?? []), s]);
  return {
    catalogue,
    galaxy: (id) => galaxies.get(id),
    system: (id) => systems.get(id),
    source: (id) => sources.get(id),
    systemsIn: (galaxyId) => byGalaxy.get(galaxyId) ?? [],
    route: (id) => routes.get(id),
    milestone: (id) => milestones.get(id),
  };
}

export { buildCatalogue, catalogueDigest, systemSeed, SIMULATION_NOTE } from './build.ts';
export { validateCatalogue, assertValidCatalogue, normalizeName, type CatalogueIssue, type IssueCode } from './validate.ts';
export * from './types.ts';
