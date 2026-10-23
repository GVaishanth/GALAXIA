# GALAXIA: Content and Asset Licences

**Prompt 15 (2026-10-21).** This is the asset register: every asset, dependency and reference that GALAXIA ships, credits or keeps in its repository, with its origin, licence, attribution duty, location and permission status. The findings and their risk assessment are in `IP_AND_ASSET_AUDIT.md`.

**GALAXIA's own licence:** MIT (root `LICENSE`, 2026; OD-18). It covers only work created for GALAXIA (the "Original" rows). Third-party rows keep their own licences and notices. The copyright holder line in `LICENSE` is a placeholder until the owner adds their legal name.

> **This register records provenance. It is not legal clearance.** A licence that is "identified" means a licence text or statement was found and read. It does not mean a lawyer has confirmed that the use is permitted, or that GALAXIA infringes nothing. Items marked **Unresolved** need a human decision.

**How to read the status column:**

| Status | Meaning |
|---|---|
| **Original (documented)** | Created for GALAXIA in this repository. The basis is the project's own records (code, docs, commit history). |
| **Licensed** | Third-party material with an identified licence whose conditions are met in this repository or release. |
| **Licensed, notice missing** | An identified licence, but a condition (usually keeping the licence text) is not met yet. |
| **Unresolved** | Origin, licence or permission not established, or a resemblance or trademark question that needs human or legal review. |
| **Fact / public domain** | Facts (not protected by copyright) or works with no copyright in the US. |

**Enforced by test:** `tests/assetRegister.test.ts` fails when:
- a file in `public/` is not listed in §1;
- a binary media or font file appears under `src/`;
- the project gains a runtime `dependency`, or a devDependency is not in §3;
- a `.claude/skills/` folder is not in §5;
- the shipped notices lose Vite's MIT notice.

Adding any third-party asset therefore means updating this file first.

---

## 1. What the published site contains (`dist/`)

| File | What it is | Origin | Licence / basis | Attribution | Status |
|---|---|---|---|---|---|
| `index.html`, `404.html` | Page shell, GitHub Pages redirect | GALAXIA source (`index.html`, `scripts/`) | Original | — | Original (documented) |
| `assets/index-*.js` | Main bundle: Classic mode, shared shell | GALAXIA TypeScript, compiled by Vite / Rolldown. Contains Vite's module-preload helper (~1 kB) | Original + **MIT** (Vite helper) | Vite MIT notice, now shipped in `THIRD_PARTY_NOTICES.txt` | Licensed |
| `assets/freeRoamMode-*.js` | Free Roam chunk (lazy) | GALAXIA TypeScript only | Original | — | Original (documented) |
| `assets/index-*.css` | All styles | `src/styles.css`, minified by Lightning CSS (MPL-2.0 tool; its output is not covered by MPL) | Original | — | Original (documented) |
| `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` | Icons (the Classic player fighter "Aster") | Generated from the sprite grid by `scripts/make-icons.ts` (`npm run icons`) | Original | — | Original (documented); resemblance note A-4 in the audit |
| `THIRD_PARTY_NOTICES.txt` | Licence notices and credits (new in Prompt 15) | This repository | — | — | — |

The published site loads **nothing** from other origins: no fonts, scripts, images, audio or analytics (`tests/release.test.ts`, "loads no external resources").

## 2. GALAXIA's own creative assets

Everything visual and audible in the game is produced by code in this repository. There are no image, audio or font files under `src/`.

### 2.1 How the assets were made (generated-asset record)

- **Sprites:**
  - Authored as text pixel grids (one character per pixel, a palette legend, a left half mirrored), then rasterised at runtime by `src/render/sprite/rasterize.ts`.
  - Contact sheets: `npm run sprites:sheet` → `docs/design/review/`.
