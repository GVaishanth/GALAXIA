/**
 * Classic ordnance adapter (Combat P03C, FR-TD-89): the post-Wave-20 ship's
 * weapons in the Classic playfield. Pure simulation on Classic's fixed step.
 *
 * Shared, not duplicated:
 *  - weapon numbers come from the catalogue (config/weapons.ts WEAPONS),
 *    scaled once by CLASSIC_ORDNANCE (distances x0.5, speeds x0.8, damage in
 *    Classic hits of 14, lock-on gated by its cooldown alone, stock refilled
 *    at every stage start);
 *  - rotation, selection, cooldowns and the fire check are the same runtime
 *    Free Roam uses (core/weapons/arsenal.ts).
 *
 * Rules in the Classic playfield:
 *  - the nose points up; plasma is the original gun (player.ts, unchanged);
 *  - heavy missile: no lock, flies up from the nose, detonates on the first
 *    enemy it touches or at the end of its fuse; the blast hits every other
 *    enemy in its radius once (falloff to the edge);
 *  - lock-on: FIRE starts a lock on the enemy nearest the nose line within
 *    range and cone; the lock holds while it stays in the keep range / cone,
 *    then the missile launches and steers at a bounded turn rate; no target
 *    = refused, nothing spent; a lost target = it flies straight and fizzles;
 *  - nuke (Condor / Albatross only, by the ship's mounts): one per stage, a
 *    short slow flight, a big blast and a 2 s zone where enemy shots and
 *    enemies flying a path run at half speed (formation slots keep the
 *    formation's clock, so the grid never tears; the fighter is never slowed);
 *  - captured fighters still held by a commander are never hit by a missile
 *    or a blast (only a hostile one is), so a rescue is never spoiled;
 *  - every kill goes through hitEnemy / destroyEnemy: scoring is unchanged.
 */
import { CLASSIC_ORDNANCE, WEAPON_BY_ID, type OrdnanceWeapon, type WeaponId } from '../../config/weapons.ts';
import type { InputFrame } from '../game/input.ts';
import type { ClassicMissile, ClassicOrdnance, Enemy, World } from '../game/types.ts';
import { createArsenal, cycleWeapon, fireGate, startCooldown, tickArsenal, type ArsenalSpec } from '../weapons/arsenal.ts';
import type { SimContext } from './context.ts';
import { hitEnemy } from './damage.ts';
import { isTargetable } from './enemies.ts';

/** The ship a Classic game is flown with after the Wave 20 milestone (null = the legacy fighter). */
export interface ClassicLoadout extends ArsenalSpec {
  readonly ship: string;
}

const TICK_MS = 1000 / 60; // catalogue values are in 60 Hz ticks
const D = CLASSIC_ORDNANCE.distance;
const V = CLASSIC_ORDNANCE.speed;
const R = CLASSIC_ORDNANCE.acquireRange;
const NOTICE_MS = 1000;

const ordnanceOf = (id: WeaponId): OrdnanceWeapon | null => {
  const w = WEAPON_BY_ID.get(id);
  return w && w.fire === 'ordnance' ? w : null;
};

/** Classic hits for an amount of catalogue damage (at least one). */
export const classicHits = (damage: number): number => Math.max(1, Math.round(damage / CLASSIC_ORDNANCE.hitDamage));

/** Stock weapons full (Classic has no stations: they refill at every stage start). */
function fullAmmo(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of WEAPON_BY_ID.values()) if (w.ammo.kind === 'stock') out[w.id] = w.ammo.capacity;
  return out;
}

export function createClassicOrdnance(spec: ClassicLoadout): ClassicOrdnance {
  return { ship: spec.ship, arsenal: createArsenal(spec), ammo: fullAmmo(), missiles: [], zones: [], blasts: [], lock: null, notice: null, noticeMs: 0, held: false, nextId: 0 };
}

