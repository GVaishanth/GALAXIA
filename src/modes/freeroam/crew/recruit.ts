/**
 * Recruitment (P05.1): who can sign on where, and the one paid action.
 * Pure: the shell supplies the world (crew/types.ts CrewWorld) and commits
 * the returned state and ledger together.
 *
 *  - Eligibility is derived from facts the save already holds (story
 *    missions completed, surveys, milestones, distress beacons cleared), so
 *    it is idempotent by construction: replaying an event, reloading or
 *    opening the Bridge again can never offer a recruit twice or sign anyone
 *    on by itself. Signing on is always the pilot's explicit action.
 *  - A station recruit signs on at their station; story and rescue recruits
 *    at any station. Never in flight.
 *  - The berth fee goes through the ledger's transact (progression/ledger.ts):
 *    taken once, never below zero, refunded if completing the hire fails,
 *    with a fresh transaction id per hire. A fee paid once is never charged
 *    again (a dismissed member signs on again for free). Admin Access hires
 *    are free and record nothing (the sandbox never changes the balance).
 */
import { transact, type Ledger } from '../progression/ledger.ts';
import { CREW, CREW_BY_ID, MAX_HIRED } from './data.ts';
import { isHired } from './state.ts';
import type { CrewDef, CrewRequirement, CrewState, CrewWorld } from './types.ts';

/**
 * Distress beacons cleared: wreck-defence sites (`defence-N`) in the saved
 * sectors' done lists. Only a cleared site is recorded there (a failed defence
 * is not), and each is recorded once, so the count is exact and replay-proof.
 */
export function distressBeaconsCleared(sectors: Readonly<Record<string, { readonly done: readonly string[] }>>): number {
  let n = 0;
  for (const rec of Object.values(sectors)) for (const id of rec.done) if (/^defence-[0-9]+$/.test(id)) n += 1;
  return n;
}

export const requirementMet = (r: CrewRequirement, w: CrewWorld): boolean =>
  r.kind === 'unlock' ? w.requirementMet(r.req) : r.kind === 'mission' ? w.missionDone(r.missionId) : w.rescues >= r.count;

/** Where a recruit can be signed on: one station, or any station. */
export const recruitStation = (d: CrewDef): string | null => (d.source.kind === 'station' ? d.source.systemId : null);

export type RecruitState =
  /** Already on the roster. */
  | 'hired'
  /** Requirements met and docked where they wait: can sign on now. */
  | 'here'
  /** Requirements met, waiting at another station. */
  | 'elsewhere'
  /** Requirements met, but the pilot is not docked. */
  | 'undocked'
  /** A requirement is not met yet. */
  | 'locked';

export function recruitState(d: CrewDef, s: CrewState, w: CrewWorld): RecruitState {
  if (isHired(s, d.id)) return 'hired';
  if (!d.requirements.every((r) => requirementMet(r, w))) return 'locked';
  if (w.docked === null) return 'undocked';
  const at = recruitStation(d);
  return at === null || at === w.docked ? 'here' : 'elsewhere';
}

/** The fee this save would pay now (0 when already paid once, for story / rescue recruits, or under Admin Access). */
export const feeDue = (d: CrewDef, s: CrewState, free: boolean): number => (free || s.paid.includes(d.id) ? 0 : d.fee);

/** Recruits for the Bridge list: not hired, those who can sign on here first, then roster order (stable, never shuffled). */
export function recruitList(s: CrewState, w: CrewWorld): { readonly def: CrewDef; readonly state: RecruitState }[] {
  const order: Readonly<Record<RecruitState, number>> = { here: 0, undocked: 1, elsewhere: 2, locked: 3, hired: 4 };
  return CREW.map((def, i) => ({ def, state: recruitState(def, s, w), i }))
    .filter((r) => r.state !== 'hired')
    .sort((a, b) => order[a.state] - order[b.state] || a.i - b.i)
    .map(({ def, state }) => ({ def, state }));
}

export type HireRefusal = 'unknown' | 'hired' | 'locked' | 'elsewhere' | 'undocked' | 'roster-full' | 'insufficient' | 'duplicate' | 'invalid' | 'failed';

export type HireResult =
  | { readonly ok: true; readonly state: CrewState; readonly ledger: Ledger; readonly charged: number }
  | { readonly ok: false; readonly reason: HireRefusal; readonly ledger: Ledger; readonly refunded: boolean };

/** Ledger id of one hire: unique per transaction (a later re-hire is a new transaction), refused if replayed. */
export const hireTxId = (crewId: string, l: Ledger): string => `crew:hire:${crewId}:${l.seq + 1}`;

/** Why a recruit cannot sign on now (null = they can), before any marks are touched. */
export function hireRefusal(d: CrewDef | undefined, s: CrewState, w: CrewWorld): HireRefusal | null {
  if (!d) return 'unknown';
  const st = recruitState(d, s, w);
  if (st === 'hired') return 'hired';
  if (st === 'locked') return 'locked';
  if (st === 'undocked') return 'undocked';
  if (st === 'elsewhere') return 'elsewhere';
  if (s.hired.length >= MAX_HIRED) return 'roster-full';
  return null;
}

/**
 * Sign a recruit on. Every rule is checked before payment; the payment and
 * the roster change then go through one transact, so the pilot is charged
 * exactly once for a completed hire and never for a failed one. The new
 * member joins the unassigned roster (no seat is taken implicitly).
 */
export function signOn(s: CrewState, l: Ledger, crewId: string, w: CrewWorld, free = false): HireResult {
  const d = CREW_BY_ID.get(crewId);
  const refusal = hireRefusal(d, s, w);
  if (refusal || !d) return { ok: false, reason: refusal ?? 'unknown', ledger: l, refunded: false };
  const fee = feeDue(d, s, free);
  const effect = (): CrewState | null => {
    // re-validated inside the transaction (the state the payment completes)
    if (hireRefusal(d, s, w)) return null;
    return { ...s, hired: [...s.hired, d.id], paid: fee > 0 && !s.paid.includes(d.id) ? [...s.paid, d.id] : s.paid };
  };
  if (fee === 0) {
    const next = effect();
    return next ? { ok: true, state: next, ledger: l, charged: 0 } : { ok: false, reason: 'failed', ledger: l, refunded: false };
  }
  const t = transact(l, fee, 'crew', `Crew · ${d.name} signed on`, hireTxId(d.id, l), effect);
  if (!t.ok) return { ok: false, reason: t.reason === 'cap' || t.reason === 'unknown' ? 'failed' : t.reason, ledger: t.ledger, refunded: t.refunded };
  return { ok: true, state: t.value, ledger: t.ledger, charged: t.charged };
}
