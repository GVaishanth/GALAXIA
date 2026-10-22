/**
 * Pure catalogue builder: authored data in, frozen Catalogue out.
 *
 * The builder is deliberately lenient. It never throws on bad content; it
 * passes unknown references through unchanged so that validateCatalogue()
 * can report them with a precise path. The same input always yields the same
 * output (no randomness, no clock, stable ordering), so seeds and the digest
 * can be pinned by tests.
 */
import type {
  Catalogue,
  FactionId,
  GalaxyRecord,
  GalaxySystems,
  HazardId,
  MilestoneRecord,
  ProgressionConfig,
  RouteRecord,
  SectorArchetype,
  SectorConfig,
  SourceRecord,
  SystemRecord,
  SystemRow,
  UnlockRequirement,
} from './types.ts';
import { CATALOGUE_VERSION, LIMITS, normalFaction } from './types.ts';

/** Default provenance note for verified objects when a row gives none. */
export const SIMULATION_NOTE = 'Real object: only the cited fact is astronomy. The playable sector, its layout, salvage, factions and encounters are a GALAXIA simulation.';

/** 32-bit FNV-1a over UTF-16 code units. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable per-system seed. Changing this formula re-rolls every sector: bump CATALOGUE_VERSION and migrate saves. */
export function systemSeed(systemId: string): number {
  return fnv1a32(`galaxia:freeroam:system:${systemId}`);
}

const qualify = (galaxyId: string, ref: string): string => (ref.includes('/') ? ref : `${galaxyId}/${ref}`);
const round2 = (v: number): number => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function buildSector(row: SystemRow, archetypes: readonly SectorArchetype[]): SectorConfig {
  const a = archetypes.find((x) => x.id === row.archetype);
  const [threat] = row.encounters;
  const [, , richness] = row.resources;
  if (!a) {
    // Unknown archetype: emit an obviously invalid config for the validator to flag.
    return { archetype: row.archetype, width: 0, height: 0, density: 0, salvageNodes: 0, encounterSlots: 0, hazard: row.hazard ?? 'none', hazardStrength: 0, station: false };
  }
  const hazard: HazardId = row.hazard ?? a.hazards[0] ?? 'none';
  return {
    archetype: a.id,
    width: a.size,
    height: a.size,
    density: round2(clamp(a.density + (row.difficulty - 3) * 0.03, 0, 1)),
    salvageNodes: clamp(a.salvageBase + richness * 2, LIMITS.salvageNodes.min, LIMITS.salvageNodes.max),
    encounterSlots: threat <= 0 ? 0 : clamp(a.encounterBase + threat + Math.floor(row.difficulty / 2), 1, LIMITS.encounterSlots.max),
    hazard,
    hazardStrength: hazard === 'none' ? 0 : round2(clamp(0.15 + row.difficulty * 0.15, 0.05, 1)),
    station: row.station ?? (row.gateway === true ? true : a.station),
  };
}

function buildUnlock(galaxyId: string, row: SystemRow): UnlockRequirement[] {
  const out: UnlockRequirement[] = [];
  for (const ref of row.needs?.systems ?? []) out.push({ kind: 'system', systemId: qualify(galaxyId, ref) });
  if (row.needs?.drive !== undefined) out.push({ kind: 'drive', tier: row.needs.drive });
  if (row.needs?.surveys !== undefined) out.push({ kind: 'surveys', count: row.needs.surveys });
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export interface CatalogueData {
  readonly sources: readonly SourceRecord[];
  readonly galaxies: readonly GalaxyRecord[];
  readonly systems: readonly GalaxySystems[];
  readonly archetypes: readonly SectorArchetype[];
  readonly routes: readonly RouteRecord[];
  readonly milestones: readonly MilestoneRecord[];
  readonly progression: ProgressionConfig;
}

export function buildCatalogue(data: CatalogueData): Catalogue {
  // Pass 1: ids and authored links.
  const links = new Map<string, Set<string>>();
  const rows: { galaxyId: string; row: SystemRow; id: string }[] = [];
  for (const group of data.systems) {
    for (const row of group.rows) {
      const id = `${group.galaxyId}/${row.slug}`;
      rows.push({ galaxyId: group.galaxyId, row, id });
      if (!links.has(id)) links.set(id, new Set());
    }
  }
  // Pass 2: make lanes symmetric. Unknown targets stay one-way for the validator to report.
  for (const { galaxyId, row, id } of rows) {
    for (const ref of row.links) {
      const target = qualify(galaxyId, ref);
      links.get(id)!.add(target);
      links.get(target)?.add(id);
    }
  }
  const systems: SystemRecord[] = rows.map(({ galaxyId, row, id }) => {
    const verified = row.provenance === 'verified-object';
    const [primary, secondary, richness] = row.resources;
    const [threat, pattern, factions] = row.encounters;
    return {
      id,
      galaxyId: galaxyId as SystemRecord['galaxyId'],
      name: row.name,
      category: row.category,
      description: row.description,
      fact: row.fact ?? null,
      provenance: {
        status: row.provenance,
        sourceIds: [...(row.sources ?? [])],
        note: row.note ?? (verified ? SIMULATION_NOTE : null),
      },
      difficulty: row.difficulty,
      resources: { primary, secondary, richness },
      encounters: { threat, pattern, factions: factions.map((f) => normalFaction(f) as FactionId) },
      discovery: row.discovery,
      unlock: buildUnlock(galaxyId, row),
      connections: [...(links.get(id) ?? [])].sort(),
      seed: systemSeed(id),
      sector: buildSector(row, data.archetypes),
      gateway: row.gateway === true,
    };
  });
  return deepFreeze({
    version: CATALOGUE_VERSION,
    sources: data.sources.map((s) => ({ ...s })),
    galaxies: data.galaxies.map((g) => structuredClone(g)),
    systems,
    routes: data.routes.map((r) => structuredClone(r)),
    milestones: data.milestones.map((m) => structuredClone(m)),
    progression: { ...data.progression },
  });
}

/** Order-stable fingerprint of a built catalogue, for golden tests. */
export function catalogueDigest(catalogue: Catalogue): string {
  return fnv1a32(JSON.stringify(catalogue)).toString(16).padStart(8, '0');
}
