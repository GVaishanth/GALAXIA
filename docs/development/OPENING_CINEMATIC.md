# Opening cinematic (Finale P3)

The first time the home page is shown after a page load, GALAXIA opens with a
short cinematic: the ship drops out of a jump into a scripted battle, wins it,
and the camera tracks the ship, dives at its canopy and crosses into the
cabin, where the **real home page** is displayed on the ship's main screen.
The camera then pushes through the display and that same live page becomes the
full-viewport home page. One continuous sequence, then done for the whole page
load: returning from a mode, opening the guide or reloading settings never
replays it.

- Total length 8.5 s (full motion); 1.65 s with reduced motion (opacity only).
- **SKIP INTRO** appears 0.6 s in (button or Escape) and goes straight to the
  home page from any phase. It is always honoured; pressing it twice is a
  no-op, and the page never traps the player behind the intro.
- A slow cinematic chunk shows a small pulsing **LOADING…** line (indeterminate
  — there is no fake percentage). If the chunk fails or has not arrived after
  6 s, the home page opens with an honest notice line.
- Deep links (`?mode=classic`, `?mode=freeroam`, the `?view=` showcases) never
  show the intro. `?intro=skip` opens the home page directly.
- The cinematic is presentation only: it touches no save, no score, no fleet,
  crew, missions, heat, credits or prefs (the test compares the whole
  `localStorage` before and after).

## Architecture

Pure Canvas 2D DOM/CSS, layered 2.5D — **not** 3D, no WebGL, no new library.
Four modules; the boundary is `src/shared/intro/introPolicy.ts`.

| File | Where | Role |
|---|---|---|
| `introPolicy.ts` | entry | the once-per-load decision, the hero-ship pick, the single-resolution gate (with its clock), the lazy-import contract |
| `introShell.ts` | entry | the overlay over the home page from the first frame, SKIP INTRO, the polite status line, the indeterminate loader; exactly one resolution, then disposal |
| `openingDirector.ts` | lazy chunk | the explicit phase schedule (`arrival → battle → victory → track → approach → cabin → display → push → handoff → complete`), clamped time stepping, once-only outcomes |
| `openingScene.ts` | lazy chunk | the seeded battle as a **pure function of time**: actors, bolts, misses, debris — nothing accumulates, every count is hard-bounded |
| `openingCockpit.ts` | lazy chunk | the pinhole-camera layer math and the rect→quad homography that maps the home page onto the display |
| `openingCabin.ts` | lazy chunk | *post-release cockpit upgrade:* the fighter cabin itself — the per-resize geometry cache (`cabinGeom`) and the cockpit painter (`paintCabin`) |
| `openingCinematic.ts` | lazy chunk | one canvas, one frame loop, one ResizeObserver, one `visibilitychange` listener; the painter |

The home page (`TitleScreen`'s own DOM, same instance) is placed on the
display with a `matrix3d`; it is inert until the handoff (the title screen's
existing blocked state). The push ends with the display exactly at the
viewport, where the transform is the identity; the overlay is removed with no
pixel moved. No screenshot, no second copy of the menu, no duplicate logo
afterwards, nothing left listening.

Determinism: one fixed seed per release (`INTRO_SEED` in `src/modes/host.ts`).
The choreography (spawn order, kill order, bolt and debris angles) is seeded
from it; re-rendered frames reproduce exactly. Frame gaps are clamped to
50 ms, so a hidden tab holds the sequence instead of jumping it; on return it
resumes where it was.

## The cockpit interior (post-release upgrade)

Still layered 2.5D Canvas 2D — the camera never enters a modelled 3D interior.
What the cabin phases paint was rebuilt into an engineered fighter cockpit
(`openingCabin.ts`), on the unchanged layer math (`near` 0.55, `display` 1,
`canopy` 1.4, `space` 8) and the unchanged camera schedule:

- **Canopy and frame.** The glass opening keeps its accepted outline. The slab
  around it is a dark graphite gradient; the rim is a metal edge stroke that
  brightens toward the upper-left (the exterior light). Three tapered,
  bevelled structural members (a centre bow strut, two A-pillars) converge
  toward the dash corners; nine small fasteners sit just off the glass. The
  glass itself is a near-transparent blue tint, one long diagonal reflection
  band, the exterior starfield drifting behind it, and a faint arched catch
  along the top curve.
- **Dashboard.** A two-tone shell: a lighter top surface (the deck band)
  meets the darker front face at a lit joint line; face seams flank the
  housing, cooling slots and fasteners sit under it, and a soft cyan pool from
  the live screen washes the deck while the display is powered (instrument
  light, timeline-driven).
- **Side consoles** (wide screens; on narrow ones a pair of slim lamp columns
  instead, as before). Each wing is a recessed bay in a faced panel:
  RADAR (three range rings, a lone sweep, `HOSTILES 0` — the battle is over)
  with a BANK/…toggles bank on the left; a NAV course trace plus the accepted
  SHLD/HULL/PWR bars on the right; three status lamps each. Everything is
  decorative: fixed labels and levels, never live game state, and the canvas
  takes no input (`pointer-events: none`, `aria-hidden`).
- **Display housing.** Drawn in screen space so it hugs the live, keystoned
  quad: a gunmetal mounting collar with four corner brackets, the accepted
  bezel band with its dimmer cyan hairline, and the unchanged screen punch —
  the real home page shows through, the transform and the identity handoff
  are byte-for-byte the accepted ones (`openingCockpit.ts` is untouched).
- **Pilot station (near layer).** Arm consoles (throttle left with an amber
  cap, stick right with a cyan cap, one live lamp each) and the pilot seat
  rising into the lower frame: padded seatback with shoulder rim light,
  bolster shading, harness straps with buckles, headrest. The seatback's top
  edge never projects above the display's bottom edge — pinned by tests on
  the real camera timeline at five viewport sizes — so the home page is never
  obscured; at the handoff the whole station is off frame.
- **Reflections.** Brief and deterministic only: the accepted canopy glint
  during the approach (unchanged), plus a warm battle-afterglow wash over the
  glass that fades out by the middle of the cabin phase. Both are pure
  functions of the timeline, not of any combat state.

Geometry is computed once per resize in `cabinGeom` (fasteners, vents, keys,
console rects, the nav trace); frames paint from that cache with a bounded
set of fills, strokes and evenly-stopped gradients — no images, no base64, no
library. Reduced motion shows the same cabin as a still (instruments frozen)
between the accepted fades. The overall timeline is unchanged: 8.5 s full,
1.65 s reduced, the 0.6 s skip reveal, the 6 s watchdog.

## The hero ship

The battle's hero is the Free Roam active hull when the active save slot names
a known hull sprite (`ship.<hull>`), otherwise the Classic fighter
(`player.fighter`) — the documented fallback. The pick is read-only: nothing
is written, a damaged or future-version slot falls back silently.

## Music

The Finale P2 engine is untouched: the home-page director (`titleMusic.ts`)
was already told "the home page is present"; now it is told **only when the
intro hands over** (`music.enter()` runs at handoff, never during the
cinematic). Skipping, the failure fallback, reduced motion and playing to the
end all reach exactly the same arrival. The theme's own rules (autoplay,
PLAY MUSIC, mute, volume, hidden tabs, gameplay fade) are unchanged; the
cinematic never loads or starts the theme itself, and a muted player stays
muted through it.

