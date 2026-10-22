import { describe, expect, it } from 'vitest';
import { COLORS, hexToRgb } from '../src/config/palette.ts';
import { SPRITES, VARIANTS, type SpriteId } from '../src/assets/sprites/index.ts';
import { expandFrame, flipVertical, joinHorizontal } from '../src/assets/sprites/format/grid.ts';
import { rasterizeFrame, resolveRole } from '../src/render/sprite/rasterize.ts';
import type { FrameSource, RgbaImage, SpriteDef } from '../src/assets/sprites/format/types.ts';

const px = (img: RgbaImage, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const rgba = (hex: string) => [...hexToRgb(hex), 255];

describe('grid helpers', () => {
  it('mirror-x expands to an odd width around the centre column', () => {
    const f = expandFrame({ rows: ['.AB', 'ABC'], symmetry: 'mirror-x' });
    expect(f.rows).toEqual(['.ABA.', 'ABCBA']);
  });

  it('mirror-xy expands both ways', () => {
    const f = expandFrame({ rows: ['A.', '.B'], symmetry: 'mirror-xy' });
    expect(f.rows).toEqual(['A.A', '.B.', 'A.A']);
  });

  it('rejects ragged rows with a descriptive error', () => {
    expect(() => expandFrame({ rows: ['AA', 'A'], symmetry: 'none' })).toThrow(/Row 1/);
  });

  it('joins frames bottom-aligned with a gap and flips vertically', () => {
    const a: FrameSource = { rows: ['A', 'A'], symmetry: 'none' };
    const b: FrameSource = { rows: ['B'], symmetry: 'none' };
    expect(joinHorizontal([a, b], 2).rows).toEqual(['A...', 'A..B']);
    expect(flipVertical({ rows: ['X', 'Y'], symmetry: 'none' }).rows).toEqual(['Y', 'X']);
  });
});

describe('rasterizeFrame', () => {
  const palette = { A: 'player.hull', C: 'player.cockpit' } as const;
  const frame = expandFrame({ rows: ['A'], symmetry: 'none' });

  it('pads for outline + glow and draws a 4-neighbour outline', () => {
    const r = rasterizeFrame(frame, palette, 'player.outline', undefined, { outlineWidth: 1, glowRadius: 2, glowGain: 1 });
    expect(r.pad).toBe(3);
    expect(r.sprite.width).toBe(7);
    expect(px(r.sprite, 3, 3)).toEqual(rgba(COLORS['player.hull']));
    expect(px(r.sprite, 2, 3)).toEqual(rgba(COLORS['player.outline']));
    expect(px(r.sprite, 3, 2)).toEqual(rgba(COLORS['player.outline']));
    expect(px(r.sprite, 2, 2)[3]).toBe(0); // diagonal stays empty (4-neighbour)
    expect(r.glow).toBeNull(); // hull is not emissive
  });

  it('builds a glow layer only for emissive pixels', () => {
    const r = rasterizeFrame(expandFrame({ rows: ['C'], symmetry: 'none' }), palette, null, undefined, { outlineWidth: 1, glowRadius: 2, glowGain: 1 });
    expect(r.pad).toBe(2);
    expect(r.glow).not.toBeNull();
    expect(r.glow!.data[(2 * r.glow!.width + 2) * 4 + 3]).toBeGreaterThan(0);
  });

  it('flash variant whitens the body, keeps the outline and drops glow', () => {
    const r = rasterizeFrame(expandFrame({ rows: ['C'], symmetry: 'none' }), palette, 'player.outline', VARIANTS.flash);
    const c = r.pad;
    expect(px(r.sprite, c, c)).toEqual(rgba(COLORS['fx.flash']));
    expect(px(r.sprite, c - 1, c)).toEqual(rgba(COLORS['player.outline']));
    expect(r.glow).toBeNull();
  });

  it('resolves variant roles', () => {
    expect(resolveRole('player.hull', VARIANTS.captive)).toBe('captive.hull');
    expect(resolveRole('commander.hull', VARIANTS.damaged)).toBe('commanderHit.hull');
    expect(resolveRole('commander.gold', VARIANTS.damaged)).toBe('commander.gold');
    expect(resolveRole('scout.body', VARIANTS.flash)).toBe('fx.flash');
  });

  it('rasterises every frame of every sprite in every variant (load check)', () => {
    let count = 0;
    for (const id of Object.keys(SPRITES) as SpriteId[]) {
      const def: SpriteDef = SPRITES[id];
      for (const frames of Object.values(def.states)) {
        for (const src of frames) {
          for (const v of [undefined, ...Object.values(VARIANTS)]) {
            const r = rasterizeFrame(expandFrame(src), def.palette, def.outline, v);
            expect(r.sprite.width).toBe(r.contentWidth + r.pad * 2);
            expect(r.sprite.data.some((b, i) => i % 4 === 3 && b > 0)).toBe(true);
            count++;
          }
        }
      }
    }
    expect(count).toBeGreaterThan(100);
  });

  it('is deterministic', () => {
    const src = SPRITES['enemy.commander'].states.capture[0]!;
    const a = rasterizeFrame(expandFrame(src), SPRITES['enemy.commander'].palette, 'commander.outline');
    const b = rasterizeFrame(expandFrame(src), SPRITES['enemy.commander'].palette, 'commander.outline');
    expect(Buffer.from(a.sprite.data).equals(Buffer.from(b.sprite.data))).toBe(true);
    expect(Buffer.from(a.glow!.data).equals(Buffer.from(b.glow!.data))).toBe(true);
  });
});
