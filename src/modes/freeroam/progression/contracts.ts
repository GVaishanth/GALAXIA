/**
 * Station contract boards (Free Roam Prompt 11).
 *
 * Every station posts BOARD.offers contracts per cycle and at most
 * BOARD.cycles cycles (6 contracts per station over a whole game): a cycle
 * moves on only once each of its slots was accepted (or cannot be filled).
 * Offers are generated from a seed of the slot id and the current world, so
 * the same board shows the same work, and every target is real content that
 * is not done yet (a POI, an encounter site, a patrol route, an unvisited or
 * uncharted system inside BOARD.radius hops). Nothing can be farmed: slots
 * are spent when accepted, POI targets are one-time, rewards are paid once.
 *
 * Pure (no DOM, no storage).
 */
import { createRng, type Rng } from '../../../core/rng.ts';
import { fnv1a32 } from '../catalogue/build.ts';
import { missionReward } from '../inventory/lootTables.ts';
import type { LootEntry } from '../sector/model.ts';
import type { MissionWorld } from './missions.ts';
import { TARGET_DONE, type ContractSpec, type MissionDef, type MissionState, type MissionType, type ObjectiveDef } from './missionTypes.ts';

export const BOARD = Object.freeze({ offers: 3, cycles: 2, radius: 4 });

export const CONTRACT_ID = /^c:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*:[0-9]:[0-9]$/;
export const contractId = (station: string, cycle: number, slot: number): string => `c:${station}:${cycle}:${slot}`;

/** FNV-1a 32-bit (stable seeds from ids). */
export const hashId = fnv1a32;

const DELIVERY_GOODS = ['scrap', 'alloy', 'ice'] as const;
const RARE_GOODS = ['components', 'crystal'] as const;

/** Base marks per contract type; + per difficulty step. */
const PAY: Readonly<Record<MissionType, readonly [number, number]>> = Object.freeze({
  'discover-system': [40, 15],
  'survey-region': [60, 20],
  'investigate-anomaly': [50, 20],
  'recover-salvage': [30, 12],
  'investigate-derelict': [40, 15],
  'destroy-patrol': [50, 20],
  'clear-outpost': [80, 30],
  'defend-wreck': [70, 25],
  'deliver-resources': [30, 0],
  'locate-rare': [90, 20],
});

const TITLE: Readonly<Record<MissionType, string>> = Object.freeze({
  'discover-system': 'Lane Scout',
  'survey-region': 'Chart Request',
  'investigate-anomaly': 'Odd Readings',
  'recover-salvage': 'Salvage Claim',
  'investigate-derelict': 'Hull Inspection',
  'destroy-patrol': 'Patrol Bounty',
  'clear-outpost': 'Outpost Contract',
  'defend-wreck': 'Hold the Wreck',
  'deliver-resources': 'Supply Run',
  'locate-rare': 'Parts Hunt',
});

/** Ships across a system's patrol routes (what one pass through the sector can destroy). */
export const patrolShips = (world: MissionWorld, id: string): number => world.sites(id).reduce((n, s) => n + (s.kind === 'patrol' ? (s.ships ?? 1) : 0), 0);

export const TEMPLATE_ORDER: readonly MissionType[] = ['discover-system', 'survey-region', 'investigate-anomaly', 'recover-salvage', 'investigate-derelict', 'destroy-patrol', 'clear-outpost', 'defend-wreck', 'deliver-resources', 'locate-rare'];

/* ------------------------------------------------------------ definitions */

function objectivesFor(spec: ContractSpec): ObjectiveDef[] {
  const t = spec.target;
  switch (spec.type) {
    case 'discover-system':
      return [{ kind: 'visit', label: 'Arrive in the system', count: 1, target: t }];
    case 'survey-region':
      return [{ kind: 'chart', label: 'Chart the system', count: 1, target: t }];
    case 'investigate-anomaly':
      return [{ kind: 'poi', label: 'Investigate the anomaly', count: 1, target: t, poiKind: 'anomaly' }];
    case 'recover-salvage':
      return [{ kind: 'poi', label: 'Empty the salvage field', count: 1, target: t, poiKind: 'salvage' }];
    case 'investigate-derelict':
      return [{ kind: 'poi', label: 'Inspect the derelict', count: 1, target: t, poiKind: 'derelict' }];
    case 'destroy-patrol':
      return [{ kind: 'destroy', label: 'Destroy patrol ships', count: spec.count, target: t, patrol: true }];
    case 'clear-outpost':
      return [{ kind: 'clear', label: 'Clear the outpost', count: 1, target: t, encounter: 'outpost' }];
    case 'defend-wreck':
      return [{ kind: 'clear', label: 'Hold the wreck until the attack breaks', count: 1, target: t, encounter: 'defence' }];
    case 'deliver-resources':
      return [{ kind: 'deliver', label: 'Deliver the cargo', count: spec.count, target: t, resources: [spec.resource] }];
    case 'locate-rare':
      return [{ kind: 'acquire', label: 'Recover parts from the field', count: spec.count, target: 'any', resources: [spec.resource] }];
  }
}

