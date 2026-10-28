/**
 * P07.1 Gravity Shadow and Silent Running (combat/stealth.ts, combat/ai.ts
 * chooseTarget, sector/run.ts) on the real sector simulation: segment
 * occlusion by celestial bodies, the signature multiplier on the one
 * acquisition path, contact memory with its exact tick boundary, the Silent
 * Running state and its trade-offs (FIRE / boost drop it and run once), the
 * lifecycle resets, and what must stay unchanged (projectiles, missiles, the
 * pilot's lock, nonvisual detection, saves). Fixed seeds; no clock.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADMIN_SEQUENCE } from '../src/modes/freeroam/admin/activation.ts';
import { DEFAULT_BINDINGS, FLIGHT_ACTIONS, PANEL_KEYS, rebind, sanitizeBindings, ZOOM_KEYS } from '../src/modes/freeroam/bindings.ts';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import { FAMILIES, FAMILY_IDS, type FamilyId } from '../src/modes/freeroam/combat/families.ts';
import { spawnShot } from '../src/modes/freeroam/combat/projectiles.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import { bodyBetween, effectiveRange, signature, STEALTH, stealthStatus } from '../src/modes/freeroam/combat/stealth.ts';
import { damageAgent } from '../src/modes/freeroam/combat/world.ts';
import { EMPTY_PROFILE, FREEROAM_VERSION, saveProfile } from '../src/modes/freeroam/profile.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE, type Landmark, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { applyShip, createSectorRun, disposeSectorRun, dockIfInRange, pauseSector, restartSector, resumeSector, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { deriveShip } from '../src/modes/freeroam/ships/equipment.ts';
import { SHIP_IDS } from '../src/modes/freeroam/ships/types.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import { arena } from './helpers/combatProbe.ts';
import { FlightPointers } from '../src/modes/freeroam/pointers.ts';
import { PAD, padSilent } from '../src/modes/freeroam/input.ts';
import { stealthHud } from '../src/modes/freeroam/ui/hudModel.ts';
import { DEFAULT_GUIDE_CONTEXT, freeRoamController, freeRoamKeyboard, freeRoamTouch, guideStep, stepText } from '../src/modes/guide/guideContent.ts';

const NONE: SectorInput = { moveX: 0, moveY: 0 };
const Z: SectorInput = { moveX: 0, moveY: 0, silentToggle: true };
const FIRE: SectorInput = { moveX: 0, moveY: 0, fire: true };

const body = (x: number, y: number, r: number, id = 'body-t'): Landmark => ({ id, kind: 'body', style: 'gas', x, y, r, hazardR: 0, label: 'Test body' });
const silentEvents = (ev: readonly SectorEvent[]): string[] => ev.flatMap((e) => (e.type === 'silent' ? [e.change] : []));
const count = (ev: readonly SectorEvent[], type: SectorEvent['type']): number => ev.filter((e) => e.type === type).length;

/** A cleared difficulty-3 arena (optionally with bodies) and a point far from the arrival sanctuary. */
function world(bodies: readonly Landmark[] = []): { L: SectorLayout; cx: number; cy: number } {
  const base = arena(3);
  const cx = base.arrival.x < base.width / 2 ? base.width - 1500 : 1500;
  const cy = base.arrival.y < base.height / 2 ? base.height - 1500 : 1500;
  return { L: { ...base, landmarks: bodies.map((b) => ({ ...b, x: b.x + cx, y: b.y + cy })) }, cx, cy };
}
/** A run past its arrival grace, pilot invulnerable (these tests are about sight, not damage). */
function fight(L: SectorLayout, seed = 7, ship?: Parameters<typeof deriveShip>[0]): SectorRun {
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed, ...(ship ? { ship: deriveShip(ship) } : {}) });
  r.grace = 0;
  r.invuln = 1e9;
  return r;
}
const put = (r: SectorRun, x: number, y: number): void => {
  Object.assign(r.ship, { x, y, px: x, py: y, vx: 0, vy: 0 });
};
const pin = (a: Agent, x: number, y: number): void => {
  Object.assign(a, { x, y, px: x, py: y, vx: 0, vy: 0 });
};
/** Step n ticks with the pilot and the agents held at fixed points (test placement only). */
function hold(r: SectorRun, n: number, pilot: { x: number; y: number }, agents: readonly { a: Agent; x: number; y: number }[], input: SectorInput = NONE): SectorEvent[] {
  const out: SectorEvent[] = [];
  for (let i = 0; i < n; i++) {
    put(r, pilot.x, pilot.y);
    for (const p of agents) pin(p.a, p.x, p.y);
    out.push(...stepSector(r, input));
  }
  return out;
}
const foe = (r: SectorRun, family: FamilyId, x: number, y: number): Agent => {
  const a = spawnAgent(r, family, 'red-tally', 'test', 'guard', x, y);
  if (!a) throw new Error('spawn refused');
  return a;
};

