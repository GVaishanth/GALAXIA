/**
 * Tractor beam, capture and rescue.
 *
 * Beam:    commander dives to a stop above the player row, beam extends,
 *          holds, retracts. A fighter inside the beam while it holds is
 *          tractored (uncollidable, no control) and pulled to the captor.
 * Capture: when the pull completes, the fighter becomes a captive attached
 *          above the commander (fighterCaptured fact, ship in play lost).
 * Rescue:  destroying the captor while it is flying (attacking/returning)
 *          with a single fighter in play frees the captive, which flies
 *          down and docks -> Dual Fighter. Destroying it in formation (or
 *          when rescue is impossible) turns the captive hostile.
 *
 * Guards: one captive at a time; the beam can only grab in 'playing' with a
 * single, alive fighter; each captive resolves exactly once.
 */
import type { Enemy } from '../game/types.ts';
import { createEnemy, setState, type SimContext } from './context.ts';
import { startReturnFromTop, startReturnToSlot } from './enemies.ts';
import { captiveSlot } from './formation.ts';
import { buildPath, clamp, line, type Pt } from './paths.ts';

export function activeCaptive(ctx: SimContext): Enemy | undefined {
  return ctx.world.enemies.find((e) => e.kind === 'capturedFighter' && e.state !== 'destroyed');
}

/** Tractor beam trigger conditions. */
export function canBeam(ctx: SimContext): boolean {
  const { world, cfg } = ctx;
  return (
    cfg.capture.enabled &&
    world.stage >= cfg.capture.minStage &&
    world.stageKind === 'normal' &&
    ctx.phase === 'playing' &&
    world.player.state === 'alive' &&
    !world.player.dual &&
    !activeCaptive(ctx) &&
    world.pendingRebound === null &&
    !world.enemies.some((e) => e.beam || (e.run && e.run.end === 'beam'))
  );
}

function captorOf(ctx: SimContext, captive: Enemy): Enemy | undefined {
  return ctx.world.enemies.find((e) => e.id === captive.captorId && e.state !== 'destroyed');
}

/** Beam lifecycle for commanders that reached their beam point. */
export function updateBeams(ctx: SimContext, dtMs: number): void {
  const { world, cfg } = ctx;
  const c = cfg.capture;
  for (const e of world.enemies) {
    if (e.state === 'destroyed' || e.kind !== 'commander') continue;
    if (!e.beam && e.run && e.run.end === 'beam' && e.run.s >= e.run.path.length) {
      e.run = null;
      e.dirX = 0;
      e.dirY = 1;
      const maxLength = world.player.y + 14 - (e.y + 12);
      e.beam = { phase: 'extending', t: 0, length: 0, maxLength, grabbed: false };
      ctx.emit({ type: 'beamStarted', captorId: e.id });
      continue;
    }
    const b = e.beam;
    if (!b) continue;
    b.t += dtMs;
    if (b.phase === 'extending') {
      b.length = (b.maxLength * Math.min(b.t, c.extendMs)) / c.extendMs;
      if (b.t >= c.extendMs) {
        b.phase = 'holding';
        b.t = 0;
      }
    } else if (b.phase === 'holding') {
      b.length = b.maxLength;
      const p = world.player;
      if (!b.grabbed && ctx.phase === 'playing' && p.state === 'alive' && !p.dual && !activeCaptive(ctx) && Math.abs(p.x - e.x) <= c.captureHalfWidth) {
        b.grabbed = true;
        p.state = 'tractored';
        p.tractorCaptorId = e.id;
        p.vx = 0;
        ctx.emit({ type: 'fighterTractored', captorId: e.id });
      }
      // a grabbing beam holds until the pull completes (completeCapture switches to retracting)
      if (!b.grabbed && b.t >= c.holdMs) {
        b.phase = 'retracting';
        b.t = 0;
      }
    } else {
      b.length = b.maxLength * Math.max(0, 1 - b.t / c.retractMs);
      if (b.t >= c.retractMs) {
        const captured = b.grabbed;
        e.beam = undefined;
        ctx.emit({ type: 'beamEnded', captorId: e.id, captured });
        if (captured) startReturnToSlot(ctx, e);
        else {
          // missed: continue the dive off the bottom, then return from the top
          const from: Pt = [e.x, e.y];
          e.run = { path: buildPath(line(from, [e.x, cfg.world.height + 40])), s: 0, speed: world.tuning.diveSpeed, end: 'exitThenReturn', fireAt: [] };
          setState(e, 'attacking');
        }
      }
    }
  }
}

/** Pull a tractored fighter up to its captor; release it if the captor is gone. */
export function updateTractor(ctx: SimContext, dtMs: number): void {
  const { world, cfg } = ctx;
  const p = world.player;
  if (p.state !== 'tractored') return;
  p.prevX = p.x;
  p.prevY = p.y;
  const captor = world.enemies.find((e) => e.id === p.tractorCaptorId && e.state !== 'destroyed');
  if (!captor) {
    // captor destroyed during the pull: the fighter is released and drops back
    p.y = Math.min(cfg.player.y, p.y + (cfg.capture.pullSpeed * 3 * dtMs) / 1000);
    if (p.y >= cfg.player.y) {
      p.y = cfg.player.y;
      p.state = 'alive';
      p.tractorCaptorId = null;
    }
    return;
  }
  const tx = captor.x;
  const ty = captor.y + cfg.capture.captiveOffsetY;
  const step = (cfg.capture.pullSpeed * dtMs) / 1000;
  const dx = tx - p.x;
  const dy = ty - p.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= step) completeCapture(ctx, captor);
  else {
    p.x += (dx / d) * step;
    p.y += (dy / d) * step;
  }
}

