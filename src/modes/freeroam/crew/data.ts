/**
 * Crew data (P05.1): the five roles, the berth fees and the curated recruit
 * roster. The only place crew content and crew prices live. Pure data.
 *
 * Roster rules:
 *  - small and hand-written: seven named people, no generated characters and
 *    no refreshing shop. Navigator and Surveyor (the roles with in-flight
 *    advice since P05.2) each have two recruits, one early and one later;
 *    the other three roles have one each;
 *  - every station recruit waits at a real station system of the catalogue
 *    (a gate hub or relay outpost: tests/crew.test.ts checks it), and every
 *    story recruit follows a real story mission (progression/missionData.ts);
 *  - the rescue recruit follows the existing distress-beacon (wreck defence)
 *    encounter: no new mission, encounter or destination is introduced;
 *  - names and bios are original and fit the factions (Haven Guild, the
 *    Gleaner scavengers, a Cordon defector).
 *
 * Fees (Guild marks, one time, never wages or upkeep): set by rank and paid
 * only for station recruits; story and rescue recruits sign on free, because
 * the pilot already earned them in play. The numbers sit inside the existing
 * economy (ships/upgrades.ts, progression/missionData.ts):
 *  - Mk I upgrades cost 50–60 marks, Mk II 140–160, Mk III 320–360; story
 *    missions pay 60–300 and the first ones 60–150 (MARKS.starting is 0);
 *  - a rated specialist (130) costs about one early story reward, so the
 *    first hire is a choice made after the first missions, not at the start;
 *  - the veteran (220) costs more than an Mk II upgrade and less than an
 *    Mk III, and is gated behind the third story mission anyway.
 * No crew member is needed to finish the game: crew are optional.
 */
import type { CrewDef, CrewRank, CrewRole, CrewRoleDef, CrewSource } from './types.ts';

/** One-time berth fee by rank (station recruits only). */
export const CREW_FEES: Readonly<Record<CrewRank, number>> = Object.freeze({ cadet: 80, rated: 130, veteran: 220 });

/** Most crew a save can have signed on at once (the roster size; a bound for saves, not a gameplay cap). */
export const MAX_HIRED = 12;

export const RANK_LABEL: Readonly<Record<CrewRank, string>> = Object.freeze({ cadet: 'CADET', rated: 'RATED', veteran: 'VETERAN' });

export const ROLE_DEFS: readonly CrewRoleDef[] = Object.freeze([
  {
    id: 'navigator',
    label: 'NAVIGATOR',
    duty: 'Plots lanes and reads the route ahead.',
    capabilities: [
      { id: 'gravity-watch', name: 'Gravity watch', text: 'Forecasts the drift past planets and stars, warns of a collision or a corona earlier than the Ship Mind, and names an escape burn checked against the same forecast.', stage: 'active' },
      { id: 'pull-reading', name: 'Pull reading', text: 'Explains a strong pull: which body, which way, how it compares with the engine, and when STOP cannot hold against it.', stage: 'active' },
      { id: 'route-notes', name: 'Route notes', text: 'On arrival, gives the exit beacon bearing and whether the reactor cells cover the lanes out of this system.', stage: 'active' },
      { id: 'route-planning', name: 'Route planning', text: 'Planned: suggestions on the system map before a jump.', stage: 'later' },
    ],
  },
  {
    id: 'surveyor',
    label: 'SURVEYOR',
    duty: 'Reads the sensors and runs the survey.',
    capabilities: [
      { id: 'signal-reading', name: 'Signal reading', text: 'Interprets new sensor contacts: what they are, where they lie, whether they are in reach and whether they count toward the survey.', stage: 'active' },
      { id: 'survey-guidance', name: 'Survey guidance', text: 'Tracks the survey marks on sensors, and says when none are left in sensor range.', stage: 'active' },
      { id: 'triangulation', name: 'Signal triangulation', text: 'Planned: bearings for tracing hidden signals (a later milestone).', stage: 'later' },
    ],
  },
  {
    id: 'engineer',
    label: 'ENGINEER',
    duty: 'Keeps the hull, drive and modules running.',
    capabilities: [
      { id: 'damage-report', name: 'Damage reports', text: 'Planned: plain-language reports on hull and module state.', stage: 'later' },
      { id: 'fit-advice', name: 'Fit advice', text: 'Planned: notes on modules that suit the ship flown.', stage: 'later' },
    ],
  },
  {
    id: 'defence',
    label: 'DEFENCE OFFICER',
    duty: 'Watches for threats and reads a fight.',
    capabilities: [
      { id: 'threat-calls', name: 'Threat calls', text: 'Planned: early calls on hostile contacts and their intent.', stage: 'later' },
      { id: 'engagement-notes', name: 'Engagement notes', text: 'Planned: a short read on whether a fight is worth taking.', stage: 'later' },
    ],
  },
  {
    id: 'quartermaster',
    label: 'QUARTERMASTER',
    duty: 'Keeps the hold, the stores and the books.',
    capabilities: [
      { id: 'hold-planning', name: 'Hold planning', text: 'Planned: notes on what the hold carries and what it lacks.', stage: 'later' },
      { id: 'trade-notes', name: 'Trade notes', text: 'Planned: reminders of what this station buys.', stage: 'later' },
    ],
  },
] satisfies CrewRoleDef[]);

