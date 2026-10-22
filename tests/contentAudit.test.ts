/**
 * Free Roam Prompt 14 §3 + §6: content audit.
 *
 * catalogue.test.ts / galaxyMap.test.ts / systemMap.test.ts / sectorStability
 * already validate counts, ids, routes, provenance and sector configs one rule
 * at a time; this file adds the cross-cutting checks a playtester cares about:
 *
 *  - the Prompt 14 content checklist in one place (so the report can cite it);
 *  - every MANDATORY objective (the story chain) resolves, at the moment it is
 *    accepted, to a system the pilot can actually route to (never sealed,
 *    never unreachable), with the targeted site present and not done, and the
 *    whole chain can be completed by a model pilot with a bounded number of
 *    extra survey runs (no grind, no dead end);
 *  - repeatable objectives stay repeatable (patrols return on re-entry);
 *  - contract boards never point at a sealed or unreachable system.
 */
import { describe, expect, it } from 'vitest';
import { catalogueIssues, getCatalogue, SYSTEM_PROVENANCE } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { applySurvey, applyTravel, checkTravel, deriveView, findPath, progressFromSaved, type ExplorationProgress } from '../src/modes/freeroam/galaxy/progress.ts';
import { applySystemTravel, deriveSystemView } from '../src/modes/freeroam/galaxy/systems.ts';
import { EMPTY_PROFILE } from '../src/modes/freeroam/profile.ts';
import type { GameEvent } from '../src/modes/freeroam/progression/events.ts';
import { patrolShips, stationBoard } from '../src/modes/freeroam/progression/contracts.ts';
import { rewardChartTargets } from '../src/modes/freeroam/progression/station.ts';
import { STORY } from '../src/modes/freeroam/progression/missionData.ts';
import { buildMissionWorld, layoutOf } from '../src/modes/freeroam/progression/missionWorld.ts';
import { acceptMission, consumeEvent, targetLocal, targetSystem } from '../src/modes/freeroam/progression/missions.ts';
import { EMPTY_MISSIONS, TARGET_DONE, type MissionState } from '../src/modes/freeroam/progression/missionTypes.ts';
import { createSectorRun } from '../src/modes/freeroam/sector/run.ts';
import { RARE_RESOURCES } from '../src/modes/freeroam/sector/model.ts';
import type { GalaxyId } from '../src/modes/freeroam/catalogue/types.ts';
import { eventsOf, fightAll, flyTo } from './helpers/frPilot.ts';

const graph = buildNavGraph();
const cat = getCatalogue();
const MW = 'milky-way';

describe('Prompt 14 content checklist', () => {
  it('10 galaxies, 15-20 systems each, 150-200 overall, zero validation issues', () => {
    expect(catalogueIssues()).toEqual([]);
    expect(cat.galaxies).toHaveLength(10);
    for (const g of cat.galaxies) {
      const n = cat.systems.filter((s) => s.galaxyId === g.id).length;
      expect(n, g.id).toBeGreaterThanOrEqual(15);
      expect(n, g.id).toBeLessThanOrEqual(20);
    }
    expect(cat.systems.length).toBeGreaterThanOrEqual(150);
    expect(cat.systems.length).toBeLessThanOrEqual(200);
  });

  it('ids are unique slugs, every reference resolves, every record carries a provenance label', () => {
    const ids = [...cat.galaxies.map((g) => g.id), ...cat.systems.map((s) => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of cat.systems) {
      expect(s.id).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/);
      expect(s.id.startsWith(`${s.galaxyId}/`)).toBe(true);
      expect(SYSTEM_PROVENANCE).toContain(s.provenance.status);
      expect(s.provenance.sourceIds.length > 0).toBe(s.provenance.status === 'verified-object');
      for (const c of s.connections) expect(graph.system(c), `${s.id} -> ${c}`).toBeTruthy();
    }
    for (const e of graph.edges) {
      expect(graph.node(e.from), e.id).toBeTruthy();
      expect(graph.node(e.to), e.id).toBeTruthy();
    }
  });

  it('every system generates a sector from its config (station, gateway and difficulty respected)', () => {
    for (const s of cat.systems) {
      const L = layoutOf(graph, s.id)!;
      expect(L, s.id).toBeTruthy();
      expect(L.systemId).toBe(s.id);
      expect(L.difficulty).toBe(s.difficulty);
      expect(L.pois.some((p) => p.kind === 'station')).toBe(s.sector.station === true);
      expect(L.pois.some((p) => p.kind === 'exit' || p.kind === 'gate')).toBe(true);
    }
  });
});