/** Stage start: magazines full, nothing left in flight, no lock, no zone. Cooldowns keep running. */
export function refillOrdnance(o: ClassicOrdnance): void {
  Object.assign(o.ammo, fullAmmo());
  o.missiles.length = 0;
  o.zones.length = 0;
  o.blasts.length = 0;
  o.lock = null;
  o.notice = null;
  o.noticeMs = 0;
}

/** The original gun fires only while plasma is selected (always, for the legacy fighter). */
export function gunSelected(world: World): boolean {
  return !world.ordnance || world.ordnance.arsenal.selected === 'plasma';
}

const liveOf = (o: ClassicOrdnance, id: WeaponId): number => o.missiles.filter((m) => m.weapon === id).length;

export function classicGate(o: ClassicOrdnance, id: WeaponId): ReturnType<typeof fireGate> {
  return fireGate(o.arsenal, id, { stock: (w) => o.ammo[w] ?? 0, energy: null, live: liveOf(o, id) });
}

/** Missiles, the lock and blasts never hit a captive still held by a commander. */
const eligible = (e: Enemy): boolean => isTargetable(e) && (e.kind !== 'capturedFighter' || e.captiveMode === 'hostile');

function notify(o: ClassicOrdnance, n: ClassicOrdnance['notice']): void {
  o.notice = n;
  o.noticeMs = NOTICE_MS;
}

/** Up = the nose. The candidate nearest the nose line within range and cone, if any. */
function pickTarget(ctx: SimContext, w: OrdnanceWeapon): Enemy | null {
  if (w.guidance.kind !== 'lock') return null;
  const p = ctx.world.player;
  const q = w.guidance.acquire;
  let best: Enemy | null = null;
  let bestOff = Infinity;
  for (const e of ctx.world.enemies) {
    if (!eligible(e)) continue;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    if (dy >= 0) continue; // behind the nose
    const d = Math.hypot(dx, dy);
    if (d > q.range * R || Math.atan2(Math.abs(dx), -dy) > q.cone) continue;
    const off = Math.abs(dx) + d * 1e-3;
    if (off < bestOff) {
      best = e;
      bestOff = off;
    }
  }
  return best;
}

function keepsLock(ctx: SimContext, w: OrdnanceWeapon, e: Enemy | undefined): boolean {
  if (!e || !eligible(e) || w.guidance.kind !== 'lock' || ctx.world.player.state !== 'alive') return false;
  const p = ctx.world.player;
  const dx = e.x - p.x;
  const dy = e.y - p.y;
  return dy < 0 && Math.hypot(dx, dy) <= w.guidance.acquire.keepRange * R && Math.atan2(Math.abs(dx), -dy) <= w.guidance.acquire.keepCone;
}

function launch(ctx: SimContext, o: ClassicOrdnance, w: OrdnanceWeapon, target: Enemy | null): void {
  const p = ctx.world.player;
  const x = p.x;
  const y = p.y + ctx.cfg.shots.spawnOffsetY;
  const speed = w.projectile.launchSpeed * V;
  o.nextId += 1;
  o.missiles.push({ id: o.nextId, weapon: w.id, x, y, prevX: x, prevY: y, vx: 0, vy: -speed, speed, lifeMs: w.projectile.lifeTicks * TICK_MS, target: target ? target.id : null });
  if (w.ammo.kind === 'stock') o.ammo[w.id] = Math.max(0, (o.ammo[w.id] ?? 0) - 1);
  startCooldown(o.arsenal, w.id);
  o.lock = null;
  ctx.emit({ type: 'ordnanceLaunched', weapon: w.id, x, y });
}

function refuse(ctx: SimContext, o: ClassicOrdnance, id: WeaponId, reason: 'noTarget' | 'empty' | 'cooling' | 'busy' | 'unavailable'): void {
  notify(o, reason === 'unavailable' ? null : reason);
  ctx.emit({ type: 'ordnanceRefused', weapon: id, reason });
}