export const ROLE_BY_ID: ReadonlyMap<CrewRole, CrewRoleDef> = new Map(ROLE_DEFS.map((r) => [r.id, r]));

/** The berth fee a recruit pays: the rank fee at a station, nothing for story and rescue recruits. */
export const feeFor = (source: CrewSource, rank: CrewRank): number => (source.kind === 'station' ? CREW_FEES[rank] : 0);

type DefInput = Omit<CrewDef, 'fee'>;
const def = (d: DefInput): CrewDef => ({ ...d, fee: feeFor(d.source, d.rank) });

export const CREW: readonly CrewDef[] = Object.freeze([
  def({
    id: 'maren-sato',
    name: 'Maren Sato',
    role: 'navigator',
    background: 'haven-guild',
    bio: 'Flew Guild couriers out of Sol for eleven years and knows the inner lanes by their beacons. She will not cut a corner she has not flown twice.',
    source: { kind: 'station', systemId: 'milky-way/sol' },
    rank: 'rated',
    attributes: { competence: 3, caution: 4, focus: 3 },
    requirements: [],
  }),
  def({
    id: 'tobiah-renn',
    name: 'Tobiah Renn',
    role: 'navigator',
    background: 'haven-guild',
    bio: 'Navigator of the Guild hauler that went quiet in Silent Hull. Once its log was recovered he took the next berth home, and he would rather fly with the pilot who came looking.',
    source: { kind: 'mission', missionId: 'story-silent-hull' },
    rank: 'veteran',
    attributes: { competence: 4, caution: 2, focus: 4 },
    requirements: [{ kind: 'mission', missionId: 'story-silent-hull' }],
  }),
  def({
    id: 'odile-marchetti',
    name: 'Odile Marchetti',
    role: 'surveyor',
    background: 'haven-guild',
    bio: "Draws the Guild's charts at Morrow's Anchor and is tired of drawing other people's. She signs on with a pilot who has finished a survey run of their own.",
    source: { kind: 'station', systemId: 'milky-way/morrows-anchor' },
    rank: 'rated',
    attributes: { competence: 4, caution: 3, focus: 3 },
    requirements: [{ kind: 'unlock', req: { kind: 'surveys', count: 1 } }],
  }),
  def({
    id: 'ilan-sefton',
    name: 'Ilan Sefton',
    role: 'surveyor',
    background: 'independent',
    bio: 'The instrument tech who logged the Lantern Echo readings and wants to know what answered the beacon. Unproven in the field and very hard to distract.',
    source: { kind: 'mission', missionId: 'story-lantern-echo' },
    rank: 'cadet',
    attributes: { competence: 3, caution: 2, focus: 5 },
    requirements: [{ kind: 'mission', missionId: 'story-lantern-echo' }],
  }),
  def({
    id: 'brask-ottley',
    name: 'Brask Ottley',
    role: 'engineer',
    background: 'gleaners',
    bio: 'A Gleaner salvage-wright whose crew was pinned down at a distress beacon. After watching you hold the wreck, he decided your hull was the safer one to keep running.',
    source: { kind: 'rescue', encounter: 'defence' },
    rank: 'rated',
    attributes: { competence: 4, caution: 3, focus: 2 },
    requirements: [{ kind: 'rescue', count: 1 }],
  }),
  def({
    id: 'corin-vasht',
    name: 'Corin Vasht',
    role: 'defence',
    background: 'cordon',
    bio: 'Held a Cordon picket line until she stopped believing in it. She waits at Lantern Gate for a pilot who has already shown that the patrols can be beaten.',
    source: { kind: 'station', systemId: 'milky-way/lantern-gate' },
    rank: 'veteran',
    attributes: { competence: 4, caution: 4, focus: 3 },
    requirements: [{ kind: 'mission', missionId: 'story-quiet-lanes' }],
  }),
  def({
    id: 'hesper-quaye',
    name: 'Hesper Quaye',
    role: 'quartermaster',
    background: 'haven-guild',
    bio: 'Kept the stores at Kestrel Verge balanced to the last cell for a decade. She wants a pilot who brings cargo home, not one who scatters it across the lanes.',
    source: { kind: 'station', systemId: 'milky-way/kestrel-verge' },
    rank: 'rated',
    attributes: { competence: 3, caution: 5, focus: 3 },
    requirements: [{ kind: 'mission', missionId: 'story-scrap-and-signal' }],
  }),
] satisfies CrewDef[]);

export const CREW_BY_ID: ReadonlyMap<string, CrewDef> = new Map(CREW.map((c) => [c.id, c]));
