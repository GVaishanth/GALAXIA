/**
 * FR-TD-86: planet and star pull in ordinary sectors (sector/gravityWells.ts).
 * Simulated only (fixed 60 Hz step, normal assisted-inertia controls): this
 * measures drift and deflection, not how the pull feels to a person.
 * The measurement block runs with GRAVITY_SECTOR_MEASURE=1.
 */
import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { applyScenario, createGravityLab, installGravityLab } from '../src/modes/freeroam/gravity/lab.ts';
import { DEFAULT_PARAMS, gravityLabLayout, sanitizeParams } from '../src/modes/freeroam/gravity/config.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { gravityAt, type Vec } from '../src/modes/freeroam/sector/gravityField.ts';
import { freshGravity, GRAVITY, pullOn, wellOf, wellsOf, type Well } from '../src/modes/freeroam/sector/gravityWells.ts';
import { EMPTY_SECTOR_SAVE, type Landmark, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, restartSector, stepSector, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import { SHIP, stepShip, type ShipState, type ShipTuning } from '../src/modes/freeroam/sim.ts';
import { arena } from './helpers/combatProbe.ts';

const NONE: SectorInput = { moveX: 0, moveY: 0 };
const body = (id: string, x: number, y: number, r: number, style: Landmark['style'] = 'rocky'): Landmark => ({ id, kind: 'body', style, x, y, r, hazardR: 0, label: 'Test body' });
const star = (id: string, x: number, y: number, r: number, hazardR: number, style: Landmark['style'] = 'yellow'): Landmark => ({ id, kind: 'star', style, x, y, r, hazardR, label: 'Test star' });
const tmp: Vec = { x: 0, y: 0 };
const mag = (w: Well, d: number): number => gravityAt(w.x, w.y, w.x + d, w.y, w.field, tmp);

/** A combat arena (no rocks, no clouds, no landmarks) with the given landmarks added. */
function runWith(landmarks: Landmark[], at?: { x: number; y: number }): SectorRun {
  const L: SectorLayout = { ...arena(1), landmarks };
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 7 }); // surveyed: the bare arena would otherwise complete on tick 1
  r.phase = 'flight';
  r.grace = 1e9;
  if (at) {
    r.ship.x = at.x;
    r.ship.y = at.y;
  }
  r.ship.vx = 0;
  r.ship.vy = 0;
  return r;
}

const ship = (x: number, y: number): ShipState => ({ x, y, px: x, py: y, vx: 0, vy: 0, heading: 0, pheading: 0, thrusting: false, thrustX: 0, thrustY: 0 }) as ShipState;
const slowest = (): ShipTuning => {
  const min = Math.min(...SHIPS.map((s) => s.base.accel));
  return { ...SHIP, accel: min * 0.95, maxSpeed: Math.min(...SHIPS.map((s) => s.base.maxSpeed)) }; // the slowest hull with the heaviest engine penalty
};

