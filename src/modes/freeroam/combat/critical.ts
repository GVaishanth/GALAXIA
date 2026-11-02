/**
 * Finale P1: critical hits (docs/freeroam/CRITICAL_HITS.md). One policy for every weapon source:
 * the pilot's bolts and ordnance, hostile NPC fire and the fleet escorts' bolts.
 *
 *  - Each eligible firing event is critical with probability CRIT_CHANCE (10 %), decided ONCE when it
 *    fires (`rollCritical`), from the run's own seeded stream (never the shared `rng`, so no other
 *    roll shifts). Independent per event: ten shots do not promise one critical.
 *  - The decision travels with the projectiles of that one firing as a token. The first confirmed
 *    impact on an eligible ship spends it (`useCritical`); later callbacks, sibling pellets, beam
 *    ticks and blast splash never see it again.
 *  - A spent critical is lethal damage through the ordinary damage function (damageAgent /
 *    damagePlayer / the escort's hurt), so destruction, kill credit, heat, loot, recall and the
 *    escort's disabled state run once, on their usual paths. It never creates a hit the ordinary
 *    rules refuse; invulnerability still absorbs it; capital-class bosses keep their explicit
 *    protection and take an ordinary hit.
 *  - Nothing here is saved: tokens live on in-flight projectiles, the state on the sector run.
 *
 * Pure simulation: no DOM, no clock, no unseeded randomness.
 */
import { createRng, type Rng } from '../../../core/rng.ts';
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import type { Agent } from './state.ts';

/** Probability that one eligible firing event is critical. */
export const CRIT_CHANCE = 0.1;

/** Shared by the projectiles of one firing event; the first confirmed impact on an eligible ship spends it. */
export interface CritToken {
  spent: boolean;
}

/** 'auto' = the seeded roll (ordinary play); 'crit' / 'normal' force the outcome (Admin sandbox and test seams only). */
export type CritMode = 'auto' | 'crit' | 'normal';

export type CritVictim = 'hostile' | 'player' | 'escort';

/** A confirmed critical: the struck ship was destroyed (hostile), lost (player) or disabled (escort). */
export interface CritEvent {
  readonly type: 'critical';
  readonly victim: CritVictim;
  /** The attacking side: 'player' covers the pilot and the escorts (same attribution as damageAgent). */
  readonly by: 'player' | 'npc';
  /** Hostile family id, escort vessel id, or 'pilot'. */
  readonly what: string;
  readonly x: number;
  readonly y: number;
  readonly tick: number;
}

export interface CritState {
  readonly rng: Rng;
  mode: CritMode;
  /** Firing events decided, of them critical, and criticals confirmed on a ship (this visit). */
  rolls: number;
  rolled: number;
  landed: number;
  /** The last confirmed criticals (newest last, at most 5): diagnostics only. */
  readonly last: CritEvent[];
}

/** The 10 % boundary on a uniform draw u in [0, 1): critical below it, ordinary at or above it. */
export const isCritical = (u: number): boolean => u < CRIT_CHANCE;

/** A fresh state for one sector visit (its own stream, derived from the visit's seed). */
export const freshCrit = (seed: number): CritState => ({ rng: createRng((seed ^ 0x2545f491) >>> 0), mode: 'auto', rolls: 0, rolled: 0, landed: 0, last: [] });

/** One firing event: one draw, one decision. A token when critical, else null. */
export function rollCritical(run: { readonly crit: CritState }): CritToken | null {
  const c = run.crit;
  const u = c.rng.next(); // always drawn, so forcing never moves the stream
  c.rolls += 1;
  if (!(c.mode === 'crit' || (c.mode === 'auto' && isCritical(u)))) return null;
  c.rolled += 1;
  return { spent: false };
}

/** Capital-class bosses keep their explicit protection (ordnance bossMul, the two-phase fight): never deleted by a critical. */
export const critShip = (a: Agent): boolean => a.role !== 'boss' && a.family !== 'capital';

/** Spend a firing event's critical on this confirmed impact: true once, and only for an eligible ship. */
export function useCritical(t: CritToken | null | undefined, a?: Agent): boolean {
  if (!t || t.spent || (a && !critShip(a))) return false;
  t.spent = true;
  return true;
}

/** Record and announce a confirmed critical (called by the damage functions after the ship's state changed). */
export function landCritical(run: SectorRun, victim: CritVictim, by: 'player' | 'npc', what: string, x: number, y: number, events: SectorEvent[]): void {
  const e: CritEvent = { type: 'critical', victim, by, what, x, y, tick: run.tick };
  const c = run.crit;
  c.landed += 1;
  c.last.push(e);
  if (c.last.length > 5) c.last.shift();
  events.push(e);
}

/**
 * Admin sandbox / QA seam: force the outcome for this sector visit (a new visit starts at 'auto').
 * The shell calls it only inside an Admin session and from the QA build's test hooks.
 */
export function forceCritical(run: { readonly crit: CritState }, mode: unknown): boolean {
  if (mode !== 'auto' && mode !== 'crit' && mode !== 'normal') return false;
  run.crit.mode = mode;
  return true;
}
