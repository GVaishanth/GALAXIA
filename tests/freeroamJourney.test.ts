/**
 * Free Roam Prompt 14: the complete early-game journey as one integration test.
 *
 * A test pilot plays a fresh save with ordinary flight input (move, aim, fire;
 * no teleporting), and a small "shell" applies every result with the same
 * functions freeRoamMode.ts calls (applyCollection, recordSurvey, applySurvey,
 * sectorGameEvents -> consumeEvent, claimReward, applySystemTravel + burnCells,
 * quoteShip, quoteUpgrade, saveSlot / loadSlot + auditProfile). The DOM shell
 * itself is covered by the browser suite freeroam-p14.mjs.
 *
 * Steps (Prompt 14 §2): 1 start with the starter ship, 2 enter a sector,
 * 3 move / explore / interact, 4 collect salvage, 5 defeat an enemy,
 * 6 a reward exactly once, 7 complete a mission, 8 save and reload,
 * 9 travel to another system, 10 unlock a galaxy destination, 11 acquire
 * another ship and an upgrade, 12 Classic still works.
 */
import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { applySurvey, checkTravel, deriveView, progressFromSaved, type ExplorationProgress } from '../src/modes/freeroam/galaxy/progress.ts';
import { applySystemTravel } from '../src/modes/freeroam/galaxy/systems.ts';
import { applyCollection, type CollectionEvent } from '../src/modes/freeroam/inventory/persistence.ts';
import { EMPTY_PROFILE, recordSurvey, withCargo, withFleet, withNavigation, withProgression, withSectorProgress, type FreeRoamProfile } from '../src/modes/freeroam/profile.ts';
import { quoteSell, commitQuote, type Wallet } from '../src/modes/freeroam/progression/economy.ts';
import type { GameEvent } from '../src/modes/freeroam/progression/events.ts';
import { burnCells, cellsHeld, FUEL, routeCells } from '../src/modes/freeroam/progression/fuel.ts';
import { sectorGameEvents } from '../src/modes/freeroam/progression/fromSector.ts';
import { STORY_BY_ID } from '../src/modes/freeroam/progression/missionData.ts';
import { buildMissionWorld } from '../src/modes/freeroam/progression/missionWorld.ts';
import { acceptMission, consumeEvent } from '../src/modes/freeroam/progression/missions.ts';
import { progressionFromSaved, progressionToSaved, type ProgressionState } from '../src/modes/freeroam/progression/persistence.ts';
import { claimReward, grantCells, quoteShip, quoteUpgrade, rewardChartTargets } from '../src/modes/freeroam/progression/station.ts';
import { auditProfile } from '../src/modes/freeroam/saveAudit.ts';
import { loadSlot, saveSlot } from '../src/modes/freeroam/saveSlots.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import type { Poi, SectorLayout, SectorSave } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, disposeSectorRun, interact, isDone, resumeSector, type SectorEvent, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { fleetFromSaved, fleetToSaved, loadoutOf, type FleetState } from '../src/modes/freeroam/ships/hangar.ts';
import { STARTER_SHIP } from '../src/modes/freeroam/ships/roster.ts';
import { cleanLevels, upgradedShip } from '../src/modes/freeroam/ships/upgrades.ts';
import type { DerivedShip, ShipId } from '../src/modes/freeroam/ships/types.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import { SAVE_KEY } from '../src/persistence/saveData.ts';
import { NO_INPUT } from '../src/core/game/input.ts';
import { FIRE, makeEngine, run as runClassic, startPlaying } from './helpers/engine.ts';
import { dist, eventsOf, fightAll, flyTo } from './helpers/frPilot.ts';

const graph = buildNavGraph();
const SYSTEMS = getCatalogue().systems;
const layoutOf = (id: string): SectorLayout => generateSector(SYSTEMS.find((s) => s.id === id)!, sectorContext(graph, id));
const SOL = 'milky-way/sol';
const ALPHA = 'milky-way/alpha-centauri';

