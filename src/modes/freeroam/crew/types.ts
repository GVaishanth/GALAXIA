/**
 * Crew model (P05.1): the shapes of the crew system. Pure types and a few
 * frozen constants; no DOM, no storage, no clock, no randomness.
 *
 * Two kinds of data, kept apart:
 *  - definitions (crew/data.ts): who a crew member is: id, name, role, bio,
 *    where and how they can be recruited, their rank and attributes. Fixed
 *    game data, identical for every save; never written to a save.
 *  - runtime state (CrewState): what this save has done with them: who has
 *    signed on, whose berth fee is paid, and who sits in which seat of which
 *    owned ship. Only ids, so a save never copies a definition.
 *
 * Attributes use one documented scale (ATTRIBUTE_SCALE): whole numbers
 * 1..5, 3 = a capable professional. They describe the person and are shown
 * on the Bridge. Since P05.2 they shape how an assigned Navigator or
 * Surveyor advises (crew/traits.ts holds the one documented mapping); they
 * never add a passive bonus to the ship, its physics, damage, currency or
 * progression. Rank is a label (and sets the berth fee); it changes no
 * behaviour, so it never duplicates an attribute.
 */
import type { UnlockRequirement } from '../catalogue/types.ts';
import type { ShipId } from '../ships/types.ts';

/* ------------------------------------------------------------------ roles */

export const CREW_ROLES = ['navigator', 'surveyor', 'engineer', 'defence', 'quartermaster'] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

/**
 * A capability a role brings. `stage` says whether it works now ('active':
 * built in P05.2, advice only) or is still planned ('later'), so the Bridge
 * never implies that a planned duty already works.
 */
export interface CrewCapability {
  readonly id: string;
  readonly name: string;
  /** One sentence for the Bridge: what it does now ('active'), or "Planned: ..." ('later'). */
  readonly text: string;
  readonly stage: 'active' | 'later';
}

export interface CrewRoleDef {
  readonly id: CrewRole;
  /** Upper-case card label ("NAVIGATOR"). */
  readonly label: string;
  /** Short duty line. */
  readonly duty: string;
  readonly capabilities: readonly CrewCapability[];
}

/* -------------------------------------------------------- rank, attributes */

export const CREW_RANKS = ['cadet', 'rated', 'veteran'] as const;
export type CrewRank = (typeof CREW_RANKS)[number];

export const CREW_ATTRIBUTES = ['competence', 'caution', 'focus'] as const;
export type CrewAttribute = (typeof CREW_ATTRIBUTES)[number];

/**
 * The attribute scale. Competence: skill at the role's own work. Caution: how
 * conservative their judgement is (high = prefers the safe line, warns early;
 * low = accepts risk). Focus: how steadily they keep to the task under
 * pressure. Higher is not always "better" for Caution: it is temperament.
 */
export const ATTRIBUTE_SCALE = Object.freeze({ min: 1, max: 5, typical: 3 });

export type CrewAttributes = Readonly<Record<CrewAttribute, number>>;

/* ---------------------------------------------------- recruitment, sources */

/**
 * Where a crew member can be signed on.
 *  - station: at one Haven Guild station (a real catalogue system with a
 *    station), for a one-time berth fee in Guild marks;
 *  - mission: after a story mission is completed, at any station, free;
 *  - rescue: after the pilot clears a distress beacon (a wreck-defence
 *    encounter) anywhere, at any station, free.
 */
export type CrewSource =
  | { readonly kind: 'station'; readonly systemId: string }
  | { readonly kind: 'mission'; readonly missionId: string }
  | { readonly kind: 'rescue'; readonly encounter: 'defence' };

/** What must be true before the crew member can be signed on (all must hold). */
export type CrewRequirement = { readonly kind: 'unlock'; readonly req: UnlockRequirement } | { readonly kind: 'mission'; readonly missionId: string } | { readonly kind: 'rescue'; readonly count: number };

export interface CrewDef {
  /** Stable id: never renamed (saves store it). Lower-case words with hyphens. */
  readonly id: string;
  readonly name: string;
  readonly role: CrewRole;
  /** Faction background, a fact about the fiction (never a gameplay modifier). */
  readonly background: 'haven-guild' | 'gleaners' | 'cordon' | 'independent';
  /** Two or three sentences for the Bridge. */
  readonly bio: string;
  readonly source: CrewSource;
  readonly rank: CrewRank;
  readonly attributes: CrewAttributes;
  /** Berth fee in Guild marks (crew/data.ts CREW_FEES; 0 = no fee). */
  readonly fee: number;
  readonly requirements: readonly CrewRequirement[];
}

/* ---------------------------------------------------------- runtime state */

/**
 * One save's crew. `hired`: signed on (hire order). `paid`: berth fee already
 * paid once (a dismissed member signs on again without paying twice).
 * `seats`: per owned ship, the crew in its seats in seat order. Invariants
 * (crew/state.ts cleanCrew keeps them): known ids only, no duplicates, every
 * seated member is hired, a member sits in at most one seat of one ship, a
 * ship never holds more crew than its seats. Nothing else is stored.
 */
export interface CrewState {
  readonly hired: readonly string[];
  readonly paid: readonly string[];
  readonly seats: Readonly<Partial<Record<ShipId, readonly string[]>>>;
  /** P05.2: the Navigator doctrine (a standing advisory preference; absent = 'balanced'). */
  readonly doctrine?: NavDoctrine | undefined;
}

/**
 * P05.2 Navigator doctrine: how an assigned Navigator advises. Advice only:
 * neither doctrine ever steers, brakes or changes the flight model.
 *  - balanced: concise route and gravity advice, momentum-keeping escape burns first;
 *  - safety: earlier hazard warnings, lower gravity thresholds, the escape
 *    burns with the widest margin first, and no optional route chatter.
 */
export const NAV_DOCTRINES = ['balanced', 'safety'] as const;
export type NavDoctrine = (typeof NAV_DOCTRINES)[number];

/** What the crew rules read from the rest of the game (the shell supplies it; tests build it by hand). */
export interface CrewWorld {
  /** System id of the station docked at, or null (in flight, on the map). */
  readonly docked: string | null;
  /** Docked with no hostile engaged: the only time crew may change seats (same rule as switching ships). */
  readonly safe: boolean;
  /** Ships this save owns (never Admin Access sandbox ships). */
  readonly owned: readonly ShipId[];
  readonly requirementMet: (req: UnlockRequirement) => boolean;
  readonly missionDone: (missionId: string) => boolean;
  /** Distress beacons cleared (wreck-defence sites in the saved sectors). */
  readonly rescues: number;
}
