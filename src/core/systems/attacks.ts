/**
 * Attack scheduler and scripted dive patterns. Which pattern launches, and
 * which enemy flies it, comes from the seeded RNG; the flight itself is a
 * deterministic Bézier script (no per-enemy random steering).
 */
import { ATTACK_PATTERNS, TRANSFORMS, transformKindForStage, type AttackPatternId } from '../../config/difficulty.ts';
import type { Enemy } from '../game/types.ts';
import { canBeam } from './capture.ts';
import { createEnemy, newId, setState, type SimContext } from './context.ts';
import { isAttacker } from './enemies.ts';
import { buildPath, chain, clamp, translatePoints, type Pt } from './paths.ts';

export type DiveVariant = 'exit' | 'loopBack' | 'beam' | 'split' | 'escape';

const ESCORT_OFFSETS: readonly Pt[] = [
  [-24, 22],
  [24, 22],
];

const idle = (e: Enemy): boolean => e.state === 'inFormation' && !e.beam && !e.run;

/** Normal-stage enemies that are not captives held by a commander. */
function combatants(ctx: SimContext): Enemy[] {
  return ctx.world.enemies.filter((e) => e.state !== 'destroyed' && !(e.kind === 'capturedFighter' && e.captiveMode !== 'hostile'));
}

export function attackersInFlight(ctx: SimContext): number {
  return combatants(ctx).filter(isAttacker).length;
}

function budget(ctx: SimContext): number {
  const alive = combatants(ctx).length;
  if (alive <= ctx.world.tuning.lowCountThreshold) return alive;
  return ctx.world.tuning.maxAttackers - attackersInFlight(ctx);
}

/** Whether the scheduler may launch anything this tick. */
export function canLaunchAttacks(ctx: SimContext): boolean {
  const { world } = ctx;
  return (
    world.stageKind === 'normal' &&
    ctx.phase === 'playing' &&
    world.formation.entryComplete &&
    world.player.state === 'alive' &&
    !world.enemies.some((e) => e.beam) &&
    !world.enemies.some((e) => e.kind === 'capturedFighter' && e.captiveMode === 'freed')
  );
}

function candidates(ctx: SimContext, id: AttackPatternId): Enemy[] {
  const all = ctx.world.enemies.filter(idle);
  switch (id) {
    case 'scoutSolo':
    case 'scoutPair':
    case 'transform':
      return all.filter((e) => e.kind === 'scout');
    case 'interceptorSolo':
      return all.filter((e) => e.kind === 'interceptor');
    case 'commanderEscort':
      return all.filter((e) => e.kind === 'commander');
    case 'commanderBeam':
      return all.filter((e) => e.kind === 'commander' && !e.captiveId);
    case 'hostileCaptive':
      return all.filter((e) => e.kind === 'capturedFighter' && e.captiveMode === 'hostile');
  }
}

function patternAvailable(ctx: SimContext, id: AttackPatternId, room: number): boolean {
  const { world } = ctx;
  if (room < 1) return false;
  if (candidates(ctx, id).length === 0) return false;
  if (id === 'scoutPair') return room >= 2 && pairFor(ctx) !== null;
  if (id === 'commanderBeam') return canBeam(ctx);
  if (id === 'transform') return transformKindForStage(world.stage) !== null && world.transformsLaunched < TRANSFORMS.perStage;
  return true;
}

function pairFor(ctx: SimContext): [Enemy, Enemy] | null {
  const scouts = candidates(ctx, 'scoutPair');
  for (const a of scouts) {
    const b = scouts.find((s) => s !== a && s.slot!.row === a.slot!.row && s.slot!.col === a.slot!.col + 1);
    if (b) return [a, b];
  }
  return null;
}

export function pickPattern(ctx: SimContext): AttackPatternId | null {
  const { world } = ctx;
  const room = budget(ctx);
  const options = ATTACK_PATTERNS.filter((p) => p.minStage <= world.stage && patternAvailable(ctx, p.id, room));
  if (options.length === 0) return null;
  const total = options.reduce((t, p) => t + p.weight, 0);
  let r = world.rng.next() * total;
  for (const p of options) {
    r -= p.weight;
    if (r < 0) return p.id;
  }
  return options[options.length - 1]!.id;
}

function nextInterval(ctx: SimContext): number {
  const { world } = ctx;
  const jitter = 0.25;
  let base = world.tuning.attackIntervalMs;
  if (combatants(ctx).length <= world.tuning.lowCountThreshold) base *= 0.4;
  return base * (1 + (world.rng.next() * 2 - 1) * jitter);
}

export function updateAttackScheduler(ctx: SimContext, dtMs: number): void {
  if (!canLaunchAttacks(ctx)) return;
  ctx.world.attackTimerMs -= dtMs;
  if (ctx.world.attackTimerMs > 0) return;
  const id = pickPattern(ctx);
  if (id) launchPattern(ctx, id);
  ctx.world.attackTimerMs = nextInterval(ctx);
}

