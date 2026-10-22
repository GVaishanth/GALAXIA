/**
 * Local-sector archetypes (content data). The five WORLD_DESIGN §4.3 archetypes
 * (gate hub, asteroid belt, derelict yard, nebula pocket, relay outpost) plus
 * five for the astrophysical destinations this catalogue adds. Values are
 * generator defaults; the builder scales them by difficulty, richness and threat.
 */
import type { SectorArchetype, SectorArchetypeId, SystemCategory } from '../types.ts';

export const ARCHETYPES: readonly SectorArchetype[] = [
  { id: 'gate-hub', label: 'Gate hub', size: 4096, density: 0.2, salvageBase: 8, encounterBase: 2, station: true, hazards: ['none', 'dust'] },
  { id: 'relay-outpost', label: 'Relay outpost', size: 3584, density: 0.15, salvageBase: 6, encounterBase: 2, station: true, hazards: ['none', 'ion-storm'] },
  { id: 'asteroid-belt', label: 'Asteroid belt', size: 4608, density: 0.65, salvageBase: 12, encounterBase: 3, station: false, hazards: ['dust', 'gravity-shear', 'none'] },
  { id: 'derelict-yard', label: 'Derelict yard', size: 4096, density: 0.45, salvageBase: 16, encounterBase: 3, station: false, hazards: ['none', 'radiation', 'dust'] },
  { id: 'nebula-pocket', label: 'Nebula pocket', size: 5120, density: 0.3, salvageBase: 9, encounterBase: 3, station: false, hazards: ['dust', 'ion-storm', 'radiation'] },
  { id: 'stellar-forge', label: 'Stellar forge', size: 5120, density: 0.35, salvageBase: 8, encounterBase: 3, station: false, hazards: ['radiation', 'flare', 'dust'] },
  { id: 'compact-remnant', label: 'Compact remnant', size: 4096, density: 0.25, salvageBase: 10, encounterBase: 4, station: false, hazards: ['gravity-shear', 'radiation'] },
  { id: 'cluster-field', label: 'Cluster field', size: 4608, density: 0.4, salvageBase: 10, encounterBase: 4, station: false, hazards: ['flare', 'gravity-shear', 'radiation'] },
  { id: 'void-drift', label: 'Void drift', size: 6144, density: 0.06, salvageBase: 4, encounterBase: 1, station: false, hazards: ['none'] },
  { id: 'shock-front', label: 'Shock front', size: 5632, density: 0.5, salvageBase: 12, encounterBase: 4, station: false, hazards: ['flare', 'radiation', 'ion-storm'] },
];

const STAR: readonly SectorArchetypeId[] = ['gate-hub', 'relay-outpost', 'asteroid-belt', 'derelict-yard', 'nebula-pocket', 'stellar-forge', 'void-drift'];
const REMNANT: readonly SectorArchetypeId[] = ['compact-remnant', 'derelict-yard'];

/** Which sector archetypes make physical sense for each system category. */
export const CATEGORY_ARCHETYPES: Readonly<Record<SystemCategory, readonly SectorArchetypeId[]>> = {
  'yellow-dwarf': STAR,
  'orange-dwarf': STAR,
  'red-dwarf': STAR,
  'blue-giant': STAR,
  'red-giant': STAR,
  'binary-star': STAR,
  'multiple-star': STAR,
  'white-dwarf': REMNANT,
  'neutron-star': REMNANT,
  'black-hole': REMNANT,
  'stellar-nursery': ['stellar-forge', 'nebula-pocket'],
  'star-cluster': ['cluster-field'],
  'supernova-remnant': ['shock-front', 'nebula-pocket', 'compact-remnant'],
  'supernova-site': ['shock-front'],
  'dark-nebula': ['nebula-pocket'],
  'debris-field': ['derelict-yard'],
  'asteroid-field': ['asteroid-belt'],
  'relay-station': ['relay-outpost', 'gate-hub'],
  'deep-void': ['void-drift'],
  'satellite-galaxy': ['cluster-field', 'void-drift'],
  'galactic-structure': ['shock-front', 'nebula-pocket', 'compact-remnant', 'cluster-field'],
  anomaly: ['gate-hub', 'relay-outpost', 'asteroid-belt', 'derelict-yard', 'nebula-pocket', 'stellar-forge', 'compact-remnant', 'cluster-field', 'void-drift', 'shock-front'],
};
