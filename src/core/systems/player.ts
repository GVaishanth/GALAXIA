/**
 * Player fighter: movement (direct or accelerated), firing, respawn.
 */
import type { InputFrame } from '../game/input.ts';
import type { Player } from '../game/types.ts';
import type { EngineConfig } from '../../config/engine.ts';
import type { SimContext } from './context.ts';
import { clamp } from './paths.ts';
import { firePlayer } from './projectiles.ts';

export function newPlayer(cfg: EngineConfig): Player {
  const x = cfg.world.width / 2;
  return { state: 'gone', x, y: cfg.player.y, prevX: x, prevY: cfg.player.y, vx: 0, dual: false, fighterId: 'f0', fighterSeq: 0, tractorCaptorId: null, lastShipLost: false };
}

/** Put a fresh single fighter at the centre. */
export function spawnPlayer(ctx: SimContext): void {
  const { world, cfg } = ctx;
  const p = world.player;
  p.fighterSeq += 1;
  p.fighterId = `f${p.fighterSeq}`;
  p.state = 'alive';
  p.dual = false;
  p.x = p.prevX = cfg.world.width / 2;
  p.y = p.prevY = cfg.player.y;
  p.vx = 0;
  p.tractorCaptorId = null;
  p.lastShipLost = false;
  // a fresh fighter starts with a cold weapon
  Object.assign(world.heat, { level: 0, overheated: false, heldMs: 0, autoMs: 0 });
}

/**
 * Weapon heat for one tick (TD-74). Holding fire past the grace heats the
 * weapon; releasing it, or being locked, cools it. A full bar locks the
 * weapon until it cools to resumeAt. Returns the heat state (mutated).
 */
export function stepHeat(ctx: SimContext, held: boolean, dtMs: number): void {
  const { world, cfg } = ctx;
  const h = world.heat;
  const c = cfg.heat;
  if (h.overheated) {
    h.heldMs = 0;
    h.level = Math.max(0, h.level - dtMs / c.coolMs);
    if (h.level <= c.resumeAt) {
      h.overheated = false;
      h.autoMs = 0;
      ctx.emit({ type: 'weaponCooled' });
    }
    return;
  }
  if (!held) {
    h.heldMs = 0;
    h.autoMs = 0;
    h.level = Math.max(0, h.level - dtMs / c.coolMs);
    return;
  }
  h.heldMs += dtMs;
  if (h.heldMs > c.graceMs) h.level = Math.min(1, h.level + dtMs / c.riseMs);
  if (h.level >= 1) {
    h.level = 1;
    h.overheated = true;
    h.autoMs = 0;
    ctx.emit({ type: 'weaponOverheated' });
  }
}

export function playerBounds(cfg: EngineConfig, dual: boolean): [number, number] {
  return dual ? [cfg.player.dualMinX, cfg.player.dualMaxX] : [cfg.player.minX, cfg.player.maxX];
}

/**
 * Move and fire. `controllable` is false outside playing/challenge, so input
 * can never move or fire while paused, between stages or after game over.
 */
export function updatePlayer(ctx: SimContext, input: InputFrame, controllable: boolean, dtMs: number): void {
  const { world, cfg } = ctx;
  const p = world.player;
  // heat first: it cools whenever the fighter cannot fire (tractored, exploding, between stages)
  stepHeat(ctx, controllable && p.state === 'alive' && input.fireHeld === true, dtMs);
  if (p.state === 'tractored') return; // driven by capture.ts
  p.prevX = p.x;
  p.prevY = p.y;
  if (p.state !== 'alive') return;
  const dir = controllable ? input.moveX : 0;
  const k = dtMs / 1000;
  if (cfg.player.movement === 'direct') {
    p.vx = dir * cfg.player.speed;
  } else {
    const target = dir * cfg.player.speed;
    const rate = dir !== 0 ? cfg.player.accel : cfg.player.decel;
    const dv = target - p.vx;
    const maxDv = rate * k;
    p.vx += Math.abs(dv) <= maxDv ? dv : Math.sign(dv) * maxDv;
  }
  const [lo, hi] = playerBounds(cfg, p.dual);
  p.x = clamp(p.x + p.vx * k, lo, hi);
  if ((p.x === lo && p.vx < 0) || (p.x === hi && p.vx > 0)) p.vx = 0;
  if (!controllable || world.heat.overheated) return;
  const h = world.heat;
  if (input.fire) {
    // a press fires at once (the original behaviour); a hold continues after autoIntervalMs
    firePlayer(ctx);
    h.autoMs = cfg.heat.autoIntervalMs;
  } else if (input.fireHeld === true) {
    h.autoMs -= dtMs;
    // capped by the shots-on-screen limit: retry next tick until a shot leaves the screen
    if (h.autoMs <= 0) h.autoMs = firePlayer(ctx) > 0 ? cfg.heat.autoIntervalMs : 0;
  }
}
