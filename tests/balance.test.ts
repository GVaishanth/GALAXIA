/**
 * Free Roam Prompt 14 §6: balance guardrails.
 *
 * Numbers come from the Prompt 14 balance probes (recorded in
 * docs/freeroam/TEST_REPORT.md). These tests keep the early game inside the
 * agreed envelope; they do not pin exact values, so tuning stays possible:
 *
 *  - the starter (Petrel, stock pulse cannon) beats every difficulty-1 and -2
 *    group with a simple "charge and lead the shot" pilot, without a recall;
 *  - difficulty rises: time-to-kill grows with tier and a difficulty-3 heavy
 *    group can defeat that same simple pilot (a real challenge stays);
 *  - travel never outruns fuel along the open Milky Way route from Sol;
 *  - the first story rewards pay for a Mk I upgrade; Mk II/III cost more and
 *    stay inside what the Milky Way story pays;
 *  - the starter hold takes a whole early sector's finds.
 *
 * Recovery after destruction (recall + cargo wreck), rare-loot odds and
 * "never stranded" are covered in combat / inventory / progression tests.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import type { FamilyId } from '../src/modes/freeroam/combat/families.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { systemGraph } from '../src/modes/freeroam/galaxy/systems.ts';
import { FUEL, hopCells } from '../src/modes/freeroam/progression/fuel.ts';
import { STORY } from '../src/modes/freeroam/progression/missionData.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, stepSector } from '../src/modes/freeroam/sector/run.ts';
import { SHIPS, STARTER_SHIP } from '../src/modes/freeroam/ships/roster.ts';
import { UPGRADES } from '../src/modes/freeroam/ships/upgrades.ts';
import { attackInput } from './helpers/frPilot.ts';

const graph = buildNavGraph();
const SYSTEMS = getCatalogue().systems;
const layout = (id: string): SectorLayout => generateSector(SYSTEMS.find((s) => s.id === id)!, sectorContext(graph, id));
const SOL = 'milky-way/sol';
const STARTER = SHIPS.find((s) => s.id === STARTER_SHIP)!;

/** An empty arena at difficulty d (open space, only the exit). */
function arena(d: number): SectorLayout {
  const L = layout(SYSTEMS.find((s) => s.difficulty === d)!.id);
  return { ...L, rocks: [], landmarks: [], regions: [], patrols: [], sites: [], hazards: [], pois: L.pois.filter((p) => p.kind === 'exit') };
}

interface Duel {
  readonly won: boolean;
  readonly secs: number;
  readonly minHull: number;
  readonly hull0: number;
}

/** The starter against `fams` spawned 450 px around it; the pilot charges the nearest and leads its shots. */
function duel(d: number, fams: readonly FamilyId[], seed: number): Duel {
  const L = arena(d);
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed });
  r.grace = 0;
  const cx = L.width / 2;
  const cy = L.height / 2;
  Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0 });
  fams.forEach((f, i) => {
    const a = (i / fams.length) * Math.PI * 2;
    spawnAgent(r, f, 'red-tally', 'balance', 'guard', cx + Math.cos(a) * 450, cy + Math.sin(a) * 450);
  });
  const hull0 = r.hull;
  let minHull = r.hull;
  let t = 0;
  for (; t < 60 * 90; t++) {
    const live = r.hostiles.filter((h) => h.hull > 0);
    if (!live.length) break;
    const s = r.ship;
    const h = live.reduce((b, x) => (Math.hypot(x.x - s.x, x.y - s.y) < Math.hypot(b.x - s.x, b.y - s.y) ? x : b));
    const ev = stepSector(r, attackInput(r, h));
    minHull = Math.min(minHull, r.hull);
    if (ev.some((e) => e.type === 'recalled')) return { won: false, secs: t / 60, minHull: 0, hull0 };
  }
  return { won: r.hostiles.every((h) => h.hull <= 0), secs: t / 60, minHull, hull0 };
}

const SEEDS = [1, 2, 3];
const all = (d: number, fams: readonly FamilyId[]): Duel[] => SEEDS.map((s) => duel(d, fams, s));
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const metrics: string[] = [];
afterAll(() => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (env?.['FR_METRICS']) console.log(`BALANCE\n${metrics.join('\n')}`);
});

