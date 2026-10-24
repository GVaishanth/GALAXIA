/**
 * Guild marks rewards (Economy pass): which gameplay events pay marks, how
 * much, and the limits that stop farming. Pure: GameEvents in, claims out;
 * the shell pays a claim through ledger.ts `award` and saves.
 *
 *  - bounty      a hostile ship destroyed by the pilot. Scaled by toughness
 *                (hull + shield). Carrier-launched drones pay nothing (a
 *                capital launches them without end). Each system has a
 *                bounty pool (REWARDS.bountyPool) per period of
 *                REWARDS.bountyWindowJumps lane hops, counted by the saved
 *                jump counter, so leaving and coming back cannot refill it
 *                at once and repeated kills cannot be farmed without limit.
 *  - encounter   an encounter cleared. Paid once: cleared encounters are saved
 *                in the sector's `done` list and never re-created.
 *  - discovery   an anomaly investigated or a derelict inspected (once: the
 *                exploration record keeps each `system#poi` once), a system
 *                charted by a survey run (once: charting happens once), a
 *                galaxy reached for the first time.
 *
 * Mission rewards keep their own amounts (missionData.ts, contracts.ts) and
 * are claimed at stations (station.ts). Ordinary resource collection pays
 * cargo, which sells for marks at an exchange; it adds no marks by itself.
 */
import { FAMILIES, type FamilyId } from '../combat/families.ts';
import type { EncounterKind } from '../sector/model.ts';
import type { EntryKind } from './ledger.ts';
import type { GameEvent } from './events.ts';

export const REWARDS = Object.freeze({
  /** Marks per hostile destroyed by the pilot, by family (about one mark per 20 points of hull + shield, at least 3). */
  bounty: Object.freeze({ raider: 3, recon: 3, picket: 4, lancer: 5, hauler: 8, heavy: 10, elite: 16, capital: 40 } satisfies Record<FamilyId, number>),
  /** Bounty marks one system pays per period. */
  bountyPool: 60,
  /** The period, in lane hops flown (the saved jump counter). */
  bountyWindowJumps: 6,
  /** Most systems tracked at once (expired windows are pruned first). */
  bountyBookMax: 128,
  /** Encounter completion, by kind (once per encounter). */
  encounter: Object.freeze({ ambush: 25, defence: 30, dispute: 25, outpost: 40, elite: 60, capital: 90 } satisfies Record<EncounterKind, number>),
  /** First-time discoveries. */
  discovery: Object.freeze({ anomaly: 15, derelict: 10, charted: 20, galaxy: 50 }),
});

export interface BountyWindow {
  /** Bounty marks paid in this system during the period. */
  readonly paid: number;
  /** Jump counter when the period opened. */
  readonly since: number;
}

export type BountyBook = Readonly<Record<string, BountyWindow>>;

export interface MarksClaim {
  readonly amount: number;
  readonly kind: EntryKind;
  readonly label: string;
  /** Claim id for duplicate refusal (ledger `recent`). */
  readonly id: string;
}

const open = (w: BountyWindow | undefined, jumps: number): boolean => !!w && jumps - w.since < REWARDS.bountyWindowJumps && jumps >= w.since;

/** Bounty marks this system can still pay in the current period. */
export function bountyLeft(book: BountyBook, systemId: string, jumps: number): number {
  const w = book[systemId];
  return open(w, jumps) ? Math.max(0, REWARDS.bountyPool - w!.paid) : REWARDS.bountyPool;
}

/** Hops until the system's pool refills (0 = full now). */
export function bountyRefillIn(book: BountyBook, systemId: string, jumps: number): number {
  const w = book[systemId];
  return open(w, jumps) ? REWARDS.bountyWindowJumps - (jumps - w!.since) : 0;
}

