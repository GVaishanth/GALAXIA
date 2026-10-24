/**
 * Ship target lock (P04.1): X / the LOCK touch button selects one hostile
 * ship and the nose keeps facing it. Pure simulation on the fixed 60 Hz step
 * (no DOM, no clock, no randomness).
 *
 * What the lock does: it supplies the AIM of the existing orientation rule
 * (sim.ts stepShip: the nose turns toward an aim at the ship's capped
 * `aimTurnRate`, the short way, never past it). That is the only thing it
 * changes. It never writes the position or the velocity, never thrusts,
 * fires, pursues or evades, and gravity, collisions and every control keep
 * working as before (movement in a normal sector follows the stick, not the
 * nose). Mouse aim and the right stick are overridden while a lock holds; the
 * nose returns to them, or to the direction of travel, at the same capped
 * rate when the lock ends (nothing snaps).
 *
 * Ship lock is not the missile lock: toggling it never launches anything or
 * spends ammunition. The lock-on missile still needs its own acquisition
 * (range, cone, line of sight, `lockTicks`, energy, cooldown); it merely
 * prefers the locked ship when that ship passes those rules
 * (playerMissile.ts pickTarget).
 *
 * Choice (deterministic): an existing missile acquisition target is reused
 * when it is eligible; otherwise, among eligible hostiles (alive, hostile to
 * the pilot so unprovoked wary factions never qualify, inside `range`
 * (shortened by sensor interference) and in line of sight), the lowest score
 * wins: angle off the nose (0 ahead .. 1 behind) plus `distanceWeight` x
 * distance / range, so ships ahead or near the nose come first and nearer
 * ones break ties; an exact tie goes to the lower id.
 *
 * The lock holds while the ship exists, is alive, is still hostile, stays
 * inside the sector and stays within `keepRange` (off screen is fine; line of
 * sight is not needed to keep it). It ends, with a reason the HUD can show,
 * when the pilot toggles it off, the ship is destroyed or leaves, it stops
 * being a valid target (no longer hostile, outside the sector), it drifts out
 * of range, or the run recalls, restarts, docks or is unloaded. It is never
 * re-acquired or moved to another ship by itself.
 *
 * Next target (C / the touch NEXT TARGET button, P04.1 polish): only while a
 * lock holds, and only by the pilot's press. The candidates are the ships X
 * could lock now (same rules, the current target excluded). The order is a
 * clockwise sweep around the pilot starting at the current target's bearing:
 * the smallest clockwise turn comes next, a ship on the same bearing comes
 * next only if it is farther (nearer ones wait for the wrap), then distance,
 * then id. Repeated presses therefore visit every eligible ship once before
 * coming back, whichever way the nose points. With no other candidate the lock
 * stays where it is ("ONLY TARGET"); with no lock, nothing is locked ("NO
 * TARGET LOCKED": X locks). Cycling never fires and never spends anything.
 */
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import { FAMILIES } from './families.ts';
import { validTarget } from './playerMissile.ts';
import type { Agent } from './state.ts';
import { hostileTo } from './world.ts';

/** Tunables, in art px (the sector's world units). The view shows roughly 360 x 640 art px at zoom 1. */
export const SHIP_LOCK = Object.freeze({
  /** Acquisition range: beyond the widest view (zoomed out, combat framing ~590 px to the edge), inside COMBAT.wakeRadius (1400). */
  range: 900,
  /** The lock holds out to this distance (hysteresis, so it does not flicker at the edge of `range`). */
  keepRange: 1100,
  /** How much distance counts against the angle off the nose when choosing. */
  distanceWeight: 0.6,
  /** How long a lock notice stays readable on the HUD (ticks). */
  noticeTicks: 90,
});

export type ShipLockEnd = 'cancelled' | 'destroyed' | 'gone' | 'range' | 'invalid';
export type ShipLockNotice = 'acquired' | 'switched' | 'noTarget' | 'unavailable' | 'noLock' | 'onlyTarget' | ShipLockEnd;

export interface ShipLock {
  /** The locked hostile's id, or null. */
  target: number | null;
  /** The latest feedback (acquired, NO TARGET, lost...) and ticks left to show it. */
  notice: ShipLockNotice | null;
  noticeTicks: number;
  /** Counters for this visit (diagnostics / tests). */
  acquired: number;
  switched: number;
}

export function freshShipLock(): ShipLock {
  return { target: null, notice: null, noticeTicks: 0, acquired: 0, switched: 0 };
}

