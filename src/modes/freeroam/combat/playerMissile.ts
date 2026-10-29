/**
 * Pilot ordnance (Combat P03 missile skill, generalised in Combat P03C,
 * FR-TD-89): the heavy missile, the lock-on missile and the nuke, fired with
 * FIRE while selected. Pure simulation on the fixed 60 Hz step (no DOM, no
 * wall clock, no unseeded randomness). Every gameplay number comes from the
 * shared catalogue (config/weapons.ts); the selection, per-weapon cooldowns
 * and fire checks are the mode-neutral arsenal (core/weapons/arsenal.ts).
 *
 * Trigger (one press = at most one launch; holding never repeats; plasma
 * keeps its hold-to-fire gun in sector/run.ts):
 *   press -> fireGate: not mountable / not in the rotation -> 'unavailable';
 *            cooling, a full live cap, an empty magazine or too little
 *            energy -> refused with a `missileRefused` event; nothing is
 *            consumed, so the pilot can press again
 *   heavy missile, nuke -> launch at once along the nose
 *   lock-on -> needs a valid target in front of the nose (`pickTarget`); the
 *            lock closes over `lockTicks` while the target stays valid, then
 *            launches. No target / lock lost / switching weapon: nothing is
 *            consumed
 *   launch -> the magazine (stock) or the energy (lock-on) is spent and that
 *            weapon's cooldown starts (the others keep theirs)
 *
 * Flight: accelerates to `speed`; the lock-on turns at most `turn` rad/s
 * toward its target (pure pursuit, never snaps; a hard break outturns it) and
 * flies straight for `lostLife` ticks once the target is gone. Unguided
 * weapons fly straight.
 *
 * End of flight (each missile resolves exactly once, in the step it ends):
 *   ship hit (the nearest hostile along the sweep; wary ships it was not
 *     aimed at are passed): that ship takes `impactDamage` once, then the
 *     blast (if any) damages every OTHER hostile ship within `blast.radius`,
 *     falling linearly to `edgeMul` at the edge, once each; enemy missiles in
 *     the radius are shot down and mines are set off
 *   rock / landmark / solid POI: detonate there (onExpiry 'detonate': heavy,
 *     nuke) or fizzle with no damage (lock-on)
 *   end of life: the same choice (a timed fuse, or a fizzle)
 *   sector edge: removed with no blast
 * Capital-class bosses take `bossMul` of every hit. The nuke's detonation
 * also opens a time-dilation zone (combat/dilation.ts).
 *
 * Cleanup: recall, restart and sector unload drop every missile, the lock
 * and every dilation zone; a paused run is not stepped.
 */
import { WEAPON_BY_ID, type AmmoRule, type Guidance, type OrdnanceWeapon, type WeaponId } from '../../../config/weapons.ts';
import { cycleWeapon, fireGate, startCooldown, tickArsenal, type FireGate } from '../../../core/weapons/arsenal.ts';
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import { openZone } from './dilation.ts';
import { FAMILIES } from './families.ts';
import { inInterference } from './hazards.ts';
import { triggerMine } from './projectiles.ts';
import { focusKeepCone, focusLockTicks } from './shipAbilities.ts';
import type { Agent } from './state.ts';
import { damageAgent, hostileTo, shotBlocked, sweptHit, TICK } from './world.ts';

const LOCK = WEAPON_BY_ID.get('lock-missile') as OrdnanceWeapon;
const LOCK_GUIDE = LOCK.guidance as Extract<Guidance, { kind: 'lock' }>;
const LOCK_AMMO = LOCK.ammo as Extract<AmmoRule, { kind: 'energy' }>;

/**
 * Tunables (measured in tests/combatMeasure.test.ts; reasoning in
 * docs/freeroam/COMBAT_P03.md). Distances in art px, times in 60 Hz ticks.
 * The lock-on missile's values as the HUD and tests read them; every gameplay
 * value comes from the shared weapon catalogue (config/weapons.ts,
 * `lock-missile`), the same definition the Armory shows; only the HUD notice
 * time lives here.
 */
