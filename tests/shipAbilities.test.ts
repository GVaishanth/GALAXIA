/**
 * P08.1 Ship Signature Abilities (combat/shipAbilities.ts, sector/run.ts
 * activateAbility and the effect boundaries in sector/run.ts, combat/world.ts,
 * combat/playerMissile.ts and sector/signal.ts) on the real sector simulation.
 * Fixed seeds, fixed 60 Hz ticks, no clock. The definitions are imported, never
 * copied: every number below comes from SHIP_ABILITIES or the existing tables.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADMIN_SEQUENCE } from '../src/modes/freeroam/admin/activation.ts';
import { DEFAULT_BINDINGS, FLIGHT_ACTIONS, PANEL_KEYS, sanitizeBindings, trackedCodes, ZOOM_KEYS } from '../src/modes/freeroam/bindings.ts';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import { MISSILE } from '../src/modes/freeroam/combat/playerMissile.ts';
import {
  abilityGate,
  abilityLine,
  abilityOf,
  abilityStatus,
  calibration,
  endAbility,
  focusKeepCone,
  focusLockTicks,
  freshAbility,
  incomingDamageMul,
  SHIP_ABILITIES,
  tickAbility,
  type AbilityDef,
} from '../src/modes/freeroam/combat/shipAbilities.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import { damageAgent, damagePlayer } from '../src/modes/freeroam/combat/world.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { PAD } from '../src/modes/freeroam/input.ts';
import { EMPTY_PROFILE, FREEROAM_VERSION, saveProfile } from '../src/modes/freeroam/profile.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE, type Landmark, type Poi, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { applyShip, createSectorRun, disposeSectorRun, interact, pauseSector, restartSector, resumeSector, setRunFlightMode, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { bearingSpread, signalSource, signalView } from '../src/modes/freeroam/sector/signal.ts';
import { deriveShip } from '../src/modes/freeroam/ships/equipment.ts';
import { spawnHulk } from '../src/modes/freeroam/sector/tow.ts';
import { SHIP_BY_ID, SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import { SHIP_IDS, type ShipId } from '../src/modes/freeroam/ships/types.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import { STORAGE_KEYS } from '../src/shared/persistence/namespaces.ts';
import { arena } from './helpers/combatProbe.ts';
import { FlightPointers } from '../src/modes/freeroam/pointers.ts';
import { drawScanMarks, type CombatView } from '../src/modes/freeroam/sector/combatRender.ts';
import { abilityHud } from '../src/modes/freeroam/ui/hudModel.ts';
import { rebind } from '../src/modes/freeroam/bindings.ts';
import { ABILITY_GUIDE, DEFAULT_GUIDE_CONTEXT, freeRoamController, freeRoamKeyboard, freeRoamTouch, guideStep, stepText } from '../src/modes/guide/guideContent.ts';

const NONE: SectorInput = { moveX: 0, moveY: 0 };
const F: SectorInput = { moveX: 0, moveY: 0, ability: true };
const graph = buildNavGraph();
const SYSTEMS = getCatalogue().systems;
const ALL: readonly SectorLayout[] = SYSTEMS.map((s) => generateSector(s, sectorContext(graph, s.id)));
const SAMPLE = (kind: Poi['kind']): Poi => ALL.flatMap((L) => L.pois).find((p) => p.kind === kind)!;
const BODY = ALL.flatMap((L) => L.landmarks).find((l) => l.kind === 'body')!;

type Pt = { x: number; y: number };
const def = <I extends AbilityDef['id']>(ship: ShipId): Extract<AbilityDef, { id: I }> => SHIP_ABILITIES[ship] as Extract<AbilityDef, { id: I }>;
const abilityEvents = (ev: readonly SectorEvent[]) => ev.flatMap((e) => (e.type === 'ability' ? [e] : []));
const changes = (ev: readonly SectorEvent[]): string[] => abilityEvents(ev).map((e) => (e.change === 'refused' ? `refused:${e.why}` : e.change));

/** An empty, calm arena copy with only these POIs (and extras); the ship parked in the middle, nose up. */
function world(pois: readonly Poi[] = [], extra: Partial<SectorLayout> = {}): SectorLayout {
  const base = arena(3);
  return { ...base, landmarks: [], regions: [], rocks: [], patrols: [], sites: [], hazards: [], veins: [], pois: [...base.pois.filter((p) => p.kind === 'exit'), ...pois], ...extra };
}
function setup(ship: ShipId, L: SectorLayout = world(), seed = 3, extra: Parameters<typeof createSectorRun>[2] = {}): SectorRun {
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed, ship: deriveShip(ship), ...extra });
  r.grace = 1e9; // no enemy fire: these tests are about the ability
  place(r, mid(L));
  r.ship.heading = 0;
  return r;
}
const mid = (L: SectorLayout): Pt => ({ x: Math.round(L.width / 2), y: Math.round(L.height / 2) });
const place = (r: SectorRun, at: Pt): void => {
  Object.assign(r.ship, { x: at.x, y: at.y, px: at.x, py: at.y, vx: 0, vy: 0 });
};
/** n ticks of `input` (the ship held at `at` when given). */
function fly(r: SectorRun, n: number, input: SectorInput = NONE, at: Pt | null = null): SectorEvent[] {
  const out: SectorEvent[] = [];
  for (let i = 0; i < n; i++) {
    if (at) place(r, at);
    out.push(...stepSector(r, input));
  }
  return out;
}
const foe = (r: SectorRun, dx: number, dy: number): Agent => {
  const a = spawnAgent(r, 'heavy', 'red-tally', 'test', 'guard', r.ship.x + dx, r.ship.y + dy);
  if (!a) throw new Error('spawn refused');
  return a;
};
const poi = (kind: Poi['kind'], id: string, at: Pt): Poi => ({ ...SAMPLE(kind), id, x: at.x, y: at.y }) as Poi;
const planet = (id: string, at: Pt, r = 70): Landmark => ({ ...BODY, id, label: 'Test world', x: at.x, y: at.y, r, solidR: r, hazardR: 0 }) as Landmark;

/** A run where the ship's ability has something to act on (a hostile, a signal, salvage), so every ship can activate. */
function ready(ship: ShipId): SectorRun {
  const L0 = world();
  const c = mid(L0);
  const L = ship === 'petrel' ? world([poi('anomaly', 'sig-1', { x: c.x + 400, y: c.y })]) : ship === 'magpie' ? world([poi('salvage', 'salv-1', { x: c.x + 1200, y: c.y })]) : ship === 'heron' ? world([poi('survey', 'survey-9', { x: c.x + 1400, y: c.y })]) : L0;
  const r = ship === 'heron' ? createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 3, ship: deriveShip(ship) }) : setup(ship, L);
  if (ship === 'heron') {
    r.grace = 1e9; // P10.1 Survey Sweep needs a mark still to record (an unsurveyed sector)
    place(r, c);
    r.ship.heading = 0;
  }
  if (ship === 'petrel') r.revealed.add('sig-1');
  if (ship === 'shrike') foe(r, 0, -400);
  if (ship === 'crane') r.hulk = { ...spawnHulk('heron')!, x: c.x, y: c.y + 100, px: c.x, py: c.y + 100, towed: true }; // P10.1 Winch Lock needs a tow
  return r;
}

/* -------------------------------------------------------------- definitions */

