/**
 * P10.1 ship roster expansion and towable hull recovery
 * (docs/freeroam/SHIP_EXPANSION.md): the ten-ship catalogue, the two Raid
 * Boxes in their real sectors, the tow lifecycle on the real simulation
 * (sector/run.ts stepping the lazily loaded sector/tow.ts), station delivery,
 * persistence and the lazy recovery boundary.
 *
 * Physics checks fly a calm copy of the real Kestrel Verge layout (the same
 * landmarks, rocks, station and Raid Box; patrols, sites and hazards removed)
 * so no encounter can interrupt a measurement.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { SHIP_ABILITIES } from '../src/modes/freeroam/combat/shipAbilities.ts';
import { bodyBetween, effectiveRange, signature, STEALTH } from '../src/modes/freeroam/combat/stealth.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { EMPTY_PROFILE, loadProfile, saveProfile, withFleet, withSectorProgress } from '../src/modes/freeroam/profile.ts';
import { auditProfile } from '../src/modes/freeroam/saveAudit.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { buildGrid, canReach, reachable, solidsOf } from '../src/modes/freeroam/sector/grid.ts';
import { EMPTY_SECTOR_SAVE, type Landmark, type SectorLayout, type SectorSave } from '../src/modes/freeroam/sector/model.ts';
import { applyShip, attachRecovery, createSectorRun, disposeSectorRun, HULK_FOCUS, interact, isDone, pauseSector, restartSector, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import * as Tow from '../src/modes/freeroam/sector/tow.ts';
import { validateSector } from '../src/modes/freeroam/sector/validate.ts';
import { deriveShip } from '../src/modes/freeroam/ships/equipment.ts';
import { acquireShip, fleetFromSaved, fleetToSaved, recoverShip, selectShip, shipStatus, STARTER_FLEET, type FleetState } from '../src/modes/freeroam/ships/hangar.ts';
import { SHIP_BY_ID, SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import { SHIP_IDS, type ShipId } from '../src/modes/freeroam/ships/types.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const { TOW, spawnHulk, towLine, towMax, towPenalty, towStatus } = Tow;
const NONE: SectorInput = { moveX: 0, moveY: 0 };
const EAST: SectorInput = { moveX: 1, moveY: 0 };
const F: SectorInput = { moveX: 0, moveY: 0, ability: true };
const graph = buildNavGraph();
const SYSTEMS = getCatalogue().systems;
const KV = 'milky-way/kestrel-verge';
const LG = 'milky-way/lantern-gate';
const layoutOf = (id: string): SectorLayout => generateSector(SYSTEMS.find((s) => s.id === id)!, sectorContext(graph, id));
const REAL = { [KV]: layoutOf(KV), [LG]: layoutOf(LG) } as const;
/** The real layout without anything that could fight the pilot (same bodies, rocks, station, box). */
const calm = (id: keyof typeof REAL): SectorLayout => ({ ...REAL[id], patrols: [], sites: [], hazards: [], regions: [] });
const OPEN: SectorSave = { ...EMPTY_SECTOR_SAVE, done: ['raidbox'] };
const towEvents = (ev: readonly SectorEvent[]) => ev.flatMap((e) => (e.type === 'tow' ? [e] : []));
const granted = (ev: readonly SectorEvent[]): boolean => ev.some((e) => e.type === 'hullDelivered');
const yes = (): boolean => true;

/** A run in the calm Kestrel Verge copy with the Heron hull waiting (its box open unless `save` says otherwise). */
function kv(ship: ShipId = 'petrel', save: SectorSave = OPEN, kit: typeof Tow | null = Tow, L: SectorLayout = calm(KV)): SectorRun {
  const r = createSectorRun(L, save, { seed: 1, ship: deriveShip(ship), salvage: 'heron', recovery: kit });
  r.grace = 0;
  return r;
}
/** Park the ship (test setup only; the game moves it by flight) and refresh the focus with one idle tick. */
function park(r: SectorRun, x: number, y: number): SectorEvent[] {
  Object.assign(r.ship, { x, y, vx: 0, vy: 0 });
  return stepSector(r, NONE);
}
/** A run with the Heron hull on the tether (attached through the real INTERACT path). */
function towing(ship: ShipId = 'petrel', L?: SectorLayout): SectorRun {
  const r = kv(ship, OPEN, Tow, L);
  park(r, 600, 2450);
  expect(r.focus).toBe(HULK_FOCUS);
  expect(towEvents(interact(r)).map((e) => e.change)).toEqual(['attached']);
  return r;
}
const fly = (r: SectorRun, input: SectorInput, ticks: number): SectorEvent[] => {
  const out: SectorEvent[] = [];
  for (let i = 0; i < ticks; i++) out.push(...stepSector(r, input));
  return out;
};
const hullPose = (r: SectorRun) => (r.hulk ? { x: r.hulk.x, y: r.hulk.y, vx: r.hulk.vx, vy: r.hulk.vy, heading: r.hulk.heading, towed: r.hulk.towed, blocked: r.hulk.blocked } : null);
const body = (x: number, y: number, r: number): Landmark => ({ id: 'body-t', kind: 'body', style: 'gas', x, y, r, hazardR: 0, label: 'Test body' });

