/**
 * Timed effect primitives: rings, screen flashes, score pop-ups, screen shake
 * and short sprite highlight "marks". Each list has a fixed cap (oldest entry
 * is dropped first) and every entry has a duration, so nothing outlives its
 * purpose. Pure data plus Canvas drawing; no DOM elements are created.
 */
import { drawPixelText } from '../text.ts';
import type { Viewport } from '../viewport.ts';

export interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  ms: number;
  age: number;
  color: string;
}

export interface Flash {
  ms: number;
  age: number;
  alpha: number;
  color: string;
}

export interface Popup {
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  ms: number;
  age: number;
  rise: number;
}

/** Fixed-capacity list: pushing past capacity evicts the oldest entry. */
export class BoundedList<T extends { age: number; ms: number }> {
  readonly items: T[] = [];
  evicted = 0;
  readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    if (this.items.length >= this.capacity) {
      this.items.shift();
      this.evicted += 1;
    }
    this.items.push(item);
  }

  update(dtMs: number): void {
    let w = 0;
    for (const it of this.items) {
      it.age += dtMs;
      if (it.age < it.ms) this.items[w++] = it;
    }
    this.items.length = w;
  }

  clear(): void {
    this.items.length = 0;
  }

  get size(): number {
    return this.items.length;
  }
}

/** Stepped fade used by every effect (keeps the arcade look). */
export function steppedFade(k: number): number {
  return k < 0.5 ? 1 : k < 0.7 ? 0.75 : k < 0.85 ? 0.5 : 0.25;
}

/** Pixel circle outline: 1-art-px squares on the circumference. */
export function drawRing(ctx: CanvasRenderingContext2D, v: Viewport, r: Ring, ox = 0, oy = 0): void {
  const k = Math.min(1, r.age / r.ms);
  const radius = r.r0 + (r.r1 - r.r0) * easeOut(k);
  if (radius < 0.5) return;
  const n = Math.min(160, Math.max(8, Math.ceil(2 * Math.PI * radius * 0.8)));
  const px = Math.max(1, Math.round(v.scale));
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * steppedFade(k);
  ctx.fillStyle = r.color;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ax = Math.round(r.x + Math.cos(a) * radius) + ox;
    const ay = Math.round(r.y + Math.sin(a) * radius) + oy;
    ctx.fillRect(Math.round(v.offsetX + ax * v.scale), Math.round(v.offsetY + ay * v.scale), px, px);
  }
  ctx.globalAlpha = prev;
}

function easeOut(k: number): number {
  return 1 - (1 - k) * (1 - k);
}

export function drawFlash(ctx: CanvasRenderingContext2D, v: Viewport, f: Flash): void {
  const k = Math.min(1, f.age / f.ms);
  const a = f.alpha * (1 - k);
  if (a <= 0.004) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * a;
  ctx.fillStyle = f.color;
  ctx.fillRect(v.offsetX, v.offsetY, Math.ceil(v.artWidth * v.scale), Math.ceil(v.artHeight * v.scale));
  ctx.globalAlpha = prev;
}

export function drawPopup(ctx: CanvasRenderingContext2D, v: Viewport, p: Popup, holdShare: number, ox = 0, oy = 0): void {
  const k = Math.min(1, p.age / p.ms);
  const y = p.y - p.rise * Math.min(1, k / holdShare);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * (k < holdShare ? 1 : steppedFade((k - holdShare) / (1 - holdShare)));
  // 1 px dark drop shadow keeps the number readable over busy backgrounds
  drawPixelText(ctx, v, p.text, Math.round(p.x) + ox + 1, Math.round(y) + oy + 1, '#06070f', p.size, 'center');
  drawPixelText(ctx, v, p.text, Math.round(p.x) + ox, Math.round(y) + oy, p.color, p.size, 'center');
  ctx.globalAlpha = prev;
}

/** Screen shake: whole-art-pixel offsets that decay linearly. */
export class Shake {
  private amp = 0;
  private ms = 0;
  private age = 0;

  add(amp: number, ms: number): void {
    // overlapping shakes take the stronger one (never accumulate)
    const remaining = this.ms > 0 ? this.amp * (1 - this.age / this.ms) : 0;
    if (amp >= remaining) {
      this.amp = amp;
      this.ms = ms;
      this.age = 0;
    }
  }

  update(dtMs: number): void {
    if (this.ms <= 0) return;
    this.age += dtMs;
    if (this.age >= this.ms) this.reset();
  }

  /** Current amplitude in art px (0 when idle). */
  get amplitude(): number {
    return this.ms > 0 ? this.amp * (1 - this.age / this.ms) : 0;
  }

  /** Offset for this frame; `pick` returns a value in [0,1). */
  offset(pick: () => number): { x: number; y: number } {
    const a = this.amplitude;
    if (a < 0.5) return { x: 0, y: 0 };
    return { x: Math.round((pick() * 2 - 1) * a), y: Math.round((pick() * 2 - 1) * a) };
  }

  reset(): void {
    this.amp = this.ms = this.age = 0;
  }
}

/** Short highlight windows per entity id (enemy flashes white). Bounded. */
export class Marks {
  private readonly until = new Map<string, number>();
  readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  set(id: string, untilMs: number): void {
    this.until.delete(id);
    this.until.set(id, untilMs);
    while (this.until.size > this.capacity) {
      const oldest = this.until.keys().next().value as string;
      this.until.delete(oldest);
    }
  }

  active(id: string, nowMs: number): boolean {
    const u = this.until.get(id);
    return u !== undefined && nowMs < u;
  }

  prune(nowMs: number): void {
    for (const [id, u] of this.until) if (u <= nowMs) this.until.delete(id);
  }

  clear(): void {
    this.until.clear();
  }

  get size(): number {
    return this.until.size;
  }
}