describe('P08.1 ability definitions (one frozen table, by stable ship id)', () => {
  it('every ship has exactly one distinct ability, keyed by its id; names come from the table only', () => {
    expect(Object.keys(SHIP_ABILITIES).sort()).toEqual([...SHIP_IDS].sort());
    const ids = SHIP_IDS.map((s) => SHIP_ABILITIES[s].id);
    expect(new Set(ids).size).toBe(SHIP_IDS.length);
    expect(Object.fromEntries(SHIP_IDS.map((s) => [s, SHIP_ABILITIES[s].name]))).toEqual({
      swift: 'Vector Burst',
      shrike: 'Predator Focus',
      petrel: 'Signal Calibration',
      magpie: 'Salvage Pulse',
      condor: 'Bulwark',
      albatross: 'Deep Scan',
      harrier: 'Pivot Jets',
      crane: 'Winch Lock',
      heron: 'Survey Sweep',
      raven: 'Quiet Hull',
    });
    for (const s of SHIP_IDS) {
      const d = SHIP_ABILITIES[s];
      expect(d.ship).toBe(s);
      expect(d.summary.length).toBeGreaterThan(20);
      expect(d.summary.length).toBeLessThanOrEqual(60);
      expect(d.tag).toMatch(/^[A-Z]{3,8}$/);
      expect(Object.isFrozen(d)).toBe(true);
    }
    expect(Object.isFrozen(SHIP_ABILITIES)).toBe(true);
  });

  it('durations and cooldowns are whole ticks inside the P08.1 targets; the cooldown always outlasts the effect', () => {
    // [min s, max s] duration and cooldown targets from the P08.1 brief
    const T: Record<ShipId, [number, number, number, number]> = { swift: [1.5, 2, 22, 28], shrike: [4, 6, 25, 32], petrel: [6, 8, 25, 35], magpie: [5, 7, 25, 35], condor: [3.5, 4.5, 35, 45], albatross: [5, 8, 30, 40], harrier: [2, 4, 22, 28], crane: [5, 7, 25, 35], heron: [5, 7, 25, 35], raven: [4, 6, 30, 40] }; // P10.1 targets for the four new hulls
    for (const s of SHIP_IDS) {
      const d = SHIP_ABILITIES[s];
      const [d0, d1, c0, c1] = T[s];
      expect(Number.isInteger(d.durationTicks) && Number.isInteger(d.cooldownTicks), s).toBe(true);
      expect(d.durationTicks).toBeGreaterThanOrEqual(d0 * 60);
      expect(d.durationTicks).toBeLessThanOrEqual(d1 * 60);
      expect(d.cooldownTicks).toBeGreaterThanOrEqual(c0 * 60);
      expect(d.cooldownTicks).toBeLessThanOrEqual(c1 * 60);
      expect(d.cooldownTicks).toBeGreaterThan(d.durationTicks);
    }
    // bounded tuning (no meaningless and no extreme effect)
    expect(def<'vector-burst'>('swift').speedMul).toBeGreaterThan(1.2);
    expect(def<'vector-burst'>('swift').speedMul).toBeLessThan(1.5);
    expect(def<'predator-focus'>('shrike').lockMul).toBeGreaterThanOrEqual(0.4);
    expect(def<'signal-calibration'>('petrel').spreadMul).toBeGreaterThanOrEqual(0.4);
    const bw = def<'bulwark'>('condor').damageMul;
    expect(1 - bw).toBeGreaterThanOrEqual(0.2);
    expect(1 - bw).toBeLessThanOrEqual(0.25);
  });

  it('lookup is by ship id only: display names, prototype keys and junk have no ability', () => {
    expect(abilityOf('swift')?.id).toBe('vector-burst');
    for (const junk of ['Swift', 'Petrel', 'PETREL', 'constructor', '__proto__', 'toString', '', null, undefined, 3, {}]) expect(abilityOf(junk)).toBeNull();
    // the module never reads the roster (no display-name matching) and imports nothing at runtime
    const code = readFileSync('src/modes/freeroam/combat/shipAbilities.ts', 'utf8');
    for (const m of code.matchAll(/^import\s+(type\s+)?[^;]*;/gm)) expect(m[1], m[0]).toBeTruthy();
    expect(code).not.toMatch(/SHIP_BY_ID|SHIPS\b|\.name\s*===/);
  });

  it('the state helpers: tick counts down to 0 and never below; edges fire once; end keeps the cooldown', () => {
    const st = freshAbility();
    expect(tickAbility(st)).toEqual({ end: false, ready: false });
    Object.assign(st, { active: 2, cooldown: 3, contacts: [{ id: 'x', kind: 'salvage', x: 0, y: 0 }] });
    expect(tickAbility(st)).toEqual({ end: false, ready: false });
    expect(tickAbility(st)).toEqual({ end: true, ready: false });
    expect(st.contacts).toEqual([]);
    expect(tickAbility(st)).toEqual({ end: false, ready: true });
    for (let i = 0; i < 5; i++) tickAbility(st);
    expect([st.active, st.cooldown]).toEqual([0, 0]);
    Object.assign(st, { active: 9, cooldown: 99, refused: 'cooling' });
    endAbility(st);
    expect([st.active, st.cooldown, st.refused]).toEqual([0, 99, null]);
    Object.assign(st, { cooldown: 1, refused: 'noTarget' });
    expect(tickAbility(st)).toEqual({ end: false, ready: true });
    expect(st.refused).toBeNull();
  });

  it('notice lines come from the table (one corner-log line each)', () => {
    expect(abilityLine({ id: 'vector-burst', change: 'start' })).toBe('VECTOR BURST ACTIVE');
    expect(abilityLine({ id: 'deep-scan', change: 'start', found: 3 })).toBe('DEEP SCAN ACTIVE · 3 FOUND');
    expect(abilityLine({ id: 'bulwark', change: 'end' })).toBe('BULWARK ENDED');
    expect(abilityLine({ id: 'bulwark', change: 'ready' })).toBe('BULWARK READY');
    expect(abilityLine({ id: 'predator-focus', change: 'refused', why: 'noTarget' })).toBe('PREDATOR FOCUS · NO TARGET');
    expect(abilityLine({ id: 'salvage-pulse', change: 'refused', why: 'cooling', ticks: 61 })).toBe('SALVAGE PULSE · COOLING 2 s');
    expect(abilityLine({ id: null, change: 'refused', why: 'unavailable' })).toBe('SHIP ABILITY · UNAVAILABLE');
  });
});

/* ------------------------------------------------- activation and cooldown */

describe('P08.1 activation, duration and cooldown (every ship, simulation ticks only)', () => {
  for (const ship of SHIP_IDS) {
    it(`${ship}: one press = one activation; exact duration; refused while active or cooling (nothing consumed); ready exactly once; usable again`, () => {
      const d = SHIP_ABILITIES[ship];
      const r = ready(ship);
      const at = { x: r.ship.x, y: r.ship.y };
      let ev = fly(r, 1, F, at);
      expect(changes(ev)).toEqual(['start']);
      expect([r.ability.active, r.ability.cooldown, r.ability.uses]).toEqual([d.durationTicks, d.cooldownTicks, 1]);
      // held / repeated input: refused every tick, never stacks or extends, never resets the cooldown
      ev = fly(r, d.durationTicks - 1, F, at);
      expect(abilityEvents(ev).every((e) => e.change === 'refused' && e.why === 'active')).toBe(true);
      expect(r.ability.active).toBe(1);
      expect(r.ability.uses).toBe(1);
      ev = fly(r, 1, NONE, at);
      expect(changes(ev)).toEqual(['end']);
      expect(r.ability.active).toBe(0);
      ev = fly(r, 1, F, at);
      expect(changes(ev)).toEqual(['refused:cooling']);
      const e = abilityEvents(ev)[0]!;
      expect(e.ticks).toBe(r.ability.cooldown);
      expect(r.ability.cooldown).toBe(d.cooldownTicks - d.durationTicks - 1);
      ev = fly(r, r.ability.cooldown - 1, NONE, at);
      expect(changes(ev)).toEqual([]);
      ev = fly(r, 1, NONE, at);
      expect(changes(ev)).toEqual(['ready']);
      expect(r.ability.cooldown).toBe(0);
      expect(abilityStatus(r)).toMatchObject({ available: true, reason: null }); // the earlier COOLING refusal is not left behind
      ev = fly(r, 1, F, at);
      expect(changes(ev)).toEqual(['start']);
      expect(r.ability.uses).toBe(2);
    });
  }

  it('pause freezes the effect and the cooldown; resume continues from the same tick', () => {
    const r = ready('condor');
    fly(r, 1, F);
    fly(r, 30);
    const snap = { ...r.ability };
    pauseSector(r);
    for (let i = 0; i < 500; i++) expect(stepSector(r, F)).toEqual([]);
    expect([r.ability.active, r.ability.cooldown, r.ability.uses]).toEqual([snap.active, snap.cooldown, snap.uses]);
    expect(abilityStatus(r)).toMatchObject({ available: false, reason: 'paused', active: true });
    resumeSector(r);
    fly(r, 1);
    expect([r.ability.active, r.ability.cooldown]).toEqual([snap.active - 1, snap.cooldown - 1]);
  });

  it('an unknown ship fails safe: refused as unavailable, nothing consumed, every effect query neutral', () => {
    const r = setup('petrel');
    r.craft = { ...r.craft, ship: 'ghost' as ShipId };
    const ev = fly(r, 1, F);
    expect(changes(ev)).toEqual(['refused:unavailable']);
    expect(abilityEvents(ev)[0]!.id).toBeNull();
    expect(r.ability).toMatchObject({ active: 0, cooldown: 0, uses: 0 });
    r.ability.active = 50; // even with a stray active count
    expect([incomingDamageMul(r, 'fire'), focusLockTicks(r, 18), focusKeepCone(r, 1), calibration(r)]).toEqual([1, 18, 1, 1]);
    expect(abilityStatus(r)).toMatchObject({ id: null, available: false, reason: 'unavailable' });
  });

  it('the status snapshot is read-only and accurate through activation, cooldown, refusal and ready', () => {
    const r = ready('swift');
    const d = SHIP_ABILITIES.swift;
    expect(abilityStatus(r)).toEqual({ id: 'vector-burst', name: 'Vector Burst', tag: 'BURST', summary: d.summary, available: true, active: false, activeTicks: 0, durationTicks: d.durationTicks, cooldownTicks: 0, cooldownMax: d.cooldownTicks, reason: null, contacts: [] });
    fly(r, 1, F);
    expect(abilityStatus(r)).toMatchObject({ available: false, active: true, activeTicks: d.durationTicks, cooldownTicks: d.cooldownTicks, reason: 'active' });
    fly(r, d.durationTicks);
    expect(abilityStatus(r)).toMatchObject({ active: false, activeTicks: 0, reason: 'cooling', cooldownTicks: d.cooldownTicks - d.durationTicks });
    const s = abilityStatus(r);
    (s as { cooldownTicks: number }).cooldownTicks = 0; // mutating a snapshot changes nothing
    expect(r.ability.cooldown).toBe(d.cooldownTicks - d.durationTicks);
    fly(r, r.ability.cooldown);
    expect(abilityStatus(r)).toMatchObject({ available: true, reason: null });
  });
});

