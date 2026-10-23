/**
 * Pilot missile skill (Combat P03, FR-TD-85). One guided missile on a
 * cooldown, launched by a deliberate press in normal Free Roam flight.
 * Pure simulation on the fixed 60 Hz step (no DOM, no wall clock, no unseeded randomness).
 *
 * Lifecycle (one press):
 *   press (rising edge of SectorInput.missile; holding never repeats)
 *   -> validate: phase is flight, not docked, not cooling down, energy >= cost,
 *      and a valid target in front of the nose (see `pickTarget`)
 *        refused: a `missileRefused` event (no target / low energy / cooling);
 *        nothing is consumed, so the pilot can line up and press again
 *   -> acquiring: lock brackets close on the target for `lockTicks`; the lock
 *      holds while the target stays alive, hostile, in sight and inside the
 *      looser keep range / cone. Lost -> `missileLockLost`, nothing consumed
 *   -> launch: energy is spent and the cooldown starts; the missile leaves the
 *      nose at the ship's forward speed plus `launchSpeed`
 *   -> guidance: accelerates to `speed`, turns at most `turn` rad/s toward the
 *      target (pure pursuit: predictable, and a hard break can outturn it).
 *      Elites see it coming and may dodge (ai.ts `incoming`)
 *   -> impact / expiry: the first ship it sweeps through (its target or any
 *      ship hostile to the pilot; the nearest along the sweep when two overlap)
 *      takes `damage` once through damageAgent (shield first, the usual kill /
 *      salvage / provoke rules), and the missile is removed in the same step.
 *      Rocks, landmarks, solid POIs, the sector edge and the end of its life
 *      remove it with no damage. If its target dies or becomes invalid it flies
 *      straight for at most `lostLife` more ticks
 *   -> cleanup: recall, restart and sector unload drop every missile and reset
 *      the skill; a paused run is not stepped, so nothing advances while paused.
 *
 * Bounded: at most `maxLive` missiles exist (the cooldown is longer than a
 * missile's life, so in practice one), each lives at most `lifeTicks`.
 * No new resource: it spends the ship's existing boost energy.
 */
import type { SectorEvent, SectorInput, SectorRun } from '../sector/run.ts';
import { FAMILIES } from './families.ts';
import { inInterference } from './hazards.ts';
import type { Agent } from './state.ts';
import { damageAgent, hostileTo, shotBlocked, sweptHit, TICK } from './world.ts';

/**
 * Tunables (measured in tests/combatMeasure.test.ts; reasoning in
 * docs/freeroam/COMBAT_P03.md). Distances in art px, times in 60 Hz ticks.
 */
export const MISSILE = Object.freeze({
  /** Acquisition: a target must be this close... */
  range: 600,
  /** ...and within this half-angle of the nose (rad, ~31 deg): aim decides the target. */
  cone: 0.55,
  /** The lock holds while the target stays inside this range and half-angle. */
  keepRange: 720,
  keepCone: 1.0,
  /** Sensor interference (pilot or target inside it) shortens the acquisition range. */
  jammedRangeMul: 0.6,
  /** Lock time before launch (0.3 s; was 0.5 s in the first P03 cut, shortened after playtest feedback). */
  lockTicks: 18,
  /** Speed added to the ship's forward speed at launch, top speed and acceleration (px/s, px/s^2). */
  launchSpeed: 200,
  speed: 470,
  accel: 900,
  /** Turn limit (rad/s): turning radius ~150 px at top speed. */
  turn: 3.2,
  /** Flight time (2.5 s) and the straight flight left after the target is lost. */
  lifeTicks: 150,
  lostLife: 45,
  /** Damage of the one impact (shield first, like every hit). */
  damage: 18,
  /** Cooldown from launch (12 s) and the energy spent at launch. */
  cooldownTicks: 720,
  energy: 30,
  /** Collision radius and the live cap. */
  radius: 4,
  maxLive: 2,
  /** How long a notice (NO TARGET, LOCK LOST, HIT...) stays on the HUD. */
  noticeTicks: 60,
});

export type MissileSkillState = 'ready' | 'acquiring' | 'cooldown';
export type MissileNotice = 'noTarget' | 'lowEnergy' | 'cooling' | 'lockLost' | 'launched' | 'hit' | 'kill' | 'miss';

export interface MissileSkill {
  state: MissileSkillState;
  /** Acquiring: the hostile being locked and the ticks locked so far. */
  target: number | null;
  lock: number;
  /** Cooling down: ticks left. */
  cooldown: number;
  /** The input last tick (edge detection: holding never repeats). */
  held: boolean;
  /** The latest feedback for the HUD, and ticks left to show it. */
  notice: MissileNotice | null;
  noticeTicks: number;
  /** Counters for this visit (diagnostics / tests). */
  launches: number;
  hits: number;
}

/** A pilot missile in flight (temporary entity). */
export interface PlayerMissile {
  readonly id: number;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  speed: number;
  life: number;
  /** Hostile id it homes on; null once lost (then it flies straight). */
  target: number | null;
}

