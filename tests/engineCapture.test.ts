/**
 * Tractor beam, capture, rescue, hostile captives and the Dual Fighter.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE } from '../src/config/engine.ts';
import { CLASSIC_SCORING } from '../src/config/scoring.ts';
import { NO_INPUT } from '../src/core/game/input.ts';
import type { Enemy } from '../src/core/game/types.ts';
import { activeCaptive, canBeam, onCaptorDestroyed } from '../src/core/systems/capture.ts';
import { destroyEnemy } from '../src/core/systems/damage.ts';
import { enemiesOf, FIRE, type Harness, LEFT, makeEngine, run, runUntil, score, shootPlayer, startPlaying } from './helpers/engine.ts';

/** Keep stray enemy fire out of scripted scenarios. */
const noFire = (h: Harness) => () => {
  h.engine.world.enemyShots = [];
  return NO_INPUT;
};

function commander(h: Harness, slotId = '0:4'): Enemy {
  return h.engine.world.enemies.find((e) => e.slot?.id === slotId)!;
}

/** Send the captor on an escorted dive, then remove the escorts so they cannot ram the test fighter. */
function diveCaptor(h: Harness, cmd: Enemy): void {
  const ids = h.engine.debugLaunch('commanderEscort', cmd.id);
  expect(ids[0]).toBe(cmd.id);
  run(h.engine, 30, noFire(h));
  for (const id of ids.slice(1)) destroyEnemy(h.engine.context, h.engine.world.enemies.find((e) => e.id === id)!);
}

/** Launch a beam dive and let it capture the stationary player. Returns the captor. */
function capture(h: Harness): Enemy {
  const cmd = commander(h);
  expect(h.engine.debugLaunch('commanderBeam', cmd.id)).toEqual([cmd.id]);
  runUntil(h.engine, () => h.engine.world.player.state === 'gone', 60 * 20, noFire(h));
  return cmd;
}

describe('tractor beam and capture', () => {
  it('captures the fighter only when the pull completes, then uses a reserve and attaches the captive', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const cmd = commander(h);
    h.engine.debugLaunch('commanderBeam', cmd.id);
    runUntil(h.engine, () => h.engine.world.player.state === 'tractored', 60 * 20, noFire(h));
    // tractored: not yet captured, uncollidable, reserves untouched
    expect(h.rewardEvents.some((e) => e.type === 'fighterCaptured')).toBe(false);
    expect(h.rewards.snapshot().reserves).toBe(2);
    shootPlayer(h.engine);
    run(h.engine, 2, noFire(h));
    expect(h.engine.world.player.state).toBe('tractored');
    runUntil(h.engine, () => h.engine.world.player.state === 'gone', 60 * 20, noFire(h));
    expect(h.engine.phase).toBe('playerHit');
    expect(h.rewardEvents.filter((e) => e.type === 'fighterCaptured')).toHaveLength(1);
    expect(h.rewards.snapshot().reserves).toBe(1);
    const captive = activeCaptive(h.engine.context)!;
    expect(captive).toMatchObject({ kind: 'capturedFighter', fighterId: 'f1', captorId: cmd.id, captiveMode: 'attached' });
    expect(cmd.captiveId).toBe(captive.id);
    // the captor brings it home, then a new fighter respawns
    runUntil(h.engine, () => h.engine.phase === 'playing', 60 * 20, noFire(h));
    expect(cmd.state).toBe('inFormation');
    expect(captive.state).toBe('inFormation');
    expect(captive.y).toBeCloseTo(cmd.y + ENGINE.capture.captiveOffsetY, 6);
    expect(h.engine.world.player.fighterId).toBe('f2');
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('a fighter outside the beam is not taken; the commander continues off screen and returns', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const cmd = commander(h);
    h.engine.debugLaunch('commanderBeam', cmd.id);
    runUntil(h.engine, () => cmd.beam !== undefined, 60 * 20, noFire(h));
    run(h.engine, 40, () => {
      h.engine.world.enemyShots = [];
      return LEFT;
    });
    runUntil(h.engine, () => cmd.state === 'inFormation', 60 * 30, noFire(h));
    expect(h.engine.world.player.state).toBe('alive');
    expect(activeCaptive(h.engine.context)).toBeUndefined();
    expect(h.rewards.snapshot().reserves).toBe(2);
  });

  it('beam conditions: no beam with a captive present, as a Dual Fighter, or in a Challenging Stage', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    expect(canBeam(h.engine.context)).toBe(true);
    h.engine.world.player.dual = true;
    expect(canBeam(h.engine.context)).toBe(false);
    h.engine.world.player.dual = false;
    capture(h);
    runUntil(h.engine, () => h.engine.phase === 'playing', 60 * 20, noFire(h));
    expect(canBeam(h.engine.context)).toBe(false);
    expect(h.engine.debugLaunch('commanderBeam')).toEqual([]);

    const c = makeEngine({ startStage: 3 });
    startPlaying(c);
    expect(canBeam(c.engine.context)).toBe(false);
  });

  it('destroying the captor during the pull releases the fighter without a capture', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const cmd = commander(h);
    h.engine.debugLaunch('commanderBeam', cmd.id);
    runUntil(h.engine, () => h.engine.world.player.state === 'tractored', 60 * 20, noFire(h));
    run(h.engine, 20, noFire(h));
    destroyEnemy(h.engine.context, cmd);
    runUntil(h.engine, () => h.engine.world.player.state === 'alive', 60 * 5, noFire(h));
    expect(h.engine.world.player.y).toBe(ENGINE.player.y);
    expect(h.engine.phase).toBe('playing');
    expect(h.rewardEvents.some((e) => e.type === 'fighterCaptured')).toBe(false);
    expect(h.rewards.snapshot().reserves).toBe(2);
  });

  it('a capture of the last fighter ends the game once the captor is home', () => {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    for (let i = 0; i < 2; i++) {
      shootPlayer(h.engine);
      run(h.engine, 1);
      runUntil(h.engine, () => h.engine.phase === 'playing', 60 * 20, noFire(h));
      h.engine.world.attackTimerMs = Number.POSITIVE_INFINITY;
    }
    expect(h.rewards.snapshot().reserves).toBe(0);
    capture(h);
    runUntil(h.engine, () => h.engine.phase === 'gameOver', 60 * 20, noFire(h));
    expect(h.rewardEvents.some((e) => e.type === 'rescue' && e.outcome.status === 'failed')).toBe(true);
  });
});

