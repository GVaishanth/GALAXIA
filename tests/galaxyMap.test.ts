import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { GALAXY_IDS, type GalaxyId } from '../src/modes/freeroam/catalogue/types.ts';
import { buildNavGraph, routeId } from '../src/modes/freeroam/galaxy/graph.ts';
import { galaxyPixels } from '../src/modes/freeroam/galaxy/galaxyArt.ts';
import { mapKeyCommands, mapPadCommands } from '../src/modes/freeroam/input.ts';
import { computeMapLayout, MAP_CELLS, MAP_GRID, nodeBox, spatialNext, type Direction, type Orientation } from '../src/modes/freeroam/galaxy/layout.ts';
import {
  applySurvey,
  applyTravel,
  checkTravel,
  deriveView,
  describeRequirement,
  edgeState,
  findPath,
  initialProgress,
  nodeState,
  progressFromSaved,
  theName,
  type ExplorationProgress,
} from '../src/modes/freeroam/galaxy/progress.ts';
import { applySystemTravel, deriveSystemView } from '../src/modes/freeroam/galaxy/systems.ts';

const graph = buildNavGraph();
const cat = getCatalogue();
const fresh = (): ExplorationProgress => initialProgress(graph);
/** Fly to the system the map suggests (if not already there), then survey it. */
const toSuggestion = (p: ExplorationProgress): ExplorationProgress => {
  const sug = deriveSystemView(deriveView(graph, p), p.current).suggestion();
  if (!sug || sug === p.system) return p;
  const r = applySystemTravel(graph, p, sug);
  if (!r.ok) throw new Error(`system travel to ${sug} blocked: ${r.reason}`);
  return r.progress;
};
const surveyN = (p: ExplorationProgress, n: number): ExplorationProgress => {
  let q = p;
  for (let i = 0; i < n; i++) q = applySurvey(graph, toSuggestion(q)).progress;
  return q;
};
const travel = (p: ExplorationProgress, to: GalaxyId): ExplorationProgress => {
  const r = applyTravel(graph, p, to);
  if (!r.ok) throw new Error(`travel to ${to} blocked: ${r.reason}`);
  return r.progress;
};
const states = (p: ExplorationProgress): Record<string, string> => {
  const v = deriveView(graph, p);
  return Object.fromEntries(graph.nodes.map((n) => [n.id, nodeState(v, n.id)]));
};