const TAU = Math.PI * 2;
/** Absolute difference of two angles, 0..pi. */
const angleDiff = (a: number, b: number): number => {
  const d = (((a - b) % TAU) + TAU) % TAU;
  return d > Math.PI ? TAU - d : d;
};
/** World direction of the nose (heading 0 = up, clockwise), as atan2(y, x). */
const noseAngle = (heading: number): number => heading - Math.PI / 2;

/** Inside the sector's bounds (world boundaries: nothing beyond the edge is a target). */
const inSector = (run: SectorRun, a: Agent): boolean => a.x >= 0 && a.y >= 0 && a.x <= run.layout.width && a.y <= run.layout.height;
/** Could be locked now: inside the sector, alive, hostile, in range (interference shortens it) and in line of sight. */
const lockable = (run: SectorRun, a: Agent): boolean => inSector(run, a) && validTarget(run, a, SHIP_LOCK.range, Math.PI);

/** The ship X would lock now, or null (see the module doc for the order). */
export function pickShipLockTarget(run: SectorRun): Agent | null {
  // a lock-on missile already acquiring a ship: that ship, if it may be locked
  const sk = run.missile;
  if (sk.state === 'acquiring' && sk.target !== null) {
    const t = run.hostiles.find((a) => a.id === sk.target);
    if (t && lockable(run, t)) return t;
  }
  const s = run.ship;
  const nose = noseAngle(s.heading);
  let best: Agent | null = null;
  let bestScore = Infinity;
  for (const a of run.hostiles) {
    if (!lockable(run, a)) continue;
    const off = angleDiff(Math.atan2(a.y - s.y, a.x - s.x), nose) / Math.PI;
    const score = off + SHIP_LOCK.distanceWeight * (Math.hypot(a.x - s.x, a.y - s.y) / SHIP_LOCK.range);
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && best !== null && a.id < best.id)) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

function notify(run: SectorRun, n: ShipLockNotice): void {
  run.shipLock.notice = n;
  run.shipLock.noticeTicks = SHIP_LOCK.noticeTicks;
}

/** End the lock (if any) with a reason; the HUD shows it and the event tells the shell. */
export function endShipLock(run: SectorRun, why: ShipLockEnd, events: SectorEvent[] | null): void {
  const id = run.shipLock.target;
  if (id === null) return;
  run.shipLock.target = null;
  notify(run, why);
  events?.push({ type: 'shipLockEnded', hostile: id, why });
}

/** Drop the lock silently (recall, restart, docking, unload): nothing to report on a screen change. */
export function clearShipLock(run: SectorRun): void {
  run.shipLock.target = null;
  run.shipLock.notice = null;
  run.shipLock.noticeTicks = 0;
}

/** X / LOCK: lock the best target, or release the current one. Never fires, never spends anything. */
export function toggleShipLock(run: SectorRun, events: SectorEvent[]): void {
  if (run.shipLock.target !== null) {
    endShipLock(run, 'cancelled', events);
    return;
  }
  // the Gravity Flight test flies rotate-and-thrust (the nose steers the thrust there): no lock in it
  if (run.flight || run.docked) {
    notify(run, 'unavailable');
    events.push({ type: 'shipLockRefused', why: 'unavailable' });
    return;
  }
  const t = pickShipLockTarget(run);
  if (!t) {
    notify(run, 'noTarget');
    events.push({ type: 'shipLockRefused', why: 'noTarget' });
    return;
  }
  run.shipLock.target = t.id;
  run.shipLock.acquired += 1;
  notify(run, 'acquired');
  events.push({ type: 'shipLocked', hostile: t.id, family: t.family, x: t.x, y: t.y });
}

/** The ship C would move the lock to, or null (no lock, or no other eligible ship). See the module doc for the order. */
export function nextShipLockTarget(run: SectorRun): Agent | null {
  const id = run.shipLock.target;
  if (id === null) return null;
  const cur = run.hostiles.find((a) => a.id === id);
  if (!cur) return null;
  const s = run.ship;
  const ref = Math.atan2(cur.y - s.y, cur.x - s.x);
  const dCur = Math.hypot(cur.x - s.x, cur.y - s.y);
  let best: Agent | null = null;
  let bt = Infinity;
  let bd = Infinity;
  for (const a of run.hostiles) {
    if (a.id === id || !lockable(run, a)) continue;
    const d = Math.hypot(a.x - s.x, a.y - s.y);
    // clockwise turn from the current target's bearing (canvas y points down, so a growing atan2 is clockwise)
    let turn = (((Math.atan2(a.y - s.y, a.x - s.x) - ref) % TAU) + TAU) % TAU;
    if (turn > TAU - 1e-9) turn = 0;
    // the same bearing: a farther ship comes next, a nearer one only after the wrap
    if (turn < 1e-9 && (d < dCur - 1e-9 || (Math.abs(d - dCur) <= 1e-9 && a.id < id))) turn = TAU;
    if (turn < bt - 1e-9 || (Math.abs(turn - bt) <= 1e-9 && (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && best !== null && a.id < best.id)))) {
      best = a;
      bt = turn;
      bd = d;
    }
  }
  return best;
}

