/**
 * P11.1 Fleet Command runtime (lazy fleet chunk; FLEET_COMMAND.md): the fleet vessels of one
 * sector run as real ships. Called synchronously by the run once attached (run.wing), so pause,
 * docking and every non-flight phase freeze it with the sector, and a disposed run drops it.
 *
 *  - Movement: the pilot's own flight model (sim.ts stepShip, the archetype's tuning) driven by
 *    a computed FlightInput, then the same solid / bounds pass as every ship (pushOutOfSolids).
 *    Never the pilot's input, never a teleport while flying (a recall, restart or dock re-forms
 *    the wing at the pilot, like the pilot's own recall).
 *  - Sight: an escort knows only what it sees: an enemy within its sensor range with no celestial
 *    body in between, plus a short contact memory (STEALTH.memoryTicks), then it lets go.
 *  - Fire: its archetype's stock weapon (range = bolt speed x life, cooldown, the pilot's heat bar),
 *    bolts in a bounded pool of its own; a hit goes through damageAgent(..., 'player', from) once,
 *    so faction heat, bounties and kill counts use the one existing attribution. Bolts strike only
 *    ships hostile to the pilot (a neutral is never provoked by the fleet).
 *  - Stealth: during Silent Running escorts hold fire (an Attack order still fires) and match the
 *    pilot's signature while quiet; escort fire never ends the pilot's Silent Running, and a ship
 *    struck by an escort turns on the escort, never on the pilot.
 *  - Disabled at 0 hull: out of the fight (drifts, no fire, not targeted), still owned and crewed.
 *
 * No allocation per tick beyond new bolts (scratch input, one shared candidate list per tick).
 */
import type { FactionId } from '../catalogue/types.ts';
import { FAMILIES } from '../combat/families.ts';
import { bodyBetween, STEALTH } from '../combat/stealth.ts';
import type { Agent, EnemyShot, Target } from '../combat/state.ts';
import { damageAgent, hostileTo, pushOutOfSolids, shotBlocked, sweptHit } from '../combat/world.ts';
import { landCritical, rollCritical, useCritical, type CritToken } from '../combat/critical.ts';
import { dist, segmentDistance } from '../sector/grid.ts';
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import { stepShip, TICK_SECONDS } from '../sim.ts';
import type { FleetKit, FleetOrder, FleetUnit, RegroupMode, VesselSpec, Wing } from './vessels.ts';

export const WING = Object.freeze({
  /** Formation slot spacing past both hulls, art px. */
  spacing: 46,
  /** Within this of its slot an escort just matches the pilot's velocity. */
  slotTolerance: 14,
  /** Hold Position dead band (no thrust inside it, so it never oscillates). */
  holdTolerance: 24,
  /** Defend / Attack never take an escort farther than this from the pilot (Attack: x1.5). */
  leash: 900,
  /** Defend Me: threats within this of the pilot (or already shooting at the pilot or the wing). */
  defendRadius: 650,
  /** Target re-check interval, ticks (staggered by slot). */
  acquireEvery: 10,
  /** Shield regeneration starts this long after a hit (the pilot's delay, run.ts RUN.regenDelayTicks). */
  regenDelay: 180,
  boltRadius: 3,
  /** Bolt pool for the whole wing (never the pilot's 24). */
  maxBolts: 18,
  /** Fires only with the nose within this of the aim, rad. */
  fireArc: 0.22,
  /** Formation facing follows the pilot's travel direction at most this fast, rad / s. */
  facingRate: 2.4,
  /** Below this pilot speed the formation keeps its facing. */
  facingSpeed: 60,
  /** Quiet ticks after the last shot before an escort matches Silent Running's signature. */
  quietTicks: 90,
});

/* ------------------------------------------------------------- attaching */

/** Attach the wing (between ticks): one unit per deployable vessel at its formation slot. A disposed run gets nothing. */
export function deploy(run: SectorRun, kit: FleetKit, specs: readonly VesselSpec[], heatModel: Wing['heatModel']): void {
  if (run.disposed || run.wing) return;
  run.wing = { kit, units: [], bolts: [], facing: run.ship.heading, heatModel };
  syncWing(run, specs);
}

/**
 * Make the units match `specs` (the deployable vessels, in vessel order): a unit whose vessel left
 * service or lost its captain is removed; a new one forms up at a free slot. Kept units keep their
 * pose and damage. Called at sector entry, after a fleet change and at a dock (never mid-fight:
 * every fleet change requires a dock).
 */
