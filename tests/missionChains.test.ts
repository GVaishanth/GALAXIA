/**
 * P09.1 connected mission chains (progression/missionData.ts CHAINS) through
 * the existing mission path: authored data and references, strict stage order,
 * the heat gate (deterministic, recoverable), faction-filtered objectives, one
 * reward and one consequence per stage at turn-in, no re-offer, failure and
 * persistence, the read-only chain snapshot, and the unchanged story and
 * contracts. Pure; no clock.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FACTION_IDS, RESOURCE_IDS } from '../src/modes/freeroam/catalogue/types.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { progressFromSaved } from '../src/modes/freeroam/galaxy/progress.ts';
import { EMPTY_PROFILE, EMPTY_PROGRESSION, loadProfile, saveProfile, withProgression } from '../src/modes/freeroam/profile.ts';
import type { GameEvent } from '../src/modes/freeroam/progression/events.ts';
import { CHAINS, MISSION_BY_ID, STORY } from '../src/modes/freeroam/progression/missionData.ts';
import { abandonMission, acceptMission, availableStory, consumeEvent, missionStatus, targetLocal, targetSystem, type MissionWorld, type PrereqContext } from '../src/modes/freeroam/progression/missions.ts';
import { buildMissionWorld } from '../src/modes/freeroam/progression/missionWorld.ts';
import { EMPTY_MISSIONS, type MissionState } from '../src/modes/freeroam/progression/missionTypes.ts';
import { progressionFromSaved, progressionToSaved, type ProgressionState } from '../src/modes/freeroam/progression/persistence.ts';
import { claimReward } from '../src/modes/freeroam/progression/station.ts';
import { chainNews, chainViews, heatText, lockText, missionsModel } from '../src/modes/freeroam/progression/view.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const graph = buildNavGraph();
let worldMemo: MissionWorld | null = null;
const world = (): MissionWorld => (worldMemo ??= buildMissionWorld(graph, progressFromSaved(graph, EMPTY_PROFILE), {}));
const ctx = (heat: PrereqContext['heat'] = {}): PrereqContext => ({ visitedGalaxies: ['milky-way'], charted: 0, heat });
const feed = (s: MissionState, events: readonly GameEvent[]): MissionState => events.reduce((acc, e) => consumeEvent(acc, e).state, s);
const W = { marks: 0, hold: {}, holdCap: 60, modules: {} };
const prog = (missions: MissionState): ProgressionState => ({ ...progressionFromSaved(EMPTY_PROGRESSION), missions });
const claimedState = (ids: readonly string[]): MissionState => ({ ...EMPTY_MISSIONS, completed: [...ids], claimed: [...ids] });
const kill = (faction: (typeof FACTION_IDS)[number], systemId = 'milky-way/sirius'): GameEvent => ({ type: 'hostile-destroyed', systemId, faction, family: 'raider', role: 'patrol', source: 'p1' });
const def = (id: string) => MISSION_BY_ID.get(id)!;

/** Accept a stage (must succeed), then feed it the events that finish it from its resolved targets. */
function run(s: MissionState, id: string, c: PrereqContext): MissionState {
  const r = acceptMission(s, def(id), world(), c);
  expect(r.ok, id).toBe(true);
  if (!r.ok) return s;
  const m = r.mission;
  const ev: GameEvent[] = def(id).objectives.flatMap((o, i): GameEvent[] => {
    const t = m.targets[i]!;
    const sys = targetSystem(t) || 'milky-way/sol';
    if (o.kind === 'destroy') return Array.from({ length: o.count }, () => kill(o.faction ?? 'red-tally'));
    if (o.kind === 'deliver') return [{ type: 'delivered', missionId: id, systemId: sys, resource: o.resources![0]!, amount: o.count }];
    if (o.kind === 'poi') return [{ type: 'poi-completed', systemId: sys, poiId: targetLocal(t), kind: o.poiKind! }];
    if (o.kind === 'chart') return ['milky-way/barnards-star', 'milky-way/sirius'].map((systemId) => ({ type: 'system-charted', systemId, galaxyId: 'milky-way' }));
    throw new Error(`no event for ${o.kind}`);
  });
  const done = feed(r.state, ev);
  expect(done.completed, id).toContain(id);
  return done;
}

