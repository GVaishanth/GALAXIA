/**
 * Galaxy travel graph (pure). Built only from the validated catalogue: the
 * nodes are catalogue galaxies and the edges are catalogue routes, so the map
 * can never show a destination or a route the catalogue does not have.
 *
 * Also derives each galaxy's survey order (which system a survey run charts
 * next): breadth-first over same-galaxy lanes from the gateway, neighbours
 * ordered by difficulty then id. Deterministic for a given catalogue.
 */
import { getCatalogue } from '../catalogue/index.ts';
import type { Catalogue, GalaxyId, GalaxyRecord, MilestoneRecord, RouteRecord, SystemRecord } from '../catalogue/types.ts';

export interface NavNode {
  readonly id: GalaxyId;
  readonly galaxy: GalaxyRecord;
  /** Systems in this galaxy (denominator of exploration %). */
  readonly systemCount: number;
}

export interface NavEdge {
  readonly id: string;
  readonly from: GalaxyId;
  readonly to: GalaxyId;
  readonly route: RouteRecord;
}

export interface NavGraph {
  readonly catalogue: Catalogue;
  readonly nodes: readonly NavNode[];
  readonly edges: readonly NavEdge[];
  readonly milestones: readonly MilestoneRecord[];
  readonly start: GalaxyId;
  readonly explorerLevelStep: number;
  node(id: string): NavNode | undefined;
  /** Edges touching a galaxy, in catalogue order. */
  edgesOf(id: GalaxyId): readonly NavEdge[];
  edgeBetween(a: GalaxyId, b: GalaxyId): NavEdge | undefined;
  /** The galaxy at the other end of an edge. */
  other(edge: NavEdge, id: GalaxyId): GalaxyId;
  milestone(id: string): MilestoneRecord | undefined;
  system(id: string): SystemRecord | undefined;
  systemsIn(id: GalaxyId): readonly SystemRecord[];
  surveyOrder(id: GalaxyId): readonly SystemRecord[];
}

/** Canonical id of the route between two galaxies (catalogue convention). */
export const routeId = (a: string, b: string): string => (a < b ? `${a}~${b}` : `${b}~${a}`);

function surveyOrderFor(systems: readonly SystemRecord[], byId: ReadonlyMap<string, SystemRecord>): SystemRecord[] {
  const gateway = systems.find((s) => s.gateway);
  if (!gateway) return [...systems].sort((a, b) => a.difficulty - b.difficulty || (a.id < b.id ? -1 : 1));
  const seen = new Set<string>([gateway.id]);
  const order: SystemRecord[] = [gateway];
  for (let i = 0; i < order.length; i++) {
    const next = order[i]!.connections
      .map((c) => byId.get(c))
      .filter((s): s is SystemRecord => s !== undefined && s.galaxyId === gateway.galaxyId && !seen.has(s.id))
      .sort((a, b) => a.difficulty - b.difficulty || (a.id < b.id ? -1 : 1));
    for (const s of next) {
      seen.add(s.id);
      order.push(s);
    }
  }
  // systems not linked by lanes (the validator forbids this) still get a place
  for (const s of systems) if (!seen.has(s.id)) order.push(s);
  return order;
}

export function buildNavGraph(catalogue: Catalogue = getCatalogue()): NavGraph {
  const systemsById = new Map(catalogue.systems.map((s) => [s.id, s]));
  const byGalaxy = new Map<string, SystemRecord[]>();
  for (const s of catalogue.systems) byGalaxy.set(s.galaxyId, [...(byGalaxy.get(s.galaxyId) ?? []), s]);
  const nodes: NavNode[] = catalogue.galaxies.map((g) => ({ id: g.id, galaxy: g, systemCount: byGalaxy.get(g.id)?.length ?? 0 }));
  const nodeById = new Map(nodes.map((n) => [n.id as string, n]));
  const edges: NavEdge[] = catalogue.routes
    .filter((r) => nodeById.has(r.from) && nodeById.has(r.to) && r.from !== r.to)
    .map((r) => ({ id: r.id, from: r.from, to: r.to, route: r }));
  const edgeByPair = new Map(edges.map((e) => [routeId(e.from, e.to), e]));
  const milestones = new Map(catalogue.milestones.map((m) => [m.id, m]));
  const orders = new Map<string, SystemRecord[]>();
  for (const n of nodes) orders.set(n.id, surveyOrderFor(byGalaxy.get(n.id) ?? [], systemsById));
  return Object.freeze({
    catalogue,
    nodes,
    edges,
    milestones: catalogue.milestones,
    start: catalogue.progression.startGalaxy,
    explorerLevelStep: catalogue.progression.explorerLevelStep,
    node: (id: string) => nodeById.get(id),
    edgesOf: (id: GalaxyId) => edges.filter((e) => e.from === id || e.to === id),
    edgeBetween: (a: GalaxyId, b: GalaxyId) => edgeByPair.get(routeId(a, b)),
    other: (edge: NavEdge, id: GalaxyId) => (edge.from === id ? edge.to : edge.from),
    milestone: (id: string) => milestones.get(id),
    system: (id: string) => systemsById.get(id),
    systemsIn: (id: GalaxyId) => byGalaxy.get(id) ?? [],
    surveyOrder: (id: GalaxyId) => orders.get(id) ?? [],
  });
}
