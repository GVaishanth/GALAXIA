/**
 * Crew state rules (P05.1): seats, assignment, dismissal and the invariant
 * check. Pure: every function takes a state and returns a new one (or a
 * refusal with its reason); nothing is mutated, stored or timed.
 *
 *  - Capacity is checked inside the assignment itself (assign), never only
 *    in the UI: a full ship refuses, whatever the panel shows.
 *  - A crew member sits in at most one seat of one ship. Assigning someone
 *    who sits elsewhere moves them (one operation, never a duplicate).
 *  - Seat changes happen only while docked with no hostile engaged (the
 *    same rule as switching ships) and only on ships the save owns.
 *  - Nothing ever deletes a crew member implicitly: when a ship has fewer
 *    seats than crew (an old save, a changed capacity, a ship no longer in
 *    the fleet) the extra crew return to the unassigned roster (cleanCrew).
 *    Only an explicit dismissal ends a contract, and the paid fee is kept.
 */
import { SHIP_BY_ID } from '../ships/roster.ts';
import { SHIP_IDS, type ShipId } from '../ships/types.ts';
import { CREW_BY_ID, MAX_HIRED } from './data.ts';
import type { CrewState, CrewWorld, NavDoctrine } from './types.ts';

export const EMPTY_CREW: CrewState = Object.freeze({ hired: Object.freeze([]), paid: Object.freeze([]), seats: Object.freeze({}) });

/**
 * Crew seats of a ship (the roster's crewSeats). The single place capacity is
 * read: a future quarters module (an equipment slot that adds berths) would
 * add its seats here, so every rule and the Bridge pick it up together.
 */
export function seatCount(ship: ShipId): number {
  const def = SHIP_BY_ID.get(ship);
  return def ? Math.max(0, Math.floor(def.crewSeats)) : 0;
}

const isShip = (id: string): id is ShipId => (SHIP_IDS as readonly string[]).includes(id);

/** The ship a crew member sits in, or null (unassigned or not hired). */
export function shipOf(s: CrewState, crewId: string): ShipId | null {
  for (const id of SHIP_IDS) if (s.seats[id]?.includes(crewId)) return id;
  return null;
}

/** Crew in a ship's seats, in seat order. */
export const crewAboard = (s: CrewState, ship: ShipId): readonly string[] => s.seats[ship] ?? [];

/** Hired crew who sit in no seat. */
export const unassigned = (s: CrewState): string[] => s.hired.filter((id) => shipOf(s, id) === null);

export const isHired = (s: CrewState, crewId: string): boolean => s.hired.includes(crewId);

const withSeats = (s: CrewState, ship: ShipId, ids: readonly string[]): CrewState => {
  const seats: Partial<Record<ShipId, readonly string[]>> = { ...s.seats };
  if (ids.length) seats[ship] = ids;
  else delete seats[ship];
  return { ...s, seats };
};

const without = (s: CrewState, crewId: string): CrewState => {
  const from = shipOf(s, crewId);
  return from ? withSeats(s, from, crewAboard(s, from).filter((id) => id !== crewId)) : s;
};

/* ------------------------------------------------------------ operations */

export type SeatRefusal = 'unknown' | 'not-hired' | 'not-owned' | 'no-seats' | 'full' | 'unsafe' | 'already' | 'not-seated';

export type SeatResult = { readonly ok: true; readonly state: CrewState; readonly moved: ShipId | null } | { readonly ok: false; readonly reason: SeatRefusal };

/** Why a crew member cannot take a seat on `ship` now (null = they can). Shared by assign and the Bridge. */
export function assignRefusal(s: CrewState, crewId: string, ship: ShipId, w: CrewWorld): SeatRefusal | null {
  if (!CREW_BY_ID.has(crewId) || !isShip(ship)) return 'unknown';
  if (!isHired(s, crewId)) return 'not-hired';
  if (!w.owned.includes(ship)) return 'not-owned';
  if (seatCount(ship) === 0) return 'no-seats';
  if (crewAboard(s, ship).includes(crewId)) return 'already';
  if (crewAboard(s, ship).length >= seatCount(ship)) return 'full';
  if (!w.safe) return 'unsafe';
  return null;
}

/** Seat a hired crew member on an owned ship (moving them from another ship if they sit there). */
export function assign(s: CrewState, crewId: string, ship: ShipId, w: CrewWorld): SeatResult {
  const refusal = assignRefusal(s, crewId, ship, w);
  if (refusal) return { ok: false, reason: refusal };
  const moved = shipOf(s, crewId);
  const next = without(s, crewId);
  return { ok: true, state: withSeats(next, ship, [...crewAboard(next, ship), crewId]), moved };
}