export function syncWing(run: SectorRun, specs: readonly VesselSpec[]): void {
  const w = run.wing;
  if (!w || run.disposed) return;
  for (let i = w.units.length - 1; i >= 0; i--) if (!specs.some((s) => s.vessel === w.units[i]!.spec.vessel && s.captain === w.units[i]!.spec.captain)) w.units.splice(i, 1);
  for (const s of specs.slice(0, 3)) {
    if (w.units.some((u) => u.spec.vessel === s.vessel)) continue;
    let slot = 0;
    while (w.units.some((u) => u.slot === slot)) slot += 1;
    if (slot > 2) break;
    const p = slotPoint(run, w, slot, s.radius);
    const unit: FleetUnit = {
      id: -(slot + 1),
      spec: s,
      slot,
      ship: { x: p.x, y: p.y, vx: 0, vy: 0, heading: run.ship.heading, px: p.x, py: p.y, pheading: run.ship.heading, thrusting: false, thrustX: 0, thrustY: 0 },
      hull: s.stats.hull,
      shield: s.stats.shield,
      sinceHit: WING.regenDelay,
      cooldown: 0,
      heat: 0,
      overheated: false,
      state: 'active',
      order: FOLLOW,
      target: null,
      seenX: 0,
      seenY: 0,
      lost: 0,
      sig: STEALTH.normal,
      quiet: WING.quietTicks,
    };
    pushOutOfSolids(run.layout, unit.ship, s.radius);
    unit.ship.px = unit.ship.x;
    unit.ship.py = unit.ship.y;
    w.units.push(unit);
  }
  w.units.sort((a, b) => a.slot - b.slot);
}

const FOLLOW: FleetOrder = Object.freeze({ kind: 'follow' });

/** Re-form the wing on the pilot (FLEET_COMMAND.md "Lifecycle"): orders back to Follow, bolts and targets cleared. */
export function regroup(run: SectorRun, mode: RegroupMode): void {
  const w = run.wing;
  if (!w) return;
  w.bolts.length = 0;
  w.facing = run.ship.heading;
  for (const u of w.units) {
    if (mode === 'dock') u.state = 'active';
    if (mode === 'dock' || (mode === 'restart' && u.state === 'active')) {
      u.hull = u.spec.stats.hull;
      u.shield = u.spec.stats.shield;
      u.heat = 0;
      u.overheated = false;
      u.cooldown = 0;
    }
    const p = slotPoint(run, w, u.slot, u.spec.radius);
    Object.assign(u.ship, { x: p.x, y: p.y, px: p.x, py: p.y, vx: 0, vy: 0, heading: run.ship.heading, pheading: run.ship.heading, thrusting: false });
    pushOutOfSolids(run.layout, u.ship, u.spec.radius);
    u.order = FOLLOW;
    u.target = null;
    u.lost = 0;
    u.sinceHit = WING.regenDelay;
  }
}

/* ---------------------------------------------------------------- orders */

export type OrderRequest = { readonly kind: 'follow' } | { readonly kind: 'hold'; readonly x?: number; readonly y?: number } | { readonly kind: 'defend' } | { readonly kind: 'attack'; readonly target: unknown };
export type OrderRefusal = 'no-wing' | 'unknown-vessel' | 'disabled' | 'player' | 'friendly' | 'station' | 'invalid-target' | 'destroyed' | 'not-hostile' | 'invalid-order';

/** Why `target` cannot be attacked, or null (an enemy ship alive and hostile to the pilot now). */
export function attackRefusal(run: SectorRun, target: unknown): OrderRefusal | null {
  if (target === 'player') return 'player';
  if (typeof target === 'string') return run.layout.pois.some((p) => p.id === target && p.kind === 'station') ? 'station' : 'invalid-target';
  if (typeof target !== 'number' || !Number.isSafeInteger(target)) return 'invalid-target';
  if (target < 0) return 'friendly';
  const a = run.hostiles.find((h) => h.id === target);
  if (!a) return 'invalid-target';
  if (a.state === 'destroyed') return 'destroyed';
  return hostileTo(run, a.faction, 'player') ? null : 'not-hostile';
}