/* ------------------------------------------------------- the story chain walk */

interface Walk {
  p: ExplorationProgress;
  m: MissionState;
  sectors: Record<string, { done: string[] }>;
  extraSurveys: number;
  log: string[];
}

const publish = (w: Walk, e: GameEvent): void => {
  w.m = consumeEvent(w.m, e).state;
};
const goSystem = (w: Walk, sys: string): void => {
  if (w.p.system === sys) return;
  const g = graph.system(sys)!.galaxyId as GalaxyId;
  if (g !== w.p.current) goGalaxy(w, g);
  const r = applySystemTravel(graph, w.p, sys);
  if (!r.ok) throw new Error(`cannot route to ${sys}: ${r.reason}`);
  w.p = r.progress;
  for (const id of r.plan.path.slice(1)) publish(w, { type: 'system-visited', systemId: id, galaxyId: g, first: true });
};
const goGalaxy = (w: Walk, g: GalaxyId): void => {
  const path = findPath(deriveView(graph, w.p), g);
  if (!path) throw new Error(`no open path to ${g}`);
  for (const hop of path.slice(1)) {
    const r = applyTravel(graph, w.p, hop);
    if (!r.ok) throw new Error(`travel to ${hop} blocked: ${r.reason}`);
    w.p = r.progress;
    publish(w, { type: 'galaxy-reached', galaxyId: hop, first: true });
  }
};
/** One survey run where the system map suggests (the player's "next" button). */
const survey = (w: Walk, extra: boolean): void => {
  const sug = deriveSystemView(deriveView(graph, w.p), w.p.current).suggestion();
  if (sug && sug !== w.p.system) goSystem(w, sug);
  const r = applySurvey(graph, w.p);
  w.p = r.progress;
  if (r.chartedSystem) publish(w, { type: 'system-charted', systemId: r.chartedSystem.id, galaxyId: r.galaxy });
  if (extra) w.extraSurveys++;
};

