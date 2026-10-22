/**
 * Local reference metadata for every real-world fact in the catalogue.
 * Content data only. The game never fetches these URLs; they exist so each
 * statement can be re-checked. All pages were read on RETRIEVED.
 * Human-readable mirror: docs/freeroam/ASTRONOMY_SOURCES.md.
 */
import type { SourceRecord } from '../types.ts';

const RETRIEVED = '2026-10-19';

const src = (id: string, publisher: string, title: string, url: string, tier: SourceRecord['tier'] = 'primary'): SourceRecord => ({ id, publisher, title, url, retrieved: RETRIEVED, tier });

export const SOURCES: readonly SourceRecord[] = [
  // Milky Way
  src('nasa-imagine-milky-way', 'NASA GSFC Imagine the Universe', 'The Milky Way Galaxy', 'https://imagine.gsfc.nasa.gov/science/featured_science/milkyway/'),
  src('apod-2005-barred-milky-way', 'NASA APOD', 'Barred Spiral Milky Way (2005 August 25)', 'https://apod.nasa.gov/apod/ap050825.html'),
  src('esa-gaia-milky-way-anatomy', 'ESA', 'Anatomy of the Milky Way', 'https://www.esa.int/ESA_Multimedia/Images/2016/09/Anatomy_of_the_Milky_Way'),
  src('wiki-milky-way', 'Wikipedia', 'Milky Way', 'https://en.wikipedia.org/wiki/Milky_Way', 'secondary'),
  src('eht-sgr-a-star', 'Event Horizon Telescope', 'Astronomers reveal first image of the black hole at the heart of our galaxy (2022)', 'https://eventhorizontelescope.org/blog/astronomers-reveal-first-image-black-hole-heart-our-galaxy'),
  src('mit-sgr-a-star', 'MIT News', 'News release on the first image of Sagittarius A* (2022-05-12)', 'https://news.mit.edu/2022/first-supermassive-black-hole-sagitarrius-0512'),
  src('britannica-alpha-centauri', 'Encyclopaedia Britannica', 'Alpha Centauri', 'https://www.britannica.com/place/Alpha-Centauri', 'secondary'),
  src('apod-2002-proxima', 'NASA APOD', 'Proxima Centauri: The Closest Star', 'https://science.nasa.gov/image-article/apod-2002-july-15-proxima-centauri-the-closest-star/'),
  src('nasa-barnard-2025', 'NASA Science', 'Discovery Alert: Four Little Planets, One Big Step', 'https://science.nasa.gov/universe/exoplanets/discovery-alert-four-little-planets-one-big-step/'),
  src('nasa-sirius-b', 'NASA', 'Measuring a White Dwarf Star', 'https://www.nasa.gov/image-article/measuring-white-dwarf-star/'),
  src('nasa-trappist-1', 'NASA Science', 'NASA Telescope Reveals Largest Batch of Earth-Size, Habitable-Zone Planets Around Single Star', 'https://science.nasa.gov/missions/hubble/nasa-telescope-reveals-largest-batch-of-earth-size-habitable-zone-planets-around-single-star/'),
  src('eso-1706', 'ESO', 'Press release eso1706 (TRAPPIST-1 system)', 'https://www.eso.org/public/news/eso1706/'),
  src('nasa-m42', 'NASA Science (Hubble Messier Catalog)', 'Messier 42 (The Orion Nebula)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-42/'),
  src('esa-m42', 'ESA', 'The Orion Nebula, also known as M42', 'https://www.esa.int/ESA_Multimedia/Images/2018/05/The_Orion_Nebula_also_known_as_M42'),
  src('nasa-m1', 'NASA Science (Hubble Messier Catalog)', 'Messier 1 (The Crab Nebula)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-1/'),
  src('chandra-crab-2017', 'NASA Chandra X-ray Center', 'Photo album: Crab Nebula (2017)', 'https://chandra.harvard.edu/photo/2017/crab/'),
  // Andromeda
  src('nasa-m31', 'NASA Science (Hubble Messier Catalog)', 'Messier 31 (The Andromeda Galaxy)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-31/'),
  src('wiki-andromeda', 'Wikipedia', 'Andromeda Galaxy', 'https://en.wikipedia.org/wiki/Andromeda_Galaxy', 'secondary'),
  src('nasa-m32', 'NASA Science (Hubble Messier Catalog)', 'Messier 32', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-32/'),
  src('nasa-mayall-ii', 'NASA Science', 'Hubble Spies Globular Cluster in Neighboring Galaxy', 'https://science.nasa.gov/missions/hubble/hubble-spies-globular-cluster-in-neighboring-galaxy/'),
  // Triangulum
  src('nasa-m33', 'NASA Science (Hubble Messier Catalog)', 'Messier 33 (The Triangulum Galaxy)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-33/'),
  src('esa-heic1901', 'ESA/Hubble', 'Science release heic1901 (Triangulum Galaxy mosaic)', 'https://esahubble.org/news/heic1901/'),
  src('wiki-triangulum', 'Wikipedia', 'Triangulum Galaxy', 'https://en.wikipedia.org/wiki/Triangulum_Galaxy', 'secondary'),
  src('esawebb-ngc604', 'ESA/Webb', 'Webb peers into the tendrils of NGC 604 (weic2407)', 'https://esawebb.org/news/weic2407/'),
  // Large Magellanic Cloud
  src('nasa-lmc-2025', 'NASA', 'Hubble Captures Cotton Candy Clouds', 'https://www.nasa.gov/image-article/hubble-captures-cotton-candy-clouds/'),
  src('noirlab-lmc', 'NOIRLab', 'Cloudy with a Chance of Star Formation (iotw2547a)', 'https://noirlab.edu/public/images/iotw2547a/'),
  src('apod-2008-lmc', 'NASA APOD', 'A Large Magellanic Cloud Deep Field (2008 April 9)', 'https://science.nasa.gov/image-article/apod-2008-april-9-a-large-magellanic-cloud-deep-field/'),
  src('esa-magellanic-spiral', 'ESA/Hubble', 'An unlikely spiral', 'https://www.esa.int/ESA_Multimedia/Images/2024/03/An_unlikely_spiral'),
  src('wiki-lmc', 'Wikipedia', 'Large Magellanic Cloud', 'https://en.wikipedia.org/wiki/Large_Magellanic_Cloud', 'secondary'),
  src('nasa-tarantula-webb', 'NASA Science', 'A Cosmic Tarantula, Caught by NASA’s Webb', 'https://science.nasa.gov/missions/webb/a-cosmic-tarantula-caught-by-nasas-webb/'),
  src('nasa-sn1987a', 'NASA Science', 'Supernova 1987A in the Large Magellanic Cloud', 'https://science.nasa.gov/asset/hubble/supernova-1987a-in-the-large-magellanic-cloud/'),
  src('nasa-sn1987a-webb', 'NASA Science', 'Webb Finds Evidence for Neutron Star at Heart of Young Supernova Remnant', 'https://science.nasa.gov/missions/webb/webb-finds-evidence-for-neutron-star-at-heart-of-young-supernova-remnant/'),
  // Small Magellanic Cloud
  src('nasa-smc', 'NASA Science', 'Hubble Captures a Neighbor’s Colorful Clouds', 'https://science.nasa.gov/missions/hubble/hubble-captures-a-neighbors-colorful-clouds/'),
  src('eso-1714', 'ESO', 'Press release eso1714 (Small Magellanic Cloud)', 'https://www.eso.org/public/news/eso1714/'),
  src('apod-2021-smc', 'NASA APOD', 'The Small Cloud of Magellan (2021 January 5)', 'https://science.nasa.gov/image-article/apod-2021-january-5-the-small-cloud-of-magellan/'),
  src('wiki-smc', 'Wikipedia', 'Small Magellanic Cloud', 'https://en.wikipedia.org/wiki/Small_Magellanic_Cloud', 'secondary'),
  src('esa-ngc346-2025', 'ESA', 'Hubble spots stellar sculptors at work in a nearby galaxy', 'https://www.esa.int/ESA_Multimedia/Images/2025/04/Hubble_spots_stellar_sculptors_at_work_in_a_nearby_galaxy'),
  src('nasa-e0102', 'NASA Science', 'Supernova Remnant E0102 in the Small Magellanic Cloud', 'https://science.nasa.gov/asset/hubble/supernova-remnant-e0102-in-the-small-magellanic-cloud/'),
  // Whirlpool
  src('nasa-m51', 'NASA Science (Hubble Messier Catalog)', 'Messier 51 (The Whirlpool Galaxy)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-51/'),
  src('esa-webb-m51', 'ESA', 'Webb captures a cosmic Whirlpool', 'https://www.esa.int/ESA_Multimedia/Images/2023/08/Webb_captures_a_cosmic_Whirlpool'),
  src('wiki-whirlpool', 'Wikipedia', 'Whirlpool Galaxy', 'https://en.wikipedia.org/wiki/Whirlpool_Galaxy', 'secondary'),
  // Pinwheel
  src('nasa-m101', 'NASA Science (Hubble Messier Catalog)', 'Messier 101 (The Pinwheel Galaxy)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-101/'),
  src('spitzer-m101', 'NASA/JPL-Caltech Spitzer', 'A Pinwheel Galaxy Rainbow', 'https://www.spitzer.caltech.edu/images/5163-sig12-005-A-Pinwheel-Galaxy-Rainbow'),
  src('wiki-pinwheel', 'Wikipedia', 'Pinwheel Galaxy', 'https://en.wikipedia.org/wiki/Pinwheel_Galaxy', 'secondary'),
  src('lbl-sn2011fe', 'Lawrence Berkeley National Laboratory', 'Closest Type Ia Supernova in Decades Solves a Cosmic Mystery', 'https://newscenter.lbl.gov/2011/12/14/sn-2011fe/'),
  src('nature-sn2011fe', 'Nature (Nugent et al. 2011)', 'Supernova SN 2011fe from an exploding carbon–oxygen white dwarf star', 'https://www.nature.com/articles/nature10644'),
  src('apod-2023-sn2023ixf', 'NASA APOD', 'Astronomy Picture of the Day, 2023 May 22 (SN 2023ixf)', 'https://apod.nasa.gov/apod/ap230522.html'),
  // Sombrero
  src('nasa-m104', 'NASA Science (Hubble Messier Catalog)', 'Messier 104 (The Sombrero Galaxy)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-104/'),
  src('nasa-m104-hubble', 'NASA Science', 'Hubble Provides New View of Galactic Favorite', 'https://science.nasa.gov/missions/hubble/hubble-provides-new-view-of-galactic-favorite/'),
  src('esawebb-sombrero', 'ESA/Webb', 'Sombrero Galaxy dazzles in new Webb image (weic2427)', 'https://esawebb.org/news/weic2427/'),
  src('wiki-sombrero', 'Wikipedia', 'Sombrero Galaxy', 'https://en.wikipedia.org/wiki/Sombrero_Galaxy', 'secondary'),
  // Centaurus A
  src('eso-1221', 'ESO', 'Press release eso1221 (Centaurus A)', 'https://www.eso.org/public/news/eso1221/'),
  src('eso-0903', 'ESO', 'Press release eso0903 (Centaurus A)', 'https://www.eso.org/public/news/eso0903/'),
  src('nasa-cen-a-jets', 'NASA', 'Radio Telescopes Capture Best-Ever Snapshot of Black Hole Jets', 'https://www.nasa.gov/universe/radio-telescopes-capture-best-ever-snapshot-of-black-hole-jets/'),
  src('wiki-centaurus-a', 'Wikipedia', 'Centaurus A', 'https://en.wikipedia.org/wiki/Centaurus_A', 'secondary'),
  // Cartwheel
  src('esawebb-weic2211', 'ESA/Webb', 'Webb captures stellar gymnastics in the Cartwheel Galaxy (weic2211)', 'https://esawebb.org/news/weic2211/'),
  src('esa-webb-cartwheel', 'ESA', 'Webb captures stellar gymnastics in the Cartwheel Galaxy', 'https://www.esa.int/Science_Exploration/Space_Science/Webb/Webb_captures_stellar_gymnastics_in_the_Cartwheel_Galaxy'),
];
