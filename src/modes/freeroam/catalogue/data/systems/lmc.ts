/**
 * Large Magellanic Cloud systems (content data). Two real objects (the
 * Tarantula Nebula and SN 1987A) with cited facts; the rest is GALAXIA fiction.
 */
import type { GalaxySystems } from '../../types.ts';

export const LMC_SYSTEMS: GalaxySystems = {
  galaxyId: 'lmc',
  rows: [
    {
      slug: 'southwind-landing', name: 'Southwind Landing', category: 'relay-station', provenance: 'fictional',
      description: 'The first Guild landing beyond the Milky Way, built where the jump lane drops out over a bright bar of stars.',
      difficulty: 1, resources: ['scrap', 'fuel', 1], encounters: [0, 'none', ['haven-guild']], discovery: 'charted',
      links: ['mariners-lamp', 'brinehold', 'kelp-lanes'], archetype: 'gate-hub', gateway: true,
    },
    {
      slug: 'mariners-lamp', name: 'Mariner’s Lamp', category: 'yellow-dwarf', provenance: 'fictional',
      description: 'A steady yellow sun used as a navigation lamp by every crew in the Cloud.',
      difficulty: 1, resources: ['fuel', 'circuits', 1], encounters: [1, 'patrols', ['tessellate', 'haven-guild']], discovery: 'charted',
      links: ['coral-spire', 'tidebreak'], archetype: 'gate-hub',
    },
    {
      slug: 'brinehold', name: 'Brinehold', category: 'red-dwarf', provenance: 'fictional',
      description: 'A salt-crusted mining hold carved into a comet, orbiting a sleepy red dwarf.',
      difficulty: 1, resources: ['ice', 'scrap', 2], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['galleon-rest'], archetype: 'asteroid-belt', hazard: 'none',
    },
    {
      slug: 'kelp-lanes', name: 'Kelp Lanes', category: 'asteroid-field', provenance: 'fictional',
      description: 'Long ribbons of dust-coated rock sway in the stellar wind like a kelp forest.',
      difficulty: 1, resources: ['scrap', 'ice', 1], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['shoalmark'], archetype: 'asteroid-belt',
    },
    {
      slug: 'coral-spire', name: 'Coral Spire', category: 'blue-giant', provenance: 'fictional',
      description: 'A blue giant lighting a reef of rock towers grown over centuries of debris impacts.',
      difficulty: 2, resources: ['crystal', 'alloy', 2], encounters: [1, 'nest', ['tessellate']], discovery: 'charted',
      links: ['tarantula-nebula'], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'tidebreak', name: 'Tidebreak', category: 'binary-star', provenance: 'fictional',
      description: 'Two suns pull a breakwater of rubble back and forth; the Red Tally surf the swell into ambushes.',
      difficulty: 2, resources: ['alloy', 'fuel', 2], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['gullwing-pass'], archetype: 'asteroid-belt', hazard: 'gravity-shear',
    },
    {
      slug: 'galleon-rest', name: 'Galleon Rest', category: 'debris-field', provenance: 'fictional',
      description: 'A graveyard of colony galleons, hulls still sealed. The Guild pays bounties for their logbooks.',
      difficulty: 2, resources: ['scrap', 'relic', 3], encounters: [1, 'patrols', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['spindrift-bar'], archetype: 'derelict-yard',
    },
    {
      slug: 'shoalmark', name: 'Shoalmark', category: 'asteroid-field', provenance: 'procedural',
      description: 'A seed-built shoal of drifting rock, laid out fresh for each charting run.',
      difficulty: 1, resources: ['scrap', null, 1], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'uncharted',
      links: ['swellward'], archetype: 'asteroid-belt',
    },
    {
      slug: 'tarantula-nebula', name: 'Tarantula Nebula', category: 'stellar-nursery', provenance: 'verified-object',
      sources: ['nasa-tarantula-webb'],
      fact: 'Also called 30 Doradus: the largest and brightest star-forming region in the Local Group, 161,000 light-years away in the LMC, home to some of the hottest, most massive stars known.',
      description: 'A colossal nursery of blazing young stars. The simulated sector threads glowing filaments thick with Tessellate builder-swarms.',
      difficulty: 2, resources: ['crystal', 'fuel', 3], encounters: [2, 'nest', ['tessellate']], discovery: 'rumoured',
      links: ['scrimshaw'], archetype: 'stellar-forge', hazard: 'radiation',
    },
    {
      slug: 'gullwing-pass', name: 'Gullwing Pass', category: 'relay-station', provenance: 'fictional',
      description: 'A relay strung across a narrow gap in the dust, beating like a gull’s wings in the solar wind.',
      difficulty: 2, resources: ['circuits', 'fuel', 1], encounters: [1, 'convoy-raids', ['red-tally', 'haven-guild', 'gleaners']], discovery: 'rumoured',
      links: ['sn-1987a', 'scrimshaw'], archetype: 'relay-outpost',
    },
    {
      slug: 'spindrift-bar', name: 'Spindrift Bar', category: 'white-dwarf', provenance: 'fictional',
      description: 'A white dwarf trailing a sandbar of fine bright dust; ships leave glittering wakes.',
      difficulty: 2, resources: ['core-shard', 'ice', 2], encounters: [2, 'patrols', ['tessellate']], discovery: 'uncharted',
      links: ['undertow'], archetype: 'compact-remnant', hazard: 'radiation',
    },
    {
      slug: 'swellward', name: 'Swellward', category: 'deep-void', provenance: 'procedural',
      description: 'Open, seed-generated space between the reefs, re-laid for every survey contract.',
      difficulty: 2, resources: ['fuel', null, 1], encounters: [1, 'patrols', ['red-tally']], discovery: 'uncharted',
      links: ['bleached-reef'], archetype: 'void-drift',
    },
    {
      slug: 'sn-1987a', name: 'SN 1987A', category: 'supernova-remnant', provenance: 'verified-object',
      sources: ['nasa-sn1987a', 'nasa-sn1987a-webb'],
      fact: 'A core-collapse supernova first seen in February 1987, about 168,000 light-years away; Webb later found the best evidence yet of a neutron star at its heart.',
      description: 'The young, glowing debris of a star seen to explode in 1987. The simulated sector follows its expanding shock rings.',
      difficulty: 3, resources: ['core-shard', 'crystal', 3], encounters: [2, 'sentinels', ['cordon']], discovery: 'rumoured',
      links: ['undertow'], archetype: 'shock-front',
    },
    {
      slug: 'scrimshaw', name: 'Scrimshaw', category: 'star-cluster', provenance: 'fictional',
      description: 'A cluster whose old stations are carved with Red Tally marks; every notch is a ship they took.',
      difficulty: 3, resources: ['relic', 'alloy', 2], encounters: [3, 'gauntlet', ['red-tally']], discovery: 'uncharted',
      links: [], archetype: 'cluster-field',
    },
    {
      slug: 'undertow', name: 'Undertow', category: 'neutron-star', provenance: 'fictional',
      description: 'A neutron star whose pull drags careless ships toward the deep; the Cordon keeps watch at the edge.',
      difficulty: 3, resources: ['core-shard', 'circuits', 3], encounters: [3, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['the-drowned-lens'], archetype: 'compact-remnant',
    },
    {
      slug: 'bleached-reef', name: 'Bleached Reef', category: 'dark-nebula', provenance: 'fictional',
      description: 'A pale, dead cloud where Tessellate foundries once fed; the husks still twitch.',
      difficulty: 3, resources: ['fuel', 'relic', 2], encounters: [2, 'swarm-tide', ['tessellate']], discovery: 'uncharted',
      links: [], archetype: 'nebula-pocket', hazard: 'ion-storm',
    },
    {
      slug: 'the-drowned-lens', name: 'The Drowned Lens', category: 'anomaly', provenance: 'speculative',
      note: 'Built around a primordial black hole, a hypothetical class of black holes formed in the early universe; none has been identified.',
      description: 'An invisible, coin-sized well that bends starlight into rings, imagined as a relic of the first second of time.',
      difficulty: 3, resources: ['relic', 'core-shard', 3], encounters: [3, 'sentinels', ['cordon']], discovery: 'hidden',
      links: [], archetype: 'compact-remnant', hazard: 'gravity-shear', needs: { systems: ['undertow', 'sn-1987a'] },
    },
  ],
};
