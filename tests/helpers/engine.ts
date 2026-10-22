/** Shared helpers for deterministic engine tests. */
import { GameEngine, type GameEngineOptions } from '../../src/core/game/engine.ts';
import { NO_INPUT, type InputFrame } from '../../src/core/game/input.ts';
import type { Enemy } from '../../src/core/game/types.ts';
import { RewardManager } from '../../src/core/rewards/rewardManager.ts';
import type { RewardEvent } from '../../src/core/rewards/types.ts';

export interface Harness {
  engine: GameEngine;
  rewards: RewardManager;
  rewardEvents: RewardEvent[];
}

export function makeEngine(options: Partial<GameEngineOptions> = {}): Harness {
  const rewards = new RewardManager();
  const rewardEvents: RewardEvent[] = [];
  rewards.events.onAny((e) => rewardEvents.push(e));
  const engine = new GameEngine({ rewards, seed: 1, instantFormation: true, ...options });
  return { engine, rewards, rewardEvents };
}

export type InputScript = InputFrame | ((tick: number) => InputFrame);

export function run(engine: GameEngine, ticks: number, script: InputScript = NO_INPUT): void {
  for (let i = 0; i < ticks; i++) engine.step(typeof script === 'function' ? script(i) : script);
}

/** Step until `pred` holds; returns ticks used. Throws if it never does. */
export function runUntil(engine: GameEngine, pred: () => boolean, max = 60 * 60, script: InputScript = NO_INPUT): number {
  for (let i = 0; i < max; i++) {
    if (pred()) return i;
    engine.step(typeof script === 'function' ? script(i) : script);
  }
  if (pred()) return max;
  throw new Error(`condition not reached in ${max} ticks (phase ${engine.phase}, stage ${engine.world.stage})`);
}

/** Title -> playing (or challenge). Optionally silence the attack scheduler for scripted scenarios. */
export function startPlaying(h: Harness, opts: { quiet?: boolean } = {}): void {
  h.engine.step({ ...NO_INPUT, start: true });
  runUntil(h.engine, () => h.engine.phase === 'playing' || h.engine.phase === 'challenge');
  if (opts.quiet) quiet(h.engine);
}

/** Stop new attacks from launching (scripted tests launch them by hand). */
export function quiet(engine: GameEngine): void {
  engine.world.attackTimerMs = Number.POSITIVE_INFINITY;
}

export function enemiesOf(engine: GameEngine, kind: Enemy['kind']): Enemy[] {
  return engine.world.enemies.filter((e) => e.kind === kind && e.state !== 'destroyed');
}

/** Put an enemy shot just above the player (hits on the next tick). */
export function shootPlayer(engine: GameEngine, dx = 0): void {
  const p = engine.world.player;
  engine.world.enemyShots.push({ id: -1, x: p.x + dx, y: p.y - 6, prevX: p.x + dx, prevY: p.y - 6, vx: 0, vy: 230 });
}

export function score(h: Harness): number {
  return h.rewards.snapshot().score;
}

export const FIRE: InputFrame = { ...NO_INPUT, fire: true };
export const LEFT: InputFrame = { ...NO_INPUT, moveX: -1 };
export const RIGHT: InputFrame = { ...NO_INPUT, moveX: 1 };
export const PAUSE: InputFrame = { ...NO_INPUT, pause: true };
export const START: InputFrame = { ...NO_INPUT, start: true };
