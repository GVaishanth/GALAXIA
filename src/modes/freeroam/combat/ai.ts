/**
 * Enemy AI (Free Roam Prompt 9): an explicit state machine per ship plus a
 * tactic per family. Deterministic for a given run seed (all variation comes
 * from SectorRun.rng: per-ship traits, aim jitter, evade rolls).
 *
 * Transitions (any live state -> destroyed when the hull empties):
 *   idle / patrol   -> pursue       a hostile target comes into sight
 *                   -> investigate  shot by an unseen pilot, or called by a recon ship
 *   investigate     -> pursue       target sighted
 *                   -> idle/patrol  searched the spot for COMBAT.searchTicks
 *   pursue          -> attack       inside the family's engagement range
 *                   -> investigate  target lost (last-known position kept)
 *                   -> idle/patrol  leashed: too far from its post (patrols, guards)
 *   attack          -> pursue       target out of range
 *                   -> evade        hit (seeded chance), a dodge (elites), a charge pass (lancers)
 *                   -> retreat      hull at the family's retreat threshold (once per ship),
 *                                   or a recon ship approached too closely
 *   evade           -> attack / pursue / investigate   after the evade time
 *   retreat         -> pursue / idle  after at most 360 ticks (or a recon back at range);
 *                                   a retreating ship beyond COMBAT.sleepRadius escapes (removed)
 *   any             -> disabled     hull at the family's disable threshold (once per ship)
 *   disabled        -> retreat / pursue  after the family's disable time
 * Every timed state has an exit, damage applies in every live state, and the
 * one-time transitions are flagged, so no ship can be stuck or invulnerable.
 *
 * Sight is distance-only (detect range) between ships. Seeing the pilot
 * (P07.1, combat/stealth.ts) also needs a clear line past every celestial body
 * (Gravity Shadow) and a distance within detect range x the pilot's signature
 * (Silent Running). In the gravity lab its flight hook owns sight instead
 * (its planet, FR-TD-84: plain geometric sight, no contact memory).
 * A pilot lost from sight stays the target for STEALTH.memoryTicks (contact
 * memory: the ship steers at the frozen last-observed position and holds its
 * fire); after that it is treated like any lost target (investigate its
 * last-known position). Reacquiring within the memory keeps the reaction
 * already served; after it, reacquiring starts the reaction delay again.
 *
 * No ship fires during the arrival grace, before its reaction delay after
 * acquiring a target, in its first COMBAT.spawnFireDelay ticks, or at a pilot
 * inside the arrival sanctuary.
 */
import { agentSteps } from './dilation.ts';
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import { dist, segmentDistance } from '../sector/grid.ts';
import { COMBAT } from './difficulty.ts';
import { CAPITAL_LAUNCH_TOTAL, CAPITAL_PHASE_TWO, FAMILIES, PHASE_TWO_WEAPONS, type FamilyId } from './families.ts';
import type { FactionId } from '../catalogue/types.ts';
import { inInterference } from './hazards.ts';
import { dropMine, spawnShot, stepBeam } from './projectiles.ts';
import type { Agent, AgentRole, AiState, Target } from './state.ts';
import { bodyBetween, effectiveRange, signature, STEALTH } from './stealth.ts';
import { WEAPONS } from './weapons.ts';
import { damagePlayer, hostileTo, inSanctuary, pushOutOfSolids, setState, targetPos, TICK } from './world.ts';

const wrap = (x: number): number => Math.atan2(Math.sin(x), Math.cos(x));
/** World angle (0 = +x) of a ship heading (0 = nose up, clockwise). */
export const angleOf = (heading: number): number => heading - Math.PI / 2;
const headingOf = (angle: number): number => angle + Math.PI / 2;

/** Ships alive now (destroyed ones are removed at the end of the tick). */
export const liveAgents = (run: SectorRun): number => run.hostiles.reduce((n, a) => n + (a.state === 'destroyed' ? 0 : 1), 0);

/**
 * Create one enemy ship. Refused (null) at the region's active cap, or at the
 * hard cap for bosses, so spawns can never grow without bound.
 */
