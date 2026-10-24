/**
 * Classic time zones (Combat P03C, FR-TD-89): the local slow-down a nuke
 * leaves. Read by the enemy path and enemy shot updates; no zone (the legacy
 * fighter, or none open) = scale 1, so the original game is untouched.
 */
import type { World } from '../game/types.ts';

/** Simulation scale at (x, y): the slowest open zone containing the point (zones never stack). */
export function zoneScale(world: World, x: number, y: number): number {
  const o = world.ordnance;
  if (!o || o.zones.length === 0) return 1;
  let s = 1;
  for (const z of o.zones) {
    if (z.msLeft <= 0) continue;
    const dx = x - z.x;
    const dy = y - z.y;
    if (dx * dx + dy * dy <= z.r * z.r && z.scale < s) s = z.scale;
  }
  return s;
}