/* ------------------------------- dive scripts ------------------------------ */

/** Clamp control points horizontally: a Bezier curve stays inside its control hull, so the flight does too. */
export function clampPointsX(points: readonly Pt[], minX: number, maxX: number): Pt[] {
  return points.map(([x, y]): Pt => [Math.min(Math.max(x, minX), maxX), y]);
}

/** Horizontal flight limits for attack scripts (ENGINE.diveMarginX inside each edge). */
function diveLimits(ctx: SimContext): [number, number] {
  return [ctx.cfg.diveMarginX, ctx.cfg.world.width - ctx.cfg.diveMarginX];
}

/** Dive control points, clamped horizontally to [minX, maxX]. */
export function divePoints(sx: number, sy: number, side: number, tx: number, variant: DiveVariant, beamY = 300, minX = Number.NEGATIVE_INFINITY, maxX = Number.POSITIVE_INFINITY): Pt[] {
  return clampPointsX(rawDivePoints(sx, sy, side, tx, variant, beamY), minX, maxX);
}

function rawDivePoints(sx: number, sy: number, side: number, tx: number, variant: DiveVariant, beamY: number): Pt[] {
  const p1: Pt = [sx + side * 52, sy + 6];
  const loop: Pt[] = [[sx, sy], [sx + side * 6, sy - 40], [sx + side * 52, sy - 40], p1];
  if (variant === 'beam') return chain(loop, [p1, [p1[0], p1[1] + 90], [tx, beamY - 90], [tx, beamY]]);
  if (variant === 'split') return chain(loop, [p1, [p1[0], p1[1] + 40], [p1[0] - side * 12, p1[1] + 70], [p1[0] - side * 12, p1[1] + 96]]);
  const p2: Pt = [tx, 440];
  const swoop: Pt[] = [p1, [p1[0], p1[1] + 120], [tx + side * 60, 360], p2];
  if (variant === 'loopBack') return chain(loop, swoop, [p2, [tx - side * 20, 520], [tx - side * 110, 520], [tx - side * 110, 420]]);
  return chain(loop, swoop, [p2, [tx - side * 30, 500], [tx - side * 50, 560], [tx - side * 50, 640]]);
}

function fireFractions(n: number): number[] {
  return [0.35, 0.5, 0.62].slice(0, Math.max(0, n));
}

function targetX(ctx: SimContext): number {
  const { world, cfg } = ctx;
  return clamp(world.player.x + world.rng.range(-40, 40), 24, cfg.world.width - 24);
}

function startRun(_ctx: SimContext, e: Enemy, pts: Pt[], end: NonNullable<Enemy['run']>['end'], speed: number, shots: number): void {
  const path = buildPath(pts);
  e.run = { path, s: 0, speed, end, fireAt: fireFractions(shots).map((f) => f * path.length) };
  setState(e, 'attacking');
}

const sideOf = (ctx: SimContext, e: Enemy): number => (e.x < ctx.cfg.world.width / 2 ? -1 : 1);

export function launchDive(ctx: SimContext, e: Enemy, variant: DiveVariant = 'exit', tx = targetX(ctx)): Pt[] {
  const { world, cfg } = ctx;
  const beamY = world.player.y - cfg.capture.beamStopAbove;
  const pts = divePoints(e.x, e.y, sideOf(ctx, e), tx, variant, beamY, ...diveLimits(ctx));
  const end = variant === 'beam' ? 'beam' : variant === 'split' ? 'split' : variant === 'loopBack' ? 'returnToSlot' : variant === 'escape' ? 'leave' : 'exitThenReturn';
  const shots = variant === 'beam' || variant === 'split' ? 0 : world.tuning.shotsPerDive;
  startRun(ctx, e, pts, end, world.tuning.diveSpeed, shots);
  return pts;
}

function pick<T>(ctx: SimContext, list: readonly T[]): T {
  return list[ctx.world.rng.int(0, list.length - 1)]!;
}