export function spawnAgent(
  run: SectorRun,
  family: FamilyId,
  faction: FactionId,
  source: string,
  role: AgentRole,
  x: number,
  y: number,
  heading = 0,
  home?: { readonly x: number; readonly y: number },
): Agent | null {
  const cap = role === 'boss' ? COMBAT.maxAgents : Math.min(COMBAT.maxAgents, run.row.maxActive);
  if (liveAgents(run) >= cap || run.disposed) return null;
  const F = FAMILIES[family];
  const trait = run.rng.next();
  const side: 1 | -1 = run.rng.next() < 0.5 ? 1 : -1;
  const p = { x, y, vx: 0, vy: 0 };
  pushOutOfSolids(run.layout, p, F.radius);
  const a: Agent = {
    id: run.nextHostile++,
    family,
    faction,
    source,
    role,
    x: p.x,
    y: p.y,
    vx: 0,
    vy: 0,
    heading,
    px: p.x,
    py: p.y,
    pheading: heading,
    hull: F.hull,
    shield: F.shield,
    maxHull: F.hull,
    maxShield: F.shield,
    sinceHit: F.regenDelay,
    state: defaultState(role),
    stateTicks: 0,
    target: null,
    lastSeen: null,
    waypoint: 0,
    homeX: home?.x ?? p.x,
    homeY: home?.y ?? p.y,
    // staggered first shots: a pack never opens fire on the same tick
    cooldowns: F.weapons.map((w) => Math.round(WEAPONS[w].cooldown * (0.25 + 0.5 * trait))),
    reaction: 0,
    age: 0,
    windup: null,
    burstLeft: 0,
    burstTimer: 0,
    burstSlot: 0,
    beam: null,
    evadeCooldown: 0,
    side,
    trait,
    disabledUsed: false,
    retreatUsed: false,
    called: false,
    phase2: false,
    launched: 0,
    flash: 0,
    seen: 0,
    lost: 0,
    shadow: false,
  };
  run.hostiles.push(a);
  return a;
}

function defaultState(role: AgentRole): AiState {
  if (role === 'patrol') return 'patrol';
  if (role === 'wave' || role === 'launched') return 'investigate';
  return 'idle';
}

function detectRange(run: SectorRun, a: Agent, other: { x: number; y: number }): number {
  const F = FAMILIES[a.family];
  return F.detect * (inInterference(run.layout, a) || inInterference(run.layout, other) ? 0.6 : 1);
}

/** Pick the target: the nearest hostile side in sight (the pilot slightly preferred); infighting is capped. */
function chooseTarget(run: SectorRun, a: Agent, infighters: number): Target | null {
  const P = run.ship;
  let best: Target | null = null;
  let bestScore = Infinity;
  const keep = a.target;
  const playerOk = run.grace === 0 && !run.docked && !inSanctuary(run.layout, P) && hostileTo(run, a.faction, 'player');
  // ship-to-ship sight is distance-only, unless the sector's flight hook owns an occluder (the gravity lab's planet)
  const blocked = run.flight?.sightBlocked;
  // P07.1: the pilot is seen within detect range x signature, past every celestial body; else a held contact is
  // remembered. The lab's hook owns its sight model (its planet, plain geometric sight, no memory), like its physics.
  // P07.2: `shadow` records that a body (not range or signature) is what hides the pilot from this ship
  let mem = false;
  a.shadow = false;
  if (playerOk) {
    const d = dist(a, P);
    const range = effectiveRange(detectRange(run, a, P), signature(run)) * (keep === 'player' ? 1.3 : 1);
    a.shadow = d <= range && !!(blocked ? blocked(a.x, a.y, P.x, P.y) : bodyBetween(run.layout.landmarks, a.x, a.y, P.x, P.y));
    if (d <= range && !a.shadow) {
      best = 'player';
      bestScore = d * 0.85;
    } else mem = !blocked && keep === 'player' && a.lost < STEALTH.memoryTicks;
  }
  const mayInfight = typeof keep === 'number' || infighters < COMBAT.maxInfighters;
  if (mayInfight) {
    for (const o of run.hostiles) {
      if (o === a || o.state === 'destroyed' || !hostileTo(run, a.faction, o.faction)) continue;
      const d = dist(a, o);
      const range = Math.min(detectRange(run, a, o), COMBAT.infightRange) * (keep === o.id ? 1.3 : 1);
      if (d <= range && d < bestScore && !blocked?.(a.x, a.y, o.x, o.y)) {
        best = o.id;
        bestScore = d;
      }
    }
  }
  mem &&= best === null;
  a.lost = mem ? a.lost + 1 : 0;
  return mem ? 'player' : best;
}

