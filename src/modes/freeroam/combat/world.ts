/**
 * Combat world rules shared by the runtime modules (Free Roam Prompt 9):
 * geometry against the static layout, damage application and provocation.
 *
 * Damage rules (tested in tests/combat.test.ts):
 *  - every attack applies its damage once per valid impact: a projectile is
 *    removed on the impact that damages, a beam remembers what it hit this
 *    firing, a mine or eruption hits each target once per blast;
 *  - shields absorb first, then the hull; the pilot's hull never regenerates
 *    in flight; enemy shields regenerate after a pause without hits;
 *  - the pilot gets short invulnerability after a hull hit from fire, longer
 *    after ramming, and none from shield hits or environmental drain;
 *  - enemies are NEVER invulnerable: damage applies in every live AI state
 *    (disabled and retreating ships included); only `destroyed` ignores it,
 *    and a destroyed ship is removed the same tick;
 *  - NPC-on-NPC damage is scaled by COMBAT.npcDamageMul and credits nothing.
 *
 * Imports `type SectorRun` only: run.ts imports this module at runtime.
 */
import type { FactionId } from '../catalogue/types.ts';
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import { segmentDistance, dist } from '../sector/grid.ts';
import type { SectorLayout } from '../sector/model.ts';
import { COMBAT } from './difficulty.ts';
import { isHostile, type Side } from './factions.ts';
import { FAMILIES } from './families.ts';
import { heatHit } from './factionHeat.ts';
import { incomingDamageMul } from './shipAbilities.ts';
import type { Agent, Target } from './state.ts';

export const TICK = 1 / 60;

/** Is (x, y) within `r` of the segment a -> b? (swept test: fast projectiles cannot tunnel through targets) */
export function sweptHit(ax: number, ay: number, bx: number, by: number, x: number, y: number, r: number): boolean {
  return segmentDistance({ x, y }, { x: ax, y: ay }, { x: bx, y: by }) <= r;
}

/** Does a projectile of radius `r` moving a -> b touch anything solid (stars, bodies, rocks, solid POIs)? */
export function shotBlocked(L: SectorLayout, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  for (const l of L.landmarks) if (sweptHit(ax, ay, bx, by, l.x, l.y, l.r + r)) return true;
  for (const k of L.rocks) {
    if (Math.abs(k.x - bx) > k.r + 40 || Math.abs(k.y - by) > k.r + 40) continue;
    if (sweptHit(ax, ay, bx, by, k.x, k.y, k.r + r)) return true;
  }
  for (const p of L.pois) if (p.solidR > 0 && sweptHit(ax, ay, bx, by, p.x, p.y, p.solidR + r)) return true;
  return false;
}

/** Push a circle out of every solid it overlaps (enemy ships do not fly through rocks or stars). */
export function pushOutOfSolids(L: SectorLayout, o: { x: number; y: number; vx: number; vy: number }, r: number): void {
  const out = (x: number, y: number, rr: number): void => {
    const dx = o.x - x;
    const dy = o.y - y;
    const d = Math.hypot(dx, dy);
    const min = rr + r;
    if (d >= min) return;
    const nx = d > 0 ? dx / d : 0;
    const ny = d > 0 ? dy / d : -1;
    o.x = x + nx * min;
    o.y = y + ny * min;
    const vn = o.vx * nx + o.vy * ny;
    if (vn < 0) {
      o.vx -= vn * nx;
      o.vy -= vn * ny;
    }
  };
  for (const l of L.landmarks) out(l.x, l.y, l.r);
  for (const k of L.rocks) if (Math.abs(k.x - o.x) < k.r + r + 4 && Math.abs(k.y - o.y) < k.r + r + 4) out(k.x, k.y, k.r);
  for (const p of L.pois) if (p.solidR > 0) out(p.x, p.y, p.solidR);
  o.x = Math.min(L.width, Math.max(0, o.x));
  o.y = Math.min(L.height, Math.max(0, o.y));
}

/** The arrival zone is a sanctuary: no enemy enters, no enemy shot crosses it, no mine arms near it. */
export const inSanctuary = (L: SectorLayout, p: { readonly x: number; readonly y: number }, margin = 0): boolean => dist(p, L.arrival) < L.arrival.r + margin;

export const agentById = (run: SectorRun, id: number): Agent | undefined => run.hostiles.find((a) => a.id === id);

/** Position of a target, or null when it no longer exists (or the pilot is in the sanctuary). */
export function targetPos(run: SectorRun, t: Target | null): { x: number; y: number; vx: number; vy: number } | null {
  if (t === null) return null;
  if (t === 'player') return run.ship;
  const a = agentById(run, t);
  return a && a.state !== 'destroyed' ? a : null;
}

/** Is `a` currently hostile toward side `b`? */
export const hostileTo = (run: SectorRun, a: Side, b: Side): boolean => isHostile(a, b, run.provoked);

