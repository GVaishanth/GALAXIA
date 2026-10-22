/**
 * Entry sequence: enemies fly in along scripted paths in strings, then form
 * up in their slots. Controlled order, never random placement.
 */
import { FORMATION } from '../../config/formation.ts';
import type { EntrySpawn, Slot } from '../game/types.ts';
import { createEnemy, setState, type SimContext } from './context.ts';
import { slotPosition } from './formation.ts';

export function buildEntryQueue(): EntrySpawn[] {
  const queue: EntrySpawn[] = [];
  for (const wave of FORMATION.entryWaves) {
    for (const string of wave.strings) {
      string.slots.forEach((slotId, i) => {
        queue.push({ atMs: wave.atMs + i * FORMATION.stringSpacingMs, slotId, pathKey: `entry:${string.path}${string.mirror ? ':m' : ''}` });
      });
    }
  }
  return queue.sort((a, b) => a.atMs - b.atMs || a.slotId.localeCompare(b.slotId));
}

/** Place the full formation instantly (tests and debug). */
export function placeFormation(ctx: SimContext): void {
  const { world, cfg } = ctx;
  const p = { x: 0, y: 0 };
  for (const slot of world.slots) {
    slotPosition(world.formation, slot, p);
    const e = createEnemy(world, cfg, slot.kind, p.x, p.y, { slot });
    setState(e, 'inFormation');
  }
  world.formation.entryQueue = [];
  world.formation.entryComplete = true;
}

export function updateEntry(ctx: SimContext, dtMs: number): void {
  const { world, cfg, paths } = ctx;
  const f = world.formation;
  if (f.entryComplete) return;
  f.entryClockMs += dtMs;
  while (f.entryQueue.length > 0 && f.entryQueue[0]!.atMs <= f.entryClockMs) {
    const spawn = f.entryQueue.shift()!;
    const slot = world.slots.find((s) => s.id === spawn.slotId) as Slot;
    const path = paths.get(spawn.pathKey);
    const e = createEnemy(world, cfg, slot.kind, path.xs[0]!, path.ys[0]!, { slot });
    const fire = world.tuning.entryFire ? [path.length * 0.45] : [];
    e.run = { path, s: 0, speed: world.tuning.entrySpeed, end: 'formUp', fireAt: fire };
    setState(e, 'entering');
  }
  if (f.entryQueue.length === 0 && !world.enemies.some((e) => e.state === 'entering' || e.state === 'formingUp')) {
    f.entryComplete = true;
  }
}
