/**
 * Menu action -> engine API. Menus never touch the world: they call the same
 * public lifecycle methods the keyboard uses (startGame / resume /
 * quitToTitle / returnToTitle), so every phase rule in the state machine
 * still applies. Sub-panel navigation only changes the overlay.
 */
import type { GamePhase } from '../core/game/stateMachine.ts';
import type { MenuAction, Overlay } from '../ui/screenModel.ts';

export interface MenuTarget {
  readonly phase: GamePhase;
  startGame(): boolean;
  resume(): boolean;
  quitToTitle(): boolean;
  returnToTitle(): boolean;
}

export interface MenuResult {
  readonly overlay: Overlay;
  /** The engine accepted the request (or the overlay changed). */
  readonly ok: boolean;
}

export function applyMenuAction(target: MenuTarget, action: MenuAction, overlay: Overlay): MenuResult {
  switch (action) {
    case 'start':
      return { overlay: null, ok: target.phase === 'title' && target.startGame() };
    case 'restart':
      // game over: play again. Paused: abandon this run (recorded as a game over,
      // as QUIT does) and start a fresh one in one step.
      if (target.phase === 'gameOver') return { overlay: null, ok: target.startGame() };
      if (target.phase === 'paused') return { overlay: null, ok: target.quitToTitle() && target.startGame() };
      return { overlay: null, ok: false };
    case 'resume':
      return { overlay: null, ok: target.resume() };
    case 'quit':
      return { overlay: null, ok: target.quitToTitle() };
    case 'title':
      return { overlay: null, ok: target.returnToTitle() };
    case 'howTo':
    case 'settings': {
      const allowed = target.phase === 'title' || target.phase === 'paused';
      return { overlay: allowed ? action : overlay, ok: allowed };
    }
    case 'back':
      return { overlay: null, ok: overlay !== null };
  }
}
