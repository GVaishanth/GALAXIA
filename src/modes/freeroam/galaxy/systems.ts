/**
 * System maps (pure, deterministic): the lane graph inside one galaxy, what the
 * pilot knows about each system, route planning and in-galaxy travel.
 *
 * Built only from the validated catalogue. The lanes ARE the systems'
 * `connections` (symmetric, 1..5 per system, never all-to-all), so every galaxy
 * gets a system map without a hand-written screen. Lane cost, hazard and transit
 * event are derived from the two end systems, so they can never disagree with
 * the catalogue and never fall outside 1..5.
 *
 * Knowledge levels (what the UI may show):
 *   hidden    not shown at all
 *   signal    an unknown node: position and lanes only ("Unknown signal")
 *   known     name, classification, difficulty, real-object fact, a resource hint
 *   surveyed  everything: resources, hostiles, hazard, anomalies, points of interest
 * Rewards stay concealed until a survey run charts the system.
 *
 * Catalogue `hidden` systems (all of them carry unlock requirements) stay off
 * the map until a neighbouring system is charted; then they show as a locked,
 * unidentified signal with their requirements, so the player can see what is
 * sealed and why. Their identity is revealed only once they are unlocked.
 */
import { HOSTILE_FACTIONS, WARY_FACTIONS, type EncounterPattern, type FactionId, type GalaxyId, type HazardId, type ResourceId, type ResourceProfile, type SectorArchetypeId, type SystemCategory, type SystemProvenanceStatus, type SystemRecord } from '../catalogue/types.ts';
import type { NavGraph } from './graph.ts';
import { deriveView, progressDiff, type ExplorationProgress, type ProgressChange, type ProgressView } from './progress.ts';

/* ------------------------------------------------------------------ graph */

export const LANE_COST = Object.freeze({ min: 1, max: 5 });

export interface LaneHazard {
  readonly id: HazardId;
  readonly strength: number;
  /** The end system the hazard belongs to. */
  readonly at: string;
}

export interface LaneEvent {
  readonly pattern: EncounterPattern;
  readonly threat: number;
  readonly at: string;
}

export interface Lane {
  /** Canonical `${a}~${b}` with a < b: one lane per pair, stable. */
  readonly id: string;
  readonly a: string;
  readonly b: string;
  /** Estimated drive charge for the hop, integer 1..5. */
  readonly cost: number;
  /** Strongest hazard at either end; null when both ends are clear. */
  readonly hazard: LaneHazard | null;
  /** Transit event class: the encounter pattern of the more dangerous end when its threat is 2+. */
  readonly event: LaneEvent | null;
}

export type SystemGraphIssueCode = 'missing-system' | 'cross-galaxy' | 'self-lane' | 'duplicate-lane' | 'asymmetric-lane' | 'invalid-cost' | 'no-gateway' | 'gateway-locked' | 'unreachable' | 'all-to-all' | 'progression-blocked';

export interface SystemGraphIssue {
  readonly code: SystemGraphIssueCode;
  readonly galaxy: GalaxyId;
  readonly detail: string;
}

export interface SystemGraph {
  readonly galaxy: GalaxyId;
  readonly gateway: string;
  /** Catalogue order. */
  readonly systems: readonly SystemRecord[];
  readonly lanes: readonly Lane[];
  /** Problems found while building (a valid catalogue has none; tests assert that). */
  readonly issues: readonly SystemGraphIssue[];
  system(id: string): SystemRecord | undefined;
  lanesOf(id: string): readonly Lane[];
  laneBetween(a: string, b: string): Lane | undefined;
  other(lane: Lane, id: string): string;
  /** Hop counts over every lane from `from` (ignores locks and knowledge). */
  hops(from: string): ReadonlyMap<string, number>;
}

export const laneId = (a: string, b: string): string => (a < b ? `${a}~${b}` : `${b}~${a}`);

const level = (x: number, lo: number, hi: number): number => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : lo);

const hazardUnits = (s: SystemRecord): number => (s.sector.hazard === 'none' ? 0 : level(s.sector.hazardStrength * 20, 0, 20));

