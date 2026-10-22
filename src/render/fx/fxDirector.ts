/**
 * FX director: turns engine events and reward events into visual effects.
 *
 * Contract (Stage 4):
 * - Read-only with respect to the simulation. It receives events after the
 *   tick that produced them and reads world positions, but never writes to
 *   the world, the engine or the reward manager. Removing it changes nothing
 *   in play (verified by tests comparing digests).
 * - Its own seeded RNG; the engine RNG is never touched.
 * - Bounded: two fixed particle pools, capped rings / flashes / pop-ups /
 *   emitters / scheduled bursts, every entry with a duration.
 * - Frozen while paused: the shell simply stops calling update().
 */
import { FX, type DebrisRecipe, type FlashRecipe, type RingRecipe } from '../../config/effects.ts';
import { HUD_LAYOUT } from '../../config/hud.ts';
import { COLORS, type ColorRole } from '../../config/palette.ts';
import type { GameEvent } from '../../core/game/events.ts';
import type { Enemy, EnemyKind, World } from '../../core/game/types.ts';
import type { RewardEvent } from '../../core/rewards/types.ts';
import { createRng, type Rng } from '../../core/rng.ts';
import type { Viewport } from '../viewport.ts';
import { BoundedList, drawFlash, drawPopup, drawRing, Marks, Shake, type Flash, type Popup, type Ring } from './effects.ts';
import { ParticlePool } from './particles.ts';

type ReadWorld = Readonly<Pick<World, 'enemies' | 'player' | 'stageKind'>>;

interface Emitter {
  kind: 'rescue' | 'beam';
  targetId: string;
  age: number;
  ms: number;
  acc: number;
}

interface Scheduled {
  atMs: number;
  x: number;
  y: number;
  count: number;
  colors: readonly ColorRole[];
}

export interface FxStats {
  readonly trails: number;
  readonly debris: number;
  readonly rings: number;
  readonly flashes: number;
  readonly popups: number;
  readonly emitters: number;
  readonly scheduled: number;
  readonly marks: number;
  readonly dropped: number;
}

const TRAIL_ROLE: Readonly<Record<EnemyKind, ColorRole>> = {
  scout: 'scout.wing',
  interceptor: 'interceptor.wing',
  commander: 'commander.hull',
  transform: 'fx.orange',
  capturedFighter: 'captive.hull',
};

export interface FxOptions {
  readonly seed?: number;
  readonly reducedMotion?: boolean;
}

export class FxDirector {
  readonly trails = new ParticlePool(FX.caps.trails);
  readonly debris = new ParticlePool(FX.caps.debris);
  readonly rings = new BoundedList<Ring>(FX.caps.rings);
  readonly flashes = new BoundedList<Flash>(FX.caps.flashes);
  readonly popups = new BoundedList<Popup>(FX.caps.popups);
  readonly shake = new Shake();
  readonly marks = new Marks(FX.caps.marks);
  private emitters: Emitter[] = [];
  private scheduled: Scheduled[] = [];
  private clockMs = 0;
  private trailAcc = 0;
  private shakeNow = { x: 0, y: 0 };
  private lastKill: { x: number; y: number } = { x: 224, y: 200 };
  private readonly rng: Rng;
  reducedMotion: boolean;

  constructor(options: FxOptions = {}) {
    this.rng = createRng(options.seed ?? 0x6a11);
    this.reducedMotion = options.reducedMotion ?? false;
  }

  /** Presentation clock (ms of unpaused fx time). */
  get nowMs(): number {
    return this.clockMs;
  }

  /* ---------------------------------- events ---------------------------------- */

