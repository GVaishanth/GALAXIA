/**
 * One tick of player intent, produced by the platform input layer (or a test
 * script). Edge-triggered actions are true for exactly one tick.
 */
export interface InputFrame {
  /** -1 left, 0 none, 1 right. */
  readonly moveX: -1 | 0 | 1;
  /** Fire pressed this tick (edge). */
  readonly fire: boolean;
  /**
   * Fire button held this tick (level; hold-to-fire with weapon heat, TD-74).
   * Absent or false = the original press-per-shot behaviour (scripts, tests).
   */
  readonly fireHeld?: boolean;
  /**
   * Combat P03C: NEXT / PREVIOUS weapon pressed this tick (edge; 1 = next,
   * -1 = previous). Only read when the game has a post-Wave-20 loadout;
   * absent = no switch (the legacy fighter has one weapon).
   */
  readonly cycle?: 1 | -1 | 0;
  /** Pause toggle pressed this tick (edge). */
  readonly pause: boolean;
  /** Start / confirm pressed this tick (edge). */
  readonly start: boolean;
}

export const NO_INPUT: InputFrame = Object.freeze({ moveX: 0, fire: false, pause: false, start: false, fireHeld: false });

export function input(partial: Partial<InputFrame>): InputFrame {
  return { ...NO_INPUT, ...partial };
}
