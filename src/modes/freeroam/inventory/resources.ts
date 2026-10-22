/**
 * Resource catalogue (Free Roam Prompt 10). Pure data: every cargo resource
 * with its stable id, name, description, category, rarity, stack size, value,
 * acquisition sources and permitted uses.
 *
 * All resources are game fiction. Some borrow everyday words (alloy, ice,
 * crystal), but none is presented as a real material, a real scientific
 * sample or a real discovery; descriptions say what each one does in the game.
 *
 *  - id        stable and saved in profiles (catalogue/types.ts RESOURCE_IDS):
 *              never rename or remove one.
 *  - stack     units per cargo stack. Every unit takes one hold unit; stacks
 *              group the hold for display and for JETTISON.
 *  - value     relative worth: decides what TAKE WHAT FITS keeps first and
 *              what SWAP offers to throw out. There is no trading yet.
 *  - sources   where it can come from; checked against the loot tables, the
 *              milestones and the ore veins by tests/inventory.test.ts.
 *  - uses      what it is spent on (fabricator recipes, ship licences);
 *              checked against the recipes and the roster by the same test.
 */
import { RESOURCE_IDS, type ResourceId } from '../catalogue/types.ts';

export const RESOURCE_CATEGORIES = ['alloys', 'reactor', 'circuitry', 'crystals', 'samples', 'navdata', 'artefacts', 'components'] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const RARITIES = ['common', 'uncommon', 'rare'] as const;
export type Rarity = (typeof RARITIES)[number];

/** Where resources come from (one loot table or reward family per source). */
export const LOOT_SOURCES = ['enemy', 'container', 'wreck', 'mining', 'salvage', 'anomaly', 'outpost', 'encounter', 'mission', 'milestone'] as const;
export type LootSource = (typeof LOOT_SOURCES)[number];

/** What resources are spent on. */
export const RESOURCE_USES = ['fabrication', 'licence'] as const;
export type ResourceUse = (typeof RESOURCE_USES)[number];

export interface ResourceDef {
  readonly id: ResourceId;
  readonly name: string;
  /** Short HUD label (at most 10 characters). */
  readonly short: string;
  readonly description: string;
  readonly category: ResourceCategory;
  readonly rarity: Rarity;
  /** Units per stack (1..99). */
  readonly stack: number;
  /** Relative value per unit (1..100). */
  readonly value: number;
  readonly sources: readonly LootSource[];
  readonly uses: readonly ResourceUse[];
}

export const CATEGORY_INFO: Readonly<Record<ResourceCategory, { readonly label: string; readonly short: string }>> = Object.freeze({
  alloys: { label: 'Salvaged alloys', short: 'ALLOYS' },
  reactor: { label: 'Reactor components', short: 'REACTOR' },
  circuitry: { label: 'Advanced circuitry', short: 'CIRCUITS' },
  crystals: { label: 'Energy crystals', short: 'CRYSTALS' },
  samples: { label: 'Research samples', short: 'SAMPLES' },
  navdata: { label: 'Navigation data', short: 'NAV DATA' },
  artefacts: { label: 'Rare artefacts', short: 'ARTEFACTS' },
  components: { label: 'Ship components', short: 'PARTS' },
});

export const RARITY_LABEL: Readonly<Record<Rarity, string>> = Object.freeze({ common: 'Common', uncommon: 'Uncommon', rare: 'Rare' });

const R = (d: ResourceDef): ResourceDef => Object.freeze({ ...d, sources: Object.freeze([...d.sources]), uses: Object.freeze([...d.uses]) });

