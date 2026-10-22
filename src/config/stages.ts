/**
 * Stage schedule: which stages are ordinary and which are Challenging Stages
 * (bonus rounds). Classic: stage 3, then every 4th stage (7, 11, 15, ...).
 * Full stage content (formations, dive patterns) arrives in Stage 3 of the
 * project; this file only fixes the ordinary/bonus distinction scoring needs.
 */
import { deepFreeze } from './freeze.ts';

export interface StageSchedule {
  readonly firstChallengingStage: number;
  readonly challengingInterval: number;
}

export const CLASSIC_STAGE_SCHEDULE: StageSchedule = deepFreeze({ firstChallengingStage: 3, challengingInterval: 4 });

export type StageKind = 'normal' | 'challenge';

export function isValidStage(stage: number): boolean {
  return Number.isInteger(stage) && stage >= 1;
}

export function stageKind(stage: number, schedule: StageSchedule = CLASSIC_STAGE_SCHEDULE): StageKind {
  if (!isValidStage(stage)) throw new RangeError(`Invalid stage ${stage}`);
  const offset = stage - schedule.firstChallengingStage;
  return offset >= 0 && offset % schedule.challengingInterval === 0 ? 'challenge' : 'normal';
}

/** 1-based Challenging Stage number (stage 3 -> 1, 7 -> 2, ...), or null for normal stages. */
export function challengeNumber(stage: number, schedule: StageSchedule = CLASSIC_STAGE_SCHEDULE): number | null {
  if (stageKind(stage, schedule) !== 'challenge') return null;
  return (stage - schedule.firstChallengingStage) / schedule.challengingInterval + 1;
}
