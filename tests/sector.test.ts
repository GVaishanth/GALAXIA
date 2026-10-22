import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import type { SystemRecord } from '../src/modes/freeroam/catalogue/types.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { systemGraph } from '../src/modes/freeroam/galaxy/systems.ts';
import { addCargo, EMPTY_PROFILE, loadProfile, saveProfile, withSectorProgress } from '../src/modes/freeroam/profile.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector, rareChance, repairLayout, unreachableTargets } from '../src/modes/freeroam/sector/generate.ts';
import { buildGrid, canReach, cellOf, dist, reachable, solidsOf, type OccupancyGrid } from '../src/modes/freeroam/sector/grid.ts';
import { EMPTY_SECTOR_SAVE, globalPoiId, maxTierFor, POI_ID, RARE_RESOURCES, SECTOR_GEN, type Point, type Poi, type SectorLayout, type SectorSave } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, disposeSectorRun, interact, isDone, marksLeft, pauseSector, restartSector, resumeSector, stepSector, type SectorEvent, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { validateSector } from '../src/modes/freeroam/sector/validate.ts';
import { COMBAT, difficultyRow } from '../src/modes/freeroam/combat/difficulty.ts';
import { FAMILIES, FAMILY_IDS } from '../src/modes/freeroam/combat/families.ts';
import { ROCK_VERTICES, rockOutline } from '../src/modes/freeroam/sector/render.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const catalogue = getCatalogue();
const graph = buildNavGraph();
const SYSTEMS = catalogue.systems;
const sys = (id: string): SystemRecord => SYSTEMS.find((s) => s.id === id)!;
const gen = (id: string): SectorLayout => generateSector(sys(id), sectorContext(graph, id));
/** Generated once for the whole file (170 sectors, ~0.5 s). */
const ALL = new Map(SYSTEMS.map((s) => [s.id, generateSector(s, sectorContext(graph, s.id))]));
const SOL = 'milky-way/sol';

/* ------------------------------------------------------------ test pilot */

