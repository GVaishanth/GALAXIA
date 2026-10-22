/**
 * Game-mode lifecycle (Free Roam Prompt 2).
 *
 *   created ──init()──► initialized ──activate()──► active ◄──pause()/resume()──► paused
 *                                                     │
 *                                  dispose() from any state ──► disposed
 *
 * Each mode owns its own state, update loop, rendering setup, input
 * interpretation, pause / restart and score / progression. Modes share only
 * the services in SharedServices (one instance per page, never recreated on a
 * mode switch). A mode reaches the host only through its ModeContext, whose
 * callbacks are bound to one session: after the mode is disposed they do
 * nothing, so a late callback from an old mode can never act on the new one.
 */
import type { SoundSystem } from '../audio/soundSystem.ts';
import type { KeyValueStore } from '../persistence/storage.ts';
import type { SpriteCache } from '../render/sprite/spriteCache.ts';
import type { PreferencesStore } from '../shared/persistence/preferences.ts';

export type ModeId = 'classic' | 'freeroam';
export const MODE_IDS: readonly ModeId[] = ['classic', 'freeroam'];

export type ModeLifecycle = 'created' | 'initialized' | 'active' | 'paused' | 'disposed';
export type PauseReason = 'hidden' | 'blur' | 'host';

/** Page-lifetime services shared by every mode. */
export interface SharedServices {
  readonly store: KeyValueStore;
  readonly prefs: PreferencesStore;
  readonly sound: SoundSystem;
  readonly sprites: SpriteCache;
  /** Storage problems found so far (shown on the title screen). */
  readonly reportStorageProblem: (problem: 'write-failed' | 'corrupt-reset' | 'future-version' | 'backup-failed') => void;
}

export interface ModeContext {
  /** Empty element the mode renders into; removed by the host after dispose(). */
  readonly container: HTMLElement;
  readonly services: SharedServices;
  /** Ask the host to return to the title screen (deferred; ignored once this session ended). */
  readonly requestExit: () => void;
  /** Ask the host to dispose this mode and start a fresh instance of it (deferred; ignored once
   *  this session ended). Free Roam uses it to open another save slot. */
  readonly requestRestart: () => void;
  /** Report an unrecoverable error: the host disposes the mode and shows the message on the title screen. */
  readonly fail: (message: string) => void;
  /** True while this mode is still the host's current session. */
  readonly isCurrent: () => boolean;
}

export interface GameMode {
  readonly id: ModeId;
  /**
   * Allocate state, DOM, listeners. May be async (lazy assets). Must not start the loop.
   * An async init may be disposed while it is still pending (the player went back): after each
   * await, check `ctx.isCurrent()` and register through the mode's DisposableScope, which ignores
   * registrations once disposed.
   */
  init(): void | Promise<void>;
  /** Start (or continue) the update / render loop. */
  activate(): void;
  /** Stop simulation time (visibility / focus loss or host request). Clears held input. */
  pause(reason: PauseReason): void;
  /** Leave a host-requested pause (modes may keep their own pause menu open instead). */
  resume(): void;
  /** Release everything: listeners, loops, timers, audio loops, canvas memory, DOM. Idempotent. */
  dispose(): void;
  /** Read-only diagnostics for automated checks. */
  debug(): ModeDebug;
}

export interface ModeDebug {
  readonly lifecycle: ModeLifecycle;
  /** Listeners this mode currently holds on long-lived targets (page, media queries). */
  readonly listeners: number;
  /** Frame loops this mode currently runs (0 or 1). */
  readonly loops: number;
  readonly [key: string]: unknown;
}

export type ModeFactory = (ctx: ModeContext) => GameMode;
/** Factories may be loaded lazily (Free Roam is a separate chunk). */
export type ModeRegistry = Readonly<Record<ModeId, () => Promise<ModeFactory>>>;
