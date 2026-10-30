/**
 * Local reference metadata for every real-world fact in the catalogue.
 * Content data only. The game never fetches these URLs; they exist so each
 * statement can be re-checked. All pages were read on RETRIEVED.
 * Human-readable mirror: docs/freeroam/ASTRONOMY_SOURCES.md.
 *
 * P09.1: ids and titles (what the game displays) are authored once in
 * sourceTitles.ts; this module joins them with the publisher, URL and tier.
 * The shipped catalogue carries only ids and titles; catalogueIssues() and the
 * tests validate these full records, and an id without metadata (or metadata
 * without an id) fails validation.
 */
import type { SourceRecord } from '../types.ts';
import { SOURCE_TITLES } from './sourceTitles.ts';

const RETRIEVED = '2026-10-19';

/** id -> [publisher, url, tier (default primary)]. */
export const SOURCE_META: Readonly<Record<string, readonly [publisher: string, url: string, tier?: 'secondary']>> = {
  // Milky Way
  'nasa-imagine-milky-way': ['NASA GSFC Imagine the Universe', 'https://imagine.gsfc.nasa.gov/science/featured_science/milkyway/'],
  'apod-2005-barred-milky-way': ['NASA APOD', 'https://apod.nasa.gov/apod/ap050825.html'],
  'esa-gaia-milky-way-anatomy': ['ESA', 'https://www.esa.int/ESA_Multimedia/Images/2016/09/Anatomy_of_the_Milky_Way'],
  'wiki-milky-way': ['Wikipedia', 'https://en.wikipedia.org/wiki/Milky_Way', 'secondary'],
  'eht-sgr-a-star': ['Event Horizon Telescope', 'https://eventhorizontelescope.org/blog/astronomers-reveal-first-image-black-hole-heart-our-galaxy'],
  'mit-sgr-a-star': ['MIT News', 'https://news.mit.edu/2022/first-supermassive-black-hole-sagitarrius-0512'],
  'britannica-alpha-centauri': ['Encyclopaedia Britannica', 'https://www.britannica.com/place/Alpha-Centauri', 'secondary'],
  'apod-2002-proxima': ['NASA APOD', 'https://science.nasa.gov/image-article/apod-2002-july-15-proxima-centauri-the-closest-star/'],
  'nasa-barnard-2025': ['NASA Science', 'https://science.nasa.gov/universe/exoplanets/discovery-alert-four-little-planets-one-big-step/'],
  'nasa-sirius-b': ['NASA', 'https://www.nasa.gov/image-article/measuring-white-dwarf-star/'],
  'nasa-trappist-1': ['NASA Science', 'https://science.nasa.gov/missions/hubble/nasa-telescope-reveals-largest-batch-of-earth-size-habitable-zone-planets-around-single-star/'],
  'eso-1706': ['ESO', 'https://www.eso.org/public/news/eso1706/'],
  'nasa-m42': ['NASA Science (Hubble Messier Catalog)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-42/'],
  'esa-m42': ['ESA', 'https://www.esa.int/ESA_Multimedia/Images/2018/05/The_Orion_Nebula_also_known_as_M42'],
  'nasa-m1': ['NASA Science (Hubble Messier Catalog)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-1/'],
  'chandra-crab-2017': ['NASA Chandra X-ray Center', 'https://chandra.harvard.edu/photo/2017/crab/'],
  // Andromeda
  'nasa-m31': ['NASA Science (Hubble Messier Catalog)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-31/'],
  'wiki-andromeda': ['Wikipedia', 'https://en.wikipedia.org/wiki/Andromeda_Galaxy', 'secondary'],
  'nasa-m32': ['NASA Science (Hubble Messier Catalog)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-32/'],
  'nasa-mayall-ii': ['NASA Science', 'https://science.nasa.gov/missions/hubble/hubble-spies-globular-cluster-in-neighboring-galaxy/'],
  // Triangulum
  'nasa-m33': ['NASA Science (Hubble Messier Catalog)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-33/'],
  'esa-heic1901': ['ESA/Hubble', 'https://esahubble.org/news/heic1901/'],
  'wiki-triangulum': ['Wikipedia', 'https://en.wikipedia.org/wiki/Triangulum_Galaxy', 'secondary'],
  'esawebb-ngc604': ['ESA/Webb', 'https://esawebb.org/news/weic2407/'],
  // Large Magellanic Cloud
  'nasa-lmc-2025': ['NASA', 'https://www.nasa.gov/image-article/hubble-captures-cotton-candy-clouds/'],
  'noirlab-lmc': ['NOIRLab', 'https://noirlab.edu/public/images/iotw2547a/'],
  'apod-2008-lmc': ['NASA APOD', 'https://science.nasa.gov/image-article/apod-2008-april-9-a-large-magellanic-cloud-deep-field/'],
  'esa-magellanic-spiral': ['ESA/Hubble', 'https://www.esa.int/ESA_Multimedia/Images/2024/03/An_unlikely_spiral'],
  'wiki-lmc': ['Wikipedia', 'https://en.wikipedia.org/wiki/Large_Magellanic_Cloud', 'secondary'],
  'nasa-tarantula-webb': ['NASA Science', 'https://science.nasa.gov/missions/webb/a-cosmic-tarantula-caught-by-nasas-webb/'],
  'nasa-sn1987a': ['NASA Science', 'https://science.nasa.gov/asset/hubble/supernova-1987a-in-the-large-magellanic-cloud/'],
  'nasa-sn1987a-webb': ['NASA Science', 'https://science.nasa.gov/missions/webb/webb-finds-evidence-for-neutron-star-at-heart-of-young-supernova-remnant/'],
  // Small Magellanic Cloud
  'nasa-smc': ['NASA Science', 'https://science.nasa.gov/missions/hubble/hubble-captures-a-neighbors-colorful-clouds/'],
  'eso-1714': ['ESO', 'https://www.eso.org/public/news/eso1714/'],
  'apod-2021-smc': ['NASA APOD', 'https://science.nasa.gov/image-article/apod-2021-january-5-the-small-cloud-of-magellan/'],
  'wiki-smc': ['Wikipedia', 'https://en.wikipedia.org/wiki/Small_Magellanic_Cloud', 'secondary'],
  'esa-ngc346-2025': ['ESA', 'https://www.esa.int/ESA_Multimedia/Images/2025/04/Hubble_spots_stellar_sculptors_at_work_in_a_nearby_galaxy'],
  'nasa-e0102': ['NASA Science', 'https://science.nasa.gov/asset/hubble/supernova-remnant-e0102-in-the-small-magellanic-cloud/'],
  // Whirlpool
  'nasa-m51': ['NASA Science (Hubble Messier Catalog)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-51/'],
  'esa-webb-m51': ['ESA', 'https://www.esa.int/ESA_Multimedia/Images/2023/08/Webb_captures_a_cosmic_Whirlpool'],
  'wiki-whirlpool': ['Wikipedia', 'https://en.wikipedia.org/wiki/Whirlpool_Galaxy', 'secondary'],
  // Pinwheel
  'nasa-m101': ['NASA Science (Hubble Messier Catalog)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-101/'],
  'spitzer-m101': ['NASA/JPL-Caltech Spitzer', 'https://www.spitzer.caltech.edu/images/5163-sig12-005-A-Pinwheel-Galaxy-Rainbow'],
  'wiki-pinwheel': ['Wikipedia', 'https://en.wikipedia.org/wiki/Pinwheel_Galaxy', 'secondary'],
  'lbl-sn2011fe': ['Lawrence Berkeley National Laboratory', 'https://newscenter.lbl.gov/2011/12/14/sn-2011fe/'],
  'nature-sn2011fe': ['Nature (Nugent et al. 2011)', 'https://www.nature.com/articles/nature10644'],
  'apod-2023-sn2023ixf': ['NASA APOD', 'https://apod.nasa.gov/apod/ap230522.html'],
  // Sombrero
  'nasa-m104': ['NASA Science (Hubble Messier Catalog)', 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-104/'],
  'nasa-m104-hubble': ['NASA Science', 'https://science.nasa.gov/missions/hubble/hubble-provides-new-view-of-galactic-favorite/'],
  'esawebb-sombrero': ['ESA/Webb', 'https://esawebb.org/news/weic2427/'],
  'wiki-sombrero': ['Wikipedia', 'https://en.wikipedia.org/wiki/Sombrero_Galaxy', 'secondary'],
  // Centaurus A
  'eso-1221': ['ESO', 'https://www.eso.org/public/news/eso1221/'],
  'eso-0903': ['ESO', 'https://www.eso.org/public/news/eso0903/'],
  'nasa-cen-a-jets': ['NASA', 'https://www.nasa.gov/universe/radio-telescopes-capture-best-ever-snapshot-of-black-hole-jets/'],
  'wiki-centaurus-a': ['Wikipedia', 'https://en.wikipedia.org/wiki/Centaurus_A', 'secondary'],
  // Cartwheel
  'esawebb-weic2211': ['ESA/Webb', 'https://esawebb.org/news/weic2211/'],
  'esa-webb-cartwheel': ['ESA', 'https://www.esa.int/Science_Exploration/Space_Science/Webb/Webb_captures_stellar_gymnastics_in_the_Cartwheel_Galaxy'],
};

// pure (no side effects): the release bundle drops it with catalogueIssues(), its only runtime-module reader
export const SOURCES: readonly SourceRecord[] = /* @__PURE__ */ SOURCE_TITLES.map(({ id, title }) => {
  const [publisher, url, tier] = SOURCE_META[id] ?? ['', ''];
  return { id, publisher, title, url, retrieved: RETRIEVED, tier: tier ?? 'primary' };
});
