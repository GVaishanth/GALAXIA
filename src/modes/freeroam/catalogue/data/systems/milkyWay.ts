/**
 * Milky Way systems (content data). Eight real objects with cited facts; the
 * rest are GALAXIA fiction. Every playable sector (salvage, factions, layout)
 * is a simulation, including those around real stars.
 */
import type { GalaxySystems } from '../../types.ts';

export const MILKY_WAY_SYSTEMS: GalaxySystems = {
  galaxyId: 'milky-way',
  rows: [
    {
      slug: 'sol', name: 'Sol', category: 'yellow-dwarf', provenance: 'verified-object',
      sources: ['nasa-imagine-milky-way'],
      fact: 'The Sun, the star at the centre of the Solar System, lies in the Milky Way’s disk about 26,000 light-years from the Galactic Centre.',
      description: 'Home port. Haven Guild docks ring the old inner lanes, and every pilot’s first sortie starts and ends here.',
      difficulty: 1, resources: ['scrap', 'ice', 1], encounters: [0, 'none', ['haven-guild']], discovery: 'charted',
      links: ['alpha-centauri', 'barnards-star', 'morrows-anchor', 'saltmarch'], archetype: 'gate-hub', gateway: true,
    },
    {
      slug: 'alpha-centauri', name: 'Alpha Centauri', category: 'multiple-star', provenance: 'verified-object',
      sources: ['britannica-alpha-centauri', 'apod-2002-proxima'],
      fact: 'A triple star system about 4.2 to 4.4 light-years away; its red dwarf Proxima Centauri, at 4.22 light-years, is the closest known star to the Sun.',
      description: 'Three suns, one busy crossroads. Training patrols sweep the lanes between the pair and their faint red companion.',
      difficulty: 1, resources: ['alloy', 'scrap', 1], encounters: [1, 'patrols', ['tessellate', 'haven-guild']], discovery: 'charted',
      links: ['sirius', 'hollowmere'], archetype: 'relay-outpost',
    },
    {
      slug: 'barnards-star', name: 'Barnard’s Star', category: 'red-dwarf', provenance: 'verified-object',
      sources: ['nasa-barnard-2025'],
      fact: 'A nearby red dwarf; in March 2025 a team reported four small planets orbiting it, each less massive than Earth.',
      description: 'A dim red ember on the near frontier. Drifting ice and stray Tessellate scouts make it a gentle first salvage run.',
      difficulty: 1, resources: ['ice', 'fuel', 1], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['kestrel-verge'], archetype: 'asteroid-belt',
    },
    {
      slug: 'sirius', name: 'Sirius', category: 'binary-star', provenance: 'verified-object',
      sources: ['nasa-sirius-b'],
      fact: 'The brightest star in the night sky, 8.6 light-years away in Canis Major; its companion Sirius B is a white dwarf with about 98 percent of the Sun’s mass.',
      description: 'A blinding beacon and its dead companion. Red Tally skiffs hide in the glare to ambush ships hauling circuits.',
      difficulty: 2, resources: ['circuits', 'alloy', 2], encounters: [1, 'ambush', ['red-tally']], discovery: 'charted',
      links: ['larkspur', 'orion-nebula'], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'trappist-1', name: 'TRAPPIST-1', category: 'red-dwarf', provenance: 'verified-object',
      sources: ['nasa-trappist-1', 'eso-1706'],
      fact: 'An ultra-cool dwarf star about 40 light-years away in Aquarius, orbited by seven Earth-size planets.',
      description: 'Seven worlds in a tight ring around a cool red star. The sector simulates a crowded, quiet orbit lane for survey practice.',
      difficulty: 2, resources: ['ice', 'crystal', 2], encounters: [1, 'patrols', ['tessellate']], discovery: 'rumoured',
      links: ['kestrel-verge', 'thistle-expanse'], archetype: 'nebula-pocket', hazard: 'dust',
    },
    {
      slug: 'orion-nebula', name: 'Orion Nebula', category: 'stellar-nursery', provenance: 'verified-object',
      sources: ['nasa-m42', 'esa-m42'],
      fact: 'The closest large star-forming region to Earth, about 1,350 to 1,500 light-years away in Orion.',
      description: 'Glowing gas and newborn stars. Tessellate builder-swarms nest in the bright folds, and the radiation cooks unshielded hulls.',
      difficulty: 2, resources: ['crystal', 'fuel', 2], encounters: [2, 'nest', ['tessellate']], discovery: 'charted',
      links: ['gannet-rise', 'crab-nebula'], archetype: 'stellar-forge',
    },
    {
      slug: 'crab-nebula', name: 'Crab Nebula', category: 'supernova-remnant', provenance: 'verified-object',
      sources: ['nasa-m1', 'chandra-crab-2017'],
      fact: 'The remnant of a supernova seen in 1054, about 6,500 light-years away in Taurus; its central pulsar spins about 30 times a second.',
      description: 'A shredded star still pulsing at its heart. Shock filaments sweep the sector and scatter core shards for the brave.',
      difficulty: 3, resources: ['core-shard', 'crystal', 3], encounters: [2, 'sentinels', ['cordon']], discovery: 'rumoured',
      links: ['driftglass-reach'], archetype: 'shock-front', hazard: 'radiation',
    },
    {
      slug: 'sagittarius-a-star', name: 'Sagittarius A*', category: 'black-hole', provenance: 'verified-object',
      sources: ['eht-sgr-a-star', 'mit-sgr-a-star'],
      fact: 'The Milky Way’s central supermassive black hole, about 4 million solar masses and about 27,000 light-years away; first imaged in 2022.',
      description: 'The deep centre of home. The simulated sector is a gravity maze on the far edge of the black hole’s pull, held by the Cordon.',
      difficulty: 3, resources: ['core-shard', 'relic', 3], encounters: [3, 'gauntlet', ['cordon', 'tessellate']], discovery: 'hidden',
      links: ['ferrous-crown'], archetype: 'compact-remnant', needs: { systems: ['ferrous-crown', 'crab-nebula'], drive: 2 },
    },
    {
      slug: 'morrows-anchor', name: 'Morrow’s Anchor', category: 'orange-dwarf', provenance: 'fictional',
      description: 'A Guild anchorage of chained hulls around a calm orange sun, where pilots trade scrap for refits.',
      difficulty: 1, resources: ['scrap', 'circuits', 1], encounters: [0, 'none', ['haven-guild']], discovery: 'charted',
      links: ['lantern-gate', 'larkspur'], archetype: 'gate-hub',
    },
    {
      slug: 'saltmarch', name: 'Saltmarch', category: 'orange-dwarf', provenance: 'fictional',
      description: 'Frozen brine clouds drift through the lanes. Ice haulers work here under light Tessellate pressure.',
      difficulty: 1, resources: ['ice', 'scrap', 2], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['hollowmere', 'cinderwake'], archetype: 'asteroid-belt',
    },
    {
      slug: 'hollowmere', name: 'Hollowmere', category: 'debris-field', provenance: 'fictional',
      description: 'A drowned shipyard of gutted freighters. Easy pickings for scrap, if the scavenger drones stay asleep.',
      difficulty: 1, resources: ['scrap', 'alloy', 2], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'charted',
      links: [], archetype: 'derelict-yard',
    },
    {
      slug: 'kestrel-verge', name: 'Kestrel Verge', category: 'red-dwarf', provenance: 'fictional',
      description: 'A frontier picket station watching the dark between two red suns, always short of fuel.',
      difficulty: 1, resources: ['fuel', 'ice', 1], encounters: [1, 'patrols', ['tessellate', 'haven-guild']], discovery: 'charted',
      links: [], archetype: 'relay-outpost',
    },
    {
      slug: 'larkspur', name: 'Larkspur', category: 'binary-star', provenance: 'fictional',
      description: 'Twin blue-white suns dance close; Red Tally crews time their raids to the eclipses.',
      difficulty: 2, resources: ['alloy', 'fuel', 2], encounters: [2, 'ambush', ['red-tally']], discovery: 'charted',
      links: ['gannet-rise'], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'lantern-gate', name: 'Lantern Gate', category: 'relay-station', provenance: 'fictional',
      description: 'The outbound relay. Charting its lantern array opens the first deep jump toward the Magellanic Clouds.',
      difficulty: 2, resources: ['circuits', 'relic', 1], encounters: [1, 'sentinels', ['cordon', 'haven-guild']], discovery: 'rumoured',
      links: ['gannet-rise'], archetype: 'relay-outpost',
    },
    {
      slug: 'cinderwake', name: 'Cinderwake', category: 'red-giant', provenance: 'fictional',
      description: 'A swollen red giant shedding embers. Old mining rigs orbit inside its hot, smoky halo.',
      difficulty: 2, resources: ['alloy', 'fuel', 2], encounters: [2, 'nest', ['tessellate']], discovery: 'rumoured',
      links: ['ferrous-crown', 'driftglass-reach'], archetype: 'nebula-pocket', hazard: 'dust',
    },
    {
      slug: 'gannet-rise', name: 'Gannet Rise', category: 'blue-giant', provenance: 'fictional',
      description: 'A fierce blue giant over a ridge of broken moons. Red Tally convoys run ore past it at full burn.',
      difficulty: 2, resources: ['alloy', 'crystal', 2], encounters: [2, 'convoy-raids', ['red-tally', 'gleaners']], discovery: 'uncharted',
      links: ['ferrous-crown'], archetype: 'stellar-forge',
    },
    {
      slug: 'ferrous-crown', name: 'Ferrous Crown', category: 'star-cluster', provenance: 'fictional',
      description: 'A tight cluster ringed by iron-rich rubble. The Cordon guards the inward route toward the galactic core.',
      difficulty: 3, resources: ['alloy', 'core-shard', 3], encounters: [3, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: [], archetype: 'cluster-field',
    },
    {
      slug: 'thistle-expanse', name: 'Thistle Expanse', category: 'deep-void', provenance: 'procedural',
      description: 'An unnamed sweep of thin space mapped only by automatic drones; every flight lays it out anew from its seed.',
      difficulty: 2, resources: ['scrap', null, 1], encounters: [1, 'patrols', ['tessellate']], discovery: 'uncharted',
      links: ['the-long-seam'], archetype: 'void-drift',
    },
    {
      slug: 'driftglass-reach', name: 'Driftglass Reach', category: 'asteroid-field', provenance: 'procedural',
      description: 'A seed-generated field of glassy rubble, charted by survey drones and never hand-placed.',
      difficulty: 3, resources: ['crystal', 'scrap', 2], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'uncharted',
      links: [], archetype: 'asteroid-belt', hazard: 'gravity-shear',
    },
    {
      slug: 'the-long-seam', name: 'The Long Seam', category: 'anomaly', provenance: 'speculative',
      note: 'Built on a traversable wormhole, a hypothetical solution of general relativity that has never been detected.',
      description: 'A shimmering fold where distant stars smear into lines, imagined here as a gravity tunnel.',
      difficulty: 3, resources: ['relic', 'core-shard', 2], encounters: [2, 'sentinels', ['cordon']], discovery: 'hidden',
      links: [], archetype: 'compact-remnant', hazard: 'gravity-shear', needs: { surveys: 10 },
    },
  ],
};
