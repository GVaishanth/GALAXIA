/**
 * Gravity Flight prototype P01: scripted-pilot measurements (simulation only;
 * not a pass/fail gate). Skipped in `npm test`; run with
 *   GRAVITY_MEASURE=1 npx vitest run tests/gravityMeasure.test.ts
 * It flies the real lab (sector/run.ts stepSector + gravity/lab.ts) with simple
 * deterministic autopilots and prints markdown tables (copied into
 * docs/freeroam/GRAVITY_FLIGHT_P01.md). An autopilot is not a player: these
 * numbers say what the physics allows, not how it feels.
 */
import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { DEFAULT_PARAMS, gravityLabLayout, LAB_SAVE, LAB_SECTOR, LAB_SYSTEM_ID, sanitizeParams, type LabParams, type ScenarioId } from '../src/modes/freeroam/gravity/config.ts';
import { createGravityLab, installGravityLab, type GravityLab } from '../src/modes/freeroam/gravity/lab.ts';
import { freshAdvice, freshTelemetry, influenceRadius, NO_CONTROLS, orbitalEnergy, stepVectorFlight, suggestEscape, type BodyState, type FieldParams, type FlightParams, type VectorControls } from '../src/modes/freeroam/gravity/physics.ts';
import type { ShipState } from '../src/modes/freeroam/sim.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { createSectorRun, stepSector, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { flyC, mean, starts, STRATEGIES, strategy } from './helpers/gravityPilots.ts';

const ON = process.env['GRAVITY_MEASURE'] === '1';
const SOL = getCatalogue().systems.find((s) => s.id === LAB_SYSTEM_ID)!;
const BASE = generateSector(SOL, sectorContext(buildNavGraph(), LAB_SYSTEM_ID));
const r0 = (n: number): string => (Number.isFinite(n) ? String(Math.round(n)) : '—');
const r1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '—');

function lab(scenario: ScenarioId, params: Partial<LabParams> = {}, seed = 1, assist = false): { run: SectorRun; lab: GravityLab } {
  const p = sanitizeParams({ ...DEFAULT_PARAMS, ...params });
  const { layout, body } = gravityLabLayout(BASE, p);
  const run = createSectorRun(layout, LAB_SAVE, { seed });
  const l = createGravityLab(body, p);
  l.scenario = scenario;
  l.assist = assist;
  installGravityLab(run, l);
  return { run, lab: l };
}

const input = (v: VectorControls, fire = false): SectorInput => ({ moveX: 0, moveY: -(v.thrust > 0 || Math.hypot(v.pointX, v.pointY) > 0.3 ? 1 : 0), vector: v, fire });

/** Waypoint autopilot: points the stick along (desired velocity - velocity); the vector model thrusts once the nose is aligned. */
function waypointPilot(points: readonly { x: number; y: number; r: number }[], cruise = 300) {
  let i = 0;
  return (run: SectorRun): VectorControls => {
    const sh = run.ship;
    while (i < points.length - 1 && Math.hypot(points[i]!.x - sh.x, points[i]!.y - sh.y) < points[i]!.r) i++;
    const w = points[i]!;
    const dx = w.x - sh.x;
    const dy = w.y - sh.y;
    const d = Math.hypot(dx, dy) || 1;
    const sx = (dx / d) * cruise - sh.vx;
    const sy = (dy / d) * cruise - sh.vy;
    const s = Math.hypot(sx, sy);
    if (s < 25) return NO_CONTROLS;
    return { ...NO_CONTROLS, pointX: sx / s, pointY: sy / s };
  };
}

interface Outcome {
  damage: number;
  collisions: number;
  lockLosses: number;
  firstLockLoss: number;
  minEnemy: number;
  endEnemy: number;
  blocked: number;
  escaped: boolean;
  escapeAt: number;
  minAlt: number;
  peak: number;
  passes: number;
  bySource: Record<string, number>;
  enemyMinAlt: number;
}