  handleGameEvent(e: GameEvent, world: ReadWorld): void {
    switch (e.type) {
      case 'enemyDestroyed': {
        this.lastKill = { x: e.x, y: e.y };
        this.burst(e.x, e.y, FX.debris[e.kind]);
        if (e.kind === 'commander') {
          this.ring(e.x, e.y, FX.ring.boss);
          this.burst(e.x, e.y, FX.debris.smoke);
          this.flash(FX.flash.boss);
          this.addShake(FX.shake.boss.amp, FX.shake.boss.ms);
        }
        break;
      }
      case 'enemyHit':
        this.burst(e.x, e.y, FX.debris.hit);
        break;
      case 'weaponOverheated':
        this.addShake(FX.shake.overheat.amp, FX.shake.overheat.ms);
        break;
      case 'playerDestroyed':
        this.burst(e.x, e.y, e.dualHalf ? FX.debris.playerHalf : FX.debris.player);
        this.burst(e.x, e.y, FX.debris.smoke);
        this.ring(e.x, e.y, FX.ring.player);
        if (!e.dualHalf) this.flash(FX.flash.player);
        this.addShake(e.dualHalf ? FX.shake.boss.amp : FX.shake.player.amp, e.dualHalf ? FX.shake.boss.ms : FX.shake.player.ms);
        break;
      case 'attackLaunched':
        for (const id of e.ids) {
          const en = findEnemy(world, id);
          if (!en) continue;
          this.marks.set(id, this.clockMs + FX.launchMarkMs);
          this.ring(en.x, en.y, FX.ring.launch);
        }
        break;
      case 'enemyArrived':
        this.marks.set(e.id, this.clockMs + FX.arrival.markMs);
        if (!this.reducedMotion) this.sparkle(this.trails, e.x, e.y - 2, FX.arrival.sparkles, ['fx.white', 'star.bright'], 18, 220);
        break;
      case 'beamStarted':
        this.addEmitter({ kind: 'beam', targetId: e.captorId, age: 0, ms: FX.beamSparkle.maxMs, acc: 0 });
        break;
      case 'beamEnded':
        this.emitters = this.emitters.filter((m) => !(m.kind === 'beam' && m.targetId === e.captorId));
        break;
      case 'fighterTractored': {
        const p = world.player;
        this.sparkle(this.debris, p.x, p.y, 8, ['beam.light', 'fx.white'], 30, 300);
        break;
      }
      case 'fighterCaptured': {
        const captive = world.enemies.find((x) => x.kind === 'capturedFighter' && x.fighterId === e.fighterId);
        if (captive) this.ring(captive.x, captive.y, FX.ring.capture);
        this.flash(FX.flash.capture);
        break;
      }
      case 'captiveFreed': {
        const captive = world.enemies.find((x) => x.kind === 'capturedFighter' && x.fighterId === e.fighterId && x.state !== 'destroyed');
        if (!captive) break;
        this.ring(captive.x, captive.y, FX.ring.freed);
        this.addEmitter({ kind: 'rescue', targetId: captive.id, age: 0, ms: FX.rescueTrail.maxMs, acc: 0 });
        break;
      }
      case 'dualFighterFormed': {
        const p = world.player;
        this.ring(p.x, p.y, FX.ring.dual);
        this.sparkle(this.debris, p.x, p.y, 20, ['fx.cyan', 'fx.rescue', 'fx.white'], 90, 520);
        this.flash(FX.flash.dual);
        this.emitters = this.emitters.filter((m) => m.kind !== 'rescue');
        break;
      }
      case 'captiveHostile':
        this.ring(e.x, e.y, FX.ring.hostile);
        break;
      case 'transformSplit':
        this.ring(e.x, e.y, FX.ring.split);
        this.sparkle(this.debris, e.x, e.y, 10, ['fx.yellow', 'fx.white'], 70, 300);
        break;
      case 'playerRespawned':
        this.materialize(e.x, e.y);
        break;
      case 'stageCleared':
        if (world.stageKind === 'normal') this.celebrate(FX.celebration.stageClear);
        break;
      case 'phaseChanged':
        if (e.to === 'title' || e.to === 'restarting') this.clear();
        break;
      default:
        break;
    }
  }

  handleRewardEvent(e: RewardEvent): void {
    switch (e.type) {
      case 'pointsAwarded':
        if (e.position) this.lastKill = { x: e.position.x, y: e.position.y };
        if ((e.source === 'enemy' || e.source === 'capturedFighter') && e.position && e.amount >= HUD_LAYOUT.popupMinPoints) {
          const big = e.amount >= FX.popup.bigFrom;
          this.popups.push({
            x: e.position.x,
            y: e.position.y - 12,
            text: String(e.amount),
            color: big ? COLORS['fx.yellow'] : COLORS['ui.highlight'],
            size: big ? 2 : 1,
            ms: FX.popup.ms,
            age: 0,
            rise: this.reducedMotion ? 0 : FX.popup.risePx,
          });
        }
        break;
      case 'extraLifeAwarded':
        // near the reserve icons (bottom-left band)
        this.sparkle(this.debris, 40, 560, FX.celebration.extraLife.count, FX.celebration.extraLife.colors, 70, 600);
        break;
      case 'transformGroupCleared':
      case 'challengeWaveCleared':
        this.sparkle(this.debris, this.lastKill.x, this.lastKill.y, FX.celebration.bonus.count, FX.celebration.bonus.colors, 80, 420);
        break;
      case 'challengeStageResult':
        if (e.perfect) {
          this.celebrate(FX.celebration.perfect);
          this.flash(FX.flash.perfect);
        }
        break;
      default:
        break;
    }
  }

