/**
 * Free Roam Prompt 11: missions, discovery and progression.
 *
 * Mission prerequisites, objective progress from typed gameplay events,
 * completion, reward uniqueness, failure, station contracts (capped),
 * resource transactions, upgrade compatibility and caps, reactor cells and
 * recovery (never stranded), route unlocks through the story, the
 * exploration log (fact vs fiction) and saved progression.
 * Deterministic: no DOM, no network, no wall clock.
 */
import { describe, expect, it } from 'vitest';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { applySurvey, deriveView, progressDiff, progressFromSaved, type ExplorationProgress } from '../src/modes/freeroam/galaxy/progress.ts';
import { deriveSystemView } from '../src/modes/freeroam/galaxy/systems.ts';
import { EMPTY_PROFILE, EMPTY_PROGRESSION, loadProfile, saveProfile, withProgression } from '../src/modes/freeroam/profile.ts';
import { createEventBus, type GameEvent } from '../src/modes/freeroam/progression/events.ts';
import { sectorGameEvents } from '../src/modes/freeroam/progression/fromSector.ts';
import { abandonMission, acceptMission, availableStory, consumeEvent, markClaimed, MAX_ACTIVE, missionStatus, readyMissions, resolveTarget, type MissionWorld, type PrereqContext, type WorldSite } from '../src/modes/freeroam/progression/missions.ts';
import { STORY, STORY_BY_ID } from '../src/modes/freeroam/progression/missionData.ts';
import { EMPTY_MISSIONS, MISSION_TYPES, type ContractSpec, type MissionState } from '../src/modes/freeroam/progression/missionTypes.ts';
import { BOARD, CONTRACT_ID, contractDef, patrolShips, stationBoard, TEMPLATE_ORDER } from '../src/modes/freeroam/progression/contracts.ts';
import { TARGET_DONE, type ObjectiveDef } from '../src/modes/freeroam/progression/missionTypes.ts';
import { buildMissionWorld } from '../src/modes/freeroam/progression/missionWorld.ts';
import { ECONOMY, MODULE_PRICES, moduleFits, moduleStock, quoteBuyCells, quoteBuyModule, quoteSell, repairLine, sellPrice, type Wallet } from '../src/modes/freeroam/progression/economy.ts';
import { burnCells, emergencyCells, emergencyJumpTarget, FUEL, galaxyJumpCells, homeJumpDue, hopCells, routeCells } from '../src/modes/freeroam/progression/fuel.ts';
import { discoveryEntries, EMPTY_LOG, explorationStats, recordEvent } from '../src/modes/freeroam/progression/discovery.ts';
import { progressionFromSaved, progressionToSaved, type ProgressionState } from '../src/modes/freeroam/progression/persistence.ts';
import { formatMarks } from '../src/modes/freeroam/progression/ledger.ts';
import { claimReward, deliver, grantCells, quoteShip, quoteUpgrade, rewardChartTargets } from '../src/modes/freeroam/progression/station.ts';
import { missionsModel, missionTargets, trackedObjective } from '../src/modes/freeroam/progression/view.ts';
import { deriveShip, STAT_BOUNDS } from '../src/modes/freeroam/ships/equipment.ts';
import { STARTER_FLEET } from '../src/modes/freeroam/ships/hangar.ts';
import { SHIP_BY_ID, SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import { checkUpgrade, cleanLevels, installUpgrade, maxLevel, UPGRADE_BY_TRACK, UPGRADE_TRACKS, UPGRADES, upgradedShip, upgradeIssues, type UpgradeLevels } from '../src/modes/freeroam/ships/upgrades.ts';
import type { StatKey } from '../src/modes/freeroam/ships/types.ts';

const graph = buildNavGraph();
const MW = 'milky-way';
const SOL = `${MW}/sol`;
const ALPHA = `${MW}/alpha-centauri`;
const fresh = (): ExplorationProgress => progressFromSaved(graph, EMPTY_PROFILE);
const ctxOf = (p: ExplorationProgress): PrereqContext => ({ visitedGalaxies: p.visited, charted: p.charted.length });
const emptyProg = (): ProgressionState => progressionFromSaved(EMPTY_PROGRESSION);
const W = (over: Partial<Wallet> = {}): Wallet => ({ marks: 0, hold: {}, holdCap: 30, modules: {}, ...over });
const feed = (s: MissionState, events: readonly GameEvent[]): MissionState => events.reduce((acc, e) => consumeEvent(acc, e).state, s);
const charted = (systemId: string, galaxyId = MW): GameEvent => ({ type: 'system-charted', systemId, galaxyId });
const poi = (systemId: string, poiId: string, kind: 'salvage' | 'derelict' | 'anomaly' | 'cache'): GameEvent => ({ type: 'poi-completed', systemId, poiId, kind });

let worldMemo: MissionWorld | null = null;
const world = (): MissionWorld => (worldMemo ??= buildMissionWorld(graph, fresh(), {}));

/** Accept a story mission and complete it through events (prerequisites must already be met). */
function completeStory(s: MissionState, id: string, ctx: PrereqContext, events: readonly GameEvent[]): MissionState {
  const r = acceptMission(s, STORY_BY_ID.get(id), world(), ctx);
  expect(r.ok, id).toBe(true);
  if (!r.ok) return s;
  const done = feed(r.state, events);
  expect(done.completed, id).toContain(id);
  return done;
}

describe('mission data (Prompt 11)', () => {
  it('has unique stable ids, valid prerequisites, objectives and rewards', () => {
    const ids = STORY.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of STORY) {
      expect(d.id).toMatch(/^story-[a-z0-9-]+$/);
      expect(d.objectives.length).toBeGreaterThan(0);
      for (const o of d.objectives) expect(o.count).toBeGreaterThan(0);
      for (const p of d.prerequisites) if (p.kind === 'mission') expect(STORY_BY_ID.has(p.id), `${d.id} -> ${p.id}`).toBe(true);
      expect(d.rewards.marks).toBeGreaterThanOrEqual(0);
      for (const r of d.rewards.resources) expect(r.amount).toBeGreaterThan(0);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
    }
    // the chain has exactly one entry point
    expect(STORY.filter((d) => d.prerequisites.length === 0).map((d) => d.id)).toEqual(['story-first-light']);
  });

  it('covers every requested mission type (story or contract templates)', () => {
    const covered = new Set<string>([...STORY.map((d) => d.type), ...TEMPLATE_ORDER]);
    for (const t of ['discover-system', 'investigate-anomaly', 'recover-salvage', 'destroy-patrol', 'clear-outpost', 'deliver-resources', 'investigate-derelict', 'locate-rare', 'survey-region']) {
      expect(MISSION_TYPES as readonly string[]).toContain(t);
      expect(covered.has(t), t).toBe(true);
    }
  });
});