/** Plain words for an order refusal (the Fleet panel shows these; the codes stay the contract). */
export function orderRefusalText(r: OrderRefusal): string {
  switch (r) {
    case 'no-wing':
      return 'No fleet vessel is flying with you.';
    case 'unknown-vessel':
      return 'That vessel is not flying with you.';
    case 'disabled':
      return 'A disabled vessel cannot take orders. Docking at a station returns it to service.';
    case 'player':
      return 'Escorts never attack you.';
    case 'friendly':
      return 'Escorts never attack your own fleet.';
    case 'station':
      return 'Stations cannot be attacked.';
    case 'invalid-target':
      return 'Lock a hostile ship first (LOCK), then order the attack.';
    case 'destroyed':
      return 'That target is already destroyed.';
    case 'not-hostile':
      return 'That ship is not hostile to you. Escorts attack only hostiles.';
    case 'invalid-order':
      return 'Unknown order.';
  }
}

/**
 * Give one vessel (`who` = its vessel id) or every active vessel ('all') an order. Disabled
 * vessels are skipped by 'all' and refused by id. Hold keeps the given point (bounds and solids
 * applied; each vessel offset by its slot) or, without one, where each vessel is now.
 */
export function issueOrder(run: SectorRun, who: string, req: OrderRequest): { readonly ok: true; readonly vessels: readonly string[] } | { readonly ok: false; readonly reason: OrderRefusal } {
  const w = run.wing;
  if (!w || !w.units.length) return { ok: false, reason: 'no-wing' };
  const picked = who === 'all' ? w.units.filter((u) => u.state === 'active') : w.units.filter((u) => u.spec.vessel === who);
  if (who !== 'all' && !picked.length) return { ok: false, reason: 'unknown-vessel' };
  if (!picked.length || picked.some((u) => u.state !== 'active')) return { ok: false, reason: 'disabled' };
  if (req.kind === 'attack') {
    const r = attackRefusal(run, req.target);
    if (r) return { ok: false, reason: r };
  } else if (req.kind !== 'follow' && req.kind !== 'defend' && req.kind !== 'hold') return { ok: false, reason: 'invalid-order' };
  const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  for (const u of picked) {
    if (req.kind === 'hold') {
      const given = fin(req.x) && fin(req.y);
      const off = given ? slotOffset(w.facing, u.slot, u.spec.radius + run.tune.radius) : null;
      const p = { x: given ? req.x! + off!.x : u.ship.x, y: given ? req.y! + off!.y : u.ship.y, vx: 0, vy: 0 };
      pushOutOfSolids(run.layout, p, u.spec.radius);
      u.order = { kind: 'hold', x: p.x, y: p.y };
    } else u.order = req.kind === 'attack' ? { kind: 'attack', target: req.target as number } : req.kind === 'defend' ? { kind: 'defend' } : FOLLOW;
    u.target = req.kind === 'attack' ? (req.target as number) : null;
    u.lost = 0;
    if (req.kind === 'attack') {
      const a = run.hostiles.find((h) => h.id === req.target)!;
      u.seenX = a.x;
      u.seenY = a.y;
    }
  }
  return { ok: true, vessels: picked.map((u) => u.spec.vessel) };
}

/* ------------------------------------------------------------ formation */

/** Slot offset from the pilot in the formation frame (facing = heading 0 up): right-rear, left-rear, astern. */
function slotOffset(facing: number, slot: number, radii: number): { x: number; y: number } {
  const s = WING.spacing + radii;
  const fx = Math.sin(facing);
  const fy = -Math.cos(facing);
  const side = slot === 0 ? 1 : slot === 1 ? -1 : 0;
  const back = slot === 2 ? 1.7 : 0.85;
  return { x: -fy * side * s - fx * back * s, y: fx * side * s - fy * back * s };
}

function slotPoint(run: SectorRun, w: Wing, slot: number, radius: number): { x: number; y: number } {
  const o = slotOffset(w.facing, slot, radius + run.tune.radius);
  const L = run.layout;
  const m = radius + 8;
  return { x: Math.min(L.width - m, Math.max(m, run.ship.x + o.x)), y: Math.min(L.height - m, Math.max(m, run.ship.y + o.y)) };
}

/* ------------------------------------------------------------------ step */

/** Scratch (no allocation per tick). */
const IN = { moveX: 0, moveY: 0, aimX: 0, aimY: 0 };
const CAND: Agent[] = [];