/* ------------------------------------------------------------- each ability */

describe('P08.1 Swift · Vector Burst (the existing flight path, no teleport)', () => {
  const thrust: SectorInput = { moveX: 1, moveY: 0 };
  const speed = (r: SectorRun): number => Math.hypot(r.ship.vx, r.ship.vy);

  it('the same thrust reaches a higher, bounded speed; no jump per tick; the cap returns by the end; no energy spent', () => {
    const a = setup('swift');
    const b = setup('swift');
    fly(b, 1, { ...thrust, ability: true });
    fly(a, 1, thrust);
    const e0 = b.energy;
    const d = def<'vector-burst'>('swift');
    let maxStep = 0;
    let top = 0;
    for (let i = 1; i < d.durationTicks; i++) {
      const x = b.ship.x;
      fly(a, 1, thrust);
      fly(b, 1, thrust);
      maxStep = Math.max(maxStep, Math.abs(b.ship.x - x));
      top = Math.max(top, speed(b));
    }
    expect(top).toBeGreaterThan(a.tune.maxSpeed * 1.2);
    expect(top).toBeLessThanOrEqual(b.tune.maxSpeed * d.speedMul + 1e-6);
    expect(maxStep).toBeLessThanOrEqual((b.tune.maxSpeed * d.speedMul) / 60 + 1e-6);
    expect(b.ship.x).toBeGreaterThan(a.ship.x + 40); // it really carried the ship further
    expect(b.energy).toBeGreaterThanOrEqual(e0); // no boost energy used
    fly(b, 2, thrust);
    expect(b.ability.active).toBe(0);
    expect(speed(b)).toBeLessThanOrEqual(b.tune.maxSpeed + 1e-6);
    expect(b.craft.stats).toEqual(deriveShip('swift').stats); // no permanent stat change
    expect(b.tune).toEqual(a.tune);
  });

  it('steering stays with the pilot (a reversed stick turns the ship around) and with no thrust nothing moves', () => {
    const r = setup('swift');
    const at = { x: r.ship.x, y: r.ship.y };
    fly(r, 1, F);
    fly(r, 20);
    expect(Math.hypot(r.ship.x - at.x, r.ship.y - at.y)).toBe(0);
    fly(r, 20, { moveX: 1, moveY: 0 });
    expect(r.ship.vx).toBeGreaterThan(0);
    fly(r, 40, { moveX: -1, moveY: 0 });
    expect(r.ship.vx).toBeLessThan(0);
  });

  it('never stacks with boost (the larger multiplier wins) and keeps collisions: a rock still stops the ship', () => {
    const L = world();
    const c = mid(L);
    const both = setup('swift', L);
    const boostOnly = setup('swift', L);
    fly(both, 1, { moveX: 1, moveY: 0, boost: true, ability: true });
    fly(boostOnly, 1, { moveX: 1, moveY: 0, boost: true });
    let top = 0;
    let topB = 0;
    for (let i = 0; i < 60; i++) {
      fly(both, 1, { moveX: 1, moveY: 0, boost: true });
      fly(boostOnly, 1, { moveX: 1, moveY: 0, boost: true });
      top = Math.max(top, speed(both));
      topB = Math.max(topB, speed(boostOnly));
    }
    expect(top).toBeLessThanOrEqual(both.tune.maxSpeed * Math.max(1.45, def<'vector-burst'>('swift').speedMul) + 1e-6);
    expect(Math.abs(top - topB)).toBeLessThan(both.tune.maxSpeed * 0.05);
    const rock = { id: 'rock-t', x: c.x + 160, y: c.y, r: 40 };
    const R = setup('swift', world([], { rocks: [rock as never] }));
    fly(R, 1, { moveX: 1, moveY: 0, ability: true });
    fly(R, 60, { moveX: 1, moveY: 0 });
    expect(R.ship.x).toBeLessThanOrEqual(rock.x - rock.r - R.tune.radius + 1);
  });

  it('works through REALISTIC flight too (the same tuning), and a flight-mode change keeps the effect', () => {
    const a = setup('swift', world(), 3, { flightMode: 'realistic' });
    const b = setup('swift', world(), 3, { flightMode: 'realistic' });
    const v = { moveX: 0, moveY: 0, vector: { turn: 0, thrust: 1, reverse: 0, strafe: 0 } } as unknown as SectorInput;
    fly(b, 1, { ...v, ability: true });
    for (let i = 0; i < 90; i++) {
      fly(a, 1, v);
      fly(b, 1, v);
    }
    expect(speed(b)).toBeGreaterThan(speed(a));
    setRunFlightMode(b, 'normal');
    expect(b.ability.active).toBeGreaterThan(0);
  });
});