const DESCRIPTION: Readonly<Record<MissionType, string>> = Object.freeze({
  'discover-system': 'The Guild wants fresh eyes on a system nobody has flown to lately.',
  'survey-region': 'A survey run in the marked system: record every survey mark there.',
  'investigate-anomaly': 'Sensors keep flagging an anomaly. Fly in and investigate it.',
  'recover-salvage': 'A salvage field is unclaimed. Empty it and keep the haul.',
  'investigate-derelict': 'A derelict hull needs inspecting before the Guild files it.',
  'destroy-patrol': 'Hostile patrols are harassing traffic. Destroy the ships flying the patrol route.',
  'clear-outpost': 'An armed installation blocks the lane. Clear it.',
  'defend-wreck': 'Salvagers are pinned at a wreck. Hold it until the attack breaks. Losing the wreck fails the contract.',
  'deliver-resources': 'A station is short of supplies. Bring the cargo before the deadline and hand it over at its exchange.',
  'locate-rare': 'A fabricator shop needs parts recovered from the field before the deadline (purchases do not count).',
});

/** Rewards: marks from the spec, plus a resource roll from the mission loot table (seeded by the id; FR-OD-24). */
export function contractRewardLoot(id: string, spec: ContractSpec): LootEntry[] {
  return missionReward(createRng(hashId(`${id}:reward`)), { difficulty: spec.difficulty, richness: 1, primary: null, secondary: null });
}

export function contractDef(id: string, spec: ContractSpec): MissionDef {
  return {
    id,
    type: spec.type,
    source: 'contract',
    title: TITLE[spec.type],
    description: DESCRIPTION[spec.type],
    galaxy: spec.station.split('/')[0] ?? '',
    prerequisites: [],
    objectives: objectivesFor(spec),
    failure: { deadlineJumps: spec.deadline > 0 ? spec.deadline : undefined, failOnEncounterLoss: spec.type === 'defend-wreck' },
    rewards: { marks: spec.marks, resources: contractRewardLoot(id, spec), modules: [], charts: 0, licences: [] },
  };
}

/* -------------------------------------------------------------- generation */

const pick = <T>(rng: Rng, xs: readonly T[]): T | undefined => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(rng.next() * Math.min(3, xs.length)))] : undefined);