/**
 * Estimated drive charge for one hop, always an integer in 1..5:
 * 1 + the two ends' hazard strengths summed and rounded (0..2) + 1 when the lane
 * carries a transit event. Integer arithmetic (strength in twentieths) so every
 * engine rounds the same way. Calm local lanes cost 1, stormy contested ones 4.
 */
export function laneCost(a: SystemRecord, b: SystemRecord): number {
  const hazard = Math.floor((hazardUnits(a) + hazardUnits(b) + 10) / 20);
  const raw = 1 + hazard + (laneEvent(a, b) ? 1 : 0);
  return level(raw, LANE_COST.min, LANE_COST.max);
}

function laneHazard(a: SystemRecord, b: SystemRecord): LaneHazard | null {
  const pick = [a, b].filter((s) => s.sector.hazard !== 'none').sort((x, y) => y.sector.hazardStrength - x.sector.hazardStrength || (x.id < y.id ? -1 : 1))[0];
  return pick ? { id: pick.sector.hazard, strength: pick.sector.hazardStrength, at: pick.id } : null;
}

function laneEvent(a: SystemRecord, b: SystemRecord): LaneEvent | null {
  const pick = [a, b].filter((s) => s.encounters.threat >= 2 && s.encounters.pattern !== 'none').sort((x, y) => y.encounters.threat - x.encounters.threat || (x.id < y.id ? -1 : 1))[0];
  return pick ? { pattern: pick.encounters.pattern, threat: pick.encounters.threat, at: pick.id } : null;
}

/**
 * Build one galaxy's lane graph. Duplicates (A lists B twice, or both A and B
 * list each other) collapse into one canonical lane; lanes to missing, foreign
 * or identical systems are dropped and reported, never drawn.
 */
export function buildSystemGraph(galaxy: GalaxyId, gateway: string, allSystems: readonly SystemRecord[]): SystemGraph {
  const systems = allSystems.filter((s) => s.galaxyId === galaxy);
  const byId = new Map(systems.map((s) => [s.id, s]));
  const allById = new Map(allSystems.map((s) => [s.id, s]));
  const issues: SystemGraphIssue[] = [];
  const lanes: Lane[] = [];
  const laneById = new Map<string, Lane>();
  const listed = new Set<string>();
  for (const s of systems) {
    const seenHere = new Set<string>();
    for (const c of s.connections) {
      if (seenHere.has(c)) issues.push({ code: 'duplicate-lane', galaxy, detail: `${s.id} lists ${c} twice` });
      seenHere.add(c);
      listed.add(`${s.id}>${c}`);
      if (c === s.id) {
        issues.push({ code: 'self-lane', galaxy, detail: s.id });
        continue;
      }
      const t = byId.get(c);
      if (!t) {
        issues.push({ code: allById.has(c) ? 'cross-galaxy' : 'missing-system', galaxy, detail: `${s.id} -> ${c}` });
        continue;
      }
      const id = laneId(s.id, t.id);
      if (laneById.has(id)) continue; // the reverse listing of a symmetric lane
      const [a, b] = s.id < t.id ? [s, t] : [t, s];
      const lane: Lane = Object.freeze({ id, a: a.id, b: b.id, cost: laneCost(a, b), hazard: laneHazard(a, b), event: laneEvent(a, b) });
      if (!Number.isInteger(lane.cost) || lane.cost < LANE_COST.min || lane.cost > LANE_COST.max) issues.push({ code: 'invalid-cost', galaxy, detail: `${id}: ${lane.cost}` });
      lanes.push(lane);
      laneById.set(id, lane);
    }
  }
  for (const l of lanes) if (!listed.has(`${l.a}>${l.b}`) || !listed.has(`${l.b}>${l.a}`)) issues.push({ code: 'asymmetric-lane', galaxy, detail: l.id });
  const adjacency = new Map<string, Lane[]>(systems.map((s) => [s.id, []]));
  for (const l of lanes) {
    adjacency.get(l.a)!.push(l);
    adjacency.get(l.b)!.push(l);
  }
  const hopsCache = new Map<string, ReadonlyMap<string, number>>();
  const hops = (from: string): ReadonlyMap<string, number> => {
    let m = hopsCache.get(from);
    if (m) return m;
    const d = new Map<string, number>();
    if (byId.has(from)) {
      d.set(from, 0);
      const q = [from];
      for (let i = 0; i < q.length; i++) {
        const x = q[i]!;
        for (const l of adjacency.get(x)!) {
          const y = l.a === x ? l.b : l.a;
          if (!d.has(y)) {
            d.set(y, d.get(x)! + 1);
            q.push(y);
          }
        }
      }
    }
    m = d;
    hopsCache.set(from, m);
    return m;
  };
  return Object.freeze({
    galaxy,
    gateway,
    systems,
    lanes,
    issues,
    system: (id: string) => byId.get(id),
    lanesOf: (id: string) => adjacency.get(id) ?? [],
    laneBetween: (a: string, b: string) => laneById.get(laneId(a, b)),
    other: (lane: Lane, id: string) => (lane.a === id ? lane.b : lane.a),
    hops,
  });
}

