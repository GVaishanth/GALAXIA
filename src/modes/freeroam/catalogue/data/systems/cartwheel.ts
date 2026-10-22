/**
 * Cartwheel Galaxy systems (content data). Two real features (the expanding
 * outer ring and the bright core) with cited facts; the rest is GALAXIA fiction.
 */
import type { GalaxySystems } from '../../types.ts';

export const CARTWHEEL_SYSTEMS: GalaxySystems = {
  galaxyId: 'cartwheel',
  rows: [
    {
      slug: 'hubstone', name: 'Hubstone', category: 'relay-station', provenance: 'fictional',
      description: 'A massive station bolted to the galaxy’s calm hub, the Guild’s farthest outpost.',
      difficulty: 4, resources: ['alloy', 'scrap', 1], encounters: [1, 'patrols', ['tessellate', 'haven-guild']], discovery: 'charted',
      links: ['gleaners-rest', 'linchpin', 'felloe-belt'], archetype: 'gate-hub', gateway: true,
    },
    {
      slug: 'gleaners-rest', name: 'Gleaner’s Rest', category: 'orange-dwarf', provenance: 'fictional',
      description: 'A harvest camp where crews gather the leavings of the last great collision.',
      difficulty: 4, resources: ['scrap', 'relic', 2], encounters: [2, 'patrols', ['red-tally', 'haven-guild']], discovery: 'charted',
      links: ['wainwright', 'trundle'], archetype: 'gate-hub',
    },
    {
      slug: 'linchpin', name: 'Linchpin', category: 'relay-station', provenance: 'fictional',
      description: 'The relay that holds the spoke roads together; lose it and the lanes fall apart.',
      difficulty: 4, resources: ['circuits', 'relic', 2], encounters: [2, 'convoy-raids', ['red-tally', 'gleaners']], discovery: 'charted',
      links: ['rutted-way'], archetype: 'relay-outpost', hazard: 'ion-storm',
    },
    {
      slug: 'felloe-belt', name: 'Felloe Belt', category: 'asteroid-field', provenance: 'fictional',
      description: 'A curved rim of rock, like the wooden rim of a wheel, grinding slowly outward.',
      difficulty: 4, resources: ['alloy', 'scrap', 3], encounters: [2, 'nest', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['oxbow'], archetype: 'asteroid-belt',
    },
    {
      slug: 'wainwright', name: 'Wainwright', category: 'yellow-dwarf', provenance: 'fictional',
      description: 'A yellow star whose shipwrights build sturdy haulers for the ring roads.',
      difficulty: 4, resources: ['alloy', 'circuits', 2], encounters: [2, 'patrols', ['tessellate', 'gleaners']], discovery: 'rumoured',
      links: ['furrowlands'], archetype: 'derelict-yard',
    },
    {
      slug: 'trundle', name: 'Trundle', category: 'red-dwarf', provenance: 'fictional',
      description: 'A slow red dwarf rolling along the spoke with a tail of icy cargo pods.',
      difficulty: 4, resources: ['ice', 'fuel', 2], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['chaffcloud'], archetype: 'asteroid-belt', hazard: 'none',
    },
    {
      slug: 'rutted-way', name: 'Rutted Way', category: 'debris-field', provenance: 'fictional',
      description: 'A spoke road worn deep with wreckage from every convoy that tried to reach the ring.',
      difficulty: 5, resources: ['scrap', 'relic', 3], encounters: [3, 'ambush', ['red-tally', 'tessellate', 'gleaners']], discovery: 'rumoured',
      links: ['cartwheel-outer-ring'], archetype: 'derelict-yard', hazard: 'radiation',
    },
    {
      slug: 'oxbow', name: 'Oxbow', category: 'binary-star', provenance: 'fictional',
      description: 'Two suns bound in a tight curve; their shared lane loops back on itself.',
      difficulty: 4, resources: ['fuel', 'crystal', 2], encounters: [2, 'patrols', ['cordon']], discovery: 'rumoured',
      links: ['ripplemark'], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'furrowlands', name: 'Furrowlands', category: 'asteroid-field', provenance: 'procedural',
      description: 'Seed-generated furrows of rock between the spokes, re-laid for every survey contract.',
      difficulty: 4, resources: ['scrap', 'ice', 1], encounters: [2, 'patrols', ['tessellate', 'gleaners']], discovery: 'uncharted',
      links: [], archetype: 'asteroid-belt', hazard: 'dust',
    },
    {
      slug: 'chaffcloud', name: 'Chaffcloud', category: 'dark-nebula', provenance: 'fictional',
      description: 'A cloud of fine husks blown off the ring, perfect cover for Tessellate ambushes.',
      difficulty: 5, resources: ['fuel', 'crystal', 2], encounters: [3, 'swarm-tide', ['tessellate']], discovery: 'uncharted',
      links: ['threshing-light'], archetype: 'nebula-pocket',
    },
    {
      slug: 'cartwheel-outer-ring', name: 'Cartwheel Outer Ring', category: 'galactic-structure', provenance: 'verified-object',
      sources: ['esa-webb-cartwheel', 'esawebb-weic2211'],
      fact: 'The Cartwheel’s colourful outer ring has been expanding into its surroundings for about 440 million years since the collision that formed the galaxy.',
      description: 'A vast wave of star formation rolling outward. The simulated sector rides the front, where new stars ignite.',
      difficulty: 5, resources: ['crystal', 'core-shard', 3], encounters: [3, 'gauntlet', ['cordon', 'tessellate']], discovery: 'rumoured',
      links: ['spokefall', 'cartwheel-core'], archetype: 'shock-front', hazard: 'flare',
    },
    {
      slug: 'ripplemark', name: 'Ripplemark', category: 'star-cluster', provenance: 'fictional',
      description: 'A cluster pressed into ridges by the passing collision wave, like sand after the tide.',
      difficulty: 5, resources: ['core-shard', 'relic', 2], encounters: [3, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['spokefall'], archetype: 'cluster-field',
    },
    {
      slug: 'threshing-light', name: 'Threshing Light', category: 'white-dwarf', provenance: 'fictional',
      description: 'A white dwarf beating a disk of debris into dust; the Red Tally sift it for core shards.',
      difficulty: 5, resources: ['core-shard', 'scrap', 2], encounters: [2, 'ambush', ['red-tally']], discovery: 'uncharted',
      links: [], archetype: 'compact-remnant', hazard: 'radiation',
    },
    {
      slug: 'spokefall', name: 'Spokefall', category: 'blue-giant', provenance: 'fictional',
      description: 'A brilliant young star born where a spoke meets the ring, flaring constantly.',
      difficulty: 5, resources: ['crystal', 'fuel', 3], encounters: [3, 'nest', ['tessellate']], discovery: 'uncharted',
      links: [], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'cartwheel-core', name: 'Cartwheel Core', category: 'galactic-structure', provenance: 'verified-object',
      sources: ['esa-webb-cartwheel', 'esawebb-weic2211'],
      fact: 'In Webb’s infrared image the Cartwheel’s core glows with large amounts of hot dust, and its brightest patches are huge clusters of young stars.',
      description: 'The dusty, blazing hub of the wheel. The simulated sector circles its clusters through thick, hot dust.',
      difficulty: 5, resources: ['core-shard', 'relic', 3], encounters: [3, 'gauntlet', ['cordon', 'tessellate']], discovery: 'hidden',
      links: ['the-hush'], archetype: 'cluster-field', hazard: 'radiation', needs: { systems: ['cartwheel-outer-ring'] },
    },
    {
      slug: 'the-hush', name: 'The Hush', category: 'anomaly', provenance: 'speculative',
      note: 'Built around a boson star, a hypothetical compact object made of exotic particles; none is known to exist.',
      description: 'A heavy, invisible presence that swallows sound on every channel, imagined as a boson star.',
      difficulty: 5, resources: ['relic', 'core-shard', 3], encounters: [3, 'sentinels', ['cordon']], discovery: 'hidden',
      links: [], archetype: 'compact-remnant', hazard: 'gravity-shear', needs: { systems: ['cartwheel-core'], surveys: 60 },
    },
  ],
};