describe('P08.1 Shrike · Predator Focus (the existing lock, bounded)', () => {
  const LOCK_FIRST = { compatible: ['plasma', 'lock-missile'], rotation: ['plasma', 'lock-missile'], start: 'lock-missile' } as const;
  const shrike = (): SectorRun => setup('shrike', world(), 3, { loadout: LOCK_FIRST });
  const PRESS: SectorInput = { moveX: 0, moveY: 0, fire: true };
  function launchTick(r: SectorRun, a: Agent): number {
    const at = { x: a.x, y: a.y };
    for (let t = 1; t <= 60; t++) {
      Object.assign(a, { x: at.x, y: at.y, vx: 0, vy: 0 });
      const ev = fly(r, 1, t === 1 ? PRESS : NONE, { x: r.ship.x, y: r.ship.y });
      if (ev.some((e) => e.type === 'missileLaunched')) return t;
    }
    return -1;
  }

  it('refuses with no valid hostile (none, out of range, hidden by a planet): no cooldown consumed', () => {
    const r = shrike();
    expect(changes(fly(r, 1, F))).toEqual(['refused:noTarget']);
    expect(abilityStatus(r)).toMatchObject({ available: true, reason: 'noTarget' }); // the last refusal, for the P08.2 HUD
    foe(r, 0, -1000); // beyond the ship lock's acquisition range
    expect(changes(fly(r, 1, F))).toEqual(['refused:noTarget']);
    const c = mid(world());
    const hid = setup('shrike', world([], { landmarks: [planet('p-t', { x: c.x, y: c.y - 250 })] }));
    foe(hid, 0, -500);
    expect(changes(fly(hid, 1, F))).toEqual(['refused:noTarget']);
    expect([r.ability.cooldown, hid.ability.cooldown]).toEqual([0, 0]);
  });

  it('halves the lock-on lock time only while active; damage, energy, cooldown and the target choice are unchanged', () => {
    const base = shrike();
    const a0 = foe(base, 0, -380);
    const b0 = base.energy;
    const t0 = launchTick(base, a0);
    const spentBase = b0 - base.energy;
    const r = shrike();
    const a = foe(r, 0, -380);
    fly(r, 1, F, { x: r.ship.x, y: r.ship.y });
    const e0 = r.energy;
    const t1 = launchTick(r, a);
    expect(t0).toBe(MISSILE.lockTicks + 1);
    expect(t1).toBe(Math.ceil(MISSILE.lockTicks * def<'predator-focus'>('shrike').lockMul) + 1);
    expect(r.missiles[0]!.target).toBe(a.id);
    expect(spentBase).toBeGreaterThan(0);
    expect(e0 - r.energy).toBeCloseTo(spentBase, 0); // the same launch cost (regeneration differs by the 9 ticks saved)
    expect(r.arsenal.cooldown['lock-missile']).toBe(MISSILE.cooldownTicks);
    expect(base.arsenal.cooldown['lock-missile']).toBe(MISSILE.cooldownTicks);
    // the hit does exactly the catalogue damage
    const hp = a.hull + a.shield;
    for (let i = 0; i < 120 && r.missiles.length; i++) {
      Object.assign(a, { x: r.ship.x, y: r.ship.y - 380, vx: 0, vy: 0 });
      fly(r, 1);
    }
    expect(hp - (a.hull + a.shield)).toBeCloseTo(MISSILE.damage, 5);
  });

  it('never creates a target: a hostile outside the acquisition cone is still refused by the missile during the focus', () => {
    const r = shrike();
    const a = foe(r, 400, 0); // to the side: in lock range (so the focus starts), outside the missile cone
    fly(r, 1, F, { x: r.ship.x, y: r.ship.y });
    expect(r.ability.active).toBeGreaterThan(0);
    Object.assign(a, { x: r.ship.x + 400, y: r.ship.y });
    const ev = fly(r, 1, PRESS, { x: r.ship.x, y: r.ship.y });
    expect(ev.some((e) => e.type === 'missileRefused' && e.reason === 'noTarget')).toBe(true);
    expect(r.missile.state).toBe('ready');
  });

  it('retention: the hold cone widens by the documented factor and is back to the catalogue value when the focus ends', () => {
    const r = shrike();
    foe(r, 0, -400);
    expect(focusKeepCone(r, MISSILE.keepCone)).toBe(MISSILE.keepCone);
    fly(r, 1, F);
    expect(focusKeepCone(r, MISSILE.keepCone)).toBeCloseTo(MISSILE.keepCone * def<'predator-focus'>('shrike').keepConeMul, 12);
    fly(r, SHIP_ABILITIES.shrike.durationTicks);
    expect([focusKeepCone(r, MISSILE.keepCone), focusLockTicks(r, MISSILE.lockTicks)]).toEqual([MISSILE.keepCone, MISSILE.lockTicks]);
  });
});

describe('P08.1 Petrel · Signal Calibration (the P06 bearing boundary only)', () => {
  function petrel(): { r: SectorRun; p: Poi } {
    const c = mid(world());
    const p = poi('anomaly', 'sig-1', { x: c.x + 400, y: c.y });
    const r = setup('petrel', world([p]));
    r.revealed.add(p.id);
    return { r, p };
  }
  function bearing(r: SectorRun, p: Poi, at: Pt, withAbility: boolean) {
    fly(r, 1, withAbility ? F : NONE, at);
    r.focus = p.id;
    interact(r);
    const ev = fly(r, 48, NONE, at);
    return ev.flatMap((e) => (e.type === 'signal' && e.result.kind === 'bearing' ? [e.result] : []))[0]!;
  }

  it('refuses with no detected, unresolved signal in sensor range (nothing consumed)', () => {
    const r = setup('petrel');
    expect(changes(fly(r, 1, F))).toEqual(['refused:noSignal']);
    const { r: far, p } = petrel();
    place(far, { x: p.x + far.craft.stats.sensor + 200, y: p.y });
    expect(changes(fly(far, 1, F, { x: far.ship.x, y: far.ship.y }))).toEqual(['refused:noSignal']);
    const { r: hidden } = petrel();
    hidden.revealed.clear();
    expect(changes(fly(hidden, 1, F))).toEqual(['refused:noSignal']);
    expect([r.ability.cooldown, far.ability.cooldown, hidden.ability.cooldown]).toEqual([0, 0, 0]);
  });

  it('a bearing recorded while active has half the spread; the same seeded noise index; no resolution, reward or source leak', () => {
    const { r: a, p } = petrel();
    const { r: b } = petrel();
    const at = { x: a.ship.x, y: a.ship.y };
    const plain = bearing(a, p, at, false);
    const cal = bearing(b, p, at, true);
    expect(cal.bearing.spread).toBeCloseTo(plain.bearing.spread * def<'signal-calibration'>('petrel').spreadMul, 12);
    expect(cal.bearing.spread).toBe(bearingSpread(b.craft.stats.sensor, 1, false, 0.5));
    expect(cal.count).toBe(1);
    expect(cal.resolved).toBeNull(); // one bearing never resolves (required bearings unchanged)
    expect(b.done.has(p.id)).toBe(false);
    expect(b.signal.tracks.get(p.id)!.fix).toBeNull();
    // the measured angle uses the same noise draw scaled by the spread: same side of the true direction
    const s = signalSource(b.layout, p);
    const truth = Math.atan2(s.y - at.y, s.x - at.x);
    expect(Math.sign(cal.bearing.angle - truth)).toBe(Math.sign(plain.bearing.angle - truth));
    expect(Math.abs(cal.bearing.angle - truth)).toBeLessThanOrEqual(Math.abs(plain.bearing.angle - truth) + 1e-12);
    // the status never carries the source (no contacts for the Petrel)
    expect(abilityStatus(b).contacts).toEqual([]);
    expect(JSON.stringify(abilityStatus(b))).not.toContain(String(Math.round(s.x)));
    expect(signalView(b, p)!.spread).toBe(bearingSpread(b.craft.stats.sensor, 1, false, 0.5));
  });

  it('inactive behaviour is bit-for-bit identical (activated and expired before the bearing = never activated)', () => {
    const { r: a, p } = petrel();
    const { r: b } = petrel();
    const at = { x: a.ship.x, y: a.ship.y };
    fly(b, 1, F, at);
    fly(b, SHIP_ABILITIES.petrel.durationTicks, NONE, at);
    fly(a, 1 + SHIP_ABILITIES.petrel.durationTicks, NONE, at);
    expect(calibration(b)).toBe(1);
    const x = bearing(a, p, at, false);
    const y = bearing(b, p, at, false);
    expect(y.bearing).toEqual(x.bearing);
    expect(Object.is(y.bearing.angle, x.bearing.angle) && Object.is(y.bearing.spread, x.bearing.spread)).toBe(true);
    // and bearingSpread with the default calibration is the P06 function exactly
    for (const sensor of [300, 900, 1200, 2400]) for (const j of [false, true]) expect(bearingSpread(sensor, 0.7, j, 1)).toBe(bearingSpread(sensor, 0.7, j));
  });

  it('still honours range, speed and occlusion: a refused or broken bearing records nothing', () => {
    const { r, p } = petrel();
    fly(r, 1, F);
    Object.assign(r.ship, { vx: 200, vy: 0 });
    r.focus = p.id;
    const ev = interact(r);
    expect(ev[0]?.type === 'signal' && ev[0].result.kind === 'refused' && ev[0].result.reason).toBe('speed');
    expect(r.signal.tracks.get(p.id)!.bearings).toHaveLength(0);
  });
});

