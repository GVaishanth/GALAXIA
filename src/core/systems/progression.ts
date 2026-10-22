/**
 * Stage progression: building a stage (normal or Challenging), deciding when
 * it is cleared, and choosing the next stage.
 */
import { tuningForStage } from '../../config/difficulty.ts';
import { stageKind, type StageSchedule } from '../../config/stages.ts';
import { buildChallenge } from './challenge.ts';
import type { SimContext } from './context.ts';
import { buildEntryQueue, placeFormation } from './entry.ts';
import { newFormationState } from './formation.ts';

/** Reset the playfield for `stage`. The player ship itself is kept (Dual carries over). */
export function setupStage(ctx: SimContext, stage: number, schedule: StageSchedule, instantFormation: boolean): void {
  const { world } = ctx;
  world.stage = stage;
  world.stageKind = stageKind(stage, schedule);
  world.tuning = tuningForStage(stage);
  world.enemies = [];
  world.playerShots = [];
  world.enemyShots = [];
  world.formation = newFormationState();
  world.challenge = null;
  world.transformsLaunched = 0;
  world.fireHoldUntilMs = 0;
  world.attackTimerMs = world.tuning.attackIntervalMs + 1200;
  if (world.stageKind === 'challenge') {
    world.challenge = buildChallenge(stage, schedule);
    world.formation.entryComplete = true;
  } else if (instantFormation) {
    placeFormation(ctx);
  } else {
    world.formation.entryQueue = buildEntryQueue();
  }
}

/** True when nothing of the stage remains in play. */
export function isStageCleared(ctx: SimContext): boolean {
  const { world } = ctx;
  if (world.stageKind === 'challenge') return world.challenge?.ended === true;
  return world.formation.entryQueue.length === 0 && world.enemies.length === 0;
}
