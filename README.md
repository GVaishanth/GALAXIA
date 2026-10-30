# GALAXIA

**An original browser space game with two modes: a fixed-screen arcade shooter and an open-space exploration game.**

Vite · TypeScript · HTML Canvas 2D · Web Audio API · Vitest

- **Status: prepared for open testing.** Classic Mode is complete. Free Roam is a playable prototype. Automated checks pass on the current build, but **nobody has playtested it yet**, it has **not been tested on physical phones, tablets or game controllers**, and it has **not been deployed** anywhere. See [Known limitations](#known-limitations-and-open-testing-notes).
- **Last updated:** 2026-10-30. See [What's new in the 2026-10-30 missions and faction heat archive](#whats-new-in-the-2026-10-30-missions-and-faction-heat-archive).
- **Licence:** [MIT](LICENSE) for GALAXIA's own code and content. The copyright holder line in `LICENSE` is still a placeholder.
- **Runs in:** current desktop and mobile browsers, as a static site with no server, accounts or tracking.
- **How to play:** the [Player Guide](docs/PLAYER_GUIDE.md) covers every control, the Hangar, the Armory, Guild marks and crew. The in-game **HOW TO PLAY** covers controls (including faint signals), ships, weapons and Guild marks (not crew yet).

---

## Contents

**Playing:** [Screenshots](#screenshots) · [What GALAXIA is](#what-galaxia-is) · [Features](#features) · [Quick start](#quick-start) · [Controls](#controls) · [Hangar](#hangar-and-ship-selection) · [Armory](#armory-and-weapon-loadouts) · [Gravity and STOP](#gravity-stop-and-station-keeping) · [Faint signals](#faint-signals) · [Guild marks](#guild-marks-credits) · [Crew and the Bridge](#crew-and-the-bridge) · [Ship Mind and crew advice](#ship-mind-navigator-and-surveyor-advice) · [Tutorial and HOW TO PLAY](#first-run-tutorial-and-how-to-play) · [Classic progression](#classic-progression-and-the-wave-20-gate)

**Developing:** [Development setup](#development-setup) · [Build and verification](#build-and-verification) · [Release archive](#release-archive) · [Hosting on GitHub Pages](#hosting-on-github-pages) · [Project structure](#project-structure) · [Architecture](#architecture-in-brief) · [Save data](#save-data-and-browser-support)

**Status:** [What's new](#whats-new-in-the-2026-10-30-missions-and-faction-heat-archive) · [What has been verified](#what-has-been-verified) · [Known limitations](#known-limitations-and-open-testing-notes) · [Licence and attribution](#licence-and-attribution) · [Reporting issues and contributing](#reporting-issues-and-contributing)

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
- **Two flight modes:** **NORMAL** (the default, unchanged assisted flight) and an opt-in **REALISTIC** mode with momentum, rotate-and-thrust steering and gravity that bends your path, plus **STOP**, which brakes and then holds position by station-keeping.
- **Combat:** four original factions with eight enemy families, met in patrols, outposts, ambushes, elite duels and capital-ship fights. Target lock turns your nose toward a chosen hostile (facing only).
- **Faint signals:** an anomaly you have not investigated yet hides its source inside a dashed ring. Take bearings from different positions with INTERACT; two lines far enough apart fix the source, then investigate there. An optional **Simple Signals** setting makes one bearing enough. See [Faint signals](#faint-signals).
- **Ships and weapons:** six ships, bought with cargo once you hold their licence, in a station **Hangar**; four weapons configured per ship in the **Armory**.
- **Economy:** one currency, **Guild marks**, earned from missions, sales, encounters, discoveries and capped bounties, and spent on reactor cells, modules, upgrades and one-time crew berth fees.
- **Crew (optional):** seven named specialists to sign on and seat aboard your ships on a station's **BRIDGE**. A seated Navigator or Surveyor gives spoken-style text advice in flight; the built-in **Ship Mind** advises every pilot, crew or not. Advice only: crew never fly, fight, pay or travel for you. See [Crew and the Bridge](#crew-and-the-bridge).
- **Progress:** a ten-mission story chain, contract boards, cargo and crafting, three save slots, and recovery that never strands you.
- **Guild chains and Faction Heat:** two three-stage Guild mission chains (Gleaner Accord, Faint Lanterns) and a per-faction heat value (0-100) raised by your attacks on that faction's ships. The station Missions tab shows both: GUILD CHAINS (each stage, its status, reward and why it is locked) and FACTION STANDING (value, tier and what it changes).
- **Pause menu:** RESUME and RESTART FLIGHT (with a confirmation) on top, then three groups that open on demand: MISSIONS & PROGRESS, SETTINGS & HELP and NAVIGATION.

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

Keyboard keys are defaults and can be rebound under pause → **SETTINGS & HELP** → **CONTROLS**.

| Action | Keyboard and mouse | Touch | Controller |
|---|---|---|---|
| Fly in any direction | W A S D or arrow keys | Floating stick (drag on open space) | Left stick or D-pad |
| Fire (hold; heats the weapon) | Space or J | **FIRE** | RT, RB or X |
| Boost (hold; uses energy) | Left or right Shift | **BOOST** | LB or LT |
| Next weapon (never fires) | Q or K | Weapon button above **FIRE** | R3 |
| Target lock on / off | X | **LOCK** (left side) | — |
| Next target (only while locked) | C | **»** beside LOCK | — |
| STOP / hold position (REALISTIC flight only) | B | **STOP**, above the weapon button | — |
| Silent running on / off (firing or boosting ends it) | Z | **SILENT**, above the weapon button (next to STOP in REALISTIC flight; top centre on a landscape phone) | L3 (press the left stick) |
| Ship signature ability (one per ship) | F | Button named with the ship's ability tag (e.g. **CALIB**): above **SILENT**; left of it on a short portrait phone; under **MAP** on a landscape phone | — |
| Camera zoom | Mouse wheel, or = and − | Pause → SETTINGS & HELP → CONTROLS → ZOOM | — |
| Interact (dock, open, inspect, take a signal bearing, gate) | E or Enter | Button that appears in range | A |
| Sector map / cargo | M / I | **MAP** / **CARGO** | Select / Y |
| Pause | Esc or P | **II** | Start |

- **The mouse wheel only zooms** the camera, centred on your ship. It never switches weapons.
- **Target lock is facing only.** X locks the hostile nearest your nose that is in range and in sight, and your ship's nose turns to face it. It never moves the ship, chases, dodges or fires; you still steer, boost and shoot yourself. Press X again to release it at once.
- **C** moves the lock to the next hostile in range (clockwise, wrapping round); it does nothing without a lock and never fires.
- Mouse aim is optional (CONTROLS → MOUSE AIM, off by default). Target lock, next target, STOP and the ship ability are not available on a controller.
- **Gravity Shadow:** a planet or star between you and a hostile hides you from it; a ship that loses sight of you keeps chasing your last seen position for about 1.25 s without firing, then searches. It works per hostile and only when the body is in the line, not just nearby; a small **GRAVITY SHADOW** tag shows while a body really hides you, and **SEARCHING · LAST KNOWN POSITION** while a hostile hunts your last seen spot. Hiding is not protection: you can still be hit. **Silent running** (Z, the **SILENT** button on touch, L3 on a controller) shrinks the range at which hostiles can spot you to about a third. It is not invisibility: ships close by still detect you. Your shield does not recharge while it is on, and pressing fire or boost ends it (the log names the input). The SILENT control reads **SILENT RUNNING** while it is on. More in the [Player Guide](docs/PLAYER_GUIDE.md#silent-running-and-gravity-shadow).
- **Ship signature abilities:** every ship has one (Swift Vector Burst, Shrike Predator Focus, Petrel Signal Calibration, Magpie Salvage Pulse, Condor Bulwark, Albatross Deep Scan). F or the touch button uses it; the ability panel shows **READY**, **ACTIVE** with the seconds left, or **COOLDOWN** with the seconds until ready. Pausing freezes it; a refused press uses nothing up and the log says why. None makes you invisible or immune to damage, adds loot or solves a signal. More in the [Player Guide](docs/PLAYER_GUIDE.md#ship-signature-abilities).
- **Faction Heat:** hitting or destroying a faction's ships raises that faction's heat (0-100; Quiet, Wary, Alert, Pursuit, Hunt). Higher heat makes only that faction's ships spot you a little farther away (up to 20%) and search your last position a little longer (up to 1 s); Silent Running and Gravity Shadow still hide you. Heat cools 1 point per 12 s of flight while none of its ships hunts you (not while paused or docked), and some chain stages change it once when turned in. See it under the station **MISSIONS** tab → FACTION STANDING, or pause → MISSIONS. One stage, Fair Shares, can only be accepted while Gleaner heat is below 40; once accepted it stays yours.

#### Flight mode and STOP

Choose under pause → **SETTINGS & HELP** → **CONTROLS** → **FLIGHT MODE**. You can switch at any time, even in flight; your position, speed, heading, weapon and target are kept, and the choice is remembered. Ships, weapons, cargo, Guild marks and progress are not affected.

- **NORMAL** (default): the standard assisted flight described above, unchanged.
- **REALISTIC**: the ship keeps drifting when you release thrust. On a keyboard, A and D rotate, W fires the main engine along the nose and S the weaker reverse thrusters; a touch or controller stick turns the nose toward the stick and thrusts harder the further you push. Engines cannot exceed the ship's normal top speed, but falling toward a planet or star can. A **REALISTIC FLIGHT** tag and the **STOP** button appear on the HUD.
- **STOP** (REALISTIC only, B or the STOP button) brakes the ship (**STOPPING**), then holds that spot against momentum and gravity (**HOLDING POSITION**), or shows **CAN'T HOLD** if a pull is too strong. Press it again, or thrust or steer, to take back control. It never aims or fires, gravity and damage still apply, and it is never saved. In NORMAL flight, B only shows a reminder.

#### Gravity, STOP and station-keeping

Planets and stars pull **only your ship** (never shots, enemies or loot), and only inside their field, marked by a dotted ring; a chevron beside the ship points along the strongest pull. The pull is stronger close in and from larger bodies.

- **NORMAL flight:** full thrust always out-pulls a field, so a pull drags you off course but never traps you.
- **REALISTIC flight:** gravity bends your drifting path, and near a large body it can be stronger than the main engine, so burn away early. Falling can carry you past the ship's normal top speed.
- **Hazards:** hitting a planet's surface hard damages the ship, and a star's **corona** burns the shield while you are inside it.
- **STOP** (REALISTIC only) brakes and then station-keeps: it fires the thrusters for you to hold that spot against drift and gravity, and shows **CAN'T HOLD** when a pull is stronger than the engines. It is a holding aid only: it never aims, fires or flies anywhere, and steering or thrusting hands control straight back.

#### Faint signals

An anomaly you have not investigated yet gives off only a faint signal: its marker sits at the centre of a dashed ring, and the real source is somewhere inside it. Find it by triangulation, with the same INTERACT control (no extra button):

1. **Get close and slow down.** Inside sensor range and below 60 speed, the prompt reads **TAKE BEARING**.
2. **Take a bearing and hold steady.** Press INTERACT and keep still for about a second; the prompt counts **HOLD STEADY 10% … 90%** and an arc fills around the ship. Going faster than 60, leaving sensor range, a planet or star coming into the line, pausing or docking cancels it.
3. **A line is drawn** from where you were, through the ring. It is a measurement with an error (shown as **±x.x°**), so it passes near the source, not exactly through it.
4. **Move, then take another.** Fly well around the marker: two lines at least **35°** apart fix the source. Pressing again from the same spot is refused, so moving matters more than pressing. If your lines stay too close, the fifth bearing always resolves it.
5. **Read the log.** Every refusal says why: **TOO FAST**, **OUT OF SENSOR RANGE**, a named body **IN THE WAY**, **SAME SPOT**, or **INTERFERENCE** widening the error.
6. **SOURCE RESOLVED:** the lines go and the marker moves to the source with a bright ring. Fly there and **INVESTIGATE** for the usual reward, paid once.

Bearings are not saved: leaving the system starts the signal afresh (a completed anomaly stays completed). **Simple Signals** (pause → **SETTINGS & HELP** → **CONTROLS** → **SIGNALS** → **SIMPLE**, off by default) makes one valid bearing enough; range, speed, the steady hold and a clear line still apply, and the reward is the same. A seated Surveyor steadies each bearing (a smaller error) and explains failed ones; they never take a bearing or reveal the source for you.

#### Pause menu

Esc, P, **II** or Start pauses a Free Roam flight. **RESUME** and **RESTART FLIGHT** sit at the top; RESTART asks for confirmation first (CANCEL is focused, so a repeated key never restarts by accident). Below them are three groups that expand when chosen:

| Group | Contents |
|---|---|
| MISSIONS & PROGRESS | Missions, Record (recent Guild mark changes), Saves |
| SETTINGS & HELP | Controls (bindings, mouse aim, zoom, flight mode, Ship Mind advice, Simple Signals), How to Play, Sound |
| NAVIGATION | Galaxy Map (or System Map, when you came from one), Main Menu |

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
- **Spend:** reactor cells, equipment modules, ship upgrades and the **one-time berth fee** of crew recruited at a station (80, 130 or 220 marks by rank). There are no wages, upkeep or profit shares.
- **Not paid in marks:** ships (cargo plus a licence), travel (reactor cells, with free emergency options), repairs and restocking (free on docking).
- **Purchases are confirmed:** the first press shows the price and your balance before and after; **CONFIRM** pays and **BACK** cancels. If you cannot afford something, the button shows `INSUFFICIENT MARKS` with the amount required, available and short.
- Recent balance changes are listed under pause → **MISSIONS & PROGRESS** → **RECORD**.

## Crew and the Bridge

Crew are optional: **flying solo is fully supported**, and no crew member is needed to finish the game. Dock at a station, open the **HANGAR** tab, select a ship card and switch to **BRIDGE · CREW**. The Bridge always shows the ship you selected: its seats, the crew aboard, your unassigned roster and the recruits you can sign on.

**Recruiting.** Seven named specialists exist, each found in one way:

| How they join | Fee | Where |
|---|---|---|
| **Station recruit** (four people) | One-time berth fee by rank: cadet 80, rated 130, veteran 220 marks | Only at their own station, once any requirement is met (for example a survey run or a story mission) |
| **Story recruit** (two people) | Free, earned by completing a story mission | Any station |
| **Rescue recruit** (one person) | Free, earned by clearing a distress beacon (a wreck defence) | Any station |

- **SIGN ON** shows the fee (or **FREE**) and asks nothing you cannot see: a refused hire says why (the station, the requirement and your progress, or the marks you are short). The fee comes out of your Guild marks once, through the same ledger as every purchase, and appears under **RECORD**.
- A fee is never charged twice. **DISMISS** ends a contract (the person returns to where they signed on) and they can sign on again later for free. Reloading, replaying a mission or reopening the Bridge never signs anyone on by itself or offers someone twice.

**Seats and assignment.** Each ship has its own crew seats: **Swift 1, Shrike 1, Petrel 2, Magpie 2, Condor 3, Albatross 3.**

- **ASSIGN TO \<SHIP\>** seats an unassigned crew member; **MOVE TO \<SHIP\>** moves someone from another of your ships (a person sits in one seat only); **UNASSIGN** returns them to the roster. A full ship refuses, and the Bridge says why.
- Seats change only while docked with no hostiles engaged, and only on ships you own. Crew who are unassigned, or seated on a ship you are not flying, do nothing.
- If a ship ends up with more crew than seats (for example an older save), the extra crew return to the unassigned roster; nobody is ever removed except by DISMISS.

**Roles.** Each card shows the role, rank, background, three attributes and **DUTIES** (what works now, and what is planned).

| Role | Status | What it does |
|---|---|---|
| **Navigator** | Active (advice) | Gravity watch, pull reading and route notes in flight |
| **Surveyor** | Active (advice) | Signal reading, survey guidance and steadier signal bearings in flight |
| **Engineer** | **Planned** | Can be recruited and seated, but has no flight duty yet (shown as *NO FLIGHT DUTY YET*) |
| **Defence** | **Planned** | As above |
| **Quartermaster** | **Planned** | As above |

Only the first Navigator and the first Surveyor seated on the ship you fly are on duty. Engineer, Defence and Quartermaster abilities and route planning are not implemented; the Bridge labels them as planned.

**Attributes** (1 to 5; rank changes none of them):

- **Competence**, the quality of their own work: a Navigator checks more escape burns against the drift forecast before naming one; a Surveyor reads more from a contact (its kind and bearing, then its reach and survey value, then its main resource).
- **Caution**, how early a risk is raised: a Navigator warns further ahead (2.5 to 4.5 s, always earlier than the Ship Mind) and explains weaker pulls; a cautious Surveyor (3 and up) flags targets inside minefields, eruption fields or interference.
- **Focus**, sticking to the work: a new non-urgent topic waits until the last one has had 1.5 to 3.5 s; at 4 and up the core job comes first (no route notes during a gravity hazard; no salvage calls while survey marks remain).

**NAVIGATOR DOCTRINE** (on the Bridge, once you have signed on a Navigator): **BALANCED** (concise advice; escape burns that keep momentum first) or **SAFETY-FIRST** (warnings a second earlier, gravity explained at lower pulls, the widest-margin burns first, no optional route notes).

## Ship Mind, Navigator and Surveyor advice

Advice appears as one short line at a time in flight, never over a menu, the map or a station screen. Each line starts with an icon, a level word and the speaker, so it never relies on colour: **◆ CRITICAL**, **▲ WARNING**, **● INFO** or **○ NOTE**. It takes no input and cannot be clicked. Advice uses only what your ship can sense (no hidden positions, nothing beyond sensor range, nothing through interference) and comes from fixed rules in the game: no online service or AI model is involved.

- **Ship Mind** (always present, solo or crewed): low hull, shield down, a collision course a couple of seconds out, a star's corona, a strong pull, hostile contacts, targets on sensors and empty magazines. It says what is happening; it does not plan.
- **Navigator:** earlier drift-impact and corona warnings with a named escape burn checked against the forecast, how strongly a body pulls and whether your engine out-pulls it, a note when STOP cannot hold, and reactor-cell notes for the lanes out of the system.
- **Surveyor:** the targets on sensors with their bearing and (with competence) what they are worth, survey marks still to chart, when interference is blinding the sensors, when a survey is complete, and why a [faint-signal](#faint-signals) bearing failed or cannot fix the source yet. A higher Competence narrows each bearing's error; the Surveyor never takes a bearing or points to the source.

**How messages are chosen.** The most urgent message shows first; a higher level interrupts a lower one, equal levels wait their turn, and at most three wait in line (a waiting message is dropped if it stops being true). Each condition is said once, again only if it gets worse (a lower hull, more contacts), and each target is named once per visit. Nothing non-urgent is said in the first moments after arriving, during a fight or while a decision prompt is open. Where the Ship Mind and a crew member would say the same thing, only one speaks.

**Pause and resume.** While paused or a panel is open, nothing shows. When you resume, the one message that was on screen comes back once if it is still true; anything that was waiting is dropped, so a pause never releases a flood. Docking clears advice completely.

**ALL ADVICE or CRITICAL ONLY.** Pause → **SETTINGS & HELP** → **CONTROLS** → **SHIP MIND**. **ALL ADVICE** is the default. **CRITICAL ONLY** shows only critical warnings (low hull and an imminent collision), which cannot be switched off; everything else is skipped, not saved up. Switching back to ALL ADVICE announces at most one hazard that is still going on (the most urgent), never a backlog. The choice is saved with your controls.

**What advice never does.** Neither the Ship Mind nor any crew member steers, thrusts, brakes, toggles STOP, aims, locks, fires, spends marks, changes cargo or progress, investigates anything or travels. Their words change nothing in the game: you decide.

## First-run tutorial and HOW TO PLAY

- **When it appears:** automatically, the first time you reach the title screen. It has six steps (Welcome, Ships, Weapons, Controls, Guild marks, Start), with a step counter and progress bar. The Controls step switches between **CLASSIC / FREE ROAM** and **KEYBOARD / TOUCH / CONTROLLER**, and shows your own Free Roam key bindings.
- **Skip or finish:** **SKIP TUTORIAL** or Esc closes it; **FINISH**, **PLAY CLASSIC** or **PLAY FREE ROAM** completes it. Either way it is remembered on this device and does not reappear on every visit or every run. If a later update changes the core controls, it appears once more.
- **It changes nothing else:** opening, skipping or finishing it never touches saves, ships, weapons, Guild marks or unlocks, and nothing you press while it is open reaches the game.
- **Reopen it** (this never resets it): the **HOW TO PLAY** button on the title screen (or H, or Y on a controller), or pause → **SETTINGS & HELP** → **HOW TO PLAY** during a Free Roam flight. Classic's **HOW TO PLAY** (title and pause menus) shows Classic's own controls and scoring card.

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
  | [`crew-bridge-p05.mjs`](docs/development/playtest/crew-bridge-p05.mjs) | The Bridge: an old save loads without crew, recruitment and fees through the ledger, refusals with reasons, assign up to capacity, unassign, dismiss, switching ships, saves across a reload, planned duties labelled, the 360 px touch layout | `npm run preview:e2e` |
  | [`crew-advisor-p05.mjs`](docs/development/playtest/crew-advisor-p05.mjs) | Ship Mind, Navigator and Surveyor advice in flight: levels, no repeats, pause and resume, ALL / CRITICAL ONLY, no steering, sensor limits, layout clear of the HUD, ship and touch stick | `npm run preview:e2e` |
  | [`signal-p06.mjs`](docs/development/playtest/signal-p06.mjs) | Faint signals: bearing prompts and notices, resolution and its reward paid once, the Simple Signals setting saved across a reload, layout clear of the touch controls | `npm run preview:e2e` |
  | [`stealth-p07.mjs`](docs/development/playtest/stealth-p07.mjs) | Silent Running and Gravity Shadow: Z and the SILENT button on and off, fire and boost ending it, the shield pause, the shadow and searching tags against the AI, pause, restart, dock and ship change, HOW TO PLAY text, touch layouts | `npm run preview:e2e` |
  | [`ship-abilities-p08.mjs`](docs/development/playtest/ship-abilities-p08.mjs) | Ship abilities (P08.1 + P08.2): F and the touch button (one tap, one request), exact duration and cooldown on simulation ticks, the HUD panel against the ability status, refusals that consume nothing, pause, Silent Running, restart, reload, sector exit, each ship's effect, scan counts and marks, dock and ship change, CONTROLS and rebinding, six viewports in both flight modes, the guide section | `npm run preview:e2e` |
  | [`missions-heat-p09.mjs`](docs/development/playtest/missions-heat-p09.mjs) | Guild chains and Faction Heat (P09.1 + P09.2): chain stages through the real board, kills, rewards and consequences once, decay and pause, detection by heat, the GUILD CHAINS and FACTION STANDING sections, notices, reloads, legacy saves and eight viewports | `npm run preview:e2e` |

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
│   │       ├── crew/          Crew roster, recruitment, seats, Bridge, traits and the advice rules
│   │       ├── advisor/       Read-only flight observation and drift forecast for the advice
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
- **Crew and advice:** `crew/` is pure rules and data (recruitment, seats, save adapter, traits, the advice rules) plus two DOM views, the Bridge section and the advice line. Each advisory pass reads a frozen observation of the flight (`advisor/observe.ts`) on the simulation's 60 Hz clock and returns text only; nothing in it can reach input, physics, weapons, the wallet or progress, and the architecture test keeps `crew/` away from the sector, combat and gravity code.
- **Boundaries:** `tests/architecture.test.ts` enforces layer rules (for example, Classic never imports Free Roam, and the simulation never touches the DOM). `vite.config.ts` turns developer tools, the Gravity Flight test sector and test hooks into compile-time flags that release builds switch off.

## Save data and browser support

Everything is stored as versioned JSON in the browser's `localStorage`, on the current device only.

| Key | Contents |
|---|---|
| `galaxia:save` | Classic high score and best stage |
| `galaxia:prefs` | Shared settings: sound and volumes, glow, pixel scaling, motion, Arcade Display |
| `galaxia:freeroam:prefs` | Free Roam controls: key bindings, mouse aim, zoom, flight mode, Ship Mind advice (ALL / CRITICAL ONLY) |
| `galaxia:freeroam`, `galaxia:freeroam:slot2`, `galaxia:freeroam:slot3` | The three Free Roam save slots (including crew signed on, fees paid, seats and Navigator doctrine) |
| `galaxia:freeroam:slots` | Which Free Roam slot is in use |
| `galaxia:fleet` | Whether Classic Wave 20 is complete, the ships shared with Classic, and the ship chosen there |
| `galaxia:guide` | Whether the tutorial was finished or skipped, and for which guide version |

- Damaged records are repaired and old ones migrated, with a backup copy written first. A save from a newer version is read but never overwritten.
- There are no accounts, cloud sync, save export or online leaderboard. Clearing site data or using a private window removes saves. If storage is blocked, the game still plays and says that progress lasts only until the tab closes.
- GALAXIA targets current Chromium-based browsers, Firefox and Safari on desktop and mobile, and needs JavaScript, Canvas 2D and ES2022. There is no offline mode (no service worker).

---

## What's new in the 2026-10-30 missions and faction heat archive

`GALAXIA_Release_2026-10-30_Missions-and-Faction-Heat.zip` adds, on top of the 2026-10-29 Ship Abilities archive (Classic Mode, ships, weapons, prices, flight modes, stealth and abilities unchanged):

- **Guild chains:** Gleaner Accord and Faint Lanterns, three stages each, through the existing Guild dispatch, rewards and saves. Each reward and each heat change is applied once, at turn-in.
- **Faction Heat:** a 0-100 value per faction raised by your hits and kills on its ships, cooling in calm flight, with small, bounded effects on that faction's ships only.
- **Missions tab:** GUILD CHAINS (stage, status, objective, reward, lock reasons, including the Fair Shares heat check made when you accept) and FACTION STANDING (value, tier, meter and effect, with help text). One notice per tier change; the turn-in message names the heat change and the next stage.
- **Saves:** one optional field (`progression.heat`); older saves load with every faction Quiet.

None of this has been playtested by a person or tried on a physical device.

## Earlier: what was new since the 2026-10-26 crew archive

These changes were made after `GALAXIA_Release_2026-10-26_Crew.zip` and are included in the 2026-10-27 signal-triangulation archive. Classic Mode, ships, weapons, flight modes, STOP, crew, prices and saves are unchanged; no save field was added.

- **Faint signals:** Free Roam anomalies you have not investigated yet now hide their source inside a dashed ring. Take bearings with INTERACT from different positions (hold steady about a second; the prompt counts the progress), watch each measured line appear, and two lines at least 35° apart fix the source; the fifth bearing always does. Then investigate there for the usual reward, paid once. Every refused bearing says why in the log. See [Faint signals](#faint-signals).
- **Simple Signals setting:** pause → SETTINGS & HELP → CONTROLS → SIGNALS → SIMPLE (off by default) makes one valid bearing enough. Saved with your controls.
- **INTERACT near stations:** a station, gate or other point in reach keeps the prompt even when a faint signal is closer; only a bearing being held keeps it (for under a second).
- **Surveyor:** a seated Surveyor's Competence narrows each bearing's error, and they explain failed bearings; they never take one or reveal the source.
- **HOW TO PLAY and documentation:** the in-game Controls step, this README and the [Player Guide](docs/PLAYER_GUIDE.md) explain the six steps.

None of this has been playtested by a person or tried on a physical device; see below.

### Earlier: the 2026-10-26 crew archive

These changes were made after `GALAXIA-Game-Release-25-10-2026.zip` and are included in the 2026-10-26 crew archive. Classic Mode, ships, weapons, flight modes, STOP, prices and saves from earlier versions are unchanged; crew are optional.

- **Crew and the Bridge:** a **BRIDGE · CREW** view in the station Hangar. Sign on seven named specialists (four for a one-time berth fee in Guild marks, three free through story missions or a rescue), seat them on your ships (1 to 3 seats each), move, unassign or dismiss them. See [Crew and the Bridge](#crew-and-the-bridge).
- **Ship Mind, Navigator and Surveyor advice:** short in-flight advice lines with an icon, level word and speaker. The Ship Mind advises every pilot; a seated Navigator adds gravity, escape-burn and route notes, and a seated Surveyor reads targets and survey marks. Each crew member's Competence, Caution and Focus change how they advise. See [Ship Mind, Navigator and Surveyor advice](#ship-mind-navigator-and-surveyor-advice).
- **SHIP MIND setting:** ALL ADVICE or CRITICAL ONLY under CONTROLS. Pausing never releases a backlog: at most the one message that was showing comes back if still true, and switching back to ALL ADVICE announces at most one ongoing hazard.
- **Planned, not active:** Engineer, Defence and Quartermaster can be recruited and seated but have no duties yet; the Bridge says so.
- **Documentation:** this README (crew, advice, gravity and STOP) and the [Player Guide](docs/PLAYER_GUIDE.md). The in-game HOW TO PLAY does not cover crew yet.

None of this has been playtested by a person or tried on a physical device; see below.

### Earlier: the 2026-10-25 archive

These changes were made after the `GALAXIA-Game-Release-OpenTest-2026-10-23.zip` open-testing archive and are included in the 2026-10-25 archive. Classic Mode is unchanged.

- **Free Roam flight modes:** an opt-in **REALISTIC** flight mode (momentum, rotate-and-thrust steering, gravity that bends your trajectory) beside the unchanged **NORMAL** default, chosen under CONTROLS → FLIGHT MODE and switchable in flight. See [Flight mode and STOP](#flight-mode-and-stop).
- **STOP** (B or the STOP button, REALISTIC only): brakes, then holds position by station-keeping against momentum and gravity, with STOPPING / HOLDING POSITION / CAN'T HOLD states. It is never saved.
- **Pause menu reorganised:** RESUME and RESTART FLIGHT on top, RESTART now asks for confirmation, and the other actions sit in three expandable groups (MISSIONS & PROGRESS, SETTINGS & HELP, NAVIGATION). Every earlier action is still there. The panel is anchored to the top of the screen, and clicks in the first moments after a group opens are ignored so a double click cannot trigger an item by accident. See [Pause menu](#pause-menu).
- **Documentation:** this README, the [Player Guide](docs/PLAYER_GUIDE.md) and the in-game HOW TO PLAY now describe the flight modes, STOP and the new pause paths.

Neither change has been playtested by a person or tried on a physical device; see below.

## What has been verified

**Automated, on the current code (missions and faction heat, 2026-10-30):**

- `BASE_PATH=/galaxia/ npm run check` exit 0: 2,297 passed, the 17 opt-in measurement runs skipped; `verify:dist` OK (first download 94.9 kB gzip of 110 kB; Free Roam 224.9 kB of 225 kB; CSS 24.3 kB of 25 kB).
- Headless Chromium against this code: Guild chains and Faction Heat (55 of 55, including eight screen sizes), ship abilities (113), stealth (69), faint signals (42), Ship Mind advice (65), crew (42), controls (162), pause and the pause menu (20, 85), HOW TO PLAY (70), Hangar (34), economy (68), Galaxy and System Map (30, 21); on the production build the release smoke test (77) and flight modes (8).

**Earlier, on the signal-triangulation code:**

- `npm run check` passes: typecheck, the Vitest suite (2,131 passed; the 17 opt-in measurement runs skipped), the production build and `verify:dist` (first download 94.8 kB gzip of a 110 kB budget; Free Roam 224.2 kB of 225 kB, loaded only when chosen; CSS 24,997 bytes gzip of a 25,000-byte budget).
- Browser scripts in headless Chromium against this code: faint signals, the SIGNALS setting and the prompt and notices at 1280×720, 1920×1080 and 320×568 and 390×844 touch layouts (42 of 42), Ship Mind and crew advice (65 of 65), crew and the Bridge (42 of 42), NORMAL and REALISTIC flight with STOP (56 of 56) and pause and resume (20 of 20), all passing. The other scripts were not re-run for this change; their last results (2026-10-26, crew archive) follow.

**Earlier, on the crew-archive code (2026-10-26):**

- `npm run check` passes: typecheck, the Vitest suite (2,081 passed; the 17 opt-in measurement runs skipped), the production build and `verify:dist` (first download 94.7 kB gzip of a 110 kB budget; Free Roam 219.7 kB of 225 kB, loaded only when chosen; CSS 24,997 bytes gzip of a 25,000-byte budget).
- Browser scripts in headless Chromium on 2026-10-26, against this code: crew and the Bridge (42 of 42 checks), Ship Mind and crew advice including pause and resume, CRITICAL ONLY and the advice line at five screen sizes (65 of 65), the Hangar (34), the economy (66), Classic weapons after Wave 20 (72), NORMAL and REALISTIC flight with STOP (56 on the test build, 8 on the production build), pause and resume (20) and the pause-menu groups (85), all passing. The Armory script passed 43 and 44 of 46 in two runs: its Nuke-on-Petrel and Lock-On detail checks also fail on the build before crew was added (the 2026-10-24 pause-menu commit) and are unresolved, and its "plot is static" timing check fails intermittently on both builds.
- The release smoke test on the production build (77 of 77: both modes, the HUD at several sizes, settings across a reload, the first visit) and the GitHub Pages-like server check (30 of 30) also passed on 2026-10-26. Controller simulation and Arcade Display were last run for earlier archives.
- The release archive is built with the repository's own builder and checked by its verifier (see [Release archive](#release-archive)).

**Not performed:**

- No person has playtested this build, including faint signals, crew, Ship Mind advice, the tutorial, target lock, zoom, the Armory and the economy.
- No physical phones or tablets (including iOS Safari), real game controllers, real GPUs or high-refresh displays, and no listening check of the audio. Touch layouts were checked only in emulation.
- Firefox and WebKit were not re-run for this build; earlier releases ran there in headless form.
- Performance was measured only in headless, software-rendered Chromium on a two-core machine; no frame rate is promised.

## Known limitations and open-testing notes

- **Open testing:** expect balance and feel issues. Combat tuning, gravity strength, marks rewards and prices come from simulations and automated checks, not from players.
- **REALISTIC flight and STOP** are tuned from automated measurements only; expect the feel (turn rate, thrust, how STOP brakes near planets) to change after player feedback.
- **Crew are advice only:** a Navigator or Surveyor never flies, fights, brakes, investigates or travels for you, and plots no routes. Engineer, Defence and Quartermaster duties and route planning are planned, not implemented. Advice is text only (no voice), in English.
- **Guild chains and Faction Heat:** heat numbers come from automated checks, not players. The chain and standing cards are text (keyboard focus moves between the panel's buttons); heat notices have no sound of their own.
- **Faint signals:** there is no sound cue for a bearing. The bearing prompt is the usual INTERACT button; on a tall phone (390×844, emulated) a thumb resting low in the left corner can cover its edge, though the DRAG TO FLY spot does not. The difficulty (sensor range, the 35° rule, the error of each bearing) comes from simulations, not from players.
- **Advice layout:** the advice line was checked in emulated layouts only (1280×720, and 360×640, 320×568, 740×360 and 568×320 touch screens). In touch portrait it hangs just below the ship and the NEARBY line steps aside while it shows. On the narrowest phones (320 px wide), a long crew message can overlap the touch stick's ring if your thumb rests high on the screen; it is drawn over, never in the way of input. Screen-reader announcements are wired up but were not tried with a real screen reader.
- **Free Roam is a prototype:** route risk, lane hazards and transit events are shown on the maps but have no gameplay effect yet; prices are fixed, with no market between stations; touch play has no aim assist; target lock, next target and STOP are not mapped on a controller.
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