describe('planet and star pull in ordinary sectors (FR-TD-86)', () => {
  it('each landmark pulls with the documented strength at its reference radius, fading smoothly to zero at 5 reference radii', () => {
    const b = wellOf(body('b', 0, 0, 60));
    expect(b.ref).toBe(60);
    expect(b.field.softening).toBe(60); // softening = solid radius (below the collision radius)
    expect(mag(b, 60)).toBeCloseTo(GRAVITY.bodyPull, 6);
    expect(b.field.range).toBe(300);
    const y = wellOf(star('s', 0, 0, 110, 230));
    expect(y.ref).toBe(115); // half the glow is larger than the core
    expect(mag(y, 115)).toBeCloseTo(GRAVITY.starPull, 6);
    const bh = wellOf(star('h', 0, 0, 70, 300, 'black-hole'));
    expect(mag(bh, bh.ref)).toBeCloseTo(GRAVITY.blackHolePull, 6);
    for (const w of [b, y, bh]) {
      // monotonic outside the reference radius, zero at and beyond the range, no jump at the taper
      let prev = Infinity;
      for (let d = w.ref; d <= w.field.range + 50; d += 2) {
        const g = mag(w, d);
        expect(g).toBeLessThanOrEqual(prev + 1e-9);
        expect(Math.abs(g - prev) < 25 || prev === Infinity).toBe(true);
        prev = g;
      }
      expect(mag(w, w.field.range)).toBe(0);
      // the field ring sits where the pull falls to feltPull
      expect(w.felt).toBeGreaterThan(w.ref);
      expect(w.felt).toBeLessThan(w.field.range);
      expect(mag(w, w.felt)).toBeCloseTo(GRAVITY.feltPull, 1);
    }
  });

  it('the summed pull points at the landmark and never exceeds 30% of the ship engine, for every hull', () => {
    const wells = wellsOf([star('n', 500, 500, 26, 200, 'neutron'), body('p', 700, 500, 90, 'gas')]);
    const out = freshGravity();
    for (const s of SHIPS) {
      for (const accel of [s.base.accel * 0.95, s.base.accel, s.base.accel * 1.15 * 1.1]) {
        pullOn(wells, 500, 500 - 27, accel, out); // right at the neutron core
        expect(out.g).toBeLessThanOrEqual(GRAVITY.engineShare * accel + 1e-9);
        expect(out.g).toBeCloseTo(GRAVITY.engineShare * accel, 6); // capped there
        expect(out.y).toBeGreaterThan(0); // toward the core (y down)
        expect(out.source).toBe('n');
      }
    }
    pullOn(wellsOf([]), 0, 0, 1000, out);
    expect(out).toEqual({ x: 0, y: 0, g: 0, source: null });
  });

  it('a coasting ship near a planet drifts toward it; beyond the field it stays put', () => {
    const r = runWith([body('b', 1500, 1000, 60)], { x: 1500 - 120, y: 1000 }); // 2 radii from the centre
    const d0 = Math.hypot(r.ship.x - 1500, r.ship.y - 1000);
    for (let t = 0; t < 120; t++) stepSector(r, NONE);
    const d1 = Math.hypot(r.ship.x - 1500, r.ship.y - 1000);
    expect(d0 - d1).toBeGreaterThan(30); // pulled in measurably within 2 s
    expect(r.gravity.source).toBe('b');
    expect(r.gravity.x).toBeGreaterThan(0);
    const far = runWith([body('b', 1500, 1000, 60)], { x: 1500 - 400, y: 1000 }); // beyond 5 radii
    for (let t = 0; t < 120; t++) stepSector(far, NONE);
    expect(far.ship.x).toBe(1100);
    expect(far.gravity.g).toBe(0);
  });

  it('full thrust always escapes: the slowest hull leaves every kind of landmark from its surface', () => {
    const tune = slowest();
    const cases: Landmark[] = [body('gas', 4000, 4000, 120, 'gas'), star('blue', 4000, 4000, 150 * 1.35, 320 * 1.35, 'blue'), star('neutron', 4000, 4000, 26, 200, 'neutron'), star('bh', 4000, 4000, 70, 300, 'black-hole')];
    for (const l of cases) {
      const wells = wellsOf([l]);
      const sh = ship(l.x, l.y - l.r - tune.radius - 1);
      const out = freshGravity();
      let t = 0;
      for (; t < 60 * 20; t++) {
        pullOn(wells, sh.x, sh.y, tune.accel, out);
        stepShip(sh, { moveX: 0, moveY: -1 }, 8000, 8000, { pullX: out.x, pullY: out.y }, tune);
        if (out.g === 0) break;
      }
      expect(out.g, l.id).toBe(0);
      expect(t / 60, l.id).toBeLessThan(6);
    }
  });

  it('the gravity lab keeps its own physics: no landmark pull on top of its planet', () => {
    const p = sanitizeParams(DEFAULT_PARAMS);
    const { layout, body: b } = gravityLabLayout(arena(1), p);
    const r = createSectorRun(layout, EMPTY_SECTOR_SAVE, { seed: 7 });
    expect(r.wells.length).toBe(1); // the lab planet is a layout landmark...
    const lab = createGravityLab(b, p);
    installGravityLab(r, lab);
    applyScenario(r, lab, 'B');
    for (let t = 0; t < 240; t++) {
      stepSector(r, { moveX: 0, moveY: 0, vector: { turn: 0, thrust: 0, reverse: 0, pointX: 0, pointY: 0 } });
      expect(r.gravity.g).toBe(0); // ...but while the lab hook runs, only the lab pulls
    }
  });

  it('is deterministic, and a restart clears the pull state', () => {
    const fly = (): number[] => {
      const r = runWith([body('b', 1500, 1000, 80), star('s', 900, 600, 96, 200, 'orange')], { x: 1300, y: 900 });
      for (let t = 0; t < 300; t++) stepSector(r, t % 90 < 30 ? { moveX: 1, moveY: 0 } : NONE);
      return [r.ship.x, r.ship.y, r.ship.vx, r.ship.vy, r.gravity.g];
    };
    expect(fly()).toEqual(fly());
    const r = runWith([body('b', 1500, 1000, 80)], { x: 1400, y: 1000 });
    for (let t = 0; t < 10; t++) stepSector(r, NONE);
    expect(r.gravity.g).toBeGreaterThan(0);
    restartSector(r);
    expect(r.gravity).toEqual(freshGravity());
  });
});