describe('rescue and Dual Fighter', () => {
  function capturedAndHome(): { h: Harness; cmd: Enemy; captive: Enemy } {
    const h = makeEngine();
    startPlaying(h, { quiet: true });
    const cmd = capture(h);
    const captive = activeCaptive(h.engine.context)!;
    runUntil(h.engine, () => h.engine.phase === 'playing', 60 * 20, noFire(h));
    h.engine.world.attackTimerMs = Number.POSITIVE_INFINITY;
    return { h, cmd, captive };
  }

  it('destroying the captor while it attacks frees the captive, which docks into a Dual Fighter', () => {
    const { h, cmd, captive } = capturedAndHome();
    h.engine.debugSetPlayerX(120);
    diveCaptor(h, cmd);
    expect(cmd.state).toBe('attacking');
    expect(captive.state).toBe('attacking');
    destroyEnemy(h.engine.context, cmd);
    expect(captive.captiveMode).toBe('freed');
    expect(h.rewardEvents.filter((e) => e.type === 'rescue').map((e) => (e.type === 'rescue' ? e.outcome.status : ''))).toContain('freed');
    // freed fighter cannot be shot while it returns
    const s = { id: -2, x: captive.x, y: captive.y + 4, prevX: captive.x, prevY: captive.y + 8, vx: 0, vy: -720 };
    h.engine.world.playerShots.push(s);
    run(h.engine, 1, noFire(h));
    expect(captive.captiveMode).toBe('freed');
    runUntil(h.engine, () => h.engine.world.player.dual, 60 * 10, noFire(h));
    const p = h.engine.world.player;
    expect(p.x).toBeGreaterThanOrEqual(ENGINE.player.dualMinX);
    expect(p.x).toBeLessThanOrEqual(ENGINE.player.dualMaxX);
    expect(h.rewards.snapshot()).toMatchObject({ dualFighterActive: true, reserves: 1 });
    expect(activeCaptive(h.engine.context)).toBeUndefined();
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('the Dual Fighter fires pairs (max 4 shots) and losing one half keeps playing without a reserve', () => {
    const { h, cmd } = capturedAndHome();
    diveCaptor(h, cmd);
    destroyEnemy(h.engine.context, cmd);
    runUntil(h.engine, () => h.engine.world.player.dual, 60 * 10, noFire(h));
    runUntil(h.engine, () => h.engine.world.enemies.every((e) => e.state === 'inFormation'), 60 * 20, noFire(h));
    h.engine.debugSetPlayerX(ENGINE.player.dualMinX);
    let max = 0;
    run(h.engine, 12, (i) => {
      h.engine.world.enemyShots = [];
      max = Math.max(max, h.engine.world.playerShots.length);
      return i % 2 === 0 ? FIRE : NO_INPUT;
    });
    expect(max).toBe(ENGINE.shots.maxDual);
    const xs = new Set(h.engine.world.playerShots.map((s) => s.x));
    expect(xs.size).toBe(2);
    const reserves = h.rewards.snapshot().reserves;
    const center = h.engine.world.player.x;
    shootPlayer(h.engine, ENGINE.player.dualHalfOffset); // right half
    run(h.engine, 1);
    expect(h.engine.phase).toBe('playing');
    expect(h.engine.world.player.dual).toBe(false);
    expect(h.engine.world.player.x).toBe(center - ENGINE.player.dualHalfOffset);
    expect(h.rewards.snapshot().reserves).toBe(reserves);
    expect(h.rewards.snapshot().dualFighterActive).toBe(false);
  });

  it('destroying the captor in formation turns the captive hostile (no Dual Fighter)', () => {
    const { h, cmd, captive } = capturedAndHome();
    destroyEnemy(h.engine.context, cmd);
    expect(captive.captiveMode).toBe('hostile');
    expect(h.rewardEvents.some((e) => e.type === 'rescue' && e.outcome.status === 'failed')).toBe(true);
    run(h.engine, 30, noFire(h));
    expect(h.engine.world.player.dual).toBe(false);
    const before = score(h);
    destroyEnemy(h.engine.context, captive);
    expect(score(h) - before).toBe(CLASSIC_SCORING.enemies.capturedFighter.formation);
  });

  it('shooting the attached captive is a failed rescue and pays the captured-fighter value', () => {
    const { h, cmd, captive } = capturedAndHome();
    diveCaptor(h, cmd);
    const before = score(h);
    destroyEnemy(h.engine.context, captive);
    expect(score(h) - before).toBe(CLASSIC_SCORING.enemies.capturedFighter.attack);
    expect(cmd.captiveId).toBeUndefined();
    destroyEnemy(h.engine.context, cmd);
    expect(h.engine.world.player.dual).toBe(false);
    run(h.engine, 120, noFire(h));
    expect(h.engine.world.player.dual).toBe(false);
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('a captive can be neither rescued nor destroyed twice', () => {
    const { h, cmd, captive } = capturedAndHome();
    diveCaptor(h, cmd);
    destroyEnemy(h.engine.context, cmd);
    destroyEnemy(h.engine.context, cmd); // second report is a no-op
    runUntil(h.engine, () => h.engine.world.player.dual, 60 * 10, noFire(h));
    destroyEnemy(h.engine.context, captive); // already docked and removed
    expect(h.rewardEvents.filter((e) => e.type === 'rescue' && e.outcome.status === 'rescued')).toHaveLength(1);
    expect(h.rewardEvents.filter((e) => e.type === 'pointsAwarded' && e.source === 'capturedFighter')).toHaveLength(0);
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('resolving the same captive again (stale captor reference) changes nothing', () => {
    const { h, cmd, captive } = capturedAndHome();
    diveCaptor(h, cmd);
    const stale = { ...cmd, captiveId: captive.id };
    destroyEnemy(h.engine.context, cmd);
    expect(captive.captiveMode).toBe('freed');
    const events = h.rewardEvents.length;
    onCaptorDestroyed(h.engine.context, stale, 'inFormation');
    expect(captive.captiveMode).toBe('freed');
    expect(h.rewardEvents.length).toBe(events);
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('a freed captive is lost if the player dies before it docks', () => {
    const { h, cmd, captive } = capturedAndHome();
    diveCaptor(h, cmd);
    destroyEnemy(h.engine.context, cmd);
    shootPlayer(h.engine);
    run(h.engine, 2);
    expect(enemiesOf(h.engine, 'capturedFighter')).toHaveLength(0);
    expect(captive.state).toBe('destroyed');
    expect(h.rewardEvents.some((e) => e.type === 'rescue' && e.outcome.status === 'failed' && e.outcome.reason === 'player-lost-before-docking')).toBe(true);
    expect(h.engine.rejectedFacts).toEqual([]);
  });

  it('a hostile captive that escapes is re-attached to a commander next stage', () => {
    const { h, cmd, captive } = capturedAndHome();
    destroyEnemy(h.engine.context, cmd);
    h.engine.debugLaunch('hostileCaptive', captive.id);
    runUntil(h.engine, () => !h.engine.world.enemies.includes(captive), 60 * 20, noFire(h));
    expect(h.engine.world.pendingRebound).toBe('f1');
    h.engine.debugDestroyAll();
    runUntil(h.engine, () => h.engine.world.stage === 2 && h.engine.phase === 'playing', 60 * 20, noFire(h));
    run(h.engine, 1, noFire(h));
    const again = activeCaptive(h.engine.context)!;
    expect(again).toMatchObject({ fighterId: 'f1', captiveMode: 'attached' });
    // the reward ledger tracks the rebound silently (no event, no points)
    expect(h.rewards.snapshot().captives.find((c) => c.fighterId === 'f1')).toMatchObject({ status: 'held', captorId: again.captorId });
    expect(h.engine.rejectedFacts).toEqual([]);
  });
});