describe('P10.1 catalogue: ten ships, one roster', () => {
  it('appends the four hulls after the six originals with stable ids', () => {
    expect(SHIP_IDS).toEqual(['petrel', 'swift', 'shrike', 'condor', 'magpie', 'albatross', 'harrier', 'crane', 'heron', 'raven']);
    expect(SHIPS.map((s) => s.id)).toEqual([...SHIP_IDS]);
    expect(new Set(SHIPS.map((s) => s.sprite)).size).toBe(10);
  });

  it('keeps the six original ships exactly as they were (stats, licence, price)', () => {
    const line = (id: ShipId): string => {
      const s = SHIP_BY_ID.get(id)!;
      const b = s.base;
      return [b.hull, b.shield, b.shieldRegen, b.accel, b.maxSpeed, b.turnRate, b.energy, b.energyRegen, b.cargo, b.sensor, b.travel].join('/');
    };
    expect(line('petrel')).toBe('100/100/6/1150/340/9/100/20/60/900/1');
    expect(line('swift')).toBe('60/70/6/1400/400/12/90/22/30/1000/0.9');
    expect(line('shrike')).toBe('85/90/7/1350/380/11.5/80/20/35/750/1.1');
    expect(line('condor')).toBe('170/130/6/900/285/6.5/70/16/60/700/1.25');
    expect(line('magpie')).toBe('120/80/5/950/300/7/80/18/90/850/1.15');
    expect(line('albatross')).toBe('90/100/6/1000/370/7.5/110/20/60/1200/0.75');
    for (const id of ['petrel', 'swift', 'shrike', 'condor', 'magpie', 'albatross'] as const) {
      expect(SHIP_BY_ID.get(id)!.salvage, id).toBeUndefined();
      expect(SHIP_BY_ID.get(id)!.towRig, id).toBeUndefined();
    }
  });

  it('gives each ship its own signature ability through the one ability table', () => {
    expect(Object.fromEntries(SHIP_IDS.map((id) => [id, SHIP_ABILITIES[id]?.id]))).toEqual({
      petrel: 'signal-calibration', swift: 'vector-burst', shrike: 'predator-focus', condor: 'bulwark', magpie: 'salvage-pulse',
      albatross: 'deep-scan', harrier: 'pivot-jets', crane: 'winch-lock', heron: 'survey-sweep', raven: 'quiet-hull',
    });
  });

  it('new hulls: real stats, trade-offs against the ships they resemble, prices inside the existing band', () => {
    const b = (id: ShipId) => SHIP_BY_ID.get(id)!.base;
    for (const id of ['harrier', 'crane', 'heron', 'raven'] as const) {
      for (const v of Object.values(b(id))) expect(Number.isFinite(v) && v > 0, id).toBe(true);
    }
    // Harrier never beats the Swift and the Shrike everywhere
    expect(b('harrier').maxSpeed).toBeLessThan(b('swift').maxSpeed);
    expect(b('harrier').turnRate).toBeLessThan(b('swift').turnRate);
    expect(b('harrier').hull).toBeLessThan(b('shrike').hull);
    // Heron is no better Albatross; Raven is no faster Swift
    expect(b('heron').sensor).toBeLessThan(b('albatross').sensor);
    expect(b('heron').energy).toBeLessThan(b('albatross').energy);
    expect(b('raven').maxSpeed).toBeLessThan(b('swift').maxSpeed);
    // Crane: the tow rig, paid for in speed and turn
    expect(SHIP_BY_ID.get('crane')!.towRig).toBe(0.5);
    expect(b('crane').maxSpeed).toBeLessThan(b('petrel').maxSpeed);
    expect(b('crane').turnRate).toBeLessThan(b('petrel').turnRate);
    const units = (id: ShipId): number => SHIP_BY_ID.get(id)!.cost.reduce((s, c) => s + c.amount, 0);
    const sold = (['swift', 'shrike', 'condor', 'magpie', 'albatross'] as const).map(units);
    for (const id of ['harrier', 'crane'] as const) {
      expect(units(id)).toBeGreaterThanOrEqual(Math.min(...sold));
      expect(units(id)).toBeLessThanOrEqual(Math.max(...sold));
      expect(SHIP_BY_ID.get(id)!.licence.length, id).toBeGreaterThan(0);
    }
  });

  it('Harrier and Crane follow the purchase rules; Heron and Raven are never for sale', () => {
    const cargo = { alloy: 99, fuel: 99, scrap: 99 };
    for (const id of ['harrier', 'crane'] as const) {
      expect(shipStatus(STARTER_FLEET, id, () => false, cargo)).toBe('locked');
      expect(shipStatus(STARTER_FLEET, id, yes, {})).toBe('unaffordable');
      expect(shipStatus(STARTER_FLEET, id, yes, cargo)).toBe('available');
      const a = acquireShip(STARTER_FLEET, cargo, id, yes);
      expect(a.ok && a.fleet.owned.includes(id)).toBe(true);
      expect(recoverShip(STARTER_FLEET, id)).toBeNull(); // a sold ship is never handed out by a recovery
    }
    for (const id of ['heron', 'raven'] as const) {
      const d = SHIP_BY_ID.get(id)!;
      expect(d.cost).toEqual([]);
      expect(d.licence).toEqual([]);
      expect(shipStatus(STARTER_FLEET, id, yes, cargo)).toBe('locked');
      expect(acquireShip(STARTER_FLEET, cargo, id, yes)).toEqual({ ok: false, reason: 'locked' });
      expect(selectShip(STARTER_FLEET, id, true)).toEqual({ ok: false, reason: 'not-owned' });
    }
  });

  it('invalid or unknown ids unlock nothing', () => {
    for (const id of ['', 'falcon', 'HERON', 'heron ', 'raidbox', '__proto__', 'constructor']) {
      expect(recoverShip(STARTER_FLEET, id), id).toBeNull();
      expect(acquireShip(STARTER_FLEET, { alloy: 99 }, id, yes)).toEqual({ ok: false, reason: 'unknown' });
    }
    expect(spawnHulk('petrel')).toBeNull();
    expect(spawnHulk('harrier')).toBeNull();
    expect(spawnHulk('falcon' as ShipId)).toBeNull();
  });
});

describe('P10.1 Raid Boxes: two authored discoveries in real sectors', () => {
  const ALL = SYSTEMS.map((s) => generateSector(s, sectorContext(graph, s.id)));

  it('exactly two boxes in the whole catalogue: the Heron in Kestrel Verge, the Raven in Lantern Gate', () => {
    const boxes = ALL.flatMap((L) => L.pois.filter((p) => p.kind === 'raidbox').map((p) => [L.systemId, p.id, p.target, p.x, p.y]));
    expect(boxes).toEqual([
      [KV, 'raidbox', 'heron', 600, 2400],
      [LG, 'raidbox', 'raven', 600, 900],
    ]);
    for (const L of ALL) expect(L.pois.filter((p) => p.kind === 'raidbox').length).toBeLessThanOrEqual(1);
    // separate recovery identities: one ship per box, one box per sector, each sector's done list its own
    expect(SHIPS.filter((s) => s.salvage).map((s) => [s.id, s.salvage!.system])).toEqual([['heron', KV], ['raven', LG]]);
  });

  it('placement is deterministic, inside the sector, clear of solids and hazards, reachable from the arrival, with a station to deliver to', () => {
    for (const id of [KV, LG] as const) {
      const L = REAL[id];
      expect(layoutOf(id)).toEqual(L);
      expect(validateSector(L, SYSTEMS.find((s) => s.id === id)!, sectorContext(graph, id))).toEqual([]);
      const ship = SHIPS.find((s) => s.salvage?.system === id)!;
      const grid = buildGrid(L.width, L.height, solidsOf(L));
      const seen = reachable(grid, L.spawns[0]!);
      for (const [x, y] of [ship.salvage!.box, ship.salvage!.hull]) {
        expect(x > 100 && y > 100 && x < L.width - 100 && y < L.height - 100).toBe(true);
        for (const c of solidsOf(L)) expect(Math.hypot(c.x - x, c.y - y), `${id} ${x},${y}`).toBeGreaterThan(c.r + ship.radius + 20);
        for (const z of L.hazards) expect(Math.hypot(z.x - x, z.y - y)).toBeGreaterThan(z.r + 60);
        expect(Math.hypot(L.arrival.x - x, L.arrival.y - y)).toBeGreaterThan(L.arrival.r);
        expect(canReach(grid, seen, { x, y }, 40)).toBe(true);
      }
      const station = L.pois.find((p) => p.kind === 'station')!;
      expect(station).toBeDefined();
      expect(canReach(grid, seen, station, station.r)).toBe(true);
    }
  });

  it('opening a box reveals the disabled hull at its rest point and grants nothing', () => {
    const r = kv('petrel', EMPTY_SECTOR_SAVE);
    expect(r.hulk).toBeNull();
    park(r, 600, 2420);
    expect(r.focus).toBe('raidbox');
    const ev = interact(r);
    expect(ev).toEqual([{ type: 'raidBox', id: 'raidbox', ship: 'heron' }]);
    expect(r.done.has('raidbox')).toBe(true);
    expect(hullPose(r)).toEqual({ x: 600, y: 2550, vx: 0, vy: 0, heading: 2.4, towed: false, blocked: 0 });
    expect(r.salvage).toBe('heron');
    // a second press finds nothing; the box never spawns a second hull
    stepSector(r, NONE);
    expect(r.focus).not.toBe('raidbox');
    expect(interact(r).some((e) => e.type === 'raidBox')).toBe(false);
  });

  it('an opened, unrecovered hull is there again on the next visit at the same pose; a recovered one never comes back', () => {
    const again = kv('petrel', OPEN);
    expect(hullPose(again)).toEqual({ x: 600, y: 2550, vx: 0, vy: 0, heading: 2.4, towed: false, blocked: 0 });
    // the shell passes salvage = null once the ship is owned: the box stays shut for good, no hull, no prompt
    const done = createSectorRun(calm(KV), EMPTY_SECTOR_SAVE, { seed: 1, ship: deriveShip('petrel'), salvage: null, recovery: Tow });
    expect(done.salvage).toBeNull();
    expect(isDone(done, done.layout.pois.find((p) => p.kind === 'raidbox')!)).toBe(true);
    park(done, 600, 2420);
    expect(done.focus).toBeNull();
    expect(done.hulk).toBeNull();
  });

  it('a salvage id that does not belong to this sector is ignored (no hull, no tow state)', () => {
    for (const s of ['raven', 'harrier', 'petrel'] as const) {
      const r = createSectorRun(calm(KV), OPEN, { seed: 1, ship: deriveShip('petrel'), salvage: s, recovery: Tow });
      expect(r.salvage, s).toBeNull();
      expect(r.hulk).toBeNull();
      expect(r.recovery).toBeNull();
    }
  });
});

