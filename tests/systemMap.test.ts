import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import type { GalaxyId, SystemRecord } from '../src/modes/freeroam/catalogue/types.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { applySurvey, applyTravel, deriveView, initialProgress, type ExplorationProgress } from '../src/modes/freeroam/galaxy/progress.ts';
import { computeSystemLayout, laneCurve, segmentDistance2, segmentsCross, SYSTEM_GRID_SIZES, systemGrid } from '../src/modes/freeroam/galaxy/systemLayout.ts';
import { systemTravelMs } from '../src/modes/freeroam/galaxy/systemMapScreen.ts';
import { curvePoint } from '../src/modes/freeroam/galaxy/systemMapRender.ts';
import { applySystemTravel, buildSystemGraph, deriveSystemView, LANE_COST, laneCost, laneId, systemGraph, validateSystemGraphs, type SystemView } from '../src/modes/freeroam/galaxy/systems.ts';

const graph = buildNavGraph();
const cat = getCatalogue();
const fresh = (): ExplorationProgress => initialProgress(graph);
const gatewayOf = (g: GalaxyId): string => graph.node(g)!.galaxy.gameplay.gatewaySystemId;
/** A pilot standing at a galaxy's gateway (Free Roam lets them get there; unlock checks are separate). */
const at = (g: GalaxyId, extra: Partial<ExplorationProgress> = {}): ExplorationProgress => ({
  ...fresh(),
  current: g,
  visited: ['milky-way', g],
  system: gatewayOf(g),
  visitedSystems: [gatewayOf(g)],
  ...extra,
});
const sview = (p: ExplorationProgress, g: GalaxyId = p.current): SystemView => deriveSystemView(deriveView(graph, p), g);

/** Independent Dijkstra (reference for the planner): cheapest cost over allowed nodes. */
function referenceCost(sv: SystemView, from: string, to: string): number | null {
  const dist = new Map<string, number>([[from, 0]]);
  const done = new Set<string>();
  for (;;) {
    const open = [...dist].filter(([id]) => !done.has(id)).sort((a, b) => a[1] - b[1]);
    if (!open.length) break;
    const [x, d] = open[0]!;
    done.add(x);
    for (const l of sv.graph.lanesOf(x)) {
      const y = sv.graph.other(l, x);
      if (sv.knowledge(y) === 'hidden' || !sv.unlocked(y)) continue;
      if (!dist.has(y) || d + l.cost < dist.get(y)!) dist.set(y, d + l.cost);
    }
  }
  return dist.get(to) ?? null;
}