/** Detonation at (x, y): every other eligible enemy in the radius takes falloff damage once; the nuke opens its zone. */
function detonate(ctx: SimContext, o: ClassicOrdnance, w: OrdnanceWeapon, x: number, y: number, direct: Enemy | null): void {
  let hits = direct ? 1 : 0;
  const b = w.blast;
  const r = b ? b.radius * D : 0;
  if (b) {
    for (const e of [...ctx.world.enemies]) {
      if (e === direct || !eligible(e)) continue;
      const box = ctx.cfg.hitboxes[e.kind];
      const d = Math.max(0, Math.hypot(e.x - x, e.y - y) - Math.max(box.w, box.h) / 2);
      if (d > r) continue;
      const dmg = b.damage * (1 - (1 - b.edgeMul) * (d / r));
      for (let n = classicHits(dmg); n > 0 && e.state !== 'destroyed'; n--) hitEnemy(ctx, e);
      hits += 1;
    }
  }
  if (w.dilation) {
    const z = w.dilation;
    o.zones.push({ x, y, r: z.radius * D, scale: z.scale, msLeft: z.durationTicks * TICK_MS, durationMs: z.durationTicks * TICK_MS });
  }
  o.blasts.push({ x, y, r: Math.max(r, 10), weapon: w.id, ageMs: 0, durationMs: Math.max(260, w.effect.ringTicks * TICK_MS) });
  if (o.blasts.length > 8) o.blasts.shift();
  ctx.emit({ type: 'detonation', weapon: w.id, x, y, r, hits });
}

function impactOf(ctx: SimContext, m: ClassicMissile, w: OrdnanceWeapon): Enemy | null {
  const rad = w.projectile.radius * D;
  const cx = (m.x + m.prevX) / 2;
  const cy = (m.y + m.prevY) / 2;
  const mw = Math.abs(m.x - m.prevX) + rad * 2;
  const mh = Math.abs(m.y - m.prevY) + rad * 2;
  let hit: Enemy | null = null;
  let best = Infinity;
  for (const e of ctx.world.enemies) {
    if (!eligible(e)) continue;
    const box = ctx.cfg.hitboxes[e.kind];
    if (Math.abs(cx - e.x) * 2 >= mw + box.w || Math.abs(cy - e.y) * 2 >= mh + box.h) continue;
    const d = Math.hypot(e.x - m.prevX, e.y - m.prevY); // nearest along the travel
    if (d < best) {
      best = d;
      hit = e;
    }
  }
  return hit;
}

function moveMissiles(ctx: SimContext, o: ClassicOrdnance, dtMs: number, live: boolean): void {
  const k = dtMs / 1000;
  const W = ctx.cfg.world;
  for (let i = o.missiles.length - 1; i >= 0; i--) {
    const m = o.missiles[i]!;
    const w = ordnanceOf(m.weapon)!;
    m.prevX = m.x;
    m.prevY = m.y;
    m.speed = Math.min(w.projectile.speed * V, m.speed + w.projectile.accel * V * k);
    let dirX = m.vx / (Math.hypot(m.vx, m.vy) || 1);
    let dirY = m.vy / (Math.hypot(m.vx, m.vy) || 1);
    if (m.target !== null && w.guidance.kind === 'lock') {
      const t = ctx.world.enemies.find((e) => e.id === m.target);
      if (!t || !eligible(t)) {
        m.target = null; // lost: straight on, then it fizzles
        m.lifeMs = Math.min(m.lifeMs, w.guidance.lostLife * TICK_MS);
      } else {
        const want = Math.atan2(t.y - m.y, t.x - m.x);
        const cur = Math.atan2(dirY, dirX);
        const d = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        const turn = w.guidance.turn * k; // bounded: it can miss
        const a = cur + Math.max(-turn, Math.min(turn, d));
        dirX = Math.cos(a);
        dirY = Math.sin(a);
      }
    }
    m.vx = dirX * m.speed;
    m.vy = dirY * m.speed;
    m.x += m.vx * k;
    m.y += m.vy * k;
    m.lifeMs -= dtMs;
    if (m.x < -20 || m.x > W.width + 20 || m.y < -20 || m.y > W.height + 20) {
      o.missiles.splice(i, 1); // the field edge: gone, no blast off-screen
      continue;
    }
    const hit = live ? impactOf(ctx, m, w) : null;
    if (hit) {
      for (let n = classicHits(w.impactDamage); n > 0 && hit.state !== 'destroyed'; n--) hitEnemy(ctx, hit);
      o.missiles.splice(i, 1);
      detonate(ctx, o, w, m.x, m.y, hit);
      continue;
    }
    if (m.lifeMs <= 0) {
      o.missiles.splice(i, 1);
      if (live && w.projectile.onExpiry === 'detonate') detonate(ctx, o, w, m.x, m.y, null);
    }
  }
}

