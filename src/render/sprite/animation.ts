import type { SpriteDef } from '../../assets/sprites/format/types.ts';

/** Which frame of a looping state is visible at `timeMs`. Pure. */
export function frameIndexAt(def: SpriteDef, state: string, timeMs: number): number {
  const frames = def.states[state];
  if (!frames || frames.length <= 1) return 0;
  const ms = (def.frameMs as Record<string, number | undefined> | undefined)?.[state];
  if (!ms || ms <= 0) return 0;
  return Math.floor(Math.max(0, timeMs) / ms) % frames.length;
}

/** Frame of a one-shot state (explosions); returns -1 once finished. */
export function oneShotFrameAt(def: SpriteDef, state: string, elapsedMs: number): number {
  const frames = def.states[state];
  const ms = (def.frameMs as Record<string, number | undefined> | undefined)?.[state];
  if (!frames || !ms) return 0;
  const i = Math.floor(Math.max(0, elapsedMs) / ms);
  return i < frames.length ? i : -1;
}