/** Fly `seconds` with a controller; count damage, planet-blocked enemy shots and pursuit metrics. */
function fly(run: SectorRun, l: GravityLab, seconds: number, ctl: (run: SectorRun, l: GravityLab) => VectorControls, fire = false): Outcome {
  const st = run.craft.stats;
  let damage = 0;
  let minEnemy = Infinity;
  let blocked = 0;
  let escapeAt = -1;
  let minAlt = Infinity;
  let peak = 0;
  let prevShots = new Map<number, { x: number; y: number }>();
  const bySource: Record<string, number> = {};
  let enemyMinAlt = Infinity;
  for (let t = 0; t < seconds * 60; t++) {
    const before = run.shield + run.hull;
    const events = stepSector(run, input(ctl(run, l), fire));
    for (const e of events) if (e.type === 'hit') bySource[e.source] = (bySource[e.source] ?? 0) + e.damage;
    for (const a of run.hostiles) if (a.state !== 'destroyed') enemyMinAlt = Math.min(enemyMinAlt, Math.hypot(a.x - l.body.x, a.y - l.body.y) - l.body.r);
    const after = run.shield + run.hull;
    if (after < before) damage += before - after;
    // enemy shots that vanished at the planet surface were stopped by it (line of sight)
    const now = new Map(run.enemyShots.map((s) => [s.id, { x: s.x, y: s.y }]));
    for (const [id, p] of prevShots) if (!now.has(id) && Math.hypot(p.x - l.body.x, p.y - l.body.y) < l.body.r + 40) blocked++;
    prevShots = now;
    const d = l.diag;
    if (d.enemyDistance !== null) minEnemy = Math.min(minEnemy, d.enemyDistance);
    minAlt = Math.min(minAlt, d.altitude);
    peak = Math.max(peak, d.speed);
    if (escapeAt < 0 && d.passes.some((p) => p.escaped)) escapeAt = l.tick / 60;
  }
  void st;
  const d = l.diag;
  return {
    damage,
    collisions: d.collisions,
    lockLosses: d.lockLosses,
    firstLockLoss: d.firstLockLossTick >= 0 ? d.firstLockLossTick / 60 : -1,
    minEnemy,
    endEnemy: d.enemyDistance ?? Infinity,
    blocked,
    escaped: d.passes.some((p) => p.escaped),
    escapeAt,
    minAlt,
    peak,
    passes: d.passes.length,
    bySource,
    enemyMinAlt,
  };
}

const BX = 2300;
const BY = 1400;

