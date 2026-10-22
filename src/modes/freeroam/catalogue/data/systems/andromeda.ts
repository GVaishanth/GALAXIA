/**
 * Andromeda Galaxy (M31) systems (content data). Two real objects (M32 and
 * Mayall II) with cited facts; every other system is GALAXIA fiction. No
 * individual stars or planets in M31 are claimed.
 */
import type { GalaxySystems } from '../../types.ts';

export const ANDROMEDA_SYSTEMS: GalaxySystems = {
  galaxyId: 'andromeda',
  rows: [
    {
      slug: 'veilhaven', name: 'Veilhaven', category: 'relay-station', provenance: 'fictional',
      description: 'The arrival dock for Andromeda, wrapped in silk-thin sensor veils that hide it from Cordon scouts.',
      difficulty: 2, resources: ['circuits', 'scrap', 1], encounters: [1, 'patrols', ['cordon', 'haven-guild']], discovery: 'charted',
      links: ['gilded-lattice', 'tidewright', 'amberlode'], archetype: 'gate-hub', gateway: true,
    },
    {
      slug: 'tidewright', name: 'Tidewright', category: 'yellow-dwarf', provenance: 'fictional',
      description: 'A shipwright colony that rebuilds wrecks between the tides of a gentle yellow sun.',
      difficulty: 2, resources: ['alloy', 'circuits', 1], encounters: [1, 'patrols', ['red-tally', 'haven-guild']], discovery: 'charted',
      links: ['quillon-reach', 'heronsgate'], archetype: 'gate-hub',
    },
    {
      slug: 'amberlode', name: 'Amberlode', category: 'asteroid-field', provenance: 'fictional',
      description: 'Honey-coloured asteroids veined with alloy, worked by claim-jumpers and the odd Red Tally crew.',
      difficulty: 2, resources: ['alloy', 'scrap', 2], encounters: [1, 'ambush', ['red-tally', 'gleaners']], discovery: 'charted',
      links: ['vellum-shoals', 'ossuary-drift'], archetype: 'asteroid-belt',
    },
    {
      slug: 'quillon-reach', name: 'Quillon Reach', category: 'yellow-dwarf', provenance: 'fictional',
      description: 'Long blade-shaped stations guard a trade lane; the Guild pays well for escorts.',
      difficulty: 2, resources: ['fuel', 'alloy', 2], encounters: [2, 'convoy-raids', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['sable-orrery'], archetype: 'relay-outpost',
    },
    {
      slug: 'heronsgate', name: 'Heronsgate', category: 'relay-station', provenance: 'fictional',
      description: 'A stilt-legged relay over a shallow gravity well, flickering with half-decoded Cordon signals.',
      difficulty: 3, resources: ['circuits', 'relic', 2], encounters: [2, 'sentinels', ['cordon']], discovery: 'rumoured',
      links: ['pale-regent', 'farrow-wilds'], archetype: 'relay-outpost', hazard: 'ion-storm',
    },
    {
      slug: 'vellum-shoals', name: 'Vellum Shoals', category: 'red-dwarf', provenance: 'fictional',
      description: 'Paper-thin ice sheets drift around a red dwarf; careless pilots tear through them and lose their cargo.',
      difficulty: 2, resources: ['ice', 'fuel', 2], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['marrowfen'], archetype: 'asteroid-belt', hazard: 'gravity-shear',
    },
    {
      slug: 'gilded-lattice', name: 'Gilded Lattice', category: 'star-cluster', provenance: 'fictional',
      description: 'A golden knot of stars threaded with old courtly beacons. Cordon sentries still hold the gates.',
      difficulty: 3, resources: ['relic', 'crystal', 2], encounters: [2, 'sentinels', ['cordon']], discovery: 'rumoured',
      links: ['messier-32', 'ember-choir'], archetype: 'cluster-field',
    },
    {
      slug: 'ossuary-drift', name: 'Ossuary Drift', category: 'debris-field', provenance: 'fictional',
      description: 'The bones of a lost war fleet, stacked like a reliquary. Tessellate drones strip it night and day.',
      difficulty: 3, resources: ['scrap', 'relic', 3], encounters: [2, 'nest', ['tessellate', 'gleaners']], discovery: 'rumoured',
      links: ['corvid-spindle'], archetype: 'derelict-yard', hazard: 'radiation',
    },
    {
      slug: 'messier-32', name: 'Messier 32', category: 'satellite-galaxy', provenance: 'verified-object',
      sources: ['nasa-m32'],
      fact: 'A compact elliptical satellite galaxy orbiting Andromeda, about 2.5 million light-years from Earth; discovered by Guillaume Le Gentil in 1749.',
      description: 'A dense, ancient companion of Andromeda. The simulated sector skims its edge, among old red stars and almost no gas.',
      difficulty: 3, resources: ['core-shard', 'alloy', 2], encounters: [2, 'patrols', ['cordon']], discovery: 'rumoured',
      links: ['mayall-ii'], archetype: 'cluster-field', hazard: 'gravity-shear',
    },
    {
      slug: 'ember-choir', name: 'Ember Choir', category: 'stellar-nursery', provenance: 'fictional',
      description: 'A singing nursery of young stars. The Wardens claim it as holy ground and answer every intruder.',
      difficulty: 3, resources: ['crystal', 'fuel', 2], encounters: [3, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['sable-orrery'], archetype: 'stellar-forge',
    },
    {
      slug: 'sable-orrery', name: 'Sable Orrery', category: 'binary-star', provenance: 'fictional',
      description: 'Two dark-red suns turn a clockwork of derelict mirrors; the machinery still tracks every ship that passes.',
      difficulty: 3, resources: ['circuits', 'relic', 2], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'uncharted',
      links: ['brindle-deep'], archetype: 'derelict-yard',
    },
    {
      slug: 'pale-regent', name: 'Pale Regent', category: 'white-dwarf', provenance: 'fictional',
      description: 'A cold white dwarf ruling over a court of frozen wrecks; the Cordon keeps its throne room sealed.',
      difficulty: 3, resources: ['core-shard', 'ice', 2], encounters: [2, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['corvid-spindle'], archetype: 'compact-remnant', hazard: 'radiation',
    },
    {
      slug: 'marrowfen', name: 'Marrowfen', category: 'dark-nebula', provenance: 'fictional',
      description: 'A thick dark fog where sensors drown. Tessellate hives grow in the murk like reeds.',
      difficulty: 3, resources: ['fuel', 'crystal', 2], encounters: [3, 'swarm-tide', ['tessellate']], discovery: 'uncharted',
      links: ['brindle-deep'], archetype: 'nebula-pocket',
    },
    {
      slug: 'corvid-spindle', name: 'Corvid Spindle', category: 'neutron-star', provenance: 'fictional',
      description: 'A spinning neutron star that crows in radio static. The Red Tally use its beam to blind pursuers.',
      difficulty: 4, resources: ['core-shard', 'circuits', 3], encounters: [3, 'ambush', ['red-tally', 'cordon']], discovery: 'uncharted',
      links: ['the-mirror-shell'], archetype: 'compact-remnant',
    },
    {
      slug: 'mayall-ii', name: 'Mayall II', category: 'star-cluster', provenance: 'verified-object',
      sources: ['nasa-mayall-ii'],
      fact: 'Also called G1: the brightest globular cluster in the Local Group, with at least 300,000 old stars, orbiting about 130,000 light-years from Andromeda’s centre.',
      description: 'An immense old swarm of stars far out in Andromeda’s halo; the simulated lanes weave between crowded, ancient suns.',
      difficulty: 4, resources: ['core-shard', 'relic', 3], encounters: [3, 'gauntlet', ['cordon']], discovery: 'rumoured',
      links: [], archetype: 'cluster-field', hazard: 'flare',
    },
    {
      slug: 'farrow-wilds', name: 'Farrow Wilds', category: 'deep-void', provenance: 'procedural',
      description: 'Seed-built wilderness charted only by drone sweeps; its layout changes with every survey contract.',
      difficulty: 3, resources: ['scrap', 'fuel', 1], encounters: [1, 'patrols', ['tessellate']], discovery: 'uncharted',
      links: [], archetype: 'void-drift',
    },
    {
      slug: 'brindle-deep', name: 'Brindle Deep', category: 'asteroid-field', provenance: 'procedural',
      description: 'A streaky, seed-generated rubble field beyond the mapped lanes, laid out fresh for each visit.',
      difficulty: 4, resources: ['alloy', 'scrap', 2], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'uncharted',
      links: [], archetype: 'asteroid-belt', hazard: 'dust',
    },
    {
      slug: 'the-mirror-shell', name: 'The Mirror Shell', category: 'anomaly', provenance: 'speculative',
      note: 'Inspired by Dyson swarms, hypothetical star-enclosing megastructures; none is known to exist.',
      description: 'A broken shell of mirrors around a dimmed star, imagined as the ruin of a builder people.',
      difficulty: 4, resources: ['relic', 'circuits', 3], encounters: [3, 'sentinels', ['cordon', 'gleaners']], discovery: 'hidden',
      links: [], archetype: 'derelict-yard', hazard: 'radiation', needs: { systems: ['corvid-spindle', 'mayall-ii'] },
    },
  ],
};
