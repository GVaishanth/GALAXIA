/**
 * Game modes. The faithful default is CLASSIC_MODE: original scoring, no
 * power-ups. Optional modern rewards may only exist inside an explicitly
 * defined variant mode; they can never be switched on inside classic.
 */
import { deepFreeze } from './freeze.ts';
import { CLASSIC_SCORING, createScoringConfig, type ScoringConfig } from './scoring.ts';
import { CLASSIC_STAGE_SCHEDULE, type StageSchedule } from './stages.ts';
import type { DeepPartial } from './freeze.ts';

/** Placeholder contract for a future modern variant. Not implemented in classic. */
export interface PowerUpConfig {
  readonly enabled: boolean;
  /** Kinds the variant allows; reward manager only reports pickups, never scores them. */
  readonly kinds: readonly string[];
}

export interface GameModeConfig {
  readonly id: string;
  readonly label: string;
  readonly scoring: ScoringConfig;
  readonly schedule: StageSchedule;
  /** null = power-ups do not exist in this mode. */
  readonly powerUps: PowerUpConfig | null;
}

export const CLASSIC_MODE: GameModeConfig = deepFreeze({
  id: 'classic',
  label: 'Classic',
  scoring: CLASSIC_SCORING,
  schedule: CLASSIC_STAGE_SCHEDULE,
  powerUps: null,
});

/**
 * Define a variant mode. The id must differ from 'classic' so a variant can
 * never masquerade as (or silently alter) the faithful mode.
 */
export function defineGameMode(options: {
  id: string;
  label: string;
  scoring?: DeepPartial<ScoringConfig>;
  schedule?: StageSchedule;
  powerUps?: PowerUpConfig | null;
}): GameModeConfig {
  if (options.id === CLASSIC_MODE.id) throw new Error('Variant modes must not reuse the "classic" id');
  return deepFreeze({
    id: options.id,
    label: options.label,
    scoring: createScoringConfig(options.scoring),
    schedule: options.schedule ?? CLASSIC_STAGE_SCHEDULE,
    powerUps: options.powerUps ?? null,
  });
}