## Budgets and loading

- The cinematic chunk (`openingCinematic-*.js`): **10,000 B gzip** budget
  (`scripts/lib/distCheck.ts`, kind `title`: lazy from the entry, never reached
  from Free Roam), marker `galaxia-opening:`. First measured 7,719 B gzip;
  with the post-release cockpit upgrade it measures **9,872 B gzip** — the
  budget was not raised. It has no art of its own: it reuses the sprite
  registry already in the entry.
- The entry grows by the shell and policy only (~1.9 kB gzip, measured
  100,337 B gzip against a 110,000 B budget — unchanged by the upgrade); the
  CSS is unchanged (24,515 B gzip, budget 25,000) — the overlay styles are
  inline.
- Normal gameplay never downloads the cinematic: Classic and Free Roam entry
  is unchanged, and a `?mode=` deep link never even shows the home page.
  `verify:dist` enforces every existing budget and the new one.

## Testing

- `tests/introOpening.test.ts` (24): the policy (URL rules, hero pick), the
  gate (every resolution race: skip, complete, fail, timeout, cancel, stale
  loads, double resolution) and the director (phase order, clamping, reduced
  motion, once-only callbacks, disposal).
- `tests/introChoreography.test.ts` (21): the seeded battle (determinism,
  bounded counts, destruction timing, camera path, spans at phone widths) and
  the handoff geometry (the display equals the viewport at the push end and at
  the reduced handoff; the transform is the identity there; phase/camera
  continuity across boundaries).
- `tests/introCabin.test.ts` (9, post-release cockpit upgrade): cabin-geometry
  determinism across identical runs, the display rest anchoring, bounded
  part counts, the consoles-vs-columns rule at narrow widths, glass bounds
  off the rest quad, the seat-clearance invariant (seatback top never above
  the display bottom; seat fully out of frame at the handoff) sampled along
  the real camera timeline at five viewport sizes with and without reduced
  motion, and hash stability.
- `docs/development/playtest/cinematic-opening-f3.mjs` (65 checks, QA build,
  fake-clock Chromium): the full run and its phases, cleanup, the live
  unobstructed home page, Classic and Free Roam navigation before and after,
  skip from arrival/battle/display by click, double click and Escape, reduced
  motion, the chunk-failure fallback, deep links, mute persistence, four
  touch viewports, and localStorage isolation. Screenshots land in
  `.cinematic-f3-shots/` next to the harness — the desk run captures the
  approach, cabin, display and push phases of the cockpit upgrade — and are
  meant to be looked at.

## Limits (honest ones)

- Layered 2.5D sprite composition. The "cabin" is painted panels with a fixed
  perspective, not a modelled interior. The brief's camera-through-the-display
  is simulated by layer scaling plus a homography on the live page.
- The battle is the Classic enemy set and the player's own hull — by design,
  instead of a bespoke cinematic model.
- The intro plays once per page load (hard invariants in tests and the
  harness); a reload shows it again. There is no "don't show again" setting —
  SKIP INTRO covers the one case it addresses.
- Controller navigation of SKIP INTRO is not added here; the pad's A button
  acts on the hidden mode cards after the handoff.
- Verified in headless Chromium only. No device, screen-reader or human-visual
  certification beyond the captured screenshots.
