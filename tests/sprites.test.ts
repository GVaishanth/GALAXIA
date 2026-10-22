import { describe, expect, it } from 'vitest';
import { COLORS, EMISSIVE_ROLES, hexToRgb, type ColorRole } from '../src/config/palette.ts';
import { LOOKS, SPRITES, VARIANTS, type SpriteId } from '../src/assets/sprites/index.ts';
import { expandFrame, isHorizontallySymmetric, unknownChars } from '../src/assets/sprites/format/grid.ts';
import type { FrameSource, SpriteDef } from '../src/assets/sprites/format/types.ts';

const entries = Object.entries(SPRITES) as [SpriteId, SpriteDef][];
const statesOf = (def: SpriteDef) => Object.entries(def.states) as [string, readonly FrameSource[]][];

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('sprite registry', () => {
  it('registers every required asset', () => {
    for (const id of [
      'player.fighter', 'player.dual', 'enemy.commander', 'enemy.interceptor', 'enemy.scout',
      'special.stinger', 'special.phantom', 'special.sovereign',
      'fx.shot.player', 'fx.shot.enemy', 'fx.beam.tractor', 'fx.explosion.enemy', 'fx.explosion.player', 'fx.hit',
    ]) {
      expect(SPRITES).toHaveProperty([id]);
    }
  });

  it('uses registry keys that match sprite ids', () => {
    for (const [key, def] of entries) expect(def.id).toBe(key);
  });

  it('covers the required states', () => {
    expect(Object.keys(SPRITES['player.fighter'].states)).toEqual(expect.arrayContaining(['idle', 'captured', 'rescued']));
    expect(Object.keys(SPRITES['enemy.commander'].states)).toEqual(expect.arrayContaining(['formation', 'attack', 'capture']));
    expect(Object.keys(SPRITES['enemy.interceptor'].states)).toEqual(expect.arrayContaining(['formation', 'attack']));
  });
});

describe.each(entries)('%s', (_id, def) => {
  it('maps every palette char to a defined colour role', () => {
    for (const role of Object.values(def.palette)) expect(COLORS).toHaveProperty([role]);
    if (def.outline) expect(COLORS).toHaveProperty([def.outline]);
    expect(Object.keys(def.palette)).not.toContain('.');
  });

  it.each(statesOf(def))('state "%s": valid, consistent frames', (_state, frames) => {
    expect(frames.length).toBeGreaterThan(0);
    const expanded = frames.map(expandFrame);
    for (const f of expanded) {
      expect(f.rows.every((r) => r.length === f.width)).toBe(true);
      expect(unknownChars(f, def.palette)).toEqual([]);
      expect(f.rows.some((r) => /[^.]/.test(r))).toBe(true);
    }
    // Frames of one state share dimensions so animation never jitters.
    expect(new Set(expanded.map((f) => `${f.width}x${f.height}`)).size).toBe(1);
  });

  it('mirrored frames are exactly symmetric', () => {
    for (const [, frames] of statesOf(def)) {
      for (const src of frames) {
        if (src.symmetry !== 'none') expect(isHorizontallySymmetric(expandFrame(src))).toBe(true);
      }
    }
  });

  it('declares a frame duration for every animated state', () => {
    for (const [state, frames] of statesOf(def)) {
      if (frames.length > 1) expect((def.frameMs as Record<string, number> | undefined)?.[state]).toBeGreaterThan(0);
    }
  });
});