const range = (u: FleetUnit): number => (u.spec.weapon.shotSpeed * u.spec.weapon.lifeTicks) / 60;
/** Does `u` see `a` right now? Its own sensor range, no celestial body in between. */
const sees = (run: SectorRun, u: FleetUnit, a: Agent): boolean => dist(u.ship, a) <= u.spec.stats.sensor && !bodyBetween(run.layout.landmarks, u.ship.x, u.ship.y, a.x, a.y);
const liveHostile = (run: SectorRun, id: number | null): Agent | null => {
  if (id === null) return null;
  const a = run.hostiles.find((h) => h.id === id);
  return a && a.state !== 'destroyed' && hostileTo(run, a.faction, 'player') ? a : null;
};
const engaged = (t: Target | null): boolean => t === 'player' || (typeof t === 'number' && t < 0);

/** One fixed tick of the wing (stepSector, right after the enemy ships). */
export function stepWing(run: SectorRun, events: SectorEvent[]): void {
  const w = run.wing;
  if (!w || run.disposed) return;
  const P = run.ship;
  // formation facing eases toward the pilot's direction of travel (slots never swing with the aim)
  const ps = Math.hypot(P.vx, P.vy);
  if (ps > WING.facingSpeed) {
    const want = Math.atan2(P.vx, -P.vy);
    const d = Math.atan2(Math.sin(want - w.facing), Math.cos(want - w.facing));
    const k = WING.facingRate * TICK_SECONDS;
    w.facing += Math.max(-k, Math.min(k, d));
  }
  // one shared candidate list per tick: live ships hostile to the pilot (each escort then checks its own sight)
  CAND.length = 0;
  for (const a of run.hostiles) if (a.state !== 'destroyed' && hostileTo(run, a.faction, 'player')) CAND.push(a);
  for (const u of w.units) stepUnit(run, w, u, events);
  separate(run, w);
  stepBolts(run, w, events);
  CAND.length = 0;
}

function stepUnit(run: SectorRun, w: Wing, u: FleetUnit, events: SectorEvent[]): void {
  const sh = u.ship;
  const st = u.spec.stats;
  const L = run.layout;
  u.quiet += 1;
  u.sinceHit += 1;
  if (u.cooldown > 0) u.cooldown -= 1;
  if (u.state === 'disabled') {
    // out of the fight: coasts to a stop (brake drag), no fire, no regeneration
    IN.moveX = IN.moveY = IN.aimX = IN.aimY = 0;
    stepShip(sh, IN, L.width, L.height, {}, u.spec.tune);
    pushOutOfSolids(L, sh, u.spec.radius);
    u.sig = STEALTH.normal;
    return;
  }
  if (u.sinceHit > WING.regenDelay && u.shield < st.shield) u.shield = Math.min(st.shield, u.shield + st.shieldRegen * TICK_SECONDS);
  const ord = u.order;

  /* target: keep a live one (an Attack order's target must stay valid, or the order falls back) */
  let t = liveHostile(run, u.target);
  if (ord.kind === 'attack' && (!t || t.id !== ord.target)) {
    fallback(u, events);
    t = null;
  }
  if (!t) u.target = null;
  const tight = run.silent && ord.kind !== 'attack' && u.sinceHit > 60; // weapons tight in Silent Running unless under fire
  if (ord.kind !== 'attack' && (u.target === null || (run.tick + u.slot * 3) % WING.acquireEvery === 0)) {
    t = tight ? null : acquire(run, u, ord.kind);
    u.target = t ? t.id : null;
    if (t) u.lost = 0;
  }
  let visible = false;
  if (t) {
    visible = sees(run, u, t);
    if (visible) {
      u.seenX = t.x;
      u.seenY = t.y;
      u.lost = 0;
    } else if (++u.lost > STEALTH.memoryTicks) {
      // contact lost: an Attack order falls back to Follow; other orders just let go
      if (ord.kind === 'attack') fallback(u, events);
      u.target = null;
      t = null;
    }
  }

  /* where to be */
  let gx: number;
  let gy: number;
  let tol: number = WING.slotTolerance;
  let match = true; // match the pilot's velocity at the goal (formation), else come to rest there
  if (ord.kind === 'hold') {
    gx = ord.x;
    gy = ord.y;
    tol = WING.holdTolerance;
    match = false;
  } else if (t && (ord.kind === 'attack' || ord.kind === 'defend')) {
    const tx = visible ? t.x : u.seenX;
    const ty = visible ? t.y : u.seenY;
    const d = Math.hypot(sh.x - tx, sh.y - ty) || 1;
    const stand = range(u) * 0.6;
    gx = tx + ((sh.x - tx) / d) * stand;
    gy = ty + ((sh.y - ty) / d) * stand;
    const lim = WING.leash * (ord.kind === 'attack' ? 1.5 : 1);
    const dp = Math.hypot(gx - run.ship.x, gy - run.ship.y);
    if (dp > lim) {
      gx = run.ship.x + ((gx - run.ship.x) / dp) * lim;
      gy = run.ship.y + ((gy - run.ship.y) / dp) * lim;
    }
    tol = WING.holdTolerance;
    match = false;
  } else {
    const p = slotPoint(run, w, u.slot, u.spec.radius);
    gx = p.x;
    gy = p.y;
  }
  gx = Math.min(L.width - u.spec.radius, Math.max(u.spec.radius, gx));
  gy = Math.min(L.height - u.spec.radius, Math.max(u.spec.radius, gy));
  steerTo(run, u, gx, gy, tol, match);

  /* aim and fire */
  IN.aimX = IN.aimY = 0;
  if (t && visible) {
    const sp = u.spec.weapon.shotSpeed;
    const d = dist(sh, t);
    const lead = d / sp;
    IN.aimX = t.x + t.vx * lead - sh.x;
    IN.aimY = t.y + t.vy * lead - sh.y;
  }
  stepShip(sh, IN, L.width, L.height, {}, u.spec.tune);
  pushOutOfSolids(L, sh, u.spec.radius, 0.2);
  coolOrFire(run, w, u, t && visible && !tight ? t : null, events);
  u.sig = run.silent && u.quiet > WING.quietTicks ? STEALTH.silent : STEALTH.normal;
}