describe('system graph: validated lanes from the catalogue', () => {
  it('passes every structural check for all 10 galaxies', () => {
    expect(validateSystemGraphs(graph)).toEqual([]);
  });

  it('builds lanes only from system connections: valid ids, one canonical lane per pair, never all-to-all', () => {
    let total = 0;
    for (const n of graph.nodes) {
      const sg = systemGraph(graph, n.id);
      const systems = cat.systems.filter((s) => s.galaxyId === n.id);
      expect(sg.systems).toEqual(systems);
      const pairs = new Set<string>();
      for (const s of systems) for (const c of s.connections) pairs.add(laneId(s.id, c));
      expect(sg.lanes.map((l) => l.id).sort()).toEqual([...pairs].sort());
      expect(new Set(sg.lanes.map((l) => l.id)).size).toBe(sg.lanes.length);
      for (const l of sg.lanes) {
        expect(l.a < l.b).toBe(true);
        expect(l.id).toBe(`${l.a}~${l.b}`);
        expect(sg.system(l.a)?.galaxyId, l.id).toBe(n.id);
        expect(sg.system(l.b)?.galaxyId, l.id).toBe(n.id);
      }
      const k = systems.length;
      expect(sg.lanes.length).toBeLessThan((k * (k - 1)) / 4); // sparse: local exploration, not a mesh
      for (const s of systems) expect(sg.lanesOf(s.id).length, s.id).toBeGreaterThanOrEqual(1);
      expect(sg.issues).toEqual([]);
      total += sg.lanes.length;
    }
    expect(total).toBe(180);
  });

  it('handles bad and duplicate connections consistently: duplicates collapse, missing / foreign / self lanes are dropped and reported', () => {
    const mw = cat.systems.filter((s) => s.galaxyId === 'milky-way');
    const sol = mw.find((s) => s.id === 'milky-way/sol')!;
    const target = sol.connections[0]!;
    const broken: SystemRecord[] = mw.map((s) => (s === sol ? { ...s, connections: [...s.connections, target, 'milky-way/nowhere', 'lmc/southwind-landing', s.id] } : s));
    const sg = buildSystemGraph('milky-way', 'milky-way/sol', [...broken, ...cat.systems.filter((s) => s.galaxyId !== 'milky-way')]);
    const codes = sg.issues.map((i) => i.code).sort();
    expect(codes).toEqual(['cross-galaxy', 'duplicate-lane', 'missing-system', 'self-lane']);
    expect(sg.lanes.length).toBe(systemGraph(graph, 'milky-way').lanes.length); // nothing new drawn, nothing lost
    expect(sg.lanes.filter((l) => l.id === laneId(sol.id, target))).toHaveLength(1);
    for (const l of sg.lanes) expect(sg.system(l.a) && sg.system(l.b)).toBeTruthy();
    // a one-sided listing still yields one lane, flagged as asymmetric
    const oneSided = mw.map((s) => (s.id === target ? { ...s, connections: s.connections.filter((c) => c !== sol.id) } : s));
    const sg2 = buildSystemGraph('milky-way', 'milky-way/sol', oneSided);
    expect(sg2.issues.map((i) => i.code)).toEqual(['asymmetric-lane']);
    expect(sg2.laneBetween(sol.id, target)).toBeDefined();
  });

  it('gives every lane an integer drive-charge estimate in 1..5, also for out-of-range input', () => {
    const costs = new Set<number>();
    for (const n of graph.nodes) {
      for (const l of systemGraph(graph, n.id).lanes) {
        expect(Number.isInteger(l.cost), l.id).toBe(true);
        expect(l.cost).toBeGreaterThanOrEqual(LANE_COST.min);
        expect(l.cost).toBeLessThanOrEqual(LANE_COST.max);
        costs.add(l.cost);
      }
    }
    expect([...costs].sort()).toEqual([1, 2, 3, 4]); // lanes differ, so routes are real choices
    const sol = cat.systems[0]!;
    const weird = { ...sol, difficulty: Number.NaN, sector: { ...sol.sector, hazard: 'flare' as const, hazardStrength: 99 }, encounters: { ...sol.encounters, threat: 9, pattern: 'gauntlet' as const } };
    const neg = { ...sol, sector: { ...sol.sector, hazard: 'dust' as const, hazardStrength: -4 } };
    for (const [a, b] of [[weird, weird], [neg, neg], [weird, neg]] as const) {
      const c = laneCost(a, b);
      expect(Number.isInteger(c) && c >= 1 && c <= 5).toBe(true);
    }
  });

  it('derives lane hazards and transit events from the end systems', () => {
    for (const n of graph.nodes) {
      const sg = systemGraph(graph, n.id);
      for (const l of sg.lanes) {
        const ends = [sg.system(l.a)!, sg.system(l.b)!];
        if (l.hazard) {
          expect([l.a, l.b]).toContain(l.hazard.at);
          expect(sg.system(l.hazard.at)!.sector.hazard).toBe(l.hazard.id);
        } else expect(ends.every((s) => s.sector.hazard === 'none')).toBe(true);
        if (l.event) expect(sg.system(l.event.at)!.encounters.threat).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('reachability and locks', () => {
  it('every galaxy gateway is open and visible, and every system is connected to it', () => {
    for (const n of graph.nodes) {
      const sv = sview(at(n.id));
      const gate = gatewayOf(n.id);
      expect(sv.current).toBe(gate);
      expect(sv.knowledge(gate)).not.toBe('hidden');
      expect(sv.unlocked(gate)).toBe(true);
      expect(sv.state(gate)).toBe('current');
      expect(sv.graph.hops(gate).size, n.id).toBe(sv.graph.systems.length);
      expect(sv.suggestion(), n.id).not.toBeNull(); // a new arrival always has something to survey
    }
  });

  it('a new pilot in the Milky Way sees Sol, its neighbours and the public charts; hidden systems stay hidden', () => {
    const sv = sview(fresh());
    expect(sv.current).toBe('milky-way/sol');
    expect(sv.state('milky-way/sol')).toBe('current');
    for (const l of sv.graph.lanesOf('milky-way/sol')) expect(sv.knowledge(sv.graph.other(l, 'milky-way/sol'))).not.toBe('hidden');
    for (const s of sv.graph.systems) if (s.discovery === 'hidden') expect(sv.knowledge(s.id), s.id).toBe('hidden');
    for (const l of sv.graph.lanes) if (sv.knowledge(l.a) === 'hidden' || sv.knowledge(l.b) === 'hidden') expect(sv.laneVisible(l)).toBe(false);
    expect(sv.visible.length).toBeGreaterThanOrEqual(10);
    expect(sv.visible.length).toBeLessThan(sv.graph.systems.length);
  });

  it('locked systems appear as sealed signals once a neighbour is charted, and cannot be entered', () => {
    let lockedSeen = 0;
    for (const n of graph.nodes) {
      const sg = systemGraph(graph, n.id);
      const open = sg.systems.filter((s) => s.unlock.length === 0 && s.discovery !== 'hidden').map((s) => s.id);
      const locked = sg.systems.filter((s) => s.unlock.length > 0);
      // before: never charted around it -> off the map entirely
      for (const s of locked) expect(sview(at(n.id, { visitedSystems: open })).knowledge(s.id), s.id).toBe('hidden');
      // chart one neighbour of each locked system (the first one by id)
      const charted = locked.map((s) => [...s.connections].sort()[0]!);
      const p = at(n.id, { visitedSystems: open, charted });
      const sv = sview(p);
      for (const s of sg.systems) {
        if (sv.unlocked(s.id)) continue;
        expect(sv.knowledge(s.id), s.id).toBe('signal'); // identity stays concealed
        expect(sv.intel(s.id).name).toBe('Unknown signal');
        lockedSeen++;
        expect(sv.state(s.id)).toBe('locked');
        const plan = sv.plan(s.id);
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.reason).toBe('locked');
        const r = applySystemTravel(graph, p, s.id);
        expect(r.ok, s.id).toBe(false);
      }
      for (const id of sv.visible) {
        const plan = sv.plan(id);
        if (plan.ok) for (const step of plan.path) expect(sv.unlocked(step), `${id} via ${step}`).toBe(true);
      }
    }
    expect(lockedSeen).toBeGreaterThanOrEqual(8);
  });

  it('hidden systems cannot be planned to or entered', () => {
    const p = fresh();
    const sv = sview(p);
    const hidden = sv.graph.systems.filter((s) => sv.knowledge(s.id) === 'hidden');
    expect(hidden.length).toBeGreaterThan(0);
    for (const s of hidden) {
      expect(sv.plan(s.id)).toMatchObject({ ok: false, reason: 'hidden' });
      expect(applySystemTravel(graph, p, s.id).ok).toBe(false);
    }
    expect(applySystemTravel(graph, p, 'milky-way/nowhere').ok).toBe(false);
    expect(applySystemTravel(graph, p, 'lmc/southwind-landing')).toMatchObject({ ok: false, reason: 'hidden' }); // another galaxy's system
  });

  it('a system becomes enterable once its unlock is met (Sagittarius A*: two key systems + drive tier 2)', () => {
    const id = 'milky-way/sagittarius-a-star';
    const s = graph.system(id)!;
    expect(s.unlock.length).toBeGreaterThan(0);
    const keys = s.unlock.flatMap((r) => (r.kind === 'system' ? [r.systemId] : []));
    let p = at('milky-way', { charted: keys, visitedSystems: systemGraph(graph, 'milky-way').systems.filter((x) => x.unlock.length === 0).map((x) => x.id) });
    p = { ...p, charted: [...p.charted, 'milky-way/sol', 'milky-way/alpha-centauri'] }; // 15% -> lantern-gate -> drive 2
    const sv = sview(p);
    expect(sv.unlocked(id)).toBe(true);
    expect(sv.knowledge(id)).not.toBe('hidden');
  });
});

describe('route planning', () => {
  it('plans the cheapest route through open, known systems; costs add up and match an independent search', () => {
    let checked = 0;
    for (const n of graph.nodes) {
      const sg = systemGraph(graph, n.id);
      const open = sg.systems.filter((s) => s.unlock.length === 0).map((s) => s.id);
      const sv = sview(at(n.id, { visitedSystems: open }));
      for (const id of sv.visible) {
        const plan = sv.plan(id);
        if (!plan.ok) continue;
        expect(plan.path[0]).toBe(sv.current);
        expect(plan.path[plan.path.length - 1]).toBe(id);
        expect(new Set(plan.path).size).toBe(plan.path.length);
        expect(plan.jumps).toBe(plan.path.length - 1);
        let sum = 0;
        for (let i = 1; i < plan.path.length; i++) {
          const l = sg.laneBetween(plan.path[i - 1]!, plan.path[i]!);
          expect(l, `${plan.path[i - 1]} -> ${plan.path[i]}`).toBeDefined();
          expect(plan.lanes[i - 1]).toBe(l);
          sum += l!.cost;
        }
        expect(plan.cost).toBe(sum);
        expect(plan.cost).toBe(referenceCost(sv, sv.current!, id));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('explains blocked routes and offers up to three reachable alternatives', () => {
    let noRoute = 0;
    for (const n of graph.nodes) {
      const sv = sview(at(n.id));
      for (const id of sv.visible) {
        const plan = sv.plan(id);
        if (plan.ok) continue;
        if (plan.reason === 'here') {
          expect(id).toBe(sv.current);
          continue;
        }
        expect(['locked', 'no-route']).toContain(plan.reason);
        expect(plan.alternatives.length).toBeLessThanOrEqual(3);
        for (const alt of plan.alternatives) {
          expect(alt).not.toBe(sv.current);
          expect(sv.plan(alt).ok, alt).toBe(true);
        }
        if (plan.reason === 'no-route') {
          noRoute++;
          if (plan.blocker) expect(sv.unlocked(plan.blocker)).toBe(false);
        }
      }
    }
    expect(noRoute).toBeGreaterThan(0);
  });

  it('views another galaxy read-only: nothing can be planned there from here', () => {
    const sv = sview(fresh(), 'lmc');
    expect(sv.here).toBe(false);
    expect(sv.current).toBeNull();
    for (const id of sv.visible) {
      expect(['remote', 'locked']).toContain(sv.state(id));
      expect(sv.plan(id)).toMatchObject({ ok: false });
    }
  });

  it('travel visits every system on the route; the pilot can always fly back to the gateway (never stranded)', () => {
    for (const n of graph.nodes) {
      const start = at(n.id);
      const sv = sview(start);
      for (const id of sv.visible) {
        const plan = sv.plan(id);
        if (!plan.ok) continue;
        const r = applySystemTravel(graph, start, id);
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        expect(r.progress.system).toBe(id);
        for (const step of plan.path) expect(r.progress.visitedSystems).toContain(step);
        expect(r.progress.current).toBe(n.id);
        const back = sview(r.progress).plan(gatewayOf(n.id));
        expect(back.ok, `${id} -> gateway`).toBe(true);
        if (back.ok) expect(back.cost).toBe(plan.cost); // lanes are symmetric
      }
    }
  });

  it('a jump to another galaxy arrives at its gateway; surveys chart the system the pilot is at', () => {
    let p = fresh();
    const r1 = applySurvey(graph, p);
    expect(r1.chartedSystem?.id).toBe('milky-way/sol');
    p = r1.progress;
    const again = applySurvey(graph, p);
    expect(again.chartedSystem).toBeNull(); // already charted: the run only counts
    expect(again.progress.surveys['milky-way']).toBe(2);
    const sv = sview(p);
    const next = sv.suggestion()!;
    expect(next).not.toBe('milky-way/sol');
    const moved = applySystemTravel(graph, p, next);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(applySurvey(graph, moved.progress).chartedSystem?.id).toBe(next);
    const jump = applyTravel(graph, moved.progress, 'lmc');
    expect(jump.ok).toBe(true);
    if (jump.ok) {
      expect(jump.progress.system).toBe(gatewayOf('lmc'));
      expect(jump.progress.visitedSystems).toContain(gatewayOf('lmc'));
    }
  });

  it('planning, inspecting and markers never change progress (selecting a node cannot launch travel)', () => {
    const p = fresh();
    const snapshot = JSON.stringify(p);
    const sv = sview(p);
    for (const id of sv.graph.systems.map((s) => s.id)) {
      sv.plan(id);
      sv.intel(id);
      sv.markers(id);
      sv.state(id);
    }
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it('keeps travel animations short', () => {
    expect(systemTravelMs(1, false)).toBe(260);
    expect(systemTravelMs(9, false)).toBe(1200);
    expect(systemTravelMs(4, true)).toBe(200);
  });
});

describe('information discovery', () => {
  it('signals show an incomplete record only; known systems show identity and a hint; surveys reveal the rest', () => {
    const p = fresh();
    const sv = sview(p);
    const signal = sv.visible.find((id) => sv.knowledge(id) === 'signal')!;
    const known = sv.visible.find((id) => sv.knowledge(id) === 'known' && id !== sv.current)!;
    expect(signal && known).toBeTruthy();
    const si = sv.intel(signal);
    expect(si).toMatchObject({ name: 'Unknown signal', category: null, difficulty: null, fact: null, resourceHint: null, resources: null, hostiles: null, pois: null, anomaly: null });
    expect(sv.markers(signal).every((m) => m.kind === 'objective')).toBe(true);
    const rec = graph.system(known)!;
    const ki = sv.intel(known);
    expect(ki).toMatchObject({ name: rec.name, category: rec.category, provenance: rec.provenance.status, difficulty: rec.difficulty, description: rec.description, fact: rec.fact, resourceHint: rec.resources.primary });
    expect(ki.resources).toBeNull();
    expect(ki.hostiles).toBeNull();
    expect(ki.pois).toBeNull();
    // chart it: everything comes from the catalogue record
    const charted = sview({ ...p, charted: [known] });
    const full = charted.intel(known);
    expect(charted.knowledge(known)).toBe('surveyed');
    expect(full.resources).toEqual(rec.resources);
    expect(full.hazard).toEqual({ id: rec.sector.hazard, strength: rec.sector.hazardStrength });
    expect(full.hostiles!.factions.every((f) => rec.encounters.factions.includes(f))).toBe(true);
    expect(full.pois!.length).toBeGreaterThanOrEqual(1);
  });

  it('charting a system identifies its neighbours (signals become known)', () => {
    const p = fresh();
    const sv = sview(p);
    const signal = sv.visible.find((id) => sv.knowledge(id) === 'signal' && sv.graph.lanesOf(id).some((l) => sv.knowledge(sv.graph.other(l, id)) !== 'hidden'))!;
    const nb = sv.graph.lanesOf(signal).map((l) => sv.graph.other(l, signal)).find((id) => sv.knowledge(id) !== 'hidden')!;
    expect(sview({ ...p, charted: [nb] }).knowledge(signal)).toBe('known');
  });

  it('marks the gateway, one survey objective and key systems; hostiles and stations only after a survey', () => {
    for (const n of graph.nodes) {
      const p = at(n.id);
      const sv = sview(p);
      const objectives = sv.visible.filter((id) => sv.markers(id).some((m) => m.kind === 'objective'));
      expect(objectives).toEqual([sv.suggestion()]);
      expect(sv.markers(gatewayOf(n.id)).map((m) => m.kind)).toContain('gateway');
      for (const id of sv.visible) {
        const kinds = sv.markers(id).map((m) => m.kind);
        if (sv.knowledge(id) !== 'surveyed') expect(kinds.filter((k) => k === 'hostile' || k === 'station' || k === 'anomaly'), id).toEqual([]);
      }
      const all = sview({ ...p, charted: sv.graph.systems.map((s) => s.id) });
      for (const s of sv.graph.systems) {
        const kinds = all.markers(s.id).map((m) => m.kind);
        expect(kinds.includes('station'), s.id).toBe(s.sector.station);
      }
    }
  });

  it('labels real objects and keeps fictional systems fictional', () => {
    const p = { ...fresh(), charted: cat.systems.map((s) => s.id) };
    for (const n of graph.nodes) {
      const sv = sview(p, n.id);
      for (const s of sv.graph.systems) {
        const i = sv.intel(s.id);
        expect(i.provenance).toBe(s.provenance.status);
        if (s.provenance.status !== 'verified-object') expect(i.fact).toBeNull();
        if (s.provenance.status === 'speculative') expect(i.anomaly).toBeTruthy();
      }
    }
  });
});

describe('deterministic system map layout', () => {
  it('places every system of every galaxy in its own lattice cell, identically on every build', () => {
    for (const n of graph.nodes) {
      const sg = systemGraph(graph, n.id);
      const grid = systemGrid(sg);
      const size = sg.systems.length <= SYSTEM_GRID_SIZES.small.maxSystems ? SYSTEM_GRID_SIZES.small : SYSTEM_GRID_SIZES.large;
      expect([grid.cols, grid.rows]).toEqual([size.cols, size.rows]);
      expect(Object.keys(grid.cells).sort()).toEqual(sg.systems.map((s) => s.id).sort());
      const keys = Object.values(grid.cells).map((c) => `${c.col},${c.row}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const c of Object.values(grid.cells)) {
        expect(c.col >= 0 && c.col < grid.cols && c.row >= 0 && c.row < grid.rows).toBe(true);
      }
      // rebuilding from scratch (new graph object, no cache) gives the same cells
      const again = systemGrid(buildSystemGraph(n.id, gatewayOf(n.id), cat.systems));
      expect(again.cells).toEqual(grid.cells);
      expect(grid.crossings, n.id).toBe(0);
      expect(grid.nearMisses, n.id).toBeLessThanOrEqual(2);
    }
  });

  it('matches the golden Milky Way lattice (guards against engine or algorithm drift)', () => {
    const cells = systemGrid(systemGraph(graph, 'milky-way')).cells;
    const pick = (id: string): string => `${cells[`milky-way/${id}`]!.col},${cells[`milky-way/${id}`]!.row}`;
    expect({ sol: pick('sol'), sirius: pick('sirius'), crab: pick('crab-nebula'), sgr: pick('sagittarius-a-star') }).toEqual({ sol: '2,2', sirius: '3,1', crab: '6,1', sgr: '6,3' });
  });

  it('keeps touch targets at least 44 CSS px on phone-sized map boxes, in both orientations', () => {
    // map boxes measured from the CSS grid: portrait bottom-sheet, landscape side panel, small landscape
    const boxes: [number, number, string][] = [
      [390, 430, 'tall'],
      [360, 380, 'tall'],
      [474, 312, 'wide'],
      [328, 272, 'wide'],
      [900, 600, 'wide'],
    ];
    for (const n of graph.nodes) {
      const grid = systemGrid(systemGraph(graph, n.id));
      for (const [w, h, o] of boxes) {
        const L = computeSystemLayout(grid, w, h);
        expect(L.orientation, `${n.id} ${w}x${h}`).toBe(o);
        for (const [id, b] of Object.entries(L.boxes)) {
          expect(Math.min(b.w, b.h), `${n.id} ${id} ${w}x${h}`).toBeGreaterThanOrEqual(44);
          expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h).toBe(true);
          const p = L.nodes[id]!;
          expect(p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h).toBe(true);
        }
      }
    }
  });

  it('uses the transposed lattice in portrait (rotation mirrors the map instead of reshuffling it)', () => {
    const grid = systemGrid(systemGraph(graph, 'andromeda'));
    const wide = computeSystemLayout(grid, 800, 400);
    const tall = computeSystemLayout(grid, 400, 800);
    expect([wide.orientation, tall.orientation]).toEqual(['wide', 'tall']);
    for (const [id, c] of Object.entries(grid.cells)) {
      expect(Math.round((wide.nodes[id]!.x - 2) / wide.cellW - 0.5)).toBe(c.col);
      expect(Math.round((tall.nodes[id]!.y - 2) / tall.cellH - 0.5)).toBeLessThanOrEqual(c.col + 1);
      expect(Math.round((tall.nodes[id]!.x - 2) / tall.cellW - 0.5)).toBe(c.row);
    }
  });

  it('bends a lane that would pass over another system, so lanes never seem to connect systems they do not', () => {
    let bent = 0;
    for (const n of graph.nodes) {
      const sg = systemGraph(graph, n.id);
      const L = computeSystemLayout(systemGrid(sg), 800, 420);
      const cell = Math.min(L.cellW, L.cellH);
      for (const l of sg.lanes) {
        const c = laneCurve(L, l.a, l.b);
        if (c.bent) bent++;
        for (const id of Object.keys(L.nodes)) {
          if (id === l.a || id === l.b) continue;
          for (let t = 0.1; t <= 0.9; t += 0.05) {
            const p = curvePoint(c, t);
            const d2 = (p.x - L.nodes[id]!.x) ** 2 + (p.y - L.nodes[id]!.y) ** 2;
            expect(Math.sqrt(d2), `${l.id} over ${id}`).toBeGreaterThan(0.2 * cell);
          }
        }
      }
    }
    expect(bent).toBeLessThanOrEqual(6);
  });

  it('geometry helpers: crossing and distance tests', () => {
    const P = (x: number, y: number) => ({ x, y });
    expect(segmentsCross(P(0, 0), P(2, 2), P(0, 2), P(2, 0))).toBe(true);
    expect(segmentsCross(P(0, 0), P(1, 0), P(1, 0), P(2, 1))).toBe(false); // shared endpoint
    expect(segmentsCross(P(0, 0), P(2, 0), P(1, 0), P(3, 0))).toBe(true); // collinear overlap
    expect(segmentDistance2(P(0, 0), P(2, 0), P(1, 1))).toBe(1);
  });
});