/** Grid path (4-neighbour BFS) from `a` to the free cell nearest `b`. */
function gridPath(g: OccupancyGrid, a: Point, b: Point): Point[] {
  const start = cellOf(g, a);
  const prev = new Int32Array(g.cols * g.rows).fill(-1);
  const seen = new Uint8Array(g.cols * g.rows);
  const q = [start];
  seen[start] = 1;
  let best = start;
  let bestD = Infinity;
  for (let h = 0; h < q.length; h++) {
    const i = q[h]!;
    const c = i % g.cols;
    const r = (i - c) / g.cols;
    const d = Math.hypot((c + 0.5) * g.cell - b.x, (r + 0.5) * g.cell - b.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
    for (const j of [c > 0 ? i - 1 : -1, c < g.cols - 1 ? i + 1 : -1, r > 0 ? i - g.cols : -1, r < g.rows - 1 ? i + g.cols : -1]) {
      if (j < 0 || seen[j] || g.blocked[j]) continue;
      seen[j] = 1;
      prev[j] = i;
      q.push(j);
    }
  }
  const out: Point[] = [b];
  for (let i = best; i !== -1 && i !== start; i = prev[i]!) {
    const c = i % g.cols;
    out.unshift({ x: (c + 0.5) * g.cell, y: ((i - c) / g.cols + 0.5) * g.cell });
  }
  return out;
}

/**
 * Fly the ship to `target` with ordinary flight input only (no teleporting):
 * follows a grid path around obstacles, slowing near waypoints. Returns the
 * events produced on the way. Stops when `until` holds or after `maxTicks`.
 */
function flyTo(run: SectorRun, target: Point, until: (ev: SectorEvent[]) => boolean, maxTicks = 60 * 120): SectorEvent[] {
  const g = buildGrid(run.layout.width, run.layout.height, solidsOf(run.layout), 18);
  let path = gridPath(g, run.ship, target);
  const all: SectorEvent[] = [];
  for (let t = 0; t < maxTicks && run.phase === 'flight'; t++) {
    if (t % 90 === 0) path = gridPath(g, run.ship, target);
    while (path.length > 1 && dist(run.ship, path[0]!) < 40) path.shift();
    const wp = path[0]!;
    const dx = wp.x - run.ship.x;
    const dy = wp.y - run.ship.y;
    const d = Math.hypot(dx, dy) || 1;
    const speed = Math.hypot(run.ship.vx, run.ship.vy);
    const k = path.length === 1 && d < 120 && speed > 120 ? 0 : 1; // coast in on the last leg
    const ev = stepSector(run, { moveX: (dx / d) * k, moveY: (dy / d) * k });
    all.push(...ev);
    if (until(ev)) break;
  }
  return all;
}

const poisOf = (L: SectorLayout, kind: Poi['kind']): Poi[] => L.pois.filter((p) => p.kind === kind);

/* --------------------------------------------------------------- tests */

describe('sector generation: every catalogue system', () => {
  it('generates a valid sector for all 170 systems (bounds, arrival, spawns, reachability, separation, difficulty, loot, ids)', () => {
    expect(ALL.size).toBe(170);
    const issues = SYSTEMS.flatMap((s) => validateSector(ALL.get(s.id)!, s, sectorContext(graph, s.id)));
    expect(issues).toEqual([]);
  });

  it('honours each system config: size, station, one gate per System Map lane, 3-5 survey marks, salvage nodes', () => {
    for (const s of SYSTEMS) {
      const L = ALL.get(s.id)!;
      const lanes = systemGraph(graph, s.galaxyId).lanesOf(s.id).length;
      expect(L.width).toBe(s.sector.width);
      expect(poisOf(L, 'gate')).toHaveLength(lanes);
      expect(poisOf(L, 'station').length).toBe(s.sector.station ? 1 : 0);
      expect(poisOf(L, 'survey').length).toBeGreaterThanOrEqual(3);
      expect(poisOf(L, 'survey').length).toBeLessThanOrEqual(5);
      expect(poisOf(L, 'salvage').length).toBeLessThanOrEqual(s.sector.salvageNodes);
      expect(poisOf(L, 'exit')).toHaveLength(1);
      if (s.encounters.threat === 0) {
        expect(L.patrols).toHaveLength(0);
        expect(poisOf(L, 'installation')).toHaveLength(0);
      }
    }
  });

  it('contains the full feature palette across the catalogue', () => {
    const kinds = new Set<string>();
    let bodies = 0;
    let clouds = 0;
    let fields = 0;
    let patrols = 0;
    for (const L of ALL.values()) {
      for (const p of L.pois) kinds.add(p.kind);
      bodies += L.landmarks.filter((l) => l.kind === 'body').length;
      clouds += L.regions.filter((g) => g.kind === 'nebula').length;
      fields += L.regions.filter((g) => g.kind === 'asteroids').length;
      patrols += L.patrols.length;
    }
    expect([...kinds].sort()).toEqual(['anomaly', 'cache', 'derelict', 'exit', 'gate', 'installation', 'salvage', 'station', 'survey']);
    expect(bodies).toBeGreaterThan(50);
    expect(clouds).toBeGreaterThan(50);
    expect(fields).toBeGreaterThan(100);
    expect(patrols).toBeGreaterThan(50);
  });
});

describe('sector generation: determinism', () => {
  it('reproduces the identical layout from the stored seed, independent of call order', () => {
    const order = [...SYSTEMS].reverse();
    for (const s of order.slice(0, 40)) expect(generateSector(s, sectorContext(graph, s.id))).toEqual(ALL.get(s.id));
    expect(gen(SOL)).toEqual(ALL.get(SOL));
  });

  it('derives the layout from the system seed: a different seed gives a different layout', () => {
    const s = sys(SOL);
    const other = generateSector({ ...s, seed: (s.seed ^ 0x9e3779b9) >>> 0 }, sectorContext(graph, SOL));
    expect(other.pois.map((p) => [p.x, p.y])).not.toEqual(ALL.get(SOL)!.pois.map((p) => [p.x, p.y]));
    expect(ALL.get(SOL)!.seed).toBe(s.seed);
  });

  it('never depends on gameplay: the context comes from the static lane graph only', () => {
    // a second graph instance (as after a reload) gives the same gates and layout
    const g2 = buildNavGraph();
    expect(sectorContext(g2, SOL)).toEqual(sectorContext(graph, SOL));
    expect(generateSector(sys(SOL), sectorContext(g2, SOL))).toEqual(ALL.get(SOL));
  });

  it('points each gate the way the neighbour lies on the System Map', () => {
    const ctx = sectorContext(graph, SOL);
    const L = ALL.get(SOL)!;
    for (const g of ctx.gates) {
      const p = L.pois.find((q) => q.target === g.to)!;
      const a = Math.atan2(p.y - L.height / 2, p.x - L.width / 2);
      const diff = Math.abs(Math.atan2(Math.sin(a - g.angle), Math.cos(a - g.angle)));
      expect(diff).toBeLessThan(Math.PI / 2);
    }
  });
});

describe('sector generation: safety constraints', () => {
  it('spawns the ship clear of every obstacle and keeps the arrival zone empty', () => {
    for (const L of ALL.values()) {
      const solids = solidsOf(L);
      expect(L.spawns[0]!.id).toBe('arrival');
      for (const sp of L.spawns) for (const c of solids) expect(dist(sp, c)).toBeGreaterThan(c.r + 12);
      for (const c of solids) expect(dist(L.arrival, c)).toBeGreaterThanOrEqual(L.arrival.r + c.r - 1e-6);
      for (const pr of L.patrols) for (const pt of pr.points) expect(dist(pt, L.arrival)).toBeGreaterThan(L.arrival.r);
    }
  });

  it('keeps every exit, gate and objective reachable from the arrival', () => {
    for (const L of ALL.values()) {
      expect(unreachableTargets(L)).toEqual([]);
      const grid = buildGrid(L.width, L.height, solidsOf(L));
      const seen = reachable(grid, L.spawns[0]!);
      for (const p of L.pois.filter((q) => q.required)) expect(canReach(grid, seen, p, p.r)).toBe(true);
    }
  });

  it('keeps major objects apart and every object inside the sector', () => {
    for (const L of ALL.values()) {
      const major = [...L.landmarks.map((l) => ({ ...l, r: Math.max(l.r, l.hazardR) })), ...L.pois.filter((p) => p.solidR > 0).map((p) => ({ ...p, r: p.solidR }))];
      for (let i = 0; i < major.length; i++) for (let j = i + 1; j < major.length; j++) expect(dist(major[i]!, major[j]!)).toBeGreaterThan(major[i]!.r + major[j]!.r);
      for (const p of L.pois) {
        expect(p.x).toBeGreaterThan(0);
        expect(p.y).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(L.width);
        expect(p.y).toBeLessThan(L.height);
      }
    }
  });

  it('matches enemy difficulty to the region: tiers capped by difficulty, ships within encounter slots', () => {
    for (const s of SYSTEMS) {
      const L = ALL.get(s.id)!;
      for (const p of L.patrols) expect(p.tier).toBeLessThanOrEqual(maxTierFor(s.difficulty));
      const ships = L.patrols.reduce((n, p) => n + p.ships, 0) + poisOf(L, 'installation').reduce((n, p) => n + p.wave, 0);
      expect(ships).toBeLessThanOrEqual(s.sector.encounterSlots);
    }
    // every enemy family is slower than the starter's top speed (340), and boost (x1.45)
    // lets even the slowest hull (the Condor, 276 -> 400) break away from an interceptor (330)
    for (const f of FAMILY_IDS) expect(FAMILIES[f].speed, f).toBeLessThan(340);
  });

  it('never guarantees rare loot: none at difficulty 1, chances capped, and no sector where every container is rare', () => {
    for (const k of ['derelict', 'cache', 'anomaly', 'installation', 'salvage'] as const) {
      expect(rareChance(k, 1, true)).toBe(0);
      for (let d = 1; d <= 5; d++) expect(rareChance(k, d, true)).toBeLessThanOrEqual(0.3);
    }
    let rare = 0;
    let total = 0;
    for (const s of SYSTEMS) {
      const L = ALL.get(s.id)!;
      const containers = L.pois.filter((p) => p.kind !== 'salvage' && p.loot.length > 0);
      const isRare = (p: Poi): boolean => p.loot.some((e) => RARE_RESOURCES.includes(e.resource));
      if (s.difficulty <= 1) expect(containers.some(isRare)).toBe(false);
      if (containers.length >= 2) expect(containers.every(isRare)).toBe(false);
      for (const p of L.pois) for (const e of p.loot) {
        expect(e.amount).toBeGreaterThanOrEqual(1);
        expect(e.amount).toBeLessThanOrEqual(99);
        total += 1;
        if (RARE_RESOURCES.includes(e.resource)) rare += 1;
      }
    }
    expect(rare / total).toBeLessThan(0.15);
  });

  it('the validator rejects broken layouts (blocked arrival, POI in a rock, enclosed objective, bad ids)', () => {
    const L = ALL.get(SOL)!;
    const s = sys(SOL);
    const ctx = sectorContext(graph, SOL);
    const codes = (x: SectorLayout): string[] => [...new Set(validateSector(x, s, ctx).map((i) => i.code))].sort();
    const blocked = { ...L, rocks: [...L.rocks, { x: L.arrival.x, y: L.arrival.y, r: 30, field: 'test', shape: 0.5 }] };
    expect(codes(blocked)).toContain('arrival-blocked');
    const mark = poisOf(L, 'survey')[0]!;
    expect(codes({ ...L, rocks: [...L.rocks, { x: mark.x, y: mark.y, r: 30, field: 'test', shape: 0.5 }] })).toContain('poi-in-obstacle');
    const ring = Array.from({ length: 24 }, (_, i) => ({ x: mark.x + Math.cos((i / 24) * Math.PI * 2) * 150, y: mark.y + Math.sin((i / 24) * Math.PI * 2) * 150, r: 30, field: 'wall', shape: 0.5 }));
    expect(codes({ ...L, rocks: [...L.rocks, ...ring] })).toContain('unreachable');
    expect(codes({ ...L, pois: [...L.pois, { ...mark }] })).toContain('duplicate-id');
    expect(codes({ ...L, pois: L.pois.map((p) => (p === mark ? { ...p, id: 'Mark #1' } : p)) })).toContain('bad-id');
  });

  it('repair clears an enclosing rock wall so the objective is reachable again', () => {
    const L = ALL.get(SOL)!;
    const mark = poisOf(L, 'survey')[0]!;
    const ring = Array.from({ length: 24 }, (_, i) => ({ x: mark.x + Math.cos((i / 24) * Math.PI * 2) * 150, y: mark.y + Math.sin((i / 24) * Math.PI * 2) * 150, r: 30, field: 'wall', shape: 0.5 }));
    const walled = { ...L, rocks: [...L.rocks, ...ring] };
    expect(unreachableTargets(walled)).toContain(mark.id);
    const fixed = repairLayout(walled);
    expect(unreachableTargets(fixed)).toEqual([]);
    expect(fixed.pois.filter((p) => p.required)).toHaveLength(L.pois.filter((p) => p.required).length);
  });
});

describe('points of interest: stable ids', () => {
  it('gives every POI a unique id in the documented grammar, stable across regeneration', () => {
    for (const L of ALL.values()) {
      const ids = L.pois.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(POI_ID);
    }
    expect(gen(SOL).pois.map((p) => p.id)).toEqual(ALL.get(SOL)!.pois.map((p) => p.id));
    expect(globalPoiId(SOL, 'derelict-1')).toBe('milky-way/sol#derelict-1');
  });

  it('names gates after their target system and fixed kinds by role', () => {
    const L = ALL.get(SOL)!;
    for (const p of poisOf(L, 'gate')) expect(p.id).toBe(`gate:${p.target}`);
    expect(L.pois.find((p) => p.kind === 'exit')!.id).toBe('exit');
    expect(poisOf(L, 'survey').map((p) => p.id)).toEqual(poisOf(L, 'survey').map((_, i) => `survey-${i + 1}`));
  });
});

describe('local sector run: a genuinely playable sector (Sol)', () => {
  it('a test pilot flies the whole survey with ordinary flight input, around obstacles, and completes it once', () => {
    const L = ALL.get(SOL)!;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 1 });
    const events: SectorEvent[] = [];
    for (let guard = 0; guard < 8 && run.phase === 'flight'; guard++) {
      const next = poisOf(L, 'survey').filter((p) => !isDone(run, p)).sort((a, b) => dist(run.ship, a) - dist(run.ship, b))[0];
      if (!next) break;
      events.push(...flyTo(run, next, (ev) => ev.some((e) => e.type === 'recorded' || e.type === 'surveyComplete')));
    }
    expect(events.filter((e) => e.type === 'recorded')).toHaveLength(poisOf(L, 'survey').length);
    expect(events.filter((e) => e.type === 'surveyComplete')).toHaveLength(1);
    expect(run.phase).toBe('complete');
    expect(run.surveyed).toBe(true);
    // keep flying after the panel: no second completion
    resumeSector(run);
    for (let i = 0; i < 120; i++) expect(stepSector(run, { moveX: 1, moveY: 0 }).some((e) => e.type === 'surveyComplete')).toBe(false);
  });

  it('flies to a wreck, inspects it once and the reward is never granted again', () => {
    const L = ALL.get(SOL)!;
    const wreck = poisOf(L, 'derelict')[0]!;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 2 });
    flyTo(run, wreck, () => run.focus === wreck.id);
    expect(run.focus).toBe(wreck.id);
    const first = interact(run);
    expect(first).toEqual([{ type: 'looted', id: wreck.id, kind: 'derelict', label: wreck.label, loot: wreck.loot, left: [] }]);
    expect(interact(run)).toEqual([]);
    expect(run.focus).not.toBe(wreck.id);
  });

  it('collects salvage by flying through it, exactly once', () => {
    const L = [...ALL.values()].find((x) => poisOf(x, 'salvage').length > 0)!;
    const node = poisOf(L, 'salvage')[0]!;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 3 });
    const ev = flyTo(run, node, (e) => e.some((x) => x.type === 'collected'));
    expect(ev.filter((e) => e.type === 'collected' && e.id === node.id)).toHaveLength(1);
    for (let i = 0; i < 60; i++) expect(stepSector(run, { moveX: 0, moveY: 0 }).some((e) => e.type === 'collected' && e.id === node.id)).toBe(false);
  });

  it('docks at the station (repeatable, logged once), uses a gate and the exit beacon', () => {
    const L = ALL.get(SOL)!;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 4, gates: Object.fromEntries(poisOf(L, 'gate').map((g) => [g.id, { state: 'open' as const, label: 'Gate', detail: '' }])) });
    const station = poisOf(L, 'station')[0]!;
    flyTo(run, station, () => run.focus === station.id);
    run.shield = 40;
    expect(interact(run)).toEqual([{ type: 'docked', id: 'station', first: true }]);
    expect(run.shield).toBe(run.craft.stats.shield);
    expect(interact(run)).toEqual([{ type: 'docked', id: 'station', first: false }]);
    const gate = poisOf(L, 'gate')[0]!;
    flyTo(run, gate, () => run.focus === gate.id);
    expect(interact(run)[0]).toMatchObject({ type: 'gate', target: gate.target, gate: { state: 'open' } });
    const exit = L.pois.find((p) => p.kind === 'exit')!;
    flyTo(run, exit, () => run.focus === exit.id);
    expect(interact(run)).toEqual([{ type: 'exit' }]);
  });

  it('spawns at the matching gate when arriving through one', () => {
    const L = ALL.get(SOL)!;
    const gate = poisOf(L, 'gate')[0]!;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { spawn: gate.id });
    expect(run.spawn).toBe(gate.id);
    expect(dist(run.ship, gate)).toBeLessThan(200);
    expect(createSectorRun(L, EMPTY_SECTOR_SAVE, { spawn: 'gate:nowhere/at-all' }).spawn).toBe('arrival');
  });
});

