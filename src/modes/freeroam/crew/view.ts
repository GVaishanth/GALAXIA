/**
 * The read-only crew view (P05.1): what the crew of one ship looks like to
 * the rest of the game. The P05.2 behaviours (Navigator, Surveyor, Ship
 * Mind) read crew only through this.
 *
 *  - Deeply frozen: a reader can never change a seat, a member or an
 *    attribute through it.
 *  - Built when the crew or the flown ship changes (the shell caches it),
 *    never per frame, so reading it allocates nothing.
 *  - It is information only. It exposes no handle on input, the ship's
 *    position, weapons, the lock, the wallet or progression, and it never
 *    grants a bonus: in P05.1 nothing in flight reads it at all.
 */
import { CREW_BY_ID } from './data.ts';
import { crewAboard, seatCount } from './state.ts';
import type { CrewAttributes, CrewRank, CrewRole, CrewState } from './types.ts';
import type { ShipId } from '../ships/types.ts';

export interface CrewMemberView {
  readonly id: string;
  readonly name: string;
  readonly role: CrewRole;
  readonly rank: CrewRank;
  readonly attributes: CrewAttributes;
  /** 0-based seat index on this ship. */
  readonly seat: number;
}

export interface ShipCrewView {
  readonly ship: ShipId;
  readonly seats: number;
  /** Seated crew in seat order (empty = flying solo, always valid). */
  readonly members: readonly CrewMemberView[];
  /** Roles present aboard, in seat order without repeats. */
  readonly roles: readonly CrewRole[];
}

/** The first member aboard with a role, or null. */
export const memberWithRole = (v: ShipCrewView, role: CrewRole): CrewMemberView | null => v.members.find((m) => m.role === role) ?? null;

export const hasRole = (v: ShipCrewView, role: CrewRole): boolean => v.roles.includes(role);

export function shipCrewView(s: CrewState, ship: ShipId): ShipCrewView {
  const members: CrewMemberView[] = [];
  crewAboard(s, ship).forEach((id, seat) => {
    const d = CREW_BY_ID.get(id);
    if (d) members.push(Object.freeze({ id: d.id, name: d.name, role: d.role, rank: d.rank, attributes: Object.freeze({ ...d.attributes }), seat }));
  });
  const roles: CrewRole[] = [];
  for (const m of members) if (!roles.includes(m.role)) roles.push(m.role);
  return Object.freeze({ ship, seats: seatCount(ship), members: Object.freeze(members), roles: Object.freeze(roles) });
}