function steer(a: Agent, tx: number, ty: number, speed: number, accel: number): void {
  const dx = tx - a.x;
  const dy = ty - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const want = Math.min(speed, d * 3);
  const ax = (dx / d) * want - a.vx;
  const ay = (dy / d) * want - a.vy;
  const al = Math.hypot(ax, ay) || 1;
  const k = Math.min(1, (accel * TICK) / al);
  a.vx += ax * k;
  a.vy += ay * k;
}

/** Steer toward a velocity (not a point). */
function steerVel(a: Agent, vx: number, vy: number, accel: number): void {
  const ax = vx - a.vx;
  const ay = vy - a.vy;
  const al = Math.hypot(ax, ay) || 1;
  const k = Math.min(1, (accel * TICK) / al);
  a.vx += ax * k;
  a.vy += ay * k;
}

function turnToward(a: Agent, angle: number): void {
  const want = headingOf(angle);
  const d = wrap(want - a.heading);
  const t = FAMILIES[a.family].turn * TICK;
  a.heading = wrap(a.heading + Math.max(-t, Math.min(t, d)));
}

/** Aim angle at a target with the region's lead and the ship's seeded jitter. */
function aimAt(run: SectorRun, a: Agent, t: { x: number; y: number; vx: number; vy: number }, speed: number): number {
  const d = dist(a, t);
  const lead = speed > 0 ? (d / speed) * run.row.lead : 0;
  const x = t.x + t.vx * lead;
  const y = t.y + t.vy * lead;
  return Math.atan2(y - a.y, x - a.x) + (run.rng.next() * 2 - 1) * run.row.jitter;
}

function postOf(run: SectorRun, a: Agent): { x: number; y: number } {
  if (a.role === 'patrol') {
    const pr = run.layout.patrols.find((p) => p.id === a.source);
    if (pr) return pr.points[a.waypoint % pr.points.length]!;
  }
  return { x: a.homeX, y: a.homeY };
}

function leashed(run: SectorRun, a: Agent): boolean {
  if (a.role === 'patrol') {
    const pr = run.layout.patrols.find((p) => p.id === a.source);
    if (!pr) return false;
    let d = Infinity;
    for (let i = 0; i < pr.points.length; i++) d = Math.min(d, segmentDistance(a, pr.points[i]!, pr.points[(i + 1) % pr.points.length]!));
    return d > COMBAT.leash;
  }
  if (a.role === 'guard' || a.role === 'boss') return Math.hypot(a.x - a.homeX, a.y - a.homeY) > COMBAT.leash;
  return false;
}

const backToPost = (a: Agent): AiState => (a.role === 'patrol' ? 'patrol' : 'idle');

/* ----------------------------------------------------------------- firing */

function release(run: SectorRun, a: Agent, slot: number, angle: number, events: SectorEvent[]): void {
  const id = FAMILIES[a.family].weapons[slot]!;
  const w = WEAPONS[id];
  if (w.kind === 'beam') {
    a.beam = { start: angle, sweep: w.sweep * a.side, ticks: 0, total: w.active, angle: angle - (w.sweep * a.side) / 2, hit: new Set() };
  } else if (w.kind === 'launch') {
    const bay = { x: a.x - Math.sin(a.heading) * 30, y: a.y + Math.cos(a.heading) * 30 };
    const s = spawnAgent(run, 'raider', a.faction, a.source, 'launched', bay.x, bay.y, a.heading + Math.PI);
    if (s) {
      a.launched += 1;
      s.lastSeen = { x: run.ship.x, y: run.ship.y };
      events.push({ type: 'reinforcements', source: a.source, count: 1, x: bay.x, y: bay.y });
    }
  } else if (w.kind === 'mine') {
    dropMine(run, a);
  } else if (w.kind === 'missile') {
    spawnShot(run, a, id, angle, 0, a.target);
  } else {
    // bolts / shells: pellets fanned over the spread; twin barrels side by side
    for (let p = 0; p < w.pellets; p++) {
      const ang = angle + (w.pellets > 1 ? (p / (w.pellets - 1) - 0.5) * w.spread : 0);
      if (w.twin > 0) {
        spawnShot(run, a, id, ang, -w.twin / 2);
        spawnShot(run, a, id, ang, w.twin / 2);
      } else spawnShot(run, a, id, ang);
    }
    if (w.burst > 1 && a.burstLeft === 0) {
      a.burstLeft = w.burst - 1;
      a.burstTimer = w.burstGap;
      a.burstSlot = slot;
    }
  }
  events.push({ type: 'enemyFired', hostile: a.id, weapon: id, x: a.x, y: a.y });
}