describe('chain data (P09.1)', () => {
  it('at least two chains of at least three stages, each stage a real mission that names its chain', () => {
    expect(CHAINS.length).toBeGreaterThanOrEqual(2);
    const all = CHAINS.flatMap((c) => c.stages);
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(CHAINS.map((c) => c.id)).size).toBe(CHAINS.length);
    for (const c of CHAINS) {
      expect(c.stages.length, c.id).toBeGreaterThanOrEqual(3);
      c.stages.forEach((id, i) => {
        const d = def(id);
        expect(d, id).toBeDefined();
        expect(id).toMatch(/^chain-[a-z]+(?:-[a-z]+)*$/);
        expect(d.chain).toBe(c.id);
        expect(d.source).toBe('story');
        expect(d.galaxy).toBe('milky-way');
        // every stage after the first requires the one before it
        if (i) expect(d.prerequisites).toContainEqual({ kind: 'mission', id: c.stages[i - 1], claimed: true });
      });
    }
  });
  it('references only real missions, factions, resources and POI kinds; rewards are marks and resources only (no gates)', () => {
    for (const id of CHAINS.flatMap((c) => c.stages)) {
      const d = def(id);
      for (const p of d.prerequisites) {
        if (p.kind === 'mission') expect(MISSION_BY_ID.has(p.id), `${id} -> ${p.id}`).toBe(true);
        if (p.kind === 'heat') expect(FACTION_IDS).toContain(p.faction);
      }
      for (const o of d.objectives) {
        if (o.faction) expect(FACTION_IDS).toContain(o.faction);
        for (const r of o.resources ?? []) expect(RESOURCE_IDS).toContain(r);
        if (o.kind === 'poi') expect(['derelict', 'anomaly', 'salvage', 'cache']).toContain(o.poiKind);
      }
      for (const r of d.rewards.resources) expect(RESOURCE_IDS).toContain(r.resource);
      expect(d.rewards).toMatchObject({ charts: 0, modules: [], licences: [] });
      if (d.heat) {
        expect(FACTION_IDS).toContain(d.heat.faction);
        expect(Math.abs(d.heat.delta)).toBeLessThanOrEqual(20); // bounded
      }
    }
  });
  it('one chain changes a faction\'s heat by its stable id; one changes none', () => {
    const withHeat = CHAINS.filter((c) => c.stages.some((id) => def(id).heat));
    const without = CHAINS.filter((c) => c.stages.every((id) => !def(id).heat));
    expect(withHeat.map((c) => c.id)).toContain('gleaner-accord');
    expect(without.map((c) => c.id)).toContain('faint-lanterns');
    expect(def('chain-accord-shares').heat).toEqual({ faction: 'gleaners', delta: -20 });
    expect(def('chain-accord-ledger').heat).toEqual({ faction: 'red-tally', delta: 15 });
  });
  it('only chain stages carry consequences; the main story is unchanged and contracts have no heat path', () => {
    expect([...MISSION_BY_ID.values()].filter((d) => d.heat).every((d) => d.chain)).toBe(true);
    expect(STORY.every((d) => !d.chain && !d.heat)).toBe(true);
    expect(STORY.map((d) => [d.id, d.rewards.marks])).toEqual([
      ['story-first-light', 60],
      ['story-scrap-and-signal', 80],
      ['story-silent-hull', 100],
      ['story-quiet-lanes', 120],
      ['story-lantern-echo', 100],
      ['story-relay-parts', 150],
      ['story-cold-outpost', 180],
      ['story-through-the-lantern', 200],
      ['story-heart-of-the-machine', 250],
      ['story-deep-survey', 300],
    ]);
    const contracts = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src/modes/freeroam/progression/contracts.ts'), 'utf8');
    expect(contracts).not.toMatch(/heat/i);
  });
  it('Red Tally ships really fly in the Milky Way (the first stage is completable): Sirius patrols are Red Tally', () => {
    const mw = getCatalogue().systems.filter((s) => s.galaxyId === 'milky-way');
    const tally = mw.flatMap((s) => {
      const L = generateSector(s, sectorContext(graph, s.id));
      const n = L.patrols.filter((p) => p.faction === 'red-tally').reduce((k, p) => k + p.ships, 0) + L.sites.filter((x) => x.factions[0] === 'red-tally').reduce((k, x) => k + x.size * x.waves, 0);
      return n ? [[s.id, n] as const] : [];
    });
    expect(tally.map(([id]) => id)).toContain('milky-way/sirius');
    expect(tally.reduce((k, [, n]) => k + n, 0)).toBeGreaterThanOrEqual(3);
  });
});

