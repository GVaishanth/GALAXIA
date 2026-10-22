/**
 * Local sector model (Prompt 6): types and generation constants. Pure data.
 *
 * A sector has five strictly separated layers:
 *   1. static layout      SectorLayout, generated from the system's catalogue
 *                         seed and SectorConfig (sector/generate.ts). Same input,
 *                         same layout, on every load and every engine.
 *   2. persistent changes SectorSave: which interactions are complete, whether
 *                         the survey is done (profile `sectors`, withSectorProgress in profile.ts).
 *   3. temporary entities hostiles, encounter timers, the ship (sector/run.ts);
 *                         created on entry, discarded on exit.
 *   4. visual decoration  parallax stars, nebula texture, rock outlines
 *                         (sector/render.ts); derived from a separate seed stream
 *                         and never read by gameplay.
 *   5. harmless variation hostile spawn jitter: a run-local stream that never
 *                         changes positions of objects, loot or encounters.
 */
import type { EncounterPattern, FactionId, HazardId, ResourceId, SectorArchetypeId } from '../catalogue/types.ts';

/**
 * Bump when generation output changes; saved progress refers to POI ids, so keep ids stable.
 * v2 (Prompt 9): encounter sites and hazard zones are added after everything else, from their
 * own seed streams; every v1 element is unchanged (tests/sectorStability.test.ts).
 * v3 (Prompt 10): every reward is rolled from the central loot tables (inventory/lootTables.ts),
 * so loot amounts changed, never ids or positions; ore veins and the sector's resource profile
 * are added after everything else.
 */
export const SECTOR_GEN_VERSION = 3;

export const SECTOR_GEN = Object.freeze({
  /** Occupancy grid cell for reachability (art px). */
  cell: 64,
  /** Keep solid content this far inside the sector bounds (beyond the soft edge band). */
  edgeMargin: 220,
  /** Arrival point distance from its sector edge. */
  arrivalInset: 560,
  /** Nothing solid, hazardous or hostile within this radius of the arrival point. */
  arrivalClear: 460,
  /** Clear radius around each gate (gate arrivals spawn here). */
  gateClear: 240,
  /** Ship clearance used for corridors (ship radius 12 + margin). */
  shipClearance: 30,
  /** Minimum gap between major objects (edge to edge). */
  separation: 120,
  /** Range for button interactions (inspect, open, dock, jump, leave). */
  interactRadius: 90,
  /** Fly-through pick-up radius for salvage nodes. */
  collectRadius: 34,
  /** Fly-through radius for survey marks. */
  markRadius: 40,
  maxAttempts: 6,
  maxRocks: 180,
  /** Hard cap on simultaneously active hostile ships. */
  maxHostiles: 24,
});

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type StarStyle = 'yellow' | 'orange' | 'red' | 'blue' | 'white' | 'neutron' | 'black-hole' | 'protostar' | 'anomaly-core' | 'dim';
export type BodyStyle = 'rocky' | 'ice' | 'gas' | 'molten';

/** Stars and planet-like bodies: visual landmarks and navigational obstacles (no orbits, no landing). */
export interface Landmark {
  readonly id: string;
  readonly kind: 'star' | 'body';
  readonly style: StarStyle | BodyStyle;
  readonly x: number;
  readonly y: number;
  /** Solid radius. */
  readonly r: number;
  /** Damaging glow (stars) around the solid core; 0 for bodies. */
  readonly hazardR: number;
  readonly label: string;
}

export type RegionKind = 'asteroids' | 'nebula';

/** Areas: asteroid fields (filled with rocks) and nebula / dust clouds (hazard effect inside). */
export interface Region {
  readonly id: string;
  readonly kind: RegionKind;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly effect: HazardId;
  readonly strength: number;
  readonly label: string;
}

/** One asteroid: a solid circle. `shape` only seeds its outline (decoration). */
export interface Rock {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly field: string;
  readonly shape: number;
}

export const POI_KINDS = ['survey', 'salvage', 'derelict', 'cache', 'anomaly', 'station', 'installation', 'gate', 'exit'] as const;
export type PoiKind = (typeof POI_KINDS)[number];

export type Interaction = 'record' | 'collect' | 'inspect' | 'open' | 'investigate' | 'dock' | 'trigger' | 'jump' | 'leave';

