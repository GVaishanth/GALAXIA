/**
 * Which features each sector archetype contains, and how many (content data,
 * read by sector/generate.ts). Counts are inclusive [min, max] ranges rolled
 * from the system seed. Salvage node counts, encounter slots, hazard and the
 * station come from the catalogue's SectorConfig instead (catalogue/build.ts).
 */
import type { SectorArchetypeId, SystemCategory } from '../catalogue/types.ts';
import type { BodyStyle, StarStyle } from './model.ts';

export type Range = readonly [number, number];

export interface SectorFeatures {
  /** Planet-like bodies (landmarks / obstacles). */
  readonly bodies: Range;
  readonly asteroidFields: Range;
  /** Nebula or dust clouds (carry the sector hazard when it has one). */
  readonly clouds: Range;
  readonly derelicts: Range;
  readonly caches: Range;
  readonly anomalies: Range;
  readonly bodyStyles: readonly BodyStyle[];
}

export const SECTOR_FEATURES: Readonly<Record<SectorArchetypeId, SectorFeatures>> = {
  'gate-hub': { bodies: [1, 2], asteroidFields: [1, 1], clouds: [0, 1], derelicts: [1, 2], caches: [1, 2], anomalies: [0, 1], bodyStyles: ['rocky', 'ice', 'gas'] },
  'relay-outpost': { bodies: [1, 2], asteroidFields: [0, 1], clouds: [0, 1], derelicts: [1, 1], caches: [1, 2], anomalies: [0, 1], bodyStyles: ['rocky', 'ice', 'gas'] },
  'asteroid-belt': { bodies: [0, 1], asteroidFields: [3, 4], clouds: [0, 1], derelicts: [1, 1], caches: [2, 3], anomalies: [0, 1], bodyStyles: ['rocky', 'ice'] },
  'derelict-yard': { bodies: [0, 1], asteroidFields: [1, 2], clouds: [0, 1], derelicts: [3, 5], caches: [2, 3], anomalies: [0, 1], bodyStyles: ['rocky', 'gas'] },
  'nebula-pocket': { bodies: [0, 1], asteroidFields: [1, 1], clouds: [2, 3], derelicts: [1, 2], caches: [1, 2], anomalies: [1, 1], bodyStyles: ['ice', 'gas'] },
  'stellar-forge': { bodies: [1, 3], asteroidFields: [1, 2], clouds: [1, 2], derelicts: [0, 1], caches: [1, 2], anomalies: [1, 1], bodyStyles: ['molten', 'rocky', 'gas'] },
  'compact-remnant': { bodies: [0, 1], asteroidFields: [1, 2], clouds: [1, 1], derelicts: [1, 2], caches: [1, 2], anomalies: [1, 2], bodyStyles: ['rocky', 'molten'] },
  'cluster-field': { bodies: [0, 2], asteroidFields: [1, 2], clouds: [1, 1], derelicts: [1, 1], caches: [1, 2], anomalies: [1, 1], bodyStyles: ['rocky', 'gas', 'ice'] },
  'void-drift': { bodies: [0, 1], asteroidFields: [0, 1], clouds: [0, 0], derelicts: [1, 2], caches: [1, 1], anomalies: [1, 1], bodyStyles: ['ice', 'rocky'] },
  'shock-front': { bodies: [0, 1], asteroidFields: [2, 2], clouds: [2, 2], derelicts: [1, 2], caches: [1, 2], anomalies: [1, 1], bodyStyles: ['molten', 'rocky'] },
};

/**
 * The sector's central landmark(s) by system category: star styles (several =
 * a binary, a multiple system or a cluster). An empty list = no star (deep
 * void). Purely visual; sizes come from the generator.
 */
export const CATEGORY_STARS: Readonly<Record<SystemCategory, readonly StarStyle[]>> = {
  'yellow-dwarf': ['yellow'],
  'orange-dwarf': ['orange'],
  'red-dwarf': ['red'],
  'blue-giant': ['blue'],
  'red-giant': ['red'],
  'white-dwarf': ['white'],
  'binary-star': ['blue', 'white'],
  'multiple-star': ['yellow', 'orange', 'red'],
  'neutron-star': ['neutron'],
  'black-hole': ['black-hole'],
  'stellar-nursery': ['protostar'],
  'star-cluster': ['blue', 'white', 'yellow', 'white'],
  'supernova-remnant': ['neutron'],
  'supernova-site': ['dim'],
  'dark-nebula': ['dim'],
  'debris-field': ['dim'],
  'asteroid-field': ['orange'],
  'relay-station': ['dim'],
  'deep-void': [],
  'satellite-galaxy': ['blue', 'yellow', 'white'],
  'galactic-structure': ['dim', 'white'],
  anomaly: ['anomaly-core'],
};

/** Giants are bigger; remnants are small but carry a wide hazard. [solid r, glow r] in art px. */
export const STAR_SIZE: Readonly<Record<StarStyle, readonly [number, number]>> = {
  yellow: [110, 230],
  orange: [96, 200],
  red: [80, 170],
  blue: [150, 320],
  white: [46, 140],
  neutron: [26, 200],
  'black-hole': [70, 300],
  protostar: [90, 220],
  'anomaly-core': [60, 200],
  dim: [60, 120],
};