/** The order's pick among the enemy ships this escort sees (the shared candidate list; nearest first). */
function acquire(run: SectorRun, u: FleetUnit, kind: FleetOrder['kind']): Agent | null {
  let best: Agent | null = null;
  let bestD = Infinity;
  const r = range(u);
  for (const a of CAND) {
    const d = dist(u.ship, a);
    if (d >= bestD) continue;
    if (kind === 'defend') {
      // a known threat to the pilot: already engaging the pilot or the wing, or close to the pilot, within the leash
      const dp = dist(run.ship, a);
      if (dp > WING.leash || (!engaged(a.target) && dp > WING.defendRadius)) continue;
    } else if (d > r || !engaged(a.target)) continue; // Follow / Hold: return fire at ships engaging, within weapon range
    if (!sees(run, u, a)) continue;
    best = a;
    bestD = d;
  }
  return best;
}

function fallback(u: FleetUnit, events: SectorEvent[]): void {
  u.order = FOLLOW;
  u.target = null;
  u.lost = 0;
  events.push({ type: 'fleet', change: 'fallback', vessel: u.spec.vessel });
}

/**
 * Turn a goal into flight input: a braking-curve approach (never overshoots into oscillation), the
 * pilot's velocity added in formation, the archetype's drag fed forward, then the unit disc.
 */
function steerTo(run: SectorRun, u: FleetUnit, gx: number, gy: number, tol: number, match: boolean): void {
  const sh = u.ship;
  const T = u.spec.tune;
  const dx = gx - sh.x;
  const dy = gy - sh.y;
  const d = Math.hypot(dx, dy);
  const bvx = match ? run.ship.vx : 0;
  const bvy = match ? run.ship.vy : 0;
  let vx = bvx;
  let vy = bvy;
  if (d > tol) {
    const sp = Math.min(T.maxSpeed, Math.sqrt(2 * T.accel * 0.45 * (d - tol)), (d - tol) * 4 + 30);
    vx += (dx / d) * sp;
    vy += (dy / d) * sp;
  }
  const vl = Math.hypot(vx, vy);
  if (vl > T.maxSpeed) {
    vx *= T.maxSpeed / vl;
    vy *= T.maxSpeed / vl;
  }
  if (!match && d <= tol) {
    // inside the dead band: no thrust (brake drag settles it; no hunting around the point)
    IN.moveX = IN.moveY = 0;
    return;
  }
  const a = T.accel * TICK_SECONDS;
  const ff = 1 - Math.exp(-T.drag * TICK_SECONDS);
  let ix = (vx - sh.vx) / (a * 3) + (vx * ff) / a;
  let iy = (vy - sh.vy) / (a * 3) + (vy * ff) / a;
  const il = Math.hypot(ix, iy);
  if (il > 1) {
    ix /= il;
    iy /= il;
  }
  IN.moveX = il < 0.02 ? 0 : ix;
  IN.moveY = il < 0.02 ? 0 : iy;
}