/* ---------------------------------------------------------------- geometry */
describe('Gravity Shadow geometry (bodyBetween)', () => {
  const B = [body(0, 0, 100)];
  it('a clear line is not blocked; a body between the two points blocks it', () => {
    expect(bodyBetween(B, -300, 300, 300, 300)).toBeNull();
    expect(bodyBetween(B, -300, 0, 300, 0)?.id).toBe('body-t');
    expect(bodyBetween(B, -300, -50, 300, 40)?.id).toBe('body-t');
  });
  it('a body behind the pilot or behind the observer never blocks', () => {
    // observer at -500, pilot at -200: the body (0, 0, r 100) is beyond the pilot
    expect(bodyBetween(B, -500, 0, -200, 0)).toBeNull();
    // and beyond the observer, looking away from it
    expect(bodyBetween(B, -200, 0, -500, 0)).toBeNull();
  });
  it('tangent lines block (distance == radius); a near miss does not', () => {
    expect(bodyBetween(B, -300, 100, 300, 100)?.id).toBe('body-t');
    expect(bodyBetween(B, -300, 100.001, 300, 100.001)).toBeNull();
    expect(bodyBetween(B, -300, 99.999, 300, 99.999)?.id).toBe('body-t');
    expect(bodyBetween(B, -300, -100, 300, -100)?.id).toBe('body-t');
  });
  it('is symmetric (observer and pilot swapped give the same answer)', () => {
    for (const [ax, ay, bx, by] of [
      [-300, 0, 300, 0],
      [-300, 101, 300, 101],
      [-500, 0, -200, 0],
      [120, -400, -80, 350],
    ] as const) {
      expect(bodyBetween(B, ax, ay, bx, by)).toBe(bodyBetween(B, bx, by, ax, ay));
    }
  });
  it('multiple bodies: any one that touches the line blocks; the first in list order is reported', () => {
    const many = [body(0, 400, 50, 'a'), body(100, 0, 60, 'b'), body(-100, 0, 60, 'c')];
    expect(bodyBetween(many, -300, 0, 300, 0)?.id).toBe('b');
    expect(bodyBetween(many, -300, 200, 300, 200)).toBeNull();
    expect(bodyBetween(many, -300, 400, 300, 400)?.id).toBe('a');
  });
  it('the radius decides: the same line clears a small body and is hidden by a larger one', () => {
    expect(bodyBetween([body(0, 0, 80)], -300, 90, 300, 90)).toBeNull();
    expect(bodyBetween([body(0, 0, 95)], -300, 90, 300, 90)).not.toBeNull();
  });
  it('is stable next to the boundary: sliding along the line never flips the answer', () => {
    for (let s = -50; s <= 50; s += 0.5) {
      expect(bodyBetween(B, -300 + s, 100.01, 300 + s, 100.01)).toBeNull();
      expect(bodyBetween(B, -300 + s, 99.99, 300 + s, 99.99)).not.toBeNull();
    }
  });
  it('invalid data never occludes: no bodies, radius <= 0, non-finite values; a zero-length segment outside a body is clear', () => {
    expect(bodyBetween([], -300, 0, 300, 0)).toBeNull();
    expect(bodyBetween([body(0, 0, 0)], -300, 0, 300, 0)).toBeNull();
    expect(bodyBetween([body(0, 0, -40)], -300, 0, 300, 0)).toBeNull();
    expect(bodyBetween([body(Number.NaN, 0, 100)], -300, 0, 300, 0)).toBeNull();
    expect(bodyBetween([body(0, 0, Number.NaN)], -300, 0, 300, 0)).toBeNull();
    expect(bodyBetween(B, Number.NaN, 0, 300, 0)).toBeNull();
    expect(bodyBetween(B, 300, 0, 300, 0)).toBeNull();
    // an infinite radius is still a solid body (it hides everything), never a crash
    expect(bodyBetween([body(0, 0, Infinity)], -300, 0, 300, 0)).not.toBeNull();
  });
});

/* ------------------------------------------------------- signature and range */
describe('signature and effective range', () => {
  it('the tuning is centralised and frozen: normal 1.0, silent 0.35, memory 75 ticks (1.25 s at 60 Hz)', () => {
    expect(STEALTH).toEqual({ normal: 1, silent: 0.35, memoryTicks: 75 });
    expect(Object.isFrozen(STEALTH)).toBe(true);
    expect(STEALTH.memoryTicks / 60).toBe(1.25);
  });
  it('signature follows the run; effective range = detect x signature, reduced (never extended) by Silent Running', () => {
    expect(signature({ silent: false })).toBe(1);
    expect(signature({ silent: true })).toBe(0.35);
    for (const f of FAMILY_IDS) {
      const d = FAMILIES[f].detect;
      expect(effectiveRange(d, signature({ silent: false }))).toBe(d);
      expect(effectiveRange(d, signature({ silent: true }))).toBeCloseTo(d * 0.35, 9);
      expect(effectiveRange(d, STEALTH.silent)).toBeLessThan(d);
    }
  });
});