- **Pixel font and insignia:** text grids in `src/assets/fonts/pixelFont.ts` and `src/assets/insignia.ts`.
- **Sound:**
  - Every effect and jingle is a recipe: oscillator waveform, frequencies or note names, envelope.
  - The recipes live in `src/config/audio.ts` (Classic) and `src/modes/freeroam/audio/frSounds.ts` (Free Roam), and are synthesised by the Web Audio API in the player's browser.
  - No samples or recordings.
- **Backdrops, map art, sector art, HUD:**
  - Drawn procedurally with Canvas 2D and CSS: starfields, nebula washes, galaxy-map nodes, asteroid fields, station rings.
  - Sector content comes from seeded generators (`src/modes/freeroam/sector/generate.ts`).
- **Written content:** names, lore, missions and UI text are in the TypeScript data files and docs.
- **Tools used:**
  - The project was built with AI-assisted development (coding agents working from written prompts). The sprites, sound recipes and text were authored as code and data in that process.
  - **No image-generation, music-generation or voice model was used.**
  - **No reference image, ROM, sprite sheet, recording or score was imported, traced or sampled.**
  - The git history begins at the "end of Free Roam Prompt 6" baseline (`b172224`), so authorship before that commit is documented in the project's records (README, `VISUAL_DESIGN_SYSTEM.md`, `SHIPS.md`) and not traceable commit by commit.
- **Statement:**
  - None of these assets was created by copying, tracing or sampling a specific protected source asset.
  - The Classic mode was **intentionally designed to evoke** the 1981 arcade game *Galaga* (`docs/design/DESIGN_PRINCIPLES.md`: "Players who know Galaga should recognise the game in one glance").
  - Evoking a game's look is not the same as copying its files, but it is not automatically safe either. See audit findings A-1 to A-5.

### 2.2 Register

