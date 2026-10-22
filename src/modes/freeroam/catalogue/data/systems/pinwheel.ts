/**
 * Pinwheel Galaxy (M101) systems (content data). Two real objects (the sites
 * of SN 2011fe and SN 2023ixf) with cited facts; the rest is GALAXIA fiction.
 * The supernova entries are explosion sites, not resolved stars or systems.
 */
import type { GalaxySystems } from '../../types.ts';

export const PINWHEEL_SYSTEMS: GalaxySystems = {
  galaxyId: 'pinwheel',
  rows: [
    {
      slug: 'whirligig', name: 'Whirligig', category: 'relay-station', provenance: 'fictional',
      description: 'A spinning carnival of docks and lights, the Guild’s gaudy gateway into the Pinwheel.',
      difficulty: 3, resources: ['circuits', 'scrap', 1], encounters: [1, 'patrols', ['red-tally', 'haven-guild']], discovery: 'charted',
      links: ['kite-meridian', 'pennant-relay', 'tinsel-belt'], archetype: 'gate-hub', gateway: true,
    },
    {
      slug: 'kite-meridian', name: 'Kite Meridian', category: 'yellow-dwarf', provenance: 'fictional',
      description: 'Solar kites hang on long tethers along a bright meridian, harvesting light for the fair.',
      difficulty: 3, resources: ['fuel', 'circuits', 2], encounters: [1, 'patrols', ['tessellate', 'haven-guild']], discovery: 'charted',
      links: ['carousel', 'bunting'], archetype: 'gate-hub',
    },
    {
      slug: 'pennant-relay', name: 'Pennant Relay', category: 'relay-station', provenance: 'fictional',
      description: 'A relay strung with signal pennants that snap and flutter in the ion wind.',
      difficulty: 3, resources: ['circuits', 'relic', 1], encounters: [2, 'convoy-raids', ['red-tally', 'gleaners']], discovery: 'charted',
      links: ['sn-2011fe'], archetype: 'relay-outpost', hazard: 'ion-storm',
    },
    {
      slug: 'tinsel-belt', name: 'Tinsel Belt', category: 'asteroid-field', provenance: 'fictional',
      description: 'A belt of foil-thin metallic shards that glitter and slice through hulls.',
      difficulty: 3, resources: ['alloy', 'scrap', 2], encounters: [2, 'nest', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['confetti-shoal'], archetype: 'asteroid-belt',
    },
    {
      slug: 'carousel', name: 'Carousel', category: 'binary-star', provenance: 'fictional',
      description: 'Two suns circling a ring of painted wrecks; the Red Tally ride the merry-go-round between raids.',
      difficulty: 4, resources: ['alloy', 'relic', 2], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['sparkler-row'], archetype: 'derelict-yard',
    },
    {
      slug: 'bunting', name: 'Bunting', category: 'red-dwarf', provenance: 'fictional',
      description: 'A cosy red dwarf strung with lines of colourful beacons from old celebrations.',
      difficulty: 3, resources: ['ice', 'fuel', 1], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'rumoured',
      links: ['ribbonfield'], archetype: 'asteroid-belt', hazard: 'none',
    },
    {
      slug: 'sn-2011fe', name: 'SN 2011fe', category: 'supernova-site', provenance: 'verified-object',
      sources: ['lbl-sn2011fe', 'nature-sn2011fe'],
      fact: 'A Type Ia supernova, the explosion of a carbon–oxygen white dwarf, caught on 24 August 2011 within hours of exploding; the closest of its type in decades.',
      description: 'The site of a white dwarf’s thermonuclear blast. The simulated sector imagines its fading debris shell.',
      difficulty: 4, resources: ['core-shard', 'crystal', 3], encounters: [2, 'sentinels', ['cordon']], discovery: 'rumoured',
      links: ['marigold-furnace'], archetype: 'shock-front',
    },
    {
      slug: 'confetti-shoal', name: 'Confetti Shoal', category: 'debris-field', provenance: 'fictional',
      description: 'A drift of brightly painted fragments from a fleet that exploded mid-parade.',
      difficulty: 4, resources: ['scrap', 'circuits', 3], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['lampblack'], archetype: 'derelict-yard', hazard: 'radiation',
    },
    {
      slug: 'sparkler-row', name: 'Sparkler Row', category: 'star-cluster', provenance: 'fictional',
      description: 'A line of young stars throwing off flares like sparklers on a festival night.',
      difficulty: 4, resources: ['crystal', 'fuel', 2], encounters: [3, 'swarm-tide', ['tessellate']], discovery: 'uncharted',
      links: ['sn-2023ixf'], archetype: 'cluster-field',
    },
    {
      slug: 'ribbonfield', name: 'Ribbonfield', category: 'asteroid-field', provenance: 'procedural',
      description: 'Seed-generated ribbons of drifting rock, re-laid for every survey contract.',
      difficulty: 3, resources: ['scrap', 'ice', 1], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'uncharted',
      links: [], archetype: 'asteroid-belt', hazard: 'dust',
    },
    {
      slug: 'marigold-furnace', name: 'Marigold Furnace', category: 'blue-giant', provenance: 'fictional',
      description: 'A roaring hot star wreathed in orange gas; Cordon wardens tend it like a sacred kiln.',
      difficulty: 4, resources: ['crystal', 'alloy', 2], encounters: [2, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['saffron-flare'], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'lampblack', name: 'Lampblack', category: 'dark-nebula', provenance: 'fictional',
      description: 'A soot-black cloud between the bright arms, thick enough to hide a Tessellate armada.',
      difficulty: 4, resources: ['fuel', 'relic', 2], encounters: [3, 'swarm-tide', ['tessellate']], discovery: 'uncharted',
      links: ['calliope-wastes', 'tumbler'], archetype: 'nebula-pocket',
    },
    {
      slug: 'sn-2023ixf', name: 'SN 2023ixf', category: 'supernova-site', provenance: 'verified-object',
      sources: ['apod-2023-sn2023ixf'],
      fact: 'A Type II supernova, the core collapse of a massive star, spotted in May 2023; the closest supernova seen in the five years before it.',
      description: 'The site of a massive star’s collapse. The simulated sector imagines the young blast wave tearing through its surroundings.',
      difficulty: 5, resources: ['core-shard', 'relic', 3], encounters: [3, 'gauntlet', ['cordon', 'tessellate']], discovery: 'uncharted',
      links: ['tumbler'], archetype: 'shock-front', hazard: 'radiation',
    },
    {
      slug: 'saffron-flare', name: 'Saffron Flare', category: 'white-dwarf', provenance: 'fictional',
      description: 'A white dwarf with a flickering yellow companion glow that the Red Tally use as a signal fire.',
      difficulty: 4, resources: ['core-shard', 'circuits', 2], encounters: [2, 'ambush', ['red-tally']], discovery: 'uncharted',
      links: [], archetype: 'compact-remnant', hazard: 'radiation',
    },
    {
      slug: 'calliope-wastes', name: 'Calliope Wastes', category: 'deep-void', provenance: 'procedural',
      description: 'Seed-built emptiness past the last fairground beacon, charted only by drones.',
      difficulty: 4, resources: ['fuel', null, 1], encounters: [2, 'patrols', ['red-tally']], discovery: 'uncharted',
      links: [], archetype: 'void-drift',
    },
    {
      slug: 'tumbler', name: 'Tumbler', category: 'neutron-star', provenance: 'fictional',
      description: 'A wobbling neutron star that throws ships off course; Tessellate carriers ride its pulses.',
      difficulty: 5, resources: ['core-shard', 'alloy', 3], encounters: [3, 'nest', ['tessellate']], discovery: 'uncharted',
      links: ['the-paper-sky'], archetype: 'compact-remnant',
    },
    {
      slug: 'the-paper-sky', name: 'The Paper Sky', category: 'anomaly', provenance: 'speculative',
      note: 'Built around a cosmic string, a hypothetical one-dimensional defect from the early universe; none has been detected.',
      description: 'A razor-thin seam across the sky that doubles every star behind it, imagined as a cosmic string.',
      difficulty: 5, resources: ['relic', 'core-shard', 3], encounters: [3, 'sentinels', ['cordon']], discovery: 'hidden',
      links: [], archetype: 'void-drift', needs: { systems: ['tumbler'] },
    },
  ],
};
