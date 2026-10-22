/**
 * Screen model (pure): which menu screen is visible for a given engine phase,
 * and what each menu offers. The DOM layer (screens.ts) renders it; the game
 * shell turns menu actions into engine API calls (game/menuActions.ts).
 */
import { TRANSITIONS } from '../config/presentation.ts';
import type { GamePhase } from '../core/game/stateMachine.ts';

export type ScreenId = 'none' | 'title' | 'howTo' | 'settings' | 'pause' | 'gameOver';
/** Sub-panel opened from a menu (title or pause). */
export type Overlay = 'howTo' | 'settings' | null;

export type MenuAction = 'start' | 'resume' | 'quit' | 'restart' | 'title' | 'howTo' | 'settings' | 'back';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly action: MenuAction;
}

export const MENUS: Readonly<Record<'title' | 'pause' | 'gameOver', readonly MenuItem[]>> = Object.freeze({
  title: [
    { id: 'start', label: 'START GAME', action: 'start' },
    { id: 'howto', label: 'HOW TO PLAY', action: 'howTo' },
    { id: 'settings', label: 'SETTINGS', action: 'settings' },
  ],
  pause: [
    { id: 'resume', label: 'RESUME', action: 'resume' },
    { id: 'settings', label: 'SETTINGS', action: 'settings' },
    { id: 'howto', label: 'HOW TO PLAY', action: 'howTo' },
    { id: 'restart', label: 'RESTART', action: 'restart' },
    { id: 'quit', label: 'QUIT TO TITLE', action: 'quit' },
  ],
  gameOver: [
    { id: 'again', label: 'PLAY AGAIN', action: 'restart' },
    { id: 'title', label: 'TITLE SCREEN', action: 'title' },
  ],
});

export interface ScreenInput {
  readonly phase: GamePhase;
  /** Simulation ms spent in game over (menu appears after the caption). */
  readonly gameOverElapsedMs: number;
  readonly overlay: Overlay;
}

export function screenFor(i: ScreenInput): ScreenId {
  switch (i.phase) {
    case 'title':
      return i.overlay ?? 'title';
    case 'paused':
      return i.overlay ?? 'pause';
    case 'gameOver':
      return i.gameOverElapsedMs >= TRANSITIONS.gameOverMenuDelayMs ? 'gameOver' : 'none';
    default:
      return 'none';
  }
}

/** Sub-panels only exist on the title and pause screens; any other phase closes them. */
export function overlayForPhase(overlay: Overlay, phase: GamePhase): Overlay {
  return phase === 'title' || phase === 'paused' ? overlay : null;
}