| Asset | Path | Mode | Method | Status | Concerns |
|---|---|---|---|---|---|
| Classic player fighter "Aster", "Aster Twin" (dual) | `src/assets/sprites/player.ts` | Classic | Text grid | Original (documented) | Dual-fighter concept and white fighter follow *Galaga* (A-1) |
| Classic enemies "Mite", "Razorwing", "Warden" | `src/assets/sprites/enemies.ts` | Classic | Text grid | Original (documented) | **Unresolved:** bee / butterfly / crowned-boss archetypes, colour scheme and 4 / 16 / 20 formation follow *Galaga* (A-1) |
| Classic transforms "Barbtail", "Wisp", "Regent" | `src/assets/sprites/specials.ts` | Classic | Text grid | Original (documented) | **Unresolved:** described in code as "scorpion-like", "spy-ship-like", "flagship-like" after *Galaga*'s transform enemies (A-1) |
| Tractor beam, captured fighter, explosions, shots | `src/assets/sprites/effects.ts`, `src/render/beam.ts` | Classic | Grid + procedural | Original (documented) | **Unresolved:** blue concentric-arc beam and red captured fighter follow *Galaga* (A-1) |
| Stage insignia (1, 5, 10, 20, 30, 50) | `src/assets/insignia.ts` | Classic | Text grid | Original (documented) | **Unresolved:** denomination system follows *Galaga*'s stage badges; designs differ (A-2) |
| HUD layout ("GALAXIA", "HIGH SCORE") | `src/ui/hud.ts`, `src/config/hud.ts` | Classic | Code | Original (documented) | Arcade convention; red labels top-left / centre echo *Galaga* (A-3, low). The top-left label read "1UP" until TD-80 (owner request, 2026-10-21) |
| Title wordmark "GALAXIA" (banded pixel logo) | `src/shared/rendering/pixelArt.ts`, `src/shared/ui/titleScreen.ts` | Classic / shell | Text grid font | Original (documented) | **Unresolved name question** (T-1) |
| Pixel font (bitmap glyphs) | `src/assets/fonts/pixelFont.ts` | Both | Text grid | Original (documented) | Simple 3 × 5-style glyphs; generic |
| Classic sound effects and jingles (20 recipes: 7 effects, 13 motifs of 2–12 notes) | `src/config/audio.ts` | Classic | Synth recipes | Original (documented) | Not compared by ear with *Galaga*'s audio (A-5, needs a human listen) |
| Free Roam fleet: Swift, Shrike, Petrel, Condor, Magpie, Albatross | `src/assets/sprites/fleet.ts` | Free Roam | Text grid | Original (documented) | Names are common bird words (N-1, low). Silhouettes reviewed (F-1) |
| Free Roam enemy families: raider, recon, picket, lancer, hauler, heavy, elite, capital | `src/assets/sprites/foes.ts` | Free Roam | Text grid | Original (documented) | Lancer's four-blade outline: optional human look (F-1, low) |
| Faction palettes, emblems, trails (Tessellate, Red Tally, Cordon, Gleaners, Haven Guild) | `src/assets/sprites/variants.ts`, `combat/factions.ts`, sector renderer | Free Roam | Palette remaps + procedural emblems | Original (documented) | Names checked in FR-TD-51 |
| Free Roam sounds and motifs | `src/modes/freeroam/audio/frSounds.ts` | Free Roam | Synth recipes | Original (documented) | — |
| Galaxy Map, System Map, sector and station art | `src/modes/freeroam/galaxy/`, `sector/render.ts`, `ui/` | Free Roam | Procedural Canvas 2D / CSS | Original (documented) | Layouts are node graphs and radial maps (generic) |
| Lore, names, missions (170 systems, 10 story missions, contracts, resources) | `src/modes/freeroam/catalogue/data/`, `progression/missionData.ts`, docs | Free Roam | Written | Original (documented) | Incidental overlaps with common words (N-1) |
| Interface artwork (panels, buttons, notices) | `src/styles.css`, `src/ui/`, `src/modes/freeroam/ui/` | Both | CSS | Original (documented) | — |
| Review screenshots and contact sheets | `docs/design/review/*.png` (11), `docs/development/playtest/s6`–`s9` (22 files) | Docs only | Rendered from the game by its own scripts / Playwright | Original (documented) | They show the Classic presentation flagged in A-1 |
| README screenshots | `docs/media/*.png` (6) | Docs only (README; included in the release archive) | Captured 2026-10-22 from the release build in headless Chromium (Playwright); `freeroam-sector.png` recaptured 2026-10-22 for P03 from the same build with read-only test hooks (`build:e2e`), used only to place the ship | Original (documented) | Show GALAXIA's own screens only; the Classic captures show the presentation flagged in A-1 |

## 3. Third-party code and tools

### 3.1 Shipped

| Name | Origin | Author | Licence | Attribution requirement | Location | Status |
|---|---|---|---|---|---|---|
| Vite module-preload helper | https://github.com/vitejs/vite | VoidZero Inc. and Vite contributors | MIT | Keep the copyright and permission notice with copies | Injected into `dist/assets/index-*.js`; notice in `public/THIRD_PARTY_NOTICES.txt` | Licensed (notice shipped from Prompt 15; it was missing before) |

### 3.2 Build and test tools (not shipped)

`package.json` has **no runtime `dependencies`**. The four direct devDependencies are `vite` 8.3.4 (MIT), `vitest` 5.0.5 (MIT), `typescript` 6.0.3 (Apache-2.0) and `@types/node` 24.19.2 (MIT). With their transitive packages, `package-lock.json` resolves 63 packages:
- 46 MIT;
- 3 Apache-2.0: `typescript`, `expect-type`, `detect-libc`;
- 12 MPL-2.0: `lightningcss` and its platform binaries (only the matching binary installs);
- 1 ISC: `picocolors`;
- 1 BSD-3-Clause: `source-map-js`.

None is copyleft in a way that reaches GALAXIA's code. MPL-2.0 is file-level and applies only to Lightning CSS's own files, which are not shipped. Each package keeps its own licence file in `node_modules/<name>/`. Those notices are preserved by npm and are not redistributed by GALAXIA, because only `dist/` is published.

