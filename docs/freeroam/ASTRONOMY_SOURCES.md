# Free Roam: Astronomy Sources

> **Status: implemented data (Free Roam Prompt 3, 2026-10-19).** This file mirrors `src/modes/freeroam/catalogue/data/sources.ts`, `data/galaxies.ts` and the verified rows in `data/systems/*.ts`. The tables in §2 to §4 are generated from that data by `npm run catalogue:doc`. `tests/catalogue.test.ts` checks that every source URL appears here, so the two cannot silently drift apart. Since P09.1 the game ships only each source's id and title (`data/sourceTitles.ts`). The publisher, URL, date and tier below come from `data/sources.ts`, which stays in the repository for validation and this document.

## 1. How the sources were used

- **What was checked:** for the 10 galaxies, the name, designations, broad classification, satellite or interaction status, constellation and distance. For the 23 real objects used as systems, the one fact each record states.
- **Distances are ranges.** Reputable sources round differently (Whirlpool: 31 Mly in the Hubble Messier Catalog, 27 Mly in the 2023 Webb release). The catalogue stores the spread rather than choosing one figure.
  - Every bound comes from a cited figure. The LMC range (160,000–168,000 ly) spans the cited distances of the galaxy (160,000 ly) and of the objects inside it (Tarantula Nebula 161,000 ly, SN 1987A 168,000 ly).
- **Classifications are not uniform.** The catalogue keeps a coarse gameplay enum (`morphology.class`) and, separately, the published Hubble / de Vaucouleurs type (`morphology.code`), with a `note` wherever the type is disputed (Sombrero, Centaurus A, LMC, SMC).
- **Primary sources come first.** Every galaxy and every verified object cites at least one primary source; the validator enforces this. Wikipedia appears only as a secondary cross-check, mainly for morphology codes, because NED (the NASA/IPAC Extragalactic Database) could not be fetched in this environment. A fact backed only by a secondary source must say “(secondary reference)” in its text; the validator enforces that too.
- **No online lookups at runtime.** The URLs are metadata for people. The game never fetches them, and the catalogue is static data bundled with the code.
- **Limits of this check:** sources were read through search excerpts and agency pages on one date. Figures can be revised; re-check before quoting them in player-facing text. Nothing here was measured or derived by this project.

### Deliberate omissions

- **47 Tucanae** looks as if it sits beside the SMC on the sky but is a Milky Way globular cluster, so it is not listed under the SMC.
- **Planet counts** are stated only for TRAPPIST-1 (seven Earth-size planets) and Barnard’s Star (four sub-Earth planets reported in March 2025). Alpha Centauri’s planets are omitted because sources disagree on the count.
- **No individual stars or planets in other galaxies** are presented as real. Real objects outside the Milky Way are nebulae, clusters, supernova sites, a companion galaxy and galaxy-scale structures only; `tests/catalogue.test.ts` enforces this.
- **Andromeda–Milky Way collision:** not stated. It is a model prediction rather than an observed property, and gameplay does not need it.

## 2. Galaxies

### Milky Way (`milky-way`)

- **Designations:** the Galaxy
- **Class (gameplay enum):** `barred-spiral`; **published type:** `SB(rs)bc` — Barred nature established by infrared star surveys; the exact Hubble subtype is uncertain because we view the disk from inside.
- **Relation:** home
- **Constellation:** Sagittarius (direction of the Galactic Centre)
- **Distance stored:** — (we are inside it)

| Fact used | Sources |
|---|---|
| The Milky Way is a barred spiral galaxy; infrared surveys of tens of millions of stars revealed a large central bar. | `apod-2005-barred-milky-way`, `esa-gaia-milky-way-anatomy` |
| Its disk is about 100,000 light-years across and the Solar System lies about 26,000 light-years from the Galactic Centre. | `nasa-imagine-milky-way` |
| Its central supermassive black hole, Sagittarius A*, was first imaged by the Event Horizon Telescope in 2022. | `eht-sgr-a-star` |
| Published morphological type SB(rs)bc (secondary reference). | `wiki-milky-way` |

