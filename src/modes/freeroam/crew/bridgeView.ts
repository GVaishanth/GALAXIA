/**
 * Bridge view model (P05.1): everything the BRIDGE section of the hangar
 * shows, as plain data. Pure: no DOM, no storage, no clock. The panel
 * (crew/ui/bridgeSection.ts) renders it; every rule comes from
 * crew/state.ts and crew/recruit.ts, every number from crew/data.ts and the
 * ship roster.
 *
 * Honesty rules for the wording:
 *  - a duty is called active only when it works (P05.2: the first Navigator
 *    and the first Surveyor seated on the flown ship advise in flight);
 *    everything else is worded as planned. Advice never flies, fights,
 *    trades or travels for the pilot, and the Bridge says so;
 *  - flying solo is stated as fully valid;
 *  - a refused action always says why (capacity, ownership, docking, a
 *    requirement with its real progress, the marks missing).
 *
 * Building the model reads state only: opening or refreshing the Bridge
 * never changes the crew, the wallet or the save.
 */
import type { UnlockRequirement } from '../catalogue/types.ts';
import { insufficientText, formatMarks, afford } from '../progression/ledger.ts';
import { STORY_BY_ID } from '../progression/missionData.ts';
import { SHIP_BY_ID } from '../ships/roster.ts';
import type { ShipId } from '../ships/types.ts';
import { CREW_BY_ID, RANK_LABEL, ROLE_BY_ID } from './data.ts';
import { feeDue, hireRefusal, recruitList, recruitStation, requirementMet, type HireRefusal, type RecruitState } from './recruit.ts';
import { assignRefusal, crewAboard, seatCount, shipOf, type SeatRefusal } from './state.ts';
import { traitLines } from './traits.ts';
import { ATTRIBUTE_SCALE, CREW_ATTRIBUTES, type CrewAttribute, type CrewDef, type CrewRequirement, type CrewRole, type CrewState, type CrewWorld, type NavDoctrine } from './types.ts';

/** What the Bridge reads (the shell supplies it; tests build it by hand). */
export interface BridgeContext {
  /** The ship inspected in the hangar. */
  readonly ship: ShipId;
  /** The ship flown. */
  readonly flown: ShipId;
  readonly crew: CrewState;
  readonly world: CrewWorld;
  /** Guild marks balance. */
  readonly balance: number;
  /** Admin Access: hires cost nothing and record nothing. */
  readonly free: boolean;
  /** Licence-style requirement wording with real progress (galaxy/progress.ts describeRequirement). */
  readonly describe: (req: UnlockRequirement) => { readonly title?: string; readonly detail: string; readonly met: boolean; readonly progress?: string | null };
  /** Display name of a station system ("Sol"). */
  readonly stationName: (systemId: string) => string;
}

export interface AttributeLine {
  readonly key: CrewAttribute;
  readonly label: string;
  readonly value: number;
  readonly max: number;
}

export interface MemberCard {
  readonly id: string;
  readonly name: string;
  readonly roleLabel: string;
  readonly rankLabel: string;
  readonly background: string;
  readonly bio: string;
  readonly duty: string;
  readonly attributes: readonly AttributeLine[];
  /** The role's capabilities: what works now, then what is planned. */
  readonly contribution: readonly string[];
  /** P05.2: what each attribute does for this role (crew/traits.ts), empty for roles without flight duties yet. */
  readonly traits: readonly string[];
}

export interface BridgeAction {
  readonly enabled: boolean;
  readonly label: string;
  /** Why it is refused (empty when enabled). */
  readonly reason: string;
}

export interface SeatCard {
  readonly index: number;
  readonly member: MemberCard | null;
  readonly unassign: BridgeAction | null;
  /** P05.2: "ON DUTY · ...", "STANDBY · ..." or "NO FLIGHT DUTY YET" (empty for an empty seat). */
  readonly status: string;
  readonly onDuty: boolean;
}

/** P05.2: the Navigator doctrine control (shown once a Navigator has signed on). */
export interface DoctrineRow {
  readonly value: NavDoctrine;
  /** "BALANCED" / "SAFETY-FIRST". */
  readonly label: string;
  readonly text: string;
  readonly toggle: BridgeAction;
  readonly next: NavDoctrine;
}