const graphCache = new WeakMap<NavGraph, Map<GalaxyId, SystemGraph>>();

/** The (memoised) lane graph of a catalogue galaxy. */
export function systemGraph(graph: NavGraph, galaxy: GalaxyId): SystemGraph {
  let perGalaxy = graphCache.get(graph);
  if (!perGalaxy) graphCache.set(graph, (perGalaxy = new Map()));
  let sg = perGalaxy.get(galaxy);
  if (!sg) {
    sg = buildSystemGraph(galaxy, graph.node(galaxy)?.galaxy.gameplay.gatewaySystemId ?? '', graph.catalogue.systems);
    perGalaxy.set(galaxy, sg);
  }
  return sg;
}

/* ------------------------------------------------------------ validation */

function milestonePercents(graph: NavGraph, galaxy: GalaxyId): number {
  let max = 0;
  const walk = (c: (typeof graph.milestones)[number]['condition']): void => {
    if (c.kind === 'exploration' && c.galaxyId === galaxy) max = Math.max(max, c.percent);
    if (c.kind === 'all' || c.kind === 'any') c.of.forEach(walk);
  };
  for (const m of graph.milestones) walk(m.condition);
  return max;
}

/**
 * Structural checks for every galaxy's system graph: build issues, a valid and
 * enterable gateway, every system connected, never all-to-all, and enough
 * requirement-free systems reachable from the gateway to meet the galaxy's
 * exploration milestones (so progression never needs a locked system).
 */
export function validateSystemGraphs(graph: NavGraph): SystemGraphIssue[] {
  const out: SystemGraphIssue[] = [];
  for (const n of graph.nodes) {
    const sg = systemGraph(graph, n.id);
    out.push(...sg.issues);
    const gate = sg.system(sg.gateway);
    if (!gate) {
      out.push({ code: 'no-gateway', galaxy: n.id, detail: sg.gateway });
      continue;
    }
    if (gate.unlock.length > 0 || gate.discovery === 'hidden') out.push({ code: 'gateway-locked', galaxy: n.id, detail: gate.id });
    const reach = sg.hops(gate.id);
    for (const s of sg.systems) if (!reach.has(s.id)) out.push({ code: 'unreachable', galaxy: n.id, detail: s.id });
    const k = sg.systems.length;
    if (k > 2 && sg.lanes.length >= (k * (k - 1)) / 2) out.push({ code: 'all-to-all', galaxy: n.id, detail: `${sg.lanes.length} lanes for ${k} systems` });
    // requirement-free systems reachable from the gateway without crossing a gated one
    const free = new Set<string>([gate.id]);
    const q = [gate.id];
    for (let i = 0; i < q.length; i++) {
      for (const l of sg.lanesOf(q[i]!)) {
        const y = sg.other(l, q[i]!);
        const s = sg.system(y)!;
        if (!free.has(y) && s.unlock.length === 0 && s.discovery !== 'hidden') {
          free.add(y);
          q.push(y);
        }
      }
    }
    const need = Math.ceil((milestonePercents(graph, n.id) * k) / 100);
    if (free.size < need) out.push({ code: 'progression-blocked', galaxy: n.id, detail: `${free.size} open systems, milestones need ${need}` });
  }
  return out;
}

/* ------------------------------------------------------------- knowledge */

