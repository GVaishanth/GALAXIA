/**
 * Exploration progress and unlocks (pure, deterministic).
 *
 * Stored state is small and monotonic: where the pilot is (galaxy and system),
 * which galaxies and systems they have visited, which systems survey runs have
 * charted, and how many survey runs they flew per galaxy. Since Prompt 5 a
 * survey run charts the system the pilot is at (travel there on the system
 * map, galaxy/systems.ts); a jump to another galaxy arrives at its gateway.
 * Everything else (completed milestones, drive tier, explorer level, unlocked
 * galaxies, open routes) is *derived* from it and the
 * catalogue's milestone table, so unlocks can never drift out of sync with the
 * data, and the same progress always yields the same unlocks.
 */
import type { GalaxyId, MilestoneCondition, MilestoneRecord, SystemRecord, UnlockRequirement } from '../catalogue/types.ts';
import type { NavEdge, NavGraph } from './graph.ts';

export interface ExplorationProgress {
  readonly current: GalaxyId;
  readonly visited: readonly GalaxyId[];
  /** Systems charted by survey runs (milestone rewards are derived, not stored). */
  readonly charted: readonly string[];
  /** Survey runs completed per galaxy id. */
  readonly surveys: Readonly<Record<string, number>>;
  /** System the pilot is at, always inside `current`. */
  readonly system: string;
  /** Systems the pilot has been to (any galaxy). */
  readonly visitedSystems: readonly string[];
}

/** The system a jump into this galaxy arrives at. */
export const gatewayOf = (graph: NavGraph, id: GalaxyId): string => graph.node(id)!.galaxy.gameplay.gatewaySystemId;

export function initialProgress(graph: NavGraph): ExplorationProgress {
  const gate = gatewayOf(graph, graph.start);
  return { current: graph.start, visited: [graph.start], charted: [], surveys: {}, system: gate, visitedSystems: [gate] };
}

/** Rebuild progress from untrusted saved fields: unknown ids are dropped, the start galaxy is the fallback. */
export function progressFromSaved(
  graph: NavGraph,
  saved: {
    readonly currentGalaxy: string;
    readonly visitedGalaxies: readonly string[];
    readonly chartedSystems: readonly string[];
    readonly galaxySurveys: Readonly<Record<string, number>>;
    readonly currentSystem?: string | undefined;
    readonly visitedSystems?: readonly string[] | undefined;
  },
): ExplorationProgress {
  const known = (id: string): id is GalaxyId => graph.node(id) !== undefined;
  const current = known(saved.currentGalaxy) ? saved.currentGalaxy : graph.start;
  const visited = [...new Set([graph.start, ...saved.visitedGalaxies.filter(known), current])];
  const charted = [...new Set(saved.chartedSystems.filter((id) => graph.system(id) !== undefined))];
  const surveys: Record<string, number> = {};
  for (const [id, n] of Object.entries(saved.galaxySurveys)) if (known(id) && Number.isInteger(n) && n > 0) surveys[id] = n;
  const visitedSystems = (saved.visitedSystems ?? []).filter((id) => graph.system(id) !== undefined);
  // The saved system must be in the current galaxy and one the pilot could have entered
  // (no requirements, or already visited / charted); anything else falls back to the gateway.
  const sys = saved.currentSystem ? graph.system(saved.currentSystem) : undefined;
  const enterable = sys !== undefined && sys.galaxyId === current && (sys.unlock.length === 0 || visitedSystems.includes(sys.id) || charted.includes(sys.id));
  const system = enterable ? sys.id : gatewayOf(graph, current);
  return { current, visited, charted, surveys, system, visitedSystems: [...new Set([...visitedSystems, system])] };
}

export interface Exploration {
  readonly charted: number;
  readonly total: number;
  /** floor(charted / total * 100). */
  readonly percent: number;
}

export interface ProgressView {
  readonly graph: NavGraph;
  readonly progress: ExplorationProgress;
  /** Completed milestones in completion order. */
  readonly completed: readonly MilestoneRecord[];
  readonly charted: ReadonlySet<string>;
  readonly driveTier: number;
  readonly totalSurveys: number;
  readonly explorerLevel: number;
  isComplete(milestoneId: string): boolean;
  exploration(id: GalaxyId): Exploration;
  surveysIn(id: GalaxyId): number;
  requirementMet(req: UnlockRequirement): boolean;
  conditionMet(cond: MilestoneCondition): boolean;
  galaxyUnlocked(id: GalaxyId): boolean;
  routeOpen(edge: NavEdge): boolean;
  /** The system the next survey run in this galaxy charts (null when nothing is chartable). */
  nextSurveyTarget(id: GalaxyId): SystemRecord | null;
}