describe('galaxy graph: built from the validated catalogue only', () => {
  it('has exactly one node per catalogue galaxy, with stable ids and no duplicates', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual(cat.galaxies.map((g) => g.id));
    expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(10);
    expect([...graph.nodes.map((n) => n.id)].sort()).toEqual([...GALAXY_IDS].sort());
    for (const n of graph.nodes) {
      expect(n.galaxy).toBe(cat.galaxies.find((g) => g.id === n.id)); // the same frozen record, not a copy
      expect(n.systemCount).toBe(cat.systems.filter((s) => s.galaxyId === n.id).length);
      expect(n.galaxy.shortName.length).toBeLessThanOrEqual(12);
    }
  });

  it('uses every catalogue route as an edge with valid endpoints and canonical, stable ids', () => {
    expect(graph.edges.map((e) => e.id)).toEqual(cat.routes.map((r) => r.id));
    expect(graph.edges.map((e) => e.id)).toEqual([
      'lmc~milky-way',
      'milky-way~smc',
      'lmc~smc',
      'andromeda~milky-way',
      'andromeda~triangulum',
      'andromeda~centaurus-a',
      'pinwheel~triangulum',
      'pinwheel~whirlpool',
      'sombrero~whirlpool',
      'centaurus-a~sombrero',
      'cartwheel~sombrero',
    ]);
    for (const e of graph.edges) {
      expect(graph.node(e.from), e.id).toBeDefined();
      expect(graph.node(e.to), e.id).toBeDefined();
      expect(e.from < e.to, e.id).toBe(true);
      expect(e.id).toBe(routeId(e.to, e.from));
      expect(graph.edgeBetween(e.to, e.from)).toBe(e); // symmetric lookup
      expect(e.route.cost).toBeGreaterThanOrEqual(1);
      expect(['low', 'moderate', 'high', 'extreme']).toContain(e.route.risk);
      expect(['local-lane', 'gate-jump', 'deep-jump', 'rift-jump']).toContain(e.route.routeClass);
    }
  });

  it('is sparse, connected and shaped for progression (not every galaxy connected directly)', () => {
    expect(graph.edges.length).toBeLessThan((10 * 9) / 2);
    for (const n of graph.nodes) expect(graph.edgesOf(n.id).length, n.id).toBeGreaterThanOrEqual(1);
    for (const n of graph.nodes) expect(graph.edgesOf(n.id).length, n.id).toBeLessThanOrEqual(4);
    // distance in jumps from home: the far galaxies really are far
    const dist = new Map<GalaxyId, number>([['milky-way', 0]]);
    const q: GalaxyId[] = ['milky-way'];
    while (q.length) {
      const cur = q.shift()!;
      for (const e of graph.edgesOf(cur)) {
        const o = graph.other(e, cur);
        if (!dist.has(o)) (dist.set(o, dist.get(cur)! + 1), q.push(o));
      }
    }
    expect(dist.size).toBe(10);
    expect(dist.get('lmc')).toBe(1);
    expect(dist.get('andromeda')).toBe(1);
    expect(dist.get('cartwheel')).toBe(4);
    expect(graph.edgeBetween('milky-way', 'cartwheel')).toBeUndefined();
  });

  it('derives a deterministic survey order per galaxy starting at the gateway', () => {
    for (const n of graph.nodes) {
      const order = graph.surveyOrder(n.id);
      expect(order.length, n.id).toBe(n.systemCount);
      expect(new Set(order.map((s) => s.id)).size).toBe(n.systemCount);
      expect(order[0]!.id).toBe(n.galaxy.gameplay.gatewaySystemId);
    }
    expect(buildNavGraph().surveyOrder('lmc').map((s) => s.id)).toEqual(graph.surveyOrder('lmc').map((s) => s.id));
  });
});