/** Take a crew member out of their seat (they stay hired, on the unassigned roster). */
export function unassign(s: CrewState, crewId: string, w: CrewWorld): SeatResult {
  const from = shipOf(s, crewId);
  if (!from) return { ok: false, reason: CREW_BY_ID.has(crewId) ? 'not-seated' : 'unknown' };
  if (!w.safe) return { ok: false, reason: 'unsafe' };
  return { ok: true, state: without(s, crewId), moved: from };
}

/** End a contract: the member leaves every seat and the roster and returns to their station's list. The paid fee is kept. */
export function dismiss(s: CrewState, crewId: string, w: CrewWorld): SeatResult {
  if (!CREW_BY_ID.has(crewId)) return { ok: false, reason: 'unknown' };
  if (!isHired(s, crewId)) return { ok: false, reason: 'not-hired' };
  if (!w.safe) return { ok: false, reason: 'unsafe' };
  const from = shipOf(s, crewId);
  const next = without(s, crewId);
  return { ok: true, state: { ...next, hired: next.hired.filter((id) => id !== crewId) }, moved: from };
}

/** P05.2: set the Navigator doctrine (a standing advisory preference; it never touches seats, fees or the roster). */
export function setDoctrine(s: CrewState, doctrine: NavDoctrine): CrewState {
  if ((s.doctrine ?? 'balanced') === doctrine) return s;
  const base: CrewState = { hired: s.hired, paid: s.paid, seats: s.seats };
  return doctrine === 'safety' ? { ...base, doctrine } : base;
}

/* ------------------------------------------------------------- invariants */

export interface CleanResult {
  readonly state: CrewState;
  /** Entries dropped or moved (0 = the input already held every invariant). */
  readonly changes: number;
  /** Crew who lost a seat and returned to the unassigned roster (still hired, never deleted). */
  readonly unseated: readonly string[];
}

/**
 * Make any crew-shaped input safe: known ids only, no duplicates, at most
 * MAX_HIRED hired, seated crew must be hired and sit once, seats only on
 * owned ships with room. Extra crew are unseated, never removed from the
 * roster. Idempotent: cleaning a clean state changes nothing.
 */
export function cleanCrew(
  raw: { readonly hired: readonly string[]; readonly paid: readonly string[]; readonly seats: Readonly<Record<string, readonly string[] | undefined>>; readonly doctrine?: string | undefined },
  owned: readonly ShipId[],
): CleanResult {
  let changes = 0;
  const hired: string[] = [];
  for (const id of raw.hired) {
    if (CREW_BY_ID.has(id) && !hired.includes(id) && hired.length < MAX_HIRED) hired.push(id);
    else changes += 1;
  }
  const paid: string[] = [];
  for (const id of raw.paid) {
    if (CREW_BY_ID.has(id) && !paid.includes(id)) paid.push(id);
    else changes += 1;
  }
  const seats: Partial<Record<ShipId, readonly string[]>> = {};
  const seated = new Set<string>();
  const unseated: string[] = [];
  for (const [ship, list] of Object.entries(raw.seats)) {
    if (!list) continue;
    const keep: string[] = [];
    const ownedShip = isShip(ship) && owned.includes(ship);
    const room = ownedShip ? seatCount(ship) : 0;
    for (const id of list) {
      if (!hired.includes(id) || seated.has(id)) {
        changes += 1; // unknown, not hired or already seated elsewhere: the seat entry is dropped
        continue;
      }
      if (keep.length >= room) {
        changes += 1;
        if (!unseated.includes(id)) unseated.push(id); // still hired: back on the roster
        continue;
      }
      keep.push(id);
      seated.add(id);
    }
    if (keep.length && isShip(ship)) seats[ship] = keep;
  }
  // P05.2: the Navigator doctrine; only 'safety' is stored ('balanced' is the absence of a choice)
  if (raw.doctrine !== undefined && raw.doctrine !== 'safety') changes += 1;
  const state: CrewState = raw.doctrine === 'safety' ? { hired, paid, seats, doctrine: 'safety' } : { hired, paid, seats };
  return { state, changes, unseated: unseated.filter((id) => !seated.has(id)) };
}

/** Re-check the seats against the fleet (after a fleet change). Returns the same object when nothing changed. */
export function reconcileCrew(s: CrewState, owned: readonly ShipId[]): CleanResult {
  const r = cleanCrew(s, owned);
  return r.changes === 0 ? { state: s, changes: 0, unseated: [] } : r;
}
