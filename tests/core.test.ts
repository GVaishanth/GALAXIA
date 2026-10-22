import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng.ts';
import { FixedStepClock } from '../src/core/clock.ts';
import { fitViewport } from '../src/render/viewport.ts';
import { frameIndexAt, oneShotFrameAt } from '../src/render/sprite/animation.ts';
import { SPRITES } from '../src/assets/sprites/index.ts';
import { GLYPHS, GLYPH_HEIGHT, GLYPH_WIDTH, textWidth } from '../src/assets/fonts/pixelFont.ts';
import { PLAYFIELD_ART } from '../src/config/visual.ts';

describe('rng', () => {
  it('is deterministic per seed and within range', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(seqA);
    expect(seqA.every((n) => n >= 0 && n < 1)).toBe(true);
    const r = createRng(1);
    for (let i = 0; i < 200; i++) {
      const n = r.int(3, 5);
      expect(n >= 3 && n <= 5 && Number.isInteger(n)).toBe(true);
    }
    expect(createRng(43).next()).not.toBe(createRng(42).next());
  });
});

describe('FixedStepClock', () => {
  it('runs a fixed number of ticks regardless of frame pacing', () => {
    const run = (frameMs: number) => {
      const clock = new FixedStepClock({ hz: 60 });
      let ticks = 0;
      for (let t = 0; t <= 1000; t += frameMs) clock.advance(t, () => ticks++);
      return ticks;
    };
    expect(run(1000 / 60)).toBeGreaterThanOrEqual(59);
    expect(run(1000 / 60)).toBeLessThanOrEqual(60);
    expect(Math.abs(run(1000 / 144) - run(1000 / 30))).toBeLessThanOrEqual(2);
  });

  it('clamps long stalls', () => {
    const clock = new FixedStepClock({ hz: 50, maxFrameMs: 100 });
    let ticks = 0;
    clock.advance(0, () => ticks++);
    clock.advance(5000, () => ticks++);
    expect(ticks).toBe(5); // 100 ms clamp / 20 ms step
  });
});

describe('viewport', () => {
  it('preserves aspect ratio and centres the playfield', () => {
    const v = fitViewport(1000, 576);
    expect(v.scale).toBe(1);
    expect(v.offsetX).toBe(Math.floor((1000 - PLAYFIELD_ART.width) / 2));
    expect(v.offsetY).toBe(0);
    const tall = fitViewport(448, 2000);
    expect(tall.scale).toBe(1);
    expect(tall.offsetY).toBeGreaterThan(0);
  });

  it('snaps to integer scale in pixel-perfect mode and honours maxScale', () => {
    expect(fitViewport(1100, 1400, { integerScale: true }).scale).toBe(2);
    expect(fitViewport(1100, 1400).scale).toBeCloseTo(Math.min(1100 / 448, 1400 / 576));
    expect(fitViewport(4000, 4000, { artWidth: 10, artHeight: 10, maxScale: 6, integerScale: true }).scale).toBe(6);
  });
});

describe('animation helpers', () => {
  it('loops frame indices using the state frame duration', () => {
    const def = SPRITES['enemy.scout'];
    expect(frameIndexAt(def, 'formation', 0)).toBe(0);
    expect(frameIndexAt(def, 'formation', def.frameMs.formation)).toBe(1);
    expect(frameIndexAt(def, 'formation', def.frameMs.formation * 2)).toBe(0);
    expect(frameIndexAt(def, 'attack', 99999)).toBe(0);
  });

  it('ends one-shot animations', () => {
    const def = SPRITES['fx.explosion.enemy'];
    expect(oneShotFrameAt(def, 'burst', 0)).toBe(0);
    expect(oneShotFrameAt(def, 'burst', def.frameMs.burst * 4)).toBe(-1);
  });
});

describe('pixel font', () => {
  it('defines every glyph on a 5x7 grid', () => {
    for (const [ch, rows] of Object.entries(GLYPHS)) {
      expect(rows.length, ch).toBe(GLYPH_HEIGHT);
      for (const r of rows) expect(r.length, ch).toBe(GLYPH_WIDTH);
    }
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') expect(GLYPHS).toHaveProperty([ch]);
    expect(textWidth('AB')).toBe(11);
  });
});