export function freshMissileSkill(): MissileSkill {
  return { state: 'ready', target: null, lock: 0, cooldown: 0, held: false, notice: null, noticeTicks: 0, launches: 0, hits: 0 };
}

/** Drop every missile and reset the skill (recall, restart, unload). */
export function resetMissiles(run: SectorRun): void {
  run.missiles.length = 0;
  run.missile = freshMissileSkill();
}

const angleDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
/** World direction of the nose (heading 0 = up, clockwise), as atan2(y, x). */
const noseAngle = (heading: number): number => heading - Math.PI / 2;

/** Line of sight from the ship to a point: rocks, landmarks, solid POIs, and a flight hook's planet (the gravity lab). */
function sightClear(run: SectorRun, x: number, y: number): boolean {
  const L = run.layout;
  const s = run.ship;
  if (run.flight?.sightBlocked?.(s.x, s.y, x, y)) return false;
  for (const l of L.landmarks) if (sweptHit(s.x, s.y, x, y, l.x, l.y, l.r)) return false;
  const minX = Math.min(s.x, x);
  const maxX = Math.max(s.x, x);
  const minY = Math.min(s.y, y);
  const maxY = Math.max(s.y, y);
  for (const k of L.rocks) {
    if (k.x + k.r < minX || k.x - k.r > maxX || k.y + k.r < minY || k.y - k.r > maxY) continue;
    if (sweptHit(s.x, s.y, x, y, k.x, k.y, k.r)) return false;
  }
  for (const p of L.pois) if (p.solidR > 0 && sweptHit(s.x, s.y, x, y, p.x, p.y, p.solidR)) return false;
  return true;
}

/** Whether `a` may be (or stay) the missile's target: alive, hostile to the pilot, inside range and cone, in sight. */
export function validTarget(run: SectorRun, a: Agent, range: number, cone: number): boolean {
  if (a.state === 'destroyed' || a.hull <= 0 || !hostileTo(run, a.faction, 'player')) return false;
  const s = run.ship;
  const jam = inInterference(run.layout, s) || inInterference(run.layout, a) ? MISSILE.jammedRangeMul : 1;
  const d = Math.hypot(a.x - s.x, a.y - s.y);
  if (d > range * jam) return false;
  if (angleDiff(Math.atan2(a.y - s.y, a.x - s.x), noseAngle(s.heading)) > cone) return false;
  return sightClear(run, a.x, a.y);
}

/**
 * The target a press would lock: among valid hostiles in front of the nose,
 * the one closest to the aim line, nearer ones breaking ties (the pilot picks
 * by pointing). Wary factions that have not been provoked are never picked.
 */
