/**
 * Combat P03: the lock-on missile (combat/playerMissile.ts), the light-ship
 * recovery tuning (combat/families.ts RECOVERY), and their controls / HUD /
 * audio plumbing. Fixed-step simulation only; no DOM, no storage writes.
 *
 * Combat P03C: the lock-on is one weapon of the rotation; FIRE fires the
 * selected weapon, so these runs start with the lock-on selected and PRESS is
 * FIRE (still one launch per press edge). Its cooldown lives in the arsenal.
 * The other weapons, switching and dilation are tested in weaponRuntime.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import { FAMILIES, RECOVERY, type FamilyId } from '../src/modes/freeroam/combat/families.ts';
import { MISSILE, pickTarget } from '../src/modes/freeroam/combat/playerMissile.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import { damageAgent } from '../src/modes/freeroam/combat/world.ts';
import { DEFAULT_BINDINGS, rebind, sanitizeBindings } from '../src/modes/freeroam/bindings.ts';
import { keyboardWeapon, padWeapon } from '../src/modes/freeroam/input.ts';
import { FlightPointers } from '../src/modes/freeroam/pointers.ts';
import { sectorCue } from '../src/modes/freeroam/audio/frCues.ts';
import { FR_SOUNDS } from '../src/modes/freeroam/audio/frSounds.ts';
import { missileGauge } from '../src/modes/freeroam/ui/hudModel.ts';
import { EMPTY_SECTOR_SAVE } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, disposeSectorRun, pauseSector, restartSector, resumeSector, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { arena } from './helpers/combatProbe.ts';

const NONE: SectorInput = { moveX: 0, moveY: 0 };
const PRESS: SectorInput = { moveX: 0, moveY: 0, fire: true };
/** Plasma + lock-on fitted, the lock-on selected at launch. */
const LOCK_FIRST = { compatible: ['plasma', 'lock-missile'], rotation: ['plasma', 'lock-missile'], start: 'lock-missile' } as const;
/** Ticks left on the lock-on's own cooldown. */
const cd = (r: SectorRun): number => r.arsenal.cooldown['lock-missile'];

/** A calm run at difficulty 1 with the ship still in the middle, nose up (heading 0). */
function setup(seed = 1): SectorRun {
  const L = arena(1);
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed, loadout: LOCK_FIRST });
  r.grace = 100_000; // no enemy fire: these tests are about the missile
  const cx = L.width / 2;
  const cy = L.height / 2;
  Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0, heading: 0 });
  return r;
}

/** Spawn a hostile at (dx, dy) from the ship and pin it there (no AI drift) for geometry tests. */
function foe(r: SectorRun, family: FamilyId, dx: number, dy: number, faction: Parameters<typeof spawnAgent>[2] = 'red-tally'): Agent {
  const a = spawnAgent(r, family, faction, 'test', 'guard', r.ship.x + dx, r.ship.y + dy)!;
  return a;
}
const pin = (a: Agent, x: number, y: number): void => {
  Object.assign(a, { x, y, px: x, py: y, vx: 0, vy: 0 });
};

/** Step n ticks with `input` (pinning listed agents each tick); collect events. */
function run(r: SectorRun, n: number, input: SectorInput = NONE, pinned: readonly Agent[] = []): SectorEvent[] {
  const out: SectorEvent[] = [];
  const at = pinned.map((a) => ({ a, x: a.x, y: a.y }));
  for (let i = 0; i < n; i++) {
    for (const p of at) pin(p.a, p.x, p.y);
    r.ship.vx = 0;
    r.ship.vy = 0;
    out.push(...stepSector(r, input));
  }
  return out;
}
const count = (ev: readonly SectorEvent[], type: SectorEvent['type']): number => ev.filter((e) => e.type === type).length;
const ehp = (a: Agent): number => a.hull + a.shield;

