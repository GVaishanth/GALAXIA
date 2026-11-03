# GALAXIA main theme: "Beyond the Beacon" (Finale Part 2)

The home page plays an original instrumental theme, written for GALAXIA in this repository and synthesised in the browser at runtime. This document records how it was made, where it plays, how it is controlled, and what has and has not been verified.

## 1. Origin and licence

- **Original work.** The melody, harmony, bass line, rhythm and arrangement were written for GALAXIA as code and data in this repository (`src/audio/music/themeScore.ts`). No melody, chord progression, riff or arrangement was taken from another work, and none was written to imitate a particular film, game or composer.
- **No audio files.** There are no samples, recordings, loops, sound fonts or rendered audio files. Every sound is made by Web Audio oscillators, filters, envelopes, a generated reverb and a delay (`src/audio/music/galaxiaTheme.ts`). The reverb impulse and the noise come from a seeded generator, so nothing is random and nothing is downloaded beyond the code.
- **Tools.** Written with AI-assisted development (coding agents working from written prompts), like the rest of the project's sound recipes. No music-generation model, voice model or reference recording was used, imported, traced or sampled.
- **Licence.** The theme is part of GALAXIA's source code and is covered by the project licence (`LICENSE`), like every other sound recipe. It is listed in `docs/freeroam/CONTENT_AND_ASSET_LICENSES.md`.
- **Not done.** No musicologist or rights clearance service compared it with existing music, and no person listened to it on speakers or headphones as part of this stage. Originality rests on how it was written (§2), not on a listening comparison.

## 2. The music

| | |
|---|---|
| Title | BEYOND THE BEACON |
| Key, tempo, metre | D minor, 84 BPM, 4/4 |
| Length | 32 bars = 128 beats ≈ 91.4 s, looping seamlessly |
| Mood | wonder and exploration, a little technological mystery, restrained heroism (no bombast) |

**Form** (each section is 8 bars):

| Section | Bars | What happens |
|---|---|---|
| A, intro | 1–8 | Warm pad and a slow bass; a bell-like arpeggio enters; the motif is hinted |
| B, main theme | 9–16 | The full motif over a pulsing bass and soft drums |
| C, development | 17–24 | The motif in F major with a countermelody, a fuller rhythm, and a climb to the peak |
| D, return | 25–32 | The motif reharmonised up high, then a wind-down whose last chord (A7) leads back to bar 1 |

**The motif:** D F A Bb A, rising 3, 4 and 1 semitones and falling back. It opens sections A, B and D, so the theme is recognisable each time it returns.

**Layers:**
- pad: detuned saw pair through a low-pass filter whose cutoff opens per section;
- lead: a soft square/triangle blend with gentle vibrato;
- counter: a second line in C and D;
- arp: bell tones;
- bass: a filtered saw with a pulsing eighth-note figure in B and C;
- drums: a sine kick, a noise hat and a soft snap, used sparingly and only in B, C and early D;
- accents: a swell and a low boom at section changes.

No raw oscillator plays alone without an envelope and filtering. Every note envelope starts and ends at exactly 0, so there are no clicks (unit-tested).

**Deterministic:** the score is pure data, 734 events per loop. The same events are produced every time, with no clock and no random numbers.

## 3. Loudness (automated measurement, not mastering)

Measured by rendering the real player offline (`OfflineAudioContext`, 44.1 kHz, Chromium), with music and master both at 100 % before the music bus:

| Section | Peak (of full scale) | RMS |
|---|---|---|
| A | 0.33 | −24.5 dBFS |
| B | 0.40 | −23.6 dBFS |
| C (the peak) | 0.46 | −22.3 dBFS |
| D | 0.31 | −24.6 dBFS |

- Every section stays under the game's limiter threshold of −3 dBFS (0.71), so the theme alone is never limited.
- The sections are within 2.3 dB of each other, so none jumps out.
- The default music volume of 70 % lowers it about 3 dB further.
- The loop seam (bar 32 → bar 1) shows no gap and no jump in level.
- After a stop the output falls fully silent (below −80 dBFS) within 0.8 s.

These figures are machine measurements in headless Chromium. They are **not** professional mastering, and they do not show how the music sounds on any speaker, headphone or phone.

## 4. Where and when it plays

- **Only on the home page** (the title screen with the CLASSIC and FREE ROAM cards). It never plays in Classic, Free Roam, a cutscene or a menu inside a mode.
- **Entering gameplay:** choosing a mode fades the theme out over 0.6 s while the mode starts at once (nothing waits for the music). After the fade nothing is scheduled and no timer runs.
- **Returning home** (MAIN MENU, or the end of a run): the theme starts again **from the top** with a 1.5 s fade-in. Restarting the opening each time keeps a short visit to the home page sounding like an arrival rather than a cut into the middle of the piece.
- **Rapid back-and-forth:** the player keeps at most one fading run beside the new one. An older fade is ramped to silence in 30 ms (no click) and released.
- **Hidden tab:** the theme holds and the audio context is suspended. When the tab is visible again it continues where it was.
- **Deep links** (`?mode=classic`, `?mode=freeroam`) skip the home page, so the theme is never requested.
- **For Finale Part 3 (Nov 4):** the director's `enter()` and `leave()` are the only entry points, so the cinematic opening can decide when the home page (and therefore the theme) begins without changes to the player. Part 2 implements no cinematic behaviour.