### Andromeda Galaxy (`andromeda`)

- **Designations:** M31, NGC 224
- **Class (gameplay enum):** `spiral`; **published type:** `SA(s)b` — Listed as SA(s)b in visible light; infrared studies suggest a bar-like inner structure (secondary reference).
- **Relation:** local-group-member
- **Constellation:** Andromeda
- **Distance stored:** about 2,500,000 ly

| Fact used | Sources |
|---|---|
| About 2.5 million light-years away in the constellation Andromeda; the nearest major galaxy to our own. | `nasa-m31` |
| Its disk is tilted about 77 degrees relative to our line of sight. | `nasa-m31` |
| One of the three large spiral galaxies of the Local Group, with the Milky Way and Triangulum. | `esa-heic1901` |
| Published morphological type SA(s)b; catalogue number NGC 224 (secondary reference). | `wiki-andromeda` |

### Triangulum Galaxy (`triangulum`)

- **Designations:** M33, NGC 598
- **Class (gameplay enum):** `spiral`; **published type:** `SA(s)cd` — Loosely wound spiral without a strong bar (code from secondary reference).
- **Relation:** local-group-member
- **Constellation:** Triangulum
- **Distance stored:** about 3,000,000 ly

| Fact used | Sources |
|---|---|
| A spiral galaxy about 3 million light-years away; the third-largest in the Local Group and roughly half the size of the Milky Way. | `nasa-m33` |
| About 60,000 light-years across and home to some 40 billion stars. | `esa-heic1901` |
| Contains NGC 604, an enormous star-forming nebula in one of its spiral arms. | `nasa-m33`, `esawebb-ngc604` |
| Published morphological type SA(s)cd (secondary reference). | `wiki-triangulum` |

### Large Magellanic Cloud (`lmc`)

- **Designations:** LMC
- **Class (gameplay enum):** `magellanic-spiral`; **published type:** `SB(s)m` — Also described as a dwarf irregular; its bar is off-centre, suggesting a former barred spiral reshaped by the Milky Way and the SMC.
- **Relation:** milky-way-satellite (of milky-way)
- **Constellation:** Dorado and Mensa
- **Distance stored:** 160,000–168,000 ly

| Fact used | Sources |
|---|---|
| A dwarf galaxy about 160,000 light-years away in Dorado and Mensa, the largest of the Milky Way’s satellite galaxies. | `nasa-lmc-2025` |
| Its bright central bar is off-centre, suggesting it was once a barred spiral whose arms were warped by the Milky Way and the SMC. | `noirlab-lmc` |
| Often classed as a dwarf irregular, yet deep exposures show it resembling a barred spiral. | `apod-2008-lmc` |
| Magellanic spirals (type Sm) are dwarf galaxies with a single spiral arm; the LMC is listed as SB(s)m. | `esa-magellanic-spiral`, `wiki-lmc` |

### Small Magellanic Cloud (`smc`)

- **Designations:** SMC, NGC 292
- **Class (gameplay enum):** `dwarf-irregular`; **published type:** `SB(s)m pec` — Dwarf irregular with a bar-like structure; its shape is distorted by interactions (code from secondary reference).
- **Relation:** milky-way-satellite (of milky-way)
- **Constellation:** Tucana (partly Hydrus)
- **Distance stored:** 200,000–210,000 ly

| Fact used | Sources |
|---|---|
| A dwarf galaxy about 200,000 light-years away in Tucana, partly in Hydrus. | `nasa-smc` |
| Its peculiar shape is the result of interactions with the Large Magellanic Cloud and the Milky Way. | `eso-1714` |
| Both Magellanic Clouds are dwarf irregular satellites of the Milky Way. | `apod-2021-smc` |
| Poorer in heavy elements than the Milky Way, which makes its star formation resemble conditions in the early universe. | `esa-ngc346-2025` |
| Published morphological type SB(s)m pec; catalogue number NGC 292 (secondary reference). | `wiki-smc` |