/** How each kind is used. `auto` = flying through it is the interaction. */
export const POI_RULES: Readonly<Record<PoiKind, { readonly interaction: Interaction; readonly auto: boolean; readonly once: boolean; readonly verb: string }>> = {
  survey: { interaction: 'record', auto: true, once: true, verb: 'Record' },
  salvage: { interaction: 'collect', auto: true, once: true, verb: 'Collect' },
  derelict: { interaction: 'inspect', auto: false, once: true, verb: 'Inspect' },
  cache: { interaction: 'open', auto: false, once: true, verb: 'Open' },
  anomaly: { interaction: 'investigate', auto: false, once: true, verb: 'Investigate' },
  station: { interaction: 'dock', auto: false, once: false, verb: 'Dock' },
  installation: { interaction: 'trigger', auto: true, once: true, verb: 'Approach' },
  gate: { interaction: 'jump', auto: false, once: false, verb: 'Use gate' },
  exit: { interaction: 'leave', auto: false, once: false, verb: 'Leave sector' },
};

export interface LootEntry {
  readonly resource: ResourceId;
  readonly amount: number;
}

/** Rare rewards: never guaranteed, never in difficulty-1 sectors (tested; equals inventory/resources.ts RARE_IDS). */
export const RARE_RESOURCES: readonly ResourceId[] = ['core-shard', 'relic'];

/**
 * A marked ore vein (Prompt 10) running through one asteroid. Bolts that hit
 * the rock chip fragments loose (inventory/lootTables.ts MINING); each chip
 * has a stable id `${id}.${k}` (k from 1), saved as done once collected, so a
 * vein depletes once and stays depleted. Rocks themselves never break.
 */
export interface OreVein {
  /** `vein-N`. */
  readonly id: string;
  /** Index of the rock in SectorLayout.rocks, and a copy of its circle. */
  readonly rock: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** Direction the marked seam faces (radians, 0 = +x); fragments fly out on this side. */
  readonly angle: number;
  /** Loot of each chip, in chip order (chip k = chips[k - 1]). */
  readonly chips: readonly (readonly LootEntry[])[];
}

/** The sector's catalogue resources (loot rolled at run time: enemy salvage pods). */
export interface SectorResources {
  readonly primary: ResourceId;
  readonly secondary: ResourceId | null;
  readonly richness: number;
}

/** A typed point of interest with a stable id (local to its sector). */
export interface Poi {
  /** Local id, e.g. `derelict-2`, `salvage-1.3`, `gate:milky-way/sirius`. Global id = `${systemId}#${id}`. */
  readonly id: string;
  readonly kind: PoiKind;
  readonly x: number;
  readonly y: number;
  /** Interaction radius (fly-through radius for auto kinds). */
  readonly r: number;
  /** Solid hull radius (0 = fly-through marker). */
  readonly solidR: number;
  readonly label: string;
  /** Required for completing the sector's survey or for leaving it. */
  readonly required: boolean;
  readonly loot: readonly LootEntry[];
  /** Gates: destination system id. */
  readonly target: string | null;
  /** Salvage nodes: the field they belong to. */
  readonly group: string | null;
  /** Installations: alert radius, wave size, ship tier, hold time (ticks). */
  readonly alertR: number;
  readonly wave: number;
  readonly tier: HostileTier;
  readonly holdTicks: number;
}

/**
 * Threat tier of a patrol or installation (1 light .. 3 heavy). Since Prompt 9 the
 * tier only selects which enemy families a group fields (combat/difficulty.ts
 * compositionFor); ship stats live in combat/families.ts.
 */
export type HostileTier = 0 | 1 | 2 | 3;

/**
 * Patrol routes keep this far (beyond the arrival zone edge) from the arrival
 * point, per tier. The values are the Prompt 6 tiers' half sight ranges, kept
 * unchanged so every generated layout stays identical.
 */
export const PATROL_ARRIVAL_CLEARANCE: Readonly<Record<1 | 2 | 3, number>> = { 1: 165, 2: 190, 3: 210 };

/** Highest hostile tier a sector of this difficulty may field (enemy difficulty respects the region). */
export function maxTierFor(difficulty: number): 1 | 2 | 3 {
  return difficulty <= 2 ? 1 : difficulty === 3 ? 2 : 3;
}

export interface PatrolRoute {
  readonly id: string;
  /** Closed loop of waypoints. */
  readonly points: readonly Point[];
  readonly ships: number;
  readonly tier: 1 | 2 | 3;
  readonly faction: FactionId;
}

/* ------------------------------------------------------- combat content (Prompt 9) */

/**
 * Encounter kinds. `outpost` is the installation POI (Prompt 6); patrol
 * interceptions come from PatrolRoute; the rest are EncounterSites.
 */