/** Launch an attack pattern. Returns the ids that launched (empty if none). Also used by debug/tests. */
export function launchPattern(ctx: SimContext, id: AttackPatternId, forced?: Enemy): string[] {
  const { world } = ctx;
  const list = candidates(ctx, id);
  if (list.length === 0 && !forced) return [];
  const ids: string[] = [];
  switch (id) {
    case 'scoutSolo':
    case 'hostileCaptive': {
      const e = forced ?? pick(ctx, list);
      launchDive(ctx, e, id === 'hostileCaptive' ? 'escape' : 'exit');
      ids.push(e.id);
      break;
    }
    case 'interceptorSolo': {
      const e = forced ?? pick(ctx, list);
      launchDive(ctx, e, world.rng.next() < 0.5 ? 'loopBack' : 'exit');
      ids.push(e.id);
      break;
    }
    case 'scoutPair': {
      const pair = pairFor(ctx);
      if (!pair) return [];
      const tx = targetX(ctx);
      launchDive(ctx, pair[0], 'exit', tx - 14);
      launchDive(ctx, pair[1], 'exit', tx + 14);
      ids.push(pair[0].id, pair[1].id);
      break;
    }
    case 'commanderEscort': {
      const leader = forced ?? pick(ctx, list);
      const pts = launchDive(ctx, leader, 'exit');
      ids.push(leader.id);
      const room = Math.max(0, budget(ctx));
      const escorts = escortsFor(ctx, leader).slice(0, Math.min(2, room));
      escorts.forEach((esc, i) => {
        const off = ESCORT_OFFSETS[esc.x < leader.x ? 0 : 1] ?? ESCORT_OFFSETS[i]!;
        const lead: Pt = [pts[0]![0] + off[0], pts[0]![1] + off[1]];
        const joinLeg: Pt[] = [[esc.x, esc.y], [esc.x, esc.y], lead, lead];
        startRun(ctx, esc, clampPointsX(chain(joinLeg, translatePoints(pts, off[0], off[1])), ...diveLimits(ctx)), 'exitThenReturn', world.tuning.diveSpeed, Math.min(1, world.tuning.shotsPerDive));
        esc.leaderId = leader.id;
        ids.push(esc.id);
      });
      leader.escortsAtDiveStart = escorts.length;
      break;
    }
    case 'commanderBeam': {
      const e = forced ?? pick(ctx, list);
      if (!canBeam(ctx)) return [];
      launchDive(ctx, e, 'beam', clamp(world.player.x, 40, ctx.cfg.world.width - 40));
      e.escortsAtDiveStart = 0;
      ids.push(e.id);
      break;
    }
    case 'transform': {
      if (transformKindForStage(world.stage) === null || world.transformsLaunched >= TRANSFORMS.perStage) return [];
      const e = forced ?? pick(ctx, list);
      launchDive(ctx, e, 'split');
      world.transformsLaunched += 1;
      ids.push(e.id);
      break;
    }
  }
  if (ids.length > 0) ctx.emit({ type: 'attackLaunched', pattern: id, ids });
  return ids;
}

/** Interceptors next to a commander (up to 2), nearest first. */
export function escortsFor(ctx: SimContext, leader: Enemy): Enemy[] {
  if (!leader.slot) return [];
  const col = leader.slot.col;
  return ctx.world.enemies
    .filter((e) => e.kind === 'interceptor' && idle(e) && e.slot && e.slot.row === 1 && Math.abs(e.slot.col - col) <= 1)
    .sort((a, b) => Math.abs(a.slot!.col - col) - Math.abs(b.slot!.col - col) || a.slot!.col - b.slot!.col)
    .slice(0, 2);
}

/* -------------------------------- transforms ------------------------------- */

/** Replace scouts that finished a 'split' run with a trio of transform enemies. */
export function updateTransforms(ctx: SimContext): void {
  const { world, cfg } = ctx;
  const kind = transformKindForStage(world.stage);
  for (const e of [...world.enemies]) {
    if (e.state === 'destroyed' || !e.run || e.run.end !== 'split' || e.run.s < e.run.path.length) continue;
    // the scout morphs (removed without score), three transforms appear
    e.state = 'destroyed';
    e.run = null;
    if (!kind) continue;
    const groupId = newId(world, 'tg');
    const s = e.x < cfg.world.width / 2 ? 1 : -1;
    const x0 = e.x;
    const y0 = e.y;
    const cx = (v: number): number => clamp(v, 20, cfg.world.width - 20);
    const base: Pt[] = [
      [x0, y0], [cx(x0 + s * 100), y0 + 60], [cx(x0 + s * 150), y0 + 200], [cx(x0 + s * 40), 420],
      [cx(x0 - s * 20), 500], [cx(x0 - s * 40), 560], [cx(x0 - s * 40), 640],
    ];
    const offsets: Pt[] = [[0, 0], [-24, -16], [24, -16]];
    const ids: string[] = [];
    for (const [dx, dy] of offsets) {
      const pts = clampPointsX(translatePoints(base, dx, dy), ...diveLimits(ctx));
      const t = createEnemy(world, cfg, 'transform', pts[0]![0], pts[0]![1], { transformKind: kind, groupId });
      const path = buildPath(pts);
      t.run = { path, s: 0, speed: TRANSFORMS.speed, end: 'leave', fireAt: world.tuning.shotsPerDive > 0 ? [path.length * 0.4] : [] };
      setState(t, 'attacking');
      ids.push(t.id);
    }
    ctx.emit({ type: 'transformSplit', x: x0, y: y0, ids });
  }
}
