/**
 * Challenging Stage: 5 waves x 8 enemies on scripted paths (first 4 fly the
 * path, last 4 its mirror). Enemies do not fire and never join a formation;
 * every target is either destroyed or leaves. The stage ends when all 40
 * are resolved.
 */
import { CHALLENGE, CHALLENGE_SETS } from '../../config/difficulty.ts';
import { challengeNumber } from '../../config/stages.ts';
import type { ChallengeState } from '../game/types.ts';
import { createEnemy, setState, type SimContext } from './context.ts';

export function buildChallenge(stage: number, schedule?: Parameters<typeof challengeNumber>[1]): ChallengeState {
  const n = challengeNumber(stage, schedule) ?? 1;
  const set = CHALLENGE_SETS[(n - 1) % CHALLENGE_SETS.length]!;
  const queue: ChallengeState['queue'] = [];
  set.forEach((wave, w) => {
    wave.kinds.forEach((kind, i) => {
      const mirrored = i >= 4;
      queue.push({ atMs: wave.atMs + (i % 4) * CHALLENGE.stringSpacingMs + (mirrored ? CHALLENGE.stringSpacingMs / 2 : 0), kind, pathKey: `challenge:${wave.path}${mirrored ? ':m' : ''}`, wave: w });
    });
  });
  queue.sort((a, b) => a.atMs - b.atMs);
  return { clockMs: 0, queue, spawned: 0, resolved: 0, total: queue.length, ended: false };
}

export function updateChallenge(ctx: SimContext, dtMs: number): void {
  const { world, cfg, paths } = ctx;
  const ch = world.challenge;
  if (!ch || ch.ended) return;
  ch.clockMs += dtMs;
  while (ch.queue.length > 0 && ch.queue[0]!.atMs <= ch.clockMs) {
    const spec = ch.queue.shift()!;
    const path = paths.get(spec.pathKey);
    const base = spec.kind === 'scout' || spec.kind === 'interceptor' || spec.kind === 'commander' ? spec.kind : 'transform';
    const e = createEnemy(world, cfg, base, path.xs[0]!, path.ys[0]!, { wave: spec.wave, ...(base === 'transform' ? { transformKind: spec.kind as never } : {}) });
    e.run = { path, s: 0, speed: CHALLENGE.speed, end: 'leave', fireAt: [] };
    setState(e, 'attacking');
    ch.spawned += 1;
  }
  if (ch.queue.length === 0 && ch.resolved >= ch.total) ch.ended = true;
}