export type Knowledge = 'hidden' | 'signal' | 'known' | 'surveyed';
/**
 * current    the pilot is here
 * reachable  an open, known route leads here from the pilot's system
 * blocked    enterable, but every known route passes a locked system (or none is known yet)
 * locked     the system's own requirements are unmet: it cannot be entered
 * remote     a system in a galaxy the pilot is not in (view only)
 */
export type SystemState = 'current' | 'reachable' | 'blocked' | 'locked' | 'remote';
/** active = touches the pilot's system; open = both ends enterable; locked = an end is locked. */
export type LaneState = 'active' | 'open' | 'locked';
export type RouteBlock = 'here' | 'elsewhere' | 'hidden' | 'locked' | 'no-route';

export interface RoutePlanOk {
  readonly ok: true;
  readonly to: string;
  /** Systems from the pilot's position to the destination, inclusive. */
  readonly path: readonly string[];
  readonly lanes: readonly Lane[];
  readonly cost: number;
  readonly jumps: number;
}

export interface RoutePlanBlocked {
  readonly ok: false;
  readonly to: string;
  readonly reason: RouteBlock;
  /** First locked system on the cheapest known route (or the destination itself); null if none. */
  readonly blocker: string | null;
  /** Up to three reachable systems nearest the destination. */
  readonly alternatives: readonly string[];
}

export type RoutePlan = RoutePlanOk | RoutePlanBlocked;

export type MarkerKind = 'gateway' | 'objective' | 'key' | 'resource' | 'hostile' | 'station' | 'anomaly';
export interface Marker {
  readonly kind: MarkerKind;
  readonly label: string;
}

export interface SystemIntel {
  readonly knowledge: Knowledge;
  /** "Unknown signal" until the system is known. */
  readonly name: string;
  readonly category: SystemCategory | null;
  readonly provenance: SystemProvenanceStatus | null;
  readonly difficulty: number | null;
  readonly description: string;
  /** Verified objects: the cited real-world statement (known and up). */
  readonly fact: string | null;
  /** Known: the main material only. */
  readonly resourceHint: ResourceId | null;
  /** Surveyed: the full profile. */
  readonly resources: ResourceProfile | null;
  /** Surveyed: hostile activity (empty factions and threat 0 = none detected). */
  readonly hostiles: { readonly threat: number; readonly pattern: EncounterPattern; readonly factions: readonly FactionId[] } | null;
  readonly friendly: readonly FactionId[] | null;
  /** Surveyed: factions that are neutral until provoked (Prompt 9: the Gleaners). */
  readonly neutral: readonly FactionId[] | null;
  readonly hazard: { readonly id: HazardId; readonly strength: number } | null;
  readonly pois: readonly string[] | null;
  readonly anomaly: string | null;
}

export interface SystemView {
  readonly view: ProgressView;
  readonly graph: SystemGraph;
  readonly galaxy: GalaxyId;
  /** True when the pilot is in this galaxy. */
  readonly here: boolean;
  /** The pilot's system (null when viewing another galaxy). */
  readonly current: string | null;
  /** Systems shown on the map (knowledge above hidden), catalogue order. */
  readonly visible: readonly string[];
  knowledge(id: string): Knowledge;
  unlocked(id: string): boolean;
  state(id: string): SystemState;
  laneVisible(lane: Lane): boolean;
  laneState(lane: Lane): LaneState;
  plan(to: string): RoutePlan;
  /** The system a survey run should chart next: the pilot's own if uncharted, else the nearest reachable uncharted one. */
  suggestion(): string | null;
  markers(id: string): readonly Marker[];
  intel(id: string): SystemIntel;
}

export const ARCHETYPE_POI: Readonly<Record<SectorArchetypeId, string>> = {
  'gate-hub': 'Gate hub',
  'relay-outpost': 'Relay outpost',
  'asteroid-belt': 'Asteroid belt',
  'derelict-yard': 'Derelict yard',
  'nebula-pocket': 'Nebula pocket',
  'stellar-forge': 'Stellar forge',
  'compact-remnant': 'Compact remnant',
  'cluster-field': 'Cluster field',
  'void-drift': 'Void drift',
  'shock-front': 'Shock front',
};
export const HAZARD_LABEL: Readonly<Record<HazardId, string>> = { none: 'None', dust: 'Dust', 'ion-storm': 'Ion storm', radiation: 'Radiation', flare: 'Stellar flares', 'gravity-shear': 'Gravity shear' };
export const PATTERN_LABEL: Readonly<Record<EncounterPattern, string>> = {
  none: 'None',
  patrols: 'Patrols',
  ambush: 'Ambush',
  nest: 'Nest',
  'swarm-tide': 'Swarm tide',
  sentinels: 'Sentinels',
  'convoy-raids': 'Convoy raids',
  gauntlet: 'Gauntlet',
};