describe('P08.1 Magpie · Salvage Pulse (existing salvage only; nothing created or collected)', () => {
  function magpie() {
    const c = mid(world());
    const near = poi('salvage', 'salv-near', { x: c.x + 1200, y: c.y });
    const far = poi('salvage', 'salv-far', { x: c.x - 1800, y: c.y });
    const derelict = poi('derelict', 'der-1', { x: c.x, y: c.y + 1000 });
    const cache = poi('cache', 'cache-1', { x: c.x, y: c.y - 600 });
    const anomaly = poi('anomaly', 'sig-1', { x: c.x + 300, y: c.y + 300 });
    const r = setup('magpie', world([near, far, derelict, cache, anomaly]));
    return { r, near, far, derelict };
  }

  it('refuses with no salvage in reach (nothing consumed)', () => {
    const r = setup('magpie');
    expect(changes(fly(r, 1, F))).toEqual(['refused:noSalvage']);
    expect(r.ability.cooldown).toBe(0);
  });

  it('marks salvage nodes, derelicts, salvage pods and the cargo wreck within sensor x rangeMul; never caches, anomalies or anything farther', () => {
    const { r } = magpie();
    const R = r.craft.stats.sensor * def<'salvage-pulse'>('magpie').rangeMul;
    expect(R).toBeGreaterThan(1200);
    expect(R).toBeLessThan(1800);
    r.cargoWreck = { x: r.ship.x - 900, y: r.ship.y, units: 3 };
    r.pickups.push({ id: 'pod-t', kind: 'pod', label: 'Salvage pod', x: r.ship.x + 100, y: r.ship.y - 100, vx: 0, vy: 0, loot: [{ resource: 'scrap', amount: 1 } as never], life: 600, persistent: false, armed: true });
    r.pickups.push({ id: 'ore-t', kind: 'ore', label: 'Ore', x: r.ship.x + 50, y: r.ship.y, vx: 0, vy: 0, loot: [], life: Infinity, persistent: true, armed: true });
    const before = { done: [...r.done], claimed: [...r.claimed], left: [...r.left.keys()], pickups: r.pickups.length, revealed: [...r.revealed], cargo: r.cargoSpace };
    const ev = fly(r, 1, F);
    expect(changes(ev)).toEqual(['start']);
    expect(abilityEvents(ev)[0]!.found).toBe(4);
    expect(abilityStatus(r).contacts.map((c) => `${c.kind}:${c.id}`).sort()).toEqual(['derelict:der-1', 'pod:pod-t', 'salvage:salv-near', 'wreck:wreck']);
    // nothing created, collected, revealed or paid
    expect(ev.some((e) => ['collected', 'looted', 'picked', 'recovered', 'recorded'].includes(e.type))).toBe(false);
    expect({ done: [...r.done], claimed: [...r.claimed], left: [...r.left.keys()], pickups: r.pickups.length, revealed: [...r.revealed], cargo: r.cargoSpace }).toEqual(before);
  });

  it('the list follows the world: a collected node drops out; the list clears when the pulse ends', () => {
    const { r, near } = magpie();
    fly(r, 1, F);
    expect(r.ability.contacts.some((c) => c.id === near.id)).toBe(true);
    r.done.add(near.id); // collected (the existing path marks it done)
    fly(r, 6);
    expect(r.ability.contacts.some((c) => c.id === near.id)).toBe(false);
    fly(r, SHIP_ABILITIES.magpie.durationTicks);
    expect(r.ability.contacts).toEqual([]);
  });
});

describe('P08.1 Condor · Bulwark (the one player damage boundary)', () => {
  it('combat hits take damageMul while active; star and hazard drain are unchanged; back to full damage at expiry', () => {
    const r = setup('condor');
    const mul = def<'bulwark'>('condor').damageMul;
    fly(r, 1, F);
    const hit = (source: Parameters<typeof damagePlayer>[2], n: number): number => {
      r.invuln = 0;
      r.shield = 1000;
      return damagePlayer(r, n, source, []);
    };
    for (const s of ['fire', 'hostile', 'mine', 'eruption', 'impact'] as const) expect(hit(s, 10)).toBeCloseTo(10 * mul, 12);
    for (const s of ['star', 'hazard'] as const) expect(hit(s, 10)).toBe(10);
    fly(r, SHIP_ABILITIES.condor.durationTicks);
    expect(hit('fire', 10)).toBe(10);
  });

  it('no invulnerability: the hull still takes the reduced rest; no stacking; enemy damage and enemy ships untouched', () => {
    const r = setup('condor');
    fly(r, 1, F);
    expect(changes(fly(r, 1, F))).toEqual(['refused:active']);
    r.invuln = 0;
    r.shield = 0;
    const h0 = r.hull;
    damagePlayer(r, 50, 'fire', []);
    expect(h0 - r.hull).toBeCloseTo(50 * def<'bulwark'>('condor').damageMul, 9);
    const a = foe(r, 0, -300);
    const hp = a.hull + a.shield;
    damageAgent(r, a, 7, 'player', []);
    expect(hp - (a.hull + a.shield)).toBeCloseTo(7, 12);
    // the hit event reports what was dealt
    r.invuln = 0;
    const ev: SectorEvent[] = [];
    damagePlayer(r, 10, 'fire', ev);
    expect(ev[0]?.type === 'hit' && ev[0].damage).toBeCloseTo(Math.round(10 * def<'bulwark'>('condor').damageMul * 10) / 10, 9);
  });

  it('another ship never gets the reduction, even with an active count', () => {
    const r = setup('albatross');
    r.ability.active = 100;
    expect(incomingDamageMul(r, 'fire')).toBe(1);
  });
});

describe('P08.1 Albatross · Deep Scan (existing sensor data, bounded radius and time)', () => {
  it('reveals POIs within sensor x rangeMul (not beyond) and lists hostiles the sensors could show; the sensor stat is unchanged', () => {
    const c = mid(world());
    const d = def<'deep-scan'>('albatross');
    const R0 = deriveShip('albatross').stats.sensor;
    const R = R0 * d.rangeMul;
    const inside = poi('cache', 'cache-in', { x: c.x + R0 + 300, y: c.y });
    const outside = poi('cache', 'cache-out', { x: c.x - R - 200, y: c.y });
    const anomaly = poi('anomaly', 'sig-1', { x: c.x, y: c.y + R0 + 200 });
    const mark = poi('survey', 'mark-far', { x: c.x - R - 600, y: c.y + R }); // an open survey mark keeps the sector in flight
    const L = world([inside, outside, anomaly, mark]);
    const r = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 3, ship: deriveShip('albatross') }); // unsurveyed: the scan has something to reveal
    r.grace = 1e9;
    place(r, c);
    const h = foe(r, 0, -(R0 + 250));
    const hFar = foe(r, R + 300, 0);
    expect(r.revealed.has(inside.id)).toBe(false);
    const ev = fly(r, 1, F);
    expect(changes(ev)).toEqual(['start']);
    expect(r.revealed.has(inside.id)).toBe(true);
    expect(r.revealed.has(anomaly.id)).toBe(true);
    expect(r.revealed.has(outside.id)).toBe(false);
    const ids = abilityStatus(r).contacts.map((x) => x.id);
    expect(ids).toContain(`hostile:${h.id}`);
    expect(ids).not.toContain(`hostile:${hFar.id}`);
    // an anomaly is listed at its public marker, never at its hidden source
    const an = abilityStatus(r).contacts.find((x) => x.id === anomaly.id)!;
    expect([an.x, an.y]).toEqual([anomaly.x, anomaly.y]);
    const s = signalSource(r.layout, anomaly);
    expect(abilityStatus(r).contacts.some((x) => x.x === s.x && x.y === s.y)).toBe(s.x === anomaly.x && s.y === anomaly.y);
    expect(r.craft.stats.sensor).toBe(R0);
    fly(r, d.durationTicks);
    expect(r.ability.active).toBe(0);
    expect(r.ability.contacts).toEqual([]);
    // after the scan the normal sensor range applies again: nothing new is revealed by it
    expect(r.revealed.has(outside.id)).toBe(false);
    expect(r.revealed.has(mark.id)).toBe(false);
  });

  it('jammed inside sensor interference: refused, nothing consumed (the sensors read nothing there either)', () => {
    const c = mid(world());
    const jam = { id: 'jam-t', kind: 'interference', x: c.x, y: c.y, r: 400, faction: null, mines: [], period: 0 } as never;
    for (const ship of ['albatross', 'magpie'] as const) {
      const r = setup(ship, world([poi('salvage', 'salv-1', { x: c.x + 300, y: c.y })], { hazards: [jam] }));
      expect(changes(fly(r, 1, F))).toEqual(['refused:jammed']);
      expect(r.ability).toMatchObject({ active: 0, cooldown: 0, uses: 0 });
      place(r, { x: c.x + 900, y: c.y }); // out of the zone: works again
      expect(changes(fly(r, 1, F, { x: c.x + 900, y: c.y }))).toEqual(['start']);
    }
  });
});