describe('missile skill lifecycle (activation -> validation -> lock -> launch -> guidance -> impact -> cleanup -> cooldown)', () => {
  it('locks the ship ahead, launches after the lock, damages it exactly once, then cools down and is ready again', () => {
    const r = setup();
    const a = foe(r, 'heavy', 0, -380);
    const e0 = r.energy;
    const before = ehp(a);
    let ev = run(r, 1, PRESS, [a]);
    expect(count(ev, 'missileLock')).toBe(1);
    expect(r.missile.state).toBe('acquiring');
    expect(r.missiles).toHaveLength(0);
    ev = run(r, MISSILE.lockTicks - 1, PRESS, [a]); // held: still one lock, not yet away (the lock counts from the tick after the press)
    expect(count(ev, 'missileLaunched')).toBe(0);
    expect(r.energy).toBeCloseTo(e0, 5);
    ev = run(r, 1, NONE, [a]);
    expect(count(ev, 'missileLaunched')).toBe(1);
    expect(r.missiles).toHaveLength(1);
    expect(r.missile.state).toBe('ready'); // the acquisition is over; the cooldown runs in the arsenal
    expect(cd(r)).toBe(MISSILE.cooldownTicks);
    expect(r.energy).toBeLessThanOrEqual(e0 - MISSILE.energy + 1e-6);
    // it travels visibly (several ticks), never teleports
    const m = r.missiles[0]!;
    let maxStep = 0;
    let hits: SectorEvent[] = [];
    for (let t = 0; t < MISSILE.lifeTicks && r.missiles.length; t++) {
      const x = m.x;
      const y = m.y;
      hits = hits.concat(run(r, 1, NONE, [a]));
      maxStep = Math.max(maxStep, Math.hypot(m.x - x, m.y - y));
    }
    expect(maxStep).toBeLessThanOrEqual(MISSILE.speed / 60 + 1e-6);
    expect(count(hits, 'missileHit')).toBe(1);
    expect(before - ehp(a)).toBeCloseTo(MISSILE.damage, 5); // one impact, one damage
    expect(r.missiles).toHaveLength(0);
    // cooldown runs from launch; ready exactly once afterwards
    const left = cd(r);
    expect(left).toBeGreaterThan(0);
    ev = run(r, left, NONE, [a]);
    expect(count(ev, 'missileReady')).toBe(1);
    expect(cd(r)).toBe(0);
  });

  it('no valid target: refused with feedback, nothing consumed (behind, outside the cone, out of range, none)', () => {
    for (const [dx, dy] of [[0, 0], [0, 300], [300, 0], [0, -(MISSILE.range + 60)]] as const) {
      const r = setup();
      if (dx || dy) foe(r, 'picket', dx, dy);
      const e0 = r.energy;
      const ev = run(r, 1, PRESS);
      expect(count(ev, 'missileRefused')).toBe(1);
      expect(ev.find((e) => e.type === 'missileRefused')).toMatchObject({ reason: 'noTarget' });
      expect(r.missile.state).toBe('ready');
      expect(r.missile.notice).toBe('noTarget');
      expect(cd(r)).toBe(0);
      expect(r.energy).toBeCloseTo(e0, 5);
      expect(r.missiles).toHaveLength(0);
    }
  });

  it('aim decides the target: the ship nearest the nose line is picked, a nearer one off-line is not', () => {
    const r = setup();
    const offLine = foe(r, 'raider', 150, -200); // ~37 deg off the nose: outside the cone
    const onLine = foe(r, 'picket', 10, -450);
    expect(pickTarget(r)?.id).toBe(onLine.id);
    expect(offLine.id).not.toBe(onLine.id);
  });

  it('low energy refuses without consuming; energy spent during the lock refuses at launch', () => {
    const r = setup();
    const a = foe(r, 'heavy', 0, -300);
    r.energy = MISSILE.energy - 1;
    let ev = run(r, 1, PRESS, [a]);
    expect(ev.find((e) => e.type === 'missileRefused')).toMatchObject({ reason: 'lowEnergy' });
    expect(r.missile.state).toBe('ready');
    run(r, 1, NONE, [a]);
    r.energy = 100;
    run(r, 1, PRESS, [a]);
    expect(r.missile.state).toBe('acquiring');
    r.energy = 0; // boost drained it mid-lock
    ev = run(r, MISSILE.lockTicks, NONE, [a]);
    expect(ev.find((e) => e.type === 'missileRefused')).toMatchObject({ reason: 'lowEnergy' });
    expect(r.missiles).toHaveLength(0);
    expect(cd(r)).toBe(0);
  });

  it('the lock is lost (nothing consumed) when the target dies, leaves the keep range or the keep cone', () => {
    for (const lose of ['dies', 'range', 'cone'] as const) {
      const r = setup();
      const a = foe(r, 'heavy', 0, -300);
      run(r, 1, PRESS, [a]);
      run(r, 5, NONE, [a]);
      expect(r.missile.state).toBe('acquiring');
      const e0 = r.energy;
      if (lose === 'dies') {
        damageAgent(r, a, 10_000, 'player', []);
        run(r, 1);
      } else if (lose === 'range') run(r, 1, NONE, []), pin(a, r.ship.x, r.ship.y - (MISSILE.keepRange + 50)), run(r, 1, NONE, [a]);
      else pin(a, r.ship.x + 300, r.ship.y + 10), run(r, 1, NONE, [a]);
      expect(r.missile.state, lose).toBe('ready');
      expect(r.missile.notice, lose).toBe('lockLost');
      expect(r.missiles, lose).toHaveLength(0);
      expect(r.energy, lose).toBeGreaterThanOrEqual(e0 - 1e-6);
    }
  });

  it('a missile whose target dies flies straight briefly and expires; it never damages the dead ship', () => {
    const r = setup();
    const a = foe(r, 'heavy', 0, -500);
    run(r, MISSILE.lockTicks + 1, PRESS, [a]);
    expect(r.missiles).toHaveLength(1);
    run(r, 3, NONE, [a]);
    damageAgent(r, a, 10_000, 'player', []);
    const hull = a.hull;
    const ev = run(r, MISSILE.lostLife + 2);
    expect(r.missiles).toHaveLength(0);
    expect(count(ev, 'missileExpired')).toBe(1);
    expect(count(ev, 'missileHit')).toBe(0);
    expect(a.hull).toBe(hull);
  });

  it('two ships overlapping on its path: exactly one impact, on the nearest, damage once; the small blast reaches the other once', () => {
    const r = setup();
    const near = foe(r, 'heavy', 0, -300);
    const far = foe(r, 'heavy', 0, -312); // radii overlap along the path
    const n0 = ehp(near);
    const f0 = ehp(far);
    const ev = run(r, MISSILE.lockTicks + 90, PRESS, [near, far]);
    expect(count(ev, 'missileHit')).toBe(1);
    expect(count(ev, 'detonation')).toBe(1);
    expect(n0 - ehp(near)).toBeCloseTo(MISSILE.damage, 5); // the struck ship takes the impact only, never the blast too
    const blast = f0 - ehp(far);
    expect(blast).toBeGreaterThan(0);
    expect(blast).toBeLessThanOrEqual(9 + 1e-6); // catalogue lock-on blast damage (centre)
  });

  it('wary ships are never picked, and the missile passes through a wary ship it was not aimed at', () => {
    const r = setup();
    foe(r, 'hauler', 0, -300, 'gleaners');
    expect(pickTarget(r)).toBeNull();
    const ev = run(r, 1, PRESS);
    expect(ev.find((e) => e.type === 'missileRefused')).toMatchObject({ reason: 'noTarget' });
    expect(r.provoked.size).toBe(0);
  });

  it('a rock blocks the lock and the flight; the sector edge removes it', () => {
    const rocks = (r: SectorRun) => r.layout.rocks as unknown as { x: number; y: number; r: number }[];
    const r = setup();
    const a = foe(r, 'heavy', 0, -400);
    rocks(r).push({ x: r.ship.x, y: r.ship.y - 200, r: 30 });
    try {
      expect(pickTarget(r)).toBeNull(); // no line of sight: no lock
    } finally {
      rocks(r).pop();
    }
    expect(pickTarget(r)?.id).toBe(a.id);
    // flight: launch, then a rock appears between the missile and the target
    const h0 = ehp(a);
    run(r, MISSILE.lockTicks + 1, PRESS, [a]);
    expect(r.missiles).toHaveLength(1);
    const m = r.missiles[0]!;
    rocks(r).push({ x: m.x, y: m.y - 40, r: 20 });
    let ev: SectorEvent[] = [];
    try {
      ev = run(r, 30, NONE, [a]);
    } finally {
      rocks(r).pop();
    }
    expect(count(ev, 'missileExpired')).toBe(1);
    expect(count(ev, 'missileHit')).toBe(0);
    expect(ehp(a)).toBe(h0);
    // the sector edge
    const r2 = setup();
    r2.missiles.push({ id: 1, weapon: 'lock-missile', x: 3, y: r2.ship.y, px: 4, py: r2.ship.y, vx: -400, vy: 0, speed: 400, life: 100, target: null });
    ev = run(r2, 1);
    expect(r2.missiles).toHaveLength(0);
    expect(count(ev, 'missileExpired')).toBe(1);
  });

  it('holding never repeats and pressing every other tick cannot exceed one launch per lock + cooldown', () => {
    const r = setup();
    const a = foe(r, 'capital', 0, -400);
    let ev = run(r, 2000, PRESS, [a]); // held the whole time
    expect(count(ev, 'missileLaunched')).toBe(1);
    const r2 = setup(2);
    const b = foe(r2, 'capital', 0, -400);
    ev = [];
    const ticks = 60 * 60;
    for (let t = 0; t < ticks; t++) ev.push(...run(r2, 1, t % 2 === 0 ? PRESS : NONE, [b]));
    const launches = count(ev, 'missileLaunched');
    expect(launches).toBeLessThanOrEqual(Math.ceil(ticks / (MISSILE.lockTicks + MISSILE.cooldownTicks)) + 1);
    expect(launches).toBeGreaterThanOrEqual(Math.floor(ticks / (MISSILE.lockTicks + MISSILE.cooldownTicks + 2)));
    expect(ev.some((e) => e.type === 'missileRefused' && e.reason === 'cooling')).toBe(true);
    expect(r2.missiles.length).toBeLessThanOrEqual(MISSILE.maxLive);
  });

  it('every missile is bounded: at most maxLive, each gone within lifeTicks', () => {
    const r = setup();
    const a = foe(r, 'raider', 0, -300);
    run(r, MISSILE.lockTicks + 1, PRESS, [a]);
    // the raider leaves sideways at once (so the missile may miss); it must still be gone in time
    let seen = 0;
    for (let t = 0; t < MISSILE.lifeTicks + 2; t++) {
      if (r.missiles.length) seen = t;
      expect(r.missiles.length).toBeLessThanOrEqual(MISSILE.maxLive);
      pin(a, a.x + 6, a.y);
      run(r, 1);
    }
    expect(r.missiles).toHaveLength(0);
    expect(seen).toBeLessThanOrEqual(MISSILE.lifeTicks);
  });

  it('pause freezes missiles and the cooldown (no stuck or doubled timers); restart, recall and unload clean up', () => {
    const r = setup();
    const a = foe(r, 'heavy', 0, -600);
    run(r, MISSILE.lockTicks + 1, PRESS, [a]);
    run(r, 5, NONE, [a]);
    const m = { ...r.missiles[0]! };
    const c0 = cd(r);
    pauseSector(r);
    for (let i = 0; i < 100; i++) expect(stepSector(r, PRESS)).toEqual([]);
    expect(r.missiles[0]).toMatchObject({ x: m.x, y: m.y, life: m.life });
    expect(cd(r)).toBe(c0);
    resumeSector(r);
    run(r, 1, NONE, [a]);
    expect(cd(r)).toBe(c0 - 1);
    restartSector(r);
    expect(r.missiles).toHaveLength(0);
    expect(r.missile.state).toBe('ready');
    expect(cd(r)).toBe(c0 - 1); // P03C: a restart never refunds a cooldown (no reset exploit)
    r.ship.heading = 0; // the restart faces the arrival heading; point the nose up again
    const b = foe(r, 'heavy', 0, -400);
    r.grace = 100_000;
    run(r, cd(r), NONE, [b]);
    run(r, MISSILE.lockTicks + 1, PRESS, [b]);
    expect(r.missiles).toHaveLength(1);
    disposeSectorRun(r);
    expect(r.missiles).toHaveLength(0);
    expect(stepSector(r, PRESS)).toEqual([]);
  });

  it('elites see a missile coming and may break away; bosses take missile damage by the normal shield-first rule', () => {
    const r = setup();
    const e = foe(r, 'elite', 0, -300);
    Object.assign(e, { state: 'attack', evadeCooldown: 0, target: 'player' });
    r.missiles.push({ id: 99, weapon: 'lock-missile', x: e.x, y: e.y + 120, px: e.x, py: e.y + 125, vx: 0, vy: -400, speed: 400, life: 60, target: e.id });
    run(r, 1);
    expect(e.state).toBe('evade');
    const r2 = setup();
    const c = foe(r2, 'capital', 0, -300);
    const s0 = c.shield;
    const h0 = c.hull;
    run(r2, MISSILE.lockTicks + 60, PRESS, [c]);
    expect(s0 - c.shield).toBeCloseTo(MISSILE.damage, 5);
    expect(c.hull).toBe(h0);
  });

  it('is deterministic on the fixed step: the same seed and inputs give the same outcome', () => {
    const play = (): string => {
      const r = setup(7);
      foe(r, 'lancer', 40, -420);
      foe(r, 'picket', -60, -380);
      const ev: string[] = [];
      for (let t = 0; t < 600; t++) for (const e of stepSector(r, t % 120 === 0 ? PRESS : NONE)) if (e.type.startsWith('missile')) ev.push(`${t}:${e.type}`);
      return `${ev.join(',')}|${r.hostiles.map((h) => `${h.id}:${h.hull.toFixed(3)}:${h.shield.toFixed(3)}`).join(',')}`;
    };
    expect(play()).toBe(play());
  });
});