export interface RosterEntry {
  readonly card: MemberCard;
  /** "UNASSIGNED" or "ABOARD THE CONDOR". */
  readonly where: string;
  readonly assign: BridgeAction;
  readonly dismiss: BridgeAction;
}

export interface RequirementLine {
  readonly text: string;
  readonly met: boolean;
}

export interface RecruitEntry {
  readonly card: MemberCard;
  readonly state: RecruitState;
  /** "WAITS AT SOL STATION" / "SIGNS ON AT ANY GUILD STATION". */
  readonly location: string;
  /** Fee due now (0 = free). */
  readonly fee: number;
  readonly feeText: string;
  /** Balance now and after paying (null after = not affordable or free). */
  readonly balanceText: string;
  readonly requirements: readonly RequirementLine[];
  readonly hire: BridgeAction;
}

export interface BridgeModel {
  readonly shipName: string;
  readonly owned: boolean;
  readonly flown: boolean;
  readonly seats: number;
  readonly occupied: number;
  readonly unassigned: number;
  readonly hired: number;
  /** One summary line ("PETREL · 2 SEATS · 1 OCCUPIED · 1 UNASSIGNED"). */
  readonly summary: string;
  /** Solo play and the not-active-yet notice. */
  readonly notes: readonly string[];
  readonly seatCards: readonly SeatCard[];
  readonly roster: readonly RosterEntry[];
  readonly recruits: readonly RecruitEntry[];
  /** Shown instead of the recruit list when it is empty. */
  readonly recruitEmpty: string;
  readonly balance: string;
  readonly doctrine: DoctrineRow | null;
}

const ATTRIBUTE_LABEL: Readonly<Record<CrewAttribute, string>> = Object.freeze({ competence: 'COMPETENCE', caution: 'CAUTION', focus: 'FOCUS' });
const BACKGROUND_LABEL: Readonly<Record<CrewDef['background'], string>> = Object.freeze({ 'haven-guild': 'Haven Guild', gleaners: 'Gleaner scavenger', cordon: 'Former Cordon officer', independent: 'Independent' });

export const ACTIVE_NOTE = 'In flight, a Navigator or Surveyor seated on the ship you fly gives advice: the pilot decides, and crew never steer, brake, fire, lock, pay or travel. The Ship Mind advises every pilot, crew or not. Engineer, Defence and Quartermaster duties are planned for later updates.';
/** The roles with in-flight duties (P05.2). */
export const ADVISING_ROLES: readonly CrewRole[] = Object.freeze(['navigator', 'surveyor']);
export const DOCTRINE_LABEL: Readonly<Record<NavDoctrine, string>> = Object.freeze({ balanced: 'BALANCED', safety: 'SAFETY-FIRST' });
export const DOCTRINE_TEXT: Readonly<Record<NavDoctrine, string>> = Object.freeze({
  balanced: 'Balanced: concise gravity and route advice; escape burns that keep momentum are named first.',
  safety: 'Safety-first: hazard warnings a second earlier, gravity explained at lower pulls, the widest-margin escape burns first, and no optional route notes. Advice only: the Navigator never flies the ship.',
});
export const SOLO_NOTE = 'Flying solo is fully supported. Crew are optional and never needed to finish the game.';

const upperShip = (id: ShipId): string => SHIP_BY_ID.get(id)!.name.toUpperCase();

export function memberCard(d: CrewDef, doctrine: NavDoctrine = 'balanced'): MemberCard {
  const role = ROLE_BY_ID.get(d.role)!;
  return {
    id: d.id,
    name: d.name,
    roleLabel: role.label,
    rankLabel: RANK_LABEL[d.rank],
    background: BACKGROUND_LABEL[d.background],
    bio: d.bio,
    duty: role.duty,
    attributes: CREW_ATTRIBUTES.map((k) => ({ key: k, label: ATTRIBUTE_LABEL[k], value: d.attributes[k], max: ATTRIBUTE_SCALE.max })),
    contribution: [...role.capabilities.filter((c) => c.stage === 'active'), ...role.capabilities.filter((c) => c.stage !== 'active')].map((c) => (c.stage === 'active' ? `${c.name}: ${c.text}` : `${c.name} (planned): ${c.text.replace(/^Planned: /, '')}`)),
    traits: traitLines(d.role, d.attributes, doctrine),
  };
}