## 5. Browser autoplay

Browsers only allow audio after the person interacts with the page. GALAXIA follows that rule and never tries to get around it.

- No audio context is created before a gesture, unless the browser itself reports that autoplay is allowed (`navigator.getAutoplayPolicy('audiocontext') === 'allowed'`, where it exists).
- Until then the home page shows **PLAY MUSIC** and the status line says *MUSIC STARTS WHEN YOU PRESS PLAY MUSIC*. Any click, tap or key press on the home page also counts.
- If the browser still keeps audio suspended after a press, or rejects it, the status is truthful: *THE BROWSER PAUSED THE MUSIC: PRESS PLAY MUSIC*. There is no retry loop and no console output; the next press tries once more.
- Blocked is not muted: the MUTE MUSIC setting is not touched.
- Gameplay never depends on music. Both modes start and play normally with audio refused (harness section B).
- Without Web Audio, or if the music code fails to load, the status reads *MUSIC UNAVAILABLE IN THIS BROWSER*. The settings still work and are saved, and PLAY MUSIC can retry the load once per press.

## 6. Controls and settings

**Home page** (under HOW TO PLAY):
- **PLAY MUSIC**: shown only while the music is waiting for a gesture or blocked. When it is not needed it keeps its space but becomes invisible and is skipped by Tab and screen readers. Collapsing it mid-tap would move the page under the finger, and the browser would send that tap's click to whatever moved there (HOW TO PLAY).
- **MUTE MUSIC**: a toggle button with an accurate pressed state (`aria-pressed`).
- **MUSIC**: a volume slider from 0 to 100 % in steps of 5, named "Music volume", with its value shown next to it. It works with a mouse, touch and the arrow keys. Dragging changes the level live and smoothly; the value is saved when you let go.
- A one-line status (`role="status"`) with room for two lines reserved, so a status change never moves the page.

**Classic SETTINGS:** the slider formerly labelled **JINGLES** is now **MUSIC** (the same setting), and a **MUTE MUSIC** toggle sits beside it.

**Free Roam:** pause → SETTINGS & HELP → SOUND has a **MUTE MUSIC: ON/OFF** button next to the existing MUSIC volume.

The three places share one saved setting and stay in sync.

**What MUTE MUSIC and the MUSIC volume control:** the music bus, i.e. the home theme plus the short music jingles:
- Classic: captured fighter, twin fighter, stage start, challenge start, stage clear, perfect and game over;
- Free Roam: mission complete and survey complete.

Shots, explosions, menu clicks, alerts and every other effect are on the effects bus and keep playing when music is muted.

**Behaviour:**
- Muting keeps the chosen volume, and unmuting restores it.
- A volume of 0 counts as silence: the theme stops rather than running inaudibly, and the mute setting is untouched.
- Changing the volume while muted is saved and stays silent.
- A route change or a reload never unmutes.
- The Mute Music setting also stays effective if the browser resumes the audio context later: the music bus gain is 0 regardless of the context.
- SOUND off (all sound) still silences everything, as before.

## 7. Saved preferences

Both values live in the existing shared preferences record (`galaxia:prefs`, `src/persistence/saveData.ts`, `src/shared/persistence/preferences.ts`). There is no new storage key and no version bump (it is still version 1).

| Field | Default | Valid values | Notes |
|---|---|---|---|
| `audio.music` | 0.7 | 0–1 | existing field (was the jingle level); 0 is kept, not replaced |
| `audio.musicMuted` | false | boolean | new, optional |

- Older records without `musicMuted` load as unmuted, with every other setting unchanged.
- Malformed values (strings, NaN, out of range) are replaced by the defaults and the record is repaired. The other settings are kept.
- Values are written on commit (a released slider, a pressed toggle), never per frame or per drag step.
- None of this is part of a game save or the critical-hit state.

## 8. Code and lifecycle

| File | Chunk | Role |
|---|---|---|
| `src/audio/music/themeScore.ts` | `galaxiaTheme` (lazy) | the score: pure data and functions |
| `src/audio/music/galaxiaTheme.ts` | `galaxiaTheme` (lazy) | the player: a look-ahead scheduler and synth voices |
| `src/shared/audio/titleMusic.ts` | entry | the director: decides when the theme plays and reports the status |
| `src/shared/ui/titleMusicControls.ts` | entry | the home-page controls |
| `src/shared/audio/musicProbe.ts` | QA build only | an offline render for the harness's level checks |

**Scheduler:**
- A timer every 100 ms schedules notes up to 0.9 s ahead in AudioContext time, so the tempo is sample-accurate and never depends on the timer being punctual.
- After a stalled page the timeline moves forward instead of firing missed notes together.
- At most 64 notes per tick (a normal tick schedules 2–12).