function buildSpec(type: MissionType, station: string, world: MissionWorld, rng: Rng, taken: ReadonlySet<string>): ContractSpec | null {
  const g = station.split('/')[0] ?? '';
  const pool = world
    .systemsIn(g)
    .filter((id) => world.enterable(id) && world.hops(station, id) <= BOARD.radius)
    .sort((a, b) => world.hops(station, a) - world.hops(station, b));
  const pay = (d: number): number => PAY[type][0] + PAY[type][1] * Math.max(0, d - 1);
  const sys = (target: string, count = 1, extra: Partial<ContractSpec> = {}): ContractSpec => {
    const d = world.difficulty(target.split('#')[0] ?? station);
    return { type, station, target, count, resource: '', marks: pay(d), deadline: 0, difficulty: d, ...extra };
  };
  const site = (match: (kind: string) => boolean): string | null => {
    const hits: string[] = [];
    for (const id of pool) for (const s of world.sites(id)) if (match(s.kind) && !s.done && !taken.has(`${id}#${s.id}`)) hits.push(`${id}#${s.id}`);
    return pick(rng, hits) ?? null;
  };
  switch (type) {
    case 'discover-system': {
      const t = pick(rng, pool.filter((id) => !world.visited(id) && id !== station && !taken.has(id)));
      return t ? sys(t) : null;
    }
    case 'survey-region': {
      const t = pick(rng, pool.filter((id) => !world.charted(id) && !taken.has(`chart:${id}`)));
      return t ? sys(t) : null;
    }
    case 'investigate-anomaly':
    case 'recover-salvage':
    case 'investigate-derelict': {
      const kind = type === 'investigate-anomaly' ? 'anomaly' : type === 'recover-salvage' ? 'salvage' : 'derelict';
      const t = site((k) => k === kind);
      return t ? sys(t) : null;
    }
    case 'clear-outpost': {
      const t = site((k) => k === 'installation');
      return t ? sys(t) : null;
    }
    case 'defend-wreck': {
      const t = site((k) => k === 'site:defence');
      return t ? sys(t) : null;
    }
    case 'destroy-patrol': {
      const t = pick(rng, pool.filter((id) => world.sites(id).some((s) => s.kind === 'patrol') && !taken.has(`patrol:${id}`)));
      if (!t) return null;
      const d = world.difficulty(t);
      // never ask for more kills than the patrols there fly (Prompt 14 balance: no re-entry grind)
      return sys(t, Math.max(1, Math.min(d >= 3 ? 3 : 2, patrolShips(world, t))));
    }
    case 'deliver-resources': {
      const stations = pool.filter((id) => world.station(id));
      const t = pick(rng, stations.filter((id) => id !== station)) ?? station;
      const resource = DELIVERY_GOODS[rng.int(0, DELIVERY_GOODS.length - 1)]!;
      const count = rng.int(4, 8);
      const value = resource === 'alloy' ? 4 : resource === 'ice' ? 2 : 1;
      return { type, station, target: t, count, resource, marks: PAY[type][0] + value * count * 5, deadline: 8, difficulty: world.difficulty(t) };
    }
    case 'locate-rare': {
      const resource = RARE_GOODS[rng.int(0, RARE_GOODS.length - 1)]!;
      return { type, station, target: '', count: 2, resource, marks: pay(world.difficulty(station)), deadline: 12, difficulty: world.difficulty(station) };
    }
  }
}

const takenKey = (spec: ContractSpec): string => (spec.type === 'survey-region' ? `chart:${spec.target}` : spec.type === 'destroy-patrol' ? `patrol:${spec.target}` : spec.target);

export interface BoardOffer {
  readonly id: string;
  readonly slot: number;
  readonly spec: ContractSpec;
  readonly def: MissionDef;
}

export interface Board {
  readonly station: string;
  /** Current cycle (BOARD.cycles = the board is exhausted). */
  readonly cycle: number;
  readonly offers: readonly BoardOffer[];
  /** Contracts this station can still post after the current offers (0 at the end). */
  readonly remaining: number;
}

const isTaken = (state: MissionState, id: string): boolean => state.active.some((m) => m.id === id) || state.completed.includes(id) || state.failed.includes(id);

/** The board of a station system: open offers of the current cycle. */
export function stationBoard(state: MissionState, station: string, world: MissionWorld): Board {
  const taken = new Set<string>();
  for (const m of state.active) {
    for (const t of m.targets) if (t && t !== TARGET_DONE) taken.add(t);
    if (m.contract) taken.add(takenKey(m.contract));
  }
  for (let cycle = 0; cycle < BOARD.cycles; cycle++) {
    const offers: BoardOffer[] = [];
    let open = 0;
    for (let slot = 0; slot < BOARD.offers; slot++) {
      const id = contractId(station, cycle, slot);
      if (isTaken(state, id)) continue;
      const rng = createRng(hashId(id));
      const order = [...TEMPLATE_ORDER];
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      for (const type of order) {
        const spec = buildSpec(type, station, world, rng, taken);
        if (!spec) continue;
        taken.add(takenKey(spec));
        offers.push({ id, slot, spec, def: contractDef(id, spec) });
        open++;
        break;
      }
    }
    // a cycle stays up while any of its slots is open; unfillable slots do not hold it back
    if (open > 0) return { station, cycle, offers, remaining: (BOARD.cycles - cycle - 1) * BOARD.offers };
  }
  return { station, cycle: BOARD.cycles, offers: [], remaining: 0 };
}