function canFire(run: SectorRun, a: Agent): boolean {
  return run.grace === 0 && a.reaction <= 0 && a.age >= COMBAT.spawnFireDelay && a.state === 'attack' && !run.disposed;
}

function tryFire(run: SectorRun, a: Agent, t: { x: number; y: number; vx: number; vy: number }, d: number, events: SectorEvent[]): void {
  const F = FAMILIES[a.family];
  if (a.target === 'player' && inSanctuary(run.layout, run.ship)) {
    a.windup = null;
    return;
  }
  if (a.windup) {
    const wd = a.windup;
    // missile locks and launch bays track; aimed shots (cannon, beam, broadside, flak) stay locked so they can be dodged
    if (wd.weapon === 'missile') wd.angle = Math.atan2(t.y - a.y, t.x - a.x);
    wd.ticks -= 1;
    if (wd.ticks <= 0) {
      a.windup = null;
      release(run, a, wd.slot, wd.angle, events);
    }
    return;
  }
  if (a.burstLeft > 0) {
    a.burstTimer -= 1;
    if (a.burstTimer <= 0) {
      a.burstLeft -= 1;
      a.burstTimer = WEAPONS[F.weapons[a.burstSlot]!].burstGap;
      const w = WEAPONS[F.weapons[a.burstSlot]!];
      spawnShot(run, a, w.id, aimAt(run, a, t, w.speed));
    }
    return;
  }
  if (a.beam || !canFire(run, a)) return;
  const facing = angleOf(a.heading);
  for (let i = 0; i < F.weapons.length; i++) {
    const id = F.weapons[i]!;
    const w = WEAPONS[id];
    if (a.cooldowns[i]! > 0 || d > w.range) continue;
    if (a.family === 'capital' && PHASE_TWO_WEAPONS.includes(id) && !a.phase2) continue;
    if (id === 'cannon' && d < 160 && F.weapons.includes('flak')) continue; // the heavy uses flak up close
    if (w.kind === 'mine' && (run.mines.filter((m) => m.owner === a.id).length >= w.maxLive || d > w.range)) continue;
    if (w.kind === 'launch') {
      const alive = run.hostiles.filter((o) => o.role === 'launched' && o.source === a.source && o.state !== 'destroyed').length;
      if (alive >= w.maxLive || a.launched >= CAPITAL_LAUNCH_TOTAL) continue;
    }
    const aim = w.kind === 'mine' || w.kind === 'launch' ? facing : aimAt(run, a, t, w.speed > 0 ? w.speed : 1e9);
    const off = id === 'broadside' ? Math.min(Math.abs(wrap(aim - facing - Math.PI / 2)), Math.abs(wrap(aim - facing + Math.PI / 2))) : Math.abs(wrap(aim - facing));
    if (off > w.arc) continue;
    a.cooldowns[i] = Math.round(w.cooldown * run.row.cooldown * (0.9 + 0.2 * a.trait)) + w.windup;
    if (w.windup > 0) {
      a.windup = { slot: i, weapon: id, ticks: w.windup, total: w.windup, angle: aim };
      events.push({ type: 'telegraph', hostile: a.id, weapon: id, x: a.x, y: a.y, ticks: w.windup });
    } else release(run, a, i, aim, events);
    return;
  }
}

/* ---------------------------------------------------------------- tactics */

