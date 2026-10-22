/**
 * Small Magellanic Cloud systems (content data). Two real objects (NGC 346 and
 * the supernova remnant 1E 0102.2-7219) with cited facts; the rest is fiction.
 * Note: 47 Tucanae appears near the SMC on the sky but belongs to the Milky
 * Way, so it is deliberately not listed here.
 */
import type { GalaxySystems } from '../../types.ts';

export const SMC_SYSTEMS: GalaxySystems = {
  galaxyId: 'smc',
  rows: [
    {
      slug: 'wingtip-haven', name: 'Wingtip Haven', category: 'relay-station', provenance: 'fictional',
      description: 'A small, frost-rimmed dock hanging off the Cloud’s ragged edge, the Guild’s only safe harbour here.',
      difficulty: 2, resources: ['scrap', 'ice', 1], encounters: [0, 'none', ['haven-guild']], discovery: 'charted',
      links: ['bramble-sun', 'pipit-relay', 'frostlace'], archetype: 'gate-hub', gateway: true,
    },
    {
      slug: 'bramble-sun', name: 'Bramble Sun', category: 'yellow-dwarf', provenance: 'fictional',
      description: 'A yellow star caught in a thicket of tangled tethers from abandoned orbital farms.',
      difficulty: 2, resources: ['scrap', 'circuits', 2], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['kittiwake', 'wrenfield'], archetype: 'derelict-yard',
    },
    {
      slug: 'pipit-relay', name: 'Pipit Relay', category: 'relay-station', provenance: 'fictional',
      description: 'A chirping beacon chain that guides haulers between the Cloud’s scattered nurseries.',
      difficulty: 2, resources: ['circuits', 'fuel', 1], encounters: [1, 'convoy-raids', ['red-tally', 'haven-guild', 'gleaners']], discovery: 'charted',
      links: ['ngc-346'], archetype: 'relay-outpost',
    },
    {
      slug: 'frostlace', name: 'Frostlace', category: 'orange-dwarf', provenance: 'fictional',
      description: 'Delicate rings of frozen gas lace an orange star; mining them is slow, careful work.',
      difficulty: 2, resources: ['ice', 'crystal', 2], encounters: [1, 'patrols', ['tessellate']], discovery: 'charted',
      links: ['hoarfrost-belt'], archetype: 'nebula-pocket', hazard: 'dust',
    },
    {
      slug: 'kittiwake', name: 'Kittiwake', category: 'binary-star', provenance: 'fictional',
      description: 'A pair of restless suns with a cliff of debris between them where Red Tally nests cling.',
      difficulty: 2, resources: ['alloy', 'scrap', 2], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['thimble-cluster'], archetype: 'asteroid-belt', hazard: 'gravity-shear',
    },
    {
      slug: 'wrenfield', name: 'Wrenfield', category: 'red-dwarf', provenance: 'fictional',
      description: 'A quiet red dwarf whose meadow of small rocks hides Tessellate scouts in every hollow.',
      difficulty: 2, resources: ['ice', 'fuel', 1], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'rumoured',
      links: ['tamarisk-field'], archetype: 'asteroid-belt', hazard: 'none',
    },
    {
      slug: 'ngc-346', name: 'NGC 346', category: 'stellar-nursery', provenance: 'verified-object',
      sources: ['esa-ngc346-2025'],
      fact: 'A bright young star cluster and star-forming region in the Small Magellanic Cloud, a galaxy poorer in heavy elements than the Milky Way.',
      description: 'A bright nursery of young stars. The simulated lanes wind through ridges of gas carved by the cluster’s winds.',
      difficulty: 3, resources: ['crystal', 'fuel', 3], encounters: [2, 'nest', ['tessellate']], discovery: 'rumoured',
      links: ['thimble-cluster', 'mothlight'], archetype: 'stellar-forge', hazard: 'radiation',
    },
    {
      slug: 'hoarfrost-belt', name: 'Hoarfrost Belt', category: 'asteroid-field', provenance: 'fictional',
      description: 'A belt of rime-coated boulders that shed glittering ice when struck.',
      difficulty: 2, resources: ['ice', 'alloy', 2], encounters: [1, 'patrols', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['linnet-scar'], archetype: 'asteroid-belt',
    },
    {
      slug: 'thimble-cluster', name: 'Thimble Cluster', category: 'star-cluster', provenance: 'fictional',
      description: 'A tiny, dense cluster where flares stitch the dark; the Cordon guards its centre.',
      difficulty: 3, resources: ['core-shard', 'crystal', 2], encounters: [3, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: [], archetype: 'cluster-field',
    },
    {
      slug: 'tamarisk-field', name: 'Tamarisk Field', category: 'asteroid-field', provenance: 'procedural',
      description: 'A seed-generated thicket of salt-pale rock, re-laid for every survey contract.',
      difficulty: 2, resources: ['scrap', 'ice', 1], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'uncharted',
      links: ['sedgewind'], archetype: 'asteroid-belt', hazard: 'dust',
    },
    {
      slug: 'mothlight', name: 'Mothlight', category: 'white-dwarf', provenance: 'fictional',
      description: 'A faint white dwarf that draws Tessellate drones to its glow like moths to a lamp.',
      difficulty: 3, resources: ['core-shard', 'ice', 2], encounters: [2, 'swarm-tide', ['tessellate']], discovery: 'uncharted',
      links: ['e0102'], archetype: 'compact-remnant', hazard: 'radiation',
    },
    {
      slug: 'linnet-scar', name: 'Linnet Scar', category: 'debris-field', provenance: 'fictional',
      description: 'A long scar of wreckage left by a convoy battle, still sparking with live munitions.',
      difficulty: 3, resources: ['scrap', 'alloy', 3], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'uncharted',
      links: ['sedgewind'], archetype: 'derelict-yard', hazard: 'radiation',
    },
    {
      slug: 'sedgewind', name: 'Sedgewind', category: 'deep-void', provenance: 'procedural',
      description: 'Thin, seed-built space on the Cloud’s torn edge, charted only by drones.',
      difficulty: 3, resources: ['fuel', null, 1], encounters: [1, 'patrols', ['red-tally']], discovery: 'uncharted',
      links: [], archetype: 'void-drift',
    },
    {
      slug: 'e0102', name: '1E 0102.2-7219', category: 'supernova-remnant', provenance: 'verified-object',
      sources: ['nasa-e0102'],
      fact: 'The expanding gaseous remnant of a supernova explosion in the Small Magellanic Cloud, commonly shortened to E0102.',
      description: 'A ring of supernova debris still racing outward. The simulated sector rides its glowing shock.',
      difficulty: 3, resources: ['core-shard', 'crystal', 3], encounters: [2, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['the-quiet-engine'], archetype: 'shock-front',
    },
    {
      slug: 'the-quiet-engine', name: 'The Quiet Engine', category: 'anomaly', provenance: 'speculative',
      note: 'Built around self-replicating interstellar probes, a thought experiment with no known examples.',
      description: 'A silent factory still assembling copies of itself from passing rock, imagined as a lost probe swarm.',
      difficulty: 3, resources: ['circuits', 'relic', 3], encounters: [3, 'gauntlet', ['tessellate', 'gleaners']], discovery: 'hidden',
      links: [], archetype: 'derelict-yard', needs: { systems: ['e0102'] },
    },
  ],
};
