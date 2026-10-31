/**
 * P07.1 Gravity Shadow and Silent Running: the pure rules (no state, no DOM,
 * no clock, no randomness). The AI (combat/ai.ts chooseTarget) and the run
 * (sector/run.ts stepSector) decide when to call them; renderers only read.
 *
 * Gravity Shadow: a hostile observes the pilot along the straight segment
 * between the two ships. A celestial body (a sector landmark: star or planet
 * / moon, at its solid radius) that touches that segment hides the pilot.
 * The test is the clamped segment distance (the projectile sweep test,
 * world.ts sweptHit), so a body behind the pilot or behind the observer
 * never blocks, and a tangent line (distance == radius) counts as blocked.
 * Rocks, caches, derelicts, stations, pickups and projectiles never occlude
 * sight; bodies are not given any aura beyond their solid radius.
 *
 * Silent Running: the pilot's signature multiplies every hostile's
 * acquisition range (detect range x signature), on the one acquisition path.
 *
 * Contact memory: a hostile that loses sight of the pilot keeps the contact
 * for STEALTH.memoryTicks AI steps (1.25 s of simulated time at 60 ticks per
 * second), steering at the frozen last-observed position and never firing;
 * then it falls back to the existing search (investigate the last-known
 * position).
 */
import type { Landmark } from '../sector/model.ts';
import type { SectorRun } from '../sector/run.ts';
import { sweptHit } from './world.ts';
import { live } from './shipAbilities.ts';

/** Tuning (units: signature multipliers; memory in 60 Hz simulation ticks). */
export const STEALTH = Object.freeze({
  /** Signature while flying normally (full detect range). */
  normal: 1,
  /** Signature in Silent Running (35 % of each hostile's detect range). */
  silent: 0.35,
  /** Contact memory after sight is lost: 75 ticks = 1.25 s. */
  memoryTicks: 75,
});

/** The first celestial body that hides b from a (null: clear line). Invalid bodies (non-finite, radius <= 0) never occlude. */
export function bodyBetween(bodies: readonly Landmark[], ax: number, ay: number, bx: number, by: number): Landmark | null {
  for (const l of bodies) if (l.r > 0 && sweptHit(ax, ay, bx, by, l.x, l.y, l.r)) return l;
  return null;
}

/**
 * The pilot's current signature multiplier. P10.1: the Raven's Quiet Hull
 * caps it (min), so it can never drop below Silent Running's value; line of
 * sight (Gravity Shadow) and contact memory are untouched by either.
 */
export const signature = (run: Pick<SectorRun, 'silent'> & Partial<Pick<SectorRun, 'craft' | 'ability'>>): number =>
  Math.min(run.silent ? STEALTH.silent : STEALTH.normal, (run.craft && run.ability && live({ craft: run.craft, ability: run.ability }, 'quiet-hull')?.signature) || 1);

/** A hostile's effective acquisition range for a base detect range and a signature. */
export const effectiveRange = (base: number, sig: number): number => base * sig;

/** Read-only stealth snapshot (P07.2 HUD). */
export interface StealthStatus {
  readonly silent: boolean;
  readonly signature: number;
  /** Hostiles holding the pilot in sight now. */
  readonly tracking: number;
  /** Hostiles holding the pilot only in contact memory (steering at the last-known position). */
  readonly searching: number;
  /** Hostiles (not disabled) whose sight of the pilot, within their acquisition range, a celestial body blocked at their last AI step (Agent.shadow). */
  readonly shadowed: number;
}

/**
 * Minimal read-only stealth snapshot for presentation (P07.2 HUD): whether
 * Silent Running is on, the signature, and how many hostiles hold the pilot
 * in sight / only in contact memory / are blocked by a body. It only counts
 * the AI's own per-ship results (no geometry here). Never authoritative.
 */
export function stealthStatus(run: SectorRun): StealthStatus {
  let tracking = 0;
  let searching = 0;
  let shadowed = 0;
  for (const a of run.hostiles) {
    if (a.state === 'destroyed') continue;
    if (a.shadow && a.state !== 'disabled') shadowed += 1;
    if (a.target !== 'player') continue;
    if (a.lost > 0) searching += 1;
    else tracking += 1;
  }
  return { silent: run.silent, signature: signature(run), tracking, searching, shadowed };
}