/** Movement inside engagement range, per family. Faces `aimAngle` while fighting. */
function tactic(run: SectorRun, a: Agent, t: { x: number; y: number; vx: number; vy: number }, d: number): void {
  const F = FAMILIES[a.family];
  const dx = t.x - a.x;
  const dy = t.y - a.y;
  const toT = Math.atan2(dy, dx);
  const ux = dx / (d || 1);
  const uy = dy / (d || 1);
  const prefer = F.prefer * (0.9 + 0.2 * a.trait);
  const radial = (d - prefer) / Math.max(40, prefer * 0.5); // + = too far
  // firing stance: while a shot winds up or a burst is out, sideways motion drops, so
  // every family gives the pilot a readable moment to hit it (bolts fly ~640-780 px/s)
  const stance = a.windup || a.burstLeft > 0 ? 0.35 : 1;
  switch (a.family) {
    case 'raider': {
      // attack runs: dive at the target (nearly head-on, slight seeded offset), then break
      // away sideways and outward, and come round again on a seeded rhythm
      const period = 100 + Math.round(a.trait * 50);
      const diving = a.stateTicks % period < period * 0.55 && d > 55 + F.radius;
      if (diving) steerVel(a, (ux * 0.95 - uy * a.side * 0.22) * F.speed * 0.85, (uy * 0.95 + ux * a.side * 0.22) * F.speed * 0.85, F.accel);
      else {
        const k = Math.max(-1, Math.min(1, (d - prefer * 1.9) / Math.max(40, prefer)));
        steerVel(a, (-uy * a.side * 0.75 + ux * k) * F.speed * 0.9, (ux * a.side * 0.75 + uy * k) * F.speed * 0.9, F.accel);
      }
      break;
    }
    case 'elite': {
      // circles at its preferred range, then holds to shoot (a seeded rhythm); dodges bolts
      const period = 150 + Math.round(a.trait * 60);
      const circling = a.stateTicks % period < period * 0.6;
      const k = Math.max(-1, Math.min(1, radial));
      const side = (circling ? 0.7 : 0.12) * stance;
      steerVel(a, (-uy * a.side * side + ux * k) * F.speed * 0.8, (ux * a.side * side + uy * k) * F.speed * 0.8, F.accel);
      break;
    }
    case 'picket': {
      // strafe across the target at medium range, switching side on a seeded rhythm
      if (a.stateTicks > 0 && a.stateTicks % (90 + Math.round(a.trait * 60)) === 0) a.side = a.side === 1 ? -1 : 1;
      const k = Math.max(-1, Math.min(1, radial));
      const side = 0.6 * stance;
      steerVel(a, (-uy * a.side * side + ux * k) * F.speed * 0.75, (ux * a.side * side + uy * k) * F.speed * 0.75, F.accel);
      break;
    }
    case 'lancer': {
      // full-speed charge through the target's position; the pass ends in a break-off (evade)
      steerVel(a, ux * F.speed, uy * F.speed, F.accel);
      if (d < 70 + F.radius) {
        a.side = run.rng.next() < 0.5 ? 1 : -1;
        setState(a, 'evade');
      }
      break;
    }
    case 'heavy':
    case 'hauler':
    case 'capital': {
      // hold the stand-off range: back off when close, close in when far
      const k = Math.max(-1, Math.min(1, radial));
      steerVel(a, ux * k * F.speed + -uy * a.side * F.speed * 0.15, uy * k * F.speed + ux * a.side * F.speed * 0.15, F.accel);
      break;
    }
    case 'recon': {
      if (d < 300) {
        setState(a, 'retreat');
        break;
      }
      const k = Math.max(-1, Math.min(1, radial));
      steerVel(a, (ux * k - uy * a.side * 0.6 * stance) * F.speed * 0.7, (uy * k + ux * a.side * 0.6 * stance) * F.speed * 0.7, F.accel);
      break;
    }
  }
  // a capital ship turns its flank (broadside) toward the target in phase one
  const face = a.family === 'capital' && !a.phase2 ? toT + (Math.PI / 2) * a.side : toT;
  turnToward(a, a.windup ? a.windup.angle : face);
}

/* ------------------------------------------------------------------- step */