export function explorerLevel(chartedCount: number, step: number): number {
  return 1 + Math.floor(chartedCount / Math.max(1, step));
}

export function deriveView(graph: NavGraph, progress: ExplorationProgress): ProgressView {
  const charted = new Set(progress.charted.filter((id) => graph.system(id) !== undefined));
  const visited = new Set<string>(progress.visited);
  const completedIds = new Set<string>();
  const completed: MilestoneRecord[] = [];
  let driveTier = 1;
  const totalSurveys = Object.values(progress.surveys).reduce((a, n) => a + n, 0);
  const surveysIn = (id: GalaxyId): number => progress.surveys[id] ?? 0;
  const exploration = (id: GalaxyId): Exploration => {
    const systems = graph.systemsIn(id);
    let n = 0;
    for (const s of systems) if (charted.has(s.id)) n++;
    return { charted: n, total: systems.length, percent: systems.length ? Math.floor((n * 100) / systems.length) : 0 };
  };
  const level = (): number => explorerLevel(charted.size, graph.explorerLevelStep);
  const conditionMet = (c: MilestoneCondition): boolean => {
    switch (c.kind) {
      case 'surveys-in':
        return surveysIn(c.galaxyId) >= c.count;
      case 'exploration':
        return exploration(c.galaxyId).percent >= c.percent;
      case 'explorer-level':
        return level() >= c.level;
      case 'milestone':
        return completedIds.has(c.milestoneId);
      case 'all':
        return c.of.every(conditionMet);
      case 'any':
        return c.of.some(conditionMet);
    }
  };
  // Fixed point: a milestone's rewards (charted systems, drive tier) can complete others.
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of graph.milestones) {
      if (completedIds.has(m.id) || !conditionMet(m.condition)) continue;
      completedIds.add(m.id);
      completed.push(m);
      if (m.rewards.driveTier !== null) driveTier = Math.max(driveTier, m.rewards.driveTier);
      for (const sid of m.rewards.chartSystems) if (graph.system(sid)) charted.add(sid);
      changed = true;
    }
  }
  const requirementMet = (r: UnlockRequirement): boolean => {
    switch (r.kind) {
      case 'system':
        return charted.has(r.systemId);
      case 'galaxy':
        return visited.has(r.galaxyId);
      case 'drive':
        return driveTier >= r.tier;
      case 'surveys':
        return totalSurveys >= r.count;
      case 'milestone':
        return completedIds.has(r.milestoneId);
    }
  };
  const galaxyUnlocked = (id: GalaxyId): boolean => {
    const n = graph.node(id);
    return n !== undefined && (id === progress.current || visited.has(id) || n.galaxy.gameplay.unlock.every(requirementMet));
  };
  const finalLevel = level();
  return {
    graph,
    progress,
    completed,
    charted,
    driveTier,
    totalSurveys,
    explorerLevel: finalLevel,
    isComplete: (id) => completedIds.has(id),
    exploration,
    surveysIn,
    requirementMet,
    conditionMet,
    galaxyUnlocked,
    routeOpen: (edge) => edge.route.unlock.every(requirementMet),
    nextSurveyTarget: (id) => graph.surveyOrder(id).find((s) => !charted.has(s.id) && s.unlock.every(requirementMet)) ?? null,
  };
}

/* -------------------------------------------------------------- map states */

/**
 * current     the pilot is here
 * available   unlocked and one open route away: can travel now
 * discovered  unlocked (or visited) but not reachable in one jump from here
 * locked      unlock requirements not met yet
 */
export type NodeState = 'current' | 'available' | 'discovered' | 'locked';
/** active = open route touching the current galaxy; sealed = route requirements unmet; locked = an end is locked. */
export type EdgeState = 'active' | 'open' | 'sealed' | 'locked';
export type TravelBlock = 'here' | 'locked' | 'no-route' | 'sealed';
export type TravelCheck = { readonly ok: true; readonly edge: NavEdge } | { readonly ok: false; readonly reason: TravelBlock; readonly edge: NavEdge | null };

