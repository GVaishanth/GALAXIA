/**
 * Margin field (TD-76): the dimmed stars / nebula outside the arena and the
 * arena edge. Headless: a recording 2D context, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { BACKDROP } from '../src/config/presentation.ts';
import { PLAYFIELD_ART } from '../src/config/visual.ts';
import { marginSides, marginTiles, SpaceBackdrop, tileShift } from '../src/render/backdrop.ts';
import { drawArenaEdge } from '../src/render/gameRenderer.ts';
import type { CanvasLike } from '../src/render/sprite/spriteCache.ts';
import { fitViewport, type Viewport } from '../src/render/viewport.ts';

interface Rect { x: number; y: number; w: number; h: number }
interface Op { kind: 'fill' | 'clip' | 'image'; r: Rect; alpha: number; style: string }

function recorder(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  let pending: Rect | null = null;
  const st: Record<string | symbol, unknown> = {
    globalAlpha: 1,
    fillStyle: '#000',
    imageSmoothingEnabled: true,
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => { pending = null; },
    rect: (x: number, y: number, w: number, h: number) => { pending = { x, y, w, h }; },
    clip: () => { if (pending) ops.push({ kind: 'clip', r: pending, alpha: st.globalAlpha as number, style: '' }); },
    fillRect: (x: number, y: number, w: number, h: number) => ops.push({ kind: 'fill', r: { x, y, w, h }, alpha: st.globalAlpha as number, style: String(st.fillStyle) }),
    drawImage: (_i: unknown, x: number, y: number, w: number, h: number) => ops.push({ kind: 'image', r: { x, y, w, h }, alpha: st.globalAlpha as number, style: '' }),
  };
  const ctx = new Proxy(st, { get: (t, k) => (k in t ? t[k] : () => undefined), set: (t, k, v) => { t[k] = v; return true; } }) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}
const fakeCanvas = (width: number, height: number): CanvasLike => ({ width, height, getContext: () => recorder().ctx }) as unknown as CanvasLike;

const arenaRect = (v: Viewport): Rect => ({ x: v.offsetX, y: v.offsetY, w: Math.ceil(v.artWidth * v.scale), h: Math.ceil(v.artHeight * v.scale) });
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const desktop = fitViewport(1920, 1080); // pillarboxed: margins left and right
const portrait = fitViewport(1170, 2532); // letterboxed: margins above and below
const exact = fitViewport(PLAYFIELD_ART.width * 2, PLAYFIELD_ART.height * 2); // the arena fills the canvas

describe('margin tiles', () => {
  it('cover the margins with arena-sized tiles, never the arena itself', () => {
    expect(marginTiles(exact, 16)).toEqual([]);
    expect(marginTiles(desktop, 16)).toEqual([{ i: -1, j: 0 }, { i: 1, j: 0 }]);
    expect(marginTiles(portrait, 16)).toEqual([{ i: 0, j: -1 }, { i: 0, j: 1 }]);
    const wide = fitViewport(3440, 1440);
    const t = marginTiles(wide, 16);
    expect(t.map((x) => x.i).sort((a, b) => a - b)).toEqual([-2, -1, 1, 2]);
    // every device pixel left / right of the arena is inside some tile
    const tw = wide.artWidth * wide.scale;
    expect(wide.offsetX + Math.min(...t.map((x) => x.i)) * tw).toBeLessThanOrEqual(0);
    expect(wide.offsetX + (Math.max(...t.map((x) => x.i)) + 1) * tw).toBeGreaterThanOrEqual(wide.deviceWidth);
  });

  it('are capped, nearest first, so a pathological canvas cannot multiply the work', () => {
    const silly = fitViewport(20000, 600);
    const t = marginTiles(silly, BACKDROP.margin.maxTiles);
    expect(t).toHaveLength(BACKDROP.margin.maxTiles);
    expect(t.slice(0, 2).map((x) => Math.abs(x.i))).toEqual([1, 1]);
    expect(t.every((x) => x.i !== 0 || x.j !== 0)).toBe(true);
  });

  it('shift each tile differently (left and right margins never mirror each other)', () => {
    const s = [tileShift(-1, 0), tileShift(1, 0), tileShift(0, -1), tileShift(0, 1), tileShift(-2, 0), tileShift(2, 0)];
    for (const v of s) expect(v >= 0 && v < 1).toBe(true);
    expect(new Set(s.map((v) => v.toFixed(3))).size).toBe(s.length);
    expect(tileShift(1, 0)).toBe(tileShift(1, 0)); // stable: no flicker between frames
  });
});

describe('margin field drawing', () => {
  it('draws nothing when the arena fills the canvas', () => {
    const b = new SpaceBackdrop(fakeCanvas, 3);
    const { ctx, ops } = recorder();
    expect(b.drawMargins(ctx, exact)).toBe(0);
    expect(ops).toHaveLength(0);
  });

  it('stays outside the arena, dimmed, with stars and nebula but no planet or comet', () => {
    for (const v of [desktop, portrait]) {
      const b = new SpaceBackdrop(fakeCanvas, 3);
      b.update(400, 0);
      const { ctx, ops } = recorder();
      expect(b.drawMargins(ctx, v)).toBe(2);
      const clips = ops.filter((o) => o.kind === 'clip');
      expect(clips).toHaveLength(2);
      for (const c of clips) expect(overlaps(c.r, arenaRect(v))).toBe(false);
      const stars = ops.filter((o) => o.kind === 'fill');
      expect(stars.length).toBeGreaterThan(50);
      expect(stars.length).toBeLessThanOrEqual(2 * b.starCount);
      for (const s of stars) expect(s.alpha).toBeCloseTo(BACKDROP.margin.alpha, 6);
      const images = ops.filter((o) => o.kind === 'image');
      expect(images).toHaveLength(4); // nebula only (2 per tile for the vertical wrap): no planet
      for (const im of images) expect(im.alpha).toBeCloseTo(BACKDROP.margin.alpha * BACKDROP.nebula.alpha, 6);
      // left / right (or top / bottom) tiles are not copies of each other
      const sig = (c: Op): string => stars.filter((s) => s.r.x >= c.r.x && s.r.x < c.r.x + c.r.w && s.r.y >= c.r.y && s.r.y < c.r.y + c.r.h).map((s) => `${Math.round(s.r.x - c.r.x)},${Math.round(s.r.y - c.r.y)}`).sort().join(' ');
      expect(sig(clips[0]!)).not.toBe(sig(clips[1]!));
    }
  });

  it('never changes the arena backdrop (same output with or without margins; restores alpha)', () => {
    const a = new SpaceBackdrop(fakeCanvas, 3);
    const b = new SpaceBackdrop(fakeCanvas, 3);
    a.update(1234, 0.3);
    b.update(1234, 0.3);
    const ra = recorder();
    a.draw(ra.ctx, desktop);
    const rb = recorder();
    b.drawMargins(rb.ctx, desktop);
    expect((rb.ctx as unknown as { globalAlpha: number }).globalAlpha).toBe(1);
    const before = rb.ops.length;
    b.draw(rb.ctx, desktop);
    expect(JSON.stringify(rb.ops.slice(before))).toBe(JSON.stringify(ra.ops));
  });
});

describe('arena edge', () => {
  it('one art pixel just outside the arena, only on sides that have a margin', () => {
    expect(marginSides(exact)).toEqual({ left: false, right: false, top: false, bottom: false });
    expect(marginSides(desktop)).toEqual({ left: true, right: true, top: false, bottom: false });
    expect(marginSides(portrait)).toEqual({ left: false, right: false, top: true, bottom: true });

    const none = recorder();
    drawArenaEdge(none.ctx, exact);
    expect(none.ops).toHaveLength(0);

    for (const v of [desktop, portrait]) {
      const { ctx, ops } = recorder();
      drawArenaEdge(ctx, v);
      expect(ops).toHaveLength(2);
      const px = Math.max(1, Math.round(v.scale));
      const a = arenaRect(v);
      for (const o of ops) {
        expect(o.style).toBe('#2b3766');
        expect(o.alpha).toBeCloseTo(BACKDROP.margin.edgeAlpha, 6);
        expect(overlaps(o.r, a)).toBe(false);
        expect(Math.min(o.r.w, o.r.h)).toBe(px);
        // touching the arena: the rule sits flush against one of its sides
        const flush = o.r.x + o.r.w === a.x || o.r.x === a.x + a.w || o.r.y + o.r.h === a.y || o.r.y === a.y + a.h;
        expect(flush).toBe(true);
      }
    }
  });
});