function stepAgent(run: SectorRun, a: Agent, fights: { n: number }, events: SectorEvent[]): void {
  const F = FAMILIES[a.family];
  a.px = a.x;
  a.py = a.y;
  a.pheading = a.heading;
  a.age += 1;
  a.stateTicks += 1;
  if (a.flash > 0) a.flash -= 1;
  a.sinceHit += 1;
  if (a.sinceHit > F.regenDelay && a.shield < a.maxShield) a.shield = Math.min(a.maxShield, a.shield + F.shieldRegen * TICK);
  for (let i = 0; i < a.cooldowns.length; i++) if (a.cooldowns[i]! > 0) a.cooldowns[i]! -= 1;
  if (a.evadeCooldown > 0) a.evadeCooldown -= 1;
  if (a.state === 'destroyed') return;
  if (a.beam) stepBeam(run, a, events);

  /* disabled: drift, no weapons, still fully damageable; always recovers */
  if (a.state === 'disabled') {
    a.vx *= 0.97;
    a.vy *= 0.97;
    a.windup = null;
    a.burstLeft = 0;
    if (a.stateTicks >= F.disableTicks) setState(a, F.retreatAt > 0 ? 'retreat' : 'pursue');
    move(run, a, events);
    return;
  }

  /* perception */
  const prev = a.target;
  a.target = chooseTarget(run, a, fights.n);
  // the infighting count is kept live within the tick, so the cap holds even when many ships look at once
  if (typeof a.target === 'number' && typeof prev !== 'number') fights.n += 1;
  else if (typeof prev === 'number' && typeof a.target !== 'number') fights.n -= 1;
  if (a.target !== null && prev === null) a.reaction = Math.round(run.row.reaction * (0.8 + 0.4 * a.trait));
  else if (a.target === null) a.reaction = 0;
  else if (a.reaction > 0) a.reaction -= 1;
  // P07.1 contact memory: the frozen last-observed position stands in for the pilot (never the live one)
  const ls = a.lastSeen;
  const t = a.lost > 0 ? ls && { x: ls.x, y: ls.y, vx: 0, vy: 0 } : targetPos(run, a.target);
  if (t && !a.lost) {
    a.lastSeen = { x: t.x, y: t.y };
    a.seen += 1;
  } else a.seen = 0;
  const d = t ? dist(a, t) : Infinity;
  const hp = a.hull / a.maxHull;

  /* capital phase two */
  if (a.family === 'capital' && !a.phase2 && hp <= CAPITAL_PHASE_TWO) {
    a.phase2 = true;
    events.push({ type: 'bossPhase', hostile: a.id, x: a.x, y: a.y });
  }
  /* recon: calls every idle ally in range to the pilot's position, once */
  if (a.family === 'recon' && !a.called && a.target === 'player' && a.seen >= COMBAT.reconCallTicks) {
    a.called = true;
    let n = 0;
    for (const o of run.hostiles) {
      if (o === a || o.state === 'destroyed' || o.target !== null || o.faction !== a.faction || dist(o, a) > COMBAT.reconCallRadius) continue;
      if (o.state !== 'idle' && o.state !== 'patrol' && o.state !== 'investigate') continue;
      o.lastSeen = { x: run.ship.x, y: run.ship.y };
      setState(o, 'investigate');
      n += 1;
    }
    events.push({ type: 'reinforcements', source: a.source, count: n, x: a.x, y: a.y });
  }

  /* hurt: retreat once */
  if (F.retreatAt > 0 && hp <= F.retreatAt && !a.retreatUsed && a.state !== 'retreat') {
    a.retreatUsed = true;
    a.windup = null;
    setState(a, 'retreat');
  }
  /* evade after a hit (seeded), or a dodge of an incoming bolt (elites) */
  if ((a.state === 'attack' || a.state === 'pursue') && a.evadeCooldown === 0 && F.evadeTicks > 0) {
    if (a.sinceHit === 1 && F.evadeChance > 0 && run.rng.next() < F.evadeChance) {
      a.side = run.rng.next() < 0.5 ? 1 : -1;
      setState(a, 'evade');
    } else if (F.dodges && incoming(run, a)) setState(a, 'evade');
  }

  switch (a.state) {
    case 'idle':
    case 'patrol': {
      if (t) setState(a, 'pursue');
      else if (a.lastSeen && a.sinceHit < 30) setState(a, 'investigate');
      const post = postOf(run, a);
      const speed = a.state === 'patrol' ? F.speed * 0.55 : F.speed * 0.4;
      steer(a, post.x, post.y, speed, F.accel);
      if (dist(a, post) < 48 && a.role === 'patrol') {
        const pr = run.layout.patrols.find((p) => p.id === a.source);
        if (pr) a.waypoint = (a.waypoint + 1) % pr.points.length;
      }
      faceVelocity(a);
      break;
    }
    case 'investigate': {
      if (t) {
        setState(a, 'pursue');
        break;
      }
      const spot = a.lastSeen ?? (a.role === 'wave' || a.role === 'launched' ? { x: run.ship.x, y: run.ship.y } : postOf(run, a));
      if (!a.lastSeen && (a.role === 'wave' || a.role === 'launched')) a.lastSeen = spot;
      steer(a, spot.x, spot.y, F.speed * 0.8, F.accel);
      faceVelocity(a);
      if (dist(a, spot) < 80 && a.stateTicks > COMBAT.searchTicks) {
        a.lastSeen = null;
        setState(a, backToPost(a));
      } else if (a.stateTicks > COMBAT.searchTicks * 4 || leashed(run, a)) {
        a.lastSeen = null;
        setState(a, backToPost(a));
      }
      break;
    }
    case 'pursue': {
      if (!t) {
        setState(a, a.lastSeen ? 'investigate' : backToPost(a));
        break;
      }
      if (leashed(run, a)) {
        a.target = null;
        a.lastSeen = null;
        setState(a, backToPost(a));
        break;
      }
      if (d <= F.engage) {
        setState(a, 'attack');
        break;
      }
      const lead = Math.min(0.6, d / 600);
      steer(a, t.x + t.vx * lead, t.y + t.vy * lead, F.speed, F.accel);
      turnToward(a, Math.atan2(t.y - a.y, t.x - a.x));
      break;
    }
    case 'attack': {
      if (!t) {
        a.windup = null;
        setState(a, a.lastSeen ? 'investigate' : backToPost(a));
        break;
      }
      if (leashed(run, a)) {
        a.windup = null;
        a.target = null;
        setState(a, backToPost(a));
        break;
      }
      if (d > F.engage * 1.5 && !a.windup) {
        setState(a, 'pursue');
        break;
      }
      tactic(run, a, t, d);
      if (a.lost) a.windup = null; // P07.1: never fires at a remembered position
      else if (a.state === 'attack') tryFire(run, a, t, d, events);
      break;
    }
    case 'evade': {
      a.windup = null;
      const from = t ?? a.lastSeen ?? postOf(run, a);
      const ux = (a.x - from.x) / (dist(a, from) || 1);
      const uy = (a.y - from.y) / (dist(a, from) || 1);
      const away = a.family === 'lancer' ? 0.8 : 0.25;
      steerVel(a, (-uy * a.side + ux * away) * F.speed, (ux * a.side + uy * away) * F.speed, F.accel * 1.4);
      faceVelocity(a);
      if (a.stateTicks >= Math.max(10, F.evadeTicks)) {
        a.evadeCooldown = F.evadeCooldown;
        setState(a, t ? 'attack' : a.lastSeen ? 'investigate' : backToPost(a));
      }
      break;
    }
    case 'retreat': {
      a.windup = null;
      const from = t ?? a.lastSeen ?? run.ship;
      const dd = dist(a, from) || 1;
      steerVel(a, ((a.x - from.x) / dd) * F.speed, ((a.y - from.y) / dd) * F.speed, F.accel);
      faceVelocity(a);
      const hurt = F.retreatAt > 0 && hp <= F.retreatAt;
      if (!hurt && a.family === 'recon' && dd > F.prefer + 40) setState(a, t ? 'attack' : backToPost(a));
      else if (a.stateTicks >= (a.family === 'elite' ? 240 : 360)) setState(a, t ? 'pursue' : backToPost(a));
      break;
    }
  }
  move(run, a, events);
}