interface Search {
  readonly dist: Map<string, number>;
  readonly jumps: Map<string, number>;
  readonly prev: Map<string, string>;
}

/** Cheapest paths (cost, then hops, then id) from `from` through nodes `pass` allows. */
function cheapest(sg: SystemGraph, from: string, pass: (id: string) => boolean): Search {
  const dist = new Map<string, number>([[from, 0]]);
  const jumps = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    let best: string | null = null;
    for (const [id, d] of dist) {
      if (done.has(id)) continue;
      if (best === null) {
        best = id;
        continue;
      }
      const bd = dist.get(best)!;
      if (d < bd || (d === bd && (jumps.get(id)! < jumps.get(best)! || (jumps.get(id) === jumps.get(best) && id < best)))) best = id;
    }
    if (best === null) break;
    done.add(best);
    for (const l of sg.lanesOf(best)) {
      const y = sg.other(l, best);
      if (done.has(y) || !pass(y)) continue;
      const nd = dist.get(best)! + l.cost;
      const nj = jumps.get(best)! + 1;
      const od = dist.get(y);
      if (od === undefined || nd < od || (nd === od && (nj < jumps.get(y)! || (nj === jumps.get(y) && best < prev.get(y)!)))) {
        dist.set(y, nd);
        jumps.set(y, nj);
        prev.set(y, best);
      }
    }
  }
  return { dist, jumps, prev };
}

const pathTo = (s: Search, to: string): string[] => {
  const path = [to];
  for (let p = s.prev.get(to); p !== undefined; p = s.prev.get(p)) path.unshift(p);
  return path;
};

const conditionTouches = (c: (NavGraph['milestones'][number])['condition'], galaxy: GalaxyId): boolean =>
  ((c.kind === 'surveys-in' || c.kind === 'exploration') && c.galaxyId === galaxy) || ((c.kind === 'all' || c.kind === 'any') && c.of.some((x) => conditionTouches(x, galaxy)));

