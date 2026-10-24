# GALAXIA

**An original browser space game with two modes: a fixed-screen arcade shooter and an open-space exploration game.**

Vite · TypeScript · HTML Canvas 2D · Web Audio API · Vitest

- **Status: prepared for open testing.** Classic Mode is complete. Free Roam is a playable prototype. Automated checks pass on the current build, but **nobody has playtested it yet**, it has **not been tested on physical phones, tablets or game controllers**, and it has **not been deployed** anywhere. See [Known limitations](#known-limitations-and-open-testing-notes).
- **Licence:** [MIT](LICENSE) for GALAXIA's own code and content. The copyright holder line in `LICENSE` is still a placeholder.
- **Runs in:** current desktop and mobile browsers, as a static site with no server, accounts or tracking.
- **How to play:** the [Player Guide](docs/PLAYER_GUIDE.md) covers every control, the Hangar, the Armory and Guild marks. The same help is in the game under **HOW TO PLAY**.

---

## Contents

**Playing:** [Screenshots](#screenshots) · [What GALAXIA is](#what-galaxia-is) · [Features](#features) · [Quick start](#quick-start) · [Controls](#controls) · [Hangar](#hangar-and-ship-selection) · [Armory](#armory-and-weapon-loadouts) · [Guild marks](#guild-marks-credits) · [Tutorial and HOW TO PLAY](#first-run-tutorial-and-how-to-play) · [Classic progression](#classic-progression-and-the-wave-20-gate)

**Developing:** [Development setup](#development-setup) · [Build and verification](#build-and-verification) · [Release archive](#release-archive) · [Hosting on GitHub Pages](#hosting-on-github-pages) · [Project structure](#project-structure) · [Architecture](#architecture-in-brief) · [Save data](#save-data-and-browser-support)

**Status:** [What has been verified](#what-has-been-verified) · [Known limitations](#known-limitations-and-open-testing-notes) · [Licence and attribution](#licence-and-attribution) · [Reporting issues and contributing](#reporting-issues-and-contributing)

---

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/media/mode-select.png" alt="GALAXIA title screen: the pixel-art GALAXIA logo above two mode cards, CLASSIC and FREE ROAM, on a starfield"></td>
    <td width="50%"><img src="docs/media/classic-responsive.png" alt="Classic Mode in Responsive Display: the GALAXIA score label top left, enemy formations diving toward the player's fighter, controls and scoring panels in the side margins"></td>
  </tr>
  <tr>
    <td align="center"><sub>Mode select</sub></td>
    <td align="center"><sub>Classic: Responsive Display (default)</sub></td>
  </tr>
  <tr>
    <td><img src="docs/media/classic-arcade.png" alt="Classic Mode in Arcade Display: the same playfield inside a centred, framed arcade screen"></td>
    <td><img src="docs/media/freeroam-galaxy-map.png" alt="Free Roam Galaxy Map: ten galaxies connected by routes, the Milky Way selected with its description, exploration progress and route list"></td>
  </tr>
  <tr>
    <td align="center"><sub>Classic: Arcade Display</sub></td>
    <td align="center"><sub>Free Roam: Galaxy Map</sub></td>
  </tr>
  <tr>
    <td><img src="docs/media/freeroam-sector.png" alt="Free Roam local sector: the player's ship beside an ice planet, a chevron next to the ship pointing toward the planet's pull, the dotted gravity field ring, and the ship status card"></td>
    <td align="center"><img src="docs/media/classic-phone.png" width="170" alt="Classic Mode on an emulated phone in portrait: the playfield above a touch control strip with a slide pad, pause and info buttons, and a FIRE button"></td>
  </tr>
  <tr>
    <td align="center"><sub>Free Roam: a planet's gravity ring and pull arrow</sub></td>
    <td align="center"><sub>Classic on a phone (touch controls)</sub></td>
  </tr>
</table>

<sub>Captured from the release build in headless Chromium on 2026-10-21 and 2026-10-22 (desktop 1280×720; phone emulated at 390×844). Some screens have changed since: the title screen now has a HOW TO PLAY button, and the Free Roam ship card now shows the selected weapon and the Guild marks balance.</sub>

---

## What GALAXIA is

GALAXIA is a browser game with two very different ways to fly. Both run on one page and share settings and display handling, but each keeps its own progress.

- **Classic Mode** is a fixed-screen arcade shooter in the style of early-1980s formation shooters. Alien squadrons fly in along scripted paths, settle into formation and break off to dive at you. Your fighter moves left and right only, and the screen never scrolls. You play for score, wave after wave.
- **Free Roam** is an exploration game. You fly in any direction through generated star-system sectors: chart them, salvage, fight four factions, trade and dock at stations to change ships and weapons. A map links 10 galaxies and 170 systems (real galaxies, stylised and not to scale), with missions and one currency, Guild marks.

The two modes meet in one place: after you complete Wave 20 in Classic, the ships you have unlocked in Free Roam can fly in Classic too, with their weapons.

---

## Features

### Classic Mode

- 40-enemy formations with scripted entry flights, diving attacks with escorts and aimed enemy fire.
- **Capture and rescue:** a commander can capture your fighter with a tractor beam; shoot it while it dives to win the captive back and fly a twin fighter.
- **Challenging Stages** (stage 3, then every fourth stage), transforming scouts from stage 4, and extra fighters at 20,000 and 70,000 points, then every 70,000.
- Endless stages; the game ends when your last fighter is lost. Holding fire builds **heat**, and a long hold overheats the gun briefly.
- Two display styles: **Responsive Display** (default, as large as the screen allows) and **Arcade Display** (a centred, framed arcade screen).
- After **Wave 20**: a SHIP choice on the Classic title and weapon switching with roster ships (see [Classic progression](#classic-progression-and-the-wave-20-gate)).

### Free Roam (playable prototype)

- **Navigation:** a Galaxy Map of 10 galaxies and a System Map for each (170 systems in total), with route planning and locked destinations. Every jump is confirmed.
- **Sectors:** every system has a generated sector with stars, planets, asteroid fields, wrecks, caches, anomalies, ore veins, stations and gates.
- **Flight:** any direction with assisted inertia, boost, a follow camera with zoom, optional mouse aim, and planet and star gravity that pulls only your ship.
- **Combat:** four original factions with eight enemy families, met in patrols, outposts, ambushes, elite duels and capital-ship fights. Target lock turns your nose toward a chosen hostile (facing only).
- **Ships and weapons:** six ships, bought with cargo once you hold their licence, in a station **Hangar**; four weapons configured per ship in the **Armory**.
- **Economy:** one currency, **Guild marks**, earned from missions, sales, encounters, discoveries and capped bounties, and spent on reactor cells, modules and upgrades.
- **Progress:** a ten-mission story chain, contract boards, cargo and crafting, three save slots, and recovery that never strands you.

### For every player

- **First-run tutorial** and a **HOW TO PLAY** guide you can reopen at any time.
- Keyboard, mouse, touch and controller, mixed freely (the newest input wins). Touch controls appear only on touch screens.
- Free Roam keys can be rebound. Menus work fully from the keyboard, with visible focus.
- The game pauses and releases held inputs when the tab is hidden, the window loses focus or a phone is rotated.
- Reduced motion (follows the system setting by default), glow and pixel-scaling options, and fullscreen where the browser supports it.
- All sprites, the font and the sounds are generated in code; there are no image, font or audio files to download, and no network requests after loading except the one-time download of Free Roam's code from the same site.

---

## Quick start

GALAXIA is distributed as source code. To play a local copy you need **Node.js 22.18 or newer** (the project uses Node 24, see [`.nvmrc`](.nvmrc)) with npm.

```sh
npm ci            # install the exact tool versions from package-lock.json
npm run build     # typecheck, then build the game into dist/
npm run preview   # serve it at http://localhost:4173/
```

Open the address shown in the terminal. For quick experiments, `npm run dev` starts a development server at http://localhost:5173/ instead.

**What to expect:** the title screen shows the GALAXIA logo and two mode cards, **CLASSIC** and **FREE ROAM**. On your first visit, a six-step tutorial opens over it; you can step through it or press **SKIP TUTORIAL**. Choose a mode with the arrow keys and Enter, by clicking, or by tapping. Sound starts after your first key press, click or tap.

To try it on a phone, the preview and development servers listen on your local network; open the computer's network address shown in the terminal. Touch controls appear automatically on a touch screen.

---

## Controls

These are the defaults from the current code. The [Player Guide](docs/PLAYER_GUIDE.md) adds map, panel and station controls and explains each action in more detail.

### Classic Mode

Classic keys are fixed.

| Action | Keyboard | Touch | Controller |
|---|---|---|---|
| Move left / right | ← → or A D | Slide along the ◀ ▶ pad | Left stick or D-pad |
| Fire (hold to keep firing; heats the gun) | Space, Z or X | **FIRE** | A or X |
| Next weapon (**only after Wave 20**, with a roster ship) | Q | Weapon button above **FIRE** | Y |
| Pause | P or Esc | **II** | Start |
| Mute | M | In SETTINGS | — |

Classic has no boost, camera zoom or target lock.

### Free Roam

Keyboard keys are defaults and can be rebound under pause → **CONTROLS**.

| Action | Keyboard and mouse | Touch | Controller |
|---|---|---|---|
| Fly in any direction | W A S D or arrow keys | Floating stick (drag on open space) | Left stick or D-pad |
| Fire (hold; heats the weapon) | Space or J | **FIRE** | RT, RB or X |
| Boost (hold; uses energy) | Left or right Shift | **BOOST** | LB or LT |
| Next weapon (never fires) | Q or K | Weapon button above **FIRE** | R3 |
| Target lock on / off | X | **LOCK** (left side) | — |
| Next target (only while locked) | C | **»** beside LOCK | — |
| Camera zoom | Mouse wheel, or = and − | Pause → CONTROLS → ZOOM | — |
| Interact (dock, open, inspect, gate) | E or Enter | Button that appears in range | A |
| Sector map / cargo | M / I | **MAP** / **CARGO** | Select / Y |
| Pause | Esc or P | **II** | Start |

- **The mouse wheel only zooms** the camera, centred on your ship. It never switches weapons.
- **Target lock is facing only.** X locks the hostile nearest your nose that is in range and in sight, and your ship's nose turns to face it. It never moves the ship, chases, dodges or fires; you still steer, boost and shoot yourself. Press X again to release it at once.
- **C** moves the lock to the next hostile in range (clockwise, wrapping round); it does nothing without a lock and never fires.
- Mouse aim is optional (CONTROLS → MOUSE AIM, off by default). Target lock and next target are not available on a controller.

---

## Hangar and ship selection

Dock at a Free Roam station and open the **HANGAR** tab.

- Select a ship card to inspect its speed, handling, hull, shield, hold and weapons. Inspecting never changes your ship.
- **Owned** ships: **SELECT SHIP**, then **CONFIRM**.
- **Available** ships: **ACQUIRE** pays **cargo materials** from your hold (not Guild marks). **NEED CARGO** means your hold is short.
- **Locked** ships show the licence they need (survey runs, a milestone or a galaxy to visit) and your progress.

The roster is the **Petrel** (starting ship), **Swift**, **Magpie**, **Shrike**, **Condor** and **Albatross**. Their licences and costs are listed in the [Player Guide](docs/PLAYER_GUIDE.md#hangar-ships).

## Armory and weapon loadouts

Open the **ARMORY** tab of a docked station (or **ARMORY ▸** in the Hangar) to set up the ship you are flying.

| Weapon | Ammunition | Fits |
|---|---|---|
| Plasma Cannon (primary) | Unlimited; overheats if held too long | All ships |
| Lock-On Missile | 30 boost energy per shot, then a cooldown | All ships |
| Heavy AoE Missile | 4 rounds, refilled free when you dock | Petrel, Shrike, Condor, Albatross |
| Nuke | 1 round, refilled free when you dock | Condor, Albatross |

- Each card shows the weapon's role, ammunition and which ships can mount it; weapons your ship cannot mount stay visible with the reason.
- **SET AS START** picks the weapon selected at launch. **ADD / REMOVE FROM CYCLE** decides what Next weapon steps through. The Plasma Cannon is always in the cycle.
- The Armory sells nothing; ammunition is restocked free when you dock.

## Guild marks (credits)

Free Roam's only currency is **Guild marks**, shown as `◈ 1,240 MARKS` on the ship card in flight and on every station screen. A new pilot starts with 0 marks. Classic has no currency, only score.

- **Earn:** mission and contract rewards, selling cargo at a station exchange, clearing an encounter (once each), first discoveries, and small bounties for hostiles you destroy (a limited pool per system).
- **Spend:** reactor cells, equipment modules and ship upgrades.
- **Not paid in marks:** ships (cargo plus a licence), travel (reactor cells, with free emergency options), repairs and restocking (free on docking).
- **Purchases are confirmed:** the first press shows the price and your balance before and after; **CONFIRM** pays and **BACK** cancels. If you cannot afford something, the button shows `INSUFFICIENT MARKS` with the amount required, available and short.
- Recent balance changes are listed under pause → **RECORD**.

## First-run tutorial and HOW TO PLAY

- **When it appears:** automatically, the first time you reach the title screen. It has six steps (Welcome, Ships, Weapons, Controls, Guild marks, Start), with a step counter and progress bar. The Controls step switches between **CLASSIC / FREE ROAM** and **KEYBOARD / TOUCH / CONTROLLER**, and shows your own Free Roam key bindings.
- **Skip or finish:** **SKIP TUTORIAL** or Esc closes it; **FINISH**, **PLAY CLASSIC** or **PLAY FREE ROAM** completes it. Either way it is remembered on this device and does not reappear on every visit or every run. If a later update changes the core controls, it appears once more.
- **It changes nothing else:** opening, skipping or finishing it never touches saves, ships, weapons, Guild marks or unlocks, and nothing you press while it is open reaches the game.
- **Reopen it** (this never resets it): the **HOW TO PLAY** button on the title screen (or H, or Y on a controller), or pause → **HOW TO PLAY** during a Free Roam flight. Classic's **HOW TO PLAY** (title and pause menus) shows Classic's own controls and scoring card.

## Classic progression and the Wave 20 gate

- Classic saves your **high score** and **best stage** on this device.
- **Completing Wave 20** (clearing it, not just reaching it) is remembered permanently and opens two things in Classic:
  - **SHIP** on the Classic title, listing the roster ships you have unlocked in any Free Roam save slot. The original GALAXIA fighter stays the default.
  - **Weapon switching** (Q, the weapon button above FIRE, or Y) when flying a roster ship, using the start weapon and cycle saved in the Armory. Its ammunition refills at the start of every stage.
- Classic never grants ships; they are acquired only in Free Roam. Before the gate, Classic and Free Roam progress stay fully separate.

---

## Development setup

### Prerequisites

- **Node.js 24** (the version in [`.nvmrc`](.nvmrc)); the minimum is **22.18**, which can run the TypeScript scripts in `scripts/` directly.
- **npm**, bundled with Node.js. The project uses npm and `package-lock.json`; please do not add another package manager's lockfile.

No accounts, API keys or environment secrets are needed. The game has **no runtime dependencies**; the four development dependencies are TypeScript, Vite, Vitest and `@types/node`, pinned in `package-lock.json`.

### Install and run

```sh
npm ci          # install exactly the versions in package-lock.json
npm run dev     # development server at http://localhost:5173/ (also on your local network)
```

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server, with developer-only URL options |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve `dist/` at http://localhost:4173/ |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | All Vitest tests |
| `npm run check` | Typecheck, tests, production build and `verify:dist` in one step |
| `npm run verify:dist` | Check the built `dist/` before publishing |
| `npm run test:soak` | Long Classic soak run (seeded autopilot games with invariant checks) |
| `npm run build:e2e` / `npm run preview:e2e` | Release build plus read-only test hooks (into `dist-e2e/`) for the browser test scripts, and a server for it |
| `npm run build:qa` | Production build with developer tools, for device testing only; never deploy it |
| `npm run icons` | Regenerate the favicons in `public/` |
| `npm run sprites:sheet` | Export sprite contact sheets for art review |
| `npm run catalogue:doc` | Regenerate the source tables in `docs/freeroam/ASTRONOMY_SOURCES.md` |

### URL options

| Option | Builds | Effect |
|---|---|---|
| `?mode=classic` / `?mode=freeroam` | All | Open that mode directly (skips the automatic tutorial) |
| `?seed=<n>` | All | Reproducible Classic enemy behaviour |
| `?controls=touch` / `?controls=keyboard` | All | Force the touch or desktop layout |

Development and QA builds (`npm run dev`, `npm run build:qa`) also accept developer options: `?stage=<n>` (start at a Classic stage), `?debug=1` (hitboxes), `?view=hangar` (sprite viewer) and `?mode=freeroam&lab=gravity` (the experimental **Gravity Flight** test sector with its tuning panel). **Release builds compile these tools out** and ignore the parameters; `verify:dist` fails a build that contains them. Ordinary planet and star gravity in Free Roam is part of the game and stays in release builds.

---

## Build and verification

```sh
npm run check            # typecheck + all tests + production build + verify:dist
```

- **Base path:** without `BASE_PATH`, the build uses relative URLs and works from any folder. For a specific hosting path, such as a GitHub project page at `/galaxia/`, use the same value for the build, the check and the preview:

  ```sh
  BASE_PATH=/galaxia/ npm run build
  BASE_PATH=/galaxia/ npm run verify:dist
  BASE_PATH=/galaxia/ npm run preview     # http://localhost:4173/galaxia/
  ```

  On Windows PowerShell, set the variable first: `$env:BASE_PATH="/galaxia/"; npm run build`.
- **`verify:dist`** ([`scripts/verify-dist.ts`](scripts/verify-dist.ts)) fails if a URL is missing the base path or names a missing file, if developer tools, the Gravity Flight test sector, test hooks or source maps are present, if Free Roam is bundled into the first download, or if a gzip size budget is exceeded.
- **Tests:** Vitest suites run in Node, deterministic (seeded) and offline: the Classic engine, Free Roam generation, navigation, combat, gravity, economy, saves and migrations, the tutorial content and state, input and layout maths, architecture boundaries and release packaging. Seventeen opt-in measurement runs are reported as skipped unless enabled with an environment variable (for example `COMBAT_MEASURE=1`).
- **Browser scripts (optional):** `docs/development/playtest/` contains Playwright scripts that drive the built game in real browser engines. Playwright is not a project dependency; install it in a separate folder (`npm i playwright && npx playwright install chromium`), then, for example:

  | Script | Checks | Run against |
  |---|---|---|
  | [`release-smoke.mjs`](docs/development/playtest/release-smoke.mjs) | The release build: both modes, pause and resume, the HUD at several sizes, settings across a reload, and the first visit (tutorial opens, SKIP is remembered, HOW TO PLAY reopens it) | `npm run preview` |
  | [`release-p16.mjs`](docs/development/playtest/release-p16.mjs) | Both modes behind a built-in GitHub Pages-like server: lazy loading, saves across a reload, deep links, the 404 page | A `build:e2e` output folder |
  | [`pause-resume.mjs`](docs/development/playtest/pause-resume.mjs) | Pause and resume by button and key, mid-attack, with tab switches | `npm run preview:e2e` |
  | [`controller-sim.mjs`](docs/development/playtest/controller-sim.mjs) | A simulated gamepad: connect, play, pause, disconnect and reconnect | `npm run preview:e2e` |
  | [`arcade-display.mjs`](docs/development/playtest/arcade-display.mjs) | Responsive and Arcade Display across screen sizes, switching mid-game | `npm run preview:e2e` |

  ```sh
  BASE_PATH=/galaxia/ npm run build && BASE_PATH=/galaxia/ npm run preview
  node docs/development/playtest/release-smoke.mjs http://localhost:4173/galaxia/ chromium
  ```

## Release archive

The release archive is a source package: one `GALAXIA/` folder with the source, `public/`, tests, scripts, configuration, `package-lock.json`, this README, the [Player Guide](docs/PLAYER_GUIDE.md), the licence and attribution files, the README screenshots and the release browser scripts.

```sh
node scripts/release-zip.ts --list                          # show what would be packaged (writes nothing)
node scripts/release-zip.ts --out ../GALAXIA-release.zip    # build it (outside the repository)
node scripts/verify-release-zip.ts ../GALAXIA-release.zip   # check an archive
```

- Files come from git (tracked plus untracked-but-not-ignored) filtered by a fixed include list, so archives are built from a git checkout of the source repository, not from an extracted archive. Hard exclusions apply at any depth and in any letter case: AI-assistant folders and instruction files (including **`.claude/`**), `.git/`, `node_modules/`, build output, caches, logs, environment and credential files, temporary files and nested archives such as an older release ZIP. Internal design records and developer documents are not packaged.
- The builder refuses to write inside the repository or over an existing file, checks the archive in memory, writes it, then reads it back and verifies it again; a failing archive is deleted.
- The verifier reads the archive itself (every entry's CRC and name) and fails on any `.claude` path component, forbidden or unexpected files, missing required files, secret-like strings or README links the archive does not contain.
- Archives are reproducible: every entry carries one timestamp (`SOURCE_DATE_EPOCH`, else the last commit time) and files are in a fixed order, so the same tree gives the same bytes.

To use an archive: extract it, `cd GALAXIA`, then follow [Quick start](#quick-start). In an extracted copy, a few tests that compare against internal documents or need a git checkout are reported as skipped.

## Hosting on GitHub Pages

The repository includes [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which typechecks, tests, builds, verifies and publishes the site with GitHub's official Pages actions (pinned to full commit SHAs, no secrets, a short-lived OIDC token for the deploy job). **It has never been run**, and no repository, remote or live address exists yet.

To publish it yourself:

1. Push the project to a GitHub repository of your own, on the `main` branch.
2. In that repository, open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. The push runs the workflow (it can also be started from the Actions tab). The workflow asks GitHub for the correct base path, so the repository name never needs to be written anywhere.

A failing step stops the run before anything is published. After the first deployment, check that the title screen shows both modes, the browser's network panel has no failed requests, and `<site>/THIRD_PARTY_NOTICES.txt` loads. A blank page or `assets/…` 404s locally usually means the preview's `BASE_PATH` differs from the build's.

---

## Project structure

```text
.
├── index.html                 Page shell and boot watchdog
├── package.json               Scripts and development dependencies (npm)
├── package-lock.json          Exact dependency versions
├── vite.config.ts             Base path, build flags, 404 page, test config
├── tsconfig.json              Strict TypeScript settings
├── .nvmrc                     Node.js version
├── LICENSE                    MIT licence
├── .github/workflows/         deploy.yml: test, build, verify and deploy to GitHub Pages
├── public/                    Favicons and THIRD_PARTY_NOTICES.txt, copied to the site as-is
├── src/
│   ├── main.ts                Entry point: mounts the mode host
│   ├── modes/                 Mode host, title flow and cross-mode ship progression
│   │   ├── classic/           Runs Classic inside the mode host
│   │   ├── guide/             First-run tutorial and HOW TO PLAY guide (loaded on demand)
│   │   └── freeroam/          Free Roam (a separate chunk, loaded when first chosen)
│   │       ├── galaxy/        Galaxy Map and System Map
│   │       ├── sector/        Sector generation, simulation and planet gravity
│   │       ├── catalogue/     Galaxy and star-system data with cited sources
│   │       ├── combat/        Factions, enemies, weapons, target lock, hazards, encounters
│   │       ├── ships/         Ship roster, Hangar, Armory, equipment, upgrades
│   │       ├── inventory/     Resources, loot, cargo hold, fabricator, milestones
│   │       ├── progression/   Missions, contracts, Guild marks ledger, reactor cells, record
│   │       ├── gravity/       Gravity Flight test sector (development and QA builds only)
│   │       └── ui/            Panels, HUD and overlays
│   ├── core/                  Classic simulation and shared weapon rules (pure TypeScript, no DOM)
│   ├── game/                  Classic shell: frame loop, presentation, menus
│   ├── render/                Classic renderer, viewport fitting, effects
│   ├── ui/                    Classic HUD, menus and side panels
│   ├── input/                 Keyboard, touch and gamepad adapters
│   ├── audio/                 Web Audio synthesiser
│   ├── persistence/           Classic save data and safe storage
│   ├── shared/                Services both modes use: lifecycle, prefs, records, title screen
│   ├── config/                Tunable data: scoring, difficulty, stages, weapons, palette, audio
│   ├── assets/                Pixel-grid sprite and bitmap-font definitions
│   └── showcase/              Developer sprite viewer (development and QA builds only)
├── tests/                     Vitest suites, fixtures and helpers
├── scripts/                   Build verifier, release archive builder and verifier, soak runner, generators
└── docs/
    ├── PLAYER_GUIDE.md        How to play (shipped with the release)
    ├── media/                 README screenshots
    ├── freeroam/              Design and decision records; the asset licence register and astronomy sources ship
    └── development/           Developer records and the Playwright browser scripts
```

The source repository also contains internal design records, decision logs, QA reports and assistant configuration (`.claude/`). They document how the game was built, are not part of the game, and are left out of the release archive.

## Architecture in brief

- **Mode host:** `src/main.ts` mounts a host that shows the title screen and runs one mode at a time. Each mode has the same lifecycle (`init`, `activate`, `pause`, `resume`, `dispose`) and owns its state, loop, rendering, input and saves; leaving a mode disposes of everything it created. Free Roam and the tutorial are loaded through dynamic `import()`.
- **Simulation:** Classic's simulation (`src/core/`) is pure TypeScript with fixed 60 Hz steps, deterministic for a given seed; the renderer only reads it. Free Roam sectors are generated deterministically from each system's seed; only progress is saved.
- **Input:** small adapters turn keyboard, touch and gamepad input into abstract actions. Free Roam reads its rebindable key map, the touch stick and the gamepad into one flight-control state.
- **Display:** one viewport system handles CSS size, device pixel ratio, safe areas, resizing and rotation for both modes. An adaptive render-scale controller lowers the game canvases' resolution after sustained slow frames and restores it gradually.
- **Boundaries:** `tests/architecture.test.ts` enforces layer rules (for example, Classic never imports Free Roam, and the simulation never touches the DOM). `vite.config.ts` turns developer tools, the Gravity Flight test sector and test hooks into compile-time flags that release builds switch off.

## Save data and browser support

Everything is stored as versioned JSON in the browser's `localStorage`, on the current device only.

| Key | Contents |
|---|---|
| `galaxia:save` | Classic high score and best stage |
| `galaxia:prefs` | Shared settings: sound and volumes, glow, pixel scaling, motion, Arcade Display |
| `galaxia:freeroam:prefs` | Free Roam controls: key bindings, mouse aim, zoom |
| `galaxia:freeroam`, `galaxia:freeroam:slot2`, `galaxia:freeroam:slot3` | The three Free Roam save slots |
| `galaxia:freeroam:slots` | Which Free Roam slot is in use |
| `galaxia:fleet` | Whether Classic Wave 20 is complete, the ships shared with Classic, and the ship chosen there |
| `galaxia:guide` | Whether the tutorial was finished or skipped, and for which guide version |

- Damaged records are repaired and old ones migrated, with a backup copy written first. A save from a newer version is read but never overwritten.
- There are no accounts, cloud sync, save export or online leaderboard. Clearing site data or using a private window removes saves. If storage is blocked, the game still plays and says that progress lasts only until the tab closes.
- GALAXIA targets current Chromium-based browsers, Firefox and Safari on desktop and mobile, and needs JavaScript, Canvas 2D and ES2022. There is no offline mode (no service worker).

---

## What has been verified

**Automated, on the current code (2026-10-23):**

- `npm run check` passes: typecheck, the Vitest suite (1,911 passed; the 17 opt-in measurement runs skipped), the production build and `verify:dist` (first download 94.4 kB gzip of a 110 kB budget; Free Roam 194.4 kB of 225 kB, loaded only when chosen).
- Browser scripts in headless Chromium: the release smoke test (both modes and the first visit), the GitHub Pages-like server check, Arcade Display across sizes, pause and resume, plus QA-build scripts for the tutorial (desktop and 320–390 px touch layouts), controls, Hangar, economy and Classic weapons. The Armory script passes 44 of 46 checks; its 2 failures (the Nuke card's disabled actions on the Petrel, and the Lock-On detail text) predate this release and are unresolved.
- The release archive: built, verified, extracted into a fresh folder outside the repository, installed with `npm ci`, and checked there with typecheck, tests, a production build and `verify:dist`.

**Not performed:**

- No person has playtested this build, including the tutorial, target lock, zoom, the Armory and the economy.
- No physical phones or tablets (including iOS Safari), real game controllers, real GPUs or high-refresh displays, and no listening check of the audio. Touch layouts were checked only in emulation.
- Firefox and WebKit were not re-run for this build; earlier releases ran there in headless form.
- Performance was measured only in headless, software-rendered Chromium on a two-core machine; no frame rate is promised.

## Known limitations and open-testing notes

- **Open testing:** expect balance and feel issues. Combat tuning, gravity strength, marks rewards and prices come from simulations and automated checks, not from players.
- **Free Roam is a prototype:** route risk, lane hazards and transit events are shown on the maps but have no gameplay effect yet; prices are fixed, with no market between stations; touch play has no aim assist; target lock and next target are not mapped on a controller.
- **Classic:** a single high score (no name entry or table); the score caps at 9,999,990; a few original arcade rules that could not be confirmed are configurable.
- **General:** sound effects and short jingles only (no music); English only; saves are local to one browser.
- **Before any public release:** the copyright holder in `LICENSE` must be filled in, and the open owner decisions on the name and the Classic presentation remain (see below).

## Licence and attribution

- **GALAXIA's own code and content** are released under the [MIT licence](LICENSE). The software comes with no warranty. The copyright holder line is a clearly marked placeholder that the owner must replace before publishing.
- **Original assets:** all sprites, the bitmap font and the icons are defined in code, and all sounds are synthesised at runtime. The project contains no sprites, logos, sounds, music, ROM data or source code from any commercial game, and loads no external fonts, images or scripts.
- **Third-party code:** the only third-party code in the published site is Vite's module-preload helper (MIT); its notice is in [`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt). Build and test tools are not shipped.
- **Astronomy references:** Free Roam's real-world facts are written in GALAXIA's own words from cited sources (NASA, ESA, ESA/Webb, ESA/Hubble, ESO, NOIRLab and others), listed in [`docs/freeroam/ASTRONOMY_SOURCES.md`](docs/freeroam/ASTRONOMY_SOURCES.md). No agency images or logos are used, and no agency endorses GALAXIA.
- **Asset register:** every asset, package and reference, with its origin and licence, is listed in [`docs/freeroam/CONTENT_AND_ASSET_LICENSES.md`](docs/freeroam/CONTENT_AND_ASSET_LICENSES.md).
- **Inspiration and open questions:** Classic Mode is an independent homage inspired by early-1980s arcade formation shooters, especially *Galaga*. It is not affiliated with, endorsed by or licensed by Bandai Namco Entertainment or any other rights holder, and *Galaga* is a trademark of its owner. The code and art are original, but the Classic presentation deliberately follows that style closely, and the name GALAXIA is similar to an existing arcade trademark. Both are open owner decisions. **The project has not received legal clearance**, and the MIT licence does not change that.

## Reporting issues and contributing

There is no public issue tracker yet. When reporting a problem from open testing, include:

- the mode (Classic or Free Roam) and, for Classic, the display style;
- your browser and version, operating system and device, and whether you used keyboard, mouse, touch or a controller;
- the steps to reproduce, what you expected and what happened;
- any errors from the browser console, and a screenshot for layout problems.

Saves hold only game progress, but they are yours; never post them if you consider anything in them private.

**When proposing a change:** keep it focused and follow the existing structure (tunable values in `src/config/`, simulation logic free of DOM access, each mode independent of the other); add or update tests for behaviour you change; run `npm run check` before submitting; and record the origin and licence of any third-party asset in [`docs/freeroam/CONTENT_AND_ASSET_LICENSES.md`](docs/freeroam/CONTENT_AND_ASSET_LICENSES.md).