/* ---------------------------------------------------------------- lifecycle */

describe('P08.1 lifecycle: restart, recall, dock, ship change, unload, new visit, saves', () => {
  it('restart and recall end the effect and keep the cooldown (no free reset)', () => {
    const r = ready('condor');
    fly(r, 1, F);
    fly(r, 10);
    const cd = r.ability.cooldown;
    restartSector(r);
    expect([r.ability.active, r.ability.cooldown]).toEqual([0, cd]);
    expect(incomingDamageMul(r, 'fire')).toBe(1);
    const q = ready('swift');
    fly(q, 1, F);
    q.hull = 0;
    q.invuln = 0;
    const ev = fly(q, 1);
    expect(ev.some((e) => e.type === 'recalled')).toBe(true);
    expect(q.ability.active).toBe(0);
    expect(q.ability.cooldown).toBe(SHIP_ABILITIES.swift.cooldownTicks - 1);
  });

  it('docking ends the effect, refuses presses while docked, and the cooldown waits (docked flight is paused)', () => {
    const L = ALL.find((x) => x.pois.some((p) => p.kind === 'station'))!;
    const st = L.pois.find((p) => p.kind === 'station')!;
    const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 2, ship: deriveShip('condor') });
    r.grace = 1e9;
    fly(r, 1, F);
    place(r, st);
    r.focus = st.id;
    for (const h of r.hostiles) h.state = 'destroyed';
    r.hostiles.length = 0;
    interact(r);
    expect(r.docked).toBe(st.id);
    expect(r.ability.active).toBe(0);
    const cd = r.ability.cooldown;
    expect(abilityGate(r)).toBe('docked');
    pauseSector(r);
    fly(r, 300, F);
    expect(r.ability.cooldown).toBe(cd);
  });

  it('a ship change ends the effect; the cooldown carries over as the same share; switching back never resets it', () => {
    const r = ready('condor');
    fly(r, 1, F);
    fly(r, 599);
    const share = r.ability.cooldown / SHIP_ABILITIES.condor.cooldownTicks;
    applyShip(r, deriveShip('swift'));
    expect(r.ability.active).toBe(0);
    expect(r.ability.cooldown).toBe(Math.ceil(share * SHIP_ABILITIES.swift.cooldownTicks));
    expect(abilityStatus(r)).toMatchObject({ id: 'vector-burst', reason: 'cooling' });
    applyShip(r, deriveShip('condor'));
    expect(r.ability.cooldown).toBeGreaterThanOrEqual(Math.floor(share * SHIP_ABILITIES.condor.cooldownTicks));
    // a loadout change on the same hull keeps the cooldown exactly
    const cd = r.ability.cooldown;
    applyShip(r, deriveShip('condor'));
    expect(r.ability.cooldown).toBe(cd);
    // a ready hull stays ready after a change
    const q = setup('petrel');
    applyShip(q, deriveShip('albatross'));
    expect(q.ability.cooldown).toBe(0);
  });

  it('the survey-complete panel holds the flight like the pause menu: the effect and cooldown wait, then continue', () => {
    const r = createSectorRun(world(), EMPTY_SECTOR_SAVE, { seed: 3, ship: deriveShip('condor') });
    r.grace = 1e9;
    const ev = fly(r, 1, F); // no survey marks: this first tick completes the survey
    expect(changes(ev)).toEqual(['start']);
    expect(r.phase).toBe('complete');
    const snap = [r.ability.active, r.ability.cooldown];
    expect(fly(r, 200, F)).toEqual([]);
    expect([r.ability.active, r.ability.cooldown]).toEqual(snap);
    resumeSector(r);
    fly(r, 1);
    expect([r.ability.active, r.ability.cooldown]).toEqual([snap[0]! - 1, snap[1]! - 1]);
  });

  it('unload ends everything; a new visit starts ready; the flight mode change and the survey panel do not touch it', () => {
    const r = ready('swift');
    fly(r, 1, F);
    disposeSectorRun(r);
    expect(r.ability.active).toBe(0);
    expect(stepSector(r, F)).toEqual([]);
    expect(ready('swift').ability).toEqual(freshAbility());
  });

  it('never saved: the profile format and version are unchanged and carry no ability state', () => {
    expect(FREEROAM_VERSION).toBe(10);
    const store = new MemoryStore();
    saveProfile(store, EMPTY_PROFILE);
    const raw = store.read(STORAGE_KEYS.freeroam);
    expect(raw && raw.length).toBeGreaterThan(100);
    expect(raw).not.toMatch(/ability|cooldown|vector-burst|bulwark/i);
    expect(Object.keys(EMPTY_PROFILE)).not.toContain('ability');
  });
});

/* ------------------------------------------------------------- interactions */

describe('P08.1 interactions: Silent Running, weapons, stats', () => {
  it('an emitting ability (burst, pulse, scan) ends Silent Running with its own reason; the others leave it on', () => {
    for (const ship of SHIP_IDS) {
      const r = ready(ship);
      fly(r, 1, { moveX: 0, moveY: 0, silentToggle: true });
      expect(r.silent).toBe(true);
      const ev = fly(r, 1, F);
      expect(changes(ev)).toEqual(['start']);
      const off = ev.filter((e) => e.type === 'silent');
      if (SHIP_ABILITIES[ship].emits) {
        expect(off).toEqual([{ type: 'silent', change: 'ability' }]);
        expect(r.silent).toBe(false);
      } else {
        expect(off).toEqual([]);
        expect(r.silent).toBe(true);
      }
    }
  });

  it('FIRE while silent still ends Silent Running first and fires once, with an ability active', () => {
    const r = ready('condor');
    fly(r, 1, { moveX: 0, moveY: 0, silentToggle: true });
    fly(r, 1, F);
    const shots = r.shotsFired;
    const ev = fly(r, 1, { moveX: 0, moveY: 0, fire: true });
    expect(ev.filter((e) => e.type === 'silent')).toEqual([{ type: 'silent', change: 'fire' }]);
    expect(r.shotsFired).toBe(shots + 1);
  });

  it('no ability changes ship stats, prices, unlocks or the weapon catalogue values', () => {
    const snapshot = JSON.stringify(SHIPS);
    for (const ship of SHIP_IDS) {
      const r = ready(ship);
      const stats = JSON.stringify(r.craft.stats);
      fly(r, 1, F);
      fly(r, SHIP_ABILITIES[ship].durationTicks + 5);
      expect(JSON.stringify(r.craft.stats)).toBe(stats);
      expect(JSON.stringify(r.craft.stats)).toBe(JSON.stringify(deriveShip(ship).stats));
    }
    expect(JSON.stringify(SHIPS)).toBe(snapshot);
    expect(SHIP_BY_ID.get('petrel')!.cost).toEqual([]);
    expect(MISSILE.lockTicks).toBe(18);
  });
});

/* -------------------------------------------------------------------- input */