function faceVelocity(a: Agent): void {
  if (Math.hypot(a.vx, a.vy) > 12) turnToward(a, Math.atan2(a.vy, a.vx));
}

/** An incoming pilot bolt within 90 px (or a pilot missile within 140 px), closing on this ship. */
function incoming(run: SectorRun, a: Agent): boolean {
  for (const s of run.shots) {
    const dx = a.x - s.x;
    const dy = a.y - s.y;
    if (dx * dx + dy * dy > 90 * 90) continue;
    if (dx * s.vx + dy * s.vy > 0) {
      a.side = s.vx * dy - s.vy * dx > 0 ? 1 : -1;
      return true;
    }
  }
  // a pilot missile is seen earlier (it is bigger and slower than a bolt): within 140 px, closing
  for (const m of run.missiles) {
    const dx = a.x - m.x;
    const dy = a.y - m.y;
    if (dx * dx + dy * dy > 140 * 140) continue;
    if (dx * m.vx + dy * m.vy > 0) {
      a.side = m.vx * dy - m.vy * dx > 0 ? 1 : -1;
      return true;
    }
  }
  return false;
}

/** Integrate; keep out of solids and the arrival sanctuary; ram the pilot. */
function move(run: SectorRun, a: Agent, events: SectorEvent[]): void {
  const F = FAMILIES[a.family];
  const sp = Math.hypot(a.vx, a.vy);
  const max = F.speed * 1.4;
  if (sp > max) {
    a.vx *= max / sp;
    a.vy *= max / sp;
  }
  a.x += a.vx * TICK;
  a.y += a.vy * TICK;
  pushOutOfSolids(run.layout, a, F.radius);
  const L = run.layout;
  const da = dist(a, L.arrival);
  const keep = L.arrival.r + F.radius;
  if (da < keep) {
    const nx = da > 0 ? (a.x - L.arrival.x) / da : 0;
    const ny = da > 0 ? (a.y - L.arrival.y) / da : -1;
    a.x = L.arrival.x + nx * keep;
    a.y = L.arrival.y + ny * keep;
  }
  // ramming: contact damage to the pilot (with knockback and contact invulnerability)
  const P = run.ship;
  if (a.state !== 'disabled' && !run.docked && hostileTo(run, a.faction, 'player') && dist(a, P) < F.radius + run.tune.radius) {
    if (damagePlayer(run, F.contact * run.row.damage, 'hostile', events, a) > 0) {
      const d = dist(a, P) || 1;
      P.vx += ((P.x - a.x) / d) * 240;
      P.vy += ((P.y - a.y) / d) * 240;
      a.vx -= ((P.x - a.x) / d) * 120;
      a.vy -= ((P.y - a.y) / d) * 120;
    }
  }
}

