/**
 * Shared context handed to every system for one simulation tick.
 */
import type { EngineConfig } from '../../config/engine.ts';
import { CHALLENGE_PATHS, ENTRY_PATHS, type PathPoints } from '../../config/paths.ts';
import type { FactResult, GameplayFact } from '../rewards/types.ts';
import type { GameEvent } from '../game/events.ts';
import type { GamePhase } from '../game/stateMachine.ts';
import type { Enemy, EnemyKind, World } from '../game/types.ts';
import { buildPath, mirrorPoints, type Path, type Pt } from './paths.ts';

export interface SimContext {
  readonly cfg: EngineConfig;
  readonly world: World;
  readonly paths: PathCache;
  /** Active phase (never 'paused' inside a tick). */
  readonly phase: GamePhase;
  emit(e: GameEvent): void;
  fact(f: GameplayFact): FactResult;
  /** Ships in reserve according to the reward ledger. */
  reserves(): number;
  /** Called when the ship in play is lost (destroyed or captured). */
  onPlayerLost(cause: 'destroyed' | 'captured'): void;
}

/** Built-once cache of scripted paths ("entry:topDrop", "challenge:zigzag:m", ...). */
export class PathCache {
  private readonly cache = new Map<string, Path>();
  private readonly width: number;
  constructor(width: number) {
    this.width = width;
  }

  get(key: string): Path {
    let p = this.cache.get(key);
    if (!p) {
      const [family, name, mirror] = key.split(':');
      const table = (family === 'entry' ? ENTRY_PATHS : family === 'challenge' ? CHALLENGE_PATHS : undefined) as Record<string, PathPoints> | undefined;
      const points = table?.[name ?? ''];
      if (!points) throw new Error(`Unknown path ${key}`);
      p = buildPath(mirror === 'm' ? mirrorPoints(points, this.width) : (points as readonly Pt[]));
      this.cache.set(key, p);
    }
    return p;
  }

  start(key: string): Pt {
    const p = this.get(key);
    return [p.xs[0]!, p.ys[0]!];
  }
}

export function newId(world: World, prefix: string): string {
  world.nextId += 1;
  return `${prefix}${world.stage}-${world.nextId}`;
}

export function createEnemy(world: World, cfg: EngineConfig, kind: EnemyKind, x: number, y: number, extra: Partial<Enemy> = {}): Enemy {
  const e: Enemy = {
    id: newId(world, kind === 'capturedFighter' ? 'cap' : 'e'),
    kind,
    state: 'entering',
    stateMs: 0,
    slot: null,
    x,
    y,
    prevX: x,
    prevY: y,
    dirX: 0,
    dirY: 1,
    run: null,
    hp: kind === 'commander' ? cfg.commanderHits : 1,
    hitFlashMs: 0,
    ...extra,
  };
  world.enemies.push(e);
  return e;
}

export function setState(e: Enemy, state: Enemy['state']): void {
  if (e.state !== state) {
    e.state = state;
    e.stateMs = 0;
  }
}
