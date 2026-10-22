/** Title-screen starfield (FR-TD-81): pure, headless. */
import { describe, expect, it } from 'vitest';
import { hash01, TITLE_STARS, TitleStarfield, type StarContext } from '../src/shared/rendering/titleStarfield.ts';

function rec(): StarContext & { rects: { x: number; y: number; w: number; h: number; c: string }[] } {
  const r = { fillStyle: '' as StarContext['fillStyle'], rects: [] as { x: number; y: number; w: number; h: number; c: string }[], fillRect(x: number, y: number, w: number, h: number) { r.rects.push({ x, y, w, h, c: String(r.fillStyle) }); } };
  return r;
}
const stars = (r: ReturnType<typeof rec>) => r.rects.slice(1); // [0] is the void

describe('title starfield', () => {
  it('is seeded: the same seed paints the same sky, another seed a different one', () => {
    const paint = (seed: number) => { const f = new TitleStarfield(seed); f.resize(480, 270); const r = rec(); f.draw(r); return JSON.stringify(r.rects); };
    expect(paint(7)).toBe(paint(7));
    expect(paint(7)).not.toBe(paint(8));
    for (let i = 0; i < 200; i++) { const h = hash01(i, -i * 3, 11); expect(h >= 0 && h < 1).toBe(true); }
  });

  it('fills the screen with one-pixel stars inside the canvas, at a density like the old static sky', () => {
    const f = new TitleStarfield();
    f.resize(960, 540);
    const r = rec();
    expect(f.draw(r)).toBe(true);
    expect(r.rects[0]).toMatchObject({ x: 0, y: 0, w: 960, h: 540 });
    const s = stars(r);
    expect(s.length).toBeGreaterThan(400);
    expect(s.length).toBeLessThan(900);
    for (const p of s) expect(p.x >= 0 && p.y >= 0 && p.x < 960 && p.y < 540 && p.w === 1 && p.h === 1).toBe(true);
  });

  it('cruises: layers move at their parallax depths (near stars faster than far ones)', () => {
    const f = new TitleStarfield();
    f.resize(400, 300);
    const before = TITLE_STARS.layers.map((_, i) => f.layerOffset(i));
    for (let i = 0; i < 600; i++) f.step(1000 / 60); // 10 s
    const moved = TITLE_STARS.layers.map((_, i) => { const a = f.layerOffset(i); return Math.hypot(a.x - before[i]!.x, a.y - before[i]!.y); });
    expect(moved[0]!).toBeGreaterThan(10);
    expect(moved[1]!).toBeGreaterThan(moved[0]!);
    expect(moved[2]!).toBeGreaterThan(moved[1]!);
    // about speed x factor x 10 s (the heading sways, so allow some slack)
    expect(moved[2]!).toBeCloseTo(TITLE_STARS.cruise.speed * 0.75 * 10, -1);
  });

  it('repaints only when a layer moved by a whole pixel; a resize forces a repaint', () => {
    const f = new TitleStarfield();
    f.resize(400, 300);
    expect(f.draw(rec())).toBe(true);
    expect(f.draw(rec())).toBe(false); // nothing moved
    let painted = 0;
    for (let i = 0; i < 120; i++) { f.step(1000 / 60); if (f.draw(rec())) painted++; }
    expect(painted).toBeGreaterThan(5);
    expect(painted).toBeLessThan(60); // most 60 Hz frames are skipped at cruising speed
    expect(f.resize(400, 300)).toBe(false);
    expect(f.resize(500, 300)).toBe(true);
    expect(f.draw(rec())).toBe(true);
    expect(f.paints).toBe(2 + painted);
  });

  it('leans towards the pointer (clamped), eases, and returns to centre when released', () => {
    const f = new TitleStarfield();
    f.resize(400, 300);
    const near = TITLE_STARS.layers.length - 1;
    const o0 = f.layerOffset(near);
    f.look(5, -3); // out of range -> clamped to the corner
    for (let i = 0; i < 6; i++) f.step(1000 / 60);
    const early = f.layerOffset(near);
    for (let i = 0; i < 120; i++) f.step(1000 / 60);
    const late = f.layerOffset(near);
    const cruise = TITLE_STARS.cruise.speed * 0.75 * 2.1; // the cruise also moved during these 2.1 s
    expect(late.x - o0.x).toBeGreaterThan(TITLE_STARS.parallax.maxPx * 0.75 * 0.9 - cruise);
    expect(late.x - o0.x).toBeLessThanOrEqual(Math.ceil(TITLE_STARS.parallax.maxPx * 0.75 + cruise));
    expect(Math.abs(early.x - o0.x)).toBeLessThan(Math.abs(late.x - o0.x)); // eased, not snapped
    f.look(null);
    const g = new TitleStarfield(); // the same cruise without any look-around
    g.resize(400, 300);
    for (let i = 0; i < 126 + 240; i++) g.step(1000 / 60);
    for (let i = 0; i < 240; i++) f.step(1000 / 60);
    expect(Math.abs(f.layerOffset(near).x - g.layerOffset(near).x)).toBeLessThanOrEqual(1);
    f.look(Number.NaN, 0.5); // garbage -> centre, never NaN offsets
    f.step(16);
    expect(Number.isFinite(f.layerOffset(near).x)).toBe(true);
  });

  it('a long gap (background tab) is clamped: the sky never jumps', () => {
    const a = new TitleStarfield();
    const b = new TitleStarfield();
    a.step(60_000);
    b.step(TITLE_STARS.maxStepMs);
    expect(a.layerOffset(2)).toEqual(b.layerOffset(2));
    a.step(-50); // clocks going backwards are ignored
    expect(a.layerOffset(2)).toEqual(b.layerOffset(2));
  });
});