export function checkTravel(view: ProgressView, to: GalaxyId): TravelCheck {
  const from = view.progress.current;
  const edge = view.graph.edgeBetween(from, to) ?? null;
  if (to === from) return { ok: false, reason: 'here', edge: null };
  if (!view.graph.node(to) || !view.galaxyUnlocked(to)) return { ok: false, reason: 'locked', edge };
  if (!edge) return { ok: false, reason: 'no-route', edge: null };
  if (!view.routeOpen(edge)) return { ok: false, reason: 'sealed', edge };
  return { ok: true, edge };
}

export function nodeState(view: ProgressView, id: GalaxyId): NodeState {
  if (id === view.progress.current) return 'current';
  if (!view.galaxyUnlocked(id)) return 'locked';
  return checkTravel(view, id).ok ? 'available' : 'discovered';
}

export function edgeState(view: ProgressView, edge: NavEdge): EdgeState {
  if (!view.galaxyUnlocked(edge.from) || !view.galaxyUnlocked(edge.to)) return 'locked';
  if (!view.routeOpen(edge)) return 'sealed';
  return edge.from === view.progress.current || edge.to === view.progress.current ? 'active' : 'open';
}

/** Shortest chain of open routes through unlocked galaxies, current -> `to` inclusive; null if none. */
export function findPath(view: ProgressView, to: GalaxyId): GalaxyId[] | null {
  const start = view.progress.current;
  if (start === to) return [start];
  const prev = new Map<GalaxyId, GalaxyId>();
  const queue: GalaxyId[] = [start];
  const seen = new Set<GalaxyId>([start]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of view.graph.edgesOf(cur)) {
      const nxt = view.graph.other(e, cur);
      if (seen.has(nxt) || !view.galaxyUnlocked(nxt) || !view.routeOpen(e)) continue;
      seen.add(nxt);
      prev.set(nxt, cur);
      if (nxt === to) {
        const path: GalaxyId[] = [to];
        for (let p = prev.get(to); p !== undefined; p = prev.get(p)) path.unshift(p);
        return path;
      }
      queue.push(nxt);
    }
  }
  return null;
}

/* ----------------------------------------------------------------- updates */

export interface ProgressChange {
  readonly progress: ExplorationProgress;
  readonly newMilestones: readonly MilestoneRecord[];
  readonly newGalaxies: readonly GalaxyId[];
  readonly newRoutes: readonly string[];
}

/** What changed between `before` and the new progress (milestones, galaxies, routes). */
export function progressDiff(graph: NavGraph, before: ProgressView, progress: ExplorationProgress): ProgressChange {
  const after = deriveView(graph, progress);
  return {
    progress,
    newMilestones: after.completed.filter((m) => !before.isComplete(m.id)),
    newGalaxies: graph.nodes.filter((n) => !before.galaxyUnlocked(n.id) && after.galaxyUnlocked(n.id)).map((n) => n.id),
    newRoutes: graph.edges.filter((e) => !before.routeOpen(e) && after.routeOpen(e)).map((e) => e.id),
  };
}

export interface SurveyResult extends ProgressChange {
  readonly galaxy: GalaxyId;
  /** The system this run charted (null when the galaxy has nothing chartable left). */
  readonly chartedSystem: SystemRecord | null;
}

/**
 * A completed survey run: counts the run in the current galaxy and charts the
 * system the pilot is at (nothing new when it is already charted; the run
 * still counts towards survey milestones).
 */
export function applySurvey(graph: NavGraph, progress: ExplorationProgress): SurveyResult {
  const before = deriveView(graph, progress);
  const g = progress.current;
  const here = graph.system(progress.system);
  const target = here && here.galaxyId === g && !before.charted.has(here.id) ? here : null;
  const next: ExplorationProgress = {
    ...progress,
    surveys: { ...progress.surveys, [g]: (progress.surveys[g] ?? 0) + 1 },
    charted: target ? [...progress.charted, target.id] : progress.charted,
  };
  return { ...progressDiff(graph, before, next), galaxy: g, chartedSystem: target };
}

export type TravelResult = ({ readonly ok: true; readonly edge: NavEdge } & ProgressChange) | { readonly ok: false; readonly reason: TravelBlock };

