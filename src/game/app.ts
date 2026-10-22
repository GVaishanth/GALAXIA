/**
 * Browser shell for the game: requestAnimationFrame loop with a fixed-step
 * clock, input, rendering, HUD, menus, audio, saves and auto-pause. All
 * gameplay lives in core/; this file only wires platform services to it.
 *
 * Timing: real frame time feeds FixedStepClock (clamped to ENGINE.maxFrameMs);
 * the engine advances in fixed 1/60 s ticks, so speed is independent of the
 * display refresh. Hidden tab / lost focus pauses the game; on return the
 * clock forgets the gap (resetTiming), so nothing teleports.
 *
 * Stage 4: events drained each tick go to the Presenter (effects, transitions,
 * audio). Menus call engine lifecycle methods through applyMenuAction. While
 * paused and nothing changes, frames are not redrawn at all.
 *
 * Stage 5: one InputHub fed by the keyboard, touch-pad and canvas-tap
 * adapters; a responsive layout (desktop / touch portrait / touch landscape)
 * chosen from the viewport and the input in use; canvas backing store sized
 * to exact device pixels with a resolution cap, reallocated only on change.
 *
 * Screen-sizing unification (TD-72): the container, the full-bleed canvas,
 * safe areas, resize and orientation come from the shared AppShell and
 * CanvasSurface (the same objects Free Roam uses); this file only decides
 * where the fixed 448x576 playfield is letterboxed (ui/layout.ts playArea).
 *
 * Free Roam Prompt 2: the shell is disposable. Every listener on window /
 * document / media queries, both ResizeObservers and the frame loop are owned
 * by one DisposableScope, so `status.dispose()` returns the page to a clean
 * state for the mode host (modes/host.ts). Shared services (sound, sprite
 * cache, preferences, storage) can be passed in instead of being created here.
 */
import { ENGINE } from '../config/engine.ts';
import { CLASSIC_MODE } from '../config/gameModes.ts';
import { COLORS } from '../config/palette.ts';
import { INSIGNIA, INSIGNIA_CELL, INSIGNIA_PALETTE } from '../assets/insignia.ts';
import { SoundSystem, type AudioContextLike } from '../audio/soundSystem.ts';
import { FixedStepClock } from '../core/clock.ts';
import { GameEngine } from '../core/game/engine.ts';
import type { GameEvent } from '../core/game/events.ts';
import { PAUSABLE } from '../core/game/stateMachine.ts';
import { RewardManager } from '../core/rewards/rewardManager.ts';
import { InputHub } from '../input/inputHub.ts';
import { isEditableTarget, KeyboardInput, LAYOUT_SWITCH_KEYS } from '../input/keyboard.ts';
import { GamepadInput, type PadUpdate } from '../input/gamepad.ts';
import { TouchControls } from '../input/touchControls.ts';
import { SaveManager, type PreferencesSource } from '../persistence/saveData.ts';
import { openStore, type KeyValueStore } from '../persistence/storage.ts';
import { DisposableScope } from '../shared/lifecycle/scope.ts';
import { anyPadConnected } from '../shared/input/gamepadReader.ts';
import { SpaceBackdrop } from '../render/backdrop.ts';
import { FxDirector } from '../render/fx/fxDirector.ts';
import { drawGame } from '../render/gameRenderer.ts';
import { drawFrame } from '../render/sprite/drawSprite.ts';
import { SpriteCache } from '../render/sprite/spriteCache.ts';
import { TransitionDirector } from '../render/transitions.ts';
import { blendViewport, cssBoxToDevice, fitViewport, type BackingSize, type Viewport } from '../render/viewport.ts';
import { AppShell } from '../shared/rendering/appShell.ts';
import { fullscreenSupported, isFullscreen, onFullscreenChange, setFullscreen } from '../shared/ui/fullscreen.ts';
import { CanvasSurface } from '../shared/rendering/canvasSurface.ts';
import type { RenderScaleStats } from '../shared/rendering/renderScale.ts';
import { chooseLayout, pageArea, playArea, type Layout, type StageBox } from '../ui/layout.ts';
import { bezelBox, easeOut, presentation, type DisplayMode } from '../ui/displayMode.ts';
import { ARCADE } from '../config/devices.ts';
import { SidePanels } from '../ui/sidePanels.ts';
import { InfoPanel } from '../ui/infoPanel.ts';
import { Hud } from '../ui/hud.ts';
import { formatScore, hudModel, notificationsFor, NotificationQueue } from '../ui/presentation.ts';
import { overlayForPhase, screenFor, type Overlay } from '../ui/screenModel.ts';
import { Screens, type SettingChange } from '../ui/screens.ts';
import { applyMenuAction } from './menuActions.ts';
import { Presenter } from './presenter.ts';
import { DEV_TOOLS } from '../config/buildFlags.ts';

/** Device family the player is using (shown in hints; touch shows the pad). */
export type InputMode = 'keyboard' | 'touch' | 'gamepad';

