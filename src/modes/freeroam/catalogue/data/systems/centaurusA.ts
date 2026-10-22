/**
 * Centaurus A (NGC 5128) systems (content data). Two real features (the jet
 * and the nucleus with its supermassive black hole) with cited facts; the rest
 * is GALAXIA fiction.
 */
import type { GalaxySystems } from '../../types.ts';

export const CENTAURUS_A_SYSTEMS: GalaxySystems = {
  galaxyId: 'centaurus-a',
  rows: [
    {
      slug: 'anvil-rest', name: 'Anvil Rest', category: 'relay-station', provenance: 'fictional',
      description: 'A heavy, storm-proofed dock shaped like an anvil, where the Guild hammers battered ships back into shape.',
      difficulty: 4, resources: ['alloy', 'scrap', 1], encounters: [1, 'patrols', ['red-tally', 'haven-guild']], discovery: 'charted',
      links: ['bulwark', 'tempest-relay', 'stampede-belt'], archetype: 'gate-hub', gateway: true,
    },
    {
      slug: 'bulwark', name: 'Bulwark', category: 'orange-dwarf', provenance: 'fictional',
      description: 'A fortress colony behind a wall of armour plate, the last safe anchorage before the storms.',
      difficulty: 4, resources: ['alloy', 'circuits', 2], encounters: [2, 'patrols', ['tessellate', 'haven-guild']], discovery: 'charted',
      links: ['hoofbeat', 'gallowglass'], archetype: 'gate-hub',
    },
    {
      slug: 'tempest-relay', name: 'Tempest Relay', category: 'relay-station', provenance: 'fictional',
      description: 'A lightning-scarred relay that keeps transmitting through storms that should have killed it.',
      difficulty: 4, resources: ['circuits', 'relic', 2], encounters: [2, 'convoy-raids', ['red-tally', 'gleaners']], discovery: 'charted',
      links: ['lightning-fen'], archetype: 'relay-outpost', hazard: 'ion-storm',
    },
    {
      slug: 'stampede-belt', name: 'Stampede Belt', category: 'asteroid-field', provenance: 'fictional',
      description: 'A belt of fast-moving boulders all racing the same way, flattening anything in their path.',
      difficulty: 4, resources: ['alloy', 'scrap', 3], encounters: [2, 'nest', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['scorch-line'], archetype: 'asteroid-belt', hazard: 'gravity-shear',
    },
    {
      slug: 'hoofbeat', name: 'Hoofbeat', category: 'red-dwarf', provenance: 'fictional',
      description: 'A flaring red dwarf that pounds out a steady rhythm of radiation bursts.',
      difficulty: 4, resources: ['ice', 'fuel', 2], encounters: [2, 'patrols', ['tessellate']], discovery: 'rumoured',
      links: ['ashfall'], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'gallowglass', name: 'Gallowglass', category: 'binary-star', provenance: 'fictional',
      description: 'Twin suns guarded by a mercenary Red Tally band that sells its loyalty by the hour.',
      difficulty: 4, resources: ['alloy', 'circuits', 2], encounters: [3, 'ambush', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['kiln-halo'], archetype: 'derelict-yard',
    },
    {
      slug: 'lightning-fen', name: 'Lightning Fen', category: 'dark-nebula', provenance: 'fictional',
      description: 'A marsh of charged gas crackling with discharges, near the path of the great jet.',
      difficulty: 5, resources: ['fuel', 'crystal', 3], encounters: [3, 'swarm-tide', ['tessellate']], discovery: 'rumoured',
      links: ['bellows', 'centaurus-a-jet'], archetype: 'nebula-pocket', hazard: 'ion-storm',
    },
    {
      slug: 'scorch-line', name: 'Scorch Line', category: 'debris-field', provenance: 'fictional',
      description: 'A trench of melted wreckage where a fleet once flew too close to the storm.',
      difficulty: 4, resources: ['scrap', 'relic', 3], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['quench'], archetype: 'derelict-yard', hazard: 'radiation',
    },
    {
      slug: 'ashfall', name: 'Ashfall', category: 'deep-void', provenance: 'procedural',
      description: 'Grey, seed-generated space dusted with fine ash, re-laid for every survey contract.',
      difficulty: 4, resources: ['scrap', null, 1], encounters: [2, 'patrols', ['tessellate']], discovery: 'uncharted',
      links: [], archetype: 'void-drift',
    },
    {
      slug: 'kiln-halo', name: 'Kiln Halo', category: 'star-cluster', provenance: 'fictional',
      description: 'An ancient cluster glowing like the inside of a kiln; the Cordon fires its war-drones here.',
      difficulty: 5, resources: ['core-shard', 'crystal', 3], encounters: [3, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['warhorn'], archetype: 'cluster-field', hazard: 'flare',
    },
    {
      slug: 'bellows', name: 'Bellows', category: 'blue-giant', provenance: 'fictional',
      description: 'A huge, breathing blue star whose pulses blast hot gas across the lanes.',
      difficulty: 5, resources: ['crystal', 'fuel', 2], encounters: [3, 'nest', ['tessellate']], discovery: 'uncharted',
      links: [], archetype: 'stellar-forge', hazard: 'radiation',
    },
    {
      slug: 'centaurus-a-jet', name: 'Centaurus A Jet', category: 'galactic-structure', provenance: 'verified-object',
      sources: ['nasa-cen-a-jets', 'eso-1221'],
      fact: 'Centaurus A’s supermassive black hole, about 55 million times the Sun’s mass, drives jets of particles; the galaxy is the most prominent radio galaxy in the sky.',
      description: 'A stream of particles blasting out from the galaxy’s core. The simulated sector skirts its turbulent edge, never its centre.',
      difficulty: 5, resources: ['core-shard', 'relic', 3], encounters: [3, 'gauntlet', ['cordon', 'tessellate']], discovery: 'rumoured',
      links: ['centaurus-a-nucleus', 'warhorn'], archetype: 'shock-front', hazard: 'radiation',
    },
    {
      slug: 'quench', name: 'Quench', category: 'white-dwarf', provenance: 'fictional',
      description: 'A cooling white dwarf where hot ships come to shed heat, watched by Red Tally pickets.',
      difficulty: 5, resources: ['ice', 'core-shard', 2], encounters: [2, 'ambush', ['red-tally']], discovery: 'uncharted',
      links: ['sparkgap'], archetype: 'compact-remnant', hazard: 'radiation',
    },
    {
      slug: 'sparkgap', name: 'Sparkgap', category: 'asteroid-field', provenance: 'procedural',
      description: 'A seed-built field of charged rubble that arcs between rocks, laid out fresh for every visit.',
      difficulty: 4, resources: ['circuits', 'scrap', 1], encounters: [2, 'patrols', ['red-tally', 'gleaners']], discovery: 'uncharted',
      links: [], archetype: 'asteroid-belt', hazard: 'dust',
    },
    {
      slug: 'warhorn', name: 'Warhorn', category: 'neutron-star', provenance: 'fictional',
      description: 'A neutron star whose radio blare rallies every Tessellate builder-swarm in range.',
      difficulty: 5, resources: ['core-shard', 'alloy', 3], encounters: [3, 'swarm-tide', ['tessellate']], discovery: 'uncharted',
      links: [], archetype: 'compact-remnant',
    },
    {
      slug: 'centaurus-a-nucleus', name: 'Centaurus A Nucleus', category: 'black-hole', provenance: 'verified-object',
      sources: ['eso-1221', 'nasa-cen-a-jets'],
      fact: 'The heart of Centaurus A hosts a supermassive black hole of about 55 million solar masses.',
      description: 'The engine behind the jets. The simulated sector is a gravity maze far outside the black hole itself.',
      difficulty: 5, resources: ['core-shard', 'relic', 3], encounters: [3, 'gauntlet', ['cordon', 'tessellate']], discovery: 'hidden',
      links: ['the-outpour'], archetype: 'compact-remnant', hazard: 'gravity-shear', needs: { systems: ['centaurus-a-jet', 'warhorn'] },
    },
    {
      slug: 'the-outpour', name: 'The Outpour', category: 'anomaly', provenance: 'speculative',
      note: 'Built around a white hole, the hypothetical time-reverse of a black hole allowed by general relativity; none is known.',
      description: 'A point that only gives and never takes, pouring out light and debris, imagined as a white hole.',
      difficulty: 5, resources: ['relic', 'core-shard', 3], encounters: [3, 'sentinels', ['cordon']], discovery: 'hidden',
      links: [], archetype: 'shock-front', needs: { systems: ['centaurus-a-nucleus'] },
    },
  ],
};