describe('local sector run: hostiles and encounters (temporary entities)', () => {
  const hostileSector = [...ALL.values()].find((L) => L.patrols.length > 0 && poisOf(L, 'installation').length > 0)!;

  it('creates patrol ships only near the pilot and removes them again when far away', () => {
    const L = hostileSector;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 5 });
    const pr = L.patrols[0]!;
    // park the ship on the route: its ships appear
    run.ship.x = pr.points[0]!.x;
    run.ship.y = pr.points[0]!.y;
    stepSector(run, { moveX: 0, moveY: 0 });
    expect(run.hostiles.filter((h) => h.source === pr.id)).toHaveLength(pr.ships);
    // fly away: idle ships are despawned beyond the sleep radius
    run.invuln = 1e9; // ignore contact damage for this check
    const far = { x: pr.points[0]!.x < L.width / 2 ? L.width - 300 : 300, y: pr.points[0]!.y < L.height / 2 ? L.height - 300 : 300 };
    for (let i = 0; i < 6000 && run.hostiles.some((h) => h.source === pr.id); i++) {
      run.ship.x = far.x;
      run.ship.y = far.y;
      stepSector(run, { moveX: 0, moveY: 0 });
    }
    const minRoute = Math.min(...pr.points.map((p) => dist(p, far)));
    expect(minRoute).toBeGreaterThan(COMBAT.sleepRadius + 400);
    expect(run.hostiles.filter((h) => h.source === pr.id)).toHaveLength(0);
  });

  it('a hostile installation starts an encounter, can be broken off, and is cleared once by surviving nearby', () => {
    const L = hostileSector;
    const inst = poisOf(L, 'installation')[0]!;
    const run = createSectorRun({ ...L, sites: [], hazards: [] }, EMPTY_SECTOR_SAVE, { seed: 6 });
    run.ship.x = inst.x + inst.alertR - 20;
    run.ship.y = inst.y;
    // no encounter starts during the arrival grace
    for (let i = 0; i < 3; i++) expect(stepSector(run, { moveX: 0, moveY: 0 }).some((e) => e.type === 'encounter')).toBe(false);
    run.grace = 0;
    const start = stepSector(run, { moveX: 0, moveY: 0 });
    expect(start).toContainEqual({ type: 'encounter', id: inst.id, kind: 'outpost', label: inst.label, state: 'start', loot: [], left: [] });
    expect(run.hostiles.filter((h) => h.source === inst.id)).toHaveLength(inst.wave);
    run.ship.x = inst.x + COMBAT.encounterLeash + 50;
    expect(stepSector(run, { moveX: 0, moveY: 0 })).toContainEqual({ type: 'encounter', id: inst.id, kind: 'outpost', label: inst.label, state: 'broken', loot: [], left: [] });
    expect(run.hostiles.filter((h) => h.source === inst.id)).toHaveLength(0);
    // back in, and hold position (shield kept up for the test)
    run.ship.x = inst.x + inst.alertR - 20;
    let cleared: SectorEvent[] = [];
    for (let i = 0; i < inst.holdTicks + 5; i++) {
      run.shield = run.craft.stats.shield;
      run.ship.x = inst.x + inst.alertR - 20;
      run.ship.y = inst.y;
      cleared = cleared.concat(stepSector(run, { moveX: 0, moveY: 0 }).filter((e) => e.type === 'encounter'));
    }
    expect(cleared.filter((e) => e.type === 'encounter' && e.state === 'cleared')).toHaveLength(1);
    expect(run.done.has(inst.id)).toBe(true);
    for (let i = 0; i < 30; i++) expect(stepSector(run, { moveX: 0, moveY: 0 }).some((e) => e.type === 'encounter')).toBe(false);
  });

  it('recalls the ship to the arrival zone with a full hull and shield when the hull fails (shield first, then hull)', () => {
    const L = hostileSector;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 7 });
    run.ship.x = L.width / 2;
    run.ship.y = L.height / 2;
    run.shield = 0;
    run.hull = 0.001;
    run.sinceHit = 0;
    const star = L.landmarks.find((l) => l.hazardR > l.r);
    expect(star).toBeDefined(); // the shield is drained by the star's burn radius
    if (star) {
      run.ship.x = star.x + star.r + 20;
      run.ship.y = star.y;
    } else run.hull = 0;
    run.invuln = 0;
    let ev: SectorEvent[] = [];
    for (let i = 0; i < 5 && !ev.some((e) => e.type === 'recalled'); i++) {
      if (!star) run.hull = 0;
      ev = stepSector(run, { moveX: 0, moveY: 0 });
    }
    expect(ev).toContainEqual({ type: 'recalled' });
    expect(ev.some((e) => e.type === 'wrecked')).toBe(true);
    expect(run.shield).toBe(run.craft.stats.shield);
    expect(run.hull).toBe(run.craft.stats.hull);
    expect(dist(run.ship, L.spawns[0]!)).toBeLessThan(1);
    expect(run.hostiles).toHaveLength(0);
  });

  it('hostiles never enter the arrival zone and only regional families appear', () => {
    const L = hostileSector;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 8 });
    const pr = L.patrols[0]!;
    run.ship.x = pr.points[0]!.x;
    run.ship.y = pr.points[0]!.y;
    run.invuln = 1e9;
    for (let i = 0; i < 600; i++) {
      // lure them toward the arrival
      const dx = L.spawns[0]!.x - run.ship.x;
      const dy = L.spawns[0]!.y - run.ship.y;
      const d = Math.hypot(dx, dy) || 1;
      stepSector(run, { moveX: dx / d, moveY: dy / d });
      run.shield = run.craft.stats.shield;
      for (const h of run.hostiles) {
        expect(dist(h, L.arrival)).toBeGreaterThanOrEqual(L.arrival.r - 1e-6);
        expect(difficultyRow(L.difficulty).families).toContain(h.family);
      }
    }
  });
});