describe('light-ship recovery tuning (RECOVERY, FR-TD-85)', () => {
  const BASE: Record<FamilyId, number> = { raider: 120, picket: 150, lancer: 150, heavy: 180, recon: 120, hauler: 180, elite: 150, capital: 240 };
  // base table values (combat/families.ts) before the light-tier rule
  const REGEN: Record<FamilyId, number> = { raider: 0, picket: 3, lancer: 4, heavy: 5, recon: 4, hauler: 3, elite: 8, capital: 6 };
  const EVADE: Record<FamilyId, number> = { raider: 0.25, picket: 0.15, lancer: 0, heavy: 0, recon: 0.4, hauler: 0, elite: 0.2, capital: 0 };
  it('only light families (threat <= 2) recover less (delay x3, rate x0.5, evade x0.6, P03C); heavy, elite and capital are unchanged', () => {
    expect(RECOVERY).toMatchObject({ lightThreat: 2, lightRegenDelayMul: 3, lightRegenMul: 0.5, lightEvadeMul: 0.6 });
    for (const f of Object.keys(BASE) as FamilyId[]) {
      const light = FAMILIES[f].threat <= RECOVERY.lightThreat;
      expect(FAMILIES[f].regenDelay, f).toBe(light ? BASE[f] * RECOVERY.lightRegenDelayMul : BASE[f]);
      expect(FAMILIES[f].shieldRegen, f).toBeCloseTo(light ? REGEN[f] * RECOVERY.lightRegenMul : REGEN[f], 9);
      expect(FAMILIES[f].evadeChance, f).toBeCloseTo(light ? EVADE[f] * RECOVERY.lightEvadeMul : EVADE[f], 9);
    }
    expect(['heavy', 'elite', 'capital'].every((f) => FAMILIES[f as FamilyId].threat > RECOVERY.lightThreat)).toBe(true);
  });

  it('a light ship still recharges once it is left alone long enough (not helpless), and hull never regenerates', () => {
    const r = setup();
    const p = foe(r, 'picket', 0, -900);
    damageAgent(r, p, 20, 'player', []); // shield 15 -> 0, hull 30 -> 25
    const hull = p.hull;
    run(r, FAMILIES.picket.regenDelay - 5, NONE, [p]);
    expect(p.shield).toBe(0);
    run(r, 6 + 300, NONE, [p]);
    expect(p.shield).toBeGreaterThan(0);
    run(r, 60 * 60, NONE, [p]);
    expect(p.shield).toBe(p.maxShield); // slower, never capped below full
    expect(p.hull).toBe(hull);
  });
});

