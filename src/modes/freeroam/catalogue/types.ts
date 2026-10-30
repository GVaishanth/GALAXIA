/**
 * Free Roam catalogue types (Prompt 3). Pure type and enum definitions only:
 * no data, no logic beyond constant tables. Every enum is a readonly tuple so
 * the validator can check untrusted input (for example a future JSON data
 * pack) against the same source of truth the compiler uses.
 *
 * Provenance model (docs/freeroam/CONTENT_PROVENANCE.md):
 *   galaxy  -> 'verified-destination'  real galaxy, used as a destination and theme
 *   system  -> 'verified-object'       real object, real facts cited; the playable sector is still a simulation
 *            -> 'fictional'            authored GALAXIA location, invented
 *            -> 'procedural'           placeholder identity; content comes from the seed and archetype only
 *            -> 'speculative'          built around a hypothetical phenomenon (labelled as such in `note`)
 */

/** 2: Prompt 4 added routes, milestones, progression and `shortName`; galaxy `routes` moved to RouteRecord. */
export const CATALOGUE_VERSION = 2;

/* ------------------------------------------------------------------ enums */

export const GALAXY_IDS = ['milky-way', 'andromeda', 'triangulum', 'lmc', 'smc', 'whirlpool', 'pinwheel', 'sombrero', 'centaurus-a', 'cartwheel'] as const;
export type GalaxyId = (typeof GALAXY_IDS)[number];

/** Broad morphology used by gameplay and the future map renderer. The precise published type lives in `Morphology.code`. */
export const GALAXY_CLASSES = [
  'barred-spiral',
  'spiral',
  'intermediate-spiral',
  'magellanic-spiral',
  'dwarf-irregular',
  'interacting-spiral',
  'spiral-or-elliptical',
  'peculiar-elliptical',
  'ring',
] as const;
export type GalaxyClass = (typeof GALAXY_CLASSES)[number];

export const GALAXY_RELATIONS = ['home', 'local-group-member', 'milky-way-satellite', 'interacting-pair', 'beyond-local-group'] as const;
export type GalaxyRelation = (typeof GALAXY_RELATIONS)[number];

/** Map silhouette used by the galaxy-map art generator (galaxy/galaxyArt.ts). */
export const MAP_SHAPES = ['barred-spiral', 'tilted-spiral', 'loose-spiral', 'magellanic-bar', 'irregular-wing', 'spiral-with-companion', 'face-on-spiral', 'edge-on-disk', 'lens-with-dust-lane', 'ring'] as const;
export type MapShape = (typeof MAP_SHAPES)[number];

export const SYSTEM_PROVENANCE = ['verified-object', 'fictional', 'procedural', 'speculative'] as const;
export type SystemProvenanceStatus = (typeof SYSTEM_PROVENANCE)[number];

export const SYSTEM_CATEGORIES = [
  // star systems
  'yellow-dwarf',
  'orange-dwarf',
  'red-dwarf',
  'blue-giant',
  'red-giant',
  'white-dwarf',
  'binary-star',
  'multiple-star',
  'neutron-star',
  'black-hole',
  // environments
  'stellar-nursery',
  'star-cluster',
  'supernova-remnant',
  'supernova-site',
  'dark-nebula',
  'debris-field',
  'asteroid-field',
  'relay-station',
  'deep-void',
  // galaxy-scale features used as destinations
  'satellite-galaxy',
  'galactic-structure',
  'anomaly',
] as const;
export type SystemCategory = (typeof SYSTEM_CATEGORIES)[number];

/**
 * Cargo resources; extends WORLD_DESIGN §8.1 (scrap, alloy, circuit, fuel cell, core shard, signal beacon -> relic).
 * Ids are saved in profiles: never rename or remove one. Prompt 10 appended samples, nav-data and
 * components; names, categories, rarity and values live in inventory/resources.ts.
 */
export const RESOURCE_IDS = ['scrap', 'alloy', 'circuits', 'fuel', 'ice', 'crystal', 'core-shard', 'relic', 'samples', 'nav-data', 'components'] as const;
export type ResourceId = (typeof RESOURCE_IDS)[number];

/**
 * Factions (Free Roam Prompt 9, docs/freeroam/FACTIONS.md). Identities, lore,
 * markings and the relationship matrix live in combat/factions.ts; the
 * catalogue only says who is present in a system.
 *   tessellate   autonomous machine fleet      hostile
 *   red-tally    organised raiders             hostile
 *   cordon       hostile security force        hostile
 *   gleaners     independent scavengers        wary (neutral until provoked)
 *   haven-guild  station owners                friendly (no ships)
 */