function coolOrFire(run: SectorRun, w: Wing, u: FleetUnit, t: Agent | null, events: SectorEvent[]): void {
  const H = w.heatModel;
  const wp = u.spec.weapon;
  const sh = u.ship;
  const ok = t && !u.overheated && u.cooldown <= 0 && !run.docked && w.bolts.length + wp.bolts <= WING.maxBolts && dist(sh, t) <= range(u);
  if (ok) {
    const nx = Math.sin(sh.heading);
    const ny = -Math.cos(sh.heading);
    const ax = IN.aimX;
    const ay = IN.aimY;
    const al = Math.hypot(ax, ay) || 1;
    if ((nx * ax + ny * ay) / al >= Math.cos(WING.fireArc)) {
      const speed = wp.shotSpeed + Math.max(0, sh.vx * nx + sh.vy * ny);
      const crit = rollCritical(run); // one decision per escort firing (the same policy as the pilot's gun)
      for (let b = 0; b < wp.bolts; b++) {
        const off = wp.bolts === 1 ? 0 : (b === 0 ? -0.5 : 0.5) * wp.spread;
        const x = sh.x + nx * (u.spec.radius + 4) - ny * off;
        const y = sh.y + ny * (u.spec.radius + 4) + nx * off;
        w.bolts.push({ x, y, px: x, py: y, vx: nx * speed, vy: ny * speed, life: wp.lifeTicks, damage: wp.damage, from: u.id, crit });
      }
      u.cooldown = wp.cooldownTicks;
      u.quiet = 0;
      u.heat = Math.min(1, u.heat + wp.cooldownTicks / H.fullTicks);
      if (u.heat >= 1) u.overheated = true;
      return;
    }
  }
  u.heat = Math.max(0, u.heat - 1 / H.coolTicks);
  if (u.overheated && u.heat <= H.resumeAt) u.overheated = false;
  void events;
}

/** Keep escorts off the pilot and off each other (position only; no contact damage between friends). */
function separate(run: SectorRun, w: Wing): void {
  const P = run.ship;
  const units = w.units;
  for (let i = 0; i < units.length; i++) {
    const a = units[i]!.ship;
    const ra = units[i]!.spec.radius;
    push(a, P, ra + run.tune.radius + 6, 1);
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j]!.ship;
      const min = ra + units[j]!.spec.radius + 6;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d >= min) continue;
      const nx = d > 0 ? dx / d : 1;
      const ny = d > 0 ? dy / d : 0;
      const h = (min - d) / 2;
      a.x += nx * h;
      a.y += ny * h;
      b.x -= nx * h;
      b.y -= ny * h;
    }
  }
}

function push(a: { x: number; y: number; vx: number; vy: number }, o: { x: number; y: number }, min: number, k: number): void {
  const dx = a.x - o.x;
  const dy = a.y - o.y;
  const d = Math.hypot(dx, dy);
  if (d >= min) return;
  const nx = d > 0 ? dx / d : 1;
  const ny = d > 0 ? dy / d : 0;
  a.x += nx * (min - d) * k;
  a.y += ny * (min - d) * k;
  const vn = a.vx * nx + a.vy * ny;
  if (vn < 0) {
    a.vx -= vn * nx;
    a.vy -= vn * ny;
  }
}

function stepBolts(run: SectorRun, w: Wing, events: SectorEvent[]): void {
  const L = run.layout;
  const R = WING.boltRadius;
  for (let i = w.bolts.length - 1; i >= 0; i--) {
    const b = w.bolts[i]!;
    b.px = b.x;
    b.py = b.y;
    b.x += b.vx * TICK_SECONDS;
    b.y += b.vy * TICK_SECONDS;
    b.life -= 1;
    let dead = b.life <= 0 || b.x < 0 || b.y < 0 || b.x > L.width || b.y > L.height || shotBlocked(L, b.px, b.py, b.x, b.y, R);
    if (!dead) {
      for (const a of run.hostiles) {
        // only ships hostile to the pilot: a fleet bolt never provokes a neutral (it passes them)
        if (a.state === 'destroyed' || !hostileTo(run, a.faction, 'player') || !sweptHit(b.px, b.py, b.x, b.y, a.x, a.y, FAMILIES[a.family].radius + R)) continue;
        const from = w.units.find((u) => u.id === b.from)?.ship ?? b;
        damageAgent(run, a, b.damage, 'player', events, from, useCritical(b.crit, a)); // the one attribution point (heat, kills, bounty)
        dead = true;
        break;
      }
    }
    if (dead) w.bolts.splice(i, 1);
  }
}