describe('chain flow through the existing mission path', () => {
  const afterHull = (): MissionState => claimedState(['story-first-light', 'story-scrap-and-signal', 'story-silent-hull']);

  it('the first stage is offered only after its story prerequisite; later stages are locked until the stage before is turned in', () => {
    expect(missionStatus(EMPTY_MISSIONS, def('chain-accord-claims'), ctx())).toBe('locked');
    const s = afterHull();
    expect(availableStory(s, ctx()).map((d) => d.id)).toContain('chain-accord-claims');
    for (const id of ['chain-accord-shares', 'chain-accord-ledger']) {
      expect(missionStatus(s, def(id), ctx())).toBe('locked');
      expect(acceptMission(s, def(id), world(), ctx())).toEqual({ ok: false, reason: 'prerequisites' });
    }
  });
  it('a completed but unclaimed stage does not unlock the next (the turn-in is the step)', () => {
    const done = run(afterHull(), 'chain-accord-claims', ctx());
    expect(missionStatus(done, def('chain-accord-claims'), ctx())).toBe('ready');
    expect(missionStatus(done, def('chain-accord-shares'), ctx())).toBe('locked');
  });
  it('the destroy objective counts only the named faction', () => {
    const r = acceptMission(afterHull(), def('chain-accord-claims'), world(), ctx());
    if (!r.ok) throw new Error('accept');
    const s = feed(r.state, [kill('tessellate'), kill('cordon'), kill('gleaners'), kill('tessellate')]);
    expect(s.active.find((m) => m.id === 'chain-accord-claims')!.progress).toEqual([0]);
    const s2 = feed(s, [kill('red-tally'), kill('red-tally')]);
    expect(s2.completed).not.toContain('chain-accord-claims');
    expect(feed(s2, [kill('red-tally')]).completed).toContain('chain-accord-claims');
  });
  it('events for a later stage never count before it is accepted (no out-of-order or auto completion)', () => {
    const s = feed(afterHull(), [
      { type: 'delivered', missionId: 'chain-accord-shares', systemId: 'milky-way/sol', resource: 'scrap', amount: 6 },
      { type: 'poi-completed', systemId: 'milky-way/sol', poiId: 'derelict-1', kind: 'derelict' },
      kill('red-tally'),
      kill('red-tally'),
      kill('red-tally'),
    ]);
    expect(s.completed).toEqual(afterHull().completed);
  });
  it('the whole chain: each reward once, each consequence once at turn-in, the next stage unlocks, nothing is re-offered', () => {
    const heat: Record<string, number> = { gleaners: 25, 'red-tally': 50 };
    let p = prog(afterHull());
    let w = { ...W };
    const marks: number[] = [];
    const consequences: unknown[] = [];
    for (const id of CHAINS[0]!.stages) {
      expect(availableStory(p.missions, ctx(heat)).map((d) => d.id)).toContain(id);
      p = { ...p, missions: run(p.missions, id, ctx(heat)) };
      const before = w.marks;
      const c = claimReward(p, id, w, () => []);
      expect(c.ok, id).toBe(true);
      if (!c.ok) return;
      p = c.progression;
      w = c.wallet as typeof w;
      marks.push(w.marks - before);
      consequences.push(c.heat ?? null);
      if (c.heat) heat[c.heat.faction] = Math.max(0, Math.min(100, (heat[c.heat.faction] ?? 0) + c.heat.delta));
      // a second turn-in pays nothing and applies nothing
      const again = claimReward(p, id, w, () => []);
      expect(again.ok).toBe(false);
      expect('heat' in again).toBe(false);
      // never offered again
      expect(availableStory(p.missions, ctx(heat)).map((d) => d.id)).not.toContain(id);
      expect(acceptMission(p.missions, def(id), world(), ctx(heat)).ok).toBe(false);
    }
    expect(marks).toEqual([120, 100, 160]);
    expect(consequences).toEqual([null, { faction: 'gleaners', delta: -20 }, { faction: 'red-tally', delta: 15 }]);
    expect(heat).toEqual({ gleaners: 5, 'red-tally': 65 });
    expect(w.hold).toEqual({ circuits: 2, 'nav-data': 2 });
    const view = chainViews(p.missions, ctx(heat)).find((c) => c.id === 'gleaner-accord')!;
    expect(view.completed).toBe(3);
    expect(view.current).toBeNull();
    expect(view.stages.map((s) => s.status)).toEqual(['claimed', 'claimed', 'claimed']);
  });
  it('the heat gate is deterministic and recoverable: locked at 40+ (reason given as data), open below 40, never skips the order', () => {
    const s = claimedState(['story-first-light', 'story-scrap-and-signal', 'story-silent-hull', 'chain-accord-claims']);
    expect(missionStatus(s, def('chain-accord-shares'), ctx({ gleaners: 40 }))).toBe('locked');
    expect(acceptMission(s, def('chain-accord-shares'), world(), ctx({ gleaners: 40 }))).toEqual({ ok: false, reason: 'prerequisites' });
    const v = chainViews(s, ctx({ gleaners: 40 })).find((c) => c.id === 'gleaner-accord')!;
    expect(v.current).toBe('chain-accord-shares');
    expect(v.stages[1]).toMatchObject({ status: 'locked', lockedBy: { kind: 'heat', faction: 'gleaners', below: 40 } });
    expect(v.stages[2]).toMatchObject({ status: 'locked', lockedBy: { kind: 'mission', id: 'chain-accord-shares', claimed: true } });
    expect(missionStatus(s, def('chain-accord-shares'), ctx({ gleaners: 39 }))).toBe('available');
    expect(missionStatus(s, def('chain-accord-shares'), ctx({ 'red-tally': 100 }))).toBe('available'); // another faction's heat does not gate it
    // low heat never opens a stage whose predecessor is not turned in
    expect(missionStatus(afterHull(), def('chain-accord-shares'), ctx({}))).toBe('locked');
    // the gate applies at acceptance only: an accepted stage stays active and completable when heat rises
    const r = acceptMission(s, def('chain-accord-shares'), world(), ctx({ gleaners: 10 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(missionStatus(r.state, def('chain-accord-shares'), ctx({ gleaners: 90 }))).toBe('active');
  });
  it('abandoning a stage pays nothing, applies nothing, keeps the order, and it can be accepted again', () => {
    const s = claimedState(['story-first-light', 'story-scrap-and-signal', 'story-silent-hull', 'chain-accord-claims']);
    const r = acceptMission(s, def('chain-accord-shares'), world(), ctx());
    if (!r.ok) throw new Error('accept');
    const a = abandonMission(r.state, 'chain-accord-shares').state;
    expect(claimReward(prog(a), 'chain-accord-shares', W, () => []).ok).toBe(false);
    expect(missionStatus(a, def('chain-accord-ledger'), ctx())).toBe('locked');
    expect(missionStatus(a, def('chain-accord-shares'), ctx())).toBe('available');
  });
  it('the chain with no consequence runs the same way and pays its rewards once', () => {
    let p = prog(claimedState(['story-first-light']));
    let w = { ...W };
    for (const id of CHAINS[1]!.stages) {
      p = { ...p, missions: run(p.missions, id, ctx()) };
      const c = claimReward(p, id, w, () => []);
      if (!c.ok) throw new Error(id);
      expect(c.heat).toBeUndefined();
      p = c.progression;
      w = c.wallet as typeof w;
    }
    expect(w.marks).toBe(80 + 120 + 140);
    expect(chainViews(p.missions, ctx()).find((c) => c.id === 'faint-lanterns')!.current).toBeNull();
  });
  it('the chain snapshot is derived only (same input, same output; the state is not changed)', () => {
    const s = afterHull();
    const before = JSON.stringify(s);
    const a = chainViews(s, ctx());
    expect(chainViews(s, ctx())).toEqual(a);
    expect(JSON.stringify(s)).toBe(before);
    expect(a.map((c) => [c.id, c.current, c.completed])).toEqual([
      ['gleaner-accord', 'chain-accord-claims', 0],
      ['faint-lanterns', 'chain-lanterns-echo', 0],
    ]);
  });
});

describe('chain persistence', () => {
  it('claimed and active stages survive a save and reload; a reload never pays or re-offers a stage', () => {
    const s = run(claimedState(['story-first-light', 'chain-lanterns-echo']), 'chain-lanterns-charts', ctx());
    const store = new MemoryStore();
    saveProfile(store, withProgression(EMPTY_PROFILE, progressionToSaved(prog(s))));
    const loaded = loadProfile(store);
    expect(loaded.status).toBe('ok');
    const back = progressionFromSaved(loaded.data.progression);
    expect(back.missions.claimed).toContain('chain-lanterns-echo');
    expect(back.missions.completed).toContain('chain-lanterns-charts');
    expect(missionStatus(back.missions, def('chain-lanterns-echo'), ctx())).toBe('claimed');
    expect(missionStatus(back.missions, def('chain-lanterns-charts'), ctx())).toBe('ready');
    expect(claimReward(back, 'chain-lanterns-echo', W, () => []).ok).toBe(false);
  });
  it('unknown or malformed chain ids in a save are dropped safely (the rest of the board still works)', () => {
    const store = new MemoryStore();
    const missions = { ...EMPTY_MISSIONS, completed: ['story-first-light', 'chain-not-real', 'chain-BAD!', 'chain-lanterns-echo'], claimed: ['story-first-light', 'chain-not-real', 'chain-lanterns-echo'] };
    saveProfile(store, { ...EMPTY_PROFILE, progression: { ...EMPTY_PROGRESSION, missions } } as never);
    const loaded = loadProfile(store);
    expect(loaded.status).toBe('repaired'); // the malformed id
    const back = progressionFromSaved(loaded.data.progression);
    expect(back.missions.completed).toEqual(['story-first-light', 'chain-lanterns-echo']);
    expect(availableStory(back.missions, ctx()).map((d) => d.id)).toContain('chain-lanterns-charts');
  });
});

describe('chain presentation (P09.2: read-only text from the same data)', () => {
  const upTo = (ids: readonly string[]): MissionState => claimedState(['story-first-light', 'story-scrap-and-signal', 'story-silent-hull', ...ids]);

  it('every stage carries its objective, data rewards, consequence and (when locked) a reason; nothing is invented', () => {
    for (const c of chainViews(upTo([]), ctx())) {
      expect(c.stages).toHaveLength(3);
      for (const st of c.stages) {
        const d = def(st.id);
        expect(['locked', 'available', 'active', 'ready', 'claimed']).toContain(st.status);
        expect(st.objective.split(' · ')).toHaveLength(d.objectives.length);
        expect(st.objective).toContain(`0/${d.objectives[0]!.count}`);
        expect(st.rewards.length).toBeGreaterThan(0);
        expect(st.consequence).toBe(d.heat ? heatText(d.heat) : null);
        expect(st.why === null).toBe(st.status !== 'locked');
      }
    }
  });

  it('the gate reason says it is checked when you accept and shows the current value; the order reason names the stage', () => {
    const v = chainViews(upTo(['chain-accord-claims']), ctx({ gleaners: 52 })).find((c) => c.id === 'gleaner-accord')!;
    expect(v.stages[1]!.why).toBe('Gleaners heat must be below 40 when you accept (now 52)');
    expect(v.stages[2]!.why).toBe(`turn in ${def('chain-accord-shares').title} first`);
    expect(lockText({ kind: 'heat', faction: 'gleaners', below: 40 }, ctx())).toContain('(now 0)');
    expect(v.stages[1]!.consequence).toBe('GLEANERS HEAT −20');
    expect(chainViews(upTo(['chain-accord-claims', 'chain-accord-shares']), ctx())[0]!.stages[2]!.consequence).toBe('RED TALLY HEAT +15');
  });

  it('progress follows the mission state (active counts, ready shows the full count)', () => {
    const r = acceptMission(upTo([]), def('chain-accord-claims'), world(), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const one = feed(r.state, [kill('red-tally')]);
    expect(chainViews(one, ctx())[0]!.stages[0]).toMatchObject({ status: 'active', objective: expect.stringContaining('1/3') });
    const done = feed(one, [kill('red-tally'), kill('red-tally')]);
    expect(chainViews(done, ctx())[0]!.stages[0]).toMatchObject({ status: 'ready', objective: expect.stringContaining('3/3') });
  });

  it('chain news reports only real changes: the next stage on the dispatch, then the chain complete; nothing when nothing changed', () => {
    const a = upTo([]);
    const b = upTo(['chain-accord-claims']);
    expect(chainNews(chainViews(a, ctx()), chainViews(b, ctx()))).toEqual([`Next: ${def('chain-accord-shares').title} is on the Guild dispatch.`]);
    // the heat gate keeps it locked: no "next" notice is claimed
    expect(chainNews(chainViews(a, ctx({ gleaners: 60 })), chainViews(b, ctx({ gleaners: 60 })))).toEqual([]);
    expect(chainNews(chainViews(b, ctx()), chainViews(b, ctx()))).toEqual([]);
    const c = upTo(['chain-accord-claims', 'chain-accord-shares']);
    expect(chainNews(chainViews(c, ctx()), chainViews(upTo(['chain-accord-claims', 'chain-accord-shares', 'chain-accord-ledger']), ctx()))).toEqual(['Gleaner Accord complete.']);
  });

  it('the board model carries the chains and labels a chain stage row with its chain and stage', () => {
    const s = upTo([]);
    const m = missionsModel(s, ctx(), world(), (id) => id, {}, 'milky-way/sol', availableStory(s, ctx()), null);
    expect(m.chains.map((c) => c.title)).toEqual(['Gleaner Accord', 'Faint Lanterns']);
    const row = [...m.dispatch, ...m.board].find((r) => r.id === 'chain-accord-claims');
    expect(row?.chain).toBe('GLEANER ACCORD · STAGE 1 OF 3');
  });
});