export function seatRefusalText(r: SeatRefusal, ship: ShipId): string {
  const name = SHIP_BY_ID.get(ship)?.name ?? ship;
  switch (r) {
    case 'not-owned':
      return `Acquire the ${name} first: only ships you own carry crew.`;
    case 'no-seats':
      return `The ${name} has no crew seats.`;
    case 'full':
      return `All ${seatCount(ship)} seat${seatCount(ship) === 1 ? '' : 's'} on the ${name} are taken. Unassign someone first.`;
    case 'unsafe':
      return 'Crew change seats only while docked with no hostiles engaged.';
    case 'already':
      return `Already aboard the ${name}.`;
    case 'not-hired':
      return 'Not on your roster.';
    case 'not-seated':
      return 'Not in a seat.';
    case 'unknown':
      return 'Unknown crew member.';
  }
}

export function requirementText(r: CrewRequirement, c: Pick<BridgeContext, 'describe' | 'world'>): RequirementLine {
  const met = requirementMet(r, c.world);
  if (r.kind === 'unlock') {
    const info = c.describe(r.req);
    return { text: `${info.title ? `${info.title}: ` : ''}${info.detail}${info.progress ? ` (${info.progress})` : ''}`, met };
  }
  if (r.kind === 'mission') return { text: `Complete the story mission “${STORY_BY_ID.get(r.missionId)?.title ?? r.missionId}”`, met };
  return { text: `Clear a distress beacon: hold off the attack on a wreck until it is safe (${Math.min(c.world.rescues, r.count)}/${r.count})`, met };
}

export function hireRefusalText(r: HireRefusal, d: CrewDef, c: BridgeContext, fee: number): string {
  switch (r) {
    case 'locked': {
      const first = d.requirements.map((q) => requirementText(q, c)).find((q) => !q.met);
      return `Locked · ${first ? first.text : 'requirement not met'}.`;
    }
    case 'elsewhere':
    case 'undocked': {
      const at = recruitStation(d);
      return at ? `Signs on only at ${c.stationName(at)} station.` : 'Dock at any station to sign on.';
    }
    case 'insufficient':
      return insufficientText(fee, c.balance);
    case 'roster-full':
      return 'Your roster is full: dismiss someone first.';
    case 'hired':
      return 'Already on your roster.';
    case 'duplicate':
      return 'That hire was already processed.';
    default:
      return 'The hire could not be completed; nothing was charged.';
  }
}

