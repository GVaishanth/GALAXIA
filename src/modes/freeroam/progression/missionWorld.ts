/**
 * The mission world (Free Roam Prompt 11): what missions and contract boards
 * may target, built from the catalogue, the navigation progress and the saved
 * sector changes. Sector layouts are regenerated from their seeds (they are
 * deterministic and immutable, so a small cache is safe); a POI is `done`
 * when the save says so. Pure (no DOM, no storage).
 */
import type { NavGraph } from '../galaxy/graph.ts';
import { deriveView, type ExplorationProgress } from '../galaxy/progress.ts';
import { deriveSystemView, systemGraph } from '../galaxy/systems.ts';
import { sectorContext } from '../sector/context.ts';
import { generateSector } from '../sector/generate.ts';
import type { SectorLayout } from '../sector/model.ts';
import type { MissionWorld, WorldSite } from './missions.ts';

const LAYOUT_CACHE_MAX = 96;
const layouts = new Map<string, SectorLayout>();

/** The sector layout of a system (cached; layouts never change for a catalogue). */
export function layoutOf(graph: NavGraph, systemId: string): SectorLayout | null {
  const hit = layouts.get(systemId);
  if (hit) return hit;
  const sys = graph.system(systemId);
  if (!sys) return null;
  const L = generateSector(sys, sectorContext(graph, systemId));
  if (layouts.size >= LAYOUT_CACHE_MAX) layouts.delete(layouts.keys().next().value!);
  layouts.set(systemId, L);
  return L;
}

/** Mission-relevant sites of a layout: POIs by kind, encounter sites as `site:<kind>`, patrol routes as `patrol`. */
export function layoutSites(L: SectorLayout, done: readonly string[]): WorldSite[] {
  const d = new Set(done);
  const out: WorldSite[] = [];
  for (const p of L.pois) if (p.kind !== 'gate' && p.kind !== 'exit') out.push({ id: p.id, kind: p.kind, done: d.has(p.id) });
  for (const s of L.sites) out.push({ id: s.id, kind: `site:${s.kind}`, done: d.has(s.id) });
  for (const p of L.patrols) out.push({ id: p.id, kind: 'patrol', done: false, ships: p.ships });
  return out;
}

export function buildMissionWorld(graph: NavGraph, progress: ExplorationProgress, sectors: Readonly<Record<string, { readonly done: readonly string[] }>>): MissionWorld {
  const view = deriveView(graph, progress);
  const views = new Map<string, ReturnType<typeof deriveSystemView>>();
  const sv = (g: string): ReturnType<typeof deriveSystemView> => {
    let v = views.get(g);
    if (!v) views.set(g, (v = deriveSystemView(view, g as never)));
    return v;
  };
  const hopCache = new Map<string, ReadonlyMap<string, number>>();
  const hopsFrom = (from: string): ReadonlyMap<string, number> => {
    let h = hopCache.get(from);
    if (!h) {
      const sys = graph.system(from);
      h = sys ? systemGraph(graph, sys.galaxyId).hops(from) : new Map<string, number>();
      hopCache.set(from, h);
    }
    return h;
  };
  return {
    galaxy: progress.current,
    system: progress.system,
    systemsIn: (g) => graph.systemsIn(g as never).map((s) => s.id),
    hops: (from, to) => (from === to ? 0 : (hopsFrom(from).get(to) ?? Infinity)),
    enterable: (id) => {
      const sys = graph.system(id);
      if (!sys) return false;
      const v = sv(sys.galaxyId);
      if (!v.unlocked(id)) return false;
      // in the pilot's galaxy only systems the map can route to; elsewhere every unlocked system
      return !v.here || v.state(id) === 'current' || v.state(id) === 'reachable';
    },
    visited: (id) => progress.visitedSystems.includes(id),
    charted: (id) => view.charted.has(id),
    station: (id) => graph.system(id)?.sector.station === true,
    difficulty: (id) => graph.system(id)?.difficulty ?? 1,
    sites: (id) => {
      const L = layoutOf(graph, id);
      return L ? layoutSites(L, sectors[id]?.done ?? []) : [];
    },
    name: (id) => graph.system(id)?.name ?? id,
  };
}