export const MISSILE = Object.freeze({
  /** Acquisition: a target must be this close... */
  range: LOCK_GUIDE.acquire.range,
  /** ...and within this half-angle of the nose (rad, ~31 deg): aim decides the target. */
  cone: LOCK_GUIDE.acquire.cone,
  /** The lock holds while the target stays inside this range and half-angle. */
  keepRange: LOCK_GUIDE.acquire.keepRange,
  keepCone: LOCK_GUIDE.acquire.keepCone,
  /** Sensor interference (pilot or target inside it) shortens the acquisition range. */
  jammedRangeMul: LOCK_GUIDE.acquire.jammedRangeMul,
  /** Lock time before launch (0.3 s; was 0.5 s in the first P03 cut, shortened after playtest feedback). */
  lockTicks: LOCK_GUIDE.acquire.lockTicks,
  /** Speed added to the ship's forward speed at launch, top speed and acceleration (px/s, px/s^2). */
  launchSpeed: LOCK.projectile.launchSpeed,
  speed: LOCK.projectile.speed,
  accel: LOCK.projectile.accel,
  /** Turn limit (rad/s): turning radius ~150 px at top speed. */
  turn: LOCK_GUIDE.turn,
  /** Flight time (2.5 s) and the straight flight left after the target is lost. */
  lifeTicks: LOCK.projectile.lifeTicks,
  lostLife: LOCK_GUIDE.lostLife,
  /** Damage of the direct impact (shield first, like every hit); its small blast hits the ships around it. */
  damage: LOCK.impactDamage,
  /** Cooldown from launch (12 s) and the energy spent at launch. */
  cooldownTicks: LOCK.cooldownTicks,
  energy: LOCK_AMMO.cost,
  /** Collision radius and the live cap. */
  radius: LOCK.projectile.radius,
  maxLive: LOCK.projectile.maxLive,
  /** How long a notice (NO TARGET, LOCK LOST, HIT...) stays on the HUD. */
  noticeTicks: 60,
});

/** Lock-on acquisition (the other weapons launch on the press). */
export type MissileSkillState = 'ready' | 'acquiring';
export type MissileNotice = 'noTarget' | 'lowEnergy' | 'cooling' | 'empty' | 'unavailable' | 'busy' | 'lockLost' | 'launched' | 'hit' | 'kill' | 'miss' | 'blast';
export type RefusalReason = Exclude<FireGate, 'ok'> | 'noTarget';

export interface MissileSkill {
  state: MissileSkillState;
  /** Acquiring: the hostile being locked and the ticks locked so far. */
  target: number | null;
  lock: number;
  /** FIRE last tick (edge detection: holding never repeats a launch). */
  held: boolean;
  /** The latest feedback for the HUD, the weapon it is about, and ticks left to show it. */
  notice: MissileNotice | null;
  noticeWeapon: WeaponId | null;
  noticeTicks: number;
  /** Counters for this visit (diagnostics / tests). */
  launches: number;
  hits: number;
}

/** A pilot missile or warhead in flight (temporary entity). */
export interface PlayerMissile {
  readonly id: number;
  readonly weapon: WeaponId;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  speed: number;
  life: number;
  /** Hostile id it homes on (lock-on); null for unguided weapons and once lost (then it flies straight). */
  target: number | null;
}

export function freshMissileSkill(): MissileSkill {
  return { state: 'ready', target: null, lock: 0, held: false, notice: null, noticeWeapon: null, noticeTicks: 0, launches: 0, hits: 0 };
}

