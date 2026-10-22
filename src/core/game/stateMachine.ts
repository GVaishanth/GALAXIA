/**
 * Game phase state machine with an explicit transition table. Illegal
 * transitions are refused (and counted) instead of producing contradictory
 * states. Paused remembers the phase to resume.
 */
export type GamePhase =
  | 'boot'
  | 'title'
  | 'ready'
  | 'playing'
  | 'playerHit'
  | 'stageCleared'
  | 'challenge'
  | 'paused'
  | 'gameOver'
  | 'restarting';

export const TRANSITIONS: Readonly<Record<GamePhase, readonly GamePhase[]>> = Object.freeze({
  boot: ['title'],
  title: ['ready'],
  ready: ['playing', 'challenge', 'paused'],
  playing: ['playerHit', 'stageCleared', 'paused'],
  challenge: ['playerHit', 'stageCleared', 'paused'],
  playerHit: ['ready', 'stageCleared', 'gameOver', 'paused'],
  stageCleared: ['ready', 'paused'],
  // Leaving pause goes back to the remembered phase (resume) or quits to title.
  paused: ['title'],
  gameOver: ['title', 'restarting'],
  restarting: ['ready'],
});

/** Phases in which the simulation advances (paused/title/boot do not). */
export const SIMULATING: ReadonlySet<GamePhase> = new Set(['ready', 'playing', 'playerHit', 'stageCleared', 'challenge', 'gameOver']);
/** Phases that accept movement and fire input. */
export const CONTROLLABLE: ReadonlySet<GamePhase> = new Set(['playing', 'challenge']);
/** Phases that can be paused. */
export const PAUSABLE: ReadonlySet<GamePhase> = new Set(['ready', 'playing', 'playerHit', 'stageCleared', 'challenge']);

/** Read-only timing of the current phase (presentation: countdowns, transitions). */
export interface PhaseClock {
  /** Active phase (while paused: the phase that will resume). */
  readonly phase: GamePhase;
  readonly paused: boolean;
  /** Simulation ms spent in `phase` (frozen while paused). */
  readonly elapsedMs: number;
  /** Fixed length of the phase, or null when it has none. */
  readonly durationMs: number | null;
}

export class PhaseMachine {
  private current: GamePhase = 'boot';
  private resumeTo: GamePhase | null = null;
  /** Time spent in the current phase (simulation ms; frozen while paused). */
  timeInPhaseMs = 0;
  /** Count of refused transitions (should stay 0; asserted in tests). */
  refused = 0;
  readonly history: GamePhase[] = ['boot'];
  private readonly onChange: (from: GamePhase, to: GamePhase) => void;

  constructor(onChange: (from: GamePhase, to: GamePhase) => void = () => undefined) {
    this.onChange = onChange;
  }

  get phase(): GamePhase {
    return this.current;
  }

  /** The phase that will resume when unpaused (or the current one). */
  get activePhase(): GamePhase {
    return this.current === 'paused' ? (this.resumeTo ?? 'title') : this.current;
  }

  can(to: GamePhase): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  transition(to: GamePhase): boolean {
    if (!this.can(to)) {
      this.refused += 1;
      return false;
    }
    this.set(to);
    return true;
  }

  pause(): boolean {
    if (!PAUSABLE.has(this.current)) return false;
    this.resumeTo = this.current;
    const from = this.current;
    this.current = 'paused';
    this.history.push('paused');
    this.onChange(from, 'paused');
    return true;
  }

  resume(): boolean {
    if (this.current !== 'paused' || this.resumeTo === null) return false;
    const to = this.resumeTo;
    this.resumeTo = null;
    this.current = to;
    this.history.push(to);
    this.onChange('paused', to);
    return true;
  }

  tick(dtMs: number): void {
    if (SIMULATING.has(this.current)) this.timeInPhaseMs += dtMs;
  }

  private set(to: GamePhase): void {
    const from = this.current;
    this.current = to;
    this.timeInPhaseMs = 0;
    if (to !== 'paused') this.resumeTo = null;
    this.history.push(to);
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    this.onChange(from, to);
  }
}
