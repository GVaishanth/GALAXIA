/**
 * Mode host (Free Roam Prompt 2): the page-level owner of everything that
 * outlives a mode, created once per page load:
 *  - shared services: storage, shared prefs (`galaxia:prefs`), one SoundSystem
 *    (one AudioContext), one sprite cache;
 *  - the title screen (mode select);
 *  - the ModeController, which runs at most one mode at a time;
 *  - page signals: audio unlock, and blur / hidden tab -> pause the active mode;
 *  - Finale P2: the home-page theme (shared/audio/titleMusic.ts), which plays
 *    only while the title is shown and loads its chunk only then;
 *  - Finale P3: the opening cinematic (shared/intro/), played over the first
 *    showing of the home page per page load; the theme, the first-run guide and
 *    the title's controls start at its handoff (docs/development/OPENING_CINEMATIC.md).
 *
 * Each launch gets a fresh, empty container that is removed after the mode's
 * dispose(), so nothing a mode created (DOM, canvases, element listeners) can
 * survive into the next one. Classic is bundled statically (it is the default,
 * verified game); Free Roam loads as a separate chunk on first use.
 */
import { parseSave } from '../persistence/saveData.ts';
import { openStore } from '../persistence/storage.ts';
import { SpriteCache } from '../render/sprite/spriteCache.ts';
import { formatScore } from '../ui/presentation.ts';
import { createSharedSound, installAudioUnlock } from '../shared/audio/audioService.ts';
import { browserAllowsAutoplay, createTitleMusic, type TitleMusicDebug } from '../shared/audio/titleMusic.ts';
import { createTitleMusicControls } from '../shared/ui/titleMusicControls.ts';
import { DisposableScope } from '../shared/lifecycle/scope.ts';
import { NOTICE_TEXT, STORAGE_KEYS, type StorageNotice } from '../shared/persistence/namespaces.ts';
import { PreferencesStore } from '../shared/persistence/preferences.ts';
import { TitleScreen, type TitleChoice } from '../shared/ui/titleScreen.ts';
import { mediaMatches } from '../shared/ui/media.ts';
import { createClassicMode } from './classic/classicMode.ts';
import { ModeController, type HostState } from './controller.ts';
import { activeSlot, FR_PREFS_SPEC, readSlot, slotSummary } from './freeroam/saveSlots.ts';
import { classicRecordShowsGate, FLEET_SPEC } from './crossMode.ts';
import type { GuideContext, GuideInput, GuideMode } from './guide/guideContent.ts';
// the dialog (and the roster / armory data its text is built from) loads on demand; only the small state module is in the entry
import type { GuideDialog, GuideEnd, GuideStatus } from './guide/guideDialog.ts';
import { acknowledgeGuide, guideDue, readGuide, type GuideRecord } from './guide/guideState.ts';
import { parseRecord } from '../shared/persistence/record.ts';
import { createGestureDetector, createSequenceDetector, keyStroke, requestAdminLaunch } from './freeroam/admin/activation.ts';
import { isEditableTarget } from '../input/keyboard.ts';
import { SPRITES } from '../assets/sprites/index.ts';
import { heroSpriteFor, INTRO_FAILED_NOTICE, introRequested } from '../shared/intro/introPolicy.ts';
import { runIntro, type IntroDebug, type IntroRun } from '../shared/intro/introShell.ts';
import { MODE_IDS, type ModeContext, type ModeDebug, type ModeId, type ModeRegistry, type SharedServices } from './types.ts';

export const MODE_REGISTRY: ModeRegistry = Object.freeze({
  classic: () => Promise.resolve(createClassicMode),
  freeroam: () => import('./freeroam/freeRoamMode.ts').then((m) => m.createFreeRoamMode),
});

export interface HostDebug {
  readonly state: HostState;
  readonly mode: ModeId | null;
  readonly stats: ModeController['stats'];
  /** Listeners / loops held by the host itself (constant across switches). */
  readonly host: { readonly listeners: number; readonly loops: number };
  readonly title: { readonly visible: boolean; readonly shows: number; readonly listeners: number; readonly loops: number; readonly starsAnimating: boolean; readonly starPaints: number };
  readonly active: ModeDebug | null;
  /** Mode containers currently in the DOM (0 or 1). */
  readonly containers: number;
  readonly notices: readonly string[];
  /** P04.2 guide: the first-run guide (dialog state and the stored record). */
  readonly guide: GuideStatus & { readonly record: GuideRecord; readonly autoOpened: boolean };
  /** Finale P2: the home-page theme (status, context, player). */
  readonly music: TitleMusicDebug;
  /** Finale P2: the shared SoundSystem (counters, context) and the effective bus gains (Mute Music is the music bus only). */
  readonly sound: ReturnType<SharedServices['sound']['stats']> & { readonly sfxGain: number; readonly musicGain: number };
  /** Finale P3: the opening cinematic of this page load (null when it was not played). */
  readonly intro: IntroDebug | null;
}

