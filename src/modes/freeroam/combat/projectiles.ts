/**
 * Enemy projectiles, mines and beams (Free Roam Prompt 9).
 *
 * Bounded by construction: a shot is refused at COMBAT.maxShots, every shot
 * dies after min(weapon life, COMBAT.maxShotLife) ticks, on solids, at the
 * sector edge, inside the arrival sanctuary, or on the impact that damages.
 * Dropped mines expire after COMBAT.maxMineLife; field mines exist only for
 * the visit. A shot only touches sides its faction is hostile to, so allies
 * never hit each other and a wary faction's fire never hits the pilot.
 */
import { shotScale } from './dilation.ts';
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import { dist, segmentDistance } from '../sector/grid.ts';
import { COMBAT } from './difficulty.ts';
import { FAMILIES } from './families.ts';
import type { Agent, Mine, Target } from './state.ts';
import { WEAPONS, type WeaponId } from './weapons.ts';
import { damageAgent, damagePlayer, hostileTo, inSanctuary, shotBlocked, sweptHit, targetPos, TICK } from './world.ts';

/** Fire one projectile from a ship along a world angle (radians, 0 = +x). Refused at the cap. */
export function spawnShot(run: SectorRun, a: Agent, weapon: WeaponId, angle: number, lateral = 0, target: Target | null = null): boolean {
  if (run.enemyShots.length >= COMBAT.maxShots) return false;
  const w = WEAPONS[weapon];
  if (w.kind !== 'bolt' && w.kind !== 'shell' && w.kind !== 'missile') return false;
  const r = FAMILIES[a.family].radius + 3;
  const cx = Math.cos(angle);
  const cy = Math.sin(angle);
  const x = a.x + cx * r - cy * lateral;
  const y = a.y + cy * r + cx * lateral;
  if (inSanctuary(run.layout, { x, y })) return false;
  run.enemyShots.push({
    id: run.nextEnemyShot++,
    owner: a.id,
    faction: a.faction,
    weapon,
    kind: w.kind,
    x,
    y,
    px: x,
    py: y,
    vx: cx * w.speed + a.vx * 0.3,
    vy: cy * w.speed + a.vy * 0.3,
    life: Math.min(w.life, COMBAT.maxShotLife),
    damage: w.damage * run.row.damage,
    radius: w.radius,
    target: w.kind === 'missile' ? target : null,
    hp: w.hp,
  });
  return true;
}

/** Move every enemy shot; home missiles; resolve the one impact each shot may make. */
export function stepEnemyShots(run: SectorRun, events: SectorEvent[]): void {
  const L = run.layout;
  for (let i = run.enemyShots.length - 1; i >= 0; i--) {
    const s = run.enemyShots[i]!;
    s.px = s.x;
    s.py = s.y;
    // Combat P03C: shots of factions hostile to the pilot move, turn and age at the dilation scale inside a nuke's zone
    const k = shotScale(run, s.faction, s.x, s.y);
    if (s.kind === 'missile') {
      const t = targetPos(run, s.target);
      if (t && !(s.target === 'player' && inSanctuary(L, run.ship))) {
        const want = Math.atan2(t.y - s.y, t.x - s.x);
        const cur = Math.atan2(s.vy, s.vx);
        let d = want - cur;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const turn = WEAPONS[s.weapon].turn * TICK * k;
        const na = cur + Math.max(-turn, Math.min(turn, d));
        const sp = WEAPONS[s.weapon].speed;
        s.vx = Math.cos(na) * sp;
        s.vy = Math.sin(na) * sp;
      }
    }
    s.x += s.vx * TICK * k;
    s.y += s.vy * TICK * k;
    s.life -= k;
    let dead = s.life <= 0 || (s.kind === 'missile' && s.hp <= 0) || s.x < 0 || s.y < 0 || s.x > L.width || s.y > L.height || inSanctuary(L, s) || shotBlocked(L, s.px, s.py, s.x, s.y, s.radius);
    if (!dead && hostileTo(run, s.faction, 'player') && !run.docked && sweptHit(s.px, s.py, s.x, s.y, run.ship.x, run.ship.y, run.tune.radius + s.radius)) {
      // one impact: the shot is spent even when invulnerability absorbs it
      damagePlayer(run, s.damage, 'fire', events, { x: s.px, y: s.py });
      dead = true;
    }
    if (!dead) {
      for (const a of run.hostiles) {
        if (a.id === s.owner || a.state === 'destroyed' || !hostileTo(run, s.faction, a.faction)) continue;
        if (!sweptHit(s.px, s.py, s.x, s.y, a.x, a.y, FAMILIES[a.family].radius + s.radius)) continue;
        damageAgent(run, a, s.damage, s.faction, events);
        dead = true;
        break;
      }
    }
    if (dead) run.enemyShots.splice(i, 1);
  }
}