/** Keep allied ships from stacking on one spot (cheap pairwise separation; at most 24 ships). */
function separate(run: SectorRun): void {
  const H = run.hostiles;
  for (let i = 0; i < H.length; i++) {
    const a = H[i]!;
    if (a.state === 'destroyed') continue;
    for (let j = i + 1; j < H.length; j++) {
      const b = H[j]!;
      if (b.state === 'destroyed') continue;
      const min = FAMILIES[a.family].radius + FAMILIES[b.family].radius + 6;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) / 2;
      a.x -= (dx / d) * push;
      a.y -= (dy / d) * push;
      b.x += (dx / d) * push;
      b.y += (dy / d) * push;
    }
  }
}

/** Advance every ship one tick; remove destroyed ships and retreaters that escaped. */
export function stepAgents(run: SectorRun, events: SectorEvent[]): void {
  const fights = { n: 0 };
  for (const a of run.hostiles) if (typeof a.target === 'number' && a.state !== 'destroyed') fights.n += 1;
  // Combat P03C: a ship inside a nuke's dilation zone runs its whole step only on the ticks its accumulator allows
  for (const a of run.hostiles) if (agentSteps(run, a)) stepAgent(run, a, fights, events);
  separate(run);
  for (let i = run.hostiles.length - 1; i >= 0; i--) {
    const a = run.hostiles[i]!;
    if (a.state === 'destroyed') run.hostiles.splice(i, 1);
    else if (a.state === 'retreat' && a.role !== 'boss' && dist(a, run.ship) > COMBAT.sleepRadius) {
      run.hostiles.splice(i, 1);
      events.push({ type: 'escaped', hostile: a.id, source: a.source });
    }
  }
}