describe('local sector run: teardown, re-entry and persistence', () => {
  it('disposes every temporary entity and refuses to step afterwards', () => {
    const L = [...ALL.values()].find((x) => x.patrols.length > 0)!;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 9 });
    run.ship.x = L.patrols[0]!.points[0]!.x;
    run.ship.y = L.patrols[0]!.points[0]!.y;
    stepSector(run, { moveX: 0, moveY: 0 });
    expect(run.hostiles.length).toBeGreaterThan(0);
    disposeSectorRun(run);
    expect(run.hostiles).toHaveLength(0);
    expect(run.patrols.size).toBe(0);
    expect(run.encounters).toHaveLength(0);
    expect(run.enemyShots).toHaveLength(0);
    expect(run.mines).toHaveLength(0);
    expect(run.pending).toHaveLength(0);
    expect(stepSector(run, { moveX: 1, moveY: 0 })).toEqual([]);
    expect(interact(run)).toEqual([]);
  });

  it('starts every visit with no hostiles: patrols are not loaded until the pilot comes near', () => {
    for (const L of ALL.values()) expect(createSectorRun(L, EMPTY_SECTOR_SAVE).hostiles).toHaveLength(0);
  });

  it('re-entry reapplies saved progress on top of the identical regenerated layout', () => {
    const L = ALL.get(SOL)!;
    const wreck = poisOf(L, 'derelict')[0]!;
    const mark = poisOf(L, 'survey')[0]!;
    const save: SectorSave = { done: [wreck.id, mark.id, 'not-in-this-sector-9'], surveyed: false };
    const again = createSectorRun(gen(SOL), save, { seed: 10 });
    expect(isDone(again, wreck)).toBe(true);
    expect(isDone(again, mark)).toBe(true);
    expect(again.done.has('not-in-this-sector-9')).toBe(false); // unknown ids are ignored, never crash
    expect(marksLeft(again)).toBe(poisOf(L, 'survey').length - 1);
    // standing on the wreck offers nothing
    again.ship.x = wreck.x;
    again.ship.y = wreck.y + wreck.solidR + 20;
    stepSector(again, { moveX: 0, moveY: 0 });
    expect(again.focus).not.toBe(wreck.id);
    // a surveyed sector never completes again and treats every mark as done
    const surveyed = createSectorRun(gen(SOL), { done: [], surveyed: true });
    expect(marksLeft(surveyed)).toBe(0);
    for (let i = 0; i < 30; i++) expect(stepSector(surveyed, { moveX: 1, moveY: 0 }).some((e) => e.type === 'surveyComplete' || e.type === 'recorded')).toBe(false);
  });

  it('pause freezes the run; restart returns to the arrival but keeps completed interactions', () => {
    const L = ALL.get(SOL)!;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 11 });
    for (let i = 0; i < 60; i++) stepSector(run, { moveX: 1, moveY: 0 });
    run.done.add('cache-1');
    pauseSector(run);
    const x = run.ship.x;
    expect(stepSector(run, { moveX: 1, moveY: 0 })).toEqual([]);
    expect(run.ship.x).toBe(x);
    restartSector(run);
    expect(run.phase).toBe('flight');
    expect(dist(run.ship, L.spawns[0]!)).toBeLessThan(1);
    expect(run.tick).toBe(0);
    expect(run.done.has('cache-1')).toBe(true);
  });

  it('persists completed activities, cargo and the survey flag in the profile (round trip through storage)', () => {
    const store = new MemoryStore();
    let p = withSectorProgress(EMPTY_PROFILE, SOL, ['derelict-1', 'survey-2']);
    p = withSectorProgress(p, SOL, ['derelict-1']); // idempotent
    p = withSectorProgress(p, SOL, [], true);
    p = addCargo(p, [{ resource: 'scrap', amount: 4 }, { resource: 'alloy', amount: 2 }]);
    p = addCargo(p, [{ resource: 'scrap', amount: 1 }, { resource: 'fuel', amount: 0 }]);
    expect(p.sectors[SOL]).toEqual({ done: ['derelict-1', 'survey-2'], surveyed: true });
    expect(p.cargo).toEqual({ scrap: 5, alloy: 2 });
    expect(withSectorProgress(p, SOL, ['derelict-1'])).toBe(p);
    expect(saveProfile(store, p)).toBe(true);
    const back = loadProfile(store);
    expect(JSON.parse(store.read('galaxia:freeroam')!).version).toBe(10);
    expect(back.data.sectors[SOL]).toEqual({ done: ['derelict-1', 'survey-2'], surveyed: true });
    expect(back.data.cargo).toEqual({ scrap: 5, alloy: 2 });
    // feeding the saved record back into a run marks the work done
    const run = createSectorRun(ALL.get(SOL)!, back.data.sectors[SOL]!);
    expect(run.surveyed).toBe(true);
  });

  it('sanitises damaged sector records and migrates v3 saves (charted systems count as surveyed)', () => {
    const store = new MemoryStore();
    store.write('galaxia:freeroam', JSON.stringify({ ...EMPTY_PROFILE, version: 10, sectors: { [SOL]: { done: ['cache-1', 'BAD ID', 7, 'cache-1'], surveyed: 'yes' }, 'NOT A SYSTEM': { done: [], surveyed: true } }, cargo: { scrap: 3, alloy: -2, 'Bad Key': 5, fuel: 1.5 } }));
    const fixed = loadProfile(store);
    expect(fixed.status).toBe('repaired');
    expect(fixed.data.sectors).toEqual({ [SOL]: { done: ['cache-1'], surveyed: false } });
    expect(fixed.data.cargo).toEqual({ scrap: 3 });
    const v3 = new MemoryStore();
    v3.write('galaxia:freeroam', JSON.stringify({ ...EMPTY_PROFILE, version: 3, chartedSystems: [SOL, 'milky-way/sirius'], sectors: undefined, cargo: undefined }));
    const migrated = loadProfile(v3);
    expect(migrated.status).toBe('migrated');
    expect(migrated.data.sectors).toEqual({ [SOL]: { done: [], surveyed: true }, 'milky-way/sirius': { done: [], surveyed: true } });
    expect(migrated.data.cargo).toEqual({});
  });
});

