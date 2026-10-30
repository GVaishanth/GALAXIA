/**
 * The Haven Guild story chain (Free Roam Prompt 11): ten original missions
 * that teach the loop and open the way out of the Milky Way.
 *
 * Progression it drives (tested):
 *  - charting: First Light charts one system and Lantern Echo's navigation
 *    data charts two more, which takes the Milky Way to the 15 % the Lantern
 *    Gate milestone asks for (catalogue/data/milestones.ts), so the route to
 *    Andromeda opens through play, not grinding;
 *  - licences: Silent Hull grants the Mk II upgrade licence, Through the
 *    Lantern the Mk III licence;
 *  - modules and marks fund the first upgrades and equipment.
 *
 * Targets marked 'nearest' are resolved when the mission is accepted, so a
 * story step can always be completed (a POI the pilot already emptied is
 * never chosen; with nothing left, the step counts as done).
 */
import type { MissionDef, MissionReward, Prerequisite } from './missionTypes.ts';

const R = (marks: number, extra: Partial<MissionReward> = {}): MissionReward => ({ marks, resources: [], modules: [], charts: 0, licences: [], ...extra });

export const STORY: readonly MissionDef[] = Object.freeze([
  {
    id: 'story-first-light',
    type: 'survey-region',
    source: 'story',
    title: 'First Light',
    description: 'The Guild needs fresh charts of the home lanes. Complete a survey run in any Milky Way system: record every survey mark and the system is charted.',
    galaxy: 'milky-way',
    prerequisites: [],
    objectives: [{ kind: 'chart', label: 'Chart a Milky Way system', count: 1, target: 'any' }],
    failure: {},
    rewards: R(60, { resources: [{ resource: 'fuel', amount: 4 }] }),
  },
  {
    id: 'story-scrap-and-signal',
    type: 'recover-salvage',
    source: 'story',
    title: 'Scrap and Signal',
    description: 'Drifting salvage clutters the inner lanes. Collect four pieces of salvage anywhere in the Milky Way and keep what you find.',
    galaxy: 'milky-way',
    prerequisites: [{ kind: 'mission', id: 'story-first-light' }],
    objectives: [{ kind: 'poi', label: 'Collect salvage pieces', count: 4, target: 'any', poiKind: 'salvage' }],
    failure: {},
    rewards: R(80, { resources: [{ resource: 'alloy', amount: 4 }] }),
  },
  {
    id: 'story-silent-hull',
    type: 'investigate-derelict',
    source: 'story',
    title: 'Silent Hull',
    description: 'A Guild hauler went quiet on a nearby lane. Inspect the derelict the dispatch marks for you and recover its log.',
    galaxy: 'milky-way',
    prerequisites: [{ kind: 'mission', id: 'story-scrap-and-signal' }],
    objectives: [{ kind: 'poi', label: 'Inspect the derelict', count: 1, target: 'nearest', poiKind: 'derelict' }],
    failure: {},
    rewards: R(100, { licences: ['mk2'] }),
  },
  {
    id: 'story-quiet-lanes',
    type: 'destroy-patrol',
    source: 'story',
    title: 'Quiet Lanes',
    description: 'Armed patrols are shadowing Guild traffic. Destroy three patrol ships in the marked system.',
    galaxy: 'milky-way',
    prerequisites: [{ kind: 'mission', id: 'story-silent-hull' }],
    objectives: [{ kind: 'destroy', label: 'Destroy patrol ships', count: 3, target: 'nearest', patrol: true }],
    failure: {},
    rewards: R(120, { modules: ['deep-array'] }),
  },
  {
    id: 'story-lantern-echo',
    type: 'investigate-anomaly',
    source: 'story',
    title: 'Lantern Echo',
    description: 'Something answers the Lantern Gate beacon from inside the Milky Way. Investigate the marked anomaly; the Guild trades the readings for chart data.',
    galaxy: 'milky-way',
    prerequisites: [{ kind: 'mission', id: 'story-quiet-lanes' }],
    objectives: [{ kind: 'poi', label: 'Investigate the anomaly', count: 1, target: 'nearest', poiKind: 'anomaly' }],
    failure: {},
    rewards: R(100, { charts: 2 }),
  },
  {
    id: 'story-relay-parts',
    type: 'deliver-resources',
    source: 'story',
    title: 'Relay Parts',
    description: 'A Guild relay is short of plating. Bring six units of refined alloy to the marked station and hand them over at its exchange.',
    galaxy: 'milky-way',
    prerequisites: [{ kind: 'mission', id: 'story-lantern-echo' }],
    objectives: [{ kind: 'deliver', label: 'Deliver refined alloy', count: 6, target: 'nearest', resources: ['alloy'] }],
    failure: {},
    rewards: R(150, { resources: [{ resource: 'nav-data', amount: 3 }] }),
  },
  {
    id: 'story-cold-outpost',
    type: 'clear-outpost',
    source: 'story',
    title: 'Cold Outpost',
    description: 'An armed installation guards a lane the Guild wants back. Clear the marked outpost.',
    galaxy: 'milky-way',
    prerequisites: [{ kind: 'mission', id: 'story-relay-parts' }],
    objectives: [{ kind: 'clear', label: 'Clear the outpost', count: 1, target: 'nearest', encounter: 'outpost' }],
    failure: {},
    rewards: R(180, { charts: 1 }),
  },
  {
    id: 'story-through-the-lantern',
    type: 'discover-system',
    source: 'story',
    title: 'Through the Lantern',
    description: 'With the Lantern Gate open, take the route to Andromeda and arrive at its gateway.',
    galaxy: 'andromeda',
    prerequisites: [{ kind: 'mission', id: 'story-cold-outpost' }],
    objectives: [{ kind: 'reach-galaxy', label: 'Reach Andromeda', count: 1, target: 'any', galaxy: 'andromeda' }],
    failure: {},
    rewards: R(200, { licences: ['mk3'], resources: [{ resource: 'fuel', amount: 8 }] }),
  },
  {
    id: 'story-heart-of-the-machine',
    type: 'locate-rare',
    source: 'story',
    title: 'Heart of the Machine',
    description: 'The Guild wants a rare component for study: any core shard or relic recovered from the field (purchases and rewards do not count).',
    galaxy: '',
    prerequisites: [{ kind: 'mission', id: 'story-through-the-lantern' }],
    objectives: [{ kind: 'acquire', label: 'Recover a core shard or relic', count: 1, target: 'any', resources: ['core-shard', 'relic'] }],
    failure: {},
    rewards: R(250, { modules: ['cruise-drive'] }),
  },
  {
    id: 'story-deep-survey',
    type: 'survey-region',
    source: 'story',
    title: 'Deep Survey',
    description: 'Andromeda is barely charted. Chart three of its systems; the Guild adds its own data for two more.',
    galaxy: 'andromeda',
    prerequisites: [{ kind: 'mission', id: 'story-through-the-lantern' }],
    objectives: [{ kind: 'chart', label: 'Chart Andromeda systems', count: 3, target: 'any' }],
    failure: {},
    rewards: R(300, { charts: 2 }),
  },
] satisfies MissionDef[]);