  /* ---------------------------------- update ---------------------------------- */

  update(dtMs: number, world: ReadWorld): void {
    if (dtMs <= 0) return;
    this.clockMs += dtMs;
    this.trails.update(dtMs);
    this.debris.update(dtMs);
    this.rings.update(dtMs);
    this.flashes.update(dtMs);
    this.popups.update(dtMs);
    this.shake.update(dtMs);
    this.marks.prune(this.clockMs);
    this.shakeNow = this.reducedMotion ? { x: 0, y: 0 } : this.shake.offset(() => this.rng.next());

    // scheduled celebration bursts
    if (this.scheduled.length > 0) {
      const due = this.scheduled.filter((s) => s.atMs <= this.clockMs);
      if (due.length > 0) {
        this.scheduled = this.scheduled.filter((s) => s.atMs > this.clockMs);
        for (const s of due) this.sparkle(this.debris, s.x, s.y, s.count, s.colors, 110, 700, 40);
      }
    }

    // emitters follow their target; they end with it or at their max duration
    const keep: Emitter[] = [];
    for (const m of this.emitters) {
      m.age += dtMs;
      const target = findEnemy(world, m.targetId);
      if (!target || m.age >= m.ms || (m.kind === 'beam' && !target.beam)) continue;
      const interval = m.kind === 'rescue' ? FX.rescueTrail.intervalMs : FX.beamSparkle.intervalMs;
      m.acc += dtMs;
      while (m.acc >= interval) {
        m.acc -= interval;
        if (m.kind === 'rescue') this.sparkle(this.debris, target.x + this.rng.range(-5, 5), target.y + 8, 1, ['fx.rescue', 'fx.white'], 12, FX.rescueTrail.lifeMs);
        else this.sparkle(this.debris, target.x + this.rng.range(-6, 6), target.y + 13, 1, ['beam.light', 'commander.emitter.core'], 16, FX.beamSparkle.lifeMs);
      }
      keep.push(m);
    }
    this.emitters = keep;

    // motion trails behind entering / diving enemies
    if (!this.reducedMotion) {
      this.trailAcc += dtMs;
      while (this.trailAcc >= FX.trail.intervalMs) {
        this.trailAcc -= FX.trail.intervalMs;
        for (const en of world.enemies) {
          const share = en.state === 'entering' ? FX.trail.entering : en.state === 'attacking' && !en.beam ? FX.trail.attacking : 0;
          if (share === 0 || this.rng.next() >= share) continue;
          if (en.kind === 'capturedFighter' && en.captiveMode === 'attached') continue;
          const hx = en.dirX;
          const hy = en.dirY;
          this.trails.spawn({
            x: en.x - hx * FX.trail.offsetPx + this.rng.range(-1, 1),
            y: en.y - hy * FX.trail.offsetPx + this.rng.range(-1, 1),
            vx: -hx * 12,
            vy: -hy * 12,
            lifeMs: FX.trail.lifeMs,
            size: 1,
            color: COLORS[TRAIL_ROLE[en.kind]],
            drag: 0.5,
          });
        }
      }
    } else this.trailAcc = 0;
  }

  /* ----------------------------------- reads ---------------------------------- */

  /** True while an enemy should be drawn with its white flash variant. */
  enemyFlash(id: string): boolean {
    return this.marks.active(id, this.clockMs);
  }

  /** Whole-art-pixel shake offset for this frame. */
  shakeOffset(): { readonly x: number; readonly y: number } {
    return this.shakeNow;
  }

  /** Nothing is animating (lets the shell skip redraws). */
  get idle(): boolean {
    return (
      this.trails.active + this.debris.active + this.rings.size + this.flashes.size + this.popups.size + this.emitters.length + this.scheduled.length === 0 &&
      this.shake.amplitude === 0
    );
  }

  stats(): FxStats {
    return {
      trails: this.trails.active,
      debris: this.debris.active,
      rings: this.rings.size,
      flashes: this.flashes.size,
      popups: this.popups.size,
      emitters: this.emitters.length,
      scheduled: this.scheduled.length,
      marks: this.marks.size,
      dropped: this.trails.dropped + this.debris.dropped,
    };
  }