describe('art direction rules', () => {
  const size = (id: SpriteId, state: string) => expandFrame((SPRITES[id].states as Record<string, readonly FrameSource[]>)[state]![0]!);
  const area = (id: SpriteId, state: string) => {
    const f = size(id, state);
    return f.rows.join('').replace(/\./g, '').length;
  };

  it('keeps the size hierarchy: commander > interceptor > scout', () => {
    expect(area('enemy.commander', 'formation')).toBeGreaterThan(area('enemy.interceptor', 'formation'));
    expect(area('enemy.interceptor', 'formation')).toBeGreaterThan(area('enemy.scout', 'formation'));
  });

  it('keeps ships within the 2 art-px-per-unit budget (<= 32 art px, i.e. 16 units)', () => {
    for (const id of ['player.fighter', 'enemy.commander', 'enemy.interceptor', 'enemy.scout', 'special.stinger', 'special.phantom', 'special.sovereign'] as const) {
      const f = size(id, Object.keys(SPRITES[id].states)[0]!);
      expect(f.width).toBeLessThanOrEqual(32);
      expect(f.height).toBeLessThanOrEqual(32);
    }
  });

  it('builds the Dual Fighter from two fighters with a visible gap', () => {
    const single = size('player.fighter', 'idle');
    const dual = size('player.dual', 'idle');
    expect(dual.width).toBe(single.width * 2 + 3);
    expect(dual.height).toBe(single.height);
    // The gap columns are empty, so both ships keep separate silhouettes.
    for (const row of dual.rows) expect(row.slice(single.width, single.width + 3)).toBe('...');
  });

  it('never shares a colour between the player and any enemy body', () => {
    const playerHexes = new Set<string>(Object.values(SPRITES['player.fighter'].palette).map((r) => COLORS[r]));
    for (const id of ['enemy.commander', 'enemy.interceptor', 'enemy.scout', 'special.stinger', 'special.phantom', 'special.sovereign'] as const) {
      for (const role of Object.values(SPRITES[id].palette)) expect(playerHexes.has(COLORS[role as ColorRole])).toBe(false);
    }
  });

  it('separates player and enemy projectile colours', () => {
    const p = Object.values(SPRITES['fx.shot.player'].palette).map((r) => COLORS[r]);
    const e: string[] = Object.values(SPRITES['fx.shot.enemy'].palette).map((r) => COLORS[r]);
    expect(p.filter((h) => e.includes(h))).toEqual([]);
  });

  it('uses dark outlines that separate ships from the void and from each other', () => {
    for (const [, def] of entries) {
      if (!def.outline) continue;
      expect(luminance(COLORS[def.outline])).toBeLessThan(0.03);
    }
  });

  it('keeps the background darker than every star and every ship colour', () => {
    const voidL = luminance(COLORS['space.void']);
    for (const role of ['star.dim', 'star.mid', 'star.bright'] as const) expect(luminance(COLORS[role])).toBeGreaterThan(voidL);
    // Stars stay dim so they never compete with sprites.
    expect(luminance(COLORS['star.bright'])).toBeLessThan(luminance(COLORS['player.hull.shade']));
  });

  it('reserves glow for a small set of roles', () => {
    // 23 Classic / player roles + 3 per Free Roam faction (eye, engine, engine core; Prompt 9)
    expect(EMISSIVE_ROLES.size).toBeLessThanOrEqual(36);
    for (const role of EMISSIVE_ROLES) expect(COLORS).toHaveProperty([role]);
  });
});

describe('palette variants and looks', () => {
  it('captive variant remaps every player role', () => {
    const swap = VARIANTS.captive.swap as Record<string, string>;
    for (const role of Object.values(SPRITES['player.fighter'].palette)) {
      expect(swap[role]).toBeDefined();
      expect(COLORS).toHaveProperty([swap[role]!]);
    }
    expect(COLORS).toHaveProperty([swap['player.outline']!]);
  });

  it('damaged variant only targets commander roles that exist', () => {
    for (const [from, to] of Object.entries(VARIANTS.damaged.swap)) {
      expect(from.startsWith('commander.')).toBe(true);
      expect(COLORS).toHaveProperty([to]);
    }
  });

  it('every look references a real sprite, state and variant', () => {
    for (const look of LOOKS) {
      const def: SpriteDef = SPRITES[look.sprite];
      expect(def.states).toHaveProperty([look.state]);
      if (look.variant) expect(VARIANTS).toHaveProperty([look.variant]);
    }
  });
});