/* ------------------------------------------------------------ state machine */
describe('Silent Running state', () => {
  it('starts off in every new run, toggles on the edge command, and repeats cleanly', () => {
    const { L } = world();
    const r = fight(L);
    expect(r.silent).toBe(false);
    expect(silentEvents(stepSector(r, Z))).toEqual(['on']);
    expect(r.silent).toBe(true);
    expect(silentEvents(stepSector(r, NONE))).toEqual([]);
    expect(r.silent).toBe(true);
    expect(silentEvents(stepSector(r, Z))).toEqual(['off']);
    expect(r.silent).toBe(false);
    for (let i = 0; i < 6; i++) stepSector(r, Z);
    expect(r.silent).toBe(false);
  });
  it('ignores invalid toggles and toggles while docked; outside flight nothing changes', () => {
    const { L } = world();
    const r = fight(L);
    for (const v of [false, undefined, 1, 'true', {}] as unknown[]) stepSector(r, { moveX: 0, moveY: 0, silentToggle: v as boolean });
    expect(r.silent).toBe(false);
    r.docked = 'station-x';
    expect(silentEvents(stepSector(r, Z))).toEqual([]);
    expect(r.silent).toBe(false);
    r.docked = null;
    pauseSector(r);
    expect(stepSector(r, Z)).toEqual([]);
    expect(r.silent).toBe(false);
  });
  it('pause freezes it: the state survives pause and resume, and no tick runs while paused', () => {
    const { L } = world();
    const r = fight(L);
    stepSector(r, Z);
    const tick = r.tick;
    pauseSector(r);
    for (let i = 0; i < 120; i++) expect(stepSector(r, NONE)).toEqual([]);
    expect(r.tick).toBe(tick);
    expect(r.silent).toBe(true);
    resumeSector(r);
    expect(r.silent).toBe(true);
  });
  it('resets on restart, recall, ship change, docking and unload; a new run (sector entry) starts normal', () => {
    const { L } = world();
    const r = fight(L);
    stepSector(r, Z);
    restartSector(r);
    expect(r.silent).toBe(false);
    stepSector(r, Z);
    r.invuln = 0;
    r.hull = 0;
    const ev = stepSector(r, NONE);
    expect(count(ev, 'recalled')).toBe(1);
    expect(r.silent).toBe(false);
    stepSector(r, Z);
    applyShip(r, deriveShip('swift'));
    expect(r.silent).toBe(false);
    stepSector(r, Z);
    disposeSectorRun(r);
    expect(r.silent).toBe(false);
    // docking at a real station
    const graph = buildNavGraph();
    const sys = getCatalogue().systems.find((s) => generateSector(s, sectorContext(graph, s.id)).pois.some((p) => p.kind === 'station'))!;
    const RL = generateSector(sys, sectorContext(graph, sys.id));
    const st = RL.pois.find((p) => p.kind === 'station')!;
    const d = createSectorRun(RL, EMPTY_SECTOR_SAVE, { seed: 3 });
    stepSector(d, Z);
    expect(d.silent).toBe(true);
    put(d, st.x, st.y + st.r * 0.5);
    expect(dockIfInRange(d).some((e) => e.type === 'docked')).toBe(true);
    expect(d.silent).toBe(false);
    expect(createSectorRun(RL, EMPTY_SECTOR_SAVE, { seed: 3 }).silent).toBe(false);
  });
  it('is never saved: the profile format and version are unchanged and carry no stealth state', () => {
    expect(FREEROAM_VERSION).toBe(10);
    const store = new MemoryStore();
    const writes: string[] = [];
    const write = store.write.bind(store);
    store.write = (k: string, v: string): boolean => (writes.push(v), write(k, v));
    expect(saveProfile(store, EMPTY_PROFILE)).toBe(true);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.join('')).not.toMatch(/silent|stealth|signature/i);
  });
  it('steering still works: the ship flies exactly as it does at normal signature', () => {
    const { L, cx, cy } = world();
    const a = fight(L);
    const b = fight(L);
    put(a, cx, cy);
    put(b, cx, cy);
    stepSector(a, NONE);
    stepSector(b, Z);
    const move: SectorInput = { moveX: 0.7, moveY: -0.4, aimX: cx + 500, aimY: cy };
    for (let i = 0; i < 90; i++) {
      stepSector(a, move);
      stepSector(b, move);
    }
    expect(b.silent).toBe(true);
    expect(b.ship).toEqual(a.ship);
  });
  it('FIRE drops it and fires exactly once through the normal path (no duplicate shot, heat or event)', () => {
    const { L, cx, cy } = world();
    const a = fight(L);
    const b = fight(L);
    put(a, cx, cy);
    put(b, cx, cy);
    stepSector(a, NONE);
    stepSector(b, Z);
    const ea = stepSector(a, FIRE);
    const eb = stepSector(b, FIRE);
    expect(silentEvents(eb)).toEqual(['fire']);
    expect(b.silent).toBe(false);
    expect(count(eb, 'fired')).toBe(1);
    expect(count(eb, 'fired')).toBe(count(ea, 'fired'));
    expect(b.shots.length).toBe(a.shots.length);
    expect(b.shotsFired).toBe(a.shotsFired);
    expect(b.heat).toBe(a.heat);
    expect(b.fireCooldown).toBe(a.fireCooldown);
    // held FIRE afterwards: the same cadence as a pilot who never ran silent
    let fa = 0;
    let fb = 0;
    for (let i = 0; i < 60; i++) {
      fa += count(stepSector(a, FIRE), 'fired');
      fb += count(stepSector(b, FIRE), 'fired');
    }
    expect(fb).toBe(fa);
    expect(b.shotsFired).toBe(a.shotsFired);
  });
  it('boost drops it, then the normal boost validation runs once (energy spent as usual, refused when empty)', () => {
    const { L, cx, cy } = world();
    const a = fight(L);
    const b = fight(L);
    put(a, cx, cy);
    put(b, cx, cy);
    stepSector(a, NONE);
    stepSector(b, Z);
    const go: SectorInput = { moveX: 1, moveY: 0, boost: true };
    const eb = stepSector(b, go);
    stepSector(a, go);
    expect(silentEvents(eb)).toEqual(['boost']);
    expect(b.silent).toBe(false);
    expect(b.boosting).toBe(true);
    expect(b.energy).toBe(a.energy);
    for (let i = 0; i < 30; i++) {
      stepSector(a, go);
      expect(silentEvents(stepSector(b, go))).toEqual([]);
    }
    expect(b.energy).toBe(a.energy);
    expect(b.ship).toEqual(a.ship);
    // with no energy the request still drops Silent Running, and the normal validation refuses the boost
    const c = fight(L);
    stepSector(c, Z);
    c.energy = 0;
    expect(silentEvents(stepSector(c, go))).toEqual(['boost']);
    expect(c.silent).toBe(false);
    expect(c.boosting).toBe(false);
  });
  it('the shield does not regenerate while silent, and regenerates normally once it is off', () => {
    const { L } = world();
    const r = fight(L);
    stepSector(r, Z);
    r.shield = 0;
    r.sinceHit = 10_000;
    for (let i = 0; i < 120; i++) stepSector(r, NONE);
    expect(r.shield).toBe(0);
    stepSector(r, Z);
    for (let i = 0; i < 60; i++) stepSector(r, NONE);
    expect(r.shield).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------- enemy behaviour */
describe('hostile acquisition with Gravity Shadow and Silent Running', () => {
  // body (r 120) at the centre; observer 200 px west of it; pilot clear (south of the observer) or hidden (east of the body)
  const scene = (family: FamilyId = 'picket') => {
    const { L, cx, cy } = world([body(0, 0, 120)]);
    const r = fight(L);
    const a = foe(r, family, cx - 200, cy);
    const A = { a, x: cx - 200, y: cy };
    return { r, a, A, clear: { x: cx - 200, y: cy + 300 }, hidden: { x: cx + 200, y: cy }, behind: { x: cx - 200, y: cy - 0 }, cx, cy };
  };

  it('normal flight in clear space: acquires within detect range', () => {
    const { r, a, A, clear } = scene();
    hold(r, 1, clear, [A]);
    expect(a.target).toBe('player');
    expect(a.lost).toBe(0);
  });
  it('a body between blocks acquisition entirely (in range, any number of ticks)', () => {
    const { r, a, A, hidden } = scene();
    const ev = hold(r, 240, hidden, [A]);
    expect(a.target).toBeNull();
    expect(ev.filter((e) => e.type === 'enemyFired').length).toBe(0);
  });
  it('a body behind the pilot does not block', () => {
    const { L, cx, cy } = world([body(0, 0, 120)]);
    const r = fight(L);
    // observer far west, pilot between it and the body
    const a = foe(r, 'picket', cx - 600, cy);
    hold(r, 1, { x: cx - 250, y: cy }, [{ a, x: cx - 600, y: cy }]);
    expect(a.target).toBe('player');
  });
  it(`contact memory: exactly ${STEALTH.memoryTicks} AI steps at the frozen last-observed position, no fire, then the existing search`, () => {
    const { r, a, A, clear, hidden } = scene();
    hold(r, 120, clear, [A]); // acquired, reaction served, in attack
    expect(a.target).toBe('player');
    expect(a.reaction).toBe(0);
    const seenAt = { ...a.lastSeen! };
    expect(Math.hypot(seenAt.x - clear.x, seenAt.y - clear.y)).toBeLessThan(1); // the observed pose (the body's pull moves the ship a hair each tick)
    let fired = 0;
    for (let k = 1; k <= STEALTH.memoryTicks; k++) {
      const ev = hold(r, 1, hidden, [A]);
      fired += ev.filter((e) => e.type === 'enemyFired').length;
      expect(a.target).toBe('player');
      expect(a.lost).toBe(k);
      expect(a.lastSeen).toEqual(seenAt); // never the live position
      expect(a.windup).toBeNull();
      expect(stealthStatus(r)).toMatchObject({ tracking: 0, searching: 1 });
    }
    expect(fired).toBe(0);
    hold(r, 1, hidden, [A]);
    expect(a.target).toBeNull();
    expect(a.lost).toBe(0);
    expect(a.state).toBe('investigate');
    expect(a.lastSeen).toEqual(seenAt);
  });
  it('reacquires after leaving the shadow: inside the memory with no new reaction delay; after it, the delay starts again', () => {
    const { r, a, A, clear, hidden } = scene();
    hold(r, 120, clear, [A]);
    hold(r, 20, hidden, [A]);
    expect(a.lost).toBe(20);
    hold(r, 1, clear, [A]);
    expect(a.target).toBe('player');
    expect(a.lost).toBe(0);
    expect(a.reaction).toBe(0);
    expect(Math.hypot(a.lastSeen!.x - clear.x, a.lastSeen!.y - clear.y)).toBeLessThan(1);
    // past the memory the contact is gone; seeing the pilot again starts the reaction delay
    hold(r, STEALTH.memoryTicks + 1, hidden, [A]);
    expect(a.target).toBeNull();
    hold(r, 1, clear, [A]);
    expect(a.target).toBe('player');
    expect(a.reaction).toBe(Math.round(r.row.reaction * (0.8 + 0.4 * a.trait)));
  });
  it('the memory counts simulation ticks only: paused, it does not advance', () => {
    const { r, a, A, clear, hidden } = scene();
    hold(r, 120, clear, [A]);
    hold(r, 10, hidden, [A]);
    pauseSector(r);
    for (let i = 0; i < 500; i++) stepSector(r, NONE);
    expect(a.lost).toBe(10);
    expect(a.target).toBe('player');
    resumeSector(r);
    hold(r, 1, hidden, [A]);
    expect(a.lost).toBe(11);
  });
  it('a pilot who docks (or is otherwise no valid target) is dropped at once, never remembered', () => {
    const { r, a, A, clear, hidden } = scene();
    hold(r, 120, clear, [A]);
    hold(r, 5, hidden, [A]);
    r.docked = 'station-x';
    hold(r, 1, hidden, [A]);
    expect(a.target).toBeNull();
    expect(a.lost).toBe(0);
  });
  it('attacks still work in clear sight (the enemy fires after its reaction delay)', () => {
    const { r, A, clear } = scene();
    const ev = hold(r, 240, clear, [A]);
    expect(ev.filter((e) => e.type === 'enemyFired').length).toBeGreaterThan(0);
  });

  for (const fam of ['raider', 'capital'] as const) {
    it(`Silent Running range (${fam}, detect ${FAMILIES[fam].detect}): between the reduced and normal range no acquisition; inside it, acquisition`, () => {
      const { L, cx, cy } = world();
      const D = FAMILIES[fam].detect;
      const at = (dist: number, silent: boolean): Agent['target'] => {
        const r = fight(L);
        if (silent) stepSector(r, Z);
        const a = foe(r, fam, cx, cy - dist);
        hold(r, 3, { x: cx, y: cy }, [{ a, x: cx, y: cy - dist }]);
        return a.target;
      };
      expect(at(D * 0.9, false)).toBe('player');
      expect(at(D * 0.9, true)).toBeNull();
      expect(at(D * 0.35 + 1, true)).toBeNull();
      expect(at(D * 0.35 - 1, true)).toBe('player');
      expect(at(40, true)).toBe('player'); // never invisible up close
    });
  }

  it('going silent mid-contact: the 1.3x hold of the reduced range no longer covers the pilot; the contact fades after the memory', () => {
    const { L, cx, cy } = world();
    const r = fight(L);
    const D = FAMILIES.picket.detect;
    const a = foe(r, 'picket', cx, cy - D * 0.8);
    const A = { a, x: cx, y: cy - D * 0.8 };
    hold(r, 30, { x: cx, y: cy }, [A]);
    expect(a.target).toBe('player');
    hold(r, 1, { x: cx, y: cy }, [A], Z);
    expect(r.silent).toBe(true);
    expect(a.lost).toBe(1);
    hold(r, STEALTH.memoryTicks, { x: cx, y: cy }, [A]);
    expect(a.target).toBeNull();
  });
  it('both protections stack: silent inside the reduced range is still hidden by a body; clear of it, acquired', () => {
    const { L, cx, cy } = world([body(0, 0, 40)]);
    const r = fight(L);
    const a = foe(r, 'capital', cx - 130, cy); // silent: reduced range 800 x 0.35 = 280
    const A = { a, x: cx - 130, y: cy };
    stepSector(r, Z);
    hold(r, 30, { x: cx + 130, y: cy }, [A]); // 260 px, but the body (r 40) is between
    expect(r.ship.x - cx).toBeGreaterThan(129);
    expect(a.target).toBeNull();
    hold(r, 1, { x: cx - 130, y: cy + 260 }, [A]); // 260 px, clear
    expect(a.target).toBe('player');
  });
  it('nonvisual detection is kept: a hidden, silent pilot who shoots a ship is still revealed to it', () => {
    const { r, a, A, hidden } = scene();
    stepSector(r, Z);
    hold(r, 10, hidden, [A]);
    expect(a.target).toBeNull();
    damageAgent(r, a, 1, 'player', []);
    expect(a.state).toBe('investigate');
    expect(a.lastSeen).toEqual({ x: r.ship.x, y: r.ship.y });
    expect(Math.hypot(r.ship.x - hidden.x, r.ship.y - hidden.y)).toBeLessThan(1);
  });
  it('shots and missiles already in flight keep their rules while the pilot is silent', () => {
    const { L, cx, cy } = world();
    const fly = (silent: boolean) => {
      const r = fight(L);
      r.invuln = 0;
      put(r, cx, cy);
      if (silent) stepSector(r, Z);
      else stepSector(r, NONE);
      const a = foe(r, 'elite', cx - 300, cy);
      expect(spawnShot(r, a, 'missile', 0, 0, 'player')).toBe(true);
      expect(spawnShot(r, a, 'twin-lance', 0)).toBe(true);
      pin(a, cx - 4000, cy - 3000); // the shooter leaves: only the projectiles act
      const trail: number[] = [];
      for (let i = 0; i < 90; i++) {
        put(r, cx, cy);
        stepSector(r, NONE);
        trail.push(...r.enemyShots.flatMap((s) => [s.x, s.y]));
      }
      return { trail, hp: r.shield + r.hull };
    };
    const n = fly(false);
    const s = fly(true);
    expect(s.trail).toEqual(n.trail);
    expect(s.hp).toBe(n.hp);
    expect(s.hp).toBeLessThan(fight(L).shield + fight(L).hull);
  });
  it("the pilot's own target lock keeps its rules: Silent Running changes nothing about it (clear or behind a body)", () => {
    const go = (silent: boolean, where: 'clear' | 'hidden') => {
      const sc = scene();
      if (silent) stepSector(sc.r, Z);
      const ev = hold(sc.r, 1, sc[where], [sc.A], { moveX: 0, moveY: 0, lockToggle: true });
      return { types: ev.filter((e) => e.type.startsWith('shipLock')).map((e) => e.type), target: sc.r.shipLock.target === sc.a.id };
    };
    expect(go(true, 'clear')).toEqual(go(false, 'clear'));
    expect(go(true, 'clear').target).toBe(true);
    expect(go(true, 'hidden')).toEqual(go(false, 'hidden'));
  });
  it('is deterministic: the same scenario replays identically', () => {
    const play = () => {
      const { r, A, clear, hidden } = scene('lancer');
      const ev = [...hold(r, 90, clear, [A]), ...hold(r, 50, hidden, [A], Z), ...hold(r, 60, clear, [A])];
      return JSON.stringify({ ev, h: r.hostiles.map((h) => ({ ...h, beam: null })) });
    };
    expect(play()).toBe(play());
  });
  it('the full ship roster: every ship has the same signature and the same silent boundary; no stats change', () => {
    const { L, cx, cy } = world();
    const D = FAMILIES.picket.detect;
    for (const id of SHIP_IDS) {
      const before = JSON.stringify(deriveShip(id).stats);
      for (const [dist, want] of [
        [D * 0.35 - 1, 'player'],
        [D * 0.35 + 1, null],
      ] as const) {
        const r = fight(L, 7, id);
        stepSector(r, Z);
        expect(signature(r)).toBe(0.35);
        const a = foe(r, 'picket', cx + dist, cy);
        hold(r, 3, { x: cx, y: cy }, [{ a, x: cx + dist, y: cy }]);
        expect(a.target, `${id} at ${dist}`).toBe(want);
      }
      expect(JSON.stringify(deriveShip(id).stats)).toBe(before);
    }
  });
});

/* ------------------------------------------------------------------- input */
describe('Silent Running key (configurable input)', () => {
  it('Z by default, on no other action, panel, zoom, gravity-lab or admin key', () => {
    expect(FLIGHT_ACTIONS).toContain('silent');
    expect(DEFAULT_BINDINGS.silent).toEqual(['KeyZ', null]);
    const others = FLIGHT_ACTIONS.filter((x) => x !== 'silent').flatMap((x) => DEFAULT_BINDINGS[x]);
    expect(others).not.toContain('KeyZ');
    const fixed = [...Object.values(PANEL_KEYS).flat(), ...ZOOM_KEYS.in, ...ZOOM_KEYS.out, ...ADMIN_SEQUENCE];
    expect(fixed).not.toContain('KeyZ');
    // the gravity lab's hotkeys (dev builds) are read from its source: it is not imported here
    expect(readFileSync('src/modes/freeroam/gravity/labShell.ts', 'utf8')).not.toContain("'KeyZ'");
  });
  it('an older save without it gets Z (or a spare key when Z is taken) without being reset; it can be rebound', () => {
    const old = Object.fromEntries(FLIGHT_ACTIONS.filter((x) => x !== 'silent').map((x) => [x, DEFAULT_BINDINGS[x]]));
    const s1 = sanitizeBindings(old);
    expect(s1.repaired).toBe(false);
    expect(s1.bindings.silent).toEqual(['KeyZ', null]);
    const s2 = sanitizeBindings({ ...old, cargo: ['KeyZ', null] });
    expect(s2.repaired).toBe(false);
    expect(s2.bindings.cargo).toEqual(['KeyZ', null]);
    expect(s2.bindings.silent[0]).not.toBe('KeyZ');
    const all = FLIGHT_ACTIONS.flatMap((x) => s2.bindings[x].filter((k): k is string => k !== null));
    expect(new Set(all).size).toBe(all.length);
    const r = rebind(DEFAULT_BINDINGS, 'silent', 0, 'KeyN');
    expect(r.ok && r.bindings.silent[0]).toBe('KeyN');
  });
});

/* ------------------------------------------------------- P07.2 presentation */
describe('P07.2 stealth presentation: the AI\'s own shadow result, the HUD model, the inputs and the guide', () => {
  const scene = () => {
    const { L, cx, cy } = world([body(0, 0, 120)]);
    const r = fight(L);
    const a = foe(r, 'picket', cx - 200, cy);
    return { r, a, A: { a, x: cx - 200, y: cy }, cx, cy };
  };

  it('Gravity Shadow is recorded only when a body blocks a hostile that is close enough to see the pilot', () => {
    const { r, a, A, cx, cy } = scene();
    hold(r, 1, { x: cx + 200, y: cy }, [A]); // hidden: east of the body, in range
    expect(a.shadow).toBe(true);
    expect(stealthStatus(r)).toMatchObject({ shadowed: 1, tracking: 0 });
    hold(r, 1, { x: cx - 200, y: cy + 300 }, [A]); // clear line
    expect(a.shadow).toBe(false);
    expect(stealthStatus(r)).toMatchObject({ shadowed: 0, tracking: 1 });
  });

  it('proximity alone never counts: hugging the planet with a clear line, or a body behind the pilot, is not a shadow', () => {
    const { r, a, A, cx, cy } = scene();
    hold(r, 1, { x: cx, y: cy + 135 }, [{ a, x: cx - 200, y: cy + 135 }]); // 15 px off the surface, the line passes beside the body
    expect(a.shadow).toBe(false);
    expect(a.target).toBe('player');
    expect(stealthStatus(r).shadowed).toBe(0);
    const w = world([body(0, 0, 120)]);
    const r2 = fight(w.L);
    const b = foe(r2, 'picket', w.cx - 600, w.cy);
    hold(r2, 1, { x: w.cx - 250, y: w.cy }, [{ a: b, x: w.cx - 600, y: w.cy }]); // the body is behind the pilot
    expect(b.shadow).toBe(false);
    void A;
  });

  it('out of range is not a shadow (range and signature decide first); silent beyond the reduced range is not a shadow either', () => {
    const { r, a, cx, cy } = scene();
    hold(r, 1, { x: cx + 400, y: cy }, [{ a, x: cx - 200, y: cy }]); // 600 px > picket detect 480, body between
    expect(a.shadow).toBe(false);
    stepSector(r, Z);
    expect(r.silent).toBe(true);
    hold(r, 1, { x: cx + 200, y: cy }, [{ a, x: cx - 200, y: cy }]); // 400 px: inside 480, outside 480 x 0.35 = 168
    expect(a.shadow).toBe(false);
    expect(stealthStatus(r)).toMatchObject({ silent: true, shadowed: 0 });
  });

  it('per hostile: one blocked, one with a clear line; the count names only the blocked one and the other still tracks', () => {
    const { r, a, A, cx, cy } = scene();
    const b = foe(r, 'picket', cx + 200, cy + 300);
    const B = { a: b, x: cx + 200, y: cy + 300 };
    hold(r, 2, { x: cx + 200, y: cy }, [A, B]);
    expect(a.shadow).toBe(true);
    expect(b.shadow).toBe(false);
    expect(b.target).toBe('player');
    expect(stealthStatus(r)).toMatchObject({ shadowed: 1, tracking: 1 });
  });

  it('a disabled or destroyed hostile is not counted; a docked or arriving pilot is never shadowed', () => {
    const { r, a, A, cx, cy } = scene();
    hold(r, 1, { x: cx + 200, y: cy }, [A]);
    expect(stealthStatus(r).shadowed).toBe(1);
    a.state = 'disabled';
    expect(stealthStatus(r).shadowed).toBe(0);
    a.state = 'destroyed';
    expect(stealthStatus(r).shadowed).toBe(0);
    const s = scene();
    s.r.grace = 60; // arrival grace: no valid target
    hold(s.r, 1, { x: s.cx + 200, y: s.cy }, [s.A]);
    expect(s.a.shadow).toBe(false);
  });

  it('the HUD model: off is quiet and names the bound key (none on touch); on names low signature, the paused shield and what ends it', () => {
    const off = stealthHud({ silent: false, tracking: 0, searching: 0, shadowed: 0 }, 'Z', false);
    expect(off).toMatchObject({ on: false, state: 'SILENT', hint: 'Z · LOW SIGNATURE', tag: [] });
    expect(off.aria).toMatch(/^Silent running \(Z\): off/);
    expect(stealthHud({ silent: false, tracking: 0, searching: 0, shadowed: 0 }, 'N', true).hint).toBe('LOW SIGNATURE');
    const on = stealthHud({ silent: true, tracking: 0, searching: 0, shadowed: 0 }, 'N', false);
    expect(on.on).toBe(true);
    expect(on.state).toBe('SILENT RUNNING');
    expect(on.hint.split('\n')).toEqual(['LOW SIGNATURE', 'SHIELD RECHARGE PAUSED', 'FIRE OR BOOST ENDS IT']);
    expect(on.aria).toMatch(/\(N\)/);
    // touch: shorter lines for the narrow button, the same three facts; no key named where no key is in use
    const onT = stealthHud({ silent: true, tracking: 0, searching: 0, shadowed: 0 }, 'N', true);
    expect(onT.hint.split('\n')).toEqual(['LOW SIGNATURE', 'SHIELD PAUSED', 'FIRE/BOOST ENDS']);
    expect(onT.aria).toMatch(/^Silent running is on: low signature, shield recharge paused; firing or boosting ends it/);
    expect(stealthHud({ silent: false, tracking: 0, searching: 0, shadowed: 0 }, 'N', true).aria).toMatch(/^Silent running: off\./);
  });

  it('the stealth tag: only from the counts, singular / plural, says who still tracks, never claims invulnerability', () => {
    const t = (s: Partial<Parameters<typeof stealthHud>[0]>): readonly string[] => stealthHud({ silent: false, tracking: 0, searching: 0, shadowed: 0, ...s }, 'Z', false).tag;
    expect(t({})).toEqual([]);
    expect(t({ tracking: 3 })).toEqual([]); // being tracked alone adds nothing
    expect(t({ shadowed: 1 })).toEqual(['GRAVITY SHADOW', 'HIDDEN FROM 1 HOSTILE']);
    expect(t({ shadowed: 2, tracking: 1 })).toEqual(['GRAVITY SHADOW', 'HIDDEN FROM 2 HOSTILES', '1 HOSTILE STILL TRACKING']);
    expect(t({ searching: 2 })).toEqual(['2 HOSTILES SEARCHING', 'LAST KNOWN POSITION']);
    const all = [t({ shadowed: 3, tracking: 2, searching: 1 }), stealthHud({ silent: true, tracking: 1, searching: 1, shadowed: 1 }, 'Z', true).hint].flat().join(' ');
    expect(all).not.toMatch(/INVULN|IMMUNE|SAFE|CLOAK|INVISIBLE|PROTECT/);
    expect(all).not.toMatch(/\d{3,}/); // no coordinates or distances
  });

  it('the HUD follows the memory window: SEARCHING while the contact is held, gone once it expires', () => {
    const { r, a, A, cx, cy } = scene();
    hold(r, 120, { x: cx - 200, y: cy + 300 }, [A]);
    hold(r, 1, { x: cx + 200, y: cy }, [A]);
    expect(stealthHud(stealthStatus(r), 'Z', false).tag).toContain('LAST KNOWN POSITION');
    hold(r, STEALTH.memoryTicks + 1, { x: cx + 200, y: cy }, [A]);
    expect(a.lost).toBe(0);
    expect(stealthHud(stealthStatus(r), 'Z', false).tag).not.toContain('LAST KNOWN POSITION');
    expect(stealthHud(stealthStatus(r), 'Z', false).tag[0]).toBe('GRAVITY SHADOW');
  });

  it('touch SILENT: its own pointer role, one latched toggle per press, never the stick; L3 on a pad', () => {
    const p = new FlightPointers();
    p.silentDown(1);
    p.silentDown(2); // a second finger while one holds it: no second toggle
    expect(p.takeSilentPress()).toBe(true);
    expect(p.takeSilentPress()).toBe(false); // read once
    expect(p.stickDown(1, 10, 10)).toBe(false); // the SILENT finger never becomes the stick
    p.release(1);
    p.release(2);
    expect(p.snapshot().silentTouches).toBe(0);
    p.stickDown(3, 0, 0);
    p.silentDown(3); // the stick finger cannot press it
    expect(p.takeSilentPress()).toBe(false);
    const snap = (pressed: boolean[]) => ({ axes: [0, 0, 0, 0], pressed }) as unknown as Parameters<typeof padSilent>[0];
    expect(PAD.silent).toEqual([10]);
    expect(padSilent(snap(Array.from({ length: 16 }, (_, i) => i === 10)))).toBe(true);
    expect(padSilent(snap(Array.from({ length: 16 }, (_, i) => i === 11)))).toBe(false); // R3 is NEXT WEAPON
    expect(padSilent(null)).toBe(false);
    for (const k of ['fire', 'boost', 'weapon'] as const) expect(PAD[k]).not.toContain(10);
  });

  it('the guide: the current key, the touch button and L3; Silent Running and Gravity Shadow explained without overclaiming', () => {
    const base = { ...DEFAULT_GUIDE_CONTEXT, mode: 'freeroam' as const };
    const kb = freeRoamKeyboard(DEFAULT_BINDINGS, false).find((x) => x.id === 'silent');
    expect(kb?.keys).toEqual([['Z']]);
    const moved = rebind(DEFAULT_BINDINGS, 'silent', 0, 'KeyN');
    if (!moved.ok) throw new Error('rebind');
    expect(freeRoamKeyboard(moved.bindings, false).find((x) => x.id === 'silent')?.keys).toEqual([['N']]);
    expect(stepText(guideStep('controls', { ...base, input: 'keyboard', bindings: moved.bindings }))).toMatch(/Press N to cut your signature/);
    expect(freeRoamTouch().find((x) => x.id === 'silent')?.keys).toEqual([['SILENT']]);
    expect(freeRoamController().find((x) => x.id === 'silent')?.keys).toEqual([['L3']]);
    for (const input of ['keyboard', 'touch', 'controller'] as const) {
      const text = stepText(guideStep('controls', { ...base, input }));
      for (const w of ['SILENT RUNNING', 'NOT INVISIBLE', 'Hostiles close by still detect you', 'does not recharge', 'fire or boost ends it', 'GRAVITY SHADOW', 'PER HOSTILE', 'LAST KNOWN', 'NOT A SHIELD']) expect(text).toContain(w);
      expect(text).not.toMatch(/invulnerab|cloak|admin|password/i);
    }
  });
});