export interface GameStatus {
  readonly engine: GameEngine;
  /** Frames rendered and simulation ticks run (for automated checks). */
  frames: number;
  ticks: number;
  /** rAF callbacks that skipped drawing (paused and unchanged). */
  skippedDraws: number;
  /** Auto-pauses caused by visibility / focus loss. */
  autoPauses: number;
  /** The ⓘ controls and scoring box is open; times it was opened (automated checks). */
  infoOpen: boolean;
  infoOpens: number;
  /** Phone vibrations requested on overheat (touch layouts, full motion only). */
  vibrations: number;
  /** Largest number of ticks run in a single frame. */
  maxTicksPerFrame: number;
  /** Last caught frame errors (capped at MAX_ERROR_LOG). */
  errors: string[];
  /** True once the loop stopped after MAX_CONSECUTIVE_ERRORS failing frames in a row. */
  halted: boolean;
  readonly input: InputHub;
  readonly touch: TouchControls;
  readonly gamepad: GamepadInput;
  /** Device family in use: drives control hints and the touch pad (Stage 8). */
  inputMode: InputMode;
  /** Auto-pauses caused by rotating a touch device mid-game (Stage 8). */
  rotationPauses: number;
  /** Current responsive layout and canvas backing store (for automated checks). */
  layout: Layout;
  backing: BackingSize;
  /** Where the playfield is letterboxed (CSS px, stage = shell coordinates; TD-72). */
  playArea: StageBox;
  /** The shared viewport owner (size, safe-area insets, orientation; TD-72). */
  readonly shell: AppShell;
  /** Canvas backing-store reallocations so far (only on real size changes). */
  canvasResizes: number;
  /**
   * Classic presentation (TD-73, automated checks): the display mode in effect,
   * the arena rect on screen and the arcade bezel's outer box (CSS px, stage
   * coordinates; bezel 0 / box null in Responsive Display), how many
   * presentation switches happened and whether the switch glide is running.
   */
  display: { mode: DisplayMode; field: StageBox | null; bezel: number; bezelBox: StageBox | null; switches: number; gliding: boolean };
  readonly presenter: Presenter;
  readonly sound: SoundSystem;
  /** Currently visible menu screen. */
  screen: string;
  /**
   * Frame profiler (Stage 6): fixed ring buffers of the last PERF_FRAMES frames,
   * no per-frame allocation. `work` = ms spent in the frame callback (simulation
   * ticks + presentation + canvas draw + DOM updates); `interval` = ms since the
   * previous rAF callback. `count` = frames recorded so far (index = count % length).
   */
  readonly perf: { readonly work: Float32Array; readonly interval: Float32Array; count: number };
  /** Adaptive render resolution (TD-79) of the playfield canvas (live object). */
  readonly renderScale: RenderScaleStats | null;
  /** Free Roam Prompt 2: release every listener, observer, loop and DOM node of this mount (idempotent). */
  readonly dispose: () => void;
  disposed: boolean;
  /** Listeners currently registered on long-lived targets by this mount (diagnostics). */
  readonly listenerCount: () => number;
}

const PERF_FRAMES = 600;
/** A one-off exception skips a frame; only a persistent failure stops the loop. */
const MAX_CONSECUTIVE_ERRORS = 20;
const MAX_ERROR_LOG = 20;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function makeSeed(param: string | null): () => number {
  if (param !== null && /^\d+$/.test(param)) {
    const fixed = Number(param) >>> 0;
    return () => fixed;
  }
  return () => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0]!;
  };
}