export const SITE_KINDS = ['ambush', 'defence', 'dispute', 'elite', 'capital'] as const;
export type SiteKind = (typeof SITE_KINDS)[number];
export type EncounterKind = SiteKind | 'outpost';

/**
 * A combat encounter placed by the generator. Its id is a sector-local id in
 * the POI grammar (`ambush-1`, `elite-1`): completing it is persisted in the
 * sector's `done` list, so its reward is paid once and an elite or capital
 * ship stays defeated.
 */
export interface EncounterSite {
  readonly id: string;
  readonly kind: SiteKind;
  readonly x: number;
  readonly y: number;
  /** Trigger / wake radius. */
  readonly r: number;
  /** ambush: bait POI id; defence: derelict POI id; dispute: salvage group id; else null. */
  readonly anchor: string | null;
  /** First = the faction that fights here; a second faction is its rival (disputes). */
  readonly factions: readonly FactionId[];
  /** Ships per wave (the elite / capital ship counts as one). */
  readonly size: number;
  readonly waves: number;
  /** defence: ticks to hold near the wreck. */
  readonly holdTicks: number;
  readonly loot: readonly LootEntry[];
  readonly label: string;
}

export const HAZARD_KINDS = ['minefield', 'interference', 'eruption'] as const;
export type HazardKind = (typeof HAZARD_KINDS)[number];

/**
 * A combat hazard zone: a minefield (proximity mines, telegraphed before they
 * blow; mines are temporary and re-laid on every visit), a sensor-interference
 * field (no sensor reveal, no hostile contacts on the map or edge markers
 * inside) or an eruption field (telegraphed blasts on a fixed seeded schedule).
 */
export interface HazardZone {
  readonly id: string;
  readonly kind: HazardKind;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** Minefields: who laid it (its mines spare that faction's allies). */
  readonly faction: FactionId | null;
  /** Minefields: mine positions. */
  readonly mines: readonly Point[];
  /** Eruption fields: ticks between blasts. */
  readonly period: number;
  readonly label: string;
}

export interface SpawnPoint {
  /** `arrival` or `gate:<system id>` (arriving through the gate that leads back there). */
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

export interface SectorLayout {
  readonly systemId: string;
  readonly seed: number;
  readonly version: number;
  readonly archetype: SectorArchetypeId;
  readonly width: number;
  readonly height: number;
  readonly difficulty: number;
  readonly threat: number;
  readonly encounterSlots: number;
  /** The clear arrival zone (centre and radius). */
  readonly arrival: { readonly x: number; readonly y: number; readonly r: number };
  readonly spawns: readonly SpawnPoint[];
  readonly landmarks: readonly Landmark[];
  readonly regions: readonly Region[];
  readonly rocks: readonly Rock[];
  readonly pois: readonly Poi[];
  readonly patrols: readonly PatrolRoute[];
  /** Prompt 9: factions present (catalogue order) and the encounter pattern. */
  readonly factions: readonly FactionId[];
  readonly pattern: EncounterPattern;
  readonly sites: readonly EncounterSite[];
  readonly hazards: readonly HazardZone[];
  /** Prompt 10: the catalogue resource profile, and marked ore veins (added after everything else). */
  readonly resources: SectorResources;
  readonly veins: readonly OreVein[];
  /** Generation attempts used (1 = first try). */
  readonly attempts: number;
}

/** What the generator needs besides the system record: one gate per lane, in map direction. */
export interface GateSpec {
  readonly to: string;
  /** Direction from the sector centre (radians, 0 = +x, y down), from the System Map lattice. */
  readonly angle: number;
}

export interface SectorContext {
  readonly gates: readonly GateSpec[];
}

/** Persistent per-sector changes (profile `sectors`). */
export interface SectorSave {
  readonly done: readonly string[];
  readonly surveyed: boolean;
  /** Prompt 10: loot still inside partly taken containers or overflowing rewards (local id -> counts). */
  readonly left?: Readonly<Record<string, Readonly<Record<string, number>>>> | undefined;
}

export const EMPTY_SECTOR_SAVE: SectorSave = Object.freeze({ done: Object.freeze([]), surveyed: false });

export const globalPoiId = (systemId: string, localId: string): string => `${systemId}#${localId}`;

/** Local POI id grammar (also enforced by the profile sanitizer, which cannot import this). */
export const POI_ID = /^[a-z]+(?:-[0-9]+(?:\.[0-9]+)?)?$|^gate:[a-z0-9-]+\/[a-z0-9-]+$/;
