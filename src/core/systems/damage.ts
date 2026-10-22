/**
 * Damage resolution: enemy hits/destruction (reported to the reward manager
 * as facts, never as scores) and player losses.
 */
import type { EnemyPhase } from '../rewards/types.ts';
import type { Enemy } from '../game/types.ts';
import { onCaptorDestroyed } from './capture.ts';
import type { SimContext } from './context.ts';
import { ANIMATION_TIMING } from '../../config/visual.ts';

/** Enemy phase as the scoring rules see it. */
export function scoringPhase(e: Enemy): EnemyPhase {
  if (e.state === 'inFormation') return 'formation';
  if (e.state === 'entering' || e.state === 'formingUp') return 'entering';
  return 'attacking';
}

function addEffect(ctx: SimContext, kind: 'enemyExplosion' | 'playerExplosion' | 'hitSpark', x: number, y: number): void {
  const dur = kind === 'enemyExplosion' ? ANIMATION_TIMING.explosionFrameMs * 4 : kind === 'playerExplosion' ? ANIMATION_TIMING.explosionFrameMs * 4 * 1.4 : ANIMATION_TIMING.hitSparkFrameMs * 2;
  ctx.world.effects.push({ kind, x, y, ageMs: 0, durationMs: dur });
}

export function updateEffects(ctx: SimContext, dtMs: number): void {
  const fx = ctx.world.effects;
  for (const f of fx) f.ageMs += dtMs;
  ctx.world.effects = fx.filter((f) => f.ageMs < f.durationMs);
}

/** Apply one hit. Commanders take two. Returns true if destroyed. */
export function hitEnemy(ctx: SimContext, e: Enemy): boolean {
  if (e.state === 'destroyed') return false;
  if (e.hp > 1) {
    e.hp -= 1;
    e.hitFlashMs = ANIMATION_TIMING.hitFlashMs * 2;
    addEffect(ctx, 'hitSpark', e.x, e.y);
    ctx.emit({ type: 'enemyHit', id: e.id, x: e.x, y: e.y });
    return false;
  }
  destroyEnemy(ctx, e);
  return true;
}

export function destroyEnemy(ctx: SimContext, e: Enemy): void {
  if (e.state === 'destroyed') return;
  const { world, cfg } = ctx;
  const phase = scoringPhase(e);
  const position = { x: Math.round(e.x), y: Math.round(e.y) };
  const waveOpt = world.stageKind === 'challenge' && e.wave !== undefined ? { wave: e.wave } : {};
  switch (e.kind) {
    case 'scout':
    case 'interceptor':
      ctx.fact({ type: 'enemyDestroyed', enemyId: e.id, kind: e.kind, phase, ...waveOpt, position });
      break;
    case 'commander': {
      const holding = e.captiveId ? world.enemies.find((c) => c.id === e.captiveId)?.fighterId : undefined;
      ctx.fact({
        type: 'enemyDestroyed',
        enemyId: e.id,
        kind: 'commander',
        phase,
        ...waveOpt,
        position,
        ...(phase === 'attacking' ? { escortsAtDiveStart: e.escortsAtDiveStart ?? 0 } : {}),
        ...(holding ? { holdingFighterId: holding } : {}),
      });
      break;
    }
    case 'transform':
      ctx.fact({ type: 'enemyDestroyed', enemyId: e.id, kind: 'transform', transformKind: e.transformKind!, ...(world.stageKind === 'normal' && e.groupId ? { groupId: e.groupId } : {}), phase, ...waveOpt, position });
      break;
    case 'capturedFighter':
      ctx.fact({ type: 'enemyDestroyed', enemyId: e.id, kind: 'capturedFighter', fighterId: e.fighterId!, phase, position });
      // the commander no longer holds it
      for (const c of world.enemies) if (c.captiveId === e.id) c.captiveId = undefined;
      break;
  }
  const preState = e.state;
  const wasFlyingCommander = e.kind === 'commander' && phase === 'attacking';
  const hadBeam = e.beam !== undefined;
  e.state = 'destroyed';
  e.run = null;
  e.beam = undefined;
  if (hadBeam) ctx.emit({ type: 'beamEnded', captorId: e.id, captured: false });
  addEffect(ctx, 'enemyExplosion', e.x, e.y);
  ctx.emit({ type: 'enemyDestroyed', id: e.id, kind: e.kind, x: e.x, y: e.y });
  // rescue eligibility depends on where the captor was when it died
  if (e.kind === 'commander' && e.captiveId) onCaptorDestroyed(ctx, e, preState);
  if (wasFlyingCommander) world.fireHoldUntilMs = world.timeMs + cfg.capture.fireHoldAfterCommanderMs;
  if (world.challenge) world.challenge.resolved += 1;
}

/**
 * The ship in play was hit. A Dual Fighter loses one half (no reserve used);
 * a single fighter is destroyed.
 */
export function damagePlayer(ctx: SimContext, half: -1 | 1 | 0): void {
  const { world, cfg } = ctx;
  const p = world.player;
  if (p.state !== 'alive') return;
  if (p.dual) {
    const o = cfg.player.dualHalfOffset;
    const lost = half === 0 ? 1 : half;
    addEffect(ctx, 'playerExplosion', p.x + lost * o, p.y);
    p.dual = false;
    p.x = Math.min(Math.max(p.x - lost * o, cfg.player.minX), cfg.player.maxX);
    ctx.fact({ type: 'playerFighterDestroyed', dualHalf: true });
    ctx.emit({ type: 'playerDestroyed', x: p.x + lost * o, y: p.y, dualHalf: true });
    return;
  }
  p.lastShipLost = ctx.reserves() === 0;
  p.state = 'exploding';
  p.vx = 0;
  addEffect(ctx, 'playerExplosion', p.x, p.y);
  ctx.fact({ type: 'playerFighterDestroyed', dualHalf: false });
  ctx.emit({ type: 'playerDestroyed', x: p.x, y: p.y, dualHalf: false });
  ctx.onPlayerLost('destroyed');
}