export const RESOURCES: Readonly<Record<ResourceId, ResourceDef>> = Object.freeze({
  scrap: R({
    id: 'scrap',
    name: 'Hull scrap',
    short: 'SCRAP',
    description: 'Torn plating and bent framing cut from wrecks and drifting debris. The bulk filler of every fabricator recipe.',
    category: 'alloys',
    rarity: 'common',
    stack: 50,
    value: 1,
    sources: ['enemy', 'container', 'wreck', 'mining', 'salvage', 'outpost', 'encounter', 'mission'],
    uses: ['fabrication', 'licence'],
  }),
  alloy: R({
    id: 'alloy',
    name: 'Refined alloy',
    short: 'ALLOY',
    description: 'Clean structural plate, already cut to fabricator stock. Frames, hardpoints and hold bulkheads are built from it.',
    category: 'alloys',
    rarity: 'common',
    stack: 40,
    value: 4,
    sources: ['enemy', 'container', 'wreck', 'mining', 'salvage', 'outpost', 'encounter', 'mission'],
    uses: ['fabrication', 'licence'],
  }),
  circuits: R({
    id: 'circuits',
    name: 'Circuit wafers',
    short: 'CIRCUITS',
    description: 'Sealed control boards pulled from consoles and drones. Weapon timing and sensor arrays need them.',
    category: 'circuitry',
    rarity: 'uncommon',
    stack: 25,
    value: 6,
    sources: ['enemy', 'container', 'wreck', 'salvage', 'outpost', 'encounter', 'mission'],
    uses: ['fabrication'],
  }),
  fuel: R({
    id: 'fuel',
    name: 'Reactor cells',
    short: 'CELLS',
    description: 'Charged power cells for small ship reactors. Drives and thrusters are fabricated around them.',
    category: 'reactor',
    rarity: 'common',
    stack: 30,
    value: 3,
    sources: ['enemy', 'container', 'wreck', 'salvage', 'outpost', 'encounter', 'mission'],
    uses: ['fabrication', 'licence'],
  }),
  ice: R({
    id: 'ice',
    name: 'Ice cores',
    short: 'ICE',
    description: 'Frozen reaction mass cut from icy rocks. Hold frames use it as ballast and coolant.',
    category: 'samples',
    rarity: 'common',
    stack: 40,
    value: 2,
    sources: ['container', 'wreck', 'mining', 'salvage', 'outpost', 'encounter', 'mission'],
    uses: ['fabrication', 'licence'],
  }),
  crystal: R({
    id: 'crystal',
    name: 'Lumen crystals',
    short: 'CRYSTAL',
    description: 'A game-invented lattice that holds a charge. Shield emitters and heavy weapons focus their energy through it.',
    category: 'crystals',
    rarity: 'uncommon',
    stack: 20,
    value: 7,
    sources: ['enemy', 'container', 'wreck', 'mining', 'salvage', 'anomaly', 'outpost', 'encounter', 'mission'],
    uses: ['fabrication', 'licence'],
  }),
  'core-shard': R({
    id: 'core-shard',
    name: 'Core shard',
    short: 'CORE',
    description: 'A splinter of a dead ship’s reactor core, still warm. Only the heaviest modules call for one. Never found in quiet starter sectors.',
    category: 'reactor',
    rarity: 'rare',
    stack: 10,
    value: 30,
    sources: ['enemy', 'container', 'wreck', 'salvage', 'anomaly', 'outpost', 'encounter', 'mission'],
    uses: ['fabrication'],
  }),
  relic: R({
    id: 'relic',
    name: 'Precursor relic',
    short: 'RELIC',
    description: 'An artefact of the Precursors, a vanished people invented for GALAXIA. Deep sensor arrays are tuned with one.',
    category: 'artefacts',
    rarity: 'rare',
    stack: 5,
    value: 50,
    sources: ['container', 'wreck', 'salvage', 'anomaly', 'outpost', 'encounter', 'mission'],
    uses: ['fabrication'],
  }),
  samples: R({
    id: 'samples',
    name: 'Field samples',
    short: 'SAMPLES',
    description: 'Sealed sensor readings and canisters taken at anomalies. Survey labs build long-range arrays from them.',
    category: 'samples',
    rarity: 'uncommon',
    stack: 20,
    value: 6,
    sources: ['enemy', 'container', 'mining', 'anomaly', 'mission', 'milestone'],
    uses: ['fabrication'],
  }),
  'nav-data': R({
    id: 'nav-data',
    name: 'Chart fragments',
    short: 'NAV DATA',
    description: 'Route recordings from beacons, scout cores and survey logs. Long-haul drives and sensor arrays are calibrated with them.',
    category: 'navdata',
    rarity: 'uncommon',
    stack: 25,
    value: 5,
    sources: ['enemy', 'container', 'wreck', 'anomaly', 'outpost', 'encounter', 'mission', 'milestone'],
    uses: ['fabrication'],
  }),
  components: R({
    id: 'components',
    name: 'Ship components',
    short: 'PARTS',
    description: 'Working actuators, couplings and emitter heads stripped from ships. Every fabricated module needs a few.',
    category: 'components',
    rarity: 'uncommon',
    stack: 20,
    value: 8,
    sources: ['enemy', 'container', 'wreck', 'salvage', 'outpost', 'encounter', 'mission', 'milestone'],
    uses: ['fabrication'],
  }),
});

/** Every resource in catalogue (save) order. */
export const RESOURCE_LIST: readonly ResourceDef[] = Object.freeze(RESOURCE_IDS.map((id) => RESOURCES[id]));

export const isResourceId = (x: unknown): x is ResourceId => typeof x === 'string' && (RESOURCE_IDS as readonly string[]).includes(x);

/** Display name; unknown ids (from an old or edited save) are shown as their id. */
export function resourceName(id: string): string {
  return isResourceId(id) ? RESOURCES[id].name : id.replace(/-/g, ' ');
}

/** Value per unit (unknown ids count as 1). */
export function resourceValue(id: string): number {
  return isResourceId(id) ? RESOURCES[id].value : 1;
}

/** Rare resources (never guaranteed, never at difficulty 1). */
export const RARE_IDS: readonly ResourceId[] = Object.freeze(RESOURCE_LIST.filter((r) => r.rarity === 'rare').map((r) => r.id));