/** Drop every missile, the lock and every dilation zone (recall, restart, unload). Cooldowns and magazines are kept. */
export function resetMissiles(run: SectorRun): void {
  run.missiles.length = 0;
  run.dilation.length = 0;
  const held = run.missile.held;
  run.missile = freshMissileSkill();
  run.missile.held = held; // a FIRE still held through a reset must not count as a new press
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
 * P04.1: the ship-locked hostile (X, combat/shipLock.ts) comes first, but only
 * when it passes this missile's own range, cone and line-of-sight rules; the
 * acquisition time, energy and cooldown are unchanged.
 */
export function pickTarget(run: SectorRun): Agent | null {
  const locked = agentById(run, run.shipLock.target);
  if (locked && validTarget(run, locked, MISSILE.range, MISSILE.cone)) return locked;
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
const ordnance = (id: WeaponId): OrdnanceWeapon | null => {
  const w = WEAPON_BY_ID.get(id);
  return w && w.fire === 'ordnance' ? w : null;
};

function notify(run: SectorRun, n: MissileNotice, weapon: WeaponId | null): void {
  run.missile.notice = n;
  run.missile.noticeWeapon = weapon;
  run.missile.noticeTicks = MISSILE.noticeTicks;
}

function refuse(run: SectorRun, weapon: WeaponId, reason: RefusalReason, events: SectorEvent[]): void {
  notify(run, reason, weapon);
  events.push({ type: 'missileRefused', reason, weapon });
}

const liveOf = (run: SectorRun, id: WeaponId): number => run.missiles.reduce((n, m) => n + (m.weapon === id ? 1 : 0), 0);

/** Whether `id` could fire right now (the HUD and the touch button show the same answer the trigger acts on). */
export function gateOf(run: SectorRun, id: WeaponId): FireGate {
  // P04 admin sandbox: magazines never run dry and launches need no energy (the cooldown still gates)
  if (run.unlimitedAmmo) return fireGate(run.arsenal, id, { stock: () => Number.POSITIVE_INFINITY, energy: null, live: liveOf(run, id) });
  return fireGate(run.arsenal, id, { stock: (w) => run.ammo[w] ?? 0, energy: run.energy, live: liveOf(run, id) });
}

function cancelLock(run: SectorRun): void {
  const sk = run.missile;
  sk.state = 'ready';
  sk.target = null;
  sk.lock = 0;
}

/**
 * Switch weapons one step (1 = next, -1 = previous) through the rotation,
 * wrapping. Never fires; a lock in progress is cancelled (nothing consumed);
 * cooldowns and magazines are untouched.
 */
export function switchWeapon(run: SectorRun, dir: 1 | -1, events: SectorEvent[]): boolean {
  if (!cycleWeapon(run.arsenal, dir)) return false;
  if (run.missile.state === 'acquiring') cancelLock(run);
  run.missile.notice = null;
  run.missile.noticeTicks = 0;
  events.push({ type: 'weaponSwitched', weapon: run.arsenal.selected });
  return true;
}

function launch(run: SectorRun, w: OrdnanceWeapon, target: Agent | null, events: SectorEvent[]): void {
  const sk = run.missile;
  const s = run.ship;
  const nose = noseAngle(s.heading);
  const nx = Math.cos(nose);
  const ny = Math.sin(nose);
  const speed = w.projectile.launchSpeed + Math.max(0, s.vx * nx + s.vy * ny);
  const x = s.x + nx * (run.tune.radius + 6);
  const y = s.y + ny * (run.tune.radius + 6);
  run.missiles.push({ id: run.nextMissile++, weapon: w.id, x, y, px: x, py: y, vx: nx * speed, vy: ny * speed, speed, life: w.projectile.lifeTicks, target: target ? target.id : null });
  if (w.ammo.kind === 'energy' && !run.unlimitedAmmo) run.energy = Math.max(0, run.energy - w.ammo.cost);
  if (w.ammo.kind === 'stock' && !run.unlimitedAmmo) {
    const left = Math.max(0, (run.ammo[w.id] ?? 0) - 1);
    run.ammo[w.id] = left;
    events.push({ type: 'ordnanceSpent', weapon: w.id, left });
  }
  startCooldown(run.arsenal, w.id);
  cancelLock(run);
  sk.launches += 1;
  notify(run, 'launched', w.id);
  events.push({ type: 'missileLaunched', weapon: w.id, hostile: target ? target.id : null, x, y });
}

/**
 * The trigger for one tick: cooldowns, the FIRE press edge for the selected
 * ordnance weapon, the lock-on acquisition. Call before stepMissiles. FIRE
 * with plasma selected is the gun (sector/run.ts) and does nothing here.
 */
export function stepMissileSkill(run: SectorRun, fireDown: boolean, events: SectorEvent[]): void {
  const sk = run.missile;
  const pressed = fireDown && !sk.held;
  sk.held = fireDown;
  if (sk.noticeTicks > 0 && --sk.noticeTicks === 0) {
    sk.notice = null;
    sk.noticeWeapon = null;
  }
  for (const id of tickArsenal(run.arsenal)) events.push({ type: 'missileReady', weapon: id as WeaponId });
  const id = run.arsenal.selected;
  const w = ordnance(id);
  if (sk.state === 'acquiring') {
    const t = agentById(run, sk.target);
    // P08.1 Predator Focus (Shrike) widens only the hold cone and shortens only the lock time; range, sight and the pick are unchanged
    if (!w || w.guidance.kind !== 'lock' || !t || run.docked || !validTarget(run, t, MISSILE.keepRange, focusKeepCone(run, MISSILE.keepCone))) {
      cancelLock(run);
      notify(run, 'lockLost', id);
      events.push({ type: 'missileLockLost' });
      return;
    }
    sk.lock += 1;
    if (sk.lock >= focusLockTicks(run, w.guidance.acquire.lockTicks)) {
      // re-checked at launch: boost may have spent the energy during the lock (refused, nothing consumed)
      const gate = gateOf(run, id);
      if (gate !== 'ok') {
        cancelLock(run);
        refuse(run, id, gate, events);
        return;
      }
      launch(run, w, t, events);
    }
    return;
  }
  if (!pressed || run.docked || !w) return;
  const gate = gateOf(run, id);
  if (gate !== 'ok') {
    refuse(run, id, gate, events);
    return;
  }
  if (w.guidance.kind !== 'lock') {
    launch(run, w, null, events);
    return;
  }
  const t = pickTarget(run);
  if (!t) {
    refuse(run, id, 'noTarget', events);
    return;
  }
  sk.state = 'acquiring';
  sk.target = t.id;
  sk.lock = 0;
  events.push({ type: 'missileLock', hostile: t.id, x: t.x, y: t.y });
}

const bossClass = (a: Agent): boolean => a.role === 'boss' || a.family === 'capital';

/**
 * Detonation at (x, y): the blast damages every hostile ship within its
 * radius except the one struck directly, once each; shoots down enemy
 * missiles and sets off mines inside it; the nuke opens its dilation zone.
 */
function detonate(run: SectorRun, w: OrdnanceWeapon, x: number, y: number, direct: Agent | null, events: SectorEvent[]): void {
  let hits = direct ? 1 : 0;
  let kills = direct && direct.state === 'destroyed' ? 1 : 0;
  const b = w.blast;
  if (b) {
    for (const a of run.hostiles) {
      if (a === direct || a.state === 'destroyed' || !hostileTo(run, a.faction, 'player')) continue;
      const d = Math.max(0, Math.hypot(a.x - x, a.y - y) - FAMILIES[a.family].radius);
      if (d > b.radius) continue;
      const dmg = b.damage * (1 - (1 - b.edgeMul) * (d / b.radius)) * (bossClass(a) ? w.damageRules.bossMul : 1);
      damageAgent(run, a, dmg, 'player', events);
      hits += 1;
      if ((a.state as string) === 'destroyed') kills += 1;
    }
    for (let j = run.enemyShots.length - 1; j >= 0; j--) {
      const m = run.enemyShots[j]!;
      if (m.kind !== 'missile' || Math.hypot(m.x - x, m.y - y) > b.radius) continue;
      run.enemyShots.splice(j, 1);
      events.push({ type: 'shotDown', x: m.x, y: m.y });
    }
    for (const m of run.mines) if (Math.hypot(m.x - x, m.y - y) <= b.radius) triggerMine(m);
  }
  if (w.dilation) openZone(run, x, y, w.dilation, events);
  run.missile.hits += hits > 0 ? 1 : 0;
  if (hits > 0) notify(run, kills > 0 ? 'kill' : direct ? 'hit' : 'blast', w.id);
  else notify(run, 'miss', w.id);
  events.push({ type: 'detonation', weapon: w.id, x, y, r: b ? b.radius : 0, hits, kills });
}

/** Move every missile; guide, collide, damage once, detonate or fizzle, expire. */
export function stepMissiles(run: SectorRun, events: SectorEvent[]): void {
  const L = run.layout;
  for (let i = run.missiles.length - 1; i >= 0; i--) {
    const m = run.missiles[i]!;
    const w = ordnance(m.weapon);
    if (!w) {
      run.missiles.splice(i, 1);
      continue;
    }
    const g = w.guidance;
    m.px = m.x;
    m.py = m.y;
    const t = agentById(run, m.target);
    if (g.kind === 'lock' && m.target !== null && (!t || !hostileTo(run, t.faction, 'player'))) {
      m.target = null; // target gone: fly straight, briefly
      m.life = Math.min(m.life, g.lostLife);
    }
    m.speed = Math.min(w.projectile.speed, m.speed + w.projectile.accel * TICK);
    let ang = Math.atan2(m.vy, m.vx);
    if (g.kind === 'lock' && t && m.target !== null) {
      let d = Math.atan2(t.y - m.y, t.x - m.x) - ang;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const turn = g.turn * TICK;
      ang += Math.max(-turn, Math.min(turn, d));
    }
    m.vx = Math.cos(ang) * m.speed;
    m.vy = Math.sin(ang) * m.speed;
    m.x += m.vx * TICK;
    m.y += m.vy * TICK;
    m.life -= 1;
    const r = w.projectile.radius;
    // one impact: the nearest ship along this tick's sweep
    let hit: Agent | null = null;
    let hitD = Infinity;
    for (const a of run.hostiles) {
      if (a.state === 'destroyed') continue;
      if (a.id !== m.target && !hostileTo(run, a.faction, 'player')) continue; // passes wary ships it was not aimed at
      if (!sweptHit(m.px, m.py, m.x, m.y, a.x, a.y, FAMILIES[a.family].radius + r)) continue;
      const d = Math.hypot(a.x - m.px, a.y - m.py);
      if (d < hitD) {
        hitD = d;
        hit = a;
      }
    }
    if (hit) {
      const dmg = w.impactDamage * (bossClass(hit) ? w.damageRules.bossMul : 1);
      damageAgent(run, hit, dmg, 'player', events);
      events.push({ type: 'missileHit', weapon: w.id, hostile: hit.id, x: m.x, y: m.y, damage: dmg, killed: hit.state === 'destroyed' });
      run.missiles.splice(i, 1);
      detonate(run, w, m.x, m.y, hit, events);
      continue;
    }
    if (m.x < 0 || m.y < 0 || m.x > L.width || m.y > L.height) {
      // left the sector: gone, no blast
      notify(run, 'miss', w.id);
      events.push({ type: 'missileExpired', weapon: w.id, x: m.px, y: m.py });
      run.missiles.splice(i, 1);
      continue;
    }
    const blocked = shotBlocked(L, m.px, m.py, m.x, m.y, r) || (run.flight?.sightBlocked?.(m.px, m.py, m.x, m.y) ?? false);
    if (blocked || m.life <= 0) {
      run.missiles.splice(i, 1);
      // a solid stops it where it touched (the last free point); the fuse bursts it where it is
      const x = blocked ? m.px : m.x;
      const y = blocked ? m.py : m.y;
      if (w.projectile.onExpiry === 'detonate') detonate(run, w, x, y, null, events);
      else {
        notify(run, 'miss', w.id);
        events.push({ type: 'missileExpired', weapon: w.id, x, y });
      }
    }
  }
}
