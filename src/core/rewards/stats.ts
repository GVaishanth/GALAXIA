/**
 * Game statistics derived purely from RewardEvents: an example of an
 * independent subscriber (the engine does not know it exists).
 */
import type { TypedEventBus } from './eventBus.ts';
import type { RewardEvent } from './types.ts';

export interface GameStats {
  kills: number;
  attackKills: number;
  killsByKind: Record<string, number>;
  bestSingleAward: number;
  transformGroupsCleared: number;
  challengeWavesCleared: number;
  challengePerfects: number;
  rescues: number;
  captivesLost: number;
  extraLives: number;
}

export function emptyStats(): GameStats {
  return {
    kills: 0,
    attackKills: 0,
    killsByKind: {},
    bestSingleAward: 0,
    transformGroupsCleared: 0,
    challengeWavesCleared: 0,
    challengePerfects: 0,
    rescues: 0,
    captivesLost: 0,
    extraLives: 0,
  };
}

export function applyStats(stats: GameStats, e: RewardEvent): void {
  switch (e.type) {
    case 'gameStarted':
      Object.assign(stats, emptyStats());
      break;
    case 'pointsAwarded':
      stats.bestSingleAward = Math.max(stats.bestSingleAward, e.amount);
      if ((e.source === 'enemy' || e.source === 'capturedFighter') && e.enemyKind) {
        stats.kills += 1;
        if (e.phase !== 'formation') stats.attackKills += 1;
        stats.killsByKind[e.enemyKind] = (stats.killsByKind[e.enemyKind] ?? 0) + 1;
      }
      break;
    case 'transformGroupCleared':
      stats.transformGroupsCleared += 1;
      break;
    case 'challengeWaveCleared':
      stats.challengeWavesCleared += 1;
      break;
    case 'challengeStageResult':
      if (e.perfect) stats.challengePerfects += 1;
      break;
    case 'rescue':
      if (e.outcome.status === 'rescued') stats.rescues += 1;
      if (e.outcome.status === 'failed') stats.captivesLost += 1;
      break;
    case 'extraLifeAwarded':
      stats.extraLives += 1;
      break;
    default:
      break;
  }
}

/** Subscribe a live stats object to a bus. Returns the stats and an unsubscribe function. */
export function trackStats(bus: TypedEventBus<RewardEvent>): { stats: GameStats; stop: () => void } {
  const stats = emptyStats();
  const stop = bus.onAny((e) => applyStats(stats, e));
  return { stats, stop };
}