/** The mode's bookkeeping, reduced to the same function calls (no DOM, no audio, no notices). */
class Shell {
  readonly store = new MemoryStore();
  profile: FreeRoamProfile;
  progress: ExplorationProgress;
  prog: ProgressionState;
  fleet: FleetState;
  craft: DerivedShip;
  run: SectorRun | null = null;
  readonly log: GameEvent[] = [];

  constructor() {
    this.profile = EMPTY_PROFILE;
    this.progress = progressFromSaved(graph, EMPTY_PROFILE);
    this.prog = progressionFromSaved(EMPTY_PROFILE.progression);
    this.fleet = fleetFromSaved(EMPTY_PROFILE.fleet);
    this.craft = this.derive();
    this.load();
  }
  private derive(): DerivedShip {
    return upgradedShip(this.fleet.active, loadoutOf(this.fleet, this.fleet.active), cleanLevels(this.fleet.active, this.prog.upgrades[this.fleet.active]));
  }
  /** freeRoamMode init: load slot 1, audit, starter cells once. */
  load(): void {
    const r = loadSlot(this.store, 1);
    const audit = auditProfile(graph, r.data);
    expect(audit.issues).toEqual([]);
    this.progress = progressFromSaved(graph, audit.profile);
    this.profile = withNavigation(audit.profile, this.progress);
    this.prog = progressionFromSaved(this.profile.progression);
    this.fleet = fleetFromSaved(this.profile.fleet);
    this.craft = this.derive();
    if (!this.prog.fuel.starter) {
      this.profile = withCargo(this.profile, grantCells(this.profile.cargo, this.craft.stats.cargo, FUEL.starterCells).hold);
      this.prog = { ...this.prog, fuel: { ...this.prog.fuel, starter: true } };
      this.syncProg();
    }
  }
  syncProg(): void {
    this.profile = withProgression(this.profile, progressionToSaved(this.prog));
  }
  save(): boolean {
    this.syncProg();
    this.profile = withNavigation(this.profile, this.progress);
    return saveSlot(this.store, 1, this.profile);
  }
  wallet(): Wallet {
    return { marks: this.prog.marks, hold: this.profile.cargo, holdCap: this.craft.stats.cargo, modules: this.profile.modules };
  }
  commitWallet(w: Wallet): void {
    this.prog = { ...this.prog, marks: w.marks };
    this.profile = withCargo(this.profile, w.hold);
    this.syncProg();
  }
  publish(events: readonly GameEvent[]): void {
    for (const e of events) {
      this.log.push(e);
      this.prog = { ...this.prog, missions: consumeEvent(this.prog.missions, e).state };
    }
    this.syncProg();
  }
  enter(systemId: string, seed = 1): SectorRun {
    const save: SectorSave = { ...(this.profile.sectors[systemId] ?? { done: [] }), surveyed: this.progress.charted.includes(systemId) };
    const r = createSectorRun(layoutOf(systemId), save, { seed, ship: this.craft });
    r.cargoSpace = Math.max(0, this.craft.stats.cargo - Object.values(this.profile.cargo).reduce((a, b) => a + b, 0));
    this.run = r;
    return r;
  }
  /** handleEvents: collections into the profile, the survey into navigation, then typed game events. */
  handle(events: readonly SectorEvent[]): void {
    const r = this.run!;
    const sys = r.layout.systemId;
    const kindOf = (id: string) => r.layout.pois.find((p) => p.id === id)?.kind;
    for (const e of events) {
      const before = this.profile;
      if (e.type === 'collected' || e.type === 'looted' || e.type === 'picked' || e.type === 'recovered' || e.type === 'encounter') this.profile = applyCollection(this.profile, sys, e as CollectionEvent);
      else if (e.type === 'recorded') this.profile = withSectorProgress(this.profile, sys, [e.id]);
      if (e.type === 'surveyComplete') {
        this.profile = withSectorProgress(recordSurvey(this.profile, e.ticks).profile, sys, [], true);
        const survey = applySurvey(graph, this.progress);
        this.progress = survey.progress;
        if (survey.chartedSystem) this.publish([{ type: 'system-charted', systemId: survey.chartedSystem.id, galaxyId: survey.galaxy }]);
        this.lastSurvey = survey;
      }
      const gained = Object.entries(this.profile.cargo).filter(([k, n]) => n > (before.cargo[k] ?? 0)).map(([k, n]) => ({ resource: k, amount: n - (before.cargo[k] ?? 0) }));
      this.publish(sectorGameEvents(e, { systemId: sys, kindOf, applied: this.profile.cargo !== before.cargo || this.profile.sectors !== before.sectors, gained: gained as never }));
    }
    r.cargoSpace = Math.max(0, this.craft.stats.cargo - Object.values(this.profile.cargo).reduce((a, b) => a + b, 0));
  }
  lastSurvey: ReturnType<typeof applySurvey> | null = null;
  accept(id: string): void {
    const res = acceptMission(this.prog.missions, STORY_BY_ID.get(id), buildMissionWorld(graph, this.progress, this.profile.sectors), { visitedGalaxies: this.progress.visited, charted: this.progress.charted.length });
    expect(res.ok, `accept ${id}`).toBe(true);
    if (res.ok) this.prog = { ...this.prog, missions: res.state };
    this.syncProg();
  }
  claim(id: string): ReturnType<typeof claimReward> {
    const res = claimReward(this.prog, id, this.wallet(), (galaxy, n) => rewardChartTargets(graph, this.progress, galaxy, n));
    if (res.ok) {
      this.prog = res.progression;
      const fresh = res.charted.filter((c) => !this.progress.charted.includes(c));
      if (fresh.length) this.progress = { ...this.progress, charted: [...this.progress.charted, ...fresh] };
      this.commitWallet(res.wallet);
    }
    return res;
  }
  /** systemTravel: plan, burn the route's cells, commit, publish arrivals. */
  travel(to: string): { cells: number } {
    const before = this.progress;
    const r = applySystemTravel(graph, this.progress, to);
    expect(r.ok, `travel to ${to}`).toBe(true);
    if (!r.ok) return { cells: 0 };
    const need = routeCells(r.plan.lanes, this.craft.stats.travel);
    const next = burnCells(this.profile.cargo, need);
    expect(next, 'enough reactor cells').not.toBeNull();
    this.profile = withCargo(this.profile, next!);
    this.progress = r.progress;
    this.publish([{ type: 'jumped', hops: r.plan.jumps }, ...r.plan.path.slice(1).map((id) => ({ type: 'system-visited' as const, systemId: id, galaxyId: 'milky-way', first: !before.visitedSystems.includes(id) }))]);
    return { cells: need };
  }
  setFleet(f: FleetState): void {
    this.fleet = f;
    this.craft = this.derive();
    this.profile = withFleet(this.profile, fleetToSaved(f));
  }
}