describe('galaxy unlocks: deterministic milestones', () => {
  it('starts a new pilot at home with a useful open route (LMC) and everything else explained', () => {
    const v = deriveView(graph, fresh());
    expect(v.progress.current).toBe('milky-way');
    expect(states(fresh())).toEqual({
      'milky-way': 'current',
      andromeda: 'locked',
      triangulum: 'locked',
      lmc: 'available',
      smc: 'locked',
      whirlpool: 'locked',
      pinwheel: 'locked',
      sombrero: 'locked',
      'centaurus-a': 'locked',
      cartwheel: 'locked',
    });
    expect(v.completed).toEqual([]);
    expect(v.explorerLevel).toBe(1);
    expect(v.driveTier).toBe(1);
    expect(checkTravel(v, 'lmc')).toMatchObject({ ok: true });
    expect(checkTravel(v, 'smc')).toMatchObject({ ok: false, reason: 'locked' });
    expect(checkTravel(v, 'milky-way')).toMatchObject({ ok: false, reason: 'here' });
    expect(checkTravel(v, 'cartwheel')).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('first session: one survey run unlocks the SMC (no grinding, no random drops)', () => {
    const r = applySurvey(graph, fresh());
    expect(r.chartedSystem?.id).toBe('milky-way/sol');
    expect(r.newMilestones.map((m) => m.id)).toEqual(['first-survey']);
    expect(r.newGalaxies).toEqual(['smc']);
    expect(states(r.progress)['smc']).toBe('available');
    expect(deriveView(graph, r.progress).exploration('milky-way')).toEqual({ charted: 1, total: 20, percent: 5 });
  });

  it('opens the Lantern Gate route at 15% Milky Way exploration, and Andromeda needs Magellanic data too', () => {
    let p = surveyN(fresh(), 2);
    let v = deriveView(graph, p);
    const gate = graph.edgeBetween('milky-way', 'andromeda')!;
    expect(edgeState(v, gate)).toBe('locked');
    expect(v.routeOpen(gate)).toBe(false);
    const third = applySurvey(graph, toSuggestion(p));
    expect(third.newMilestones.map((m) => m.id)).toEqual(['lantern-gate']);
    expect(third.newRoutes).toEqual(['andromeda~milky-way']);
    v = deriveView(graph, third.progress);
    expect(v.driveTier).toBe(2);
    expect(v.charted.has('milky-way/lantern-gate')).toBe(true); // navigation-data reward
    expect(v.exploration('milky-way').charted).toBe(4);
    expect(nodeState(v, 'andromeda')).toBe('locked');
    expect(checkTravel(v, 'andromeda')).toMatchObject({ ok: false, reason: 'locked' });
    p = travel(third.progress, 'lmc');
    p = surveyN(p, 1);
    p = travel(p, 'smc');
    const smcRun = applySurvey(graph, toSuggestion(p));
    expect(smcRun.newMilestones.map((m) => m.id)).toEqual(['andromeda-charts']);
    expect(smcRun.newGalaxies).toEqual(['andromeda']);
    v = deriveView(graph, smcRun.progress);
    expect(nodeState(v, 'andromeda')).toBe('discovered'); // unlocked, but no direct route from the SMC
    expect(checkTravel(v, 'andromeda')).toMatchObject({ ok: false, reason: 'no-route' });
    expect(findPath(v, 'andromeda')).toEqual(['smc', 'milky-way', 'andromeda']);
  });

  it('reports a sealed route separately from a locked destination', () => {
    // Andromeda unlocked (Magellanic data) but the Lantern Gate still offline
    let p = surveyN(fresh(), 1);
    p = surveyN(travel(p, 'lmc'), 1);
    p = surveyN(travel(p, 'smc'), 1);
    p = travel(p, 'milky-way');
    const v = deriveView(graph, p);
    expect(v.galaxyUnlocked('andromeda')).toBe(true);
    expect(checkTravel(v, 'andromeda')).toMatchObject({ ok: false, reason: 'sealed' });
    expect(nodeState(v, 'andromeda')).toBe('discovered');
    expect(edgeState(v, graph.edgeBetween('milky-way', 'andromeda')!)).toBe('sealed');
  });

  it('never travels along a missing route or to an unknown galaxy', () => {
    const p = fresh();
    expect(applyTravel(graph, p, 'cartwheel')).toMatchObject({ ok: false });
    expect(applyTravel(graph, p, 'atlantis' as GalaxyId)).toMatchObject({ ok: false, reason: 'locked' });
    expect(applyTravel(graph, p, 'milky-way')).toMatchObject({ ok: false, reason: 'here' });
  });

  it('is deterministic and monotonic: the same progress gives the same unlocks, more progress never re-locks', () => {
    let p = fresh();
    let unlocked = 1;
    for (let i = 0; i < 12; i++) {
      p = applySurvey(graph, p).progress;
      const a = deriveView(graph, p);
      const b = deriveView(graph, JSON.parse(JSON.stringify(p)) as ExplorationProgress);
      expect(a.completed.map((m) => m.id)).toEqual(b.completed.map((m) => m.id));
      const n = graph.nodes.filter((x) => a.galaxyUnlocked(x.id)).length;
      expect(n).toBeGreaterThanOrEqual(unlocked);
      unlocked = n;
    }
  });

  it('a simulated pilot unlocks all 10 galaxies and every milestone within a bounded number of survey runs', () => {
    let p = fresh();
    let runs = 0;
    const firstUnlockRun = new Map<GalaxyId, number>([['milky-way', 0], ['lmc', 0]]);
    for (let guard = 0; guard < 400 && runs < 200; guard++) {
      const v = deriveView(graph, p);
      if (graph.nodes.every((n) => v.galaxyUnlocked(n.id)) && v.completed.length === graph.milestones.length) break;
      // 1) go and see any newly unlocked, reachable galaxy
      const fresh = graph.nodes.find((n) => v.galaxyUnlocked(n.id) && !p.visited.includes(n.id) && findPath(v, n.id));
      // galaxies with something left to chart: the system map's suggestion from the gateway (or from here)
      const workIn = (id: GalaxyId): boolean => deriveSystemView(deriveView(graph, id === p.current ? p : { ...p, current: id, system: graph.node(id)!.galaxy.gameplay.gatewaySystemId }), id).suggestion() !== null;
      const target = fresh?.id ?? graph.nodes.filter((n) => p.visited.includes(n.id) && workIn(n.id) && findPath(v, n.id)).sort((a, b) => v.exploration(a.id).percent - v.exploration(b.id).percent)[0]?.id;
      if (!target) break;
      for (const hop of findPath(v, target)!.slice(1)) p = travel(p, hop);
      const r = applySurvey(graph, toSuggestion(p));
      runs++;
      for (const g of r.newGalaxies) if (!firstUnlockRun.has(g)) firstUnlockRun.set(g, runs);
      p = r.progress;
    }
    const v = deriveView(graph, p);
    expect(graph.nodes.filter((n) => !v.galaxyUnlocked(n.id)).map((n) => n.id)).toEqual([]);
    expect(v.completed.length).toBe(graph.milestones.length);
    expect(graph.edges.filter((e) => !v.routeOpen(e)).map((e) => e.id)).toEqual([]);
    expect(runs).toBeLessThanOrEqual(45);
    // every run charts a new system: valid under the Prompt 6 rule that each sector credits its survey once
    expect(new Set(p.charted).size).toBe(runs);
    expect(firstUnlockRun.get('smc')!).toBeLessThanOrEqual(2); // this pilot visits the LMC first; one Milky Way run is enough (tested above)
    console.info(`[galaxy-map] simulated pilot: ${runs} survey runs; first unlock run per galaxy ${JSON.stringify(Object.fromEntries(firstUnlockRun))}`);
    expect(firstUnlockRun.get('andromeda')!).toBeLessThanOrEqual(6);
  });

  it('explains every locked destination with the milestone, task and progress', () => {
    const v = deriveView(graph, fresh());
    for (const n of graph.nodes) {
      for (const req of n.galaxy.gameplay.unlock) {
        const info = describeRequirement(v, req);
        expect(info.title.length, n.id).toBeGreaterThan(2);
        expect(info.detail.length, n.id).toBeGreaterThan(10);
        expect(info.met).toBe(false);
      }
    }
    const smc = describeRequirement(v, graph.node('smc')!.galaxy.gameplay.unlock[0]!);
    expect(smc).toMatchObject({ title: 'First Survey', progress: '0 / 1', met: false });
    const and = describeRequirement(v, graph.node('andromeda')!.galaxy.gameplay.unlock[0]!);
    expect(and.parts.map((x) => x.text)).toEqual(['Complete 1 survey run in the Large Magellanic Cloud', 'Complete 1 survey run in the Small Magellanic Cloud']);
    const som = describeRequirement(v, graph.node('sombrero')!.galaxy.gameplay.unlock[0]!);
    expect(som.progress).toBe('0 / 1');
    expect(som.parts.map((x) => x.text)).toEqual(['Explore 20% of the Whirlpool Galaxy', 'Explore 20% of Centaurus A']);
    expect(theName('Centaurus A')).toBe('Centaurus A');
    expect(theName('Milky Way')).toBe('the Milky Way');
  });

  it('sanitises saved progress: unknown ids are dropped and the start galaxy is the fallback', () => {
    const p = progressFromSaved(graph, { currentGalaxy: 'atlantis', visitedGalaxies: ['lmc', 'atlantis', 'lmc'], chartedSystems: ['milky-way/sol', 'nowhere/x', 'milky-way/sol'], galaxySurveys: { 'milky-way': 1, atlantis: 5, lmc: -2, smc: 1.5 } });
    expect(p).toEqual({ current: 'milky-way', visited: ['milky-way', 'lmc'], charted: ['milky-way/sol'], surveys: { 'milky-way': 1 }, system: 'milky-way/sol', visitedSystems: ['milky-way/sol'] });
  });
});

describe('galaxy map layout and keyboard movement', () => {
  const ids = graph.nodes.map((n) => n.id);
  it('places every catalogue galaxy in exactly one distinct cell in both lattices', () => {
    for (const o of ['wide', 'tall'] as Orientation[]) {
      const cells = MAP_CELLS[o];
      expect(Object.keys(cells).sort()).toEqual([...ids].sort());
      const keys = Object.values(cells).map((c) => `${c.col},${c.row}`);
      expect(new Set(keys).size).toBe(10);
      for (const c of Object.values(cells)) {
        expect(c.col).toBeGreaterThanOrEqual(0);
        expect(c.col).toBeLessThan(MAP_GRID[o].cols);
        expect(c.row).toBeLessThan(MAP_GRID[o].rows);
      }
    }
  });

  it('keeps routes from crossing in both lattices', () => {
    for (const o of ['wide', 'tall'] as Orientation[]) {
      const L = computeMapLayout(o === 'wide' ? 1000 : 400, o === 'wide' ? 560 : 700);
      expect(L.orientation).toBe(o);
      const seg = graph.edges.map((e) => [L.nodes[e.from], L.nodes[e.to], e] as const);
      const cross = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): boolean => {
        const o1 = Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
        const o2 = Math.sign((b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x));
        const o3 = Math.sign((d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x));
        const o4 = Math.sign((d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x));
        return o1 * o2 < 0 && o3 * o4 < 0;
      };
      for (let i = 0; i < seg.length; i++)
        for (let j = i + 1; j < seg.length; j++) {
          const [a, b, e1] = seg[i]!;
          const [c, d, e2] = seg[j]!;
          expect(cross(a, b, c, d), `${o}: ${e1.id} x ${e2.id}`).toBe(false);
        }
    }
  });

  const SIZES: [number, number][] = [
    [328, 280], [320, 262], [360, 330], [390, 430], [430, 560], [544, 346], [700, 300], [900, 672], [1180, 760], [1600, 1000], [300, 520],
  ];
  it('fits every destination inside the map box with 44px targets that never overlap', () => {
    for (const [w, h] of SIZES) {
      const L = computeMapLayout(w, h);
      const boxes = ids.map((id) => [id, nodeBox(L, id)] as const);
      for (const [id, b] of boxes) {
        const tag = `${w}x${h} ${L.orientation} ${id}`;
        expect(b.width, tag).toBeGreaterThanOrEqual(44);
        expect(b.height, tag).toBeGreaterThanOrEqual(44);
        expect(b.left, tag).toBeGreaterThanOrEqual(0);
        expect(b.top, tag).toBeGreaterThanOrEqual(0);
        expect(b.left + b.width, tag).toBeLessThanOrEqual(w + 0.01);
        expect(b.top + b.height, tag).toBeLessThanOrEqual(h + 0.01);
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const [ia, a] = boxes[i]!;
          const [ib, b] = boxes[j]!;
          const overlap = a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
          expect(overlap, `${w}x${h} ${L.orientation}: ${ia} overlaps ${ib}`).toBe(false);
        }
    }
  });

  it('picks the lattice that suits the box (wide for landscape, tall for portrait)', () => {
    expect(computeMapLayout(1200, 600).orientation).toBe('wide');
    expect(computeMapLayout(360, 640).orientation).toBe('tall');
    expect(computeMapLayout(544, 346).orientation).toBe('wide');
    expect(computeMapLayout(328, 280).orientation).toBe('tall');
  });

  it('reaches every destination from every destination with arrow keys alone', () => {
    for (const [w, h] of SIZES) {
      const L = computeMapLayout(w, h);
      for (const from of ids) {
        const seen = new Set<string>([from]);
        const q = [from as string];
        while (q.length) {
          const cur = q.shift()!;
          for (const d of ['up', 'down', 'left', 'right'] as Direction[]) {
            const n = spatialNext(L.nodes, cur, d);
            if (n && !seen.has(n)) (seen.add(n), q.push(n));
          }
        }
        expect(seen.size, `${w}x${h} ${L.orientation} from ${from}`).toBe(10);
      }
    }
  });

  it('moves in the pressed direction and stays put at the edge', () => {
    const L = computeMapLayout(1000, 560);
    expect(spatialNext(L.nodes, 'milky-way', 'down')).toBe('lmc');
    expect(spatialNext(L.nodes, 'lmc', 'up')).toBe('milky-way');
    expect(spatialNext(L.nodes, 'lmc', 'right')).toBe('smc');
    expect(spatialNext(L.nodes, 'milky-way', 'left')).toBeNull();
    expect(spatialNext(L.nodes, 'nope', 'left')).toBeNull();
    for (const id of ids)
      for (const d of ['up', 'down', 'left', 'right'] as Direction[]) {
        const n = spatialNext(L.nodes, id, d);
        if (!n) continue;
        const a = L.nodes[id];
        const b = L.nodes[n as GalaxyId];
        if (d === 'up') expect(b.y).toBeLessThan(a.y);
        if (d === 'down') expect(b.y).toBeGreaterThan(a.y);
        if (d === 'left') expect(b.x).toBeLessThan(a.x);
        if (d === 'right') expect(b.x).toBeGreaterThan(a.x);
      }
  });
});

describe('galaxy map art and input (Prompt 4)', () => {
  const lit = (px: Uint8ClampedArray): number => {
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]! > 24) n++;
    return n;
  };

  it('generates deterministic, non-empty, distinct portraits for every catalogue galaxy', () => {
    const seen = new Set<string>();
    for (const g of cat.galaxies) {
      const a = galaxyPixels(g, 32);
      const b = galaxyPixels(g, 32);
      expect(a.length).toBe(32 * 32 * 4);
      expect(Array.from(a)).toEqual(Array.from(b));
      const filled = lit(a) / (32 * 32);
      expect(filled, g.id).toBeGreaterThan(0.03);
      expect(filled, g.id).toBeLessThan(0.85);
      seen.add(Array.from(a).join(','));
    }
    expect(seen.size).toBe(cat.galaxies.length);
  });

  it('renders the locked (mono) variant as pure grey', () => {
    for (const g of cat.galaxies) {
      const m = galaxyPixels(g, 24, 'mono');
      expect(lit(m), g.id).toBeGreaterThan(0);
      for (let i = 0; i < m.length; i += 4) {
        expect(m[i]).toBe(m[i + 1]);
        expect(m[i + 1]).toBe(m[i + 2]);
      }
    }
  });

  it('maps keyboard and pad to map commands (no auto travel key)', () => {
    expect(mapKeyCommands(['ArrowUp', 'KeyS', 'ArrowLeft', 'KeyD', 'Enter', 'Space', 'Escape', 'KeyP', 'KeyR'])).toEqual(['up', 'down', 'left', 'right', 'confirm', 'confirm', 'back']);
    expect(mapPadCommands({ moveX: 0, presses: ['up', 'right', 'a', 'b', 'start', 'x'], active: true } as never)).toEqual(['up', 'right', 'confirm', 'back']);
  });
});