### Whirlpool Galaxy (`whirlpool`)

- **Designations:** M51a, NGC 5194
- **Class (gameplay enum):** `interacting-spiral`; **published type:** `SA(s)bc pec` — Grand-design spiral interacting with its companion NGC 5195 (code from secondary reference).
- **Relation:** interacting-pair
- **Constellation:** Canes Venatici
- **Distance stored:** 27,000,000–31,000,000 ly

| Fact used | Sources |
|---|---|
| A spiral galaxy in Canes Venatici, about 31 million light-years away in the Hubble Messier Catalog and about 27 million in the 2023 Webb release. | `nasa-m51`, `esa-webb-m51` |
| Its dwarf companion NGC 5195 tugs on one of the spiral arms as it passes behind the Whirlpool. | `nasa-m51`, `esa-webb-m51` |
| Published morphological type SA(s)bc pec, an interacting grand-design spiral (secondary reference). | `wiki-whirlpool` |

### Pinwheel Galaxy (`pinwheel`)

- **Designations:** M101, NGC 5457
- **Class (gameplay enum):** `intermediate-spiral`; **published type:** `SAB(rs)cd` — Face-on, weakly barred spiral (code from secondary reference).
- **Relation:** beyond-local-group
- **Constellation:** Ursa Major
- **Distance stored:** 21,000,000–25,000,000 ly

| Fact used | Sources |
|---|---|
| A face-on spiral galaxy in Ursa Major, about 25 million light-years away in the Hubble Messier Catalog. | `nasa-m101` |
| About 170,000 light-years across and about 21 million light-years away in Spitzer’s figures. | `spitzer-m101` |
| Host of SN 2011fe (Type Ia) and SN 2023ixf (Type II), two of the nearest supernovae of recent decades. | `lbl-sn2011fe`, `apod-2023-sn2023ixf` |
| Published morphological type SAB(rs)cd (secondary reference). | `wiki-pinwheel` |

### Sombrero Galaxy (`sombrero`)

- **Designations:** M104, NGC 4594
- **Class (gameplay enum):** `spiral-or-elliptical`; **published type:** `SA(s)a` — Classification debated: a disk with a prominent dust ring inside a large, elliptical-like halo (secondary reference).
- **Relation:** beyond-local-group
- **Constellation:** Virgo
- **Distance stored:** 28,000,000–30,000,000 ly

| Fact used | Sources |
|---|---|
| Seen nearly edge-on in Virgo, with a bulbous core and prominent dust lanes; about 28 million light-years away in the Hubble Messier Catalog. | `nasa-m104` |
| About 30 million light-years away in a later Hubble release. | `nasa-m104-hubble` |
| Webb’s mid-infrared image (2024) resolved the clumpy dust along the galaxy’s outer ring. | `esawebb-sombrero` |
| Its type is unclear: catalogued as SA(s)a, but its large halo has led some studies to treat it as an elliptical with a disk (secondary reference). | `wiki-sombrero` |

### Centaurus A (`centaurus-a`)

- **Designations:** NGC 5128
- **Class (gameplay enum):** `peculiar-elliptical`; **published type:** `S0 pec / E pec` — Type debated between giant elliptical and lenticular; its dust lane is a sign of a merger with a spiral galaxy.
- **Relation:** beyond-local-group
- **Constellation:** Centaurus
- **Distance stored:** 12,000,000–13,000,000 ly

| Fact used | Sources |
|---|---|
| A peculiar massive elliptical galaxy about 12 million light-years away in Centaurus, hosting a supermassive black hole; the most prominent radio galaxy in the sky. | `eso-1221` |
| About 13 million light-years away and thought to be merging with a companion spiral galaxy. | `eso-0903` |
| Its central black hole, of about 55 million solar masses, drives jets of particles. | `nasa-cen-a-jets` |
| Its morphological type is debated (lenticular or giant elliptical) (secondary reference). | `wiki-centaurus-a` |

### Cartwheel Galaxy (`cartwheel`)