export function bridgeModel(c: BridgeContext): BridgeModel {
  const ship = SHIP_BY_ID.get(c.ship)!;
  const seats = seatCount(c.ship);
  const owned = c.world.owned.includes(c.ship);
  const aboard = owned ? crewAboard(c.crew, c.ship) : [];
  const unassignedIds = c.crew.hired.filter((id) => shipOf(c.crew, id) === null);
  const doctrine: NavDoctrine = c.crew.doctrine ?? 'balanced';
  const flown = c.ship === c.flown;

  // P05.2 duty status: the first seated Navigator and the first seated Surveyor advise (crew/advisor.ts advisorCrew reads the same order)
  const firstOfRole = new Map<CrewRole, string>();
  for (const id of aboard) {
    const d = CREW_BY_ID.get(id);
    if (d && !firstOfRole.has(d.role)) firstOfRole.set(d.role, id);
  }
  const seatStatus = (d: CrewDef): { status: string; onDuty: boolean } => {
    if (!ADVISING_ROLES.includes(d.role)) return { status: 'NO FLIGHT DUTY YET · planned for a later update', onDuty: false };
    if (firstOfRole.get(d.role) !== d.id) return { status: `STANDBY · the first ${ROLE_BY_ID.get(d.role)!.label.toLowerCase()} seated gives the advice`, onDuty: false };
    if (!flown) return { status: `ADVISES WHEN THE ${upperShip(c.ship)} IS FLOWN`, onDuty: false };
    return { status: d.role === 'navigator' ? 'ON DUTY · gravity watch, pull reading, route notes' : 'ON DUTY · signal reading, survey guidance', onDuty: true };
  };

  const seatCards: SeatCard[] = [];
  for (let i = 0; i < seats; i++) {
    const id = aboard[i];
    const d = id ? CREW_BY_ID.get(id) : undefined;
    seatCards.push({
      index: i,
      member: d ? memberCard(d, doctrine) : null,
      unassign: d ? { enabled: c.world.safe, label: 'UNASSIGN', reason: c.world.safe ? '' : seatRefusalText('unsafe', c.ship) } : null,
      ...(d ? seatStatus(d) : { status: '', onDuty: false }),
    });
  }

  // the roster: everyone hired who is not in this ship's seats (unassigned first, then crew aboard other ships)
  const others = c.crew.hired.filter((id) => !aboard.includes(id));
  others.sort((a, b) => Number(shipOf(c.crew, a) !== null) - Number(shipOf(c.crew, b) !== null));
  const roster: RosterEntry[] = others.flatMap((id) => {
    const d = CREW_BY_ID.get(id);
    if (!d) return [];
    const at = shipOf(c.crew, id);
    const refusal = assignRefusal(c.crew, id, c.ship, c.world);
    const label = at ? `MOVE TO ${upperShip(c.ship)}` : `ASSIGN TO ${upperShip(c.ship)}`;
    return [
      {
        card: memberCard(d, doctrine),
        where: at ? `ABOARD THE ${upperShip(at)}` : 'UNASSIGNED',
        assign: { enabled: refusal === null, label, reason: refusal ? seatRefusalText(refusal, c.ship) : '' },
        dismiss: { enabled: c.world.safe, label: 'DISMISS', reason: c.world.safe ? '' : 'Contracts end only while docked with no hostiles engaged.' },
      },
    ];
  });

  const recruits: RecruitEntry[] = recruitList(c.crew, c.world).map(({ def: d, state }) => {
    const fee = feeDue(d, c.crew, c.free);
    const at = recruitStation(d);
    const refusal = hireRefusal(d, c.crew, c.world) ?? (fee > 0 && !afford(c.balance, fee).ok ? 'insufficient' : null);
    const feeText = c.free && d.fee > 0 ? 'FREE · ADMIN ACCESS' : fee > 0 ? `${formatMarks(fee)} · ONE-TIME BERTH FEE` : d.fee > 0 ? 'FEE ALREADY PAID' : 'NO FEE';
    const after = c.balance - fee;
    const balanceText = fee > 0 ? `BALANCE ${formatMarks(c.balance)} → ${after >= 0 ? formatMarks(after) : 'NOT ENOUGH'}` : `BALANCE ${formatMarks(c.balance)} · UNCHANGED`;
    return {
      card: memberCard(d),
      state,
      location: at ? `WAITS AT ${c.stationName(at).toUpperCase()} STATION` : 'SIGNS ON AT ANY STATION',
      fee,
      feeText,
      balanceText,
      requirements: d.requirements.map((r) => requirementText(r, c)),
      hire: { enabled: refusal === null, label: fee > 0 ? `SIGN ON · ${formatMarks(fee)}` : 'SIGN ON · FREE', reason: refusal ? hireRefusalText(refusal, d, c, fee) : '' },
    };
  });

  const occupied = aboard.length;
  const parts = [`${ship.name.toUpperCase()}`, `${seats} CREW SEAT${seats === 1 ? '' : 'S'}`, `${occupied} OCCUPIED`, `${unassignedIds.length} UNASSIGNED`];
  const notes = [SOLO_NOTE, ACTIVE_NOTE];
  const hasNavigator = c.crew.hired.some((id) => CREW_BY_ID.get(id)?.role === 'navigator');
  const next: NavDoctrine = doctrine === 'safety' ? 'balanced' : 'safety';
  const doctrineRow: DoctrineRow | null = hasNavigator
    ? { value: doctrine, label: DOCTRINE_LABEL[doctrine], text: DOCTRINE_TEXT[doctrine], next, toggle: { enabled: true, label: `NAVIGATOR DOCTRINE · ${DOCTRINE_LABEL[doctrine]}`, reason: '' } }
    : null;
  if (!owned) notes.unshift(`Not owned: the ${ship.name} would carry ${seats} crew once acquired.`);
  return {
    shipName: ship.name,
    owned,
    flown,
    seats,
    occupied,
    unassigned: unassignedIds.length,
    hired: c.crew.hired.length,
    summary: parts.join('\u00a0· '),
    notes,
    seatCards,
    roster,
    recruits,
    recruitEmpty: recruits.length ? '' : 'Every recruit has signed on. A dismissed crew member returns to the station where they signed on.',
    balance: c.free ? `${formatMarks(c.balance)} · ADMIN ACCESS` : formatMarks(c.balance),
    doctrine: doctrineRow,
  };
}