/* ------------------------------------------------- enemy fire on the wing */

function hurt(run: SectorRun, u: FleetUnit, amount: number, events: SectorEvent[], crit = false): void {
  let n = Math.max(0, Number.isFinite(amount) ? amount : 0);
  if (n <= 0 || u.state !== 'active' || run.disposed) return;
  if (crit) n = Math.max(n, u.shield + u.hull); // Finale P1: a critical disables the escort (never destroys or frees it)
  const absorbed = Math.min(u.shield, n);
  u.shield -= absorbed;
  u.hull = Math.max(0, u.hull - (n - absorbed));
  u.sinceHit = 0;
  if (u.hull <= 0) {
    // disabled: out of the fight, still owned and crewed; back in service at the next dock
    u.state = 'disabled';
    u.target = null;
    u.order = FOLLOW;
    if (crit) landCritical(run, 'escort', 'npc', u.spec.vessel, u.ship.x, u.ship.y, events); // logged before the disabled line
    events.push({ type: 'fleet', change: 'disabled', vessel: u.spec.vessel });
  }
}

/** An enemy shot (hostile to the pilot) that touches a live escort hits it once. True = the shot is spent. */
export function shotHit(run: SectorRun, s: EnemyShot, events: SectorEvent[]): boolean {
  const w = run.wing;
  if (!w || !hostileTo(run, s.faction, 'player')) return false;
  for (const u of w.units) {
    if (u.state !== 'active' || !sweptHit(s.px, s.py, s.x, s.y, u.ship.x, u.ship.y, u.spec.radius + s.radius)) continue;
    hurt(run, u, s.damage, events, useCritical(s.crit));
    return true;
  }
  return false;
}

/** A sweep beam hits each live escort once per firing (the beam's own `hit` set). */
export function beamHit(run: SectorRun, a: Agent, ex: number, ey: number, width: number, damage: number, hit: Set<Target>, events: SectorEvent[], crit?: CritToken | null): void {
  const w = run.wing;
  if (!w || !hostileTo(run, a.faction, 'player')) return;
  for (const u of w.units) {
    if (u.state !== 'active' || hit.has(u.id) || segmentDistance(u.ship, a, { x: ex, y: ey }) > width + u.spec.radius) continue;
    hit.add(u.id);
    hurt(run, u, damage, events, useCritical(crit));
  }
}

/** Is a live escort within `r` of a mine of `faction` (hostile to the pilot)? */
export function nearUnit(run: SectorRun, faction: FactionId, x: number, y: number, r: number): boolean {
  const w = run.wing;
  return !!w && hostileTo(run, faction, 'player') && w.units.some((u) => u.state === 'active' && Math.hypot(u.ship.x - x, u.ship.y - y) < r + u.spec.radius);
}

/** A blast of `faction` hits each live escort inside it once. */
export function blastHit(run: SectorRun, faction: FactionId, x: number, y: number, r: number, damage: number, events: SectorEvent[]): void {
  const w = run.wing;
  if (!w || !hostileTo(run, faction, 'player')) return;
  for (const u of w.units) if (u.state === 'active' && Math.hypot(u.ship.x - x, u.ship.y - y) < r + u.spec.radius) hurt(run, u, damage, events);
}

/* ---------------------------------------------------------------- status */

/** Read-only view of the wing (the shell's status and the P11.2 HUD). */
export function wingStatus(run: SectorRun): { readonly units: readonly Readonly<Record<string, unknown>>[]; readonly bolts: number } | null {
  const w = run.wing;
  if (!w) return null;
  return {
    units: w.units.map((u) => ({ id: u.id, vessel: u.spec.vessel, ship: u.spec.ship, captain: u.spec.captain, slot: u.slot, x: u.ship.x, y: u.ship.y, vx: u.ship.vx, vy: u.ship.vy, heading: u.ship.heading, hull: u.hull, shield: u.shield, maxHull: u.spec.stats.hull, state: u.state, order: { ...u.order }, target: u.target, sig: u.sig, heat: u.heat, range: range(u), lost: u.lost })),
    bolts: w.bolts.length,
  };
}