describe('sector constants', () => {
  it('keeps the arrival zone larger than the clear radius used by hostiles and wide enough to turn', () => {
    expect(SECTOR_GEN.arrivalClear).toBeGreaterThanOrEqual(300);
    expect(COMBAT.sleepRadius).toBeGreaterThan(COMBAT.wakeRadius);
  });
});

describe('sector art budget', () => {
  it('keeps every asteroid outline to a few vertices in all generated sectors (regression: WebKit memory crash)', () => {
    let rocks = 0;
    let maxVerts = 0;
    for (const L of ALL.values()) {
      for (const r of L.rocks) {
        const pts = rockOutline(r);
        const n = pts.length / 2;
        rocks += 1;
        maxVerts = Math.max(maxVerts, n);
        expect(n).toBeGreaterThanOrEqual(ROCK_VERTICES.min);
        expect(n).toBeLessThanOrEqual(ROCK_VERTICES.max);
        for (let i = 0; i < pts.length; i += 2) {
          expect(Number.isFinite(pts[i]!) && Number.isFinite(pts[i + 1]!)).toBe(true);
          expect(Math.hypot(pts[i]! - r.x, pts[i + 1]! - r.y)).toBeLessThanOrEqual(r.r + 1e-9);
        }
      }
    }
    expect(rocks).toBeGreaterThan(1000);
    expect(maxVerts).toBeLessThanOrEqual(ROCK_VERTICES.max);
  });

  it('gives the same outline for the same rock (decoration is deterministic)', () => {
    const r = gen('milky-way/barnards-star').rocks[0]!;
    expect(rockOutline(r)).toEqual(rockOutline({ ...r }));
  });
});