- **Designations:** ESO 350-40, PGC 2248
- **Class (gameplay enum):** `ring`; **published type:** none stored — Collisional ring galaxy formed when a smaller galaxy passed through a large spiral; two rings joined by spokes.
- **Relation:** beyond-local-group
- **Constellation:** Sculptor
- **Distance stored:** about 500,000,000 ly

| Fact used | Sources |
|---|---|
| About 500 million light-years away in Sculptor; a rare ring galaxy formed by a high-speed collision between a large spiral and a smaller galaxy. | `esawebb-weic2211` |
| It has a bright inner ring and a colourful outer ring that has been expanding for about 440 million years. | `esa-webb-cartwheel` |

## 3. Real objects used as systems

Only the **fact** column is astronomy. The playable sector at each of these locations is a GALAXIA simulation (see `CONTENT_PROVENANCE.md`).

| System id | Name | Category | Fact used | Sources |
|---|---|---|---|---|
| `milky-way/sol` | Sol | yellow-dwarf | The Sun, the star at the centre of the Solar System, lies in the Milky Way’s disk about 26,000 light-years from the Galactic Centre. | `nasa-imagine-milky-way` |
| `milky-way/alpha-centauri` | Alpha Centauri | multiple-star | A triple star system about 4.2 to 4.4 light-years away; its red dwarf Proxima Centauri, at 4.22 light-years, is the closest known star to the Sun. | `britannica-alpha-centauri`, `apod-2002-proxima` |
| `milky-way/barnards-star` | Barnard’s Star | red-dwarf | A nearby red dwarf; in March 2025 a team reported four small planets orbiting it, each less massive than Earth. | `nasa-barnard-2025` |
| `milky-way/sirius` | Sirius | binary-star | The brightest star in the night sky, 8.6 light-years away in Canis Major; its companion Sirius B is a white dwarf with about 98 percent of the Sun’s mass. | `nasa-sirius-b` |
| `milky-way/trappist-1` | TRAPPIST-1 | red-dwarf | An ultra-cool dwarf star about 40 light-years away in Aquarius, orbited by seven Earth-size planets. | `nasa-trappist-1`, `eso-1706` |
| `milky-way/orion-nebula` | Orion Nebula | stellar-nursery | The closest large star-forming region to Earth, about 1,350 to 1,500 light-years away in Orion. | `nasa-m42`, `esa-m42` |
| `milky-way/crab-nebula` | Crab Nebula | supernova-remnant | The remnant of a supernova seen in 1054, about 6,500 light-years away in Taurus; its central pulsar spins about 30 times a second. | `nasa-m1`, `chandra-crab-2017` |
| `milky-way/sagittarius-a-star` | Sagittarius A* | black-hole | The Milky Way’s central supermassive black hole, about 4 million solar masses and about 27,000 light-years away; first imaged in 2022. | `eht-sgr-a-star`, `mit-sgr-a-star` |
| `andromeda/messier-32` | Messier 32 | satellite-galaxy | A compact elliptical satellite galaxy orbiting Andromeda, about 2.5 million light-years from Earth; discovered by Guillaume Le Gentil in 1749. | `nasa-m32` |
| `andromeda/mayall-ii` | Mayall II | star-cluster | Also called G1: the brightest globular cluster in the Local Group, with at least 300,000 old stars, orbiting about 130,000 light-years from Andromeda’s centre. | `nasa-mayall-ii` |
| `triangulum/ngc-604` | NGC 604 | stellar-nursery | A giant star-forming nebula in one of Triangulum’s spiral arms, about 1,300 light-years across and about 3.5 million years old, with more than 200 hot, massive young stars. | `esawebb-ngc604`, `nasa-m33` |
| `lmc/tarantula-nebula` | Tarantula Nebula | stellar-nursery | Also called 30 Doradus: the largest and brightest star-forming region in the Local Group, 161,000 light-years away in the LMC, home to some of the hottest, most massive stars known. | `nasa-tarantula-webb` |
| `lmc/sn-1987a` | SN 1987A | supernova-remnant | A core-collapse supernova first seen in February 1987, about 168,000 light-years away; Webb later found the best evidence yet of a neutron star at its heart. | `nasa-sn1987a`, `nasa-sn1987a-webb` |
| `smc/ngc-346` | NGC 346 | stellar-nursery | A bright young star cluster and star-forming region in the Small Magellanic Cloud, a galaxy poorer in heavy elements than the Milky Way. | `esa-ngc346-2025` |
| `smc/e0102` | 1E 0102.2-7219 | supernova-remnant | The expanding gaseous remnant of a supernova explosion in the Small Magellanic Cloud, commonly shortened to E0102. | `nasa-e0102` |
| `whirlpool/ngc-5195` | NGC 5195 | satellite-galaxy | The Whirlpool’s dwarf companion galaxy; its gravity tugs on one of the Whirlpool’s spiral arms as it passes behind the larger galaxy. | `nasa-m51`, `esa-webb-m51` |
| `pinwheel/sn-2011fe` | SN 2011fe | supernova-site | A Type Ia supernova, the explosion of a carbon–oxygen white dwarf, caught on 24 August 2011 within hours of exploding; the closest of its type in decades. | `lbl-sn2011fe`, `nature-sn2011fe` |
| `pinwheel/sn-2023ixf` | SN 2023ixf | supernova-site | A Type II supernova, the core collapse of a massive star, spotted in May 2023; the closest supernova seen in the five years before it. | `apod-2023-sn2023ixf` |
| `sombrero/sombrero-dust-ring` | Sombrero Dust Ring | galactic-structure | The Sombrero galaxy’s outer ring of dust, whose clumpy structure was resolved in Webb’s mid-infrared image released in November 2024. | `esawebb-sombrero` |
| `centaurus-a/centaurus-a-jet` | Centaurus A Jet | galactic-structure | Centaurus A’s supermassive black hole, about 55 million times the Sun’s mass, drives jets of particles; the galaxy is the most prominent radio galaxy in the sky. | `nasa-cen-a-jets`, `eso-1221` |
| `centaurus-a/centaurus-a-nucleus` | Centaurus A Nucleus | black-hole | The heart of Centaurus A hosts a supermassive black hole of about 55 million solar masses. | `eso-1221`, `nasa-cen-a-jets` |
| `cartwheel/cartwheel-outer-ring` | Cartwheel Outer Ring | galactic-structure | The Cartwheel’s colourful outer ring has been expanding into its surroundings for about 440 million years since the collision that formed the galaxy. | `esa-webb-cartwheel`, `esawebb-weic2211` |
| `cartwheel/cartwheel-core` | Cartwheel Core | galactic-structure | In Webb’s infrared image the Cartwheel’s core glows with large amounts of hot dust, and its brightest patches are huge clusters of young stars. | `esa-webb-cartwheel`, `esawebb-weic2211` |