describe.runIf(ON)('Gravity Flight P01 measurements (scripted pilots, simulated)', () => {
  it('scenario A: escape from inside the field', () => {
    const rows: string[] = ['| pilot | assist | escaped | time to field edge (s) | planet hits | min altitude (px) | peak speed (px/s) |', '|---|---|---|---|---|---|---|'];
    const cases: [string, boolean, (run: SectorRun, l: GravityLab) => VectorControls][] = [
      ['no input', false, () => NO_CONTROLS],
      ['burn straight out (radial)', false, (run) => ({ ...NO_CONTROLS, pointX: 0, pointY: run.ship.y > BY ? 1 : -1 })],
      ['burn along the motion (prograde)', false, (run) => {
        const s = Math.hypot(run.ship.vx, run.ship.vy) || 1;
        return { ...NO_CONTROLS, pointX: run.ship.vx / s, pointY: run.ship.vy / s };
      }],
      ['follow the assist escape heading', true, (_run, l) => (Number.isFinite(l.advice.heading) ? { ...NO_CONTROLS, pointX: Math.sin(l.advice.heading), pointY: -Math.cos(l.advice.heading) } : { ...NO_CONTROLS, thrust: 1 })],
      ['radial burn, assist on', true, (run) => ({ ...NO_CONTROLS, pointX: 0, pointY: run.ship.y > BY ? 1 : -1 })],
    ];
    for (const [name, assist, ctl] of cases) {
      const { run, lab: l } = lab('A', {}, 1, assist);
      const o = fly(run, l, 10, ctl);
      rows.push(`| ${name} | ${assist ? 'on' : 'off'} | ${o.escaped ? 'yes' : 'no'} | ${o.escapeAt >= 0 ? r1(o.escapeAt) : '—'} | ${o.collisions} | ${r0(o.minAlt)} | ${r0(o.peak)} |`);
    }
    console.log(`\n### Scenario A\n${rows.join('\n')}`);
    expect(rows.length).toBeGreaterThan(2);
  });

  it('scenario B: slingshot — course change to due north with and without the planet', () => {
    // Goal: leave heading due north at 230 px/s (the field-entry speed). The pilot steers the
    // stick along (target velocity - velocity); "use the planet" coasts until periapsis first.
    const rows: string[] = [
      '| approach | pilot | engine Δv used (px/s) | done at (s) | unpowered bend before burning (deg) | min altitude (px) | hits |',
      '|---|---|---|---|---|---|---|',
    ];
    const TX = 0;
    const TY = -230;
    for (const a of [10, 12, 14]) {
      for (const [name, params, waitPeri] of [
        ['no planet (μ = 0), turn with the engines', { mu: 0, approachDeg: a }, false],
        ['planet: coast to periapsis, then burn', { approachDeg: a }, true],
        ['planet: coast through the whole pass, then burn', { approachDeg: a }, true],
      ] as [string, Partial<LabParams>, boolean][]) {
        const late = name.includes('whole pass');
        const { run, lab: l } = lab('B', params);
        let dv = 0;
        let doneAt = -1;
        let bend = 0;
        let minAlt = Infinity;
        let burning = !waitPeri;
        let lastD = Infinity;
        const a0 = Math.atan2(run.ship.vy, run.ship.vx);
        for (let t = 0; t < 20 * 60 && doneAt < 0; t++) {
          const sh = run.ship;
          const dist = Math.hypot(sh.x - l.body.x, sh.y - l.body.y);
          if (!burning && dist > lastD && dist < l.params.range && (!late || dist > 700)) {
            burning = true;
            bend = ((Math.atan2(sh.vy, sh.vx) - a0) * 180) / Math.PI;
          }
          lastD = dist;
          const ex = TX - sh.vx;
          const ey = TY - sh.vy;
          const e = Math.hypot(ex, ey);
          if (burning && e < 12) doneAt = t / 60;
          const v = burning && e >= 12 ? { ...NO_CONTROLS, pointX: ex / e, pointY: ey / e } : NO_CONTROLS;
          stepSector(run, input(v));
          dv += l.tel.engine / 60;
          minAlt = Math.min(minAlt, l.diag.altitude);
        }
        rows.push(`| ${a}° | ${name} | ${r0(dv)} | ${doneAt >= 0 ? r1(doneAt) : 'not reached'} | ${waitPeri ? r0(bend) : '—'} | ${Number.isFinite(minAlt) && params.mu !== 0 ? r0(minAlt) : '—'} | ${l.diag.collisions} |`);
      }
    }
    const ideal = (deg: number): number => 2 * 230 * Math.sin(((deg * Math.PI) / 180) / 2);
    rows.push('', `Reference: rotating a 230 px/s velocity by 102° with engines alone needs at least ${r0(ideal(102))} px/s of Δv; by 45°, ${r0(ideal(45))} px/s.`);
    console.log(`\n### Scenario B\n${rows.join('\n')}`);
    expect(rows.length).toBeGreaterThan(2);
  });

  it('scenario C: evasion — wide run vs slingshot round the planet vs coast (12 seeds each)', () => {
    const strategies: [string, () => (run: SectorRun, l: GravityLab) => VectorControls][] = [
      ['coast (no input)', () => () => NO_CONTROLS],
      ['run wide of the planet', () => waypointPilot([{ x: BX, y: BY + 560, r: 200 }, { x: 4000, y: BY + 560, r: 100 }], 340)],
      ['slingshot: dive past and loop behind the planet', () => waypointPilot([{ x: BX - 60, y: BY + 215, r: 90 }, { x: BX + 230, y: BY, r: 90 }, { x: BX, y: BY - 240, r: 90 }, { x: 900, y: 500, r: 100 }], 340)],
      ['orbit hug: keep the planet between you and it', () => waypointPilot([{ x: BX - 60, y: BY + 215, r: 80 }, { x: BX + 215, y: BY + 40, r: 80 }, { x: BX + 40, y: BY - 215, r: 80 }, { x: BX - 215, y: BY - 40, r: 80 }, { x: BX - 40, y: BY + 215, r: 80 }, { x: BX + 215, y: BY + 40, r: 80 }], 300)],
    ];
    const rows: string[] = [
      '| pilot (15 s, lancer pursuing, enemy gravity on, enemy fire on) | mean damage taken | of which ram / shots / planet | planet hits | runs with lock lost | shots stopped by the planet | mean min gap (px) | mean final gap (px) | lancer closest to surface (px) |',
      '|---|---|---|---|---|---|---|---|---|',
    ];
    for (const [name, make] of strategies) {
      const out: Outcome[] = [];
      for (let seed = 1; seed <= 12; seed++) {
        const { run, lab: l } = lab('C', {}, seed);
        out.push(fly(run, l, 15, make()));
      }
      const mean = (f: (o: Outcome) => number): number => out.reduce((s, o) => s + f(o), 0) / out.length;
      const src = (k: string): string => r1(mean((o) => o.bySource[k] ?? 0));
      rows.push(`| ${name} | ${r1(mean((o) => o.damage))} | ${src('hostile')} / ${src('fire')} / ${src('impact')} | ${out.reduce((s, o) => s + o.collisions, 0)} | ${out.filter((o) => o.lockLosses > 0).length}/12 | ${out.reduce((s, o) => s + o.blocked, 0)} | ${r0(mean((o) => o.minEnemy))} | ${r0(mean((o) => (Number.isFinite(o.endEnemy) ? o.endEnemy : 0)))} | ${r0(Math.min(...out.map((o) => o.enemyMinAlt)))} |`);
    }
    console.log(`\n### Scenario C\n${rows.join('\n')}`);
    expect(rows.length).toBeGreaterThan(2);
  });

  it('scenario C with the enemy unaffected by gravity, and with the normal controller', () => {
    const rows: string[] = ['| variant | pilot | mean damage | runs with lock lost | planet hits |', '|---|---|---|---|---|'];
    const sling = () => waypointPilot([{ x: BX - 60, y: BY + 215, r: 90 }, { x: BX + 230, y: BY, r: 90 }, { x: BX, y: BY - 240, r: 90 }, { x: 900, y: 500, r: 100 }], 340);
    const wide = () => waypointPilot([{ x: BX, y: BY + 560, r: 200 }, { x: 4000, y: BY + 560, r: 100 }], 340);
    for (const [variant, params, pilotName, pilot] of [
      ['enemy gravity off', { enemyGravity: false }, 'slingshot loop', sling],
      ['enemy gravity off', { enemyGravity: false }, 'run wide', wide],
      ['raider instead of lancer', { enemyFamily: 'raider' }, 'slingshot loop', sling],
      ['raider instead of lancer', { enemyFamily: 'raider' }, 'run wide', wide],
    ] as [string, Partial<LabParams>, string, typeof sling][]) {
      const out: Outcome[] = [];
      for (let seed = 1; seed <= 12; seed++) {
        const { run, lab: l } = lab('C', params, seed);
        out.push(fly(run, l, 15, pilot()));
      }
      rows.push(`| ${variant} | ${pilotName} | ${r1(out.reduce((s, o) => s + o.damage, 0) / 12)} | ${out.filter((o) => o.lockLosses > 0).length}/12 | ${out.reduce((s, o) => s + o.collisions, 0)} |`);
    }
    console.log(`\n### Scenario C variants\n${rows.join('\n')}`);
    expect(rows.length).toBeGreaterThan(2);
  });
});