export function deriveSystemView(view: ProgressView, galaxy: GalaxyId): SystemView {
  const sg = systemGraph(view.graph, galaxy);
  const here = view.progress.current === galaxy;
  const current = here && sg.system(view.progress.system) ? view.progress.system : here ? sg.gateway : null;
  const visited = new Set(view.progress.visitedSystems);
  if (current) visited.add(current);
  const charted = view.charted;

  const unlockedCache = new Map<string, boolean>();
  const unlocked = (id: string): boolean => {
    let u = unlockedCache.get(id);
    if (u === undefined) {
      const s = sg.system(id);
      u = s !== undefined && (visited.has(id) || charted.has(id) || s.unlock.every((r) => view.requirementMet(r)));
      unlockedCache.set(id, u);
    }
    return u;
  };
  const knowledgeMap = new Map<string, Knowledge>();
  for (const s of sg.systems) {
    const nbrs = sg.lanesOf(s.id).map((l) => sg.other(l, s.id));
    let k: Knowledge;
    if (charted.has(s.id)) k = 'surveyed';
    else if (s.discovery === 'hidden' && !unlocked(s.id)) k = nbrs.some((y) => charted.has(y)) ? 'signal' : 'hidden'; // sealed signal
    else if (visited.has(s.id) || s.discovery === 'charted' || s.id === sg.gateway || nbrs.some((y) => charted.has(y))) k = 'known';
    else if (s.discovery === 'rumoured' || s.discovery === 'hidden' || nbrs.some((y) => visited.has(y))) k = 'signal'; // an unlocked hidden system appears as a new signal
    else k = 'hidden';
    knowledgeMap.set(s.id, k);
  }
  const knowledge = (id: string): Knowledge => knowledgeMap.get(id) ?? 'hidden';
  const isVisible = (id: string): boolean => knowledge(id) !== 'hidden';
  const visible = sg.systems.filter((s) => isVisible(s.id)).map((s) => s.id);

  // routes the pilot can fly now: known (visible) and enterable systems only
  const open: Search | null = current ? cheapest(sg, current, (id) => isVisible(id) && unlocked(id)) : null;

  const state = (id: string): SystemState => {
    if (id === current) return 'current';
    if (!unlocked(id)) return 'locked';
    if (!here) return 'remote';
    return open!.dist.has(id) ? 'reachable' : 'blocked';
  };

  const laneState = (lane: Lane): LaneState => {
    if (!unlocked(lane.a) || !unlocked(lane.b)) return 'locked';
    return current !== null && (lane.a === current || lane.b === current) ? 'active' : 'open';
  };

  const plan = (to: string): RoutePlan => {
    const blocked = (reason: RouteBlock, blocker: string | null, alternatives: readonly string[] = []): RoutePlanBlocked => ({ ok: false, to, reason, blocker, alternatives });
    if (!sg.system(to) || !isVisible(to)) return blocked('hidden', null);
    if (!here || !current || !open) return blocked('elsewhere', null);
    if (to === current) return blocked('here', null);
    if (open.dist.has(to)) {
      const path = pathTo(open, to);
      const lanes = path.slice(1).map((id, i) => sg.laneBetween(path[i]!, id)!);
      return { ok: true, to, path, lanes, cost: open.dist.get(to)!, jumps: path.length - 1 };
    }
    // alternatives: reachable systems nearest the destination (by lane hops), then cheapest
    const near = sg.hops(to);
    const alternatives = [...open.dist.keys()]
      .filter((id) => id !== current)
      .sort((x, y) => (near.get(x) ?? 99) - (near.get(y) ?? 99) || open.dist.get(x)! - open.dist.get(y)! || (x < y ? -1 : 1))
      .slice(0, 3);
    if (!unlocked(to)) return blocked('locked', to, alternatives);
    const any = cheapest(sg, current, isVisible);
    let blocker: string | null = null;
    if (any.dist.has(to)) blocker = pathTo(any, to).find((id) => !unlocked(id)) ?? null;
    return blocked('no-route', blocker, alternatives);
  };

  const suggestion = (): string | null => {
    if (current && !charted.has(current)) return current;
    if (open) {
      let best: string | null = null;
      for (const [id, d] of open.dist) {
        if (charted.has(id)) continue;
        if (best === null || d < open.dist.get(best)! || (d === open.dist.get(best) && id < best)) best = id;
      }
      return best;
    }
    // another galaxy: its gateway if uncharted, else the first visible uncharted, enterable system
    if (!charted.has(sg.gateway)) return sg.gateway;
    return visible.find((id) => !charted.has(id) && unlocked(id)) ?? null;
  };

  const keySystems = new Set<string>();
  for (const s of sg.systems) for (const r of s.unlock) if (r.kind === 'system') keySystems.add(r.systemId);
  const activeMilestone = view.graph.milestones.find((m) => !view.isComplete(m.id) && conditionTouches(m.condition, galaxy)) ?? null;
  let suggestionCache: string | null | undefined;

  const markers = (id: string): Marker[] => {
    const s = sg.system(id);
    const k = knowledge(id);
    if (!s || k === 'hidden') return [];
    const out: Marker[] = [];
    if (id === sg.gateway) out.push({ kind: 'gateway', label: 'Jump point: jumps into this galaxy arrive here' });
    if (suggestionCache === undefined) suggestionCache = suggestion();
    if (id === suggestionCache) out.push({ kind: 'objective', label: activeMilestone ? `Survey objective: counts towards ${activeMilestone.name}` : 'Survey objective: chart this system next' });
    if (keySystems.has(id) && !charted.has(id) && k !== 'signal') out.push({ kind: 'key', label: 'Key system: charting it may reveal more' });
    if (k === 'known') out.push({ kind: 'resource', label: `Resource hint: ${s.resources.primary}` });
    if (k === 'surveyed') {
      out.push({ kind: 'resource', label: `Resources: ${[s.resources.primary, s.resources.secondary].filter(Boolean).join(', ')} (richness ${s.resources.richness}/3)` });
      const hostile = s.encounters.factions.filter((f) => HOSTILE_FACTIONS.includes(f));
      if (s.encounters.threat > 0 && hostile.length > 0) out.push({ kind: 'hostile', label: `Hostile activity: threat ${s.encounters.threat}/3` });
      if (s.sector.station) out.push({ kind: 'station', label: 'Haven Guild dock' });
      if (anomalyOf(s)) out.push({ kind: 'anomaly', label: 'Anomaly' });
    }
    return out;
  };

  const intel = (id: string): SystemIntel => {
    const s = sg.system(id);
    const k = knowledge(id);
    const none: SystemIntel = {
      knowledge: k,
      name: 'Unknown signal',
      category: null,
      provenance: null,
      difficulty: null,
      description: 'A faint navigation signal. Fly to a neighbouring system or chart one to identify it.',
      fact: null,
      resourceHint: null,
      resources: null,
      hostiles: null,
      friendly: null,
      neutral: null,
      hazard: null,
      pois: null,
      anomaly: null,
    };
    if (!s || k === 'hidden' || k === 'signal') return none;
    const base: SystemIntel = {
      ...none,
      name: s.name,
      category: s.category,
      provenance: s.provenance.status,
      difficulty: s.difficulty,
      description: s.description,
      fact: s.fact,
      resourceHint: s.resources.primary,
    };
    if (k === 'known') return base;
    const hostile = s.encounters.factions.filter((f) => HOSTILE_FACTIONS.includes(f));
    const pois = [`${ARCHETYPE_POI[s.sector.archetype]}`];
    if (s.sector.station) pois.push('Haven Guild dock');
    if (s.sector.salvageNodes > 0) pois.push(`${s.sector.salvageNodes} salvage sites`);
    return {
      ...base,
      resources: s.resources,
      hostiles: { threat: hostile.length ? s.encounters.threat : 0, pattern: hostile.length ? s.encounters.pattern : 'none', factions: hostile },
      friendly: s.encounters.factions.filter((f) => !HOSTILE_FACTIONS.includes(f) && !WARY_FACTIONS.includes(f)),
      neutral: s.encounters.factions.filter((f) => WARY_FACTIONS.includes(f)),
      hazard: { id: s.sector.hazard, strength: s.sector.hazardStrength },
      pois,
      anomaly: anomalyOf(s),
    };
  };

  return {
    view,
    graph: sg,
    galaxy,
    here,
    current,
    visible,
    knowledge,
    unlocked,
    state,
    laneVisible: (lane) => isVisible(lane.a) && isVisible(lane.b),
    laneState,
    plan,
    suggestion: () => (suggestionCache === undefined ? (suggestionCache = suggestion()) : suggestionCache),
    markers,
    intel,
  };
}