const poisOf = (L: SectorLayout, kind: Poi['kind']): Poi[] => L.pois.filter((p) => p.kind === kind);
const nearestUndone = (r: SectorRun, kind: Poi['kind']): Poi | undefined => poisOf(r.layout, kind).filter((p) => !isDone(r, p)).sort((a, b) => dist(r.ship, a) - dist(r.ship, b))[0];
const units = (h: Readonly<Record<string, number>>): number => Object.values(h).reduce((a, b) => a + b, 0);

describe('Free Roam journey (Prompt 14 §2): one fresh save through the early game', () => {
  it('plays steps 1-12 in order with real flight input and the shell\'s own bookkeeping', () => {
    const shell = new Shell();
    const classicBefore = '{"version":1,"highScore":4200,"bestStage":3}';
    shell.store.write(SAVE_KEY, classicBefore);

    /* 1. start with the starter ship */
    expect(shell.fleet.active).toBe(STARTER_SHIP);
    expect(shell.fleet.owned).toEqual([STARTER_SHIP]);
    expect(shell.progress.system).toBe(SOL);
    expect(cellsHeld(shell.profile.cargo)).toBe(FUEL.starterCells);

    /* 2. enter a local sector (Sol) and dock to take the first story mission */
    let r = shell.enter(SOL);
    resumeSector(r); // START FLIGHT
    expect(r.phase).toBe('flight');
    const station = poisOf(r.layout, 'station')[0]!;
    shell.handle(flyTo(r, station, () => r.focus === station.id));
    shell.handle(interact(r));
    expect(r.docked).toBe('station');
    shell.accept('story-first-light');
    r.docked = null;

    /* 3. move, explore and interact with an object (a derelict) */
    const start = { x: r.ship.x, y: r.ship.y };
    const wreck = nearestUndone(r, 'derelict')!;
    shell.handle(flyTo(r, wreck, () => r.focus === wreck.id));
    expect(dist(r.ship, start)).toBeGreaterThan(200);
    const looted = interact(r);
    shell.handle(looted);
    expect(eventsOf(looted, 'looted')).toHaveLength(1);
    expect(shell.profile.sectors[SOL]!.done).toContain(wreck.id);
    expect(interact(r)).toEqual([]); // a second inspection gives nothing

    /* 4. collect salvage (fly through four pieces: the next story step needs them) */
    const holdBefore = units(shell.profile.cargo);
    let salvaged = 0;
    for (let i = 0; i < 4; i++) {
      const node = nearestUndone(r, 'salvage')!;
      const ev = flyTo(r, node, (e) => e.some((x) => (x.type === 'collected' || x.type === 'holdFull') && x.id === node.id));
      shell.handle(ev);
      salvaged += eventsOf(ev, 'collected').length;
    }
    expect(salvaged).toBeGreaterThanOrEqual(4);
    expect(units(shell.profile.cargo)).toBeGreaterThan(holdBefore);

    /* 7. complete a mission: record every survey mark -> Sol charted -> First Light complete */
    for (let guard = 0; guard < 10 && r.phase === 'flight'; guard++) {
      const mark = nearestUndone(r, 'survey');
      if (!mark) break;
      shell.handle(flyTo(r, mark, (ev) => ev.some((e) => e.type === 'recorded' || e.type === 'surveyComplete')));
    }
    expect(r.phase).toBe('complete');
    expect(shell.progress.charted).toContain(SOL);
    expect(shell.prog.missions.completed).toContain('story-first-light');

    /* 10. a galaxy destination unlocks: the first survey opens the SMC (milestone first-survey) */
    expect(shell.lastSurvey!.newGalaxies).toContain('smc');
    expect(deriveView(graph, progressFromSaved(graph, EMPTY_PROFILE)).galaxyUnlocked('smc')).toBe(false);
    expect(deriveView(graph, shell.progress).galaxyUnlocked('smc')).toBe(true);
    expect(checkTravel(deriveView(graph, shell.progress), 'lmc').ok).toBe(true); // the open neighbour route

    /* 6. the reward is paid exactly once: claim, then claim again */
    resumeSector(r);
    shell.handle(flyTo(r, station, () => r.focus === station.id));
    shell.handle(interact(r));
    const marks0 = shell.prog.marks;
    const fuel0 = cellsHeld(shell.profile.cargo);
    const first = shell.claim('story-first-light');
    expect(first.ok).toBe(true);
    expect(shell.prog.marks).toBe(marks0 + 60);
    expect(cellsHeld(shell.profile.cargo)).toBe(fuel0 + 4);
    const again = shell.claim('story-first-light');
    expect(again.ok).toBe(false);
    expect(shell.prog.marks).toBe(marks0 + 60);
    // and a completed object never pays twice: re-entering Sol, the derelict and salvage stay done
    const cargoAfterClaim = { ...shell.profile.cargo };
    // Scrap and Signal already counted? It starts counting only once accepted: take it now, collect 4 more later
    shell.accept('story-scrap-and-signal');
    r.docked = null;
    disposeSectorRun(r);
    r = shell.enter(SOL, 2);
    resumeSector(r);
    expect(isDone(r, wreck)).toBe(true);
    expect(interact(r)).toEqual([]);
    expect(shell.profile.cargo).toEqual(cargoAfterClaim);

    /* 8. save and reload: every piece of progress survives, nothing is corrected */
    expect(shell.save()).toBe(true);
    const reloaded = new Shell();
    (reloaded as { store: MemoryStore }).store.write('galaxia:freeroam', shell.store.read('galaxia:freeroam')!);
    reloaded.load();
    expect(reloaded.progress.charted).toEqual(shell.progress.charted);
    expect(reloaded.prog.missions.claimed).toContain('story-first-light');
    expect(reloaded.prog.missions.active.map((a) => a.id)).toContain('story-scrap-and-signal');
    expect(reloaded.prog.marks).toBe(shell.prog.marks);
    expect(reloaded.profile.cargo).toEqual(shell.profile.cargo);
    expect(reloaded.profile.sectors[SOL]).toEqual(shell.profile.sectors[SOL]);
    expect(reloaded.claim('story-first-light').ok).toBe(false); // still exactly once after a reload
    disposeSectorRun(r);

    /* 9. travel to another system: the route burns reactor cells */
    const cellsBefore = cellsHeld(shell.profile.cargo);
    const trip = shell.travel(ALPHA);
    expect(trip.cells).toBeGreaterThan(0);
    expect(cellsHeld(shell.profile.cargo)).toBe(cellsBefore - trip.cells);
    expect(shell.progress.system).toBe(ALPHA);
    expect(shell.progress.visitedSystems).toContain(ALPHA);

    /* 5. defeat an enemy: fly to Alpha Centauri's patrol and shoot it down with aim + fire */
    r = shell.enter(ALPHA, 3);
    resumeSector(r);
    r.grace = 0;
    const patrol = r.layout.patrols[0]!;
    const ev5 = flyTo(r, patrol.points[0]!, (e) => e.some((x) => x.type === 'destroyed'), { fight: 700, maxTicks: 60 * 90 });
    ev5.push(...fightAll(r, () => false, 900, 60 * 60));
    shell.handle(ev5);
    const kills = eventsOf(ev5, 'destroyed').filter((e) => e.by === 'player');
    expect(kills.length).toBeGreaterThan(0);
    expect(eventsOf(ev5, 'recalled')).toHaveLength(0); // the starter wins a tier-1 patrol fight
    expect(shell.log.some((e) => e.type === 'hostile-destroyed')).toBe(true);

    // Scrap and Signal: four salvage pieces here complete it
    for (let i = 0; i < 6 && !shell.prog.missions.completed.includes('story-scrap-and-signal'); i++) {
      const node = nearestUndone(r, 'salvage');
      if (!node) break;
      shell.handle(flyTo(r, node, (e) => e.some((x) => (x.type === 'collected' || x.type === 'holdFull') && x.id === node.id), { fight: 500 }));
    }
    expect(shell.prog.missions.completed).toContain('story-scrap-and-signal');

    /* 11. acquire another ship and an upgrade (at Alpha Centauri's station) */
    const st2 = poisOf(r.layout, 'station')[0]!;
    shell.handle(flyTo(r, st2, () => r.focus === st2.id, { fight: 500 }));
    shell.handle(interact(r));
    expect(r.docked).toBe('station');
    expect(shell.claim('story-scrap-and-signal').ok).toBe(true);
    const view = deriveView(graph, shell.progress);
    const licenceMet = (q: Parameters<typeof view.requirementMet>[0]) => view.requirementMet(q);
    // sell scrap only if a ship's price needs nothing more; take the cheapest first-tier ship the hold can pay
    const affordable = () => (['swift', 'magpie'] as ShipId[]).map((id) => ({ id, q: quoteShip(shell.wallet(), shell.fleet, id, licenceMet) })).find((x) => x.q.quote.ok);
    // not yet? keep exploring this sector (salvage, caches, wrecks) like a player would; count the extra finds
    let extraFinds = 0;
    r.docked = null;
    for (let i = 0; i < 20 && !affordable(); i++) {
      const p = (['salvage', 'cache', 'derelict'] as const).flatMap((k) => poisOf(r.layout, k)).filter((q) => !isDone(r, q)).sort((a, b) => dist(r.ship, a) - dist(r.ship, b))[0];
      if (!p) break;
      const ev = flyTo(r, p, (e) => e.some((x) => (x.type === 'collected' || x.type === 'holdFull') && x.id === p.id) || r.focus === p.id, { fight: 500 });
      if (r.focus === p.id) ev.push(...interact(r));
      shell.handle(ev);
      extraFinds++;
    }
    shell.handle(flyTo(r, st2, () => r.focus === st2.id, { fight: 500 }));
    shell.handle(interact(r));
    expect(extraFinds, 'finds needed beyond the story steps for a first ship').toBeLessThanOrEqual(12);
    const pick = affordable();
    expect(pick, `a first-tier ship is affordable with ${JSON.stringify(shell.profile.cargo)}`).toBeDefined();
    shell.commitWallet(commitQuote(pick!.q.quote)!);
    shell.setFleet(pick!.q.fleet!);
    expect(shell.fleet.owned).toContain(pick!.id);
    expect(shell.fleet.active).toBe(STARTER_SHIP); // owned, not switched
    // an upgrade for the flown ship: sell a little salvage if marks are short
    let uq = quoteUpgrade(shell.wallet(), STARTER_SHIP, loadoutOf(shell.fleet, STARTER_SHIP), {}, 'hull', shell.prog.licences);
    if (!uq.quote.ok) {
      const sale = quoteSell(shell.wallet(), ALPHA, 'scrap', Math.min(10, shell.profile.cargo['scrap'] ?? 0));
      if (sale.ok) shell.commitWallet(sale.result);
      uq = quoteUpgrade(shell.wallet(), STARTER_SHIP, loadoutOf(shell.fleet, STARTER_SHIP), {}, 'hull', shell.prog.licences);
    }
    expect(uq.quote.ok, uq.quote.ok ? '' : uq.quote.reason).toBe(true);
    const hull0 = shell.craft.stats.hull;
    shell.commitWallet(commitQuote(uq.quote)!);
    shell.prog = { ...shell.prog, upgrades: { ...shell.prog.upgrades, [STARTER_SHIP]: uq.levels! } };
    shell.setFleet(shell.fleet);
    expect(shell.craft.stats.hull).toBeGreaterThan(hull0);
    expect(shell.save()).toBe(true);
    const back = new Shell();
    back.store.write('galaxia:freeroam', shell.store.read('galaxia:freeroam')!);
    back.load();
    expect(back.fleet.owned).toContain(pick!.id);
    expect(back.craft.stats.hull).toBe(shell.craft.stats.hull);
    disposeSectorRun(r);

    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (env?.['FR_METRICS']) console.log(`JOURNEY ${JSON.stringify({ extraFinds, ship: pick!.id, marks: shell.prog.marks, cells: cellsHeld(shell.profile.cargo), hold: shell.profile.cargo, kills: kills.length, trip: trip.cells, completed: shell.prog.missions.completed })}`);

    /* 12. Classic still works, and its save was never touched by any Free Roam operation */
    expect(shell.store.read(SAVE_KEY)).toBe(classicBefore);
    const h = makeEngine();
    startPlaying(h);
    runClassic(h.engine, 60 * 5, (t) => (t % 20 < 2 ? FIRE : NO_INPUT));
    expect(['playing', 'challenge', 'stageCleared', 'playerHit']).toContain(h.engine.phase);
    expect(h.engine.world.stage).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