describe('P08.1 activation input (one named action, conflict-audited)', () => {
  it('`ability` is a flight action on F with a label; F is used by no other action, panel, zoom, lab or hidden-sequence key', () => {
    expect(FLIGHT_ACTIONS).toContain('ability');
    expect(DEFAULT_BINDINGS.ability).toEqual(['KeyF', null]);
    const others = FLIGHT_ACTIONS.filter((a) => a !== 'ability').flatMap((a) => DEFAULT_BINDINGS[a]);
    expect(others).not.toContain('KeyF');
    expect(Object.values(PANEL_KEYS).flat()).not.toContain('KeyF');
    expect(Object.values(ZOOM_KEYS).flat()).not.toContain('KeyF');
    expect(ADMIN_SEQUENCE).not.toContain('KeyF');
    expect(readFileSync('src/modes/freeroam/gravity/labShell.ts', 'utf8')).not.toMatch(/'KeyF'/);
    expect(trackedCodes(DEFAULT_BINDINGS)).toContain('KeyF');
    const all = FLIGHT_ACTIONS.flatMap((a) => DEFAULT_BINDINGS[a].filter((k): k is string => k !== null));
    expect(new Set(all).size).toBe(all.length);
  });

  it('older saves gain the action without a repair; a save that already uses F gets a spare key; nothing is reset', () => {
    const old = Object.fromEntries(FLIGHT_ACTIONS.filter((a) => a !== 'ability').map((a) => [a, DEFAULT_BINDINGS[a]]));
    expect(sanitizeBindings(old)).toMatchObject({ repaired: false, bindings: { ability: ['KeyF', null] } });
    const s2 = sanitizeBindings({ ...old, map: ['KeyF', null] });
    expect(s2.repaired).toBe(false);
    expect(s2.bindings.map).toEqual(['KeyF', null]);
    expect(s2.bindings.ability[0]).not.toBe('KeyF');
    const keys = FLIGHT_ACTIONS.flatMap((a) => s2.bindings[a].filter((k): k is string => k !== null));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the shell sends one edge per press through the existing pending pattern; no listener, clock or timer of its own', () => {
    const shell = readFileSync('src/modes/freeroam/freeRoamMode.ts', 'utf8');
    expect(shell).toMatch(/binds\.ability\.includes\(code\)\) abilityPending = true;/);
    expect(shell).toMatch(/if \(abilityPending\) f = \{ \.\.\.f, ability: true \};/);
    expect(shell.match(/^\s+abilityPending = false;$/gm)?.length).toBe(2); // cleared when flight is not live, and after each tick's hand-off
    // no ability data duplicated in the shell: names come from the table
    for (const s of SHIP_IDS) expect(shell).not.toContain(SHIP_ABILITIES[s].name);
    const mod = readFileSync('src/modes/freeroam/combat/shipAbilities.ts', 'utf8');
    expect(mod).not.toMatch(/addEventListener|setTimeout|setInterval|requestAnimationFrame/);
  });

  it('the controller layout is unchanged (no free standard-mapping button); P08.2 adds the touch button as one more latched pointer role', () => {
    expect(PAD).toEqual({ rightX: 2, rightY: 3, fire: [7, 5, 2], boost: [4, 6], weapon: [11], silent: [10], aimDeadZone: 0.3 });
    const pointers = readFileSync('src/modes/freeroam/pointers.ts', 'utf8');
    // the same latch as WPN / LOCK / STOP / SILENT: no listener, clock or timer in the pointer model
    expect(pointers).toMatch(/abilityDown\(id: number\): void \{\n\s+this\.latch\('ability', id\);/);
    expect(pointers).not.toMatch(/addEventListener|setTimeout|Date\.now|performance\.now/);
  });
});

/* --------------------------------------------------- P08.2 presentation */

describe('P08.2 ability HUD model (the status snapshot in words; no clock, no game logic)', () => {
  const base = (ship: ShipId) => {
    const d = SHIP_ABILITIES[ship];
    return { id: d.id, name: d.name, tag: d.tag, summary: d.summary, active: false, activeTicks: 0, cooldownTicks: 0 };
  };

  it('no ship ability: hidden; every ship: its own name (desktop) or tag (touch), never a hardcoded F', () => {
    expect(abilityHud(null, 'F', false).show).toBe(false);
    for (const ship of SHIP_IDS) {
      const d = SHIP_ABILITIES[ship];
      const desk = abilityHud(base(ship), 'G', false);
      const touch = abilityHud(base(ship), 'G', true);
      expect(desk).toMatchObject({ show: true, state: 'ready', label: d.name.toUpperCase() });
      expect(desk.hint.startsWith('G · READY\n')).toBe(true); // the bound key, only on a desktop
      expect(desk.hint.replace(/\s+/g, ' ')).toContain(d.summary);
      expect(desk.aria).toContain(`${d.name}, ship ability, key G: ready.`);
      expect(touch).toMatchObject({ show: true, state: 'ready', label: d.tag, hint: 'READY' });
      expect(touch.aria).not.toContain('key');
    }
  });

  it('ACTIVE shows the seconds left (rounded up to a tenth), COOLDOWN whole seconds (rounded up), both from the snapshot only', () => {
    const on = abilityHud({ ...base('swift'), active: true, activeTicks: 105, cooldownTicks: 1500 }, 'F', true);
    expect(on).toMatchObject({ state: 'on', hint: 'ACTIVE · 1.8 s' });
    expect(abilityHud({ ...base('swift'), active: true, activeTicks: 1, cooldownTicks: 1400 }, 'F', true).hint).toBe('ACTIVE · 0.1 s');
    const cool = abilityHud({ ...base('condor'), cooldownTicks: 61 }, 'F', false);
    expect(cool.state).toBe('cooling');
    expect(cool.hint.split('\n')[0]).toBe('COOLDOWN · 2 s'); // no key while it cannot be used
    expect(cool.aria).toContain('cooldown, 2 seconds');
    expect(abilityHud({ ...base('condor'), cooldownTicks: 1 }, 'F', true).hint).toBe('COOLDOWN · 1 s');
  });

  it('bad numbers never show NaN, Infinity or a negative time', () => {
    for (const v of [Number.NaN, -30, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const active of [true, false]) {
        const m = abilityHud({ ...base('albatross'), active, activeTicks: v, cooldownTicks: active ? 2000 : v }, 'F', false);
        expect(`${m.hint} ${m.aria}`).not.toMatch(/NaN|Infinity|-\d/);
      }
    }
  });

  it('the model follows the run: READY -> ACTIVE (counting down) -> COOLDOWN -> READY, frozen while paused, a refusal changes nothing', () => {
    const r = ready('albatross');
    const hud = () => abilityHud(abilityStatus(r), 'F', false);
    expect(hud().state).toBe('ready');
    fly(r, 1, F);
    expect(hud().state).toBe('on');
    const a = hud().hint;
    pauseSector(r);
    fly(r, 120);
    expect(hud().hint).toBe(a); // paused: nothing counts down
    resumeSector(r);
    fly(r, 60);
    expect(hud().hint).not.toBe(a);
    fly(r, SHIP_ABILITIES.albatross.durationTicks);
    expect(hud().state).toBe('cooling');
    const before = abilityStatus(r).cooldownTicks;
    const ev = fly(r, 1, F); // refused while cooling: nothing consumed or restarted
    expect(changes(ev)).toEqual(['refused:cooling']);
    expect(abilityStatus(r).cooldownTicks).toBe(before - 1);
    fly(r, before);
    expect(hud().state).toBe('ready');
  });
});