/** Advance a ship's sweep beam; each target is damaged at most once per firing. */
export function stepBeam(run: SectorRun, a: Agent, events: SectorEvent[]): void {
  const b = a.beam;
  if (!b) return;
  const w = WEAPONS.beam;
  b.ticks += 1;
  b.angle = b.start + b.sweep * (b.ticks / b.total - 0.5);
  const ex = a.x + Math.cos(b.angle) * w.length;
  const ey = a.y + Math.sin(b.angle) * w.length;
  const P = run.ship;
  if (!b.hit.has('player') && hostileTo(run, a.faction, 'player') && !inSanctuary(run.layout, P) && segmentDistance(P, a, { x: ex, y: ey }) <= w.width + run.tune.radius) {
    b.hit.add('player');
    damagePlayer(run, w.damage * run.row.damage, 'fire', events, a);
  }
  for (const o of run.hostiles) {
    if (o === a || o.state === 'destroyed' || b.hit.has(o.id) || !hostileTo(run, a.faction, o.faction)) continue;
    if (segmentDistance(o, a, { x: ex, y: ey }) > w.width + FAMILIES[o.family].radius) continue;
    b.hit.add(o.id);
    damageAgent(run, o, w.damage * run.row.damage, a.faction, events);
  }
  if (b.ticks >= b.total) a.beam = null;
}

/** Drop a mine behind a ship (cargo raiders). Refused at the per-ship or global cap. */
export function dropMine(run: SectorRun, a: Agent): boolean {
  const w = WEAPONS.mine;
  if (run.mines.length >= COMBAT.maxMines) return false;
  if (run.mines.filter((m) => m.owner === a.id).length >= w.maxLive) return false;
  const back = a.heading + Math.PI;
  const x = a.x + Math.sin(back) * (FAMILIES[a.family].radius + 8);
  const y = a.y - Math.cos(back) * (FAMILIES[a.family].radius + 8);
  if (inSanctuary(run.layout, { x, y }, COMBAT.sanctuaryMargin)) return false;
  run.mines.push({ id: run.nextMine++, x, y, faction: a.faction, owner: a.id, arm: w.arm, fuse: -1, life: COMBAT.maxMineLife });
  return true;
}

/** Lay the visit's field mines from the layout (on entry and after a recall). */
export function layFieldMines(run: SectorRun): void {
  for (let i = run.mines.length - 1; i >= 0; i--) if (typeof run.mines[i]!.owner === 'string') run.mines.splice(i, 1);
  for (const z of run.layout.hazards) {
    if (z.kind !== 'minefield' || !z.faction) continue;
    for (const m of z.mines) {
      if (run.mines.length >= COMBAT.maxMines) return;
      if (inSanctuary(run.layout, m, COMBAT.sanctuaryMargin)) continue;
      run.mines.push({ id: run.nextMine++, x: m.x, y: m.y, faction: z.faction, owner: z.id, arm: 0, fuse: -1, life: Infinity });
    }
  }
}

/** Trigger a mine now (shot by the pilot). */
export function triggerMine(m: Mine): void {
  if (m.fuse < 0 || m.fuse > 1) m.fuse = 1;
}

/** Arm, trigger (telegraph: a blinking ring) and detonate mines; expire dropped ones. */
export function stepMines(run: SectorRun, events: SectorEvent[]): void {
  const w = WEAPONS.mine;
  const P = run.ship;
  for (let i = run.mines.length - 1; i >= 0; i--) {
    const m = run.mines[i]!;
    m.life -= 1;
    if (m.life <= 0) {
      run.mines.splice(i, 1);
      continue;
    }
    if (m.arm > 0) {
      m.arm -= 1;
      continue;
    }
    if (m.fuse < 0) {
      const near =
        (run.grace === 0 && hostileTo(run, m.faction, 'player') && !run.docked && dist(P, m) < w.trigger + run.tune.radius) ||
        run.hostiles.some((a) => a.state !== 'destroyed' && hostileTo(run, m.faction, a.faction) && dist(a, m) < w.trigger + FAMILIES[a.family].radius);
      if (near) {
        m.fuse = w.fuse;
        events.push({ type: 'telegraph', hostile: 0, weapon: 'mine', x: m.x, y: m.y, ticks: w.fuse });
      }
      continue;
    }
    m.fuse -= 1;
    if (m.fuse > 0) continue;
    // detonation: everything hostile to the layer inside the blast is hit once
    run.mines.splice(i, 1);
    events.push({ type: 'blast', kind: 'mine', x: m.x, y: m.y, r: w.blast });
    if (hostileTo(run, m.faction, 'player') && dist(P, m) < w.blast + run.tune.radius) damagePlayer(run, w.damage * run.row.damage, 'mine', events, m);
    for (const a of run.hostiles) {
      if (a.state === 'destroyed' || !hostileTo(run, m.faction, a.faction)) continue;
      if (dist(a, m) < w.blast + FAMILIES[a.family].radius) damageAgent(run, a, w.damage * run.row.damage, m.faction, events);
    }
  }
}