describe('P10.1 lazy recovery boundary', () => {
  it('without the recovery chunk the box stays shut (no partial state) and the run behaves as before', () => {
    const r = kv('petrel', EMPTY_SECTOR_SAVE, null);
    expect(r.recovery).toBeNull();
    park(r, 600, 2420);
    expect(r.focus).toBe('raidbox');
    const before = [...r.done];
    expect(interact(r)).toEqual([{ type: 'recoveryPending', ship: 'heron' }]);
    expect([...r.done]).toEqual(before);
    expect(r.hulk).toBeNull();
    // flying on without it: no penalty, no hull, no tow events
    const ev = fly(r, EAST, 120);
    expect(towEvents(ev)).toEqual([]);
    expect(Math.hypot(r.ship.vx, r.ship.vy)).toBeGreaterThan(300);
  });

  it('attaching the chunk later opens the box normally; an already-open box shows its hull at the rest point', () => {
    const r = kv('petrel', EMPTY_SECTOR_SAVE, null);
    attachRecovery(r, Tow);
    expect(r.recovery).toBe(Tow);
    expect(r.hulk).toBeNull(); // the box is still shut
    park(r, 600, 2420);
    expect(interact(r)).toEqual([{ type: 'raidBox', id: 'raidbox', ship: 'heron' }]);
    const open = kv('petrel', OPEN, null);
    expect(open.hulk).toBeNull();
    attachRecovery(open, Tow);
    expect(hullPose(open)).toEqual(hullPose(kv('petrel', OPEN, Tow)));
  });

  it('attaches once, never to a disposed run or a sector without an unrecovered hull', () => {
    const r = kv('petrel', OPEN, null);
    attachRecovery(r, Tow);
    const h = r.hulk;
    attachRecovery(r, Tow);
    expect(r.hulk).toBe(h);
    const gone = kv('petrel', OPEN, null);
    disposeSectorRun(gone);
    attachRecovery(gone, Tow);
    expect(gone.recovery).toBeNull();
    const none = createSectorRun(calm(KV), OPEN, { seed: 1, ship: deriveShip('petrel') });
    attachRecovery(none, Tow);
    expect(none.recovery).toBeNull();
    expect(none.hulk).toBeNull();
  });

  it('only types of sector/tow.ts are imported eagerly; the shell loads it with one cached dynamic import', () => {
    const src = (p: string): string => readFileSync(new URL(`../src/modes/freeroam/${p}`, import.meta.url), 'utf8');
    for (const p of ['sector/run.ts', 'sector/render.ts', 'freeRoamMode.ts']) {
      for (const m of src(p).matchAll(/^import\s+(type\s+)?[^;]*from '\.\/(?:sector\/)?tow\.ts';$/gm)) expect(m[1], `${p}: ${m[0]}`).toBeTruthy();
    }
    const shell = src('freeRoamMode.ts');
    expect(shell.match(/import\('\.\/sector\/tow\.ts'\)/g)).toHaveLength(1);
    expect(shell).toMatch(/recoveryLoad \?\?= import\('\.\/sector\/tow\.ts'\)\.then\(/);
    // a failed load is forgotten so the next request retries, and it never touches the run
    expect(shell).toMatch(/\(\) => \{\s*recoveryLoad = null;\s*recoveryFailed = true;/);
    // RESTART FLIGHT reports a tow it ended (the run returns it; the shell shows it like any other end)
    expect(shell).toMatch(/for \(const e of restartSector\(run\)\) if \(e\.type === 'tow'\) handleEvent\(/);
    // delivery reads only run.hulk: it is in run.ts, not in the lazy chunk
    expect(src('sector/run.ts')).toMatch(/type: 'hullDelivered', ship: h\.ship, station: p\.id/);
    expect(src('sector/tow.ts')).not.toMatch(/hullDelivered/);
  });
});

describe('P10.1 towing', () => {
  it('TOW HULL refusals name the real reason and change nothing', () => {
    // out of reach
    const far = kv();
    park(far, 600, 2300);
    expect(far.focus).not.toBe(HULK_FOCUS);
    expect(Tow.toggleTow(far)).toEqual([{ type: 'tow', change: 'refused', ship: 'heron', why: 'range' }]);
    // too fast relative to the hull
    const fast = kv();
    park(fast, 600, 2450);
    fast.ship.vx = TOW.attachSpeed + 1;
    const before = hullPose(fast);
    expect(interact(fast)).toEqual([{ type: 'tow', change: 'refused', ship: 'heron', why: 'speed' }]);
    expect(hullPose(fast)).toEqual(before);
    // a celestial body on the line
    const L = calm(KV);
    const walled = kv('petrel', OPEN, Tow, { ...L, landmarks: [...L.landmarks, body(600, 2500, 12)] });
    park(walled, 600, 2450);
    expect(walled.focus).toBe(HULK_FOCUS);
    expect(interact(walled)).toEqual([{ type: 'tow', change: 'refused', ship: 'heron', why: 'blocked' }]);
    expect(walled.hulk!.towed).toBe(false);
    // the refusal lines (the shell's notices) name the same reasons
    expect(towLine({ change: 'refused', why: 'range' })[0]).toBe('TOW · OUT OF REACH');
    expect(towLine({ change: 'refused', why: 'speed' })[0]).toBe('TOW · TOO FAST');
    expect(towLine({ change: 'refused', why: 'blocked' })[0]).toBe('TOW · LINE BLOCKED');
  });

  it('attaches only in flight, undocked and not paused; one hull at a time', () => {
    const r = kv();
    park(r, 600, 2450);
    pauseSector(r);
    expect(Tow.toggleTow(r)).toEqual([]);
    expect(interact(r)).toEqual([]);
    const t = towing();
    expect(t.hulk!.towed).toBe(true);
    expect(towStatus(t).state).toBe('towed');
    // INTERACT on the hull again releases it (the same key; RELEASE TOW)
    expect(towEvents(interact(t)).map((e) => e.change)).toEqual(['released']);
  });

  it('the hull follows continuously (no jump) within the tether, turning and stopping included, and settles without oscillating', () => {
    const r = towing();
    let prev = { x: r.hulk!.x, y: r.hulk!.y };
    let maxStep = 0;
    let maxGap = 0;
    const track = (input: SectorInput, ticks: number): number[] => {
      const gaps: number[] = [];
      for (let i = 0; i < ticks; i++) {
        const ev = stepSector(r, input);
        expect(towEvents(ev)).toEqual([]);
        maxStep = Math.max(maxStep, Math.hypot(r.hulk!.x - prev.x, r.hulk!.y - prev.y));
        prev = { x: r.hulk!.x, y: r.hulk!.y };
        const g = towStatus(r).distance;
        maxGap = Math.max(maxGap, g);
        gaps.push(g);
      }
      return gaps;
    };
    track(EAST, 300); // straight run
    for (let k = 0; k < 600; k++) track({ moveX: Math.cos(k / 60), moveY: Math.sin(k / 60) }, 1); // a full turn
    const stop = track(NONE, 900); // hard stop: the line goes slack, the hull coasts on and is caught once
    expect(r.hulk!.towed).toBe(true);
    expect(maxStep).toBeLessThan(8); // px per tick: never a teleport
    expect(maxGap).toBeLessThan(TOW.maxLength * 0.7);
    // after the catch the distance converges: at most one turn-around in the last 600 ticks, and the hull is at rest
    const tail = stop.slice(300);
    let turns = 0;
    for (let i = 2; i < tail.length; i++) if (Math.sign(tail[i]! - tail[i - 1]!) * Math.sign(tail[i - 1]! - tail[i - 2]!) < 0) turns += 1;
    expect(turns).toBeLessThanOrEqual(1);
    expect(Math.hypot(r.hulk!.vx, r.hulk!.vy)).toBeLessThan(0.5);
    expect(tail.at(-1)!).toBeGreaterThan(TOW.rest - 20);
    expect(tail.at(-1)!).toBeLessThanOrEqual(TOW.rest + 5);
  });

  it('is deterministic: the same inputs give the same hull path', () => {
    const path = (): number[] => {
      const r = towing();
      const out: number[] = [];
      for (let i = 0; i < 400; i++) {
        stepSector(r, i % 120 < 60 ? EAST : { moveX: 0, moveY: 1 });
        out.push(r.hulk!.x, r.hulk!.y);
      }
      return out;
    };
    expect(path()).toEqual(path());
  });

  it('penalties are temporary modifiers: thrust and top speed drop while towing and come back on release', () => {
    expect(towPenalty(kv())).toEqual({ accel: 1, speed: 1 });
    const r = towing('petrel');
    expect(towPenalty(r)).toEqual({ accel: TOW.accelMul, speed: TOW.speedMul });
    fly(r, EAST, 300);
    expect(Math.hypot(r.ship.vx, r.ship.vy)).toBeCloseTo(r.tune.maxSpeed * TOW.speedMul, 0);
    expect(r.tune.maxSpeed).toBe(deriveShip('petrel').stats.maxSpeed); // the stored tuning is never rewritten
    park(r, r.ship.x, r.ship.y);
    Object.assign(r.hulk!, { x: r.ship.x - 100, y: r.ship.y, vx: 0, vy: 0 });
    stepSector(r, NONE);
    expect(towEvents(interact(r)).map((e) => e.change)).toEqual(['released']);
    expect(towPenalty(r)).toEqual({ accel: 1, speed: 1 });
    fly(r, EAST, 300);
    expect(Math.hypot(r.ship.vx, r.ship.vy)).toBeGreaterThan(r.tune.maxSpeed * 0.95);
  });

  it('the Crane tows better through the same state (half the penalty); any ship can tow', () => {
    const c = towing('crane');
    expect(towPenalty(c)).toEqual({ accel: 1 - (1 - TOW.accelMul) * 0.5, speed: 1 - (1 - TOW.speedMul) * 0.5 });
    fly(c, EAST, 300);
    expect(Math.hypot(c.ship.vx, c.ship.vy)).toBeCloseTo(c.tune.maxSpeed * (1 - (1 - TOW.speedMul) * 0.5), 0);
    for (const s of ['swift', 'condor', 'harrier', 'raven'] as const) expect(towing(s).hulk!.towed, s).toBe(true);
  });

  it('Winch Lock: refused without a tow, cancels the penalty and lengthens the line, and ends with the tow', () => {
    const idle = kv('crane');
    park(idle, 600, 2300);
    expect(stepSector(idle, F).some((e) => e.type === 'ability' && e.change === 'refused' && e.why === 'noTow')).toBe(true);
    const r = towing('crane');
    expect(stepSector(r, F).some((e) => e.type === 'ability' && e.id === 'winch-lock' && e.change === 'start')).toBe(true);
    expect(towPenalty(r)).toEqual({ accel: 1, speed: 1 });
    expect(towMax(r)).toBe(TOW.maxLength * 1.5);
    // 300 px would snap a plain line; under Winch Lock it holds
    Object.assign(r.hulk!, { x: r.ship.x - 300, y: r.ship.y, vx: 0, vy: 0 });
    expect(towEvents(stepSector(r, NONE))).toEqual([]);
    const cd = r.ability.cooldown;
    Object.assign(r.hulk!, { x: r.ship.x - 400 });
    const ev = stepSector(r, NONE);
    expect(towEvents(ev).map((e) => e.change)).toEqual(['snapped']);
    expect(ev.some((e) => e.type === 'ability' && e.id === 'winch-lock' && e.change === 'end')).toBe(true);
    expect(r.ability.active).toBe(0);
    expect(r.ability.cooldown).toBeGreaterThanOrEqual(cd - 1); // the cooldown is kept, never refunded
    expect(towMax(r)).toBe(TOW.maxLength);
  });

  it('overstretch snaps the line at the documented maximum and leaves the hull where it is', () => {
    const r = towing();
    Object.assign(r.hulk!, { x: r.ship.x - (TOW.maxLength - 5), y: r.ship.y, vx: 0, vy: 0 });
    // P10.2: just inside the limit the line holds (one STRAINED warning, still towed)
    expect(towEvents(stepSector(r, NONE))).toEqual([{ type: 'tow', change: 'strained', ship: 'heron' }]);
    expect(r.hulk!.towed).toBe(true);
    const pose = { x: r.ship.x - (TOW.maxLength + 5), y: r.ship.y };
    Object.assign(r.hulk!, { ...pose, vx: 0, vy: 0 });
    const ev = stepSector(r, NONE);
    expect(towEvents(ev)).toEqual([{ type: 'tow', change: 'snapped', ship: 'heron' }]);
    expect(granted(ev)).toBe(false);
    expect(r.hulk!.towed).toBe(false);
    expect(Math.hypot(r.hulk!.x - pose.x, r.hulk!.y - pose.y)).toBeLessThan(1);
    expect(towPenalty(r)).toEqual({ accel: 1, speed: 1 });
  });

  it('a celestial body across the line releases the tow after blockTicks, not before', () => {
    const L = calm(KV);
    const r = towing('petrel', { ...L, landmarks: [...L.landmarks] });
    // a small body appears on the line (test geometry; the line is checked every tick)
    (r.layout.landmarks as Landmark[]).push(body((r.ship.x + r.hulk!.x) / 2, (r.ship.y + r.hulk!.y) / 2 + 4, 6));
    const changes: string[] = [];
    let at = -1;
    for (let i = 0; i < TOW.blockTicks + 5 && at < 0; i++) {
      Object.assign(r.ship, { vx: 0, vy: 0 });
      const ev = towEvents(stepSector(r, NONE));
      if (ev.length) {
        at = i + 1;
        changes.push(...ev.map((e) => e.change));
      }
    }
    expect(changes).toEqual(['blocked']);
    expect(at).toBe(TOW.blockTicks);
    expect(r.hulk!.towed).toBe(false);
  });

  it('the towed hull collides with celestial bodies and is never pushed inside one', () => {
    const r = towing();
    const star = r.layout.landmarks.find((l) => l.kind === 'star')!;
    Object.assign(r.hulk!, { x: star.x - star.r - 40, y: star.y, vx: 400, vy: 0, towed: false });
    for (let i = 0; i < 120; i++) {
      stepSector(r, NONE);
      expect(Math.hypot(r.hulk!.x - star.x, r.hulk!.y - star.y)).toBeGreaterThanOrEqual(star.r + r.hulk!.r - 0.01);
    }
  });

  it('every interruption ends the tow, keeps the hull in place and grants nothing: release, restart, recall, ship change, pause, sector exit', () => {
    // release
    const a = towing();
    fly(a, EAST, 60);
    const at = { x: a.hulk!.x, y: a.hulk!.y };
    const rel = interact(a);
    expect(towEvents(rel).map((e) => e.change)).toEqual(['released']);
    expect({ x: a.hulk!.x, y: a.hulk!.y }).toEqual(at);
    expect(granted([...rel, ...fly(a, NONE, 300)])).toBe(false);
    // restart
    const b = towing();
    fly(b, EAST, 60);
    const bh = { x: b.hulk!.x, y: b.hulk!.y };
    const rs = restartSector(b);
    expect(towEvents(rs).map((e) => e.change)).toEqual(['lost']);
    expect(b.hulk!.towed).toBe(false);
    expect({ x: b.hulk!.x, y: b.hulk!.y }).toEqual(bh);
    expect(granted(rs)).toBe(false);
    // recall (the hull fails)
    const c = towing();
    c.hull = 0;
    const rc = stepSector(c, NONE);
    expect(rc.map((e) => e.type)).toEqual(expect.arrayContaining(['wrecked', 'tow', 'recalled']));
    expect(towEvents(rc).map((e) => e.change)).toEqual(['lost']);
    expect(c.hulk!.towed).toBe(false);
    expect(granted(rc)).toBe(false);
    // ship change (the shell does it docked; applyShip itself always drops the tow)
    const d = towing();
    applyShip(d, deriveShip('crane'));
    expect(d.hulk!.towed).toBe(false);
    expect(towPenalty(d)).toEqual({ accel: 1, speed: 1 });
    // pause freezes the hull (no step while paused)
    const e = towing();
    fly(e, EAST, 30);
    const frozen = hullPose(e);
    pauseSector(e);
    fly(e, EAST, 120);
    expect(hullPose(e)).toEqual(frozen);
    // sector exit: the run is disposed, nothing dangles; the next visit starts with the hull at rest
    const f = towing();
    fly(f, EAST, 60);
    disposeSectorRun(f);
    expect(f.hulk).toBeNull();
    expect(stepSector(f, EAST)).toEqual([]);
    expect(hullPose(kv())).toEqual({ x: 600, y: 2550, vx: 0, vy: 0, heading: 2.4, towed: false, blocked: 0 });
  });

  it('boost, Silent Running and abilities stay available while towing; the tow penalty applies on top', () => {
    const r = towing('petrel');
    const ev = stepSector(r, { ...NONE, silentToggle: true });
    expect(r.silent).toBe(true);
    expect(ev.some((e) => e.type === 'tow')).toBe(false);
    expect(signature(r)).toBe(STEALTH.silent);
    fly(r, { ...EAST, boost: true }, 120);
    expect(r.hulk!.towed).toBe(true);
    expect(towPenalty(r)).toEqual({ accel: TOW.accelMul, speed: TOW.speedMul });
  });
});

describe('P10.1 station delivery', () => {
  /** Tow the Heron hull to the Kestrel Verge station: fly the real line (the ship is parked off the dock, the hull follows by flight). */
  function deliver(ship: ShipId = 'petrel') {
    const r = towing(ship);
    const st = r.layout.pois.find((p) => p.kind === 'station')!;
    // fly toward the station until the dock prompt answers (reach r + ship radius; the line clears the star)
    for (let i = 0; i < 2400 && r.focus !== st.id; i++) {
      const dx = st.x - r.ship.x;
      const dy = st.y - r.ship.y;
      const d = Math.hypot(dx, dy);
      expect(towEvents(stepSector(r, d > 100 ? { moveX: dx / d, moveY: dy / d } : NONE))).toEqual([]);
      if (d <= 100) Object.assign(r.ship, { vx: 0, vy: 0 });
    }
    expect(r.focus).toBe(st.id);
    expect(r.hulk!.towed).toBe(true);
    return { r, st };
  }

  it('docking at a real station with the hull on the line delivers it exactly once', () => {
    const { r, st } = deliver();
    const ev = interact(r);
    expect(ev.map((e) => e.type)).toEqual(['hullDelivered', 'docked']);
    expect(ev[0]).toEqual({ type: 'hullDelivered', ship: 'heron', station: st.id });
    expect(r.hulk).toBeNull();
    expect(r.salvage).toBeNull();
    expect(r.docked).toBe(st.id);
    // dock again (repeat interaction): only a docking, never a second delivery
    r.docked = null;
    stepSector(r, NONE);
    if (r.focus === st.id) expect(granted(interact(r))).toBe(false);
    // the shell's grant refuses a repeat
    const once = recoverShip(STARTER_FLEET, 'heron')!;
    expect(once.owned).toEqual(['petrel', 'heron']);
    expect(once.active).toBe('petrel');
    expect(recoverShip(once, 'heron')).toBeNull();
  });

  it('a hull left resting (not on the line) is not delivered by docking', () => {
    const r = kv();
    const st = r.layout.pois.find((p) => p.kind === 'station')!;
    park(r, st.x, st.y + st.r - 10);
    expect(r.focus).toBe(st.id);
    expect(interact(r).map((e) => e.type)).toEqual(['docked']);
    expect(r.hulk).not.toBeNull();
    expect(r.salvage).toBe('heron');
  });

  it('the Raven recovery works the same way in Lantern Gate (box, hull, tow, station)', () => {
    const L = calm(LG);
    const r = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 1, ship: deriveShip('crane'), salvage: 'raven', recovery: Tow });
    r.grace = 0;
    park(r, 600, 930);
    expect(interact(r)).toEqual([{ type: 'raidBox', id: 'raidbox', ship: 'raven' }]);
    park(r, 600, 960);
    expect(r.focus).toBe(HULK_FOCUS);
    expect(towEvents(interact(r)).map((e) => e.change)).toEqual(['attached']);
    const st = L.pois.find((p) => p.kind === 'station')!;
    for (let i = 0; i < 2400 && r.focus !== st.id; i++) {
      const dx = st.x - r.ship.x;
      const dy = st.y - r.ship.y;
      const d = Math.hypot(dx, dy);
      expect(towEvents(stepSector(r, d > 100 ? { moveX: dx / d, moveY: dy / d } : NONE))).toEqual([]);
      if (d <= 100) Object.assign(r.ship, { vx: 0, vy: 0 });
    }
    expect(interact(r)[0]).toEqual({ type: 'hullDelivered', ship: 'raven', station: st.id });
  });
});

describe('P10.1 persistence', () => {
  const recovered = (f: FleetState, ...ids: ShipId[]): FleetState => ids.reduce((x, id) => recoverShip(x, id) ?? x, f);

  it('a legacy save (no recovery anywhere) loads with both recovery ships locked and nothing else changed', () => {
    const store = new MemoryStore();
    expect(saveProfile(store, EMPTY_PROFILE)).toBe(true);
    const loaded = loadProfile(store).data;
    const fleet = fleetFromSaved(loaded.fleet);
    expect(fleet.owned).toEqual(['petrel']);
    for (const id of ['heron', 'raven'] as const) expect(shipStatus(fleet, id, yes, { alloy: 99 })).toBe('locked');
    expect(auditProfile(graph, loaded).changed).toBe(0);
  });

  it('a recovery persists across save and load (the ship owned, the box done), with cargo, marks and missions untouched', () => {
    let p = withSectorProgress(EMPTY_PROFILE, KV, ['raidbox', 'station']);
    p = withFleet(p, fleetToSaved(recovered(STARTER_FLEET, 'heron')));
    const store = new MemoryStore();
    expect(saveProfile(store, p)).toBe(true);
    const raw = store.read('galaxia:freeroam')!;
    // only ids are stored: no tether geometry, no hull pose, no active ability or tow state
    expect(raw).not.toMatch(/hulk|towed|tether|"blocked"|winch/);
    const back = loadProfile(store).data;
    expect(back.sectors[KV]!.done).toEqual(expect.arrayContaining(['raidbox', 'station']));
    const fleet = fleetFromSaved(back.fleet);
    expect(fleet.owned).toEqual(['petrel', 'heron']);
    expect(shipStatus(fleet, 'heron', yes, {})).toBe('owned');
    expect(shipStatus(fleet, 'raven', yes, {})).toBe('locked');
    expect(back.cargo).toEqual(EMPTY_PROFILE.cargo);
    expect(back.progression).toEqual(EMPTY_PROFILE.progression);
    const audit = auditProfile(graph, back);
    expect(audit.changed).toBe(0);
    expect(audit.profile.fleet.owned).toEqual(['petrel', 'heron']);
    // the next entry of Kestrel Verge: owned, so the shell passes no salvage and the box stays shut
    const r = createSectorRun(calm(KV), back.sectors[KV]!, { seed: 1, ship: deriveShip('heron'), salvage: null, recovery: Tow });
    expect(r.hulk).toBeNull();
  });

  it('unknown ship ids in a save are normalized away; they never unlock a recovery ship', () => {
    const p = withFleet(EMPTY_PROFILE, { active: 'falcon', owned: ['petrel', 'falcon', 'heron-mk2'], loadouts: {} });
    const audit = auditProfile(graph, p);
    expect(audit.profile.fleet.owned).toEqual(['petrel']);
    expect(audit.profile.fleet.active).toBe('petrel');
    expect(audit.changed).toBeGreaterThan(0);
    expect(fleetFromSaved(p.fleet).owned).toEqual(['petrel']);
  });

  it('the Raid Box done id passes the save filter; a mangled id is dropped', () => {
    const store = new MemoryStore();
    saveProfile(store, withSectorProgress(EMPTY_PROFILE, LG, ['raidbox']));
    const raw = JSON.parse(store.read('galaxia:freeroam')!) as { sectors: Record<string, { done: string[] }> };
    expect(loadProfile(store).data.sectors[LG]!.done).toEqual(['raidbox']);
    raw.sectors[LG]!.done = ['raidbox', 'raidbox-heron', 'RAIDBOX'];
    store.write('galaxia:freeroam', JSON.stringify(raw));
    expect(loadProfile(store).data.sectors[LG]!.done).toEqual(['raidbox']);
  });
});

describe('P10.1 abilities keep the earlier systems intact', () => {
  it('Quiet Hull caps the signature at 0.6, never below Silent Running, and leaves sight lines and memory alone', () => {
    const r = createSectorRun(calm(LG), EMPTY_SECTOR_SAVE, { seed: 1, ship: deriveShip('raven') });
    r.grace = 0;
    park(r, 1400, 2200);
    expect(signature(r)).toBe(1);
    expect(stepSector(r, F).some((e) => e.type === 'ability' && e.id === 'quiet-hull' && e.change === 'start')).toBe(true);
    expect(signature(r)).toBe(0.6);
    expect(effectiveRange(1000, signature(r))).toBe(600);
    r.silent = true;
    expect(signature(r)).toBe(STEALTH.silent);
    expect(STEALTH.memoryTicks).toBe(75);
    const star = r.layout.landmarks.find((l) => l.kind === 'star')!;
    expect(bodyBetween(r.layout.landmarks, star.x - 300, star.y, star.x + 300, star.y)).toBe(star);
    // other ships are untouched by the cap
    const p = createSectorRun(calm(LG), EMPTY_SECTOR_SAVE, { seed: 1, ship: deriveShip('petrel') });
    expect(signature(p)).toBe(1);
  });

  it('Pivot Jets turns the nose faster only while active; Survey Sweep widens only survey marks', () => {
    const turn = (active: boolean): number => {
      const r = createSectorRun(calm(KV), { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 1, ship: deriveShip('harrier') });
      r.grace = 0;
      park(r, 2000, 1600);
      r.ship.heading = 0;
      if (active) stepSector(r, F);
      const h0 = r.ship.heading;
      stepSector(r, { moveX: -1, moveY: 0.0001 });
      return Math.abs(r.ship.heading - h0);
    };
    expect(turn(true)).toBeGreaterThan(turn(false) * 1.5);
    const heron = createSectorRun(calm(KV), EMPTY_SECTOR_SAVE, { seed: 1, ship: deriveShip('heron') });
    heron.grace = 0;
    const mark = heron.layout.pois.find((p) => p.kind === 'survey')!;
    park(heron, mark.x + mark.r * 3, mark.y);
    expect(heron.done.has(mark.id)).toBe(false);
    stepSector(heron, F);
    stepSector(heron, NONE);
    expect(heron.done.has(mark.id)).toBe(true);
  });
});

/* ------------------------------------------------------------------ P10.2 */

/** The Crane's Winch Lock entry, narrowed (the one ability table). */
const WINCH = SHIP_ABILITIES.crane as Extract<(typeof SHIP_ABILITIES)[ShipId], { id: 'winch-lock' }>;

describe('P10.2 tow HUD: every prompt and warning reads the simulation', () => {
  const { towRefusal, towPrompt, toggleTow } = Tow;
  /** The press outcome for a verdict: what toggleTow must do when the prompt shows `why`. */
  const pressFor = (why: string | null) => (why === null ? ['attached'] : why === 'state' ? [] : ['refused']);

  it('one attach check: the cached prompt verdict, towRefusal and the press always agree', () => {
    const L = calm(KV);
    const cases: { name: string; want: string | null; make: () => SectorRun }[] = [
      { name: 'in reach, still', want: null, make: () => { const r = kv(); park(r, 600, 2450); return r; } },
      { name: 'out of reach', want: 'range', make: () => { const r = kv(); park(r, 600, 2300); return r; } },
      { name: 'too fast', want: 'speed', make: () => { const r = kv(); park(r, 600, 2450); r.ship.vx = TOW.attachSpeed + 60; stepSector(r, NONE); return r; } },
      { name: 'a body on the line', want: 'blocked', make: () => { const r = kv('petrel', OPEN, Tow, { ...L, landmarks: [...L.landmarks, body(600, 2500, 12)] }); park(r, 600, 2450); return r; } },
    ];
    for (const c of cases) {
      const r = c.make();
      const why = towRefusal(r);
      expect(why, c.name).toBe(c.want);
      expect(r.hulk!.attach, `${c.name}: cached after the tick`).toBe(why);
      expect(towStatus(r).attach, c.name).toBe(why);
      const p = towPrompt(r, 'hulk');
      expect(p.main, c.name).toBe('TOW HULL · HERON');
      expect(p.state, c.name).toBe(why === null || why === 'range' ? 'ready' : 'refused');
      expect(p.sub, c.name).toBe(why === 'speed' ? 'TOO FAST · MATCH ITS SPEED' : why === 'blocked' ? 'LINE BLOCKED BY A BODY' : '');
      const ev = toggleTow(r);
      expect(ev.map((e) => (e.type === 'tow' ? e.change : e.type)), c.name).toEqual(pressFor(why));
      if (why && why !== 'state') expect(ev[0]).toEqual({ type: 'tow', change: 'refused', ship: 'heron', why });
    }
    // no attach outside flight: towRefusal says 'state' and the press does nothing
    const paused = kv();
    park(paused, 600, 2450);
    pauseSector(paused);
    expect(towRefusal(paused)).toBe('state');
    expect(toggleTow(paused)).toEqual([]);
    // while towing the attach verdict is 'state' (a press releases instead)
    expect(towRefusal(towing())).toBe('state');
  });

  it('towPrompt: the hull, attached status, station delivery and leaving, from the run alone', () => {
    const none = { main: null, sub: '', state: '', risk: 'ok' };
    expect(towPrompt(createSectorRun(calm(KV), EMPTY_SECTOR_SAVE, { seed: 1, ship: deriveShip('petrel') }), 'hulk')).toEqual(none);
    const rest = kv();
    park(rest, 600, 2450);
    expect(towPrompt(rest, 'station')).toEqual(none); // a resting hull says nothing for another focus
    const r = towing();
    const p = towPrompt(r, 'hulk');
    expect(p.main).toBe('RELEASE TOW · HERON');
    expect(p.state).toBe('towing');
    expect(p.risk).toBe('ok');
    const m = /^TOW ATTACHED · (\d+)\/(\d+)$/.exec(p.sub);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBe(TOW.maxLength);
    expect(Math.abs(Number(m![1]) - towStatus(r).distance)).toBeLessThanOrEqual(5); // rounded to 10 px
    expect(Number(m![1]) % 10).toBe(0);
    expect(towPrompt(r, 'station')).toMatchObject({ main: null, state: 'towing', sub: expect.stringMatching(/^DELIVERS THE HERON · \d+\/260$/) });
    expect(towPrompt(r, 'gate').sub).toBe('TOWING HERON · LEAVING DROPS THE TOW');
    expect(towPrompt(r, 'exit').sub).toBe('TOWING HERON · LEAVING DROPS THE TOW');
    expect(towPrompt(r, null).sub).toMatch(/^TOW ATTACHED · /);
    // the prompt is read-only: asking changes nothing in the run
    const pose = hullPose(r);
    for (let i = 0; i < 5; i++) towPrompt(r, 'hulk');
    expect(hullPose(r)).toEqual(pose);
  });

  it('strain: one warning per stretch, re-armed only well inside the limit (no flicker on the boundary)', () => {
    const r = towing();
    const hold = (len: number): ReturnType<typeof towEvents> => {
      Object.assign(r.ship, { vx: 0, vy: 0 });
      Object.assign(r.hulk!, { x: r.ship.x - len, y: r.ship.y, vx: 0, vy: 0 });
      return towEvents(stepSector(r, NONE));
    };
    const max = TOW.maxLength;
    expect(hold(max * 0.7)).toEqual([]); // under strainAt: nothing
    expect(towStatus(r).risk).toBe('ok');
    expect(hold(max * 0.85)).toEqual([{ type: 'tow', change: 'strained', ship: 'heron' }]);
    expect(towStatus(r).risk).toBe('strain');
    expect(towPrompt(r, 'hulk').sub).toMatch(/ · STRAINED$/);
    let more = 0;
    for (let i = 0; i < 60; i++) more += hold(max * 0.85).length;
    expect(more).toBe(0); // held strained: no repeat
    // hovering around the threshold (between strainClear and strainAt) never re-warns
    for (let i = 0; i < 60; i++) more += hold(max * (i % 2 ? 0.79 : 0.81)).length;
    expect(more).toBe(0);
    expect(hold(max * 0.7)).toEqual([]); // above strainClear: still latched
    expect(hold(max * 0.85)).toEqual([]);
    expect(hold(max * 0.5)).toEqual([]); // well inside: re-armed
    expect(hold(max * 0.85).map((e) => e.change)).toEqual(['strained']);
    expect(r.hulk!.towed).toBe(true);
    expect(towLine({ change: 'strained' })).toEqual(['TOW LINE STRAINED · EASE OFF OR IT SNAPS', 'warn']);
    // Winch Lock lengthens the line, so the same stretch is no strain for the Crane
    const c = towing('crane');
    stepSector(c, F);
    expect(towStatus(c).maxLength).toBe(Math.round(TOW.maxLength * WINCH.tetherMul));
    Object.assign(c.hulk!, { x: c.ship.x - max * 0.85, y: c.ship.y, vx: 0, vy: 0 });
    Object.assign(c.ship, { vx: 0, vy: 0 });
    expect(towEvents(stepSector(c, NONE))).toEqual([]);
    expect(towStatus(c).risk).toBe('ok');
  });

  it('a body on the line shows LINE BLOCKED from the run, with no warning notice before the cut', () => {
    const L = calm(KV);
    const r = towing('petrel', { ...L, landmarks: [...L.landmarks] });
    (r.layout.landmarks as Landmark[]).push(body((r.ship.x + r.hulk!.x) / 2, (r.ship.y + r.hulk!.y) / 2 + 4, 6));
    Object.assign(r.ship, { vx: 0, vy: 0 });
    expect(towEvents(stepSector(r, NONE))).toEqual([]);
    expect(towStatus(r).risk).toBe('blocked');
    expect(towPrompt(r, 'hulk')).toMatchObject({ risk: 'blocked', sub: expect.stringMatching(/ · LINE BLOCKED$/) });
    const changes: string[] = [];
    for (let i = 0; i < TOW.blockTicks; i++) {
      Object.assign(r.ship, { vx: 0, vy: 0 });
      changes.push(...towEvents(stepSector(r, NONE)).map((e) => e.change));
    }
    expect(changes).toEqual(['blocked']);
    expect(towLine({ change: 'blocked' })[0]).toBe('TOW LINE CUT BY A BODY · HULL LEFT BEHIND');
  });

  it('every ending is reported exactly once with its real cause; delivery is the only grant', () => {
    // RESTART FLIGHT: one 'lost' with the cause; a second restart reports nothing
    const a = towing();
    const rs = towEvents(restartSector(a));
    expect(rs).toEqual([{ type: 'tow', change: 'lost', ship: 'heron', cause: 'restart' }]);
    expect(towLine(rs[0]!)[0]).toBe('TOW LOST · HULL LEFT BEHIND · FLIGHT RESTARTED');
    expect(towEvents(restartSector(a))).toEqual([]);
    // wreck: one 'lost' with the cause, then nothing more on later ticks
    const b = towing();
    b.hull = 0;
    const wr = towEvents(stepSector(b, NONE));
    expect(wr).toEqual([{ type: 'tow', change: 'lost', ship: 'heron', cause: 'wreck' }]);
    expect(towLine(wr[0]!)[0]).toBe('TOW LOST · HULL LEFT BEHIND · SHIP WRECKED');
    expect(towEvents(fly(b, NONE, 120))).toEqual([]);
    // release and a repeated end: one event, then endTow is a no-op
    const c = towing();
    const rel = towEvents(interact(c));
    expect(rel).toEqual([{ type: 'tow', change: 'released', ship: 'heron' }]);
    expect(towLine(rel[0]!)).toEqual(['TOW RELEASED · HULL LEFT HERE', 'info']);
    const extra: SectorEvent[] = [];
    Tow.endTow(c, 'snapped', extra);
    expect(extra).toEqual([]);
    // the latch never outlives a tow: a fresh attach can warn again
    const d = towing();
    Object.assign(d.hulk!, { x: d.ship.x - TOW.maxLength * 0.85, y: d.ship.y, vx: 0, vy: 0 });
    expect(towEvents(stepSector(d, NONE)).map((e) => e.change)).toEqual(['strained']);
    interact(d);
    expect(d.hulk!.strained).toBe(false);
    // no tow event ever claims a recovery; only hullDelivered does (tested end to end in 'station delivery')
    for (const e of [...rs, ...wr, ...rel]) expect(e.type).toBe('tow');
  });

  it('the shell routes each tow change through towLine and reports a sector exit once, never on quit', () => {
    const shell = readFileSync(new URL('../src/modes/freeroam/freeRoamMode.ts', import.meta.url), 'utf8');
    // the prompt reads towPrompt; it never calls the attach check or the line-of-sight test itself
    expect(shell).toMatch(/r\.recovery\.towPrompt\(r, /);
    expect(shell).not.toMatch(/towRefusal|bodyBetween\(/);
    // one interact path: the existing button and key; no new listener for the tow
    expect(shell.match(/interactBtn\.addEventListener\(/g)?.length).toBe(1);
    // the sector-exit note: in leaveSector, only while towing and not on dispose
    const leave = shell.slice(shell.indexOf('const leaveSector = '), shell.indexOf('const leaveSector = ') + 600);
    expect(leave).toMatch(/run\.hulk\?\.towed && lifecycle !== 'disposed'/);
    expect(leave).toMatch(/TOW LOST · LEFT THE SECTOR/);
  });
});

describe('P10.2 Hangar and guide: per-ship data from the one catalogue', () => {
  it('each of the ten ships renders its own name, sprite, role, ability, stats and acquisition', async () => {
    const { shipAsFlown, statusOf, yardHighlights } = await import('../src/modes/freeroam/ships/hangarView.ts');
    const { abilityOf } = await import('../src/modes/freeroam/combat/shipAbilities.ts');
    const cx = { fleet: STARTER_FLEET, cargo: { scrap: 40, alloy: 40, fuel: 40 }, licenceMet: () => false, levels: () => ({}) };
    const rows = SHIP_IDS.map((id) => {
      const d = SHIP_BY_ID.get(id)!;
      const ab = abilityOf(id)!;
      return { id, name: d.name, sprite: d.sprite, role: d.role, ability: ab.name, summary: ab.summary, stats: JSON.stringify(shipAsFlown(cx, id).stats), status: statusOf(cx, id), highs: yardHighlights(id).map((h) => h.key) };
    });
    for (const k of ['name', 'sprite', 'ability', 'summary', 'stats'] as const) expect(new Set(rows.map((r) => r[k])).size, k).toBe(10);
    for (const r of rows) {
      expect(r.ability, r.id).toBe(SHIP_ABILITIES[r.id].name);
      expect(r.stats, r.id).toBe(JSON.stringify(deriveShip(r.id).stats)); // stock fit, no stale modifiers
      expect(r.highs.includes('tow'), r.id).toBe(r.id === 'crane');
      expect(r.highs.includes('recovered'), r.id).toBe(r.id === 'heron' || r.id === 'raven');
    }
    // recovery ships: locked with no price; after recovery owned and selectable
    for (const id of ['heron', 'raven'] as const) {
      expect(SHIP_BY_ID.get(id)!.cost).toEqual([]);
      expect(statusOf({ ...cx, licenceMet: yes }, id)).toBe('locked');
      const f = recoverShip(STARTER_FLEET, id)!;
      expect(statusOf({ ...cx, fleet: f }, id)).toBe('owned');
      expect(selectShip(f, id, false)).toEqual({ ok: false, reason: 'unsafe' }); // only docked
      expect(selectShip(f, id, true)).toEqual({ ok: true, fleet: { ...f, active: id } });
    }
    // the panel reads the ability from the table and prints no price for a recovery hull
    const panel = readFileSync(new URL('../src/modes/freeroam/ships/hangarPanel.ts', import.meta.url), 'utf8');
    expect(panel).toMatch(/abilityOf\(inspected\)/);
    expect(panel).toMatch(/RECOVERY · OPEN THE RAID BOX IN \$\{label\(ship\.salvage\.system/);
  });

  it('How to Play and PLAYER_GUIDE give the recovery loop with the real places and figures', async () => {
    const { DEFAULT_GUIDE_CONTEXT, guideStep, stepText } = await import('../src/modes/guide/guideContent.ts');
    const text = stepText(guideStep('ships', { ...DEFAULT_GUIDE_CONTEXT, mode: 'freeroam' }));
    for (const id of ['heron', 'raven'] as const) {
      const sys = SYSTEMS.find((s) => s.id === SHIP_BY_ID.get(id)!.salvage!.system)!;
      expect(text, id).toContain(sys.name);
    }
    for (let i = 1; i <= 10; i++) expect(text).toContain(`${i} · `);
    expect(text).toMatch(/WINCH LOCK/);
    expect(text).not.toMatch(/admin/i);
    const doc = readFileSync(new URL('../docs/PLAYER_GUIDE.md', import.meta.url), 'utf8');
    const sec = doc.slice(doc.indexOf('### Recovering a hull'), doc.indexOf('## Armory'));
    expect(sec).toContain('Kestrel Verge');
    expect(sec).toContain('Lantern Gate');
    for (let i = 1; i <= 10; i++) expect(sec).toMatch(new RegExp(`^${i}\\. \\*\\*`, 'm'));
    // figures pinned to the simulation
    expect(sec).toContain(`${TOW.maxLength}; ${TOW.maxLength * WINCH.tetherMul} under Winch Lock`);
    expect(sec).toContain(`Past ${TOW.strainAt * 100}% of its limit`);
    expect(sec).toContain(`under ${TOW.attachSpeed}`);
    expect(TOW.blockTicks).toBe(30); // "half a second"
    expect(sec).toContain(`(${SHIP_ABILITIES.crane.durationTicks / 60} s active, ${SHIP_ABILITIES.crane.cooldownTicks / 60} s cooldown)`);
    expect(sec).not.toMatch(/admin|change ships, or leave/i);
    // every tow log line in the doc is one the game prints
    for (const line of [towLine({ change: 'released' })[0], towLine({ change: 'snapped' })[0], towLine({ change: 'strained' })[0], towLine({ change: 'lost', cause: 'wreck' })[0], towLine({ change: 'lost', cause: 'restart' })[0]]) expect(sec, line).toContain(line);
  });
});