function createAudioContext(): AudioContextLike | null {
  const w = window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

export interface MountOptions {
  /** Called once if the frame loop halts after repeated errors (shows the fatal panel). */
  readonly onHalt?: () => void;
  /** Shared services from the mode host; each falls back to a private instance (standalone Classic). */
  readonly sound?: SoundSystem | undefined;
  readonly cache?: SpriteCache | undefined;
  readonly prefs?: PreferencesSource | undefined;
  readonly store?: KeyValueStore | undefined;
  /** "Back to the main menu" (title-screen MENU button, Esc / gamepad B on the title). Absent = no button. */
  readonly onExit?: (() => void) | undefined;
}

export function mountGame(root: HTMLElement, options: MountOptions = {}): GameStatus {
  const params = new URLSearchParams(location.search);
  // developer parameters exist only in dev / QA builds (TD-49)
  const debug = DEV_TOOLS && params.get('debug') === '1';
  const startStage = DEV_TOOLS ? Math.max(1, Math.min(9999, Number(params.get('stage') ?? '1') | 0 || 1)) : 1;

  const scope = new DisposableScope();
  root.replaceChildren();
  // the shared viewport owner (same as Free Roam): full-display container, safe areas, resize, orientation
  const shell = new AppShell(root, scope, 'game-app');
  const stage = el('div', 'game-stage mode-stage');
  root.append(stage);
  // full-bleed canvas with the shared DPR / backing-store policy (CanvasSurface, as in Free Roam)
  const surface = new CanvasSurface(stage, scope, 'GALAXIA playfield', 'stage-canvas mode-canvas', { adaptive: true });
  const canvas = surface.canvas;
  const ctx = surface.ctx;
  /* Arcade Display bezel (TD-73): a decorative DOM ring just OUTSIDE the arena
     rect (never over gameplay), click-through, above the canvas and under the
     HUD / menus (appended right after the canvas). Hidden in Responsive. */
  const bezel = el('div', 'arcade-bezel');
  bezel.setAttribute('aria-hidden', 'true');
  bezel.hidden = true;
  stage.append(bezel);

  const cache = options.cache ?? new SpriteCache();
  const save = new SaveManager(options.store ?? openStore());
  /** Audio + display preferences: the shared `galaxia:prefs` store under the mode host, else the Classic record (as before). */
  const prefs: PreferencesSource = options.prefs ?? save;
  const rewards = new RewardManager({ mode: CLASSIC_MODE, highScore: save.get().highScore });
  const engine = new GameEngine({ rewards, seedProvider: makeSeed(params.get('seed')), startStage });
  const input = new InputHub();
  const keyboard = new KeyboardInput(input);
  keyboard.attach(window);
  scope.add(() => keyboard.dispose());
  const touch = new TouchControls(input);
  scope.add(() => touch.dispose());
  const gamepad = new GamepadInput();
  if (options.onExit && anyPadConnected()) gamepad.reset(); // started from the mode menu by pad: the A may still be held
  const queue = new NotificationQueue();
  const sound = options.sound ?? new SoundSystem(createAudioContext, prefs.get().audio);
  const presenter = new Presenter({ fx: new FxDirector(), transitions: new TransitionDirector(), backdrop: new SpaceBackdrop(), sound });

  const hud = new Hud(stage, { reserveIcon: reserveIconFactory(cache), badgeIcon: badgeIconFactory() });

  /* menus */
  let overlay: Overlay = null;
  /** True while the player abandons a paused run (RESTART / QUIT TO TITLE): the
      run is still recorded, but the GAME OVER banner is for real game overs only. */
  let abandoning = false;
  const screens = new Screens(stage, {
    onAction: (action) => {
      sound.play('uiSelect');
      abandoning = engine.phase === 'paused' && (action === 'restart' || action === 'quit');
      if (abandoning) queue.clear(); // drop banners of the abandoned run
      let r: ReturnType<typeof applyMenuAction>;
      try {
        r = applyMenuAction(engine, action, overlay);
      } finally {
        abandoning = false;
      }
      overlay = r.overlay;
      input.clear(); // a click/Enter that chose an item must not also fire
    },
    onSetting: (change) => applySetting(change),
    onNavigate: () => sound.play('uiMove'),
  });
  scope.add(() => screens.dispose());

  /* back to the GALAXIA main menu (mode host): a compact button in the HUD band, title screen only */
  const exitToMenu = (): void => {
    if (!options.onExit || status.disposed) return;
    sound.play('uiSelect');
    options.onExit();
  };
  const exitButton = options.onExit ? el('button', 'mode-exit menu-btn', '◀ MENU') : null;
  if (exitButton) {
    exitButton.type = 'button';
    exitButton.hidden = true;
    exitButton.setAttribute('aria-label', 'Back to the GALAXIA main menu');
    scope.on(exitButton, 'click', exitToMenu);
    stage.append(exitButton);
  }

  /* ⓘ controls and scoring box, and the II / ⓘ corner buttons (owner request,
     TD-75). The box covers the whole app (pad included). The corner buttons
     sit top-right of the playfield during play on desktop layouts with no
     room for the side panels (phone-sized windows); touch layouts have II and
     ⓘ on the pad instead. Opening the box pauses a running game first. */
  const info = new InfoPanel(root);
  scope.add(() => info.dispose());
  const corner = el('div', 'play-corner');
  corner.hidden = true;
  const cornerPause = el('button', 'play-corner-btn play-corner-pause', 'II');
  cornerPause.type = 'button';
  cornerPause.setAttribute('aria-label', 'Pause');
  const cornerInfo = el('button', 'play-corner-btn play-corner-info', 'i');
  cornerInfo.type = 'button';
  cornerInfo.setAttribute('aria-label', 'Controls and scoring');
  corner.append(cornerPause, cornerInfo);
  stage.append(corner);
  const openInfo = (from: HTMLElement | null): void => {
    if (info.isOpen() || status.disposed) return;
    if (PAUSABLE.has(engine.phase)) engine.pause(); // never leave a run going under the box
    releaseAll();
    sound.play('uiSelect');
    info.show({ best: formatScore(Math.max(save.get().highScore, rewards.snapshot().highScore)), bestStage: save.get().bestStage }, from);
    status.infoOpen = true;
    status.infoOpens += 1;
  };
  info.onClose = () => {
    status.infoOpen = false;
    input.clear(); // the press that closed it must not also act behind it
    sound.play('uiMove');
  };
  scope.on(cornerInfo, 'click', () => openInfo(cornerInfo));
  scope.on(cornerPause, 'click', () => {
    input.press('pause', 'pointer');
    cornerPause.blur(); // keep Space / Enter for the game
  });
  touch.onInfo = () => openInfo(null);

  /* tap the playfield to start (title only; game over uses its menu, so a
     stray tap or fire press cannot skip the final score) */
  scope.on<PointerEvent>(canvas, 'pointerdown', (e) => {
    if (engine.phase === 'title' && (e.pointerType !== 'mouse' || e.button === 0)) input.press('start', 'pointer');
  });

  const sidePanels = new SidePanels(stage);
  root.append(stage, touch.root);

  /* responsive layout: touch UI on coarse pointers, or after a touch on a hybrid device */
  const forced = params.get('controls'); // ?controls=touch|keyboard (testing)
  const coarse = window.matchMedia('(pointer: coarse)');
  let touchUI = forced === 'touch' || (forced !== 'keyboard' && coarse.matches);
  let layout: Layout = chooseLayout({ width: shell.safe.width, height: shell.safe.height, touch: touchUI });
  let area: StageBox = playArea(layout, shell.safe);
  /** Set once auto-pause exists (below): rotating a touch device mid-game pauses it. */
  let onRotate = (): void => {};
  const applyLayout = (shellRotated = false): void => {
    const next = chooseLayout({ width: shell.safe.width, height: shell.safe.height, touch: touchUI });
    const modeChanged = next.mode !== layout.mode;
    // portrait <-> landscape on a touch device (the shared shell's aspect flip,
    // or the touch layout flipping): the controls jump under the player's
    // thumbs, so pause instead of letting them die while re-gripping
    const rotated = (shellRotated && touchUI) || (modeChanged && layout.mode !== 'desktop' && next.mode !== 'desktop');
    layout = next;
    area = playArea(next, shell.safe);
    status.playArea = area;
    status.layout = next;
    root.dataset['layout'] = next.mode;
    root.dataset['panels'] = next.sidePanels;
    root.style.setProperty('--side-col', `${next.sideColumn}px`);
    root.style.setProperty('--pad-h', `${next.padHeight}px`);
    sidePanels.setMode(next.sidePanels);
    if (modeChanged || rotated) touch.reset(); // controls moved under the fingers: drop them
    if (rotated) onRotate();
  };
  const setTouchUI = (on: boolean): void => {
    if (forced || on === touchUI) return;
    touchUI = on;
    applyLayout();
  };
  const setInputMode = (mode: InputMode): void => {
    if (status.inputMode === mode && root.dataset['input'] === mode) return;
    status.inputMode = mode;
    root.dataset['input'] = mode;
  };
  scope.on<PointerEvent>(
    window,
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch') {
        setTouchUI(true);
        setInputMode('touch');
      } else if (e.pointerType === 'mouse' && !coarse.matches) {
        setTouchUI(false);
        setInputMode('keyboard');
      }
    },
    { capture: true },
  );
  // A game key switches to the keyboard layout on any device, including
  // tablets and phones with a hardware keyboard (Stage 8; the pad returns on
  // the next touch). Only game keys count, so system keys never flip it, and
  // only fresh presses: a held key's auto-repeat must not hide the pad again
  // straight after the player touches the screen.
  scope.on<KeyboardEvent>(window, 'keydown', (e) => {
    if (e.repeat || isEditableTarget(e.target) || !LAYOUT_SWITCH_KEYS.has(e.code)) return;
    setTouchUI(false);
    setInputMode('keyboard');
  });
  scope.on(coarse, 'change', () => setTouchUI(coarse.matches));
  // one resize system: the shared shell reports size / inset / orientation changes
  shell.onChange((c) => applyLayout(c.rotated));
  // early rotation signal: release held controls and pause straight away on touch
  shell.onRotateStart(() => {
    if (!touchUI) return;
    touch.reset();
    onRotate();
  });

  const status: GameStatus = {
    engine,
    frames: 0,
    ticks: 0,
    skippedDraws: 0,
    autoPauses: 0,
    infoOpen: false,
    infoOpens: 0,
    vibrations: 0,
    maxTicksPerFrame: 0,
    errors: [],
    input,
    touch,
    gamepad,
    inputMode: 'keyboard',
    rotationPauses: 0,
    presenter,
    sound,
    screen: 'none',
    layout,
    backing: surface.backing,
    playArea: area,
    shell,
    canvasResizes: 0,
    display: { mode: 'responsive', field: null, bezel: 0, bezelBox: null, switches: 0, gliding: false },
    perf: { work: new Float32Array(PERF_FRAMES), interval: new Float32Array(PERF_FRAMES), count: 0 },
    renderScale: surface.adaptive?.stats ?? null,
    halted: false,
    dispose: () => dispose(),
    disposed: false,
    listenerCount: () => scope.activeListeners,
  };
  let consecutiveErrors = 0;
  let perfPrevTs: number | null = null;
  applyLayout();
  setInputMode(touchUI ? 'touch' : 'keyboard');
  // fullscreen where supported (shared with Free Roam); entering/leaving is an ordinary shell resize
  screens.setFullscreen(fullscreenSupported(), isFullscreen());
  onFullscreenChange(scope, (on) => screens.setFullscreen(fullscreenSupported(), on));

  /* audio unlock: the context is created only inside a user gesture */
  const unlock = (): void => sound.unlock();
  scope.on(window, 'pointerdown', unlock, { capture: true });
  scope.on(window, 'keydown', unlock, { capture: true });

  /* settings (persisted through SaveManager, which sanitises and clamps) */
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const resolveReducedMotion = (): boolean => {
    const pref = prefs.get().display.reducedMotion;
    return pref === 'on' || (pref === 'system' && reducedMotionQuery.matches);
  };
  let prefsVersion = 0;
  const syncPrefs = (): void => {
    const s = prefs.get();
    sound.setPrefs(s.audio);
    presenter.setReducedMotion(resolveReducedMotion());
    root.dataset['motion'] = resolveReducedMotion() ? 'reduced' : 'full'; // CSS: no blinking with reduced motion
    screens.setPrefs(s.audio, s.display);
    prefsVersion += 1;
  };
  function applySetting(change: SettingChange): void {
    switch (change.kind) {
      case 'fullscreen':
        // the browser owns the state; fullscreenchange (below) updates the toggle
        void setFullscreen(change.value);
        return;
      case 'muted':
        prefs.setAudio({ muted: change.value });
        break;
      case 'volume':
        if (change.commit) prefs.setAudio({ [change.bus]: change.value });
        else sound.setPrefs({ ...prefs.get().audio, [change.bus]: change.value });
        if (!change.commit) return;
        break;
      case 'glow':
        prefs.setDisplay({ glow: change.value });
        break;
      case 'pixelPerfect':
        prefs.setDisplay({ pixelPerfect: change.value });
        break;
      case 'reducedMotion':
        prefs.setDisplay({ reducedMotion: change.value });
        break;
      case 'arcadeDisplay':
        // presentation only (TD-73): the next frame re-fits the arena; no restart, same loop
        prefs.setDisplay({ arcadeDisplay: change.value });
        break;
    }
    syncPrefs();
    if (change.kind !== 'muted' || !change.value) sound.play('uiMove');
  }
  scope.on(reducedMotionQuery, 'change', syncPrefs);
  syncPrefs();

  /* Esc on the Classic title returns to the GALAXIA main menu (OD-20 fix). It
     means "pause" only during play. This runs in the capture phase, before
     KeyboardInput (which takes Escape as its pause key and prevents its
     default) and before the menus: the screen is still the one the player saw
     when pressing, so Esc on HOW TO PLAY / SETTINGS steps back to the title
     and never leaves the mode in the same press. */
  scope.on<KeyboardEvent>(
    window,
    'keydown',
    (e) => {
      if (info.isOpen()) {
        // the box is modal: Esc / Enter / Space close it, Tab stays on CLOSE, nothing reaches the game or menus behind
        if (e.code === 'KeyM' || isEditableTarget(e.target)) return;
        e.stopImmediatePropagation();
        if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space' || e.code === 'Tab') {
          e.preventDefault();
          if (e.code === 'Tab') info.closeButton.focus({ preventScroll: true });
          else if (!e.repeat) info.hide();
        }
        return;
      }
      if (e.code !== 'Escape' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
      if (!options.onExit || screens.screen !== 'title' || engine.phase !== 'title') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      exitToMenu();
    },
    { capture: true },
  );
  scope.on<KeyboardEvent>(window, 'keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
    if (e.code !== 'KeyM') return;
    applySetting({ kind: 'muted', value: !prefs.get().audio.muted });
  });

  /* reward events -> HUD notifications, effects / audio, persistence (independent subscribers) */
  let presentationMs = 0;
  let uiMs = 0;
  rewards.events.onAny((e) => {
    if (!(abandoning && e.type === 'gameOver')) queue.push(notificationsFor(e), presentationMs);
    presenter.handleRewardEvent(e);
  });
  rewards.events.on('gameOver', (e) => {
    save.recordGameResult({ score: e.finalScore, stage: e.stage });
    screens.setGameOver({ score: formatScore(e.finalScore), stage: e.stage, newHighScore: e.newHighScore });
  });
  const recordInterruptedRun = (): void => {
    const s = rewards.snapshot();
    if (s.status === 'running') save.recordGameResult({ score: s.score, stage: s.stage });
  };
  scope.on(window, 'pagehide', recordInterruptedRun);

  /* auto-pause on visibility / focus loss */
  const clock = new FixedStepClock({ hz: ENGINE.tickHz, maxFrameMs: ENGINE.maxFrameMs });
  const releaseAll = (): void => {
    keyboard.reset();
    touch.reset();
    gamepad.reset();
    input.clear();
  };
  const autoPause = (): void => {
    releaseAll();
    if (PAUSABLE.has(engine.phase) && engine.pause()) status.autoPauses += 1;
    // suspend audio now (TD-81), whoever paused the engine (the host's blur / hidden handler runs
    // first): the phase event that normally does it is handled on the next frame, and a hidden tab
    // runs no frames, so a capture-beam loop would keep humming
    if (engine.phase === 'paused') sound.pause();
    clock.resetTiming();
  };
  scope.on(document, 'visibilitychange', () => {
    if (document.hidden) autoPause();
    else clock.resetTiming();
  });
  scope.on(window, 'blur', autoPause);
  onRotate = (): void => {
    const before = status.autoPauses;
    autoPause();
    if (status.autoPauses > before) status.rotationPauses += 1;
  };
  // a controller that drops out mid-game (battery, Bluetooth) pauses, like a lost focus
  scope.on(window, 'gamepaddisconnected', () => {
    input.clearSource('gamepad');
    if (status.inputMode === 'gamepad') autoPause();
  });

  /* gamepad: one poll per frame; meaning depends on the screen (play vs menu) */
  const handlePad = (u: PadUpdate): void => {
    if (u.active) {
      setTouchUI(false);
      setInputMode('gamepad');
    }
    if (u.presses.length > 0) {
      sound.unlock(); // browsers may not count pad presses as a gesture; a key or tap then unlocks audio
      input.lastSource = 'gamepad';
    }
    if (info.isOpen()) {
      // the ⓘ box is modal: A, B or START closes it; nothing reaches the game behind
      input.setMove('gamepad', 0);
      input.setFireHeld('gamepad', false);
      if (u.presses.some((b) => b === 'a' || b === 'b' || b === 'start')) info.hide();
      return;
    }
    const menu = screens.screen;
    if (menu === 'none') {
      input.setMove('gamepad', u.moveX);
      input.setFireHeld('gamepad', u.fireHeld);
      for (const b of u.presses) {
        if (b === 'a' || b === 'x') input.press('fire', 'gamepad');
        else if (b === 'start') input.press('pause', 'gamepad');
      }
      return;
    }
    input.setMove('gamepad', 0);
    input.setFireHeld('gamepad', false);
    for (const b of u.presses) {
      input.pressCount.gamepad += 1;
      if (b === 'up') screens.navigate(-1);
      else if (b === 'down') screens.navigate(1);
      else if (b === 'left') screens.adjust(-1);
      else if (b === 'right') screens.adjust(1);
      else if (b === 'a') screens.activate();
      else if (b === 'b') {
        if (!screens.back()) {
          if (menu === 'pause') input.press('pause', 'gamepad');
          else if (menu === 'title') exitToMenu();
        }
      } else if (b === 'start') {
        if (menu === 'pause') input.press('pause', 'gamepad');
        else if (!screens.back()) screens.activate();
      }
    }
  };

  /** Position the arcade bezel ring (CSS only when its box changed; hidden when thinner than half a pixel). */
  const placeBezel = (outer: StageBox | null, thickness: number): void => {
    const key = outer ? `${outer.left}|${outer.top}|${outer.width}|${outer.height}|${thickness}` : '';
    if (key === bezelKey) return;
    bezelKey = key;
    bezel.hidden = outer === null;
    if (!outer) return;
    const t = Math.round(thickness * 100) / 100;
    bezel.style.left = `${outer.left}px`;
    bezel.style.top = `${outer.top}px`;
    bezel.style.width = `${outer.width}px`;
    bezel.style.height = `${outer.height}px`;
    bezel.style.setProperty('--bezel', `${t}px`);
    // the small GALAXIA mark only fits a generous frame (large screens)
    bezel.classList.toggle('arcade-bezel-mark', t >= ARCADE.markMinBezel);
  };

  let lastTs: number | null = null;
  let lastDrawKey = '';
  /* Responsive <-> Arcade switch (TD-73): the viewport glides from where the
     arena was to its new box (ARCADE.switchMs; instant with reduced motion).
     Presentation only: the engine keeps ticking in art pixels throughout.
     A resize mid-glide snaps (blendViewport refuses a different backing size). */
  let shownMode: DisplayMode | null = null;
  let shownView: Viewport | null = null;
  let shownBezel = 0;
  let bezelKey = '';
  let glide: { from: Viewport; fromBezel: number; start: number } | null = null;
  const pending: GameEvent[] = [];
  // the constructor already moved boot -> title; start the boot fade now
  presenter.handleGameEvents(engine.drainEvents(), engine.world, 0);
  presenter.transitions.boot(0);

  let rafId = 0;
  function frame(ts: number): void {
    if (status.disposed) return; // a frame queued before dispose() must not touch the next mode
    const workStart = performance.now();
    try {
      handlePad(gamepad.poll(ts));
      let ticks = 0;
      const alpha = clock.advance(ts, () => {
        // fire doubles as confirm on the title only (never skips game over)
        engine.step(input.frame({ fireConfirms: engine.phase === 'title' }));
        for (const e of engine.drainEvents()) pending.push(e);
        ticks += 1;
      });
      status.ticks += ticks;
      status.maxTicksPerFrame = Math.max(status.maxTicksPerFrame, ticks);
      const realDt = lastTs === null ? 0 : Math.min(Math.max(0, ts - lastTs), ENGINE.maxFrameMs);
      lastTs = ts;
      uiMs += realDt;
      // menu actions call the engine outside step(); collect their events too
      for (const e of engine.drainEvents()) pending.push(e);
      if (pending.length > 0) {
        // overheat: a short buzz on phones that support it (touch layouts, full motion only; presentation)
        if (touchUI && !presenter.isReducedMotion && pending.some((e) => e.type === 'weaponOverheated') && typeof navigator.vibrate === 'function') {
          navigator.vibrate([70, 50, 70]);
          status.vibrations += 1;
        }
        presenter.handleGameEvents(pending, engine.world, uiMs);
        pending.length = 0;
      }
      const paused = engine.phase === 'paused';
      if (!paused) presentationMs += realDt;

      const phaseClock = engine.phaseClock();
      overlay = overlayForPhase(overlay, engine.phase);
      const screen = screenFor({ phase: engine.phase, gameOverElapsedMs: phaseClock.phase === 'gameOver' ? phaseClock.elapsedMs : 0, overlay });
      screens.show(screen);
      status.screen = screen;
      if (root.dataset['screen'] !== screen) root.dataset['screen'] = screen; // CSS: page screens hide the touch pad
      if (exitButton && exitButton.hidden !== (screen !== 'title')) exitButton.hidden = screen !== 'title';
      // II / ⓘ corner: phone-sized desktop layouts (no side panels, no touch pad), during play only
      const cornerOn = layout.mode === 'desktop' && layout.sidePanels === 'none' && screen === 'none' && !info.isOpen();
      if (corner.hidden === cornerOn) corner.hidden = !cornerOn;
      const cornerKey = cornerOn ? 'on' : 'off';
      if (root.dataset['corner'] !== cornerKey) root.dataset['corner'] = cornerKey; // CSS: the ticker keeps clear of it
      // weapon heat (TD-74): HUD meter during a run, and the touch FIRE button
      const heat = engine.world.heat;
      const inRun = engine.phase !== 'title' && engine.phase !== 'gameOver' && engine.phase !== 'boot' && engine.phase !== 'restarting';
      hud.setHeat(heat.level, heat.overheated, inRun);
      touch.setHeat(inRun ? heat.level : 0, inRun && heat.overheated);
      const tr = presenter.frame(realDt, uiMs, engine.world, phaseClock, engine.isStageIntro);

      const display = prefs.get().display;
      const backing = surface.fit(); // reallocates only when the size really changed
      status.canvasResizes = surface.resizes;
      status.backing = backing;
      const { width, height } = backing;
      const ratio = backing.ratio;
      const pres = presentation(layout, area, display.arcadeDisplay);
      if (shownMode !== null && pres.mode !== shownMode) {
        status.display.switches += 1;
        glide = shownView && !presenter.isReducedMotion && ARCADE.switchMs > 0 ? { from: shownView, fromBezel: shownBezel, start: uiMs } : null;
      }
      shownMode = pres.mode;
      if (root.dataset['display'] !== pres.mode) root.dataset['display'] = pres.mode;
      const glideK = glide ? (uiMs - glide.start) / ARCADE.switchMs : 1;
      if (glide && glideK >= 1) glide = null;
      status.display.gliding = glide !== null;
      const drawKey = `${width}x${height}|${ratio}|${pres.align}|${shell.revision}|${area.left},${area.top},${area.width},${area.height}|${prefsVersion}|${screen}|${glide ? uiMs : ''}`;
      const skip = paused && drawKey === lastDrawKey && !presenter.transitions.animating(uiMs, phaseClock, presenter.isReducedMotion);
      if (skip) {
        status.skippedDraws += 1;
      } else {
        lastDrawKey = drawKey;
        // the fixed arena, letterboxed inside the safe play area of the full-bleed canvas:
        // the whole play area (Responsive) or the arcade box inside its bezel (Arcade)
        const target = fitViewport(width, height, { integerScale: display.pixelPerfect, align: pres.align, area: cssBoxToDevice(pres.fit, backing) });
        const ease = glide ? easeOut(glideK) : 1;
        const v = glide ? blendViewport(glide.from, target, ease) : target;
        if (v === target) glide = null; // a resize mid-glide: snap to the new layout
        const bezelPx = glide ? glide.fromBezel + (pres.bezel - glide.fromBezel) * ease : pres.bezel;
        shownView = v;
        shownBezel = bezelPx;
        drawGame(ctx!, { cache, backdrop: presenter.backdrop!, fx: presenter.fx }, v, engine.world, {
          alpha: paused ? 1 : alpha,
          timeMs: presentationMs,
          phase: engine.phase,
          activePhase: engine.machine.activePhase,
          glow: display.glow,
          motion: presenter.isReducedMotion ? 0.25 : 1,
          transition: tr,
          debug,
          hitboxes: ENGINE.hitboxes,
        });
        const rect = { left: v.offsetX / ratio, top: v.offsetY / ratio, width: (v.artWidth * v.scale) / ratio, height: (v.artHeight * v.scale) / ratio };
        hud.setPlayfieldRect(rect);
        // page screens may use the whole safe game area on touch layouts (no DOM reads: derived from the layout)
        screens.setPlayfieldRect(rect, area, pageArea(layout, shell.safe));
        const outer = bezelPx >= 0.5 ? bezelBox(rect, bezelPx) : null;
        sidePanels.setRect(outer ?? rect, area); // desktop panels sit beside the bezel, not under it
        placeBezel(outer, bezelPx);
        status.display.mode = pres.mode;
        status.display.field = rect;
        status.display.bezel = Math.round(bezelPx * 100) / 100;
        status.display.bezelBox = outer;
        if (exitButton) {
          // top-right corner of the playfield, level with the score band (free on every layout)
          exitButton.style.left = `${rect.left + rect.width}px`;
          exitButton.style.top = `${rect.top}px`;
        }
        corner.style.left = `${rect.left + rect.width}px`;
        corner.style.top = `${rect.top}px`;
      }
      const snap = rewards.snapshot();
      hud.update(hudModel(snap));
      if (layout.sidePanels !== 'none') sidePanels.update({ best: formatScore(Math.max(save.get().highScore, snap.highScore)), bestStage: save.get().bestStage, muted: prefs.get().audio.muted });
      hud.setPaused(paused);
      hud.setMenuOpen(screen !== 'none');
      // score pop-ups are drawn on the canvas (under projectiles); the DOM HUD shows the rest
      hud.showNotifications(queue.active(presentationMs).filter((n) => n.placement !== 'popup'));
      status.frames += 1;
      const slot = status.perf.count % PERF_FRAMES;
      const work = performance.now() - workStart;
      status.perf.work[slot] = work;
      // TD-79: adaptive render resolution samples running frames only (pause excluded; hidden tabs excluded in the surface)
      // Pixel Perfect picks the largest integer art scale for the device-pixel area, so a lower ratio
      // would shrink the arena on screen: that mode always renders at full resolution
      const pixelPerfect = prefs.get().display.pixelPerfect;
      if (pixelPerfect) surface.adaptive?.reset();
      surface.sample(ts, work, !paused && !pixelPerfect);
      status.perf.interval[slot] = perfPrevTs === null ? 0 : ts - perfPrevTs;
      status.perf.count += 1;
      perfPrevTs = ts;
      consecutiveErrors = 0;
    } catch (err) {
      status.errors.push(err instanceof Error ? err.message : String(err));
      if (status.errors.length > MAX_ERROR_LOG) status.errors.shift();
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        // persistent failure: stop instead of spinning, and say so
        status.halted = true;
        console.error('GALAXIA stopped after repeated frame errors:', err);
        options.onHalt?.();
        return;
      }
    }
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  function dispose(): void {
    if (status.disposed) return;
    status.disposed = true;
    cancelAnimationFrame(rafId);
    try {
      recordInterruptedRun(); // leaving mid-run still counts, exactly like closing the tab
      releaseAll();
      sound.stopLoops(); // mode-specific loops (beam); the shared AudioContext stays
      if (sound.isPaused) sound.resume(); // TD-81: never hand the next mode a suspended context
    } finally {
      // always release, even after a halt left the engine in a bad state
      scope.dispose(); // listeners, observer, canvas memory, keyboard, touch pad, menus, html.game-mode
      root.replaceChildren();
    }
  }
  return status;
}

