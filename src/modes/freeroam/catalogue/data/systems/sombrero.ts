/**
 * Sombrero Galaxy (M104) systems (content data). One real feature (the dusty
 * outer ring imaged by Webb) with cited facts; the rest is GALAXIA fiction.
 */
import type { GalaxySystems } from '../../types.ts';

export const SOMBRERO_SYSTEMS: GalaxySystems = {
  galaxyId: 'sombrero',
  rows: [
    {
      slug: 'mesa-crossing', name: 'Mesa Crossing', category: 'relay-station', provenance: 'fictional',
      description: 'A flat-topped station on a lonely rubble mesa, the Guild’s only crossing into the Sombrero.',
      difficulty: 3, resources: ['scrap', 'fuel', 1], encounters: [1, 'patrols', ['red-tally', 'haven-guild']], discovery: 'charted',
      links: ['arroyo-light', 'drywash', 'ochre-basin'], archetype: 'gate-hub', gateway: true, hazard: 'dust',
    },
    {
      slug: 'arroyo-light', name: 'Arroyo Light', category: 'yellow-dwarf', provenance: 'fictional',
      description: 'A yellow star shining down a dry canyon of debris where water haulers once ran.',
      difficulty: 3, resources: ['ice', 'scrap', 1], encounters: [1, 'patrols', ['tessellate', 'haven-guild']], discovery: 'charted',
      links: ['ironwood', 'butte-twins'], archetype: 'gate-hub', hazard: 'dust',
    },
    {
      slug: 'drywash', name: 'Drywash', category: 'relay-station', provenance: 'fictional',
      description: 'A sun-bleached relay that wakes only when a dust flood rolls through.',
      difficulty: 3, resources: ['circuits', 'fuel', 1], encounters: [2, 'convoy-raids', ['red-tally', 'gleaners']], discovery: 'charted',
      links: ['wreckline'], archetype: 'relay-outpost',
    },
    {
      slug: 'ochre-basin', name: 'Ochre Basin', category: 'asteroid-field', provenance: 'fictional',
      description: 'A basin of rust-red rock rich in alloy and thick with claim markers.',
      difficulty: 3, resources: ['alloy', 'scrap', 2], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'charted',
      links: ['caliche'], archetype: 'asteroid-belt',
    },
    {
      slug: 'ironwood', name: 'Ironwood', category: 'orange-dwarf', provenance: 'fictional',
      description: 'A tough orange star ringed by dense, slow-growing alloy rock that dulls mining lasers.',
      difficulty: 3, resources: ['alloy', 'fuel', 2], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'rumoured',
      links: ['playa'], archetype: 'asteroid-belt', hazard: 'none',
    },
    {
      slug: 'butte-twins', name: 'Butte Twins', category: 'binary-star', provenance: 'fictional',
      description: 'Two suns standing over towering rubble buttes; Red Tally snipers hold the high ground.',
      difficulty: 4, resources: ['alloy', 'relic', 2], encounters: [3, 'ambush', ['red-tally']], discovery: 'rumoured',
      links: ['haloclast'], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'wreckline', name: 'Wreckline', category: 'debris-field', provenance: 'fictional',
      description: 'A straight line of wrecked convoys stretching for days, half-buried in dust.',
      difficulty: 4, resources: ['scrap', 'circuits', 3], encounters: [2, 'nest', ['tessellate', 'gleaners']], discovery: 'rumoured',
      links: ['dustmantle'], archetype: 'derelict-yard', hazard: 'dust',
    },
    {
      slug: 'caliche', name: 'Caliche', category: 'red-dwarf', provenance: 'fictional',
      description: 'A red dwarf crusted in hardened mineral dust that must be cracked open for ice.',
      difficulty: 4, resources: ['ice', 'crystal', 2], encounters: [2, 'patrols', ['tessellate']], discovery: 'rumoured',
      links: ['saguaro-spire'], archetype: 'nebula-pocket', hazard: 'dust',
    },
    {
      slug: 'playa', name: 'Playa', category: 'deep-void', provenance: 'procedural',
      description: 'A flat, seed-generated expanse of nothing, re-laid for every survey contract.',
      difficulty: 4, resources: ['fuel', null, 1], encounters: [1, 'patrols', ['red-tally']], discovery: 'uncharted',
      links: [], archetype: 'void-drift',
    },
    {
      slug: 'haloclast', name: 'Haloclast', category: 'star-cluster', provenance: 'fictional',
      description: 'An old cluster in the galaxy’s glowing halo, cracked by ancient collisions.',
      difficulty: 4, resources: ['core-shard', 'relic', 2], encounters: [3, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['sombrero-dust-ring'], archetype: 'cluster-field',
    },
    {
      slug: 'dustmantle', name: 'Dustmantle', category: 'dark-nebula', provenance: 'fictional',
      description: 'A thick mantle of dust where Tessellate tides surge without warning.',
      difficulty: 4, resources: ['fuel', 'crystal', 2], encounters: [3, 'swarm-tide', ['tessellate']], discovery: 'uncharted',
      links: ['sombrero-dust-ring', 'mirage-flats'], archetype: 'nebula-pocket',
    },
    {
      slug: 'saguaro-spire', name: 'Saguaro Spire', category: 'blue-giant', provenance: 'fictional',
      description: 'A lone blue giant standing tall over the badlands, armed with fierce flares.',
      difficulty: 4, resources: ['crystal', 'alloy', 2], encounters: [2, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['hardpan'], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'sombrero-dust-ring', name: 'Sombrero Dust Ring', category: 'galactic-structure', provenance: 'verified-object',
      sources: ['esawebb-sombrero'],
      fact: 'The Sombrero galaxy’s outer ring of dust, whose clumpy structure was resolved in Webb’s mid-infrared image released in November 2024.',
      description: 'The great dark brim of the galaxy. The simulated sector is a clumpy maze of dust banks along the ring.',
      difficulty: 5, resources: ['crystal', 'core-shard', 3], encounters: [3, 'gauntlet', ['cordon', 'tessellate']], discovery: 'rumoured',
      links: [], archetype: 'nebula-pocket',
    },
    {
      slug: 'mirage-flats', name: 'Mirage Flats', category: 'asteroid-field', provenance: 'procedural',
      description: 'Seed-built flats of shimmering pebbles, laid out fresh for every visit.',
      difficulty: 4, resources: ['scrap', 'crystal', 1], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'uncharted',
      links: [], archetype: 'asteroid-belt', hazard: 'dust',
    },
    {
      slug: 'hardpan', name: 'Hardpan', category: 'white-dwarf', provenance: 'fictional',
      description: 'A compact white dwarf baked into a field of fused slag; nothing grows here but Cordon towers.',
      difficulty: 5, resources: ['core-shard', 'alloy', 3], encounters: [3, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['the-glass-desert'], archetype: 'compact-remnant', hazard: 'radiation',
    },
    {
      slug: 'the-glass-desert', name: 'The Glass Desert', category: 'anomaly', provenance: 'speculative',
      note: 'Built around strange quark matter, a hypothetical form of matter that has never been found.',
      description: 'A plain of impossibly dense, glassy fragments that hum on the scanner, imagined as strange matter.',
      difficulty: 5, resources: ['relic', 'core-shard', 3], encounters: [3, 'gauntlet', ['cordon', 'gleaners']], discovery: 'hidden',
      links: [], archetype: 'asteroid-belt', hazard: 'gravity-shear', needs: { systems: ['hardpan', 'sombrero-dust-ring'] },
    },
  ],
};