describe('mandatory objectives: the story chain is reachable and completable', () => {
  it('walks all 10 story missions; every target is routable when accepted; no sealed or done targets', () => {
    const w: Walk = { p: progressFromSaved(graph, EMPTY_PROFILE), m: EMPTY_MISSIONS, sectors: {}, extraSurveys: 0, log: [] };
    for (const def of STORY) {
      const world = buildMissionWorld(graph, w.p, w.sectors);
      const acc = acceptMission(w.m, def, world, { visitedGalaxies: w.p.visited, charted: w.p.charted.length });
      expect(acc.ok, `accept ${def.id}`).toBe(true);
      if (!acc.ok) return;
      w.m = acc.state;
      const active = w.m.active.find((a) => a.id === def.id)!;
      def.objectives.forEach((o, i) => {
        const t = active.targets[i]!;
        expect(t, `${def.id}: objective ${i} has something to do`).not.toBe(TARGET_DONE);
        const sys = targetSystem(t);
        if (sys) {
          // reachable now: enterable (never sealed) and routable from where the pilot is
          expect(world.enterable(sys), `${def.id} -> ${sys} enterable`).toBe(true);
          if (graph.system(sys)!.galaxyId === w.p.current && sys !== w.p.system) expect(applySystemTravel(graph, w.p, sys).ok, `${def.id} -> ${sys} routable`).toBe(true);
          const local = targetLocal(t);
          if (local) {
            const L = layoutOf(graph, sys)!;
            const site = [...L.pois.map((p) => p.id), ...L.sites.map((s) => s.id)].includes(local);
            expect(site, `${def.id}: ${t} exists`).toBe(true);
            expect(w.sectors[sys]?.done ?? []).not.toContain(local);
          }
        }
        w.log.push(`${def.id}: ${t || '(anywhere)'}`);
        // the model pilot does the objective
        switch (o.kind) {
          case 'chart':
            for (let k = 0; k < o.count; k++) survey(w, false);
            break;
          case 'poi': {
            if (sys) {
              goSystem(w, sys);
              publish(w, { type: 'poi-completed', systemId: sys, poiId: targetLocal(t), kind: o.poiKind! });
              (w.sectors[sys] ??= { done: [] }).done.push(targetLocal(t));
            } else {
              // "any": nearest routable systems holding enough of that kind (Sol for the first salvage)
              let left = o.count;
              const world2 = buildMissionWorld(graph, w.p, w.sectors);
              for (const id of world2.systemsIn(w.p.current).filter((x) => world2.enterable(x)).sort((a, b) => world2.hops(w.p.system, a) - world2.hops(w.p.system, b))) {
                for (const s of world2.sites(id).filter((x) => x.kind === o.poiKind && !x.done)) {
                  if (left <= 0) break;
                  goSystem(w, id);
                  publish(w, { type: 'poi-completed', systemId: id, poiId: s.id, kind: o.poiKind! });
                  (w.sectors[id] ??= { done: [] }).done.push(s.id);
                  left--;
                }
                if (left <= 0) break;
              }
              expect(left, `${def.id}: enough ${o.poiKind} nearby`).toBe(0);
            }
            break;
          }
          case 'destroy': {
            goSystem(w, sys);
            const L = layoutOf(graph, sys)!;
            expect(L.patrols.length, `${def.id}: ${sys} has a patrol`).toBeGreaterThan(0);
            // one visit is enough: the targeted system's patrols fly at least the required number of ships
            expect(L.patrols.reduce((n, p) => n + p.ships, 0), `${def.id}: ships at ${sys}`).toBeGreaterThanOrEqual(o.count);
            w.log.push(`  patrol ships at ${sys}: ${L.patrols.map((p) => p.ships).join('+')} (needs ${o.count})`);
            for (let k = 0; k < o.count; k++) publish(w, { type: 'hostile-destroyed', systemId: sys, faction: L.patrols[0]!.faction, family: 'x', role: 'patrol', source: L.patrols[0]!.id });
            break;
          }
          case 'deliver':
            expect(graph.system(sys)!.sector.station, `${def.id}: ${sys} has a station`).toBe(true);
            goSystem(w, sys);
            publish(w, { type: 'delivered', missionId: def.id, systemId: sys, resource: o.resources![0]!, amount: o.count });
            break;
          case 'clear': {
            goSystem(w, sys);
            // outposts are installation POIs (encounter id = POI id); other kinds are encounter sites
            const L = layoutOf(graph, sys)!;
            const local = targetLocal(t);
            const ok = o.encounter === 'outpost' ? L.pois.some((p) => p.id === local && p.kind === 'installation') : L.sites.some((s) => s.id === local && s.kind === o.encounter);
            expect(ok, `${def.id}: ${t} is a ${o.encounter}`).toBe(true);
            publish(w, { type: 'encounter-cleared', systemId: sys, encounterId: local, kind: o.encounter! });
            break;
          }
          case 'reach-galaxy': {
            // survey where the map suggests until the destination opens (counted as extra work)
            // The destination's requirements are shown on the galaxy map (locked: a milestone; sealed: a route
            // milestone). The model pilot works the first unmet one: an unlocked galaxy with no survey yet
            // (Andromeda Charts = one survey in each Magellanic Cloud), else Milky Way exploration (Lantern Gate).
            const goal = o.galaxy as GalaxyId;
            for (let k = 0; k < 40 && !findPath(deriveView(graph, w.p), goal); k++) {
              const v = deriveView(graph, w.p);
              const fresh = graph.nodes.find((n) => n.id !== goal && v.galaxyUnlocked(n.id) && v.surveysIn(n.id) === 0 && findPath(v, n.id));
              goGalaxy(w, fresh ? fresh.id : (MW as GalaxyId));
              survey(w, true);
            }
            expect(findPath(deriveView(graph, w.p), goal), `${def.id}: ${goal} opens`).toBeTruthy();
            w.log.push(`  checkTravel from ${w.p.current}: ${checkTravel(deriveView(graph, w.p), goal).ok ? 'direct' : 'via path'}`);
            goGalaxy(w, o.galaxy as GalaxyId);
            break;
          }
          case 'acquire': {
            // a guaranteed source exists in a routable system of the current galaxy
            const world2 = buildMissionWorld(graph, w.p, w.sectors);
            const src = world2.systemsIn(w.p.current).filter((x) => world2.enterable(x)).find((id) => layoutOf(graph, id)!.pois.some((p) => p.loot.some((l) => (o.resources ?? []).includes(l.resource))));
            expect(src, `${def.id}: a placed ${o.resources!.join('/')} in ${w.p.current}`).toBeTruthy();
            w.log.push(`  source: ${src}`);
            publish(w, { type: 'resource-acquired', resource: o.resources![0]!, amount: 1 });
            break;
          }
          default:
            throw new Error(`unhandled objective ${o.kind}`);
        }
      });
      expect(w.m.completed, `${def.id} completes`).toContain(def.id);
      // turn it in: chart rewards are picked by the game (freeRoamMode.claimMission)
      const picks = rewardChartTargets(graph, w.p, def.galaxy || w.p.current, def.rewards.charts).filter((c) => !w.p.charted.includes(c));
      if (picks.length) w.p = { ...w.p, charted: [...w.p.charted, ...picks] };
    }
    expect(STORY.every((d) => w.m.completed.includes(d.id))).toBe(true);
    // no grind: the model pilot needed only a few survey runs the story did not ask for
    expect(w.extraSurveys).toBeLessThanOrEqual(8);
    w.log.push(`extra survey runs: ${w.extraSurveys}; charted ${w.p.charted.length}; galaxies ${w.p.visited.join(',')}`);
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (env?.['FR_METRICS']) console.log(`STORY\n${w.log.join('\n')}`);
  });

  it('rare objectives have placed sources: core shards in reachable Milky Way systems (none in difficulty 1)', () => {
    const mw = cat.systems.filter((s) => s.galaxyId === MW);
    const withRare = mw.filter((s) => layoutOf(graph, s.id)!.pois.some((p) => p.loot.some((l) => RARE_RESOURCES.includes(l.resource))));
    expect(withRare.length).toBeGreaterThan(0);
    for (const s of withRare) expect(s.difficulty).toBeGreaterThanOrEqual(2);
  });

  it('patrol objectives stay repeatable: a destroyed patrol is back on the next entry', () => {
    const sys = 'milky-way/alpha-centauri';
    const L = layoutOf(graph, sys)!;
    const pr = L.patrols[0]!;
    const run = createSectorRun(L, { done: [], surveyed: false }, { seed: 3 });
    const ev = flyTo(run, pr.points[0]!, () => run.hostiles.some((h) => h.source === pr.id), { fight: 700 });
    const live = () => run.hostiles.filter((h) => h.source === pr.id && h.state !== 'destroyed');
    for (let i = 0; i < 30 && live().length; i++) {
      ev.push(...flyTo(run, live()[0]!, () => !live().length, { fight: 900, maxTicks: 600 }));
      ev.push(...fightAll(run, () => !live().length));
    }
    const kills = eventsOf(ev, 'destroyed').filter((d) => d.source === pr.id).length;
    expect(kills).toBeGreaterThan(0);
    const again = createSectorRun(L, { done: [], surveyed: false }, { seed: 4 });
    flyTo(again, pr.points[0]!, () => again.hostiles.some((h) => h.source === pr.id), { maxTicks: 60 * 60 });
    expect(again.hostiles.filter((h) => h.source === pr.id).length).toBe(pr.ships);
  });
});

describe('contract boards point only at reachable systems', () => {
  it('every Milky Way station board (after first light) offers routable, enterable targets', () => {
    let p = applySurvey(graph, progressFromSaved(graph, EMPTY_PROFILE)).progress;
    const stations = cat.systems.filter((s) => s.galaxyId === MW && s.sector.station);
    expect(stations.length).toBeGreaterThan(2);
    let checked = 0;
    let bounties = 0;
    for (const st of stations) {
      const r = applySystemTravel(graph, p, st.id);
      if (!r.ok) continue; // a station behind a closed lane: its board is not visible yet
      p = r.progress;
      const world = buildMissionWorld(graph, p, {});
      const board = stationBoard(EMPTY_MISSIONS, st.id, world);
      for (const o of board.offers) {
        const sys = targetSystem(o.spec.target);
        if (!sys) continue;
        expect(world.enterable(sys), `${o.id} -> ${sys}`).toBe(true);
        if (o.spec.type === 'destroy-patrol') {
          // never more kills than the patrols there fly
          expect(o.spec.count, `${o.id} count`).toBeLessThanOrEqual(patrolShips(world, sys));
          bounties++;
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(bounties, 'at least one patrol bounty checked').toBeGreaterThan(0);
  });
});