/**
 * One Classic tick of the ordnance: the switch edge, cooldowns, the FIRE
 * press for the selected missile weapon, the lock, every missile, zones and
 * blast rings. `controllable` = the player may act; `live` = hits count
 * (false between stages and after game over: missiles just fly out).
 */
export function updateOrdnance(ctx: SimContext, input: InputFrame, controllable: boolean, dtMs: number, live: boolean): void {
  const o = ctx.world.ordnance;
  if (!o) return;
  const p = ctx.world.player;
  const alive = p.state === 'alive';
  if (controllable && (input.cycle === 1 || input.cycle === -1) && cycleWeapon(o.arsenal, input.cycle)) {
    o.lock = null; // a lock in progress is dropped, nothing spent
    o.notice = null;
    ctx.emit({ type: 'weaponSwitched', weapon: o.arsenal.selected });
  }
  tickArsenal(o.arsenal, dtMs / TICK_MS);
  if (o.noticeMs > 0 && (o.noticeMs -= dtMs) <= 0) o.notice = null;
  for (let i = o.zones.length - 1; i >= 0; i--) if ((o.zones[i]!.msLeft -= dtMs) <= 0) o.zones.splice(i, 1);
  for (let i = o.blasts.length - 1; i >= 0; i--) if ((o.blasts[i]!.ageMs += dtMs) >= o.blasts[i]!.durationMs) o.blasts.splice(i, 1);

  if (!alive) {
    // hit / captured: no slow-motion zone or half-made lock outlives the fighter (missiles already flying go on)
    o.zones.length = 0;
    o.lock = null;
  }
  const fireDown = controllable && alive && (input.fire || input.fireHeld === true);
  const pressed = fireDown && !o.held;
  o.held = fireDown;
  const id = o.arsenal.selected;
  const w = ordnanceOf(id);
  if (o.lock) {
    const t = ctx.world.enemies.find((e) => e.id === o.lock!.target);
    if (!w || !controllable || !keepsLock(ctx, w, t)) {
      o.lock = null;
      notify(o, 'lockLost');
      ctx.emit({ type: 'lockLost' });
    } else if (w.guidance.kind === 'lock' && (o.lock.ms += dtMs) >= w.guidance.acquire.lockTicks * TICK_MS) {
      const gate = classicGate(o, id);
      if (gate === 'ok') launch(ctx, o, w, t!);
      else {
        o.lock = null;
        refuse(ctx, o, id, gate === 'lowEnergy' ? 'cooling' : gate);
      }
    }
  } else if (pressed && w) {
    const gate = classicGate(o, id);
    if (gate !== 'ok') refuse(ctx, o, id, gate === 'lowEnergy' ? 'cooling' : gate);
    else if (w.guidance.kind !== 'lock') launch(ctx, o, w, null);
    else {
      const t = pickTarget(ctx, w);
      if (!t) refuse(ctx, o, id, 'noTarget');
      else {
        o.lock = { target: t.id, ms: 0 };
        ctx.emit({ type: 'lockStarted', target: t.id });
      }
    }
  }
  moveMissiles(ctx, o, dtMs, live);
}
