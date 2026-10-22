/**
 * Mode host (Free Roam Prompt 2): the page-level owner of everything that
 * outlives a mode, created once per page load:
 *  - shared services: storage, shared prefs (`galaxia:prefs`), one SoundSystem
 *    (one AudioContext), one sprite cache;
 *  - the title screen (mode select);
 *  - the ModeController, which runs at most one mode at a time;
 *  - page signals: audio unlock, and blur / hidden tab -> pause the active mode.
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
import { DisposableScope } from '../shared/lifecycle/scope.ts';
import { NOTICE_TEXT, STORAGE_KEYS, type StorageNotice } from '../shared/persistence/namespaces.ts';
import { PreferencesStore } from '../shared/persistence/preferences.ts';
import { TitleScreen, type TitleChoice } from '../shared/ui/titleScreen.ts';
import { createClassicMode } from './classic/classicMode.ts';
import { ModeController, type HostState } from './controller.ts';
import { activeSlot, readSlot, slotSummary } from './freeroam/saveSlots.ts';
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
  }
}

declare const __GALAXIA_TEST_HOOKS__: boolean; // vite.config.ts `define` (TD-78: automation hooks, absent from release builds)

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
  const title = new TitleScreen(root, sprites, {
    onSelect: (choice: TitleChoice) => {
      if (pendingChoice) return; // double click / Enter + click in the same moment
      pendingChoice = true;
      sound.unlock(); // a click / Enter is a user gesture
      sound.play('uiSelect');
      title.hide();
      // start on the next task: the key event that chose the mode is still being dispatched, and
      // the new mode's listeners must not receive it (Enter would also skip Free Roam's briefing)
      setTimeout(() => {
        pendingChoice = false;
        void launch(choice);
      }, 0);
    },
    onMove: () => sound.play('uiMove'),
    // the same rule as the modes: the shared setting, with 'system' following the browser
    reducedMotion: () => {
      const pref = prefs.get().display.reducedMotion;
      return pref === 'on' || (pref === 'system' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    },
  });

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
      },
      hide: () => title.hide(),
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
  hostScope.on(window, 'blur', () => controller.pause('blur'));
  // audio suspension stays with the modes (Classic suspends while its pause menu is open)
  hostScope.on(document, 'visibilitychange', () => {
    if (document.hidden) controller.pause('hidden');
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
    }),
  };
  // TD-78: test the literal so the release build drops the hook entirely
  if (__GALAXIA_TEST_HOOKS__) window.__galaxia = host;

  // ?mode=classic|freeroam opens a mode directly (bookmarks, automated checks); anything else shows the title
  const requested = new URLSearchParams(location.search).get('mode');
  if (requested !== null && (MODE_IDS as readonly string[]).includes(requested)) void launch(requested as ModeId);
  else controller.returnToMenu();
  return host;
}
