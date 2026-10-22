/**
 * Triangulum Galaxy (M33) systems (content data). One real object (NGC 604)
 * with cited facts; every other system is GALAXIA fiction.
 */
import type { GalaxySystems } from '../../types.ts';

export const TRIANGULUM_SYSTEMS: GalaxySystems = {
  galaxyId: 'triangulum',
  rows: [
    {
      slug: 'trine-harbour', name: 'Trine Harbour', category: 'relay-station', provenance: 'fictional',
      description: 'A three-armed harbour of glass docks, the Guild’s gateway into Triangulum.',
      difficulty: 2, resources: ['circuits', 'scrap', 1], encounters: [0, 'none', ['haven-guild']], discovery: 'charted',
      links: ['lumen-weir', 'facet-row', 'vane-corridor'], archetype: 'gate-hub', gateway: true,
    },
    {
      slug: 'lumen-weir', name: 'Lumen Weir', category: 'yellow-dwarf', provenance: 'fictional',
      description: 'Light-sails dam a calm stellar wind into a shining weir, a favourite rest stop for haulers.',
      difficulty: 2, resources: ['fuel', 'circuits', 1], encounters: [1, 'patrols', ['red-tally', 'haven-guild']], discovery: 'charted',
      links: ['glasswing', 'halcyon-tarn'], archetype: 'gate-hub',
    },
    {
      slug: 'facet-row', name: 'Facet Row', category: 'asteroid-field', provenance: 'fictional',
      description: 'Rows of crystalline asteroids cut like gems; every collision rings like a bell.',
      difficulty: 2, resources: ['crystal', 'scrap', 2], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['wickerwheel'], archetype: 'asteroid-belt',
    },
    {
      slug: 'vane-corridor', name: 'Vane Corridor', category: 'relay-station', provenance: 'fictional',
      description: 'A line of weather-vane relays that turn toward incoming storms and away from Cordon signals.',
      difficulty: 3, resources: ['circuits', 'relic', 1], encounters: [2, 'convoy-raids', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['ngc-604', 'prism-fold'], archetype: 'relay-outpost', hazard: 'ion-storm',
    },
    {
      slug: 'glasswing', name: 'Glasswing', category: 'binary-star', provenance: 'fictional',
      description: 'Two suns cast the shadow of a vast transparent wreck shaped like a moth’s wing.',
      difficulty: 2, resources: ['alloy', 'crystal', 2], encounters: [1, 'ambush', ['red-tally', 'gleaners']], discovery: 'charted',
      links: ['cobalt-meadow'], archetype: 'derelict-yard',
    },
    {
      slug: 'halcyon-tarn', name: 'Halcyon Tarn', category: 'orange-dwarf', provenance: 'fictional',
      description: 'A still pool of icy debris around a mild orange star; Tessellate scouts skim it for water.',
      difficulty: 2, resources: ['ice', 'fuel', 2], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'rumoured',
      links: ['clover-scatter'], archetype: 'asteroid-belt', hazard: 'none',
    },
    {
      slug: 'wickerwheel', name: 'Wickerwheel', category: 'debris-field', provenance: 'fictional',
      description: 'A woven ring of scrapped hulls, slowly turning; the Red Tally patch it into a fortress.',
      difficulty: 3, resources: ['scrap', 'alloy', 3], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['silt-mirage'], archetype: 'derelict-yard',
    },
    {
      slug: 'ngc-604', name: 'NGC 604', category: 'stellar-nursery', provenance: 'verified-object',
      sources: ['esawebb-ngc604', 'nasa-m33'],
      fact: 'A giant star-forming nebula in one of Triangulum’s spiral arms, about 1,300 light-years across and about 3.5 million years old, with more than 200 hot, massive young stars.',
      description: 'A vast stellar nursery blazing with massive young stars; its simulated lanes wind through cavities blown open by stellar winds.',
      difficulty: 3, resources: ['crystal', 'fuel', 3], encounters: [2, 'nest', ['tessellate']], discovery: 'rumoured',
      links: ['prism-fold'], archetype: 'stellar-forge', hazard: 'radiation',
    },
    {
      slug: 'prism-fold', name: 'Prism Fold', category: 'blue-giant', provenance: 'fictional',
      description: 'A blue giant behind a fold of ionised gas that splits its light into hard-edged rainbows.',
      difficulty: 3, resources: ['crystal', 'circuits', 2], encounters: [2, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['apex-rookery'], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'cobalt-meadow', name: 'Cobalt Meadow', category: 'star-cluster', provenance: 'fictional',
      description: 'A loose cluster of young blue suns, grazed by Tessellate drone herds that scatter at the first shot.',
      difficulty: 3, resources: ['fuel', 'crystal', 2], encounters: [2, 'swarm-tide', ['tessellate']], discovery: 'uncharted',
      links: ['shardlight'], archetype: 'cluster-field',
    },
    {
      slug: 'shardlight', name: 'Shardlight', category: 'white-dwarf', provenance: 'fictional',
      description: 'A white dwarf ringed by shattered mirrors that throw its glare across the lanes.',
      difficulty: 3, resources: ['core-shard', 'crystal', 2], encounters: [2, 'ambush', ['red-tally']], discovery: 'uncharted',
      links: ['apex-rookery'], archetype: 'compact-remnant', hazard: 'radiation',
    },
    {
      slug: 'silt-mirage', name: 'Silt Mirage', category: 'dark-nebula', provenance: 'fictional',
      description: 'A brown dust cloud full of false echoes; sensors show fleets that are not there.',
      difficulty: 3, resources: ['fuel', 'relic', 2], encounters: [2, 'ambush', ['tessellate']], discovery: 'uncharted',
      links: ['fennel-stray'], archetype: 'nebula-pocket',
    },
    {
      slug: 'apex-rookery', name: 'Apex Rookery', category: 'neutron-star', provenance: 'fictional',
      description: 'A neutron star crowded with nesting Tessellate carriers, perched on its magnetic field lines.',
      difficulty: 4, resources: ['core-shard', 'alloy', 3], encounters: [3, 'nest', ['tessellate']], discovery: 'uncharted',
      links: ['the-folded-mile'], archetype: 'compact-remnant',
    },
    {
      slug: 'clover-scatter', name: 'Clover Scatter', category: 'asteroid-field', provenance: 'procedural',
      description: 'A seed-generated scatter of small rocks, re-laid for every survey contract.',
      difficulty: 2, resources: ['scrap', 'ice', 1], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'uncharted',
      links: [], archetype: 'asteroid-belt', hazard: 'dust',
    },
    {
      slug: 'fennel-stray', name: 'Fennel Stray', category: 'deep-void', provenance: 'procedural',
      description: 'An unremarkable stretch of seed-built space at the edge of the charts.',
      difficulty: 3, resources: ['fuel', null, 1], encounters: [1, 'patrols', ['red-tally']], discovery: 'uncharted',
      links: [], archetype: 'void-drift',
    },
    {
      slug: 'the-folded-mile', name: 'The Folded Mile', category: 'anomaly', provenance: 'speculative',
      note: 'Based on warp-bubble spacetime metrics, which remain purely theoretical and require exotic matter not known to exist.',
      description: 'A stretch of space that seems shorter on the inside, imagined as the wake of an ancient warp drive.',
      difficulty: 4, resources: ['relic', 'core-shard', 3], encounters: [3, 'sentinels', ['cordon']], discovery: 'hidden',
      links: [], archetype: 'void-drift', needs: { systems: ['apex-rookery', 'ngc-604'] },
    },
  ],
};
