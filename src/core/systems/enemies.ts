/**
 * Enemy state machine. Every movement is scripted: a path run (entry, dive,
 * return, challenge flight) or a slot chase (forming up / in formation).
 *
 *   entering --path end--> formingUp --arrived--> inFormation
 *   inFormation --attack launch--> attacking
 *   attacking --exit bottom--> returning (re-enter at top) --> formingUp
 *   attacking --loop back--> returning --> formingUp
 *   attacking / entering (challenge) --> leaving --> removed
 *   any --hit (hp 0)--> destroyed --> removed
 */
import type { Enemy } from '../game/types.ts';
import { setState, type SimContext } from './context.ts';
import { slotPosition } from './formation.ts';
import { buildPath, chain, line, pointAt, type Pt, type Vec } from './paths.ts';
import { spawnEnemyShot } from './projectiles.ts';
import { zoneScale } from './timeZones.ts';

const tmp: Vec = { x: 0, y: 0 };
const dir: Vec = { x: 0, y: 1 };

/** Enemies inside the world that can collide / be shot. */
export function isTargetable(e: Enemy): boolean {
  if (e.state === 'destroyed') return false;
  if (e.kind === 'capturedFighter' && e.captiveMode === 'freed') return false;
  return true;
}

export function isAttacker(e: Enemy): boolean {
  return e.state === 'attacking' || e.state === 'returning' || e.state === 'leaving';
}

/** Build a return path from the top edge down towards the slot. */
export function startReturnFromTop(ctx: SimContext, e: Enemy): void {
  if (!e.slot) {
    setState(e, 'leaving');
    e.run = null;
    return;
  }
  slotPosition(ctx.world.formation, e.slot, tmp);
  const from: Pt = [tmp.x, -24];
  e.x = e.prevX = from[0];
  e.y = e.prevY = from[1];
  const to: Pt = [tmp.x, tmp.y - 20];
  e.run = { path: buildPath(line(from, to)), s: 0, speed: ctx.world.tuning.returnSpeed, end: 'formUp', fireAt: [] };
  setState(e, 'returning');
}

/** Curve from the current position back up to the slot. */
export function startReturnToSlot(ctx: SimContext, e: Enemy): void {
  if (!e.slot) {
    setState(e, 'leaving');
    e.run = null;
    return;
  }
  slotPosition(ctx.world.formation, e.slot, tmp);
  const a: Pt = [e.x, e.y];
  const b: Pt = [tmp.x, tmp.y];
  const pts: Pt[] = [a, [a[0], a[1] - 60], [b[0], b[1] + 90], b];
  e.run = { path: buildPath(pts), s: 0, speed: ctx.world.tuning.returnSpeed, end: 'formUp', fireAt: [] };
  setState(e, 'returning');
}

/** Advance one enemy along its scripted run; returns true when the run finished this tick. */
function advanceRun(ctx: SimContext, e: Enemy, dtMs: number): boolean {
  const run = e.run!;
  // Combat P03C: inside a nuke's time zone an enemy on a flight path runs at the zone's scale (no zone = 1)
  run.s += (run.speed * dtMs * zoneScale(ctx.world, e.x, e.y)) / 1000;
  pointAt(run.path, run.s, tmp, dir);
  e.x = tmp.x;
  e.y = tmp.y;
  e.dirX = dir.x;
  e.dirY = dir.y;
  while (run.fireAt.length > 0 && run.s >= run.fireAt[0]!) {
    run.fireAt.shift();
    tryEnemyFire(ctx, e);
  }
  return run.s >= run.path.length;
}

export function tryEnemyFire(ctx: SimContext, e: Enemy): void {
  const { world, cfg } = ctx;
  if (world.stageKind !== 'normal') return;
  if (ctx.phase !== 'playing') return;
  if (world.timeMs < world.fireHoldUntilMs) return;
  if (world.player.state !== 'alive') return;
  if (world.enemyShots.length >= world.tuning.maxEnemyShots) return;
  if (world.player.y - e.y < cfg.shots.enemyMinFireGap) return;
  spawnEnemyShot(ctx, e.x, e.y + 8);
}

function onRunEnd(ctx: SimContext, e: Enemy): void {
  const end = e.run!.end;
  switch (end) {
    case 'formUp':
      e.run = null;
      setState(e, 'formingUp');
      break;
    case 'exitThenReturn':
      startReturnFromTop(ctx, e);
      break;
    case 'returnToSlot':
      startReturnToSlot(ctx, e);
      break;
    case 'leave':
      e.run = null;
      setState(e, 'leaving');
      break;
    case 'beam':
    case 'split':
      // handled by capture / attacks systems (they poll run end)
      break;
  }
}

/** Update all non-captive enemies. Captives attached to / freed from a commander are driven by capture.ts. */
export function updateEnemies(ctx: SimContext, dtMs: number): void {
  const { world, cfg } = ctx;
  const step = (cfg.formingUpSpeed * dtMs) / 1000;
  for (const e of world.enemies) {
    if (e.state === 'destroyed') continue;
    e.prevX = e.x;
    e.prevY = e.y;
    e.stateMs += dtMs;
    if (e.hitFlashMs > 0) e.hitFlashMs = Math.max(0, e.hitFlashMs - dtMs);
    if (e.kind === 'capturedFighter' && e.captiveMode !== 'hostile') continue;
    if (e.beam) continue; // beaming commander holds position

    if (e.run) {
      const done = advanceRun(ctx, e, dtMs);
      if (done && e.run.end !== 'beam' && e.run.end !== 'split') onRunEnd(ctx, e);
      continue;
    }
    switch (e.state) {
      case 'formingUp': {
        if (!e.slot) {
          setState(e, 'leaving');
          break;
        }
        slotPosition(world.formation, e.slot, tmp);
        const dx = tmp.x - e.x;
        const dy = tmp.y - e.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= step || d === 0) {
          e.x = tmp.x;
          e.y = tmp.y;
          e.dirX = 0;
          e.dirY = 1;
          setState(e, 'inFormation');
          ctx.emit({ type: 'enemyArrived', id: e.id, kind: e.kind, x: e.x, y: e.y });
        } else {
          e.x += (dx / d) * step;
          e.y += (dy / d) * step;
          e.dirX = dx / d;
          e.dirY = dy / d;
        }
        break;
      }
      case 'inFormation':
        if (e.slot) {
          slotPosition(world.formation, e.slot, tmp);
          e.x = tmp.x;
          e.y = tmp.y;
        }
        e.dirX = 0;
        e.dirY = 1;
        break;
      case 'leaving':
        // fly straight on along the last heading until off screen
        e.x += (e.dirX * world.tuning.diveSpeed * dtMs) / 1000;
        e.y += (Math.max(e.dirY, 0.3) * world.tuning.diveSpeed * dtMs) / 1000;
        break;
      default:
        break;
    }
  }
}

/** Off the playfield (beyond a margin). */
export function isOffscreen(cfgWidth: number, cfgHeight: number, e: Enemy): boolean {
  const m = 40;
  return e.x < -m || e.x > cfgWidth + m || e.y < -m - 40 || e.y > cfgHeight + m;
}

/** Remove destroyed enemies and leavers that have flown off; returns removed leavers. */
export function sweepEnemies(ctx: SimContext): Enemy[] {
  const { world, cfg } = ctx;
  const gone: Enemy[] = [];
  world.enemies = world.enemies.filter((e) => {
    if (e.state === 'destroyed') return false;
    if (e.state === 'leaving' && isOffscreen(cfg.world.width, cfg.world.height, e)) {
      gone.push(e);
      return false;
    }
    return true;
  });
  return gone;
}

export { chain, line };