export const STORY_BY_ID: ReadonlyMap<string, MissionDef> = new Map(STORY.map((m) => [m.id, m]));

/**
 * P09.1 connected chains: short Guild arcs beside the main story. Each stage is
 * an ordinary story-source mission (same accept, objective, reward and save
 * path); chain() adds "the previous stage turned in" (claimed) to every stage
 * after the first, so the order lives in one place and a stage can never be accepted,
 * progressed or paid before the one before it.
 */
export interface ChainDef {
  readonly id: string;
  readonly title: string;
  /** Stage mission ids in order. */
  readonly stages: readonly string[];
}

type Stage = Omit<MissionDef, 'source' | 'galaxy' | 'failure' | 'chain' | 'prerequisites'> & { readonly prerequisites?: readonly Prerequisite[] };

const chained: MissionDef[] = [];
const chain = (id: string, title: string, stages: readonly Stage[]): ChainDef => {
  stages.forEach((st, i) =>
    chained.push({ ...st, source: 'story', galaxy: 'milky-way', failure: {}, chain: id, prerequisites: [...(i ? [{ kind: 'mission' as const, id: stages[i - 1]!.id, claimed: true as const }] : []), ...(st.prerequisites ?? [])] }),
  );
  return { id, title, stages: stages.map((st) => st.id) };
};

