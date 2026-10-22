/**
 * Fixed-capacity particle pool (structure of arrays). Allocation happens once
 * in the constructor; spawning past capacity is refused and counted, so a
 * burst of explosions can never grow memory or frame cost without bound.
 *
 * Particles are drawn as whole-art-pixel squares (1 or 2 px) snapped to the
 * art grid, so they read as pixel art rather than soft glow.
 */
import type { Viewport } from '../viewport.ts';

export interface ParticleSpec {
  x: number;
  y: number;
  vx: number;
  vy: number;
  lifeMs: number;
  size: number;
  color: string;
  /** Velocity damping per second (0..1). */
  drag?: number;
  /** Downward acceleration (art px/s^2). */
  gravity?: number;
}

export class ParticlePool {
  readonly capacity: number;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Uint8Array;
  private readonly drag: Float32Array;
  private readonly gravity: Float32Array;
  private readonly color: string[];
  private count = 0;
  /** Spawn requests refused because the pool was full (diagnostics). */
  dropped = 0;
  /** Total particles ever spawned (diagnostics). */
  spawned = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
    const n = this.capacity;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size = new Uint8Array(n);
    this.drag = new Float32Array(n);
    this.gravity = new Float32Array(n);
    this.color = new Array<string>(n).fill('#ffffff');
  }

  get active(): number {
    return this.count;
  }

  spawn(p: ParticleSpec): boolean {
    if (this.count >= this.capacity || !(p.lifeMs > 0)) {
      this.dropped += 1;
      return false;
    }
    const i = this.count++;
    this.x[i] = p.x;
    this.y[i] = p.y;
    this.vx[i] = p.vx;
    this.vy[i] = p.vy;
    this.age[i] = 0;
    this.life[i] = p.lifeMs;
    this.size[i] = Math.max(1, Math.min(4, Math.round(p.size)));
    this.drag[i] = p.drag ?? 0;
    this.gravity[i] = p.gravity ?? 0;
    this.color[i] = p.color;
    this.spawned += 1;
    return true;
  }

  /** Advance and recycle expired particles (swap-remove, O(active)). */
  update(dtMs: number): void {
    if (dtMs <= 0) return;
    const dt = dtMs / 1000;
    let i = 0;
    while (i < this.count) {
      const age = this.age[i]! + dtMs;
      if (age >= this.life[i]!) {
        this.removeAt(i);
        continue;
      }
      this.age[i] = age;
      const damp = Math.max(0, 1 - this.drag[i]! * dt);
      this.vx[i] = this.vx[i]! * damp;
      this.vy[i] = this.vy[i]! * damp + this.gravity[i]! * dt;
      this.x[i] = this.x[i]! + this.vx[i]! * dt;
      this.y[i] = this.y[i]! + this.vy[i]! * dt;
      i++;
    }
  }

  clear(): void {
    this.count = 0;
  }

  /**
   * Draw all particles. Alpha fades over the last 40 % of life in 3 steps
   * (stepped, not smooth, to keep the arcade look).
   */
  draw(ctx: CanvasRenderingContext2D, v: Viewport, ox = 0, oy = 0): void {
    if (this.count === 0) return;
    const prevAlpha = ctx.globalAlpha;
    for (let i = 0; i < this.count; i++) {
      const k = this.age[i]! / this.life[i]!;
      const a = k < 0.6 ? 1 : k < 0.75 ? 0.7 : k < 0.9 ? 0.45 : 0.2;
      const s = this.size[i]!;
      const ax = Math.round(this.x[i]! - s / 2) + ox;
      const ay = Math.round(this.y[i]! - s / 2) + oy;
      ctx.globalAlpha = prevAlpha * a;
      ctx.fillStyle = this.color[i]!;
      ctx.fillRect(Math.round(v.offsetX + ax * v.scale), Math.round(v.offsetY + ay * v.scale), Math.max(1, Math.round(s * v.scale)), Math.max(1, Math.round(s * v.scale)));
    }
    ctx.globalAlpha = prevAlpha;
  }

  /** Oldest remaining age ratio (tests / diagnostics). */
  maxAgeRatio(): number {
    let m = 0;
    for (let i = 0; i < this.count; i++) m = Math.max(m, this.age[i]! / this.life[i]!);
    return m;
  }

  private removeAt(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.x[i] = this.x[last]!;
    this.y[i] = this.y[last]!;
    this.vx[i] = this.vx[last]!;
    this.vy[i] = this.vy[last]!;
    this.age[i] = this.age[last]!;
    this.life[i] = this.life[last]!;
    this.size[i] = this.size[last]!;
    this.drag[i] = this.drag[last]!;
    this.gravity[i] = this.gravity[last]!;
    this.color[i] = this.color[last]!;
  }
}
