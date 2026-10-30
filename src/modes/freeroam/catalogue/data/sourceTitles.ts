/**
 * The ids and titles of the catalogue's references: the only part of a source
 * the game shows (the exploration record names a fact's sources by title).
 * Shipped with Free Roam. The full records (publisher, URL, retrieval date,
 * tier) live in sources.ts, which only validation, tests and the docs
 * generator read, so the release bundle carries no URL it never displays.
 */
import type { SourceRef } from '../types.ts';

const t = (id: string, title: string): SourceRef => ({ id, title });

export const SOURCE_TITLES: readonly SourceRef[] = [
  // Milky Way
  t('nasa-imagine-milky-way', 'The Milky Way Galaxy'),
  t('apod-2005-barred-milky-way', 'Barred Spiral Milky Way (2005 August 25)'),
  t('esa-gaia-milky-way-anatomy', 'Anatomy of the Milky Way'),
  t('wiki-milky-way', 'Milky Way'),
  t('eht-sgr-a-star', 'Astronomers reveal first image of the black hole at the heart of our galaxy (2022)'),
  t('mit-sgr-a-star', 'News release on the first image of Sagittarius A* (2022-05-12)'),
  t('britannica-alpha-centauri', 'Alpha Centauri'),
  t('apod-2002-proxima', 'Proxima Centauri: The Closest Star'),
  t('nasa-barnard-2025', 'Discovery Alert: Four Little Planets, One Big Step'),
  t('nasa-sirius-b', 'Measuring a White Dwarf Star'),
  t('nasa-trappist-1', 'NASA Telescope Reveals Largest Batch of Earth-Size, Habitable-Zone Planets Around Single Star'),
  t('eso-1706', 'Press release eso1706 (TRAPPIST-1 system)'),
  t('nasa-m42', 'Messier 42 (The Orion Nebula)'),
  t('esa-m42', 'The Orion Nebula, also known as M42'),
  t('nasa-m1', 'Messier 1 (The Crab Nebula)'),
  t('chandra-crab-2017', 'Photo album: Crab Nebula (2017)'),
  // Andromeda
  t('nasa-m31', 'Messier 31 (The Andromeda Galaxy)'),
  t('wiki-andromeda', 'Andromeda Galaxy'),
  t('nasa-m32', 'Messier 32'),
  t('nasa-mayall-ii', 'Hubble Spies Globular Cluster in Neighboring Galaxy'),
  // Triangulum
  t('nasa-m33', 'Messier 33 (The Triangulum Galaxy)'),
  t('esa-heic1901', 'Science release heic1901 (Triangulum Galaxy mosaic)'),
  t('wiki-triangulum', 'Triangulum Galaxy'),
  t('esawebb-ngc604', 'Webb peers into the tendrils of NGC 604 (weic2407)'),
  // Large Magellanic Cloud
  t('nasa-lmc-2025', 'Hubble Captures Cotton Candy Clouds'),
  t('noirlab-lmc', 'Cloudy with a Chance of Star Formation (iotw2547a)'),
  t('apod-2008-lmc', 'A Large Magellanic Cloud Deep Field (2008 April 9)'),
  t('esa-magellanic-spiral', 'An unlikely spiral'),
  t('wiki-lmc', 'Large Magellanic Cloud'),
  t('nasa-tarantula-webb', 'A Cosmic Tarantula, Caught by NASA’s Webb'),
  t('nasa-sn1987a', 'Supernova 1987A in the Large Magellanic Cloud'),
  t('nasa-sn1987a-webb', 'Webb Finds Evidence for Neutron Star at Heart of Young Supernova Remnant'),
  // Small Magellanic Cloud
  t('nasa-smc', 'Hubble Captures a Neighbor’s Colorful Clouds'),
  t('eso-1714', 'Press release eso1714 (Small Magellanic Cloud)'),
  t('apod-2021-smc', 'The Small Cloud of Magellan (2021 January 5)'),
  t('wiki-smc', 'Small Magellanic Cloud'),
  t('esa-ngc346-2025', 'Hubble spots stellar sculptors at work in a nearby galaxy'),
  t('nasa-e0102', 'Supernova Remnant E0102 in the Small Magellanic Cloud'),
  // Whirlpool
  t('nasa-m51', 'Messier 51 (The Whirlpool Galaxy)'),
  t('esa-webb-m51', 'Webb captures a cosmic Whirlpool'),
  t('wiki-whirlpool', 'Whirlpool Galaxy'),
  // Pinwheel
  t('nasa-m101', 'Messier 101 (The Pinwheel Galaxy)'),
  t('spitzer-m101', 'A Pinwheel Galaxy Rainbow'),
  t('wiki-pinwheel', 'Pinwheel Galaxy'),
  t('lbl-sn2011fe', 'Closest Type Ia Supernova in Decades Solves a Cosmic Mystery'),
  t('nature-sn2011fe', 'Supernova SN 2011fe from an exploding carbon–oxygen white dwarf star'),
  t('apod-2023-sn2023ixf', 'Astronomy Picture of the Day, 2023 May 22 (SN 2023ixf)'),
  // Sombrero
  t('nasa-m104', 'Messier 104 (The Sombrero Galaxy)'),
  t('nasa-m104-hubble', 'Hubble Provides New View of Galactic Favorite'),
  t('esawebb-sombrero', 'Sombrero Galaxy dazzles in new Webb image (weic2427)'),
  t('wiki-sombrero', 'Sombrero Galaxy'),
  // Centaurus A
  t('eso-1221', 'Press release eso1221 (Centaurus A)'),
  t('eso-0903', 'Press release eso0903 (Centaurus A)'),
  t('nasa-cen-a-jets', 'Radio Telescopes Capture Best-Ever Snapshot of Black Hole Jets'),
  t('wiki-centaurus-a', 'Centaurus A'),
  // Cartwheel
  t('esawebb-weic2211', 'Webb captures stellar gymnastics in the Cartwheel Galaxy (weic2211)'),
  t('esa-webb-cartwheel', 'Webb captures stellar gymnastics in the Cartwheel Galaxy'),
];