describe('P08.2 scan messages and marks (the P08.1 result list, read-only)', () => {
  it('Deep Scan counts markers and hostiles apart, each contact once; Salvage Pulse counts its finds, zero included', () => {
    expect(abilityLine({ id: 'deep-scan', change: 'start', found: 5, hostiles: 2 })).toBe('DEEP SCAN ACTIVE · 3 MARKERS · 2 HOSTILES');
    expect(abilityLine({ id: 'deep-scan', change: 'start', found: 2, hostiles: 1 })).toBe('DEEP SCAN ACTIVE · 1 MARKER · 1 HOSTILE');
    expect(abilityLine({ id: 'deep-scan', change: 'start', found: 0, hostiles: 0 })).toBe('DEEP SCAN ACTIVE · 0 MARKERS · 0 HOSTILES');
    expect(abilityLine({ id: 'salvage-pulse', change: 'start', found: 0 })).toBe('SALVAGE PULSE ACTIVE · 0 FOUND');
    const r = ready('albatross');
    foe(r, 0, -500);
    const ev = abilityEvents(fly(r, 1, F)).find((e) => e.change === 'start');
    const c = abilityStatus(r).contacts;
    expect(ev).toMatchObject({ found: c.length, hostiles: c.filter((k) => k.kind === 'hostile').length });
    expect(ev?.hostiles).toBe(1);
    expect(new Set(c.map((k) => k.id)).size).toBe(c.length);
  });

  it('drawScanMarks only draws: the run is unchanged, one ring per visible result, one arrow per off-screen result, nothing once it ends', () => {
    const r = ready('albatross');
    foe(r, 0, -250); // on screen
    foe(r, 0, 1000); // off screen, inside Deep Scan's reach
    fly(r, 1, F);
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_t, k) => (typeof k === 'string' && ['save', 'restore', 'beginPath', 'arc', 'stroke', 'setLineDash', 'translate', 'rotate', 'moveTo', 'lineTo', 'closePath', 'fill'].includes(k) ? () => calls.push(k) : undefined), set: () => true }) as unknown as CanvasRenderingContext2D;
    const W = 800;
    const H = 600;
    const V = { toX: (x: number) => x - r.ship.x + W / 2, toY: (y: number) => y - r.ship.y + H / 2, zoom: 1, ratio: 1, W, H, visible: (x: number, y: number, m: number) => Math.abs(x - r.ship.x) <= W / 2 + m && Math.abs(y - r.ship.y) <= H / 2 + m } as unknown as CombatView;
    const snap = JSON.stringify({ a: r.ability, ship: r.ship, h: r.hostiles.map((h) => [h.x, h.y, h.state]), rev: [...r.revealed] });
    const c = abilityStatus(r).contacts;
    const onScreen = c.filter((k) => V.visible(k.x, k.y, 40)).length;
    drawScanMarks(ctx, r, V, false);
    expect(calls.filter((k) => k === 'arc').length).toBe(onScreen);
    calls.length = 0;
    drawScanMarks(ctx, r, V, true);
    const off = c.filter((k) => { const x = V.toX(k.x); const y = V.toY(k.y); return !(x >= 0 && y >= 0 && x <= W && y <= H); }).length;
    expect(off).toBeGreaterThan(0);
    expect(onScreen).toBeGreaterThan(0);
    expect(calls.filter((k) => k === 'rotate').length).toBe(off);
    expect(JSON.stringify({ a: r.ability, ship: r.ship, h: r.hostiles.map((h) => [h.x, h.y, h.state]), rev: [...r.revealed] })).toBe(snap);
    fly(r, SHIP_ABILITIES.albatross.durationTicks);
    calls.length = 0;
    drawScanMarks(ctx, r, V, false);
    drawScanMarks(ctx, r, V, true);
    expect(calls.filter((k) => k === 'arc' || k === 'rotate')).toEqual([]); // expired with the effect
  });

  it('the presentation never reads the hidden P06 source or performs a scan', () => {
    const render = readFileSync('src/modes/freeroam/sector/combatRender.ts', 'utf8');
    const fn = render.slice(render.indexOf('export function drawScanMarks'), render.indexOf('/* ------------------------------------------------------------- UI layer */'));
    expect(fn).toContain('run.ability.contacts');
    expect(fn).not.toMatch(/signalSource|source|scan\(|sense\(|layout\.pois|hostiles/);
    const hud = readFileSync('src/modes/freeroam/ui/hudModel.ts', 'utf8');
    expect(hud).not.toMatch(/signalSource|Date\.now|performance\.now|setTimeout|setInterval/);
  });
});

describe('P08.2 touch button: one tap, one request (the existing latched pointer model)', () => {
  it('a tap latches exactly one request; release, cancel and a second finger add none', () => {
    const p = new FlightPointers();
    p.abilityDown(1);
    expect(p.snapshot().abilityTouches).toBe(1);
    p.abilityDown(2); // a second finger while one holds it
    expect(p.takeAbilityPress()).toBe(true);
    expect(p.takeAbilityPress()).toBe(false);
    p.release(1);
    p.release(2);
    expect(p.takeAbilityPress()).toBe(false);
    expect(p.snapshot().abilityTouches).toBe(0);
    p.abilityDown(3);
    p.release(3); // a quick tap, released before the frame reads it: still one request
    expect(p.takeAbilityPress()).toBe(true);
    expect(p.takeAbilityPress()).toBe(false);
  });

  it('the stick finger and a finger already on another button never trigger it; reset drops a pending press', () => {
    const p = new FlightPointers();
    expect(p.stickDown(1, 100, 100)).toBe(true);
    p.abilityDown(1);
    p.fireDown(2);
    p.abilityDown(2);
    expect(p.takeAbilityPress()).toBe(false);
    p.abilityDown(3);
    p.reset();
    expect(p.takeAbilityPress()).toBe(false);
  });

  it('one request reaches the run as one activation, the same input as the key', () => {
    const r = ready('swift');
    const p = new FlightPointers();
    p.abilityDown(7);
    const ev: SectorEvent[] = [];
    for (let i = 0; i < 5; i++) ev.push(...stepSector(r, { moveX: 0, moveY: 0, ability: p.takeAbilityPress() }));
    expect(changes(ev)).toEqual(['start']);
    expect(r.ability.uses).toBe(1);
  });
});

describe('P08.2 How to Play: Ship Signature Abilities after Silent Running', () => {
  const base = { ...DEFAULT_GUIDE_CONTEXT, mode: 'freeroam' as const };

  it('the section follows Silent Running, lists the six ships from the one table, and uses the bound key', () => {
    for (const input of ['keyboard', 'touch', 'controller'] as const) {
      const text = stepText(guideStep('controls', { ...base, input }));
      const at = text.indexOf('SHIP SIGNATURE ABILITIES');
      expect(at).toBeGreaterThan(text.indexOf('NOT A SHIELD'));
      for (const ship of SHIP_IDS) {
        const d = SHIP_ABILITIES[ship];
        const line = `${SHIP_BY_ID.get(ship)!.name.toUpperCase()} · ${d.name.toUpperCase()}`;
        expect(text.indexOf(line)).toBeGreaterThan(at);
      }
      for (const w of ['PAUSED', 'Pausing freezes', 'ability changes with the ship', 'Nothing is used up', 'ends Silent Running']) expect(text).toContain(w);
      expect(text).not.toMatch(/invulnerab|auto-?collect|admin|password/i);
    }
    expect(stepText(guideStep('controls', { ...base, input: 'keyboard' }))).toContain('Press F to use it');
    const moved = rebind(DEFAULT_BINDINGS, 'ability', 0, 'KeyG');
    if (!moved.ok) throw new Error('rebind');
    expect(stepText(guideStep('controls', { ...base, input: 'keyboard', bindings: moved.bindings }))).toContain('Press G to use it');
    expect(stepText(guideStep('controls', { ...base, input: 'controller' }))).toMatch(/no controller button yet/);
    expect(stepText(guideStep('controls', { ...base, input: 'touch' }))).toMatch(/Tap the ability button/);
  });

  it('the guide rows and the Player Guide table match the one ability table (names, order, durations, cooldowns)', () => {
    expect(ABILITY_GUIDE.map(([ship, name]) => [ship, name])).toEqual(SHIP_IDS.map((s) => [s, SHIP_ABILITIES[s].name]).sort((a, b) => ABILITY_GUIDE.findIndex((g) => g[0] === a[0]) - ABILITY_GUIDE.findIndex((g) => g[0] === b[0])));
    expect(ABILITY_GUIDE.map(([s]) => s).sort()).toEqual([...SHIP_IDS].sort());
    const all = Object.values(SHIP_ABILITIES);
    const lo = Math.min(...all.map((d) => d.durationTicks / 60));
    const hi = Math.max(...all.map((d) => d.durationTicks / 60));
    expect([lo < 2, hi]).toEqual([true, 7]);
    expect([Math.min(...all.map((d) => d.cooldownTicks / 60)), Math.max(...all.map((d) => d.cooldownTicks / 60))]).toEqual([25, 40]);
    const doc = readFileSync('docs/PLAYER_GUIDE.md', 'utf8');
    const sec = doc.slice(doc.indexOf('### Ship Signature Abilities'), doc.indexOf('### Flight mode'));
    expect(doc.indexOf('### Ship Signature Abilities')).toBeGreaterThan(doc.indexOf('### Silent Running and Gravity Shadow'));
    for (const [ship, name, text] of ABILITY_GUIDE) {
      const d = SHIP_ABILITIES[ship];
      expect(sec).toContain(`| ${SHIP_BY_ID.get(ship)!.name} | ${name} | ${text.replace(/\.$/, '')} | ${d.durationTicks / 60} s | ${d.cooldownTicks / 60} s |`);
    }
  });

  it('the control rows: the bound key, the touch button, and no controller row', () => {
    expect(freeRoamKeyboard(DEFAULT_BINDINGS, false).find((x) => x.id === 'ability')?.keys).toEqual([['F']]);
    const moved = rebind(DEFAULT_BINDINGS, 'ability', 0, 'KeyG');
    if (!moved.ok) throw new Error('rebind');
    expect(freeRoamKeyboard(moved.bindings, false).find((x) => x.id === 'ability')?.keys).toEqual([['G']]);
    expect(freeRoamTouch().find((x) => x.id === 'ability')?.keys).toEqual([['SHIP TAG']]);
    expect(freeRoamController().find((x) => x.id === 'ability')).toBeUndefined();
  });
});