export function pickTarget(run: SectorRun): Agent | null {
  const s = run.ship;
  const nose = noseAngle(s.heading);
  let best: Agent | null = null;
  let bestScore = Infinity;
  for (const a of run.hostiles) {
    if (!validTarget(run, a, MISSILE.range, MISSILE.cone)) continue;
    const off = angleDiff(Math.atan2(a.y - s.y, a.x - s.x), nose) / MISSILE.cone;
    const score = off + 0.5 * (Math.hypot(a.x - s.x, a.y - s.y) / MISSILE.range);
    if (score < bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

const agentById = (run: SectorRun, id: number | null): Agent | null => (id === null ? null : (run.hostiles.find((a) => a.id === id && a.state !== 'destroyed') ?? null));

function notify(run: SectorRun, n: MissileNotice): void {
  run.missile.notice = n;
  run.missile.noticeTicks = MISSILE.noticeTicks;
}

function launch(run: SectorRun, target: Agent, events: SectorEvent[]): void {
  const sk = run.missile;
  const s = run.ship;
  const nose = noseAngle(s.heading);
  const nx = Math.cos(nose);
  const ny = Math.sin(nose);
  const speed = MISSILE.launchSpeed + Math.max(0, s.vx * nx + s.vy * ny);
  const x = s.x + nx * (run.tune.radius + 6);
  const y = s.y + ny * (run.tune.radius + 6);
  run.missiles.push({ id: run.nextMissile++, x, y, px: x, py: y, vx: nx * speed, vy: ny * speed, speed, life: MISSILE.lifeTicks, target: target.id });
  run.energy = Math.max(0, run.energy - MISSILE.energy);
  sk.state = 'cooldown';
  sk.cooldown = MISSILE.cooldownTicks;
  sk.target = null;
  sk.lock = 0;
  sk.launches += 1;
  notify(run, 'launched');
  events.push({ type: 'missileLaunched', hostile: target.id, x, y });
}

/** The skill for one tick: edge-triggered activation, the lock, the cooldown. Call before stepMissiles. */
export function stepMissileSkill(run: SectorRun, input: SectorInput, events: SectorEvent[]): void {
  const sk = run.missile;
  const down = input.missile === true;
  const pressed = down && !sk.held;
  sk.held = down;
  if (sk.noticeTicks > 0 && --sk.noticeTicks === 0) sk.notice = null;

  if (sk.state === 'cooldown') {
    sk.cooldown -= 1;
    if (sk.cooldown <= 0) {
      sk.cooldown = 0;
      sk.state = 'ready';
      events.push({ type: 'missileReady' });
    } else if (pressed) {
      notify(run, 'cooling');
      events.push({ type: 'missileRefused', reason: 'cooling' });
    }
    return;
  }

  if (sk.state === 'acquiring') {
    const t = agentById(run, sk.target);
    if (!t || run.docked || !validTarget(run, t, MISSILE.keepRange, MISSILE.keepCone)) {
      sk.state = 'ready';
      sk.target = null;
      sk.lock = 0;
      notify(run, 'lockLost');
      events.push({ type: 'missileLockLost' });
      return;
    }
    sk.lock += 1;
    if (sk.lock >= MISSILE.lockTicks) {
      if (run.energy < MISSILE.energy) {
        // energy spent on boost during the lock: refuse, nothing consumed
        sk.state = 'ready';
        sk.target = null;
        sk.lock = 0;
        notify(run, 'lowEnergy');
        events.push({ type: 'missileRefused', reason: 'lowEnergy' });
        return;
      }
      launch(run, t, events);
    }
    return;
  }

  // ready
  if (!pressed || run.docked) return;
  if (run.missiles.length >= MISSILE.maxLive) {
    notify(run, 'cooling');
    events.push({ type: 'missileRefused', reason: 'cooling' });
    return;
  }
  if (run.energy < MISSILE.energy) {
    notify(run, 'lowEnergy');
    events.push({ type: 'missileRefused', reason: 'lowEnergy' });
    return;
  }
  const t = pickTarget(run);
  if (!t) {
    notify(run, 'noTarget');
    events.push({ type: 'missileRefused', reason: 'noTarget' });
    return;
  }
  sk.state = 'acquiring';
  sk.target = t.id;
  sk.lock = 0;
  events.push({ type: 'missileLock', hostile: t.id, x: t.x, y: t.y });
}

/** Move every missile; guide, collide, damage once, expire. */
export function stepMissiles(run: SectorRun, events: SectorEvent[]): void {
  const L = run.layout;
  for (let i = run.missiles.length - 1; i >= 0; i--) {
    const m = run.missiles[i]!;
    m.px = m.x;
    m.py = m.y;
    const t = agentById(run, m.target);
    if (m.target !== null && (!t || !hostileTo(run, t.faction, 'player'))) {
      m.target = null; // target gone: fly straight, briefly
      m.life = Math.min(m.life, MISSILE.lostLife);
    }
    m.speed = Math.min(MISSILE.speed, m.speed + MISSILE.accel * TICK);
    let ang = Math.atan2(m.vy, m.vx);
    if (t && m.target !== null) {
      let d = Math.atan2(t.y - m.y, t.x - m.x) - ang;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const turn = MISSILE.turn * TICK;
      ang += Math.max(-turn, Math.min(turn, d));
    }
    m.vx = Math.cos(ang) * m.speed;
    m.vy = Math.sin(ang) * m.speed;
    m.x += m.vx * TICK;
    m.y += m.vy * TICK;
    m.life -= 1;

    // one impact: the nearest ship along this tick's sweep
    let hit: Agent | null = null;
    let hitD = Infinity;
    for (const a of run.hostiles) {
      if (a.state === 'destroyed') continue;
      if (a.id !== m.target && !hostileTo(run, a.faction, 'player')) continue; // passes wary ships it was not aimed at
      if (!sweptHit(m.px, m.py, m.x, m.y, a.x, a.y, FAMILIES[a.family].radius + MISSILE.radius)) continue;
      const d = Math.hypot(a.x - m.px, a.y - m.py);
      if (d < hitD) {
        hitD = d;
        hit = a;
      }
    }
    if (hit) {
      damageAgent(run, hit, MISSILE.damage, 'player', events);
      const killed = hit.state === 'destroyed';
      run.missile.hits += 1;
      notify(run, killed ? 'kill' : 'hit');
      events.push({ type: 'missileHit', hostile: hit.id, x: m.x, y: m.y, damage: MISSILE.damage, killed });
      run.missiles.splice(i, 1);
      continue;
    }
    const blocked = shotBlocked(L, m.px, m.py, m.x, m.y, MISSILE.radius) || (run.flight?.sightBlocked?.(m.px, m.py, m.x, m.y) ?? false);
    if (m.life <= 0 || blocked || m.x < 0 || m.y < 0 || m.x > L.width || m.y > L.height) {
      if (run.missile.notice === 'launched' || run.missile.notice === null) notify(run, 'miss');
      events.push({ type: 'missileExpired', x: m.x, y: m.y });
      run.missiles.splice(i, 1);
    }
  }
}