/** C / NEXT TARGET: move the lock to the next eligible ship. Only on the pilot's press; never fires, never spends. */
export function cycleShipLock(run: SectorRun, events: SectorEvent[]): void {
  if (run.shipLock.target === null) {
    notify(run, 'noLock');
    events.push({ type: 'shipLockRefused', why: 'noLock' });
    return;
  }
  const t = nextShipLockTarget(run);
  if (!t) {
    notify(run, 'onlyTarget');
    events.push({ type: 'shipLockRefused', why: 'onlyTarget' });
    return;
  }
  const from = run.shipLock.target;
  run.shipLock.target = t.id;
  run.shipLock.switched += 1;
  notify(run, 'switched');
  events.push({ type: 'shipLocked', hostile: t.id, family: t.family, x: t.x, y: t.y, from });
}

/** Why the locked ship can no longer be held, or null while it can. */
export function lockBreak(run: SectorRun, a: Agent | undefined): ShipLockEnd | null {
  if (!a) return 'gone';
  if (a.state === 'destroyed' || a.hull <= 0) return 'destroyed';
  if (!hostileTo(run, a.faction, 'player') || !inSector(run, a)) return 'invalid';
  if (Math.hypot(a.x - run.ship.x, a.y - run.ship.y) > SHIP_LOCK.keepRange) return 'range';
  return null;
}

/**
 * One tick, before the ship moves: re-check the lock and return the aim
 * vector toward the locked ship (world px, from the ship), or null when there
 * is no lock. The caller passes it to the ship step as the aim; nothing else
 * is touched.
 */
export function stepShipLock(run: SectorRun, events: SectorEvent[]): { x: number; y: number } | null {
  const L = run.shipLock;
  if (L.noticeTicks > 0 && --L.noticeTicks === 0) L.notice = null;
  if (L.target === null) return null;
  const a = run.hostiles.find((h) => h.id === L.target);
  const why = lockBreak(run, a);
  if (why) {
    endShipLock(run, why, events);
    return null;
  }
  const dx = a!.x - run.ship.x;
  const dy = a!.y - run.ship.y;
  // on top of the ship there is no direction to face: keep the current heading this tick
  return Math.hypot(dx, dy) > 1 ? { x: dx, y: dy } : null;
}

/** The locked ship, for the HUD and the renderer. */
export function lockedAgent(run: SectorRun): Agent | null {
  const id = run.shipLock.target;
  if (id === null) return null;
  return run.hostiles.find((a) => a.id === id && a.state !== 'destroyed') ?? null;
}

/** The corner-log line for a lock event (one short line, never a card; `warn` only when it failed or broke). */
export function shipLockLine(e: SectorEvent): { text: string; tone: 'info' | 'warn' } | null {
  if (e.type === 'shipLocked') return { text: `${e.from !== undefined ? 'NEXT TARGET' : 'TARGET LOCKED'} · ${FAMILIES[e.family].label.toUpperCase()}`, tone: 'info' };
  if (e.type === 'shipLockRefused') {
    const text = e.why === 'noTarget' ? 'NO TARGET IN RANGE' : e.why === 'noLock' ? 'NO TARGET LOCKED' : e.why === 'onlyTarget' ? 'ONLY TARGET IN RANGE' : 'TARGET LOCK UNAVAILABLE HERE';
    return { text, tone: e.why === 'onlyTarget' ? 'info' : 'warn' };
  }
  if (e.type !== 'shipLockEnded') return null;
  if (e.why === 'cancelled') return { text: 'TARGET LOCK RELEASED', tone: 'info' };
  if (e.why === 'destroyed') return { text: 'LOCKED TARGET DESTROYED', tone: 'info' };
  if (e.why === 'range') return { text: 'TARGET LOCK LOST · OUT OF RANGE', tone: 'warn' };
  return { text: 'TARGET LOCK LOST', tone: 'warn' };
}