export const FACTION_IDS = ['tessellate', 'red-tally', 'cordon', 'gleaners', 'haven-guild'] as const;
export type FactionId = (typeof FACTION_IDS)[number];
export const HOSTILE_FACTIONS: readonly FactionId[] = ['tessellate', 'red-tally', 'cordon'];
/** Neutral until provoked: present without making a system threatening. */
export const WARY_FACTIONS: readonly FactionId[] = ['gleaners'];
/** Faction ids used before Prompt 9, accepted in authored data and mapped to the new factions. */
export const LEGACY_FACTION_ALIASES: Readonly<Record<string, FactionId>> = Object.freeze({ swarm: 'tessellate', 'rust-corsairs': 'red-tally', 'wardens-choir': 'cordon' });
/** A known faction id, or the faction a legacy id maps to; anything else is returned unchanged (and rejected by the validator). */
export const normalFaction = (id: string): string => LEGACY_FACTION_ALIASES[id] ?? id;

export const ENCOUNTER_PATTERNS = ['none', 'patrols', 'ambush', 'nest', 'swarm-tide', 'sentinels', 'convoy-raids', 'gauntlet'] as const;
export type EncounterPattern = (typeof ENCOUNTER_PATTERNS)[number];

/**
 * Initial discovery state (before the player does anything). The system map
 * (galaxy/systems.ts) turns it into what the player knows:
 *   charted   known (named) on the system map from the start
 *   rumoured  an unnamed signal from the start
 *   uncharted invisible until a lane neighbour is visited (signal) or charted (known)
 *   hidden    a sealed system (needs >= 1 unlock requirement): invisible until a lane
 *             neighbour is charted, then a locked, unnamed signal; once unlocked it is
 *             at least a signal and follows the uncharted rules
 */
export const DISCOVERY_STATES = ['charted', 'rumoured', 'uncharted', 'hidden'] as const;
export type DiscoveryState = (typeof DISCOVERY_STATES)[number];

export const SECTOR_ARCHETYPES = ['gate-hub', 'relay-outpost', 'asteroid-belt', 'derelict-yard', 'nebula-pocket', 'stellar-forge', 'compact-remnant', 'cluster-field', 'void-drift', 'shock-front'] as const;
export type SectorArchetypeId = (typeof SECTOR_ARCHETYPES)[number];

export const HAZARDS = ['none', 'dust', 'ion-storm', 'radiation', 'flare', 'gravity-shear'] as const;
export type HazardId = (typeof HAZARDS)[number];

/**
 * Inter-galaxy route classes (Prompt 4). Pure game fiction, never a physical claim:
 *   local-lane  short hop between neighbours (the Milky Way and its satellites)
 *   gate-jump   needs or uses a jump gate
 *   deep-jump   long drive jump across intergalactic space
 *   rift-jump   extreme-range jump (endgame)
 */
export const ROUTE_CLASSES = ['local-lane', 'gate-jump', 'deep-jump', 'rift-jump'] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];
export const ROUTE_RISKS = ['low', 'moderate', 'high', 'extreme'] as const;
export type RouteRisk = (typeof ROUTE_RISKS)[number];

/** Milestone kinds the unlock system understands (config-driven; see data/milestones.ts). */
export const MILESTONE_KINDS = ['starter-objective', 'navigation-data', 'exploration-level', 'regional-mission', 'jump-gate'] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

/* ---------------------------------------------------------------- limits */

export const LIMITS = Object.freeze({
  galaxies: 10,
  systemsPerGalaxy: { min: 15, max: 20 },
  systemsTotal: { min: 150, max: 200 },
  difficulty: { min: 1, max: 5 },
  driveTier: { min: 1, max: 5 },
  surveys: { min: 1, max: 100 },
  /** Direct routes per galaxy: at least one, and never a fully connected map. */
  routesPerGalaxy: { min: 1, max: 4 },
  routeCost: { min: 1, max: 5 },
  explorationPercent: { min: 1, max: 100 },
  explorerLevel: { min: 2, max: 50 },
  explorerLevelStep: { min: 1, max: 20 },
  shortNameLength: { min: 3, max: 12 },
  milestoneDescriptionLength: { min: 20, max: 160 },
  connectionsPerSystem: { min: 1, max: 5 },
  /** Square-ish sector in world units; multiples of SECTOR_GRID. */
  sectorSize: { min: 2048, max: 6144 },
  sectorGrid: 256,
  salvageNodes: { min: 0, max: 32 },
  encounterSlots: { min: 0, max: 10 },
  nameLength: { min: 3, max: 28 },
  descriptionLength: { min: 30, max: 240 },
  factLength: { min: 20, max: 260 },
});

/* --------------------------------------------------------------- sources */

/** What the game shows of a reference: its id and title (data/sourceTitles.ts; the shipped catalogue holds only these). */
export interface SourceRef {
  readonly id: string;
  readonly title: string;
}

