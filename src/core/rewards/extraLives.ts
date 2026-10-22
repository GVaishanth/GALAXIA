/**
 * Extra-life threshold schedule. Pure functions over ScoringConfig.extraLives.
 * Threshold i (0-based): i=0 -> first, i=1 -> second, i>=2 -> second + (i-1)*every.
 */
import type { ScoringConfig } from '../../config/scoring.ts';

export type ExtraLifeRule = ScoringConfig['extraLives'];

/** The i-th threshold, or null if the schedule has fewer thresholds. */
export function extraLifeThreshold(rule: ExtraLifeRule, index: number): number | null {
  if (!Number.isInteger(index) || index < 0) return null;
  let value: number | null;
  if (index === 0) value = rule.first;
  else if (index === 1) value = rule.first === null ? null : rule.second;
  else value = rule.second === null || rule.every === null ? null : rule.second + (index - 1) * rule.every;
  if (value === null) return null;
  if (rule.stopAboveScore !== null && value > rule.stopAboveScore) return null;
  return value;
}

/** Number of thresholds at or below `score`. */
export function extraLivesEarnedAt(rule: ExtraLifeRule, score: number): number {
  let n = 0;
  for (;;) {
    const t = extraLifeThreshold(rule, n);
    if (t === null || t > score) return n;
    n += 1;
    if (n > 100_000) return n; // defensive bound; unreachable with validated configs
  }
}

/** First `count` thresholds, for documentation and UI ("next extra fighter at ..."). */
export function listExtraLifeThresholds(rule: ExtraLifeRule, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = extraLifeThreshold(rule, i);
    if (t === null) break;
    out.push(t);
  }
  return out;
}