## 4. Source register

All pages retrieved **2026-10-19**. `primary` = space agency, observatory, laboratory or peer-reviewed journal; `secondary` = encyclopedia, used only for cross-checks and published morphology codes, and always labelled “(secondary reference)” where it is the only citation.

| Id | Tier | Publisher | Title | URL | Cited by |
|---|---|---|---|---|---|
| `nasa-imagine-milky-way` | primary | NASA GSFC Imagine the Universe | The Milky Way Galaxy | <https://imagine.gsfc.nasa.gov/science/featured_science/milkyway/> | milky-way, milky-way/sol |
| `apod-2005-barred-milky-way` | primary | NASA APOD | Barred Spiral Milky Way (2005 August 25) | <https://apod.nasa.gov/apod/ap050825.html> | milky-way |
| `esa-gaia-milky-way-anatomy` | primary | ESA | Anatomy of the Milky Way | <https://www.esa.int/ESA_Multimedia/Images/2016/09/Anatomy_of_the_Milky_Way> | milky-way |
| `wiki-milky-way` | secondary | Wikipedia | Milky Way | <https://en.wikipedia.org/wiki/Milky_Way> | milky-way |
| `eht-sgr-a-star` | primary | Event Horizon Telescope | Astronomers reveal first image of the black hole at the heart of our galaxy (2022) | <https://eventhorizontelescope.org/blog/astronomers-reveal-first-image-black-hole-heart-our-galaxy> | milky-way, milky-way/sagittarius-a-star |
| `mit-sgr-a-star` | primary | MIT News | News release on the first image of Sagittarius A* (2022-05-12) | <https://news.mit.edu/2022/first-supermassive-black-hole-sagitarrius-0512> | milky-way/sagittarius-a-star |
| `britannica-alpha-centauri` | secondary | Encyclopaedia Britannica | Alpha Centauri | <https://www.britannica.com/place/Alpha-Centauri> | milky-way/alpha-centauri |
| `apod-2002-proxima` | primary | NASA APOD | Proxima Centauri: The Closest Star | <https://science.nasa.gov/image-article/apod-2002-july-15-proxima-centauri-the-closest-star/> | milky-way/alpha-centauri |
| `nasa-barnard-2025` | primary | NASA Science | Discovery Alert: Four Little Planets, One Big Step | <https://science.nasa.gov/universe/exoplanets/discovery-alert-four-little-planets-one-big-step/> | milky-way/barnards-star |
| `nasa-sirius-b` | primary | NASA | Measuring a White Dwarf Star | <https://www.nasa.gov/image-article/measuring-white-dwarf-star/> | milky-way/sirius |
| `nasa-trappist-1` | primary | NASA Science | NASA Telescope Reveals Largest Batch of Earth-Size, Habitable-Zone Planets Around Single Star | <https://science.nasa.gov/missions/hubble/nasa-telescope-reveals-largest-batch-of-earth-size-habitable-zone-planets-around-single-star/> | milky-way/trappist-1 |
| `eso-1706` | primary | ESO | Press release eso1706 (TRAPPIST-1 system) | <https://www.eso.org/public/news/eso1706/> | milky-way/trappist-1 |
| `nasa-m42` | primary | NASA Science (Hubble Messier Catalog) | Messier 42 (The Orion Nebula) | <https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-42/> | milky-way/orion-nebula |
| `esa-m42` | primary | ESA | The Orion Nebula, also known as M42 | <https://www.esa.int/ESA_Multimedia/Images/2018/05/The_Orion_Nebula_also_known_as_M42> | milky-way/orion-nebula |
| `nasa-m1` | primary | NASA Science (Hubble Messier Catalog) | Messier 1 (The Crab Nebula) | <https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-1/> | milky-way/crab-nebula |
| `chandra-crab-2017` | primary | NASA Chandra X-ray Center | Photo album: Crab Nebula (2017) | <https://chandra.harvard.edu/photo/2017/crab/> | milky-way/crab-nebula |
| `nasa-m31` | primary | NASA Science (Hubble Messier Catalog) | Messier 31 (The Andromeda Galaxy) | <https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-31/> | andromeda |
| `wiki-andromeda` | secondary | Wikipedia | Andromeda Galaxy | <https://en.wikipedia.org/wiki/Andromeda_Galaxy> | andromeda |
| `nasa-m32` | primary | NASA Science (Hubble Messier Catalog) | Messier 32 | <https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-32/> | andromeda/messier-32 |
| `nasa-mayall-ii` | primary | NASA Science | Hubble Spies Globular Cluster in Neighboring Galaxy | <https://science.nasa.gov/missions/hubble/hubble-spies-globular-cluster-in-neighboring-galaxy/> | andromeda/mayall-ii |
| `nasa-m33` | primary | NASA Science (Hubble Messier Catalog) | Messier 33 (The Triangulum Galaxy) | <https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-33/> | triangulum, triangulum/ngc-604 |
| `esa-heic1901` | primary | ESA/Hubble | Science release heic1901 (Triangulum Galaxy mosaic) | <https://esahubble.org/news/heic1901/> | andromeda, triangulum |
| `wiki-triangulum` | secondary | Wikipedia | Triangulum Galaxy | <https://en.wikipedia.org/wiki/Triangulum_Galaxy> | triangulum |
| `esawebb-ngc604` | primary | ESA/Webb | Webb peers into the tendrils of NGC 604 (weic2407) | <https://esawebb.org/news/weic2407/> | triangulum, triangulum/ngc-604 |
| `nasa-lmc-2025` | primary | NASA | Hubble Captures Cotton Candy Clouds | <https://www.nasa.gov/image-article/hubble-captures-cotton-candy-clouds/> | lmc |
| `noirlab-lmc` | primary | NOIRLab | Cloudy with a Chance of Star Formation (iotw2547a) | <https://noirlab.edu/public/images/iotw2547a/> | lmc |
| `apod-2008-lmc` | primary | NASA APOD | A Large Magellanic Cloud Deep Field (2008 April 9) | <https://science.nasa.gov/image-article/apod-2008-april-9-a-large-magellanic-cloud-deep-field/> | lmc |
| `esa-magellanic-spiral` | primary | ESA/Hubble | An unlikely spiral | <https://www.esa.int/ESA_Multimedia/Images/2024/03/An_unlikely_spiral> | lmc |
| `wiki-lmc` | secondary | Wikipedia | Large Magellanic Cloud | <https://en.wikipedia.org/wiki/Large_Magellanic_Cloud> | lmc |
| `nasa-tarantula-webb` | primary | NASA Science | A Cosmic Tarantula, Caught by NASA’s Webb | <https://science.nasa.gov/missions/webb/a-cosmic-tarantula-caught-by-nasas-webb/> | lmc/tarantula-nebula |
| `nasa-sn1987a` | primary | NASA Science | Supernova 1987A in the Large Magellanic Cloud | <https://science.nasa.gov/asset/hubble/supernova-1987a-in-the-large-magellanic-cloud/> | lmc/sn-1987a |
| `nasa-sn1987a-webb` | primary | NASA Science | Webb Finds Evidence for Neutron Star at Heart of Young Supernova Remnant | <https://science.nasa.gov/missions/webb/webb-finds-evidence-for-neutron-star-at-heart-of-young-supernova-remnant/> | lmc/sn-1987a |
| `nasa-smc` | primary | NASA Science | Hubble Captures a Neighbor’s Colorful Clouds | <https://science.nasa.gov/missions/hubble/hubble-captures-a-neighbors-colorful-clouds/> | smc |
| `eso-1714` | primary | ESO | Press release eso1714 (Small Magellanic Cloud) | <https://www.eso.org/public/news/eso1714/> | smc |
| `apod-2021-smc` | primary | NASA APOD | The Small Cloud of Magellan (2021 January 5) | <https://science.nasa.gov/image-article/apod-2021-january-5-the-small-cloud-of-magellan/> | smc |
| `wiki-smc` | secondary | Wikipedia | Small Magellanic Cloud | <https://en.wikipedia.org/wiki/Small_Magellanic_Cloud> | smc |
| `esa-ngc346-2025` | primary | ESA | Hubble spots stellar sculptors at work in a nearby galaxy | <https://www.esa.int/ESA_Multimedia/Images/2025/04/Hubble_spots_stellar_sculptors_at_work_in_a_nearby_galaxy> | smc, smc/ngc-346 |
| `nasa-e0102` | primary | NASA Science | Supernova Remnant E0102 in the Small Magellanic Cloud | <https://science.nasa.gov/asset/hubble/supernova-remnant-e0102-in-the-small-magellanic-cloud/> | smc/e0102 |
| `nasa-m51` | primary | NASA Science (Hubble Messier Catalog) | Messier 51 (The Whirlpool Galaxy) | <https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-51/> | whirlpool, whirlpool/ngc-5195 |
| `esa-webb-m51` | primary | ESA | Webb captures a cosmic Whirlpool | <https://www.esa.int/ESA_Multimedia/Images/2023/08/Webb_captures_a_cosmic_Whirlpool> | whirlpool, whirlpool/ngc-5195 |
| `wiki-whirlpool` | secondary | Wikipedia | Whirlpool Galaxy | <https://en.wikipedia.org/wiki/Whirlpool_Galaxy> | whirlpool |
| `nasa-m101` | primary | NASA Science (Hubble Messier Catalog) | Messier 101 (The Pinwheel Galaxy) | <https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-101/> | pinwheel |
| `spitzer-m101` | primary | NASA/JPL-Caltech Spitzer | A Pinwheel Galaxy Rainbow | <https://www.spitzer.caltech.edu/images/5163-sig12-005-A-Pinwheel-Galaxy-Rainbow> | pinwheel |
| `wiki-pinwheel` | secondary | Wikipedia | Pinwheel Galaxy | <https://en.wikipedia.org/wiki/Pinwheel_Galaxy> | pinwheel |
| `lbl-sn2011fe` | primary | Lawrence Berkeley National Laboratory | Closest Type Ia Supernova in Decades Solves a Cosmic Mystery | <https://newscenter.lbl.gov/2011/12/14/sn-2011fe/> | pinwheel, pinwheel/sn-2011fe |
| `nature-sn2011fe` | primary | Nature (Nugent et al. 2011) | Supernova SN 2011fe from an exploding carbon–oxygen white dwarf star | <https://www.nature.com/articles/nature10644> | pinwheel/sn-2011fe |
| `apod-2023-sn2023ixf` | primary | NASA APOD | Astronomy Picture of the Day, 2023 May 22 (SN 2023ixf) | <https://apod.nasa.gov/apod/ap230522.html> | pinwheel, pinwheel/sn-2023ixf |
| `nasa-m104` | primary | NASA Science (Hubble Messier Catalog) | Messier 104 (The Sombrero Galaxy) | <https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-104/> | sombrero |
| `nasa-m104-hubble` | primary | NASA Science | Hubble Provides New View of Galactic Favorite | <https://science.nasa.gov/missions/hubble/hubble-provides-new-view-of-galactic-favorite/> | sombrero |
| `esawebb-sombrero` | primary | ESA/Webb | Sombrero Galaxy dazzles in new Webb image (weic2427) | <https://esawebb.org/news/weic2427/> | sombrero, sombrero/sombrero-dust-ring |
| `wiki-sombrero` | secondary | Wikipedia | Sombrero Galaxy | <https://en.wikipedia.org/wiki/Sombrero_Galaxy> | sombrero |
| `eso-1221` | primary | ESO | Press release eso1221 (Centaurus A) | <https://www.eso.org/public/news/eso1221/> | centaurus-a, centaurus-a/centaurus-a-jet, centaurus-a/centaurus-a-nucleus |
| `eso-0903` | primary | ESO | Press release eso0903 (Centaurus A) | <https://www.eso.org/public/news/eso0903/> | centaurus-a |
| `nasa-cen-a-jets` | primary | NASA | Radio Telescopes Capture Best-Ever Snapshot of Black Hole Jets | <https://www.nasa.gov/universe/radio-telescopes-capture-best-ever-snapshot-of-black-hole-jets/> | centaurus-a, centaurus-a/centaurus-a-jet, centaurus-a/centaurus-a-nucleus |
| `wiki-centaurus-a` | secondary | Wikipedia | Centaurus A | <https://en.wikipedia.org/wiki/Centaurus_A> | centaurus-a |
| `esawebb-weic2211` | primary | ESA/Webb | Webb captures stellar gymnastics in the Cartwheel Galaxy (weic2211) | <https://esawebb.org/news/weic2211/> | cartwheel, cartwheel/cartwheel-outer-ring, cartwheel/cartwheel-core |
| `esa-webb-cartwheel` | primary | ESA | Webb captures stellar gymnastics in the Cartwheel Galaxy | <https://www.esa.int/Science_Exploration/Space_Science/Webb/Webb_captures_stellar_gymnastics_in_the_Cartwheel_Galaxy> | cartwheel, cartwheel/cartwheel-outer-ring, cartwheel/cartwheel-core |