export const CHAINS: readonly ChainDef[] = [
  chain('gleaner-accord', 'Gleaner Accord', [
    {
      id: 'chain-accord-claims',
      type: 'destroy-patrol',
      title: 'Claim Jumpers',
      description: 'Red Tally raiders are robbing Gleaner salvage claims. Destroy three Red Tally ships anywhere in the Milky Way and the Guild will vouch for you.',
      prerequisites: [{ kind: 'mission', id: 'story-silent-hull' }],
      objectives: [{ kind: 'destroy', label: 'Destroy Red Tally ships', count: 3, target: 'any', faction: 'red-tally' }],
      rewards: R(120),
    },
    {
      id: 'chain-accord-shares',
      type: 'deliver-resources',
      title: 'Fair Shares',
      description: 'The Gleaner families talk to pilots who share. Deliver six scrap to the marked station. They will not deal with a pilot who has been shooting at them lately.',
      prerequisites: [{ kind: 'heat', faction: 'gleaners', below: 40 }],
      objectives: [{ kind: 'deliver', label: 'Deliver scrap', count: 6, target: 'nearest', resources: ['scrap'] }],
      rewards: R(100, { resources: [{ resource: 'circuits', amount: 2 }] }),
      heat: { faction: 'gleaners', delta: -20 },
    },
    {
      id: 'chain-accord-ledger',
      type: 'investigate-derelict',
      title: 'The Red Ledger',
      description: 'The Gleaners name the wreck where the Red Tally hides its raid ledger. Inspect it. The Tally will know who took it.',
      objectives: [{ kind: 'poi', label: 'Inspect the derelict', count: 1, target: 'nearest', poiKind: 'derelict' }],
      rewards: R(160, { resources: [{ resource: 'nav-data', amount: 2 }] }),
      heat: { faction: 'red-tally', delta: 15 },
    },
  ]),
  chain('faint-lanterns', 'Faint Lanterns', [
    {
      id: 'chain-lanterns-echo',
      type: 'investigate-anomaly',
      title: 'Faint Lanterns',
      description: 'Guild listeners hear a faint pattern under the beacon traffic. Investigate the marked anomaly.',
      prerequisites: [{ kind: 'mission', id: 'story-first-light' }],
      objectives: [{ kind: 'poi', label: 'Investigate the anomaly', count: 1, target: 'nearest', poiKind: 'anomaly' }],
      rewards: R(80),
    },
    {
      id: 'chain-lanterns-charts',
      type: 'survey-region',
      title: 'Lantern Charts',
      description: 'The pattern repeats across the lanes. Chart two Milky Way systems so the Guild can compare readings.',
      objectives: [{ kind: 'chart', label: 'Chart Milky Way systems', count: 2, target: 'any' }],
      rewards: R(120, { resources: [{ resource: 'fuel', amount: 4 }] }),
    },
    {
      id: 'chain-lanterns-coolant',
      type: 'deliver-resources',
      title: 'Cold Listening',
      description: 'The listening array runs hot. Deliver four ice to the marked station to keep it cold.',
      objectives: [{ kind: 'deliver', label: 'Deliver ice', count: 4, target: 'nearest', resources: ['ice'] }],
      rewards: R(140, { resources: [{ resource: 'nav-data', amount: 2 }] }),
    },
  ]),
];

/** Every Guild mission (story + chain stages) by id: the one lookup accept, progress, claim and load use. */
export const MISSION_BY_ID: ReadonlyMap<string, MissionDef> = new Map([...STORY, ...chained].map((m) => [m.id, m]));