/** Drop expired windows; keep at most bountyBookMax systems (the most recent windows). */
export function pruneBounties(book: BountyBook, jumps: number): BountyBook {
  const live = Object.entries(book).filter(([, w]) => open(w, jumps));
  live.sort((a, b) => b[1].since - a[1].since);
  return Object.fromEntries(live.slice(0, REWARDS.bountyBookMax));
}

/** The bounty a kill earns before the pool limit (0 = none: not the pilot's kill, or a launched drone). */
export function bountyBase(e: Extract<GameEvent, { type: 'hostile-destroyed' }>): number {
  if (e.role === 'launched') return 0;
  return (REWARDS.bounty as Readonly<Record<string, number>>)[e.family] ?? 0;
}

/**
 * Pay a kill from the system's pool: the claim (null = nothing due) and the updated book.
 * `seq` makes the claim id unique per kill (the run's kill counter).
 */
export function bountyClaim(book: BountyBook, e: Extract<GameEvent, { type: 'hostile-destroyed' }>, jumps: number, seq: string): { readonly claim: MarksClaim | null; readonly book: BountyBook; readonly limited: boolean } {
  const base = bountyBase(e);
  if (base <= 0) return { claim: null, book, limited: false };
  const left = bountyLeft(book, e.systemId, jumps);
  const amount = Math.min(base, left);
  if (amount <= 0) return { claim: null, book, limited: true };
  const w = book[e.systemId];
  const next: BountyWindow = open(w, jumps) ? { paid: w!.paid + amount, since: w!.since } : { paid: amount, since: jumps };
  const label = FAMILIES[e.family as FamilyId]?.label ?? 'Hostile';
  return { claim: { amount, kind: 'bounty', label: `Bounty · ${label}`, id: `kill:${e.systemId}:${seq}` }, book: pruneBounties({ ...book, [e.systemId]: next }, jumps), limited: amount < base };
}

export interface DiscoveryContext {
  /** The exploration record changed with this event (a new anomaly or wreck entry). */
  readonly newEntry: boolean;
  readonly systemName: (id: string) => string;
  readonly galaxyName: (id: string) => string;
}

const ENCOUNTER_NAME: Readonly<Record<EncounterKind, string>> = { ambush: 'Ambush', defence: 'Defence', dispute: 'Salvage dispute', outpost: 'Outpost', elite: 'Elite', capital: 'Capital ship' };

/** A once-only reward due for this event (encounters and discoveries; bounties go through bountyClaim). */
export function eventClaim(e: GameEvent, ctx: DiscoveryContext): MarksClaim | null {
  switch (e.type) {
    case 'encounter-cleared': {
      const amount = REWARDS.encounter[e.kind] ?? 0;
      return amount > 0 ? { amount, kind: 'encounter', label: `${ENCOUNTER_NAME[e.kind] ?? 'Encounter'} cleared · ${ctx.systemName(e.systemId)}`, id: `enc:${e.systemId}#${e.encounterId}` } : null;
    }
    case 'poi-completed': {
      if (!ctx.newEntry) return null;
      if (e.kind === 'anomaly') return { amount: REWARDS.discovery.anomaly, kind: 'discovery', label: `Anomaly investigated · ${ctx.systemName(e.systemId)}`, id: `poi:${e.systemId}#${e.poiId}` };
      if (e.kind === 'derelict') return { amount: REWARDS.discovery.derelict, kind: 'discovery', label: `Derelict inspected · ${ctx.systemName(e.systemId)}`, id: `poi:${e.systemId}#${e.poiId}` };
      return null;
    }
    case 'system-charted':
      return { amount: REWARDS.discovery.charted, kind: 'discovery', label: `System charted · ${ctx.systemName(e.systemId)}`, id: `chart:${e.systemId}` };
    case 'galaxy-reached':
      return e.first ? { amount: REWARDS.discovery.galaxy, kind: 'discovery', label: `New galaxy · ${ctx.galaxyName(e.galaxyId)}`, id: `galaxy:${e.galaxyId}` } : null;
    default:
      return null;
  }
}