describe('starter ship and early enemies', () => {
  const EARLY: [number, FamilyId[]][] = [
    [1, ['raider']],
    [1, ['picket']],
    [1, ['recon']],
    [1, ['hauler']],
    [1, ['picket', 'raider', 'raider']],
    [2, ['lancer']],
    [2, ['picket', 'lancer', 'recon']],
  ];
  for (const [d, fams] of EARLY) {
    it(`the stock starter beats d${d} ${fams.join('+')} every time, without a recall and with hull to spare`, () => {
      const res = all(d, fams);
      metrics.push(`d${d} ${fams.join('+')}: ${res.map((x) => `${x.secs.toFixed(1)}s/${Math.round(x.minHull)}`).join(' ')}`);
      for (const x of res) {
        expect(x.won).toBe(true);
        expect(x.minHull).toBeGreaterThanOrEqual(x.hull0 * 0.5);
        expect(x.secs).toBeLessThan(45); // no attrition slog
      }
    }, 60_000);
  }

  it('difficulty rises: time-to-kill grows by tier, and difficulty 3 elites stay dangerous', () => {
    const raider = mean(all(1, ['raider']).map((x) => x.secs));
    const lancer = mean(all(2, ['lancer']).map((x) => x.secs));
    const heavy = mean(all(3, ['heavy']).map((x) => x.secs));
    expect(raider).toBeLessThan(lancer);
    expect(lancer).toBeLessThan(heavy);
    const group = all(3, ['heavy', 'picket', 'lancer']);
    const elite = all(3, ['elite']);
    const eliteWing = all(3, ['elite', 'lancer', 'lancer', 'picket']);
    const fmt = (r: Duel[]): string => r.map((x) => (x.won ? `won/${Math.round(x.minHull)}/${x.secs.toFixed(1)}s` : `lost@${x.secs.toFixed(1)}s`)).join(' ');
    metrics.push(`ttk raider ${raider.toFixed(1)}s < lancer ${lancer.toFixed(1)}s < heavy ${heavy.toFixed(1)}s`);
    metrics.push(`d3 heavy+picket+lancer ${fmt(group)}; d3 elite ${fmt(elite)}; d3 elite+lancer+lancer+picket ${fmt(eliteWing)}`);
    // a challenge remains: an elite costs the simple pilot over half its hull, and an elite wing can win
    for (const x of elite) expect(x.minHull).toBeLessThan(x.hull0 * 0.5);
    expect(eliteWing.some((x) => !x.won), 'an elite wing can beat the simple pilot').toBe(true);
  }, 120_000);
});

describe('economy: travel, upgrades, cargo', () => {
  /** Breadth-first over the Milky Way's lanes from Sol: the order a new pilot meets systems. */
  const bfs = (): { id: string; cells: number }[] => {
    const sg = systemGraph(graph, 'milky-way');
    const out: { id: string; cells: number }[] = [];
    const seen = new Set([SOL]);
    const q = [{ id: SOL, cells: 0 }];
    while (q.length) {
      const c = q.shift()!;
      out.push(c);
      for (const l of sg.lanesOf(c.id)) {
        const o = sg.other(l, c.id);
        if (seen.has(o)) continue;
        seen.add(o);
        q.push({ id: o, cells: hopCells(l.cost, STARTER.base.travel) });
      }
    }
    return out;
  };
  const loot = (L: SectorLayout): Record<string, number> => {
    const t: Record<string, number> = {};
    const add = (e: { resource: string; amount: number }): void => void (t[e.resource] = (t[e.resource] ?? 0) + e.amount);
    for (const p of L.pois) for (const e of p.loot) add(e);
    for (const v of L.veins) for (const c of v.chips) for (const e of c) add(e);
    for (const s of L.sites) for (const e of s.loot) add(e);
    return t;
  };

  it('fuel found never falls behind the cells the route burns (starter cells included)', () => {
    let spent = 0;
    let found = 0;
    for (const [i, s] of bfs().entries()) {
      spent += s.cells;
      found += loot(layout(s.id))['fuel'] ?? 0;
      expect(FUEL.starterCells + found - spent, `after ${i + 1} systems (${s.id})`).toBeGreaterThanOrEqual(0);
      if (i === 3 || i === 9) metrics.push(`fuel after ${i + 1} systems: spent ${spent}, found ${found}, starter ${FUEL.starterCells}`);
    }
  });

  it('the first two story rewards buy a Mk I upgrade; later levels cost more and stay within the Milky Way story pay', () => {
    const marks = STORY.map((m) => m.rewards.marks);
    const mwStory = STORY.filter((m) => !m.galaxy || m.galaxy === 'milky-way').reduce((a, m) => a + m.rewards.marks, 0);
    const mk = (level: number): number[] => UPGRADES.map((u) => u.steps[level]!.cost.marks);
    expect(marks[0]! + marks[1]!).toBeGreaterThanOrEqual(Math.min(...mk(0)));
    for (const u of UPGRADES) for (let i = 1; i < u.steps.length; i++) expect(u.steps[i]!.cost.marks, u.id).toBeGreaterThan(u.steps[i - 1]!.cost.marks);
    expect(Math.min(...mk(2))).toBeLessThanOrEqual(mwStory);
    metrics.push(`story marks ${marks.join(',')}; MW story ${mwStory}; Mk I ${Math.min(...mk(0))}-${Math.max(...mk(0))}, Mk II ${Math.min(...mk(1))}-${Math.max(...mk(1))}, Mk III ${Math.min(...mk(2))}-${Math.max(...mk(2))}`);
  });

  it('the starter hold takes all of Sol (no forced dumping in the first sector); every hull holds more than the starter or trades it for a role', () => {
    const sol = Object.values(loot(layout(SOL))).reduce((a, b) => a + b, 0);
    expect(STARTER.base.cargo + FUEL.starterCells).toBeGreaterThanOrEqual(sol);
    const cargo = SHIPS.map((s) => s.base.cargo);
    expect(Math.max(...cargo)).toBeGreaterThan(STARTER.base.cargo); // a hauler upgrade path exists
    metrics.push(`Sol loot ${sol} units; starter cargo ${STARTER.base.cargo} (+${FUEL.starterCells} cells); hulls ${SHIPS.map((s) => `${s.id}:${s.base.cargo}`).join(' ')}`);
  });
});