export interface GalaxiaHost {
  launch(id: ModeId): Promise<boolean>;
  menu(): void;
  debug(): HostDebug;
}

declare global {
  interface Window {
    /** Host diagnostics for automated checks (read-only; launch/menu mirror the buttons). */
    __galaxia?: GalaxiaHost;
    /** QA builds only (Finale P2): offline render + measurement of the theme (shared/audio/musicProbe.ts). */
    __galaxiaMusicProbe?: (spec: import('../shared/audio/musicProbe.ts').ProbeSpec) => Promise<import('../shared/audio/musicProbe.ts').ProbeResult>;
  }
}

declare const __GALAXIA_TEST_HOOKS__: boolean; // vite.config.ts `define` (TD-78: automation hooks, absent from release builds)

/** Finale P3: the opening cinematic's choreography seed (fixed: the same intro on every visit). */
const INTRO_SEED = 0x6a1a2026;

const CLASSIC_SAVE_UNREADABLE = 'Classic save data could not be read: Classic starts fresh and keeps a backup copy of the old data.';

export function mountHost(root: HTMLElement): GalaxiaHost {
  const hostScope = new DisposableScope();
  const store = openStore();
  const prefs = new PreferencesStore(store);
  const sound = createSharedSound(prefs.get().audio);
  const sprites = new SpriteCache();

  const notices = new Set<string>();
  if (!store.persistent) notices.add(NOTICE_TEXT.unavailable);
  if (prefs.backedUp) notices.add(NOTICE_TEXT['corrupt-reset']);
  if (prefs.loadStatus === 'future-version') notices.add(NOTICE_TEXT['future-version']);
  if (prefs.backupFailed) notices.add(NOTICE_TEXT['backup-failed']);
  const report = (problem: StorageNotice): void => {
    notices.add(NOTICE_TEXT[problem]);
  };
  const services: SharedServices = { store, prefs, sound, sprites, reportStorageProblem: report };

  root.replaceChildren();
  root.className = 'galaxia-root';

  let controller: ModeController;
  let pendingChoice = false;
  const choose = (choice: TitleChoice): void => {
    if (pendingChoice) return; // double click / Enter + click in the same moment
    pendingChoice = true;
    music.leave(); // Finale P2: the theme fades out now; the mode's start never waits for it
    sound.unlock(); // a click / Enter is a user gesture
    sound.play('uiSelect');
    title.hide();
    // start on the next task: the key event that chose the mode is still being dispatched, and
    // the new mode's listeners must not receive it (Enter would also skip Free Roam's briefing)
    setTimeout(() => {
      pendingChoice = false;
      void launch(choice);
    }, 0);
  };
  /* ---- Finale P2: the home-page theme and its controls ---- */
  const music = createTitleMusic({
    sound,
    prefs: () => prefs.get().audio,
    load: () => import('../audio/music/galaxiaTheme.ts'),
    autoplayAllowed: () => browserAllowsAutoplay(),
    onChange: () => musicControls.refresh(),
  });
  const musicControls = createTitleMusicControls({
    get: () => prefs.get().audio,
    save: (change) => {
      prefs.setAudio(change); // shared galaxia:prefs (the same settings Classic and Free Roam show)
      sound.setPrefs(prefs.get().audio);
      music.prefsChanged();
    },
    preview: (a) => sound.setPrefs(a),
    play: () => music.gesture(),
    status: () => music.status(),
  });
  const title = new TitleScreen(root, sprites, {
    extras: [musicControls.root],
    onSelect: choose,
    onMove: () => sound.play('uiMove'),
    // the same rule as the modes: the shared setting, with 'system' following the browser
    reducedMotion: () => reducedMotion(),
    onGuide: () => openGuide('reference'),
  });

  /* ---- P04.2 guide: first-run tutorial and HOW TO PLAY (modes/guide) ---- */
  /** Debug status before the dialog chunk has loaded. */
  const GUIDE_CLOSED: GuideStatus = { open: false, kind: null, step: 'welcome', index: 0, mode: 'classic', input: 'keyboard', highlighted: false, listeners: 0, loops: 0 };
  const reducedMotion = (): boolean => {
    const pref = prefs.get().display.reducedMotion;
    return pref === 'on' || (pref === 'system' && mediaMatches('(prefers-reduced-motion: reduce)'));
  };
  /** Opened automatically at most once per page load (also when the choice could not be stored). */
  let guideAutoOpened = false;
  const guideInput = (): GuideInput => {
    const forced = new URLSearchParams(location.search).get('controls');
    if (forced === 'touch' || forced === 'keyboard') return forced;
    if (mediaMatches('(pointer: coarse)')) return 'touch';
    const pads = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? [...navigator.getGamepads()] : [];
    return pads.some((p) => p?.connected) ? 'controller' : 'keyboard';
  };
  /** Read-only: the Free Roam keys as saved, and whether Classic Wave 20 is complete (nothing is written). */
  const guideContext = (mode: GuideMode): GuideContext => {
    const fr = parseRecord(store.read(FR_PREFS_SPEC.key), FR_PREFS_SPEC).data.controls;
    const gate = parseRecord(store.read(FLEET_SPEC.key), FLEET_SPEC).data.classicComplete || classicRecordShowsGate(store);
    return { mode, input: guideInput(), bindings: fr.bindings, mouseAim: fr.mouseAim, classicGate: gate };
  };
  const onGuideEnd = (end: GuideEnd): void => {
    title.setBlocked(false);
    // only the tutorial is remembered; the HOW TO PLAY reference never changes the stored state
    if (end.kind === 'tutorial' && end.how !== 'closed') acknowledgeGuide(store, end.how);
    if (end.play) choose(end.play);
  };
  let guide: GuideDialog | null = null;
  let guideLoad: Promise<GuideDialog | null> | null = null;
  /** True from the request until the dialog is open (the chunk may still be loading). */
  let guideOpening = false;
  const guideActive = (): boolean => guideOpening || (guide?.isOpen() ?? false);
  const loadGuide = (): Promise<GuideDialog | null> =>
    (guideLoad ??= import('./guide/guideDialog.ts').then(
      (m) => {
        if (hostScope.disposed) return null;
        const g = new m.GuideDialog(root, { onEnd: onGuideEnd, onMove: () => sound.play('uiMove'), reducedMotion });
        hostScope.add(() => g.dispose());
        guide = g;
        return g;
      },
      () => {
        guideLoad = null; // offline or a stale deploy: try again next time
        return null;
      },
    ));
  const openGuide = (kind: 'tutorial' | 'reference'): void => {
    if (!title.visible || pendingChoice || guideActive() || introActive()) return;
    guideOpening = true;
    title.setBlocked(true); // from the request on: nothing on the title reacts while the guide loads
    const opener = kind === 'reference' ? title.guideButton : null;
    void loadGuide().then((g) => {
      guideOpening = false;
      if (!g || !title.visible || pendingChoice) {
        title.setBlocked(false);
        return;
      }
      g.open({
        kind,
        context: guideContext(title.focusedChoice),
        canPlay: true,
        // measured live, skipped when the card would cover them: the two mode cards on the first step,
        // the HOW TO PLAY button on the last (where the guide can be opened again)
        highlight: (step) => (step === 'welcome' ? title.root.querySelector('.mode-cards') : step === 'start' ? title.guideButton : null),
        opener,
      });
    });
  };

  /* ---- Finale P3: the opening cinematic (shared/intro/; the cinematic itself is a lazy chunk) ---- */
  /** Played at most once per page load: the first showing of the home page, unless `?intro=skip` or a deep link. */
  let introPending = introRequested(location.search);
  let intro: IntroRun | null = null;
  /** The last run (diagnostics). */
  let introRun: IntroRun | null = null;
  const introActive = (): boolean => intro?.active ?? false;
  /** The home page is really here: the theme, the controls, and (once) the first-run guide. */
  const arriveHome = (error?: string): void => {
    music.enter();
    musicControls.refresh();
    // P04.2 guide: a player who has not finished or skipped the current guide gets it once, over the title
    if (!guideAutoOpened && !error && guideDue(readGuide(store))) {
      guideAutoOpened = true;
      openGuide('tutorial');
    }
  };
  const startIntro = (): void => {
    title.setBlocked(true); // the live home page rides on the cockpit display, inert until the handoff
    // the hero: the Free Roam active hull when it is a known sprite, else the Classic fighter (read-only peek)
    const hero = heroSpriteFor(readSlot(store, activeSlot(store)).facts?.ship, (id) => Object.hasOwn(SPRITES, id));
    intro = introRun = runIntro({
      root,
      target: title.root,
      sprites,
      hero,
      seed: INTRO_SEED,
      reduced: reducedMotion(),
      load: () => import('../shared/intro/openingCinematic.ts'),
      onDone: (outcome) => {
        intro = null;
        if (outcome === 'cancelled' || !title.visible) return;
        title.setBlocked(false); // focus returns to the highlighted mode card
        if (outcome === 'failed' || outcome === 'timeout') title.notice(INTRO_FAILED_NOTICE);
        arriveHome();
      },
    });
  };

  /** Read-only peeks at both records for the cards (never writes, never backs up). */
  const titleModel = (error?: string): Parameters<TitleScreen['show']>[0] => {
    const classic = parseSave(store.read(STORAGE_KEYS.classic));
    if (classic.status === 'corrupt') notices.add(CLASSIC_SAVE_UNREADABLE);
    else notices.delete(CLASSIC_SAVE_UNREADABLE);
    const c = classic.data;
    const classicMeta = c.highScore > 0 ? `HIGH SCORE ${formatScore(c.highScore)} · BEST STAGE ${c.bestStage}` : 'HIGH SCORE —';
    // the slot Free Roam opens (read-only peek; slots are managed inside Free Roam)
    const fr = readSlot(store, activeSlot(store));
    return { classicMeta, freeRoamMeta: slotSummary(fr), notices: [...notices], error };
  };

  const setUrlMode = (id: ModeId | null): void => {
    try {
      const url = new URL(location.href);
      if (id) url.searchParams.set('mode', id);
      else url.searchParams.delete('mode');
      if (url.href !== location.href) history.replaceState(history.state, '', url);
    } catch {
      /* sandboxed / file: contexts may refuse replaceState; the deep link is a convenience only */
    }
  };

  controller = new ModeController({
    registry: MODE_REGISTRY,
    menu: {
      show: (error) => {
        setUrlMode(null);
        document.title = 'GALAXIA';
        title.show(titleModel(error));
        sound.setPrefs(prefs.get().audio); // the saved levels (a mode may have previewed others)
        // Finale P3: the first showing per page load plays the opening cinematic; the rest waits for its handoff
        const playIntro = introPending && !error;
        introPending = false;
        if (playIntro) startIntro();
        else arriveHome(error);
      },
      hide: () => {
        intro?.cancel(); // a mode starting mid-intro: the cinematic stops at once, without the home-page handoff
        music.leave();
        guide?.dismiss();
        title.hide();
      },
    },
    makeContext: (id, binding): ModeContext => {
      const container = document.createElement('div');
      container.className = 'mode-root';
      container.dataset['mode'] = id;
      container.dataset['modeRoot'] = ''; // modes restyle their container; this marker survives
      root.append(container);
      return { container, services, ...binding };
    },
    releaseContext: (ctx) => ctx.container.remove(),
    onError: (err) => console.error(err),
    onState: (state, mode) => {
      root.dataset['state'] = state;
      if (mode) root.dataset['mode'] = mode;
      else delete root.dataset['mode'];
    },
  });

  function launch(id: ModeId): Promise<boolean> {
    setUrlMode(id);
    document.title = id === 'classic' ? 'GALAXIA · Classic' : 'GALAXIA · Free Roam';
    return controller.launch(id);
  }

  installAudioUnlock(hostScope, window, sound);
  // Finale P2: a real gesture on the home page may start the theme (autoplay rules). Not the press that
  // picks a mode (a card, or Enter / Space outside the music controls): that press leaves the page.
  // pointerup, not pointerdown: the press has picked its target, so PLAY MUSIC disappearing (the row
  // re-flows) can never move a different control under the finger; the context itself was already
  // created by the pointerdown unlock above.
  const musicGesture = (e: Event): void => {
    if (!title.visible || pendingChoice || introActive()) return; // the intro's own presses (SKIP INTRO) only unlock audio
    const t = e.target as Element | null;
    const inMusic = !!t?.closest?.('.title-music');
    if (e.type === 'pointerup' ? !!t?.closest?.('.mode-card') : !inMusic && ['Enter', 'Space', 'NumpadEnter'].includes((e as KeyboardEvent).code)) return;
    music.gesture();
  };
  hostScope.on<PointerEvent>(window, 'pointerup', musicGesture, { capture: true });
  hostScope.on<KeyboardEvent>(window, 'keydown', musicGesture, { capture: true });

  // P04: hidden Admin Access on the title screen (docs/development/ADMIN_ACCESS.md; nothing on screen
  // mentions it). The detectors only observe: no title key or tap behaves differently unless the whole
  // sequence / gesture completes, which hands a one-shot request to Free Roam and starts it.
  const adminKeys = createSequenceDetector();
  const adminGesture = createGestureDetector();
  const startAdmin = (): void => {
    if (!title.visible || pendingChoice || guideActive() || introActive()) return;
    requestAdminLaunch(performance.now());
    choose('freeroam');
  };
  hostScope.on<KeyboardEvent>(
    window,
    'keydown',
    (e) => {
      if (!title.visible || guideActive() || introActive() || e.isComposing || isEditableTarget(e.target)) {
        adminKeys.reset();
        return;
      }
      if (adminKeys.feed(keyStroke(e))) {
        e.preventDefault();
        startAdmin();
      }
    },
    { capture: true },
  );
  const logo = title.root.querySelector<HTMLElement>('.title-logo');
  if (logo) {
    hostScope.on<PointerEvent>(logo, 'pointerdown', (e) => {
      if (title.visible && !guideActive()) adminGesture.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
    });
    hostScope.on<PointerEvent>(logo, 'pointermove', (e) => adminGesture.move(e.pointerId, e.clientX, e.clientY));
    hostScope.on<PointerEvent>(logo, 'pointerup', (e) => {
      if (adminGesture.up(e.pointerId, e.timeStamp)) startAdmin();
    });
    hostScope.on<PointerEvent>(logo, 'pointercancel', () => adminGesture.cancel());
    // a long press on the logo must not open the browser's context / image menu
    hostScope.on<Event>(logo, 'contextmenu', (e) => e.preventDefault());
  }
  hostScope.on(window, 'blur', () => controller.pause('blur'));
  // audio suspension stays with the modes (Classic suspends while its pause menu is open)
  hostScope.on(document, 'visibilitychange', () => {
    if (document.hidden) controller.pause('hidden');
    music.visibility(document.hidden); // the home-page theme holds while hidden (nothing else changes on the title)
  });

  const host: GalaxiaHost = {
    launch,
    menu: () => controller.returnToMenu(),
    debug: () => ({
      state: controller.state,
      mode: controller.modeId,
      stats: controller.stats,
      host: { listeners: hostScope.activeListeners, loops: hostScope.activeLoops },
      title: { visible: title.visible, shows: title.shows, ...title.debug() },
      active: controller.mode?.debug() ?? null,
      containers: root.querySelectorAll(':scope > [data-mode-root]').length,
      notices: [...notices],
      guide: { ...(guide?.status() ?? GUIDE_CLOSED), record: readGuide(store), autoOpened: guideAutoOpened },
      music: music.debug(),
      sound: { ...sound.stats(), sfxGain: sound.busGain('sfx'), musicGain: sound.busGain('music') },
      intro: introRun?.debug() ?? null,
    }),
  };
  // TD-78: test the literal so the release build drops the hook entirely
  // (one guarded line per hook: tests/release.test.ts checks each assignment's line)
  if (__GALAXIA_TEST_HOOKS__) window.__galaxia = host;
  if (__GALAXIA_TEST_HOOKS__) window.__galaxiaMusicProbe = (spec) => import('../shared/audio/musicProbe.ts').then((m) => m.probe(spec));

  // ?mode=classic|freeroam opens a mode directly (bookmarks, automated checks); anything else shows the title
  const requested = new URLSearchParams(location.search).get('mode');
  if (requested !== null && (MODE_IDS as readonly string[]).includes(requested)) {
    introPending = false; // a deep link never shows the intro, not even on the first return to the home page
    void launch(requested as ModeId);
  } else controller.returnToMenu();
  return host;
}
