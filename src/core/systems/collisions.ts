/**
 * Axis-aligned box collision for shots and bodies. Shots test their swept
 * segment (previous -> current position) so fast shots never tunnel.
 */
import { CHALLENGE } from '../../config/difficulty.ts';
import type { Box } from '../../config/engine.ts';
import type { Enemy, Shot } from '../game/types.ts';
import type { SimContext } from './context.ts';
import { damagePlayer, hitEnemy } from './damage.ts';
import { isTargetable } from './enemies.ts';

function overlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): boolean {
  return Math.abs(ax - bx) * 2 < aw + bw && Math.abs(ay - by) * 2 < ah + bh;
}

/** Swept vertical-ish shot vs box: tests the box spanning prev..current. */
function shotHits(s: Shot, box: Box, x: number, y: number, sw: number, sh: number): boolean {
  const cx = (s.x + s.prevX) / 2;
  const cy = (s.y + s.prevY) / 2;
  const h = Math.abs(s.y - s.prevY) + sh;
  const w = Math.abs(s.x - s.prevX) + sw;
  return overlap(cx, cy, w, h, x, y, box.w, box.h);
}

function enemyBox(ctx: SimContext, e: Enemy): Box {
  return ctx.cfg.hitboxes[e.kind];
}

/** Player halves currently collidable: [centreX] for single, [left, right] for dual. */
function playerHalves(ctx: SimContext): { x: number; half: -1 | 1 | 0 }[] {
  const p = ctx.world.player;
  if (p.state !== 'alive') return [];
  if (!p.dual) return [{ x: p.x, half: 0 }];
  const o = ctx.cfg.player.dualHalfOffset;
  return [
    { x: p.x - o, half: -1 },
    { x: p.x + o, half: 1 },
  ];
}

export function resolveCollisions(ctx: SimContext): void {
  const { world, cfg } = ctx;
  const sb = cfg.shots.playerBox;
  // player shots vs enemies (one enemy per shot, nearest along travel = lowest y first)
  const remaining: Shot[] = [];
  for (const s of world.playerShots) {
    let target: Enemy | null = null;
    for (const e of world.enemies) {
      if (!isTargetable(e)) continue;
      if (!shotHits(s, enemyBox(ctx, e), e.x, e.y, sb.w, sb.h)) continue;
      if (!target || e.y > target.y) target = e;
    }
    if (target) hitEnemy(ctx, target);
    else remaining.push(s);
  }
  world.playerShots = remaining;

  const pb = cfg.player.hitbox;
  // enemy shots vs player
  const eb = cfg.shots.enemyBox;
  const keep: Shot[] = [];
  for (const s of world.enemyShots) {
    const hit = playerHalves(ctx).find((h) => shotHits(s, pb, h.x, world.player.y, eb.w, eb.h));
    if (hit) damagePlayer(ctx, hit.half);
    else keep.push(s);
  }
  world.enemyShots = keep;

  // enemy bodies vs player (flying enemies only; challenge collisions configurable)
  if (world.stageKind === 'challenge' && !CHALLENGE.collisions) return;
  for (const e of world.enemies) {
    if (!isTargetable(e) || e.state === 'inFormation') continue;
    const box = enemyBox(ctx, e);
    const hit = playerHalves(ctx).find((h) => overlap(h.x, world.player.y, pb.w, pb.h, e.x, e.y, box.w, box.h));
    if (!hit) continue;
    // a collision destroys the enemy too (scored as a kill, as in the original)
    if (e.kind === 'commander') e.hp = 1;
    hitEnemy(ctx, e);
    damagePlayer(ctx, hit.half);
  }
}