/* ------------------------------------------------------------------ measurements (GRAVITY_SECTOR_MEASURE=1) */

const MEASURE = process.env['GRAVITY_SECTOR_MEASURE'] === '1';

describe.skipIf(!MEASURE)('FR-TD-86 measurements (simulated)', () => {
  it('drift and deflection with normal controls: this design vs the lab pull unchanged', () => {
    const lines: string[] = [];
    const starter = { ...SHIP, accel: SHIPS[0]!.base.accel, maxSpeed: SHIPS[0]!.base.maxSpeed };
    // the lab's default field as it would act on a 120 px planet (mu 7e6, eps 30, range 1400)
    const labWell: Well = { id: 'lab', x: 2000, y: 2000, solid: 120, ref: 120, pull: 0, field: { mu: DEFAULT_PARAMS.mu, softening: DEFAULT_PARAMS.softening, range: DEFAULT_PARAMS.range }, felt: 0 };
    const designs: [string, Well][] = [
      ['planet r60 (this design)', wellOf(body('p60', 2000, 2000, 60))],
      ['gas giant r120 (this design)', wellOf(body('p120', 2000, 2000, 120, 'gas'))],
      ['yellow star r110 (this design)', wellOf(star('y', 2000, 2000, 110, 230))],
      ['black hole r70 (this design)', wellOf(star('bh', 2000, 2000, 70, 300, 'black-hole'))],
      ['lab pull unchanged, r120 planet', labWell],
    ];
    lines.push('| Landmark | pull at 1.5 / 2 / 3 solid radii (px/s²) | coasting drift after 1.5 s from rest at 1.5 / 2 / 3 radii (px/s) | flying past under full thrust, 2 radii out: sideways offset toward it | field ring |');
    lines.push('|---|---|---|---|---|');
    for (const [name, w] of designs) {
      const pulls = [1.5, 2, 3].map((k) => Math.min(GRAVITY.engineShare * starter.accel, mag(w, w.solid * k)).toFixed(0));
      const drift = [1.5, 2, 3].map((k) => {
        const sh = ship(w.x - w.solid * k, w.y);
        const out = freshGravity();
        for (let t = 0; t < 90; t++) {
          pullOn([w], sh.x, sh.y, starter.accel, out);
          stepShip(sh, NONE, 4000, 4000, { pullX: out.x, pullY: out.y }, starter);
        }
        return Math.hypot(sh.vx, sh.vy).toFixed(0);
      });
      // fly past: start far below-left, thrust straight up along x = centre - 2 radii
      const sh = ship(w.x - w.solid * 2, w.y + 900);
      sh.vy = -starter.maxSpeed;
      const out = freshGravity();
      for (let t = 0; t < 60 * 6 && sh.y > w.y - 900; t++) {
        pullOn([w], sh.x, sh.y, starter.accel, out);
        stepShip(sh, { moveX: 0, moveY: -1 }, 4000, 4000, { pullX: out.x, pullY: out.y }, starter);
      }
      lines.push(`| ${name} | ${pulls.join(' / ')} | ${drift.join(' / ')} | ${(sh.x - (w.x - w.solid * 2)).toFixed(0)} px | ${w.felt ? w.felt.toFixed(0) + ' px' : '—'} |`);
    }
    console.log(['GRAVITY_SECTOR', ...lines].join('\n'));
  });

  it('escape from the surface under full thrust: time to leave the field', () => {
    const hulls: [string, ShipTuning][] = [
      ['slowest hull, heaviest engine penalty', slowest()],
      ['starter hull', { ...SHIP, accel: SHIPS[0]!.base.accel, maxSpeed: SHIPS[0]!.base.maxSpeed }],
    ];
    const cases: Landmark[] = [body('rocky r60', 4000, 4000, 60), body('gas giant r120', 4000, 4000, 120, 'gas'), star('yellow star', 4000, 4000, 110, 230), star('blue giant', 4000, 4000, 150 * 1.35, 320 * 1.35, 'blue'), star('neutron star', 4000, 4000, 26, 200, 'neutron'), star('black hole', 4000, 4000, 70, 300, 'black-hole')];
    const lines = ['| Landmark | ' + hulls.map(([n]) => n).join(' | ') + ' |', '|---|' + hulls.map(() => '---|').join('')];
    for (const l of cases) {
      const cells = hulls.map(([, tune]) => {
        const wells = wellsOf([l]);
        const sh = ship(l.x, l.y - l.r - tune.radius - 1);
        const out = freshGravity();
        let t = 0;
        for (; t < 60 * 20; t++) {
          pullOn(wells, sh.x, sh.y, tune.accel, out);
          stepShip(sh, { moveX: 0, moveY: -1 }, 8000, 8000, { pullX: out.x, pullY: out.y }, tune);
          if (out.g === 0) break;
        }
        return `${(t / 60).toFixed(2)} s (${(wells[0]!.field.range - l.r).toFixed(0)} px)`;
      });
      lines.push(`| ${l.id} | ${cells.join(' | ')} |`);
    }
    console.log(['GRAVITY_ESCAPE', ...lines].join('\n'));
  });

  it('the catalogue: landmarks per sector and the pull at arrival points', () => {
    const cat = getCatalogue();
    const graph = buildNavGraph(cat);
    let sectors = 0;
    let withWells = 0;
    let wells = 0;
    let maxSpawn = 0;
    let spawnsPulled = 0;
    let spawns = 0;
    let feltShare = 0;
    let maxPoi = 0;
    let maxPoiId = '';
    const out = freshGravity();
    for (const sys of cat.systems) {
      const L = generateSector(sys, sectorContext(graph, sys.id));
      sectors += 1;
      const ws = wellsOf(L.landmarks);
      if (ws.length) withWells += 1;
      wells += ws.length;
      for (const sp of L.spawns) {
        pullOn(ws, sp.x, sp.y, SHIPS[0]!.base.accel, out);
        spawns += 1;
        if (out.g > GRAVITY.arrowPull) spawnsPulled += 1;
        maxSpawn = Math.max(maxSpawn, out.g);
      }
      for (const p of L.pois) {
        pullOn(ws, p.x, p.y, SHIPS[0]!.base.accel, out);
        if (out.g > maxPoi) {
          maxPoi = out.g;
          maxPoiId = `${sys.id} ${p.kind}`;
        }
      }
      // share of the sector area inside a field ring (grid sample)
      let inside = 0;
      let n = 0;
      for (let x = 50; x < L.width; x += 100)
        for (let y = 50; y < L.height; y += 100) {
          n += 1;
          if (ws.some((w) => Math.hypot(w.x - x, w.y - y) < w.felt)) inside += 1;
        }
      feltShare += inside / n;
    }
    console.log(`GRAVITY_CATALOGUE sectors ${sectors}, with landmarks ${withWells}, landmarks ${wells} (${(wells / sectors).toFixed(2)} per sector), mean area inside a field ring ${((100 * feltShare) / sectors).toFixed(1)}%, spawn points ${spawns}, pulled above ${GRAVITY.arrowPull} px/s² ${spawnsPulled}, strongest spawn pull ${maxSpawn.toFixed(1)} px/s², strongest pull at a point of interest ${maxPoi.toFixed(1)} px/s² (${maxPoiId})`);
  });
});