/** Travel along one open route. Instant in the prototype; the map plays a short cosmetic transition afterwards. */
export function applyTravel(graph: NavGraph, progress: ExplorationProgress, to: GalaxyId): TravelResult {
  const before = deriveView(graph, progress);
  const check = checkTravel(before, to);
  if (!check.ok) return { ok: false, reason: check.reason };
  const gate = gatewayOf(graph, to);
  const next: ExplorationProgress = {
    ...progress,
    current: to,
    visited: progress.visited.includes(to) ? progress.visited : [...progress.visited, to],
    system: gate,
    visitedSystems: progress.visitedSystems.includes(gate) ? progress.visitedSystems : [...progress.visitedSystems, gate],
  };
  return { ok: true, edge: check.edge, ...progressDiff(graph, before, next) };
}

/* ------------------------------------------------------------ explanations */

export interface RequirementLine {
  readonly text: string;
  readonly met: boolean;
  /** "1 / 3", "20%", "LV 2" or null. */
  readonly progress: string | null;
}

export interface RequirementInfo {
  /** Milestone name, or a short label for non-milestone requirements. */
  readonly title: string;
  readonly detail: string;
  readonly met: boolean;
  readonly progress: string | null;
  /** Per-condition lines for composite milestones ("all" / "any"). */
  readonly parts: readonly RequirementLine[];
}

/** "the Milky Way", "the Large Magellanic Cloud", but "Centaurus A". */
export function theName(name: string): string {
  return / [A-Z0-9]$/.test(name) ? name : `the ${name}`;
}

function conditionLine(view: ProgressView, c: MilestoneCondition): RequirementLine {
  const gName = (id: GalaxyId): string => theName(view.graph.node(id)?.galaxy.name ?? id);
  const met = view.conditionMet(c);
  switch (c.kind) {
    case 'surveys-in':
      return { text: `Complete ${c.count} survey run${c.count === 1 ? '' : 's'} in ${gName(c.galaxyId)}`, met, progress: `${Math.min(view.surveysIn(c.galaxyId), c.count)} / ${c.count}` };
    case 'exploration':
      return { text: `Explore ${c.percent}% of ${gName(c.galaxyId)}`, met, progress: `${view.exploration(c.galaxyId).percent}% / ${c.percent}%` };
    case 'explorer-level':
      return { text: `Reach explorer level ${c.level} (${(c.level - 1) * view.graph.explorerLevelStep} systems charted)`, met, progress: `LV ${view.explorerLevel} / ${c.level}` };
    case 'milestone':
      return { text: `Complete the ${view.graph.milestone(c.milestoneId)?.name ?? c.milestoneId} milestone`, met, progress: null };
    case 'all':
    case 'any': {
      const n = c.of.filter((x) => view.conditionMet(x)).length;
      return { text: c.kind === 'all' ? 'All of the following' : 'Any one of the following', met, progress: `${n} / ${c.kind === 'all' ? c.of.length : 1}` };
    }
  }
}

export function describeRequirement(view: ProgressView, req: UnlockRequirement): RequirementInfo {
  const met = view.requirementMet(req);
  switch (req.kind) {
    case 'milestone': {
      const m = view.graph.milestone(req.milestoneId);
      if (!m) return { title: req.milestoneId, detail: 'Unknown milestone', met, progress: null, parts: [] };
      const head = conditionLine(view, m.condition);
      const parts = m.condition.kind === 'all' || m.condition.kind === 'any' ? m.condition.of.map((c) => conditionLine(view, c)) : [];
      return { title: m.name, detail: m.description, met, progress: head.progress, parts };
    }
    case 'system':
      return { title: 'Chart a system', detail: `Chart ${view.graph.system(req.systemId)?.name ?? req.systemId}.`, met, progress: null, parts: [] };
    case 'galaxy':
      return { title: 'Visit a galaxy', detail: `Travel to ${theName(view.graph.node(req.galaxyId)?.galaxy.name ?? req.galaxyId)}.`, met, progress: null, parts: [] };
    case 'drive':
      return { title: `Jump Drive Mk ${req.tier}`, detail: `Needs Jump Drive tier ${req.tier}.`, met, progress: `Mk ${view.driveTier} / ${req.tier}`, parts: [] };
    case 'surveys':
      return { title: 'Survey runs', detail: `Complete ${req.count} survey runs in total.`, met, progress: `${Math.min(view.totalSurveys, req.count)} / ${req.count}`, parts: [] };
  }
}
