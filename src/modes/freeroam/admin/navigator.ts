/**
 * Admin Navigator view model (P04). Pure: no DOM, no storage, no clock.
 *
 * Lists exactly what the catalogue has: every galaxy (NavGraph nodes) and
 * every system of each galaxy (catalogue order). Each system is one sector
 * the game generates from its catalogue record; a system with a station can
 * also be entered beside the station. Nothing is invented to pad the list.
 *
 * The rows also say what ordinary play would allow from the normal progress
 * (locked galaxy, sealed or undiscovered system), so the owner can see which
 * places are normally out of reach. That is information only: admin travel
 * ignores it (session.ts resolveDestination).
 */
import type { GalaxyId, SystemRecord } from '../catalogue/types.ts';
import type { NavGraph } from '../galaxy/graph.ts';
import type { ProgressView } from '../galaxy/progress.ts';
import { deriveSystemView, type SystemView } from '../galaxy/systems.ts';

export interface NavGalaxyRow {
  readonly id: GalaxyId;
  readonly name: string;
  readonly short: string;
  readonly systems: number;
  readonly stations: number;
  readonly here: boolean;
  /** Ordinary play: the galaxy's own unlock requirements are unmet. */
  readonly normallyLocked: boolean;
}

/** What ordinary play would say about entering this system right now. */
export type NormalAccess = 'open' | 'locked' | 'undiscovered' | 'other-galaxy-locked';

export interface NavSystemRow {
  readonly id: string;
  readonly galaxy: GalaxyId;
  readonly galaxyName: string;
  readonly name: string;
  readonly category: string;
  readonly difficulty: number;
  readonly station: boolean;
  readonly gateway: boolean;
  readonly here: boolean;
  readonly normal: NormalAccess;
}

export const NORMAL_TEXT: Readonly<Record<NormalAccess, string>> = Object.freeze({
  open: 'OPEN IN NORMAL PLAY',
  locked: 'LOCKED IN NORMAL PLAY',
  undiscovered: 'UNDISCOVERED IN NORMAL PLAY',
  'other-galaxy-locked': 'GALAXY LOCKED IN NORMAL PLAY',
});

export function navigatorGalaxies(view: ProgressView): NavGalaxyRow[] {
  const g = view.graph;
  return g.nodes.map((n) => {
    const systems = g.systemsIn(n.id);
    return {
      id: n.id,
      name: n.galaxy.name,
      short: n.galaxy.shortName,
      systems: systems.length,
      stations: systems.filter((s) => s.sector.station).length,
      here: view.progress.current === n.id,
      normallyLocked: !view.galaxyUnlocked(n.id),
    };
  });
}

const CATEGORY_LABEL = (c: string): string => c.replace(/-/g, ' ').toUpperCase();

function row(view: ProgressView, sv: SystemView, s: SystemRecord, galaxyLocked: boolean, galaxyName: string): NavSystemRow {
  const k = sv.knowledge(s.id);
  const normal: NormalAccess = galaxyLocked ? 'other-galaxy-locked' : !sv.unlocked(s.id) ? 'locked' : k === 'hidden' || k === 'signal' ? 'undiscovered' : 'open';
  return {
    id: s.id,
    galaxy: s.galaxyId,
    galaxyName,
    name: s.name,
    category: CATEGORY_LABEL(s.category),
    difficulty: s.difficulty,
    station: s.sector.station,
    gateway: s.gateway,
    here: view.progress.system === s.id,
    normal,
  };
}

const matches = (r: NavSystemRow, q: string): boolean => {
  const hay = `${r.name} ${r.id} ${r.category} ${r.galaxyName} ${r.station ? 'station' : ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
};

/**
 * Systems of one galaxy (catalogue order); with a query, matching systems of
 * every galaxy instead (galaxy order, then catalogue order). `normalView` is
 * the ordinary progress, so the access notes describe normal play.
 */
export function navigatorSystems(normalView: ProgressView, galaxy: GalaxyId, query = ''): NavSystemRow[] {
  const g: NavGraph = normalView.graph;
  const q = query.trim();
  const ids = q ? g.nodes.map((n) => n.id) : [galaxy];
  const out: NavSystemRow[] = [];
  for (const id of ids) {
    const node = g.node(id);
    if (!node) continue;
    const sv = deriveSystemView(normalView, id);
    const locked = !normalView.galaxyUnlocked(id);
    for (const s of g.systemsIn(id)) {
      const r = row(normalView, sv, s, locked, node.galaxy.name);
      if (!q || matches(r, q)) out.push(r);
    }
  }
  return out;
}

/** Every destination the navigator can offer: each system's arrival, plus its station when it has one. */
export function allDestinations(graph: NavGraph): { readonly galaxy: GalaxyId; readonly system: string; readonly arrival: 'arrival' | 'station' }[] {
  const out: { galaxy: GalaxyId; system: string; arrival: 'arrival' | 'station' }[] = [];
  for (const n of graph.nodes) {
    for (const s of graph.systemsIn(n.id)) {
      out.push({ galaxy: n.id, system: s.id, arrival: 'arrival' });
      if (s.sector.station) out.push({ galaxy: n.id, system: s.id, arrival: 'station' });
    }
  }
  return out;
}
