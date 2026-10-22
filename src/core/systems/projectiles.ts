/**
 * Player and enemy projectiles: spawning (with caps), movement, culling.
 * No pooling: at most 4 player + 9 enemy shots exist at once, so plain
 * arrays are cheaper to reason about than a pool (TD-26).
 */
import type { Shot, World } from '../game/types.ts';
import type { SimContext } from './context.ts';

function makeShot(world: World, x: number, y: number, vx: number, vy: number): Shot {
  world.nextId += 1;
  return { id: world.nextId, x, y, prevX: x, prevY: y, vx, vy };
}

/** Player fire. Single: one shot, max 2 on screen. Dual: a pair, max 4 (2 pairs). Returns shots spawned. */
export function firePlayer(ctx: SimContext): number {
  const { world, cfg } = ctx;
  const p = world.player;
  const y = p.y + cfg.shots.spawnOffsetY;
  const v = -cfg.shots.playerSpeed;
  if (p.dual) {
    if (world.playerShots.length > cfg.shots.maxDual - 2) return 0;
    const o = cfg.player.dualHalfOffset;
    world.playerShots.push(makeShot(world, p.x - o, y, 0, v), makeShot(world, p.x + o, y, 0, v));
    ctx.emit({ type: 'playerShot', x: p.x, y });
    return 2;
  }
  if (world.playerShots.length >= cfg.shots.maxSingle) return 0;
  world.playerShots.push(makeShot(world, p.x, y, 0, v));
  ctx.emit({ type: 'playerShot', x: p.x, y });
  return 1;
}

/** Aimed enemy shot: heads towards the player's current x, with a capped slope. */
export function spawnEnemyShot(ctx: SimContext, x: number, y: number): void {
  const { world, cfg } = ctx;
  const speed = world.tuning.enemyShotSpeed;
  const dy = Math.max(world.player.y - y, 1);
  const dx = world.player.x - x;
  const maxVx = speed * cfg.shots.enemyMaxSlope;
  let vx = (dx * speed) / dy;
  if (vx > maxVx) vx = maxVx;
  if (vx < -maxVx) vx = -maxVx;
  world.enemyShots.push(makeShot(world, x, y, vx, speed));
  ctx.emit({ type: 'enemyShot', x, y });
}

export function updateProjectiles(ctx: SimContext, dtMs: number): void {
  const { world, cfg } = ctx;
  const k = dtMs / 1000;
  const keep = (s: Shot): boolean => s.y > -20 && s.y < cfg.world.height + 20 && s.x > -20 && s.x < cfg.world.width + 20;
  for (const s of world.playerShots) {
    s.prevX = s.x;
    s.prevY = s.y;
    s.x += s.vx * k;
    s.y += s.vy * k;
  }
  for (const s of world.enemyShots) {
    s.prevX = s.x;
    s.prevY = s.y;
    s.x += s.vx * k;
    s.y += s.vy * k;
  }
  world.playerShots = world.playerShots.filter(keep);
  world.enemyShots = world.enemyShots.filter(keep);
}