function anomalyOf(s: SystemRecord): string | null {
  if (s.provenance.status === 'speculative') return s.provenance.note ?? 'A hypothetical phenomenon (GALAXIA speculation).';
  if (s.category === 'anomaly') return 'An unexplained anomaly (GALAXIA fiction).';
  if (s.sector.hazard === 'gravity-shear') return 'Gravity shear distorts the local lanes (GALAXIA fiction).';
  return null;
}

/* ----------------------------------------------------------------- travel */

export type SystemTravelResult = ({ readonly ok: true; readonly plan: RoutePlanOk } & ProgressChange) | { readonly ok: false; readonly reason: RouteBlock; readonly plan: RoutePlanBlocked };

/** Fly a planned route inside the current galaxy: every system on the way is visited. */
export function applySystemTravel(graph: NavGraph, progress: ExplorationProgress, to: string): SystemTravelResult {
  const before = deriveView(graph, progress);
  const plan = deriveSystemView(before, progress.current).plan(to);
  if (!plan.ok) return { ok: false, reason: plan.reason, plan };
  const visitedSystems = [...progress.visitedSystems];
  for (const id of plan.path) if (!visitedSystems.includes(id)) visitedSystems.push(id);
  const next: ExplorationProgress = { ...progress, system: to, visitedSystems };
  return { ok: true, plan, ...progressDiff(graph, before, next) };
}