| Package | Version | Licence | Role | Author (package.json) | Source |
|---|---|---|---|---|---|
| `@jridgewell/resolve-uri` | 3.1.2 | MIT | build/test | Justin Ridgewell | https://github.com/jridgewell/resolve-uri |
| `@jridgewell/sourcemap-codec` | 1.6.0 | MIT | build/test | Justin Ridgewell | https://github.com/jridgewell/sourcemaps |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT | build/test | Justin Ridgewell | https://github.com/jridgewell/sourcemaps |
| `@oxc-project/types` | 0.154.0 | MIT | build/test | Boshen and oxc contributors | https://github.com/oxc-project/oxc |
| `@rolldown/binding-android-arm-eabi` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-android-arm64` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-darwin-arm64` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-darwin-x64` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-freebsd-x64` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-linux-arm-gnueabihf` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-linux-arm64-gnu` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-linux-arm64-musl` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-linux-ppc64-gnu` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-linux-s390x-gnu` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-linux-x64-gnu` | 1.2.14 | MIT | optional binary | — | https://github.com/rolldown/rolldown |
| `@rolldown/binding-linux-x64-musl` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-openharmony-arm64` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-win32-arm64-msvc` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/binding-win32-x64-msvc` | 1.2.14 | MIT | optional binary (not installed here) | — | npm registry |
| `@rolldown/pluginutils` | 1.0.1 | MIT | build/test | — | https://github.com/rolldown/plugins |
| `@types/chai` | 5.2.3 | MIT | build/test | — | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/deep-eql` | 4.0.2 | MIT | build/test | — | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/estree` | 1.0.9 | MIT | build/test | — | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/node` | 24.19.2 | MIT | build/test | — | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@vitest/mocker` | 5.0.5 | MIT | build/test | — | https://github.com/vitest-dev/vitest |
| `@vitest/spy` | 5.0.5 | MIT | build/test | — | https://github.com/vitest-dev/vitest |
| `assertion-error` | 2.0.1 | MIT | build/test | Jake Luer | git@github.com:chaijs/assertion-error |
| `chai` | 6.3.0 | MIT | build/test | Jake Luer | https://github.com/chaijs/chai |
| `detect-libc` | 2.1.2 | Apache-2.0 | build/test | Lovell Fuller | https://github.com/lovell/detect-libc |
| `es-module-lexer` | 2.3.2 | MIT | build/test | Guy Bedford | https://github.com/guybedford/es-module-lexer |
| `estree-walker` | 3.0.3 | MIT | build/test | Rich Harris | https://github.com/Rich-Harris/estree-walker |
| `expect-type` | 1.4.0 | Apache-2.0 | build/test | — | https://github.com/mmkal/expect-type |
| `fdir` | 6.5.0 | MIT | build/test | thecodrr | https://github.com/thecodrr/fdir |
| `fsevents` | 2.3.3 | MIT | optional binary (not installed here) | — | npm registry |
| `lightningcss` | 1.33.0 | MPL-2.0 | build/test | — | https://github.com/parcel-bundler/lightningcss |
| `lightningcss-android-arm64` | 1.33.0 | MPL-2.0 | optional binary (not installed here) | — | npm registry |
| `lightningcss-darwin-arm64` | 1.33.0 | MPL-2.0 | optional binary (not installed here) | — | npm registry |
| `lightningcss-darwin-x64` | 1.33.0 | MPL-2.0 | optional binary (not installed here) | — | npm registry |
| `lightningcss-freebsd-x64` | 1.33.0 | MPL-2.0 | optional binary (not installed here) | — | npm registry |
| `lightningcss-linux-arm-gnueabihf` | 1.33.0 | MPL-2.0 | optional binary (not installed here) | — | npm registry |
| `lightningcss-linux-arm64-gnu` | 1.33.0 | MPL-2.0 | optional binary (not installed here) | — | npm registry |
| `lightningcss-linux-arm64-musl` | 1.33.0 | MPL-2.0 | optional binary (not installed here) | — | npm registry |
| `lightningcss-linux-x64-gnu` | 1.33.0 | MPL-2.0 | optional binary | — | https://github.com/parcel-bundler/lightningcss |
| `lightningcss-linux-x64-musl` | 1.33.0 | MPL-2.0 | optional binary (not installed here) | — | npm registry |
| `lightningcss-win32-arm64-msvc` | 1.33.0 | MPL-2.0 | optional binary (not installed here) | — | npm registry |
| `lightningcss-win32-x64-msvc` | 1.33.0 | MPL-2.0 | optional binary (not installed here) | — | npm registry |
| `magic-string` | 1.4.3 | MIT | build/test | Rich Harris | https://github.com/Rich-Harris/magic-string |
| `nanoid` | 3.3.20 | MIT | build/test | Andrey Sitnik | ai/nanoid |
| `obug` | 3.0.0 | MIT | build/test | Kevin Deng | https://github.com/sxzz/obug |
| `picocolors` | 1.1.1 | ISC | build/test | Alexey Raspopov | alexeyraspopov/picocolors |
| `picomatch` | 4.0.7 | MIT | build/test | Jon Schlinkert | micromatch/picomatch |
| `postcss` | 8.5.31 | MIT | build/test | Andrey Sitnik | postcss/postcss |
| `rolldown` | 1.2.14 | MIT | build/test | — | https://github.com/rolldown/rolldown |
| `source-map-js` | 1.2.2 | BSD-3-Clause | build/test | Valentin 7rulnik Semirulnik | 7rulnik/source-map-js |
| `std-env` | 4.3.0 | MIT | build/test | — | unjs/std-env |
| `tinybench` | 6.2.2 | MIT | build/test | — | tinylibs/tinybench |
| `tinyexec` | 1.3.1 | MIT | build/test | James Garbutt | https://github.com/tinylibs/tinyexec |
| `tinyglobby` | 0.2.17 | MIT | build/test | Superchupu | https://github.com/SuperchupuDev/tinyglobby |
| `typescript` | 6.0.3 | Apache-2.0 | build/test | Microsoft Corp. | https://github.com/microsoft/TypeScript |
| `undici-types` | 7.24.6 | MIT | build/test | — | https://github.com/nodejs/undici |
| `vite` | 8.3.4 | MIT | build/test | Evan You | https://github.com/vitejs/vite |
| `vitest` | 5.0.5 | MIT | build/test | Anthony Fu | https://github.com/vitest-dev/vitest |
| `why-is-node-running` | 3.2.1 | MIT | build/test | Mathias Buus | https://github.com/mafintosh/why-is-node-running |

Generated from `package-lock.json` and each installed `package.json` on 2026-10-21. Packages marked "not installed here" are platform binaries for other operating systems, whose licence comes from the lockfile.

### 3.3 Tools installed outside the project

| Tool | Licence | Use | Status |
|---|---|---|---|
| Node.js 24 | MIT (plus bundled third-party notices) | Runs the build and tests | Licensed; not redistributed |
| Playwright 1.64.1 | Apache-2.0 | Optional browser playtests in `docs/development/playtest/`, installed in a separate folder (not a project dependency) | Licensed; not redistributed |
| Playwright browser builds: Chromium, Firefox, WebKit | BSD-3-Clause (Chromium), MPL-2.0 (Firefox), LGPL-2.1 / BSD (WebKit) | Headless testing only | Licensed; not redistributed |
| GitHub Actions: `actions/checkout`, `setup-node`, `configure-pages`, `upload-pages-artifact`, `deploy-pages` (pinned SHAs in `.github/workflows/deploy.yml`) | MIT | Build and deploy to GitHub Pages | Licensed; referenced, not copied |

## 4. Algorithms and snippets

| Item | Where | Origin | Basis | Status |
|---|---|---|---|---|
| mulberry32 PRNG | `src/core/rng.ts` | A widely published public-domain generator (Tommy Ettinger) | Re-implemented from the published algorithm | Fact / public domain [Assumed: the public-domain dedication is not recorded in the repo] |
| FNV-1a 32-bit hash | `catalogue/build.ts`, `progression/contracts.ts` | Fowler–Noll–Vo, public-domain algorithm | Re-implemented | Fact / public domain |
| Golden-ratio / Murmur-style mixing constants | `sector/generate.ts` | Published constants | Not protectable | Fact |

No other third-party code snippets were found. A search for "adapted from", "based on", "copied", "credit", "stackoverflow" and known library names (Penner, Perlin, simplex, xorshift, sfc32, PCG) found only GALAXIA's own comments.

## 5. Third-party content kept in the repository only (`.claude/`)

These are instruction files for AI coding assistants, used during development. They are **never built or deployed** (only `dist/` is uploaded), but they **are committed**: 158 tracked files. So they would be redistributed if the repository became public (open decision OD-19).

Origins were checked against `skills-lock.json` (4 entries), licence statements inside the files and public repositories (2026-10-21). "Likely origin" means the local text matches a public repository's skill, but no hash or commit was recorded at install time.

| Skill / file | Likely origin (URL) | Author | Licence | Attribution requirement | Local path | Permission status / concern |
|---|---|---|---|---|---|---|
| `brainstorming` | https://github.com/obra/superpowers (likely; older revision) | Jesse Vincent | MIT (upstream) | Keep notice | `.claude/skills/brainstorming/` | **Licensed, notice missing:** no licence file in the local copy; origin unconfirmed |
| `clean-code` | Unknown | Unknown | **None stated** | Unknown | `.claude/skills/clean-code/` | **Unresolved:** do not publish until origin and licence are known |
| `frontend-design` | Anthropic skills collection (https://github.com/anthropics/skills) | Anthropic | Apache-2.0 (`LICENSE.txt` present) | Keep `LICENSE.txt`; note changes | `.claude/skills/frontend-design/` | Licensed |
| `gsap-core`, `gsap-performance`, `gsap-timeline` | https://github.com/greensock/gsap-skills (`skills-lock.json`) | GreenSock | MIT (stated in front matter) | Keep notice | `.claude/skills/gsap-*/` | **Licensed, notice missing:** only a front-matter `license: MIT`; no copyright line in the copy. GSAP itself is not used (OD-4) |
| `impeccable` (+ 4 agents in `.claude/agents/`: `impeccable-asset-producer`, `impeccable-documenter`, `impeccable-finish-reviewer`, `impeccable-manual-edit-applier`) | https://github.com/pbakaus/impeccable (named in the files) | Paul Bakaus | Apache 2.0 (stated in front matter) | Apache-2.0 §4: include a copy of the licence and keep notices | `.claude/skills/impeccable/`, `.claude/agents/` | **Licensed, notice missing:** no Apache licence copy. Its 21 MB binary is git-ignored and downloaded by its launcher (not committed) |
| `make-interfaces-feel-better` | https://github.com/jakubkrehel/make-interfaces-feel-better (`skills-lock.json`) | Jakub Krehel | MIT (upstream LICENSE) | Keep notice | `.claude/skills/make-interfaces-feel-better/` | **Licensed, notice missing** |
| `mobile-design` | Unknown (published copies exist under several accounts) | Unknown | **None stated** | Unknown | `.claude/skills/mobile-design/` | **Unresolved** |
| `senior-architect`, `senior-backend`, `senior-frontend`, `ui-design-system` | https://github.com/alirezarezvani/claude-skills (likely) | Alireza Rezvani | MIT (upstream LICENSE) | Keep notice | `.claude/skills/senior-*/`, `ui-design-system/` | **Licensed, notice missing;** origin unconfirmed |
| `skill-creator` | Anthropic skills collection (https://github.com/anthropics/skills) | Anthropic | Apache-2.0 (`LICENSE.txt` present) | Keep `LICENSE.txt` | `.claude/skills/skill-creator/` | Licensed |
| `ui-ux-pro-max` | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | Next Level Builder | MIT (upstream LICENSE) | Keep notice | `.claude/skills/ui-ux-pro-max/` | **Licensed, notice missing.** Contains font and colour data tables (names and pairings, no font files) |
| `.claude/settings.json`, `skills-lock.json` | This project | — | — | — | repo root / `.claude/` | Original configuration |

**Recommended handling** (owner decision, OD-19): keep `.claude/` out of a public repository (move it to a private repository or `.gitignore`), or add each upstream licence file and remove `clean-code` and `mobile-design` until their origin is known.

## 6. Astronomy references and facts (Free Roam)

| Item | Origin | Licence / basis | Attribution | Location | Status |
|---|---|---|---|---|---|
| Galaxy facts (10 galaxies), 23 real-object fact lines | 57 sources in `catalogue/data/sources.ts`: NASA (science.nasa.gov, APOD, Hubble Messier Catalog, Chandra, GSFC, JPL/Spitzer), ESA, ESA/Webb, ESA/Hubble, ESO, NOIRLab, EHT, MIT News, LBNL, *Nature*, Britannica, Wikipedia (secondary) | **Facts are not protected by copyright;** the lines are written in GALAXIA's own words. NASA text is generally US-government public domain. ESA / ESA/Webb / ESA/Hubble / ESO / NOIRLab texts and images are CC BY 4.0. Britannica and Wikipedia (CC BY-SA) are cited for facts only | Credits in `public/THIRD_PARTY_NOTICES.txt` §3 (shipped), with full URLs in `ASTRONOMY_SOURCES.md` | `src/modes/freeroam/catalogue/data/` | Fact / licensed. **Fixed in Prompt 15:** the Cartwheel Core line followed ESA/Webb's sentence closely and was reworded (S-1) |
| Agency names (NASA, ESA, ESO, Webb, Hubble) | — | Named as sources only. No logos or insignia are used, and no endorsement is implied | Statement in the notices | Data and docs only, not in the game UI | OK. Do not add agency logos without permission |
| Telescope imagery | — | **None used.** All map and sector art is procedural | — | — | — |

## 7. Trademarks referenced

| Mark | Owner | Where it appears | Basis | Status |
|---|---|---|---|---|
| *Galaga*, *Galaxian* | Bandai Namco Entertainment Inc. (*Galaxian*: US Reg. 2095564 and 3230317) | README, design docs, notices (inspiration and no-affiliation statements). **Not** in shipped game code or UI (`RELEASE_CHECKLIST.md` naming check) | Descriptive reference to the inspiration | **Unresolved:** see T-1 for the closeness of the name GALAXIA and the presentation |
| NASA, ESA, ESO, Webb, Hubble | Respective agencies | Source credits | Factual reference | OK |
| Chrome, Firefox, Safari / WebKit | Respective owners | Docs (test reports) | Factual reference | OK |

## 8. Maintenance

- **New asset or package:** add a row here first. The test lists what it checks.
- **New sources:** use `npm run catalogue:doc` to regenerate `ASTRONOMY_SOURCES.md`. Write facts in your own words, and never paste press-release sentences.
- **Before publishing the repository:** resolve §5 (OD-19), replace the placeholder copyright holder in `LICENSE` (OD-18: MIT chosen) and complete the review actions in `IP_AND_ASSET_AUDIT.md` §7.
- **Release archive** (`GALAXIA-Game-Release.zip`): contains what is needed to build, run, test and deploy, plus this register, `ASTRONOMY_SOURCES.md`, `LICENSE` and the shipped `THIRD_PARTY_NOTICES.txt`. It excludes `.claude/`, `skills-lock.json` (§5) and the internal review documents, including `IP_AND_ASSET_AUDIT.md`; references to those documents point to the source repository.