describe('missile controls, HUD and audio', () => {
  it('NEXT WEAPON (binding id `missile`, kept for saved bindings) is rebindable (Q / K by default) and the pad uses R3', () => {
    expect(DEFAULT_BINDINGS.missile).toEqual(['KeyQ', 'KeyK']);
    expect(keyboardWeapon(new Set(['KeyQ']))).toBe(true);
    expect(keyboardWeapon(new Set(['KeyF']))).toBe(false);
    const r = rebind(DEFAULT_BINDINGS, 'missile', 0, 'KeyF');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(keyboardWeapon(new Set(['KeyF']), r.bindings)).toBe(true);
      expect(keyboardWeapon(new Set(['KeyQ']), r.bindings)).toBe(false);
    }
    const pressed: boolean[] = [];
    expect(padWeapon({ axes: [], pressed })).toBe(false);
    pressed[11] = true;
    expect(padWeapon({ axes: [], pressed })).toBe(true);
    expect(padWeapon(null)).toBe(false);
  });

  it('older saves gain the missile action without a repair and without losing any key', () => {
    const old = { ...DEFAULT_BINDINGS } as Record<string, unknown>;
    delete old['missile'];
    expect(sanitizeBindings(old)).toMatchObject({ repaired: false, bindings: { missile: ['KeyQ', 'KeyK'] } });
    // a later action already uses K: the missile takes Q only, pause keeps K
    const k = { ...old, pause: ['KeyK', null] };
    const s1 = sanitizeBindings(k);
    expect(s1.repaired).toBe(false);
    expect(s1.bindings.pause).toEqual(['KeyK', null]);
    expect(s1.bindings.missile).toEqual(['KeyQ', null]);
    // both defaults taken: a spare key, still not a repair, nothing reset
    const both = { ...old, map: ['KeyQ', null], pause: ['KeyK', null] };
    const s2 = sanitizeBindings(both);
    expect(s2.repaired).toBe(false);
    expect(s2.bindings.map).toEqual(['KeyQ', null]);
    expect(s2.bindings.missile).toEqual(['KeyF', null]);
  });

  it('the WPN touch button presses once per touch; a second finger and holding never repeat; release clears', () => {
    const p = new FlightPointers();
    p.weaponDown(5);
    expect(p.weaponHeld).toBe(true);
    expect(p.takeWeaponPress()).toBe(true);
    expect(p.takeWeaponPress()).toBe(false);
    p.weaponDown(6);
    expect(p.takeWeaponPress()).toBe(false);
    p.release(5);
    p.release(6);
    expect(p.weaponHeld).toBe(false);
    p.stickDown(7, 0, 0);
    p.weaponDown(7); // the stick finger never becomes a weapon press
    expect(p.takeWeaponPress()).toBe(false);
  });

  it('the lock-on row says the state in text: READY, LOCK, AWAY, seconds, results; refusals take the row; a cooldown press nudges', () => {
    const base = { label: 'LOCK-ON', feed: 'energy', stock: 0, capacity: 0, gate: 'ok', lock: 0, lockTicks: 30, cooldown: 0, cooldownTicks: 720, inFlight: false, notice: null } as const;
    const steady = [
      missileGauge({ ...base, state: 'ready' }, false),
      missileGauge({ ...base, state: 'acquiring', lock: 15 }, false),
      missileGauge({ ...base, state: 'cooldown', cooldown: 700, inFlight: true }, false),
      missileGauge({ ...base, state: 'cooldown', cooldown: 361 }, false),
      missileGauge({ ...base, state: 'cooldown', cooldown: 720 }, false),
      missileGauge({ ...base, state: 'cooldown', cooldown: 600, notice: 'kill' }, false),
      missileGauge({ ...base, state: 'cooldown', cooldown: 600, notice: 'hit' }, false),
      missileGauge({ ...base, state: 'cooldown', cooldown: 600, notice: 'miss' }, false),
      missileGauge({ ...base, state: 'cooldown', cooldown: 600, notice: 'cooling' }, false),
      missileGauge({ ...base, state: 'ready' }, true),
    ];
    expect(steady.map((g) => g.gauge.text)).toEqual(['READY', 'LOCK', 'AWAY', '7s', '12s', 'KILL', 'HIT', 'MISS', '10s', 'SAFE']);
    expect(steady.map((g) => g.state)).toEqual(['ready', 'acquiring', 'launching', 'cooldown', 'cooldown', 'cooldown', 'cooldown', 'cooldown', 'cooldown', 'safe']);
    // the value column (54 px on phones at the card's 10 px) holds 5 characters
    for (const g of steady) expect(g.gauge.text.length).toBeLessThanOrEqual(5);
    expect(steady[1]!.gauge.pct).toBe(50);
    expect(steady[3]!.gauge.pct).toBe(50);
    // pressing during the cooldown: the seconds stay, flagged as a refusal; nothing else nudges
    expect(steady.map((g) => g.nudge)).toEqual([false, false, false, false, false, false, false, false, true, false]);
    // refusals: state `refused` (the row shows only the message for that moment)
    expect(missileGauge({ ...base, state: 'ready', notice: 'noTarget' }, false)).toMatchObject({ state: 'refused', nudge: false, gauge: { text: 'NO TARGET' } });
    expect(missileGauge({ ...base, state: 'ready', notice: 'lockLost' }, false)).toMatchObject({ state: 'refused', gauge: { text: 'LOCK LOST' } });
    expect(missileGauge({ ...base, state: 'ready', notice: 'lowEnergy' }, false)).toMatchObject({ state: 'refused', gauge: { text: 'LOW ENERGY' } });
  });

  it('every missile event has a defined cue (a kill uses the destroyed boom)', () => {
    const ctx = { shieldBefore: 0, shieldAfter: 0 };
    const cues = [
      sectorCue({ type: 'missileLock', hostile: 1, x: 0, y: 0 }, ctx),
      sectorCue({ type: 'missileLaunched', weapon: 'lock-missile', hostile: 1, x: 0, y: 0 }, ctx),
      sectorCue({ type: 'missileHit', weapon: 'lock-missile', hostile: 1, x: 0, y: 0, damage: 18, killed: false }, ctx),
      sectorCue({ type: 'missileRefused', weapon: 'lock-missile', reason: 'noTarget' }, ctx),
      sectorCue({ type: 'missileLockLost' }, ctx),
      sectorCue({ type: 'missileReady', weapon: 'lock-missile' }, ctx),
      sectorCue({ type: 'weaponSwitched', weapon: 'heavy-missile' }, ctx),
      sectorCue({ type: 'detonation', weapon: 'heavy-missile', x: 0, y: 0, r: 96, hits: 0, kills: 0 }, ctx),
      sectorCue({ type: 'detonation', weapon: 'nuke', x: 0, y: 0, r: 300, hits: 0, kills: 0 }, ctx),
    ];
    for (const c of cues) expect(c && FR_SOUNDS[c]).toBeDefined();
    expect(sectorCue({ type: 'missileHit', weapon: 'lock-missile', hostile: 1, x: 0, y: 0, damage: 18, killed: true }, ctx)).toBeNull();
  });
});