function reserveIconFactory(cache: SpriteCache): () => HTMLElement {
  const size = 32;
  const source = document.createElement('canvas');
  source.width = size;
  source.height = size;
  const c = source.getContext('2d');
  if (c) drawFrame(c, cache, cache.frame('player.fighter', 'idle', 0), fitViewport(size, size, { artWidth: 28, artHeight: 28 }), 14, 14, { glow: false });
  return () => {
    const n = document.createElement('canvas');
    n.width = size;
    n.height = size;
    n.getContext('2d')?.drawImage(source, 0, 0);
    return n;
  };
}

/** Stage insignia icons: drawn once per denomination at 1 px per art pixel, scaled up by CSS (pixelated). */
function badgeIconFactory(): (value: number) => HTMLElement {
  const sources = new Map<number, HTMLCanvasElement>();
  const draw = (value: number): HTMLCanvasElement => {
    const grid = INSIGNIA[value] ?? INSIGNIA[1]!;
    const c = document.createElement('canvas');
    c.width = INSIGNIA_CELL.width;
    c.height = INSIGNIA_CELL.height;
    const g = c.getContext('2d');
    if (g) {
      const top = INSIGNIA_CELL.height - grid.length;
      grid.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          const role = INSIGNIA_PALETTE[row[x]!];
          if (!role) continue;
          g.fillStyle = COLORS[role];
          g.fillRect(x, top + y, 1, 1);
        }
      });
    }
    return c;
  };
  return (value) => {
    let src = sources.get(value);
    if (!src) {
      src = draw(value);
      sources.set(value, src);
    }
    const n = document.createElement('canvas');
    n.width = src.width;
    n.height = src.height;
    n.getContext('2d')?.drawImage(src, 0, 0);
    n.setAttribute('aria-hidden', 'true');
    return n;
  };
}