/** One cited reference. Stored locally; the game never fetches it (data/sources.ts: validation, tests, docs). */
export interface SourceRecord extends SourceRef {
  readonly publisher: string;
  readonly url: string;
  /** ISO date the page was read for this catalogue. */
  readonly retrieved: string;
  /** 'primary' = agency, observatory or peer-reviewed; 'secondary' = encyclopedia, cross-check only. */
  readonly tier: 'primary' | 'secondary';
}

export interface CitedFact {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

/* -------------------------------------------------------------- galaxies */

export interface Morphology {
  readonly class: GalaxyClass;
  /** Published Hubble / de Vaucouleurs type where one exists (secondary-sourced). */
  readonly code: string | null;
  /** Caveats: disputed or alternative classifications. */
  readonly note: string | null;
}

export interface DistanceRange {
  /** Light-years. low === high when sources agree on one rounded value. */
  readonly low: number;
  readonly high: number;
}

export type UnlockRequirement =
  | { readonly kind: 'system'; readonly systemId: string }
  | { readonly kind: 'galaxy'; readonly galaxyId: string }
  | { readonly kind: 'drive'; readonly tier: number }
  | { readonly kind: 'surveys'; readonly count: number }
  | { readonly kind: 'milestone'; readonly milestoneId: string };

export interface GalaxyTheme {
  /** Two #rrggbb accents for future map and HUD tinting. */
  readonly accent: readonly [string, string];
  readonly mapShape: MapShape;
  /** One line of GALAXIA flavour, explicitly fiction. */
  readonly motif: string;
}

export interface GalaxyGameplay {
  /** Progression tier 1 (start) .. 5 (endgame). */
  readonly tier: number;
  /** Inclusive difficulty band every system in the galaxy must sit inside. */
  readonly difficultyBand: readonly [number, number];
  readonly gatewaySystemId: string;
  /** Destination unlock (Prompt 4: milestone requirements). Travel also needs an open route (RouteRecord). */
  readonly unlock: readonly UnlockRequirement[];
  readonly theme: GalaxyTheme;
}

export interface GalaxyRecord {
  readonly id: GalaxyId;
  readonly name: string;
  /** Map label (<= 12 characters), e.g. "LMC" for the Large Magellanic Cloud. */
  readonly shortName: string;
  readonly designations: readonly string[];
  readonly morphology: Morphology;
  readonly relation: GalaxyRelation;
  /** Where the relation names another galaxy (e.g. satellite of the Milky Way). */
  readonly relatedTo: GalaxyId | null;
  readonly constellation: string;
  /** null for the Milky Way (we are inside it). */
  readonly distanceLy: DistanceRange | null;
  readonly description: string;
  readonly facts: readonly CitedFact[];
  readonly provenance: { readonly status: 'verified-destination'; readonly sourceIds: readonly string[] };
  readonly gameplay: GalaxyGameplay;
}

/* --------------------------------------------------------------- systems */

export interface SystemProvenance {
  readonly status: SystemProvenanceStatus;
  /** Required (>= 1) for verified objects; must be empty otherwise. */
  readonly sourceIds: readonly string[];
  /** Verified: what is real vs simulated. Speculative: what is hypothetical. */
  readonly note: string | null;
}

export interface ResourceProfile {
  readonly primary: ResourceId;
  readonly secondary: ResourceId | null;
  /** 1 sparse .. 3 rich. */
  readonly richness: number;
}

export interface EncounterProfile {
  /** 0 safe .. 3 deadly. */
  readonly threat: number;
  readonly pattern: EncounterPattern;
  readonly factions: readonly FactionId[];
}

export interface SectorConfig {
  readonly archetype: SectorArchetypeId;
  readonly width: number;
  readonly height: number;
  /** Obstacle coverage 0..1 (asteroids, wrecks, gas). */
  readonly density: number;
  readonly salvageNodes: number;
  readonly encounterSlots: number;
  readonly hazard: HazardId;
  /** 0 when hazard is 'none', otherwise (0, 1]. */
  readonly hazardStrength: number;
  /** A Haven Guild dock exists in the sector (repairs, trade). */
  readonly station: boolean;
}

export interface SystemRecord {
  /** `${galaxyId}/${slug}`; stable even if the display name changes. */
  readonly id: string;
  readonly galaxyId: GalaxyId;
  readonly name: string;
  readonly category: SystemCategory;
  /** Gameplay description. For verified objects the real fact is in `fact`. */
  readonly description: string;
  /** Verified objects only: a cited real-world statement. null otherwise. */
  readonly fact: string | null;
  readonly provenance: SystemProvenance;
  readonly difficulty: number;
  readonly resources: ResourceProfile;
  readonly encounters: EncounterProfile;
  readonly discovery: DiscoveryState;
  readonly unlock: readonly UnlockRequirement[];
  /** Same-galaxy lanes (symmetric). */
  readonly connections: readonly string[];
  /** uint32, derived from the id (FNV-1a); stable across releases. */
  readonly seed: number;
  readonly sector: SectorConfig;
  readonly gateway: boolean;
}

/* ------------------------------------------------- routes and milestones */
/**
 * One inter-galaxy route (Prompt 4). Routes are symmetric: travel works both
 * ways, `from`/`to` only fix a canonical order. The id is `${from}~${to}` with
 * `from < to` (string order), so it is stable and unique per pair.
 * A route is open when its own `unlock` is met; travelling along it also needs
 * the destination galaxy unlocked.
 */
export interface RouteRecord {
  readonly id: string;
  readonly from: GalaxyId;
  readonly to: GalaxyId;
  /** Display name, GALAXIA fiction (e.g. "Lantern Gate jump"). */
  readonly name: string;
  readonly routeClass: RouteClass;
  /** Abstract drive charge 1..5. Stored for later fuel rules; nothing is spent yet. */
  readonly cost: number;
  readonly risk: RouteRisk;
  /** Encounter class reserved for transit events (later stage); 'none' = quiet. */
  readonly encounter: EncounterPattern;
  readonly unlock: readonly UnlockRequirement[];
}

export type MilestoneCondition =
  | { readonly kind: 'surveys-in'; readonly galaxyId: GalaxyId; readonly count: number }
  | { readonly kind: 'exploration'; readonly galaxyId: GalaxyId; readonly percent: number }
  | { readonly kind: 'explorer-level'; readonly level: number }
  | { readonly kind: 'milestone'; readonly milestoneId: string }
  | { readonly kind: 'all'; readonly of: readonly MilestoneCondition[] }
  | { readonly kind: 'any'; readonly of: readonly MilestoneCondition[] };

export interface MilestoneRewards {
  /** Jump Drive tier granted (satisfies `drive` requirements); null = none. */
  readonly driveTier: number | null;
  /** Systems charted immediately (navigation data). */
  readonly chartSystems: readonly string[];
}

export interface MilestoneRecord {
  readonly id: string;
  readonly kind: MilestoneKind;
  readonly name: string;
  /** Player-facing task, e.g. "Complete your first survey run in the Milky Way." */
  readonly description: string;
  readonly condition: MilestoneCondition;
  readonly rewards: MilestoneRewards;
}

export interface ProgressionConfig {
  /** Where every new pilot starts (must be the home galaxy). */
  readonly startGalaxy: GalaxyId;
  /** Explorer level = 1 + floor(systems charted / step). */
  readonly explorerLevelStep: number;
}

export interface Catalogue {
  readonly version: number;
  readonly sources: readonly SourceRef[];
  readonly galaxies: readonly GalaxyRecord[];
  readonly systems: readonly SystemRecord[];
  readonly routes: readonly RouteRecord[];
  readonly milestones: readonly MilestoneRecord[];
  readonly progression: ProgressionConfig;
}

/* ------------------------------------------------------ authored row form */

/**
 * Compact authored form used by data/systems/*.ts. The builder expands it into
 * a SystemRecord (adds ids, seed, symmetric connections and the sector config).
 * Links and `needs` use slugs within the same galaxy.
 */
export interface SystemRow {
  readonly slug: string;
  readonly name: string;
  readonly category: SystemCategory;
  readonly provenance: SystemProvenanceStatus;
  readonly sources?: readonly string[];
  readonly fact?: string;
  readonly note?: string;
  readonly description: string;
  readonly difficulty: number;
  /** [primary, secondary | null, richness 1..3] */
  readonly resources: readonly [ResourceId, ResourceId | null, number];
  /** [threat 0..3, pattern, factions] */
  readonly encounters: readonly [number, EncounterPattern, readonly FactionId[]];
  readonly discovery: DiscoveryState;
  readonly links: readonly string[];
  readonly archetype: SectorArchetypeId;
  readonly hazard?: HazardId;
  readonly station?: boolean;
  readonly gateway?: boolean;
  readonly needs?: { readonly systems?: readonly string[]; readonly drive?: number; readonly surveys?: number };
}

export interface GalaxySystems {
  readonly galaxyId: GalaxyId;
  readonly rows: readonly SystemRow[];
}

/** Archetype defaults (data/archetypes.ts). */
export interface SectorArchetype {
  readonly id: SectorArchetypeId;
  readonly label: string;
  readonly size: number;
  readonly density: number;
  readonly salvageBase: number;
  readonly encounterBase: number;
  readonly station: boolean;
  /** First entry is the default hazard. */
  readonly hazards: readonly HazardId[];
}