  clear(): void {
    this.trails.clear();
    this.debris.clear();
    this.rings.clear();
    this.flashes.clear();
    this.popups.clear();
    this.shake.reset();
    this.marks.clear();
    this.emitters = [];
    this.scheduled = [];
    this.shakeNow = { x: 0, y: 0 };
  }

  /* ----------------------------------- draw ----------------------------------- */

  /** Under ships: trails and twinkles. */
  drawUnder(ctx: CanvasRenderingContext2D, v: Viewport): void {
    this.trails.draw(ctx, v, this.shakeNow.x, this.shakeNow.y);
  }

  /** Over ships, under projectiles: debris, rings, pop-ups. */
  drawOver(ctx: CanvasRenderingContext2D, v: Viewport): void {
    const { x, y } = this.shakeNow;
    for (const r of this.rings.items) drawRing(ctx, v, r, x, y);
    this.debris.draw(ctx, v, x, y);
    for (const p of this.popups.items) drawPopup(ctx, v, p, FX.popup.holdShare, x, y);
  }

  /** Full-field colour flash (the renderer decides its layer). */
  drawFlash(ctx: CanvasRenderingContext2D, v: Viewport): void {
    for (const f of this.flashes.items) drawFlash(ctx, v, f);
  }

  /* --------------------------------- helpers ---------------------------------- */

  private scaled(n: number): number {
    return this.reducedMotion ? Math.max(1, Math.round(n * FX.reducedMotionScale)) : n;
  }

  private burst(x: number, y: number, r: DebrisRecipe): void {
    const n = this.scaled(r.count);
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const s = this.rng.range(r.speed[0], r.speed[1]);
      this.debris.spawn({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        lifeMs: this.rng.range(r.lifeMs[0], r.lifeMs[1]),
        size: this.rng.int(r.size[0], r.size[1]),
        color: COLORS[r.colors[i % r.colors.length]!],
        drag: r.drag,
      });
    }
  }

  private sparkle(pool: ParticlePool, x: number, y: number, count: number, colors: readonly ColorRole[], speed: number, lifeMs: number, gravity = 0): void {
    const n = this.scaled(count);
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const s = this.rng.range(speed * 0.3, speed);
      pool.spawn({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, lifeMs: this.rng.range(lifeMs * 0.6, lifeMs), size: 1, color: COLORS[colors[i % colors.length]!], drag: 0.8, gravity });
    }
  }

  private ring(x: number, y: number, r: RingRecipe): void {
    this.rings.push({ x, y, r0: r.r0, r1: r.r1, ms: r.ms, age: 0, color: COLORS[r.color] });
  }

  private flash(f: FlashRecipe): void {
    // reduced motion keeps flashes but halves them (no strobing)
    this.flashes.push({ alpha: this.reducedMotion ? f.alpha / 2 : f.alpha, ms: f.ms, age: 0, color: COLORS[f.color] });
  }

  private addShake(amp: number, ms: number): void {
    if (!this.reducedMotion) this.shake.add(amp, ms);
  }

  private addEmitter(m: Emitter): void {
    this.emitters = this.emitters.filter((o) => !(o.kind === m.kind && o.targetId === m.targetId));
    if (this.emitters.length >= FX.caps.emitters) this.emitters.shift();
    this.emitters.push(m);
  }

  private materialize(x: number, y: number): void {
    this.ring(x, y, FX.ring.respawn);
    const n = this.scaled(FX.respawn.count);
    const life = FX.respawn.lifeMs;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = FX.respawn.radius;
      // particles start on a circle and converge on the ship
      this.debris.spawn({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, vx: (-Math.cos(a) * r * 1000) / life, vy: (-Math.sin(a) * r * 1000) / life, lifeMs: life, size: 1, color: COLORS[i % 2 ? 'player.trim' : 'fx.white'] });
    }
  }

  private celebrate(c: { bursts: number; spanMs: number; count: number; colors: readonly ColorRole[] }): void {
    for (let i = 0; i < c.bursts; i++) {
      if (this.scheduled.length >= FX.caps.scheduled) break;
      this.scheduled.push({
        atMs: this.clockMs + (c.bursts > 1 ? (i * c.spanMs) / (c.bursts - 1) : 0),
        x: this.rng.range(90, 358),
        y: this.rng.range(110, 260),
        count: c.count,
        colors: c.colors,
      });
    }
  }
}

function findEnemy(world: ReadWorld, id: string): Readonly<Enemy> | undefined {
  for (const e of world.enemies) if (e.id === id && e.state !== 'destroyed') return e;
  return undefined;
}
