/**
 * Classic Mode adapter: wraps the existing, verified Classic shell
 * (game/app.ts mountGame) in the mode lifecycle without changing its gameplay.
 * Classic keeps owning its state (core/game), update loop, renderer, input
 * interpretation (left/right only), pause / restart menus and scoring / save
 * record (`galaxia:save`). The adapter only:
 *  - passes the page-wide services (sound, sprites, shared prefs, storage);
 *  - maps lifecycle calls (Classic starts its loop on mount, so init() mounts
 *    and activate() has nothing left to do);
 *  - exposes the status object for automated checks while Classic is active;
 *  - Combat P03C: hands Classic the cross-mode ship registry as plain data
 *    (modes/crossMode.ts): before Wave 20 is completed it reports the gate
 *    closed and Classic stays exactly as it was.
 */
import { mountGame, type GameStatus } from '../../game/app.ts';
import { PAUSABLE } from '../../core/game/stateMachine.ts';
import type { GameMode, ModeContext, ModeDebug, ModeLifecycle } from '../types.ts';
import { CLASSIC_GATE_STAGE, classicFleet, markClassicComplete, setClassicShip } from '../crossMode.ts';

declare global {
  interface Window {
    /** Classic status (read-only diagnostics for Playwright) while Classic Mode is active. */
    __galaxiaGame?: GameStatus;
  }
}

declare const __GALAXIA_TEST_HOOKS__: boolean; // vite.config.ts `define` (TD-78: automation hooks, absent from release builds)

export function createClassicMode(ctx: ModeContext): GameMode {
  let status: GameStatus | null = null;
  let lifecycle: ModeLifecycle = 'created';
  return {
    id: 'classic',
    init() {
      const { services } = ctx;
      status = mountGame(ctx.container, {
        sound: services.sound,
        cache: services.sprites,
        prefs: services.prefs,
        store: services.store,
        onExit: ctx.requestExit,
        fleet: {
          read: () => classicFleet(services.store),
          select: (id) => void setClassicShip(services.store, id),
          complete: () => void markClassicComplete(services.store),
          gateStage: CLASSIC_GATE_STAGE,
        },
        onHalt: () => ctx.fail('The game stopped after an unexpected error.'),
      });
      if (__GALAXIA_TEST_HOOKS__) window.__galaxiaGame = status;
      lifecycle = 'initialized';
    },
    activate() {
      lifecycle = 'active';
    },
    pause() {
      // Classic already auto-pauses on blur / hidden tab; a host pause uses the same rule
      if (status && PAUSABLE.has(status.engine.phase)) status.engine.pause();
      if (lifecycle === 'active') lifecycle = 'paused';
    },
    resume() {
      // the player resumes from Classic's own pause menu (unchanged arcade behaviour)
      if (lifecycle === 'paused') lifecycle = 'active';
    },
    dispose() {
      if (lifecycle === 'disposed') return;
      lifecycle = 'disposed';
      status?.dispose();
      if (__GALAXIA_TEST_HOOKS__ && window.__galaxiaGame === status) delete window.__galaxiaGame;
      status = null;
    },
    debug(): ModeDebug {
      return { lifecycle, listeners: status?.listenerCount() ?? 0, loops: status && !status.disposed && !status.halted ? 1 : 0 };
    },
  };
}