**Graph:**
- The shared reverb, delay and waveforms are built once, on the first start, and reused.
- Each start creates a small "run" (fade gains plus its notes).
- `stop()` cancels every note that has not started, fades the run out and disconnects all its nodes afterwards.
- `dispose()` disconnects everything.
- A Settings change never builds new nodes; it only moves the music bus gain.

**Single instance:** one director and one player per page. The host loads the chunk with a dynamic import, the first time the home page wants music.

**Errors:** every Web Audio call that can throw is caught. A failure is reported once in the status and never blocks the page or the settings.

## 9. Size budget

Exact gzip (level 9, `npm run verify:dist`, release build under `/galaxia/`), compared with the Finale Part 1 release:

| Asset | Before | After | Budget |
|---|---|---|---|
| entry | 96,463 | 98,438 (+1,975: the director and the controls) | 110,000 |
| CSS | 24,374 | 24,515 (+141) | 25,000 |
| Free Roam main chunk | 214,772 | 214,830 (+58) | 225,000 |
| eager Free Roam closure | 223,537 | 223,594 (+57) | 225,000 |
| `galaxiaTheme` (lazy, new) | – | 5,138 | 6,500 (new) |

- **The +57 B in eager Free Roam** is the MUTE MUSIC button in its SOUND panel; it is required, because Settings must offer the toggle. No music code is in Free Roam: a unit test forbids any Free Roam file from referencing the music modules, and the build verifier fails if the music chunk's marker appears in another chunk.
- **The new `galaxiaTheme` budget** of 6,500 B allows about 27 % growth for fixes. That is far too small for audio samples or a music library, which is the point.
- No existing budget was raised.
- **Proof that gameplay does not download the theme** (harness checks A8, C1–C3):
  - Free Roam and Classic chosen from the home page fetch no music;
  - deep links fetch none;
  - a muted profile fetches none, even after a gesture.

## 10. Tests

**Unit tests (Vitest, node):**
- `tests/musicTheme.test.ts`:
  - the score: form, motif, bar arithmetic, the loop seam, section dynamics and the chunk marker;
  - the player against a fake AudioContext: the node set, tempo, the look-ahead window, never scheduling a note twice, bounded ticks, the loop, zero-start/zero-end envelopes, stop cancellation and disconnection, graph reuse, rapid start/stop including back-to-back trips, stalls, hold/release, dispose and the offline span;
  - source rules for the chunk boundary.
- `tests/titleMusic.test.ts`:
  - the director: every status, autoplay allowed or locked, gesture start, blocked and rejected resume, unavailable, load failure and retry, muted first visit, volume and mute changes, repeated entry, rapid transitions, hidden tab, gameplay before music, no polling;
  - preference sanitising: defaults, legacy records, malformed values, and 0 kept;
  - the SoundSystem music bus: Mute Music silences the theme and the jingles but never the effects.
- `tests/audio.test.ts`, `tests/savePartition.test.ts`, `tests/distCheck.test.ts`: updated for the music setting and the new chunk kind.

**Browser harness:** `docs/development/playtest/music-theme-f2.mjs` (QA build, headless Chromium). It covers:
- A, desktop: locked → PLAY MUSIC, slider by keyboard and pointer, volume 0, MUTE MUSIC while effects still play, volume while muted, reload persistence, gameplay stopping the theme, restart on return, rapid navigation, a simulated hidden tab, Classic SETTINGS, and the offline levels;
- B, simulated autoplay refusal: blocked, no retry loop, gameplay unaffected, PLAY MUSIC once allowed;
- C: deep links and a muted profile download nothing;
- D, 320×568 touch with reduced motion: layout, 44 px targets, a tap starts music without moving the page or opening the guide, slider tap, inert under the guide;
- K, keyboard: Enter/Space on PLAY MUSIC and MUTE MUSIC, Tab order and focus rings, HOW TO PLAY from the keyboard;
- E: autoplay allowed by the browser;
- F: Free Roam's SOUND panel, with flight and the critical-hit hook still working;
- page errors and AudioContext warnings throughout.

## 11. Limits and known gaps

- Verified only in automated headless Chromium (Playwright). No Firefox, Safari or WebKit run, no physical phone, tablet or controller, no screen reader, and **no human listening test** on speakers or headphones.
- Autoplay refusal and the hidden tab are **simulated** in the harness (a wrapped `AudioContext` whose `resume()` rejects; a patched `document.hidden`). Real browser policies vary.
- A game controller cannot reach the home-page music controls (the title screen's pad navigation covers the mode cards and HOW TO PLAY). The setting is reachable from Classic SETTINGS and Free Roam SOUND with a pad.
- The music is a single 91 s piece that loops; there is no second theme and no in-game music.
- PLAY MUSIC leaves a blank slot on the home page while music plays (it keeps its box on purpose, §6).
- **Fixed alongside (inherited):** before this stage, Enter or Space on a focused HOW TO PLAY button started the highlighted mode instead of opening the guide (present in the Finale Part 1 release). Such a button now handles its own key. Enter with nothing focused still starts the highlighted mode.