function completeCapture(ctx: SimContext, captor: Enemy): void {
  const { world, cfg } = ctx;
  const p = world.player;
  const fighterId = p.fighterId;
  const lastShip = ctx.reserves() === 0;
  const captive = createEnemy(world, cfg, 'capturedFighter', captor.x, captor.y + cfg.capture.captiveOffsetY, {
    fighterId,
    captorId: captor.id,
    captiveMode: 'attached',
    slot: captor.slot ? captiveSlot(captor.slot, cfg.capture.captiveOffsetY) : null,
    state: 'attacking',
  });
  captor.captiveId = captive.id;
  if (captor.beam) {
    captor.beam.phase = 'retracting';
    captor.beam.t = 0;
  }
  p.state = 'gone';
  p.tractorCaptorId = null;
  p.lastShipLost = lastShip;
  ctx.fact({ type: 'fighterCaptured', fighterId, captorId: captor.id });
  ctx.emit({ type: 'fighterCaptured', fighterId, captorId: captor.id });
  ctx.onPlayerLost('captured');
}

/** Attached captives follow their captor; freed captives fly down and dock. */
export function updateCaptives(ctx: SimContext, dtMs: number): void {
  const { world, cfg } = ctx;
  const p = world.player;
  for (const e of world.enemies) {
    if (e.kind !== 'capturedFighter' || e.state === 'destroyed') continue;
    if (e.captiveMode === 'attached') {
      const captor = captorOf(ctx, e);
      if (!captor) continue; // resolved by onCaptorDestroyed
      e.x = captor.x;
      e.y = captor.y + cfg.capture.captiveOffsetY;
      e.dirX = captor.dirX;
      e.dirY = captor.dirY;
      const st = captor.state === 'inFormation' ? 'inFormation' : captor.state === 'formingUp' ? 'formingUp' : 'attacking';
      if (e.state !== st) setState(e, st);
    } else if (e.captiveMode === 'freed') {
      if (p.state !== 'alive') {
        // the player was lost before docking: the freed fighter is lost too
        e.state = 'destroyed';
        ctx.fact({ type: 'captiveLost', fighterId: e.fighterId!, reason: 'player-lost-before-docking' });
        continue;
      }
      if (e.stateMs < cfg.capture.freedHoverMs) continue;
      const o = cfg.player.dualHalfOffset;
      // dock beside the player; if the pair would leave the field, the pair centre is clamped
      const right = p.x + 2 * o <= cfg.player.maxX;
      const tx = right ? p.x + 2 * o : p.x - 2 * o;
      const ty = p.y;
      const step = (cfg.capture.dockSpeed * dtMs) / 1000;
      const dx = tx - e.x;
      const dy = ty - e.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= step) {
        e.state = 'destroyed';
        p.dual = true;
        p.x = clamp(right ? p.x + o : p.x - o, cfg.player.dualMinX, cfg.player.dualMaxX);
        ctx.fact({ type: 'captiveDocked', fighterId: e.fighterId! });
        ctx.emit({ type: 'dualFighterFormed', fighterId: e.fighterId! });
      } else {
        e.x += (dx / d) * step;
        e.y += (dy / d) * step;
        e.dirX = 0;
        e.dirY = -1;
      }
    }
  }
}

/** Called when a commander holding a captive is destroyed. Resolves the captive exactly once. */
export function onCaptorDestroyed(ctx: SimContext, captor: Enemy, captorState: Enemy['state']): void {
  const captive = ctx.world.enemies.find((e) => e.id === captor.captiveId && e.state !== 'destroyed');
  captor.captiveId = undefined;
  if (!captive || captive.captiveMode !== 'attached') return;
  const p = ctx.world.player;
  const flying = captorState === 'attacking' || captorState === 'returning';
  const rescuable = flying && ctx.phase === 'playing' && p.state === 'alive' && !p.dual;
  const fighterId = captive.fighterId!;
  if (rescuable) {
    captive.captiveMode = 'freed';
    captive.run = null;
    setState(captive, 'attacking');
    captive.stateMs = 0;
    ctx.fact({ type: 'captiveFreed', fighterId, captorId: captor.id });
    ctx.emit({ type: 'captiveFreed', fighterId });
    return;
  }
  // Deviation (documented): when rescue is impossible mid-flight, the captive also turns hostile.
  captive.captiveMode = 'hostile';
  captive.captorId = undefined;
  ctx.fact({ type: 'captiveTurnedHostile', fighterId, captorId: captor.id });
  ctx.emit({ type: 'captiveHostile', fighterId, x: captive.x, y: captive.y });
  if (captorState === 'inFormation') setState(captive, 'inFormation');
  else if (captive.y > ctx.cfg.world.height * 0.6) startReturnFromTop(ctx, captive);
  else startReturnToSlot(ctx, captive);
}

/** Re-attach an escaped hostile captive to a commander (next normal stage, once the formation is complete). */
export function tryRebound(ctx: SimContext): void {
  const { world, cfg } = ctx;
  if (world.pendingRebound === null || world.stageKind !== 'normal' || !world.formation.entryComplete) return;
  const captor = world.enemies.find((e) => e.kind === 'commander' && e.state === 'inFormation' && !e.captiveId && !e.beam);
  if (!captor) return;
  const fighterId = world.pendingRebound;
  world.pendingRebound = null;
  const captive = createEnemy(world, cfg, 'capturedFighter', captor.x, captor.y + cfg.capture.captiveOffsetY, {
    fighterId,
    captorId: captor.id,
    captiveMode: 'attached',
    slot: captor.slot ? captiveSlot(captor.slot, cfg.capture.captiveOffsetY) : null,
    state: 'inFormation',
  });
  captor.captiveId = captive.id;
  ctx.fact({ type: 'captiveRebound', fighterId, captorId: captor.id });
}
