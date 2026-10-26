/**
 * Crew persistence adapter (P05.1): the only crew file that knows the save
 * shape (profile.ts SavedCrew). Pure.
 *
 *  - Loading: a missing field is the empty crew (old saves, and saves that
 *    never hired). Ids are checked against this build's crew roster and the
 *    fleet (crew/state.ts cleanCrew): unknown or duplicate ids are dropped,
 *    seats on ships the save does not own and seats over a ship's capacity
 *    are released, and those crew stay on the unassigned roster.
 *  - Saving: the empty crew writes no field, so a save that never touched
 *    crew is byte-for-byte what it was before P05.1.
 *  - Loading never adds anyone: nothing here (or anywhere) grants crew.
 *  - P05.2: the Navigator doctrine rides along only when it is 'safety'.
 */
import type { SavedCrew } from '../profile.ts';
import type { ShipId } from '../ships/types.ts';
import { cleanCrew, EMPTY_CREW, type CleanResult } from './state.ts';
import type { CrewState } from './types.ts';

export function crewFromSaved(saved: SavedCrew | undefined, owned: readonly ShipId[]): CleanResult {
  if (!saved) return { state: EMPTY_CREW, changes: 0, unseated: [] };
  return cleanCrew(saved, owned);
}

export function crewToSaved(s: CrewState): SavedCrew | undefined {
  const seats: Record<string, readonly string[]> = {};
  for (const [ship, ids] of Object.entries(s.seats)) if (ids && ids.length) seats[ship] = [...ids];
  if (!s.hired.length && !s.paid.length && !Object.keys(seats).length) return undefined;
  // P05.2: the doctrine is written only when it is not the default, so P05.1 saves round-trip unchanged
  return s.doctrine === 'safety' ? { hired: [...s.hired], paid: [...s.paid], seats, doctrine: 'safety' } : { hired: [...s.hired], paid: [...s.paid], seats };
}
