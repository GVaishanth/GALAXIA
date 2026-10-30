/**
 * Progression state <-> profile (Free Roam Prompt 11).
 *
 * profile.ts (main bundle) only checks shapes; this module validates the
 * saved progression against the game data when Free Roam loads: unknown
 * story ids, contract types, licences, ships, upgrade tracks and resources
 * are dropped, upgrade levels are capped per ship, mission progress is
 * capped at the objective counts. Pure; the profile type is the only link to
 * storage, so the later save system can serialise ProgressionState as is.
 */
import type { SavedProgression } from '../profile.ts';
import { isResourceId } from '../inventory/resources.ts';
import { SHIP_IDS, type ShipId } from '../ships/types.ts';
import { cleanLevels, UPGRADE_LICENCES } from '../ships/upgrades.ts';
import { CONTRACT_ID, contractDef } from './contracts.ts';
import { EMPTY_LOG, type ExplorationLog } from './discovery.ts';
import { MISSION_BY_ID } from './missionData.ts';
import { heatToSaved, type HeatBook } from '../combat/factionHeat.ts';
import { MISSION_TYPES, type ActiveMission, type ContractSpec, type MissionState, type MissionType } from './missionTypes.ts';
import { ledgerFromSaved, ledgerToSaved, type Ledger } from './ledger.ts';
import { pruneBounties, type BountyBook } from './marksRewards.ts';

export interface FuelBook {
  readonly starter: boolean;
  readonly arrivals: number;
  readonly aidAt: number;
}

/** The marks history beside the balance (ledger.ts Ledger without `balance`: the balance is `marks`). */
export type LedgerBook = Omit<Ledger, 'balance'>;

export interface ProgressionState {
  /** The one authoritative Guild marks balance (every screen reads it; ledger.ts changes it). */
  readonly marks: number;
  readonly missions: MissionState;
  readonly upgrades: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly licences: readonly string[];
  readonly log: ExplorationLog;
  readonly fuel: FuelBook;
  /** Economy pass: bounded history of marks changes and recent claim ids. */
  readonly ledger: LedgerBook;
  /** Economy pass: per-system bounty windows (marksRewards.ts). */
  readonly bounty: BountyBook;
}

/** The wallet view of a progression state (balance + history). */
export const ledgerOf = (p: ProgressionState): Ledger => ({ balance: p.marks, seq: p.ledger.seq, history: p.ledger.history, recent: p.ledger.recent });

/** Write a ledger step back: the balance and the history change together. */
export const withLedger = (p: ProgressionState, l: Ledger): ProgressionState => ({ ...p, marks: l.balance, ledger: { seq: l.seq, history: l.history, recent: l.recent } });

export const PROGRESSION_FORMAT = 1;

const knownMission = (id: string): boolean => MISSION_BY_ID.has(id) || CONTRACT_ID.test(id);
const isType = (x: string): x is MissionType => (MISSION_TYPES as readonly string[]).includes(x);
const isShip = (x: string): x is ShipId => (SHIP_IDS as readonly string[]).includes(x);

function spec(raw: { readonly type: string } & Omit<ContractSpec, 'type'>): ContractSpec | null {
  return isType(raw.type) ? { ...raw, type: raw.type } : null;
}

export function progressionFromSaved(saved: SavedProgression): ProgressionState {
  const m = saved.missions;
  const completed = m.completed.filter(knownMission);
  const active: ActiveMission[] = [];
  for (const a of m.active) {
    if (!knownMission(a.id)) continue;
    const contract = a.contract ? spec(a.contract) : null;
    if (a.id.startsWith('c:') && !contract) continue;
    const def = MISSION_BY_ID.get(a.id) ?? (contract ? contractDef(a.id, contract) : undefined);
    if (!def || def.objectives.length !== a.progress.length) continue;
    const progress = def.objectives.map((o, i) => Math.min(o.count, a.progress[i] ?? 0));
    active.push(contract ? { id: a.id, at: a.at, progress, targets: [...a.targets], contract } : { id: a.id, at: a.at, progress, targets: [...a.targets] });
  }
  const ready: Record<string, ContractSpec> = {};
  for (const [id, raw] of Object.entries(m.ready)) {
    const s = spec(raw);
    if (s && completed.includes(id)) ready[id] = s;
  }
  // a completed contract without its spec cannot be turned in: it counts as claimed (no reward, no repeat)
  const claimed = [...new Set([...m.claimed.filter((id) => completed.includes(id)), ...completed.filter((id) => id.startsWith('c:') && !ready[id] && !m.claimed.includes(id))])];
  const upgrades: Record<string, Record<string, number>> = {};
  for (const [ship, levels] of Object.entries(saved.upgrades)) {
    if (!isShip(ship)) continue;
    const clean = cleanLevels(ship, levels);
    if (Object.keys(clean).length) upgrades[ship] = { ...clean };
  }
  const acquired: Record<string, number> = {};
  for (const [k, n] of Object.entries(saved.log.acquired)) if (isResourceId(k)) acquired[k] = n;
  const ledger = ledgerFromSaved(saved.marks, saved.ledger);
  return {
    marks: ledger.balance,
    missions: { jumps: m.jumps, active, completed, claimed, failed: m.failed.filter(knownMission), ready },
    upgrades,
    licences: saved.licences.filter((l) => (UPGRADE_LICENCES as readonly string[]).includes(l)),
    log: { ...EMPTY_LOG, ...saved.log, acquired },
    fuel: { ...saved.fuel },
    ledger: { seq: ledger.seq, history: ledger.history, recent: ledger.recent },
    bounty: pruneBounties(saved.bounty ?? {}, m.jumps),
  };
}

/** Structural copy into the profile shape (ids and numbers are already valid). */
export function progressionToSaved(p: ProgressionState, heat?: HeatBook): SavedProgression {
  const h = heat && heatToSaved(heat);
  return {
    marks: p.marks,
    missions: { jumps: p.missions.jumps, active: p.missions.active.map((a) => ({ ...a })), completed: [...p.missions.completed], claimed: [...p.missions.claimed], failed: [...p.missions.failed], ready: { ...p.missions.ready } },
    upgrades: p.upgrades,
    licences: [...p.licences],
    log: p.log,
    fuel: { ...p.fuel },
    ...(p.ledger.seq > 0 || p.ledger.recent.length ? { ledger: ledgerToSaved(ledgerOf(p)) } : {}),
    ...(Object.keys(p.bounty).length ? { bounty: { ...p.bounty } } : {}),
    ...(h ? { heat: h } : {}),
  };
}