/** The pilot provokes a wary faction (shooting one of its ships, contesting its claim). Once per faction per visit. */
export function provoke(run: SectorRun, faction: FactionId, why: 'shot' | 'claim', events: SectorEvent[]): void {
  if (run.provoked.has(faction)) return;
  run.provoked.add(faction);
  events.push({ type: 'provoked', faction, why });
}

export type PlayerDamageSource = 'impact' | 'hostile' | 'star' | 'hazard' | 'fire' | 'mine' | 'eruption';

/**
 * Damage the pilot: the shield absorbs first, the rest hits the hull. Combat
 * sources respect (and grant) invulnerability; environmental drain does not.
 * P08.1: the one damage boundary for the Condor's Bulwark (combat/shipAbilities.ts
 * incomingDamageMul: combat hits only, exactly 1 otherwise). Returns the damage dealt (0 when ignored).
 */
export function damagePlayer(run: SectorRun, amount: number, source: PlayerDamageSource, events: SectorEvent[], from?: { readonly x: number; readonly y: number }): number {
  const n = Math.max(0, Number.isFinite(amount) ? amount : 0) * incomingDamageMul(run, source);
  if (n <= 0 || run.disposed) return 0;
  const timed = source !== 'star' && source !== 'hazard';
  if (timed && run.invuln > 0) return 0;
  const absorbed = Math.min(run.shield, n);
  run.shield -= absorbed;
  const toHull = n - absorbed;
  run.hull = Math.max(0, run.hull - toHull);
  run.sinceHit = 0;
  if (from && absorbed > 0) run.shieldHit = { angle: Math.atan2(from.y - run.ship.y, from.x - run.ship.x), tick: run.tick };
  if (timed) {
    if (source === 'impact' || source === 'hostile') run.invuln = COMBAT.contactInvulnTicks;
    else if (toHull > 0) run.invuln = COMBAT.hitInvulnTicks;
    events.push({ type: 'hit', source, damage: Math.round(n * 10) / 10 });
  }
  return n;
}

/**
 * Damage an enemy ship. `by` is the attacking side ('player' or a faction);
 * NPC attackers deal reduced damage; 'environment' (eruptions) deals full
 * damage and credits nobody. Applies once per call; the caller removes
 * its projectile. Returns true if the ship was destroyed by this hit.
 */
export function damageAgent(run: SectorRun, a: Agent, amount: number, by: Side | 'environment', events: SectorEvent[]): boolean {
  if (a.state === 'destroyed' || run.disposed) return false;
  const n = Math.max(0, Number.isFinite(amount) ? amount : 0) * (by === 'player' || by === 'environment' ? 1 : COMBAT.npcDamageMul);
  if (n <= 0) return false;
  const absorbed = Math.min(a.shield, n);
  a.shield -= absorbed;
  a.hull = Math.max(0, a.hull - (n - absorbed));
  a.sinceHit = 0;
  a.flash = 6;
  if (by === 'player') {
    if (!hostileTo(run, a.faction, 'player')) provoke(run, a.faction, 'shot', events);
    const enc = run.encounters.find((e) => e.id === a.source);
    if (enc) enc.engaged = true;
    // being shot reveals the shooter: the ship turns on the pilot
    if (a.target === null || a.state === 'idle' || a.state === 'patrol' || a.state === 'investigate') {
      a.lastSeen = { x: run.ship.x, y: run.ship.y };
      if (a.state === 'idle' || a.state === 'patrol') setState(a, 'investigate');
    }
  }
  if (by === 'player') heatHit(run, a, a.hull <= 0, events); // P09.1: the one attribution point
  if (a.hull <= 0) {
    setState(a, 'destroyed');
    a.vx *= 0.3;
    a.vy *= 0.3;
    if (by === 'player') run.kills += 1;
    events.push({ type: 'destroyed', hostile: a.id, family: a.family, faction: a.faction, source: a.source, by: by === 'player' ? 'player' : 'npc', role: a.role, x: a.x, y: a.y, size: FAMILIES[a.family].size });
    return true;
  }
  events.push({ type: 'struck', hostile: a.id, x: a.x, y: a.y, shield: absorbed > 0 && a.shield > 0, by: by === 'player' ? 'player' : 'npc' });
  const F = FAMILIES[a.family];
  if (F.disableAt > 0 && !a.disabledUsed && a.hull <= a.maxHull * F.disableAt) {
    a.disabledUsed = true;
    a.windup = null;
    a.beam = null;
    a.burstLeft = 0;
    setState(a, 'disabled');
    events.push({ type: 'disabled', hostile: a.id, x: a.x, y: a.y });
  }
  return false;
}

/** Change AI state (resets the state timer; `destroyed` is terminal). */
export function setState(a: Agent, s: Agent['state']): void {
  if (a.state === 'destroyed' || a.state === s) return;
  a.state = s;
  a.stateTicks = 0;
}