/* ---------------- Gravity Flight P02 (FR-TD-84) ---------------- */

describe.runIf(ON)('Gravity Flight P02 measurements (scripted pilots, simulated)', () => {
  it('scenario C: A/B/C strategies from 36 identical starts, planet occlusion on and off', () => {
    const S = starts(4);
    const rows: string[] = [
      '| strategy | pilot | mean damage (shots / ram / planet) | starts with no damage | enemy shots fired | shots stopped by the planet | shots prevented by occlusion (off − on) | s in enemy range with sight blocked / clear | starts where the enemy lost the target | still pursued at 15 s | mean final gap (px) | planet hits | engine Δv (px/s) | net turn of velocity (°) |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const st of STRATEGIES) {
      const on = S.map((s) => flyC(s, st.make(), { occlusion: true }));
      const off = S.map((s) => flyC(s, st.make(), { occlusion: false }));
      const n = S.length;
      rows.push(
        `| ${st.group}${st.poor ? ' (poor)' : ''} | ${st.name} | ${r1(mean(on, (o) => o.damage))} (${r1(mean(on, (o) => o.damageShots))} / ${r1(mean(on, (o) => o.damageRam))} / ${r1(mean(on, (o) => o.damagePlanet))}) · off: ${r1(mean(off, (o) => o.damage))} | ${on.filter((o) => o.damage === 0).length}/${n} | ${r1(mean(on, (o) => o.shots))} | ${r1(mean(on, (o) => o.stopped))} | ${r1(mean(off, (o) => o.shots) - mean(on, (o) => o.shots))} | ${r1(mean(on, (o) => o.covered))} / ${r1(mean(on, (o) => o.exposed))} | ${on.filter((o) => o.lockLost).length}/${n} | ${on.filter((o) => o.pursuedAtEnd).length}/${n} | ${r0(mean(on, (o) => (Number.isFinite(o.finalGap) ? o.finalGap : 0)))} | ${on.reduce((s, o) => s + o.planetHits, 0)} | ${r0(mean(on, (o) => o.engineDv))} | ${r0(mean(on, (o) => o.headingChange))} |`,
      );
    }
    console.log(`\n### P02 scenario C strategies (3 gaps x 3 offsets x 4 seeds = ${S.length} starts each)\n${rows.join('\n')}`);
    expect(rows.length).toBe(STRATEGIES.length + 2);
  }, 300_000);

  it('reacquisition: ticks from sight clearing to the next enemy shot', () => {
    const rows: string[] = ['| pilot | starts with a shot after cover | delay min / mean / max (s) |', '|---|---|---|'];
    for (const id of ['C-east', 'C-wide', 'B-330']) {
      const out = starts(4).map((s) => flyC(s, strategy(id).make())).filter((o) => o.fireDelay >= 0);
      const ds = out.map((o) => o.fireDelay / 60);
      rows.push(`| ${id} | ${out.length}/36 | ${ds.length ? `${r1(Math.min(...ds))} / ${r1(mean(ds, (x) => x))} / ${r1(Math.max(...ds))}` : '—'} |`);
    }
    console.log(`\n### P02 reacquisition\n${rows.join('\n')}`);
    expect(rows.length).toBe(5);
  }, 120_000);

  it('escape advice before (P01) vs after (P02): a keyboard pilot follows each from the same states', () => {
    const f: FieldParams = { mu: DEFAULT_PARAMS.mu, softening: DEFAULT_PARAMS.softening, range: DEFAULT_PARAMS.range };
    const body: BodyState = { x: BX, y: BY, vx: 0, vy: 0, r: DEFAULT_PARAMS.radius };
    const p: FlightParams = { thrust: DEFAULT_PARAMS.thrust, reverseRatio: DEFAULT_PARAMS.reverseRatio, speedLimit: 340, turnRate: DEFAULT_PARAMS.turnRate, pointTurnRate: 9, assist: false, assistStrength: 0.6, assistMax: 225, safetySpeed: 2400 };
    const W = LAB_SECTOR.width;
    const H = LAB_SECTOR.height;
    const SAFE = influenceRadius(f, p.thrust, DEFAULT_PARAMS.displayThreshold);
    const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
    /** P01's suggestEscape, verbatim in behaviour (instant heading, 24 headings, end energy after 2.5 s). */
    const p01 = (sh: ShipState): number => {
      const probe: ShipState = { ...sh };
      const tel = freshTelemetry();
      let best = -Infinity;
      let bestHeading = Number.NaN;
      for (let i = 0; i < 24; i++) {
        const heading = (i / 24) * Math.PI * 2 - Math.PI;
        Object.assign(probe, { x: sh.x, y: sh.y, vx: sh.vx, vy: sh.vy, heading });
        let crashed = false;
        for (let t = 0; t < 150; t++) {
          stepVectorFlight(probe, { ...NO_CONTROLS, thrust: 1 }, body, f, p, 12, W, H, tel);
          if (tel.impact > 0) {
            crashed = true;
            break;
          }
        }
        if (crashed) continue;
        const e = orbitalEnergy(probe.x, probe.y, probe.vx, probe.vy, body, f);
        if (e > best) {
          best = e;
          bestHeading = heading;
        }
      }
      return bestHeading;
    };
    const follow = (s0: ShipState, heading: number): { hit: boolean; out: number } => {
      const s: ShipState = { ...s0 };
      const tel = freshTelemetry();
      let hit = false;
      for (let t = 0; t < 360; t++) {
        const err = wrap(heading - s.heading);
        stepVectorFlight(s, { ...NO_CONTROLS, turn: Math.max(-1, Math.min(1, err / (p.turnRate / 60))), thrust: Math.abs(err) <= 0.35 ? 1 : 0 }, body, f, p, 12, W, H, tel);
        hit = hit || tel.impact >= 20;
        if (Math.hypot(s.x - BX, s.y - BY) >= SAFE) return { hit, out: (t + 1) / 60 };
      }
      return { hit, out: Infinity };
    };
    const acc = { old: { n: 0, hits: 0, out: 0, t: 0, lean: new Set<number>() }, now: { n: 0, hits: 0, out: 0, t: 0, lean: new Set<number>() } };
    let none = 0;
    let noneOldSurvives = 0;
    let total = 0;
    for (const r of [180, 230, 300, 380, 460]) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + 0.2;
        const ux = Math.sin(a);
        const uy = -Math.cos(a);
        for (const [vt, vr] of [[0, 0], [150, 0], [300, 0], [-200, -150], [100, 120], [0, -250]] as const) {
          for (const face of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
            const sh: ShipState = { x: BX + ux * r, y: BY + uy * r, vx: ux * vr - uy * vt, vy: uy * vr + ux * vt, heading: wrap(a + face), px: 0, py: 0, pheading: 0, thrusting: false, thrustX: 0, thrustY: 0 };
            total++;
            const adv = suggestEscape(sh, body, f, p, 12, W, H, 4, freshAdvice(), SAFE);
            const old = p01(sh);
            for (const [key, h] of [['old', old], ['now', adv.heading]] as const) {
              if (!Number.isFinite(h)) continue;
              const o = follow(sh, h);
              const m = acc[key];
              m.n++;
              if (o.hit) m.hits++;
              if (Number.isFinite(o.out)) {
                m.out++;
                m.t += o.out;
              }
              const outward = Math.atan2(ux, -uy);
              m.lean.add(Math.round((Math.abs(wrap(h - outward)) * 180) / Math.PI));
            }
            if (adv.status === 'none') {
              none++;
              if (Number.isFinite(old) && !follow(sh, old).hit) noneOldSurvives++;
            }
          }
        }
      }
    }
    const row = (name: string, m: typeof acc.old): string => `| ${name} | ${m.n}/${total} | ${m.hits} | ${m.out} | ${r1(m.t / Math.max(1, m.out))} | ${m.lean.size} |`;
    console.log(
      `\n### P02 escape advice before/after (${total} states; keyboard pilot turns at ${p.turnRate} rad/s, burns within 20°)\n| advice | states with a heading | follower touched the planet (≥ 20 px/s) | follower reached the field edge in 6 s | mean time to the edge (s) | distinct angles from radial (°, rounded) |\n|---|---|---|---|---|---|\n${row('P01 (instant turn, end energy)', acc.old)}\n${row('P02 (turn-then-burn rollouts, time to edge)', acc.now)}\n\nP02 'no safe escape': ${none} states; in ${noneOldSurvives} of them the P01 heading followed by the same pilot avoided the planet.`,
    );
    expect(total).toBeGreaterThan(0);
  }, 120_000);

  it('C with the assist on vs off (same pilot, same starts)', () => {
    const rows: string[] = ['| pilot | assist | mean damage | no-damage starts | shots | lost target | planet hits | assist Δv |', '|---|---|---|---|---|---|---|---|'];
    for (const id of ['C-215', 'C-low', 'A-north']) {
      for (const assist of [false, true]) {
        const out = starts(4).map((s) => flyC(s, strategy(id).make(), {}, 15, assist));
        rows.push(`| ${id} | ${assist ? 'on' : 'off'} | ${r1(mean(out, (o) => o.damage))} | ${out.filter((o) => o.damage === 0).length}/36 | ${r1(mean(out, (o) => o.shots))} | ${out.filter((o) => o.lockLost).length}/36 | ${out.reduce((s, o) => s + o.planetHits, 0)} | ${r0(mean(out, (o) => o.assistDv))} |`);
      }
    }
    console.log(`\n### P02 assist on/off\n${rows.join('\n')}`);
    expect(rows.length).toBe(8);
  }, 120_000);
});
