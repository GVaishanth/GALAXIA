/**
 * Whirlpool Galaxy (M51) systems (content data). One real object (the
 * companion galaxy NGC 5195) with cited facts; the rest is GALAXIA fiction.
 */
import type { GalaxySystems } from '../../types.ts';

export const WHIRLPOOL_SYSTEMS: GalaxySystems = {
  galaxyId: 'whirlpool',
  rows: [
    {
      slug: 'millrace-gate', name: 'Millrace Gate', category: 'relay-station', provenance: 'fictional',
      description: 'A gate station turning on the current of a spiral arm, the Guild’s foothold in the Whirlpool.',
      difficulty: 3, resources: ['circuits', 'scrap', 1], encounters: [1, 'patrols', ['red-tally', 'haven-guild']], discovery: 'charted',
      links: ['backwater', 'sluice-run', 'fulling-light'], archetype: 'gate-hub', gateway: true,
    },
    {
      slug: 'backwater', name: 'Backwater', category: 'orange-dwarf', provenance: 'fictional',
      description: 'A slow eddy of stations off the main current, where refits are cheap and questions are few.',
      difficulty: 3, resources: ['scrap', 'circuits', 2], encounters: [1, 'patrols', ['red-tally', 'haven-guild']], discovery: 'charted',
      links: ['undershot', 'countercurrent'], archetype: 'gate-hub',
    },
    {
      slug: 'sluice-run', name: 'Sluice Run', category: 'relay-station', provenance: 'fictional',
      description: 'A chain of relays that open and close like sluice gates, timing the traffic through a dust bank.',
      difficulty: 3, resources: ['circuits', 'fuel', 1], encounters: [2, 'convoy-raids', ['red-tally', 'gleaners']], discovery: 'charted',
      links: ['quern-stones'], archetype: 'relay-outpost', hazard: 'ion-storm',
    },
    {
      slug: 'fulling-light', name: 'Fulling Light', category: 'yellow-dwarf', provenance: 'fictional',
      description: 'A hard-working yellow star whose stations beat raw ore into plate day and night.',
      difficulty: 3, resources: ['alloy', 'scrap', 2], encounters: [2, 'patrols', ['tessellate', 'gleaners']], discovery: 'charted',
      links: ['eddyfall'], archetype: 'derelict-yard',
    },
    {
      slug: 'undershot', name: 'Undershot', category: 'red-dwarf', provenance: 'fictional',
      description: 'A red dwarf skimming low beneath the arm’s current, its ice belt churned by passing traffic.',
      difficulty: 3, resources: ['ice', 'fuel', 2], encounters: [2, 'ambush', ['red-tally', 'gleaners']], discovery: 'rumoured',
      links: ['teaselgrove'], archetype: 'asteroid-belt',
    },
    {
      slug: 'countercurrent', name: 'Countercurrent', category: 'binary-star', provenance: 'fictional',
      description: 'Two suns orbiting against the galaxy’s spin; their lanes run backwards to every chart.',
      difficulty: 3, resources: ['alloy', 'crystal', 2], encounters: [2, 'patrols', ['cordon']], discovery: 'rumoured',
      links: ['coriolis-knot'], archetype: 'stellar-forge', hazard: 'flare',
    },
    {
      slug: 'quern-stones', name: 'Quern Stones', category: 'asteroid-field', provenance: 'fictional',
      description: 'Pairs of huge flat asteroids grinding together, milling smaller rock into dust.',
      difficulty: 3, resources: ['alloy', 'scrap', 3], encounters: [2, 'nest', ['tessellate', 'gleaners']], discovery: 'rumoured',
      links: ['gyre-bridge'], archetype: 'asteroid-belt', hazard: 'gravity-shear',
    },
    {
      slug: 'eddyfall', name: 'Eddyfall', category: 'blue-giant', provenance: 'fictional',
      description: 'A blue giant where stellar wind tumbles into a cascade of glowing gas.',
      difficulty: 4, resources: ['crystal', 'fuel', 2], encounters: [2, 'sentinels', ['cordon']], discovery: 'rumoured',
      links: ['bobbin-coil', 'rillstorm'], archetype: 'stellar-forge',
    },
    {
      slug: 'teaselgrove', name: 'Teaselgrove', category: 'asteroid-field', provenance: 'procedural',
      description: 'A seed-built bristle of spiky rock, re-laid for every survey contract.',
      difficulty: 3, resources: ['scrap', 'ice', 1], encounters: [1, 'patrols', ['tessellate', 'gleaners']], discovery: 'uncharted',
      links: [], archetype: 'asteroid-belt', hazard: 'dust',
    },
    {
      slug: 'coriolis-knot', name: 'Coriolis Knot', category: 'star-cluster', provenance: 'fictional',
      description: 'A cluster twisted into a tight spiral knot by the galaxy’s spin; the Cordon reads omens in the pattern.',
      difficulty: 4, resources: ['relic', 'crystal', 2], encounters: [3, 'sentinels', ['cordon']], discovery: 'uncharted',
      links: ['ngc-5195'], archetype: 'cluster-field',
    },
    {
      slug: 'gyre-bridge', name: 'Gyre Bridge', category: 'debris-field', provenance: 'fictional',
      description: 'A wreck-strewn span between two arms, littered with ships that tried to cross it.',
      difficulty: 4, resources: ['scrap', 'relic', 3], encounters: [3, 'ambush', ['red-tally', 'tessellate', 'gleaners']], discovery: 'uncharted',
      links: ['ngc-5195', 'ebbstar'], archetype: 'derelict-yard', hazard: 'radiation',
    },
    {
      slug: 'ngc-5195', name: 'NGC 5195', category: 'satellite-galaxy', provenance: 'verified-object',
      sources: ['nasa-m51', 'esa-webb-m51'],
      fact: 'The Whirlpool’s dwarf companion galaxy; its gravity tugs on one of the Whirlpool’s spiral arms as it passes behind the larger galaxy.',
      description: 'The companion galaxy at the end of the arm. The simulated sector sits in the tidal wake between the two.',
      difficulty: 4, resources: ['core-shard', 'alloy', 3], encounters: [3, 'gauntlet', ['cordon', 'tessellate']], discovery: 'rumoured',
      links: [], archetype: 'cluster-field', hazard: 'gravity-shear',
    },
    {
      slug: 'bobbin-coil', name: 'Bobbin Coil', category: 'white-dwarf', provenance: 'fictional',
      description: 'A white dwarf wound with a coil of stolen cable; the Red Tally spool their prizes here.',
      difficulty: 4, resources: ['circuits', 'core-shard', 2], encounters: [2, 'ambush', ['red-tally']], discovery: 'uncharted',
      links: ['carders-waste'], archetype: 'compact-remnant', hazard: 'radiation',
    },
    {
      slug: 'rillstorm', name: 'Rillstorm', category: 'dark-nebula', provenance: 'fictional',
      description: 'A dark cloud cut by rivulets of lightning that fry shields in a heartbeat.',
      difficulty: 4, resources: ['fuel', 'crystal', 2], encounters: [3, 'swarm-tide', ['tessellate']], discovery: 'uncharted',
      links: ['maelstrom-eye'], archetype: 'nebula-pocket', hazard: 'ion-storm',
    },
    {
      slug: 'ebbstar', name: 'Ebbstar', category: 'orange-dwarf', provenance: 'fictional',
      description: 'A fading orange star at low tide, its ruined stations stranded on dry rock.',
      difficulty: 4, resources: ['relic', 'scrap', 2], encounters: [2, 'patrols', ['cordon', 'gleaners']], discovery: 'uncharted',
      links: ['the-still-point'], archetype: 'derelict-yard',
    },
    {
      slug: 'carders-waste', name: 'Carder’s Waste', category: 'deep-void', provenance: 'procedural',
      description: 'Combed-out, seed-generated emptiness on the far side of the arm.',
      difficulty: 4, resources: ['fuel', null, 1], encounters: [2, 'patrols', ['red-tally']], discovery: 'uncharted',
      links: [], archetype: 'void-drift',
    },
    {
      slug: 'maelstrom-eye', name: 'Maelstrom Eye', category: 'black-hole', provenance: 'fictional',
      description: 'A stellar black hole circled by a whirl of wrecks; the deepest current in GALAXIA’s Whirlpool.',
      difficulty: 4, resources: ['core-shard', 'relic', 3], encounters: [3, 'gauntlet', ['tessellate', 'cordon']], discovery: 'hidden',
      links: [], archetype: 'compact-remnant', needs: { systems: ['rillstorm', 'coriolis-knot'] },
    },
    {
      slug: 'the-still-point', name: 'The Still Point', category: 'anomaly', provenance: 'speculative',
      note: 'Built around a starless dark-matter clump; such dark subhalos are predicted by models but none is unambiguously identified.',
      description: 'A patch of space that bends ships’ paths though nothing shines there, imagined as a dark clump with no stars.',
      difficulty: 4, resources: ['relic', 'core-shard', 3], encounters: [3, 'sentinels', ['cordon']], discovery: 'hidden',
      links: [], archetype: 'void-drift', needs: { systems: ['ebbstar'], surveys: 40 },
    },
  ],
};