describe('prerequisites, progress and completion', () => {
  it('locks later story missions until the one before is completed', () => {
    const p = fresh();
    const ctx = ctxOf(p);
    expect(availableStory(EMPTY_MISSIONS, ctx).map((d) => d.id)).toEqual(['story-first-light']);
    const scrap = STORY_BY_ID.get('story-scrap-and-signal')!;
    expect(missionStatus(EMPTY_MISSIONS, scrap, ctx)).toBe('locked');
    expect(acceptMission(EMPTY_MISSIONS, scrap, world(), ctx)).toEqual({ ok: false, reason: 'prerequisites' });
    expect(acceptMission(EMPTY_MISSIONS, undefined, world(), ctx)).toEqual({ ok: false, reason: 'unknown' });
    const s = completeStory(EMPTY_MISSIONS, 'story-first-light', ctx, [charted(SOL)]);
    expect(missionStatus(s, scrap, ctx)).toBe('available');
  });

  it('counts only matching events in scope, never past the objective, and completes once', () => {
    const ctx = ctxOf(fresh());
    let s = completeStory(EMPTY_MISSIONS, 'story-first-light', ctx, [charted(SOL)]);
    const acc = acceptMission(s, STORY_BY_ID.get('story-scrap-and-signal'), world(), ctx);
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    s = acc.state;
    // wrong kind, another galaxy: nothing
    s = feed(s, [poi(SOL, 'cache-1', 'cache'), poi('andromeda/x', 'salvage-1.1', 'salvage'), { type: 'jumped', hops: 1 }]);
    expect(s.active.find((m) => m.id === 'story-scrap-and-signal')!.progress).toEqual([0]);
    const step = consumeEvent(s, poi(SOL, 'salvage-1.1', 'salvage'));
    expect(step.updates).toEqual([{ kind: 'progress', id: 'story-scrap-and-signal', title: expect.any(String), objective: 0, value: 1, count: 4 }]);
    s = feed(step.state, [poi(SOL, 'salvage-1.2', 'salvage'), poi(SOL, 'salvage-1.3', 'salvage')]);
    const last = consumeEvent(s, poi(ALPHA, 'salvage-2.1', 'salvage'));
    expect(last.updates.map((u) => u.kind)).toEqual(['progress', 'completed']);
    s = last.state;
    expect(s.completed.filter((id) => id === 'story-scrap-and-signal')).toHaveLength(1);
    expect(s.active.some((m) => m.id === 'story-scrap-and-signal')).toBe(false);
    // more events after completion change nothing: no second completion
    const again = consumeEvent(s, poi(ALPHA, 'salvage-2.2', 'salvage'));
    expect(again.updates).toEqual([]);
    expect(again.state.completed).toEqual(s.completed);
    // a completed mission cannot be accepted again
    expect(acceptMission(s, STORY_BY_ID.get('story-scrap-and-signal'), world(), ctx)).toEqual({ ok: false, reason: 'completed' });
  });

  it('resolves "nearest" targets and only the targeted site counts', () => {
    const ctx = ctxOf(fresh());
    let s = completeStory(EMPTY_MISSIONS, 'story-first-light', ctx, [charted(SOL)]);
    s = completeStory(s, 'story-scrap-and-signal', ctx, [1, 2, 3, 4].map((i) => poi(SOL, `salvage-1.${i}`, 'salvage')));
    const acc = acceptMission(s, STORY_BY_ID.get('story-silent-hull'), world(), ctx);
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    const target = acc.mission.targets[0]!;
    expect(target).toMatch(/^milky-way\/[a-z0-9-]+#derelict-\d+$/);
    const [sys, local] = target.split('#') as [string, string];
    expect(missionTargets(acc.state).get(sys)).toEqual([STORY_BY_ID.get('story-silent-hull')!.title]);
    // another derelict (or the same id elsewhere) does not count
    let t = feed(acc.state, [poi(sys, 'derelict-99', 'derelict'), poi(sys === SOL ? ALPHA : SOL, local, 'derelict')]);
    expect(t.completed).not.toContain('story-silent-hull');
    t = feed(t, [poi(sys, local, 'derelict')]);
    expect(t.completed).toContain('story-silent-hull');
  });

  it('caps active missions, lets story missions be abandoned and taken again', () => {
    const ctx = ctxOf(fresh());
    const acc = acceptMission(EMPTY_MISSIONS, STORY_BY_ID.get('story-first-light'), world(), ctx);
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    expect(acceptMission(acc.state, STORY_BY_ID.get('story-first-light'), world(), ctx)).toEqual({ ok: false, reason: 'active' });
    const ab = abandonMission(acc.state, 'story-first-light');
    expect(ab.update).toMatchObject({ kind: 'failed', why: 'abandoned' });
    expect(missionStatus(ab.state, STORY_BY_ID.get('story-first-light')!, ctx)).toBe('available');
    // limit: MAX_ACTIVE contracts, then refusal
    let s: MissionState = EMPTY_MISSIONS;
    for (let i = 0; i < MAX_ACTIVE; i++) {
      const spec: ContractSpec = { type: 'discover-system', station: SOL, target: ALPHA, count: 1, resource: '', marks: 40, deadline: 0, difficulty: 1 };
      const id = `c:${MW}/sol:${Math.floor(i / 3)}:${i % 3}`;
      const r = acceptMission(s, contractDef(id, spec), world(), ctx, spec);
      expect(r.ok, id).toBe(true);
      if (r.ok) s = r.state;
    }
    expect(acceptMission(s, STORY_BY_ID.get('story-first-light'), world(), ctx)).toEqual({ ok: false, reason: 'limit' });
  });

  it('fails a contract past its deadline and never offers it again', () => {
    const ctx = ctxOf(fresh());
    const id = `c:${MW}/sol:0:0`;
    expect(id).toMatch(CONTRACT_ID);
    const spec: ContractSpec = { type: 'discover-system', station: SOL, target: ALPHA, count: 1, resource: '', marks: 40, deadline: 3, difficulty: 1 };
    const acc = acceptMission(EMPTY_MISSIONS, contractDef(id, spec), world(), ctx, spec);
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    let s = feed(acc.state, [{ type: 'jumped', hops: 3 }]);
    expect(s.active).toHaveLength(1);
    const late = consumeEvent(s, { type: 'jumped', hops: 1 });
    expect(late.updates).toEqual([{ kind: 'failed', id, title: expect.any(String), why: 'deadline' }]);
    s = late.state;
    expect(s.failed).toContain(id);
    expect(acceptMission(s, contractDef(id, spec), world(), ctx, spec)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('rewards are paid once, by the game systems', () => {
  const readyState = (): ProgressionState => {
    const ctx = ctxOf(fresh());
    return { ...emptyProg(), missions: completeStory(EMPTY_MISSIONS, 'story-first-light', ctx, [charted(SOL)]) };
  };

  it('claims a reward exactly once (marks and cargo), then refuses', () => {
    const p = readyState();
    expect(readyMissions(p.missions)).toEqual(['story-first-light']);
    const def = STORY_BY_ID.get('story-first-light')!;
    const first = claimReward(p, 'story-first-light', W({ marks: p.marks }), () => []);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.wallet.marks).toBe(def.rewards.marks);
    expect(first.progression.marks).toBe(def.rewards.marks);
    for (const r of def.rewards.resources) expect(first.wallet.hold[r.resource]).toBe(r.amount);
    expect(first.progression.missions.claimed).toEqual(['story-first-light']);
    const second = claimReward(first.progression, 'story-first-light', first.wallet, () => []);
    expect(second).toMatchObject({ ok: false, reason: 'not-ready' });
    expect(markClaimed(first.progression.missions, 'story-first-light')).toBeNull();
    // never claimable before completion either
    expect(claimReward(emptyProg(), 'story-scrap-and-signal', W(), () => [])).toMatchObject({ ok: false, reason: 'not-ready' });
  });

  it('a reward that does not fit is refused without being marked paid (nothing vanishes)', () => {
    const p = readyState();
    const full = W({ hold: { scrap: 30 }, holdCap: 30 });
    const r = claimReward(p, 'story-first-light', full, () => []);
    expect(r).toMatchObject({ ok: false, reason: 'hold' });
    expect(readyMissions(p.missions)).toEqual(['story-first-light']);
    const ok = claimReward(p, 'story-first-light', W(), () => []);
    expect(ok.ok).toBe(true);
  });

  it('licences and modules arrive with the reward, charts are picked by the game', () => {
    const ctx = ctxOf(fresh());
    let s = completeStory(EMPTY_MISSIONS, 'story-first-light', ctx, [charted(SOL)]);
    s = completeStory(s, 'story-scrap-and-signal', ctx, [1, 2, 3, 4].map((i) => poi(SOL, `salvage-1.${i}`, 'salvage')));
    const acc = acceptMission(s, STORY_BY_ID.get('story-silent-hull'), world(), ctx);
    if (!acc.ok) throw new Error('accept');
    const [sys, local] = acc.mission.targets[0]!.split('#') as [string, string];
    s = feed(acc.state, [poi(sys, local, 'derelict')]);
    const p: ProgressionState = { ...emptyProg(), missions: s };
    const res = claimReward(p, 'story-silent-hull', W(), () => []);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.progression.licences).toEqual(['mk2']);
  });

  it('deliveries hand over cargo only at the named station and count toward the objective', () => {
    const spec: ContractSpec = { type: 'deliver-resources', station: SOL, target: ALPHA, count: 5, resource: 'alloy', marks: 60, deadline: 0, difficulty: 1 };
    const id = `c:${MW}/sol:0:1`;
    const acc = acceptMission(EMPTY_MISSIONS, contractDef(id, spec), world(), ctxOf(fresh()), spec);
    if (!acc.ok) throw new Error('accept');
    const p: ProgressionState = { ...emptyProg(), missions: acc.state };
    const station = ALPHA;
    expect(deliver(p, id, `${MW}/barnards-star`, { alloy: 9 })).toMatchObject({ ok: false });
    expect(deliver(p, id, station, {})).toMatchObject({ ok: false });
    const d = deliver(p, id, station, { alloy: 3, scrap: 1 });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.hold).toEqual({ scrap: 1 });
    const s1 = consumeEvent(p.missions, d.event).state;
    expect(s1.active[0]!.progress).toEqual([3]);
    const d2 = deliver({ ...p, missions: s1 }, id, station, { alloy: 9 });
    if (!d2.ok) throw new Error('deliver');
    expect(d2.amount).toBe(2); // only what is still needed
    expect(d2.hold).toEqual({ alloy: 7 });
    expect(consumeEvent(s1, d2.event).state.completed).toContain(id);
  });
});

describe('station contracts', () => {
  it('posts at most BOARD.offers deterministic contracts per cycle, capped at BOARD.cycles', () => {
    const w = world();
    const a = stationBoard(EMPTY_MISSIONS, SOL, w);
    const b = stationBoard(EMPTY_MISSIONS, SOL, w);
    expect(a).toEqual(b);
    expect(a.offers.length).toBeGreaterThan(0);
    expect(a.offers.length).toBeLessThanOrEqual(BOARD.offers);
    for (const o of a.offers) {
      expect(o.id).toMatch(CONTRACT_ID);
      expect(o.spec.marks).toBeGreaterThan(0);
      expect(o.def.source).toBe('contract');
    }
    // take everything on offer, cycle by cycle: the board runs dry (no endless grind)
    let s: MissionState = EMPTY_MISSIONS;
    const ctx = ctxOf(fresh());
    let taken = 0;
    for (let guard = 0; guard < 10; guard++) {
      const board = stationBoard(s, SOL, w);
      if (board.offers.length === 0) {
        expect(board.remaining).toBe(0);
        break;
      }
      for (const o of board.offers) {
        const r = acceptMission(s, o.def, w, ctx, o.spec);
        expect(r.ok, o.id).toBe(true);
        if (r.ok) s = { ...r.state, active: r.state.active.filter((m) => m.id !== o.id), completed: [...r.state.completed, o.id] };
        taken++;
      }
    }
    expect(taken).toBeLessThanOrEqual(BOARD.offers * BOARD.cycles);
    expect(stationBoard(s, SOL, w).offers).toEqual([]);
  });
});

/** A small hand-built world: hops from `g/st`, patrol ship counts per system (FR-TD-75). */
function patrolWorld(ships: Readonly<Record<string, number>>, hops: Readonly<Record<string, number>>): MissionWorld {
  const ids = ['g/st', ...Object.keys(hops)];
  const sites = (id: string): readonly WorldSite[] => (ships[id] ? [{ id: 'patrol-1', kind: 'patrol', done: false, ships: ships[id] }] : []);
  return {
    galaxy: 'g',
    system: 'g/st',
    systemsIn: () => ids,
    hops: (from, to) => (from === to ? 0 : (hops[to] ?? hops[from] ?? Infinity)),
    enterable: () => true,
    visited: () => true,
    charted: () => true,
    station: (id) => id === 'g/st',
    difficulty: () => 3,
    sites,
    name: (id) => id,
  };
}

describe('patrol-kill targets can be finished in one visit (FR-TD-75)', () => {
  const destroy = (count: number): ObjectiveDef => ({ kind: 'destroy', label: 'Destroy patrol ships', count, target: 'nearest', patrol: true });

  it('patrolShips sums the ships of every patrol route in a system', () => {
    const w = patrolWorld({ 'g/a': 3 }, { 'g/a': 1 });
    expect(patrolShips(w, 'g/a')).toBe(3);
    expect(patrolShips(w, 'g/st')).toBe(0);
  });

  it('a destroy objective prefers the nearest system whose patrols fly the whole count', () => {
    const w = patrolWorld({ 'g/near': 1, 'g/mid': 2, 'g/far': 4 }, { 'g/near': 1, 'g/mid': 2, 'g/far': 3 });
    expect(resolveTarget(destroy(1), 'g', w, new Set())).toBe('g/near');
    expect(resolveTarget(destroy(2), 'g', w, new Set())).toBe('g/mid');
    expect(resolveTarget(destroy(3), 'g', w, new Set())).toBe('g/far');
  });

  it('falls back to the nearest patrol when none is large enough, and to done when there is none', () => {
    const w = patrolWorld({ 'g/near': 1, 'g/far': 2 }, { 'g/near': 1, 'g/far': 2 });
    expect(resolveTarget(destroy(5), 'g', w, new Set())).toBe('g/near');
    expect(resolveTarget(destroy(1), 'g', patrolWorld({}, { 'g/a': 1 }), new Set())).toBe(TARGET_DONE);
  });

  it('Quiet Lanes resolves to a Milky Way system with at least 3 patrol ships', () => {
    const quiet = STORY_BY_ID.get('story-quiet-lanes');
    const o = quiet?.objectives.find((x) => x.kind === 'destroy');
    expect(o).toBeDefined();
    if (!o) return;
    const t = resolveTarget(o, MW, world(), new Set());
    expect(t).not.toBe(TARGET_DONE);
    expect(patrolShips(world(), t)).toBeGreaterThanOrEqual(o.count);
  });

  it('a patrol bounty never asks for more kills than its target patrols fly', () => {
    const ships: Record<string, number> = { 'g/one': 1, 'g/two': 2, 'g/big': 5 };
    const w = patrolWorld(ships, { 'g/one': 1, 'g/two': 1, 'g/big': 2 });
    let s: MissionState = EMPTY_MISSIONS;
    const ctx = ctxOf(fresh());
    const seen: string[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const board = stationBoard(s, 'g/st', w);
      if (board.offers.length === 0) break;
      for (const o of board.offers) {
        if (o.spec.type === 'destroy-patrol') {
          seen.push(o.spec.target);
          expect(o.spec.count, o.spec.target).toBe(Math.max(1, Math.min(3, ships[o.spec.target] ?? 0)));
          expect(o.spec.count).toBeLessThanOrEqual(ships[o.spec.target] ?? 0);
        }
        const r = acceptMission(s, o.def, w, ctx, o.spec);
        if (r.ok) s = { ...r.state, active: r.state.active.filter((m) => m.id !== o.id), completed: [...r.state.completed, o.id] };
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('resource exchange', () => {
  it('quotes before committing: selling pays marks and removes exactly the units sold', () => {
    const w = W({ hold: { scrap: 5, fuel: 3 } });
    const price = sellPrice('scrap', SOL);
    expect(price).toBeGreaterThan(0);
    const q = quoteSell(w, SOL, 'scrap', 2);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.result.marks).toBe(price * 2);
    expect(q.result.hold).toEqual({ scrap: 3, fuel: 3 });
    expect(q.lines.find((l) => l.label === 'Marks')).toEqual({ label: 'Marks', before: '◈ 0 MARKS', after: formatMarks(price * 2) });
    expect(w.hold).toEqual({ scrap: 5, fuel: 3 }); // the quote never mutates
    expect(quoteSell(w, SOL, 'scrap', 6).ok).toBe(false);
    expect(quoteSell(w, SOL, 'scrap', -1).ok).toBe(false);
    expect(quoteSell(w, SOL, 'scrap', 0).ok).toBe(false);
    expect(quoteSell(w, SOL, 'fuel', 1).ok).toBe(false); // cells are never sold
    expect(quoteSell(w, SOL, 'not-a-resource', 1).ok).toBe(false);
  });

  it('buys cells and compatible modules only when affordable; costs are never negative', () => {
    for (const [id, p] of Object.entries(MODULE_PRICES)) {
      expect(p.marks, id).toBeGreaterThan(0);
      for (const m of p.materials) expect(m.amount, id).toBeGreaterThan(0);
    }
    expect(ECONOMY.cellPrice).toBeGreaterThan(0);
    const cells = quoteBuyCells(W({ marks: 100 }), 5);
    expect(cells.ok && cells.result).toMatchObject({ marks: 100 - 5 * ECONOMY.cellPrice, hold: { fuel: 5 } });
    expect(quoteBuyCells(W({ marks: 1 }), 5).ok).toBe(false);
    expect(quoteBuyCells(W({ marks: 999, hold: { scrap: 30 } }), 1).ok).toBe(false);
    expect(quoteBuyCells(W({ marks: 999 }), -3).ok).toBe(false);
    for (const ship of SHIPS) for (const id of moduleStock(ship)) expect(moduleFits(ship, id), `${ship.id} ${id}`).toBe(true);
    const petrel = SHIP_BY_ID.get('petrel')!;
    const q = quoteBuyModule(W({ marks: 500 }), petrel, 'deep-array');
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.result).toMatchObject({ marks: 500 - MODULE_PRICES['deep-array']!.marks, modules: { 'deep-array': 1 } });
    expect(quoteBuyModule(W({ marks: 10 }), petrel, 'deep-array').ok).toBe(false);
    expect(quoteBuyModule(W({ marks: 999 }), petrel, 'twin-pulse').ok).toBe(false); // needs circuits
    const incompatible = SHIPS.flatMap((s) => Object.keys(MODULE_PRICES).filter((m) => !moduleFits(s, m)).map((m) => [s, m] as const));
    for (const [s, m] of incompatible) expect(quoteBuyModule(W({ marks: 9999, hold: { circuits: 9, components: 9, crystal: 9, 'nav-data': 9, alloy: 9 }, holdCap: 99 }), s, m).ok, `${s.id} ${m}`).toBe(false);
  });

  it('acquires a ship for its licence and cargo price; repairs stay free', () => {
    const allMet = (): boolean => true;
    const swift = SHIP_BY_ID.get('swift')!;
    const hold: Record<string, number> = {};
    for (const c of swift.cost) hold[c.resource] = c.amount;
    const q = quoteShip(W({ hold, holdCap: 99 }), STARTER_FLEET, 'swift', allMet);
    expect(q.quote.ok).toBe(true);
    expect(q.fleet?.owned).toContain('swift');
    expect(quoteShip(W(), STARTER_FLEET, 'swift', allMet).quote.ok).toBe(false);
    expect(quoteShip(W({ hold, holdCap: 99 }), STARTER_FLEET, 'swift', () => false).quote.ok).toBe(false);
    expect(quoteShip(W(), STARTER_FLEET, 'petrel', allMet).quote).toMatchObject({ ok: false, reason: 'Already in your fleet.' });
    const r = repairLine(40, 100, 0, 60);
    expect(r.free).toBe(true);
    expect(r.after).toBe('Hull 100/100 · Shield 60/60');
    expect(repairLine(100, 100, 60, 60).after).toBe('Nothing to repair');
  });
});

describe('upgrades: compatibility, no duplicates, controlled stacking', () => {
  it('has a valid table: 8 tracks, three increasing positive-cost levels', () => {
    expect(upgradeIssues()).toEqual([]);
    expect([...UPGRADE_TRACKS]).toEqual(['weapons', 'shields', 'hull', 'engines', 'handling', 'cargo', 'sensors', 'travel']);
    for (const u of UPGRADES) {
      expect(u.steps.map((s) => s.level)).toEqual([1, 2, 3]);
      for (let i = 0; i < 3; i++) {
        expect(u.steps[i]!.cost.marks).toBeGreaterThan(0);
        if (i > 0) expect(u.steps[i]!.cost.marks).toBeGreaterThan(u.steps[i - 1]!.cost.marks);
      }
      expect(u.steps.map((s) => s.licence)).toEqual([null, 'mk2', 'mk3']);
    }
  });

  it('installs one level at a time, needs licences, refuses incompatible frames and repeats', () => {
    const rich = { marks: 99999, hold: { scrap: 99, alloy: 99, circuits: 99, crystal: 99, components: 99, 'nav-data': 99, 'core-shard': 99, relic: 99, fuel: 99, samples: 99 } };
    let levels: UpgradeLevels = {};
    const one = installUpgrade('petrel', levels, 'hull', rich, []);
    expect(one?.levels).toEqual({ hull: 1 });
    levels = one!.levels;
    expect(checkUpgrade('petrel', levels, 'hull', rich, [])).toMatchObject({ ok: false, reason: 'licence', from: 1, to: 2 });
    levels = installUpgrade('petrel', levels, 'hull', rich, ['mk2'])!.levels;
    levels = installUpgrade('petrel', levels, 'hull', rich, ['mk2', 'mk3'])!.levels;
    expect(levels).toEqual({ hull: 3 });
    expect(checkUpgrade('petrel', levels, 'hull', rich, ['mk2', 'mk3'])).toMatchObject({ ok: false, reason: 'max' });
    expect(installUpgrade('petrel', levels, 'hull', rich, ['mk2', 'mk3'])).toBeNull();
    // the interceptor cannot take cargo work; caps hold for every ship
    expect(maxLevel('shrike', 'cargo')).toBe(0);
    expect(checkUpgrade('shrike', {}, 'cargo', rich, ['mk2', 'mk3'])).toMatchObject({ ok: false, reason: 'incompatible' });
    expect(checkUpgrade('petrel', {}, 'warp-core', rich, [])).toMatchObject({ ok: false, reason: 'unknown' });
    expect(checkUpgrade('petrel', {}, 'hull', { marks: 0, hold: {} }, [])).toMatchObject({ ok: false, reason: 'marks' });
  });

  it('levels replace each other (no stacking) and every combination stays inside the stat bounds', () => {
    for (const t of UPGRADE_TRACKS) {
      const lv3 = upgradedShip('petrel', undefined, { [t]: 3 });
      const direct = deriveShip('petrel', undefined, { mods: [UPGRADE_BY_TRACK.get(t)!.steps[2]!.mods], weapon: UPGRADE_BY_TRACK.get(t)!.steps[2]!.weapon });
      expect(lv3.stats, t).toEqual(direct.stats);
    }
    for (const ship of SHIPS) {
      const all: Record<string, number> = {};
      for (const t of UPGRADE_TRACKS) all[t] = 3;
      const clean = cleanLevels(ship.id, all);
      for (const t of UPGRADE_TRACKS) expect(clean[t] ?? 0).toBeLessThanOrEqual(maxLevel(ship.id, t));
      const d = upgradedShip(ship.id, undefined, all as UpgradeLevels);
      for (const [k, [lo, hi]] of Object.entries(STAT_BOUNDS)) {
        const v = d.stats[k as StatKey];
        expect(v, `${ship.id} ${k}`).toBeGreaterThanOrEqual(lo);
        expect(v, `${ship.id} ${k}`).toBeLessThanOrEqual(hi);
      }
    }
    // edited saves: unknown tracks and impossible levels are dropped or capped
    expect(cleanLevels('shrike', { cargo: 3, hull: 9, nonsense: 2, engines: 1.5, shields: -1 })).toEqual({ hull: 3 });
  });

  it('the exchange preview shows cost and the stat change before installing', () => {
    const w = W({ marks: 1000, hold: { scrap: 20, alloy: 20 } });
    const q = quoteUpgrade(w, 'petrel', undefined, {}, 'hull', []);
    expect(q.quote.ok).toBe(true);
    if (!q.quote.ok) return;
    expect(q.levels).toEqual({ hull: 1 });
    expect(q.quote.lines[0]!.label).toBe('Marks');
    expect(q.quote.lines.some((l) => /hull/i.test(l.label) && l.before !== l.after)).toBe(true);
    expect(q.quote.result.marks).toBe(1000 - UPGRADE_BY_TRACK.get('hull')!.steps[0]!.cost.marks);
    expect(quoteUpgrade(W(), 'petrel', undefined, {}, 'hull', []).quote.ok).toBe(false);
  });
});

describe('travel: reactor cells, route unlocks and recovery', () => {
  it('charges each hop at least one cell; the travel upgrade lowers the charge', () => {
    expect(FUEL.starterCells).toBeGreaterThan(0);
    for (const cost of [1, 2, 3, 4]) {
      expect(hopCells(cost, 1)).toBe(cost);
      expect(hopCells(cost, 0.6)).toBeLessThanOrEqual(cost);
      expect(hopCells(cost, 0.4)).toBeGreaterThanOrEqual(1);
    }
    const p = fresh();
    const sv = deriveSystemView(deriveView(graph, p), MW);
    const lanes = sv.graph.lanesOf(sv.graph.gateway);
    expect(routeCells(lanes, 1)).toBe(lanes.reduce((n, l) => n + l.cost, 0));
    expect(burnCells({ fuel: 3 }, 4)).toBeNull();
    expect(burnCells({ fuel: 3, scrap: 1 }, 3)).toEqual({ scrap: 1 });
    expect(burnCells({ fuel: 5 }, 2)).toEqual({ fuel: 3 });
    for (const e of graph.edges) expect(galaxyJumpCells(e, 1)).toBe(e.route.cost * FUEL.galaxyFactor);
  });

  it('is never stranded: every Milky Way system has a free way to cells', () => {
    const all = graph.systemsIn(MW).map((s) => s.id);
    const base = fresh();
    for (const here of all) {
      const p: ExplorationProgress = { ...base, charted: all, visitedSystems: all, system: here };
      const sv = deriveSystemView(deriveView(graph, p), MW);
      if (sv.current !== here) continue; // not a place the pilot can be
      const isStation = (id: string): boolean => !!graph.system(id)?.sector.station;
      if (isStation(here)) {
        expect(emergencyCells(0, sv.graph, here, 1, false), here).toBeGreaterThan(0);
        expect(emergencyCells(0, sv.graph, here, 1, true), here).toBe(0); // once per arrival
      } else {
        const to = emergencyJumpTarget(sv, 0, 1, isStation);
        expect(to, here).not.toBeNull();
        expect(isStation(to!)).toBe(true);
        expect(sv.plan(to!).ok).toBe(true);
      }
    }
  });

  it('flies the pilot home for free when no open route out of another galaxy is affordable', () => {
    const edges = graph.edgesOf('andromeda');
    expect(homeJumpDue('andromeda', graph.start, 0, edges, 1)).toBe(true);
    expect(homeJumpDue('andromeda', graph.start, 999, edges, 1)).toBe(false);
    expect(homeJumpDue(graph.start, graph.start, 0, graph.edgesOf(graph.start), 1)).toBe(false);
    expect(homeJumpDue('andromeda', graph.start, 999, [], 1)).toBe(true);
  });

  it('grants free cells only into free hold space', () => {
    expect(grantCells({ scrap: 8 }, 10, 5)).toEqual({ hold: { scrap: 8, fuel: 2 }, added: 2 });
    expect(grantCells({}, 10, 0)).toEqual({ hold: {}, added: 0 });
  });

  it('the story opens the Lantern Gate route after one survey (charts as rewards, no grind)', () => {
    let p = fresh();
    p = applySurvey(graph, p).progress; // first-light: one survey run
    expect(p.charted).toHaveLength(1);
    const before = deriveView(graph, p);
    expect(before.isComplete('lantern-gate')).toBe(false);
    const closed = graph.edges.filter((e) => !before.routeOpen(e)).length;
    // lantern-echo pays 2 charts: the game picks uncharted, unlocked systems
    const picks = rewardChartTargets(graph, p, MW, STORY_BY_ID.get('story-lantern-echo')!.rewards.charts);
    expect(picks).toHaveLength(2);
    for (const id of picks) expect(p.charted).not.toContain(id);
    const next: ExplorationProgress = { ...p, charted: [...p.charted, ...picks] };
    const diff = progressDiff(graph, before, next);
    expect(diff.newMilestones.map((m) => m.id)).toContain('lantern-gate');
    expect(diff.newRoutes.length).toBeGreaterThan(0);
    expect(graph.edges.filter((e) => !deriveView(graph, next).routeOpen(e)).length).toBe(closed - diff.newRoutes.length);
  });
});

describe('events, exploration log and discoveries', () => {
  it('the sector bridge publishes only applied collections; partial finds are not completed', () => {
    const ctx = { systemId: SOL, kindOf: () => 'salvage' as const, applied: true, gained: [{ resource: 'scrap' as const, amount: 2 }] };
    const looted = { type: 'looted', id: 'derelict-1', kind: 'derelict', label: 'Derelict', loot: [{ resource: 'scrap', amount: 2 }], left: [] } as unknown as Parameters<typeof sectorGameEvents>[0];
    expect(sectorGameEvents(looted, ctx)).toEqual([{ type: 'resource-acquired', resource: 'scrap', amount: 2 }, { type: 'poi-completed', systemId: SOL, poiId: 'derelict-1', kind: 'derelict' }]);
    expect(sectorGameEvents(looted, { ...ctx, applied: false })).toEqual([]);
    const partial = { ...looted, left: [{ resource: 'alloy', amount: 1 }] } as typeof looted;
    expect(sectorGameEvents(partial, ctx).some((e) => e.type === 'poi-completed')).toBe(false);
  });

  it('the bus delivers to subscribers until they unsubscribe', () => {
    const bus = createEventBus();
    const got: string[] = [];
    const off = bus.subscribe((e) => got.push(e.type));
    bus.publishAll([{ type: 'jumped', hops: 1 }, { type: 'docked', systemId: SOL }]);
    off();
    bus.publish({ type: 'jumped', hops: 1 });
    expect(got).toEqual(['jumped', 'docked']);
    expect(bus.subscribers).toBe(0);
  });

  it('tracks exploration and keeps real astronomy apart from GALAXIA fiction', () => {
    let log = EMPTY_LOG;
    const events: GameEvent[] = [
      { type: 'galaxy-reached', galaxyId: 'andromeda', first: true },
      { type: 'galaxy-reached', galaxyId: 'andromeda', first: false },
      poi(SOL, 'anomaly-1', 'anomaly'),
      poi(SOL, 'anomaly-1', 'anomaly'),
      poi(SOL, 'derelict-1', 'derelict'),
      { type: 'faction-encountered', faction: 'gleaners' as never },
      { type: 'resource-acquired', resource: 'scrap', amount: 3 },
    ];
    for (const e of events) log = recordEvent(log, e, graph);
    expect(log.anomalies).toEqual([`${SOL}#anomaly-1`]);
    expect(log.wrecks).toEqual([`${SOL}#derelict-1`]);
    expect(log.facts).toEqual(['andromeda']);
    const stats = Object.fromEntries(explorationStats(log, { visitedSystems: 4, visitedGalaxies: 2, routesOpen: 3, missionsCompleted: 1, charted: 2 }).map((r) => [r.id, r.value]));
    expect(stats).toMatchObject({ systems: 4, galaxies: 2, anomalies: 1, wrecks: 1, resources: 3, factions: 1, routes: 3, missions: 1, discoveries: 2 });
    const entries = discoveryEntries(log, graph);
    const fact = entries.find((e) => e.kind === 'fact')!;
    const fiction = entries.find((e) => e.kind === 'fiction')!;
    expect(fact.title).toBe(graph.node('andromeda')!.galaxy.name);
    expect(fact.sources.length).toBeGreaterThan(0);
    expect(fiction.sources).toEqual([]);
    // a fictional system never becomes a "fact"
    const fictional = graph.systemsIn(MW).find((s) => s.provenance.status !== 'verified-object')!;
    expect(recordEvent(EMPTY_LOG, { type: 'system-visited', systemId: fictional.id, galaxyId: MW, first: true }, graph)).toBe(EMPTY_LOG);
  });

  it('view models: the HUD tracks the objective in the pilot system first', () => {
    const ctx = ctxOf(fresh());
    let s = completeStory(EMPTY_MISSIONS, 'story-first-light', ctx, [charted(SOL)]);
    s = completeStory(s, 'story-scrap-and-signal', ctx, [1, 2, 3, 4].map((i) => poi(SOL, `salvage-1.${i}`, 'salvage')));
    const acc = acceptMission(s, STORY_BY_ID.get('story-silent-hull'), world(), ctx);
    if (!acc.ok) throw new Error('accept');
    const sys = acc.mission.targets[0]!.split('#')[0]!;
    const name = { name: (id: string) => graph.system(id)?.name ?? id };
    expect(trackedObjective(acc.state, sys, name, (g) => g)).toMatchObject({ id: 'story-silent-hull', here: true });
    expect(trackedObjective(EMPTY_MISSIONS, sys, name, (g) => g)).toBeNull();
    const model = missionsModel(acc.state, ctx, name, (g) => g, {}, SOL, [...STORY_BY_ID.values()], null);
    expect(model.active.map((r) => r.id)).toEqual(['story-silent-hull']);
    expect(model.ready.map((r) => r.id)).toEqual(['story-first-light', 'story-scrap-and-signal']);
    expect(missionsModel(acc.state, ctx, name, (g) => g, {}, null, [...STORY_BY_ID.values()], null).dispatch).toEqual([]);
  });
});

describe('saved progression', () => {
  it('round-trips through the profile and storage (v9)', () => {
    const ctx = ctxOf(fresh());
    let missions = completeStory(EMPTY_MISSIONS, 'story-first-light', ctx, [charted(SOL)]);
    const acc = acceptMission(missions, STORY_BY_ID.get('story-scrap-and-signal'), world(), ctx);
    if (!acc.ok) throw new Error('accept');
    missions = feed(acc.state, [poi(SOL, 'salvage-1.1', 'salvage'), { type: 'jumped', hops: 2 }]);
    const p: ProgressionState = {
      ...emptyProg(),
      marks: 345,
      missions: { ...missions, claimed: ['story-first-light'] },
      upgrades: { petrel: { hull: 2, cargo: 1 } },
      licences: ['mk2'],
      log: recordEvent(EMPTY_LOG, poi(SOL, 'anomaly-1', 'anomaly'), graph),
      fuel: { starter: true, arrivals: 7, aidAt: 5 },
    };
    const store = new Map<string, string>();
    const backing = { persistent: true, read: (k: string) => store.get(k) ?? null, write: (k: string, v: string) => (store.set(k, v), true), remove: (k: string) => void store.delete(k), keys: () => [...store.keys()] };
    expect(saveProfile(backing as never, withProgression(EMPTY_PROFILE, progressionToSaved(p)))).toBe(true);
    const loaded = loadProfile(backing as never);
    expect(loaded.status).toBe('ok');
    const back = progressionFromSaved(loaded.data.progression);
    expect(back).toEqual(p);
  });

  it('sanitises edited or damaged progression (no duplicate rewards, no invalid upgrades)', () => {
    const store = new Map<string, string>();
    const backing = { persistent: true, read: (k: string) => store.get(k) ?? null, write: (k: string, v: string) => (store.set(k, v), true), remove: (k: string) => void store.delete(k), keys: () => [...store.keys()] };
    const bad = {
      ...EMPTY_PROFILE,
      version: 10,
      progression: {
        marks: -50,
        missions: { jumps: -3, active: [{ id: 'story-made-up', at: 0, progress: [1], targets: [''] }, { id: 'story-scrap-and-signal', at: 0, progress: [99], targets: [''] }], completed: ['story-first-light', 'story-first-light', 'nope'], claimed: ['story-first-light', 'story-silent-hull'], failed: [], ready: {} },
        upgrades: { shrike: { cargo: 3, hull: 3, engines: 7 }, 'not-a-ship': { hull: 1 } },
        licences: ['mk2', 'mk9', 'mk2'],
        log: { anomalies: [], wrecks: [], factions: [], facts: [], kills: -1, acquired: { scrap: 2, 'BAD ID': 1 } },
        fuel: { starter: 'yes', arrivals: 1.5, aidAt: -1 },
      },
    };
    store.set('galaxia:freeroam', JSON.stringify(bad));
    const r = loadProfile(backing as never);
    expect(r.status).toBe('repaired');
    const p = progressionFromSaved(r.data.progression);
    expect(p.marks).toBe(0);
    expect(p.missions.completed).toEqual(['story-first-light']);
    expect(p.missions.claimed).toEqual(['story-first-light']); // claimed only ever a subset of completed
    expect(p.missions.active.map((m) => m.id)).toEqual(['story-scrap-and-signal']);
    expect(p.missions.active[0]!.progress).toEqual([4]); // clamped to the objective
    expect(p.upgrades).toEqual({ shrike: { hull: 3 } });
    expect(p.licences).toEqual(['mk2']);
    expect(p.log.acquired).toEqual({ scrap: 2 });
    expect(p.log.kills).toBe(0);
    expect(p.fuel.arrivals).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(p.fuel.arrivals)).toBe(true);
  });
});
