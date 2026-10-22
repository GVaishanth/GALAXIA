import { COLORS, EMISSIVE_ROLES, hexToRgb, type ColorRole } from '../../config/palette.ts';
import { SPRITE_STYLE } from '../../config/visual.ts';
import { TRANSPARENT } from '../../assets/sprites/format/grid.ts';
import type { CharPalette, ExpandedFrame, PaletteVariant, RasterFrame, RgbaImage } from '../../assets/sprites/format/types.ts';

export interface RasterStyle {
  readonly outlineWidth: number;
  readonly glowRadius: number;
  readonly glowGain: number;
}

export const DEFAULT_RASTER_STYLE: RasterStyle = {
  outlineWidth: SPRITE_STYLE.outlineWidth,
  glowRadius: SPRITE_STYLE.glowRadius,
  glowGain: SPRITE_STYLE.glowGain,
};

export function resolveRole(role: ColorRole, variant: PaletteVariant | undefined): ColorRole {
  if (!variant) return role;
  const base = variant.all ?? role;
  return variant.swap?.[base] ?? base;
}

function makeImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

const rgbCache = new Map<ColorRole, readonly [number, number, number]>();
function rgbOf(role: ColorRole): readonly [number, number, number] {
  let rgb = rgbCache.get(role);
  if (!rgb) {
    rgb = hexToRgb(COLORS[role]);
    rgbCache.set(role, rgb);
  }
  return rgb;
}

/**
 * Rasterise an expanded grid into a padded sprite image plus an optional glow
 * image. Pure and deterministic: no DOM, usable in browser, tests and Node.
 */
export function rasterizeFrame(
  frame: ExpandedFrame,
  palette: CharPalette,
  outline: ColorRole | null,
  variant?: PaletteVariant,
  style: RasterStyle = DEFAULT_RASTER_STYLE,
): RasterFrame {
  const outlineWidth = outline === null ? 0 : style.outlineWidth;
  const glowRadius = variant?.noGlow ? 0 : style.glowRadius;
  const pad = outlineWidth + glowRadius;
  const width = frame.width + pad * 2;
  const height = frame.height + pad * 2;

  // Role map for the padded canvas; null = empty.
  const roles: (ColorRole | null)[] = new Array<ColorRole | null>(width * height).fill(null);
  for (let y = 0; y < frame.height; y++) {
    const row = frame.rows[y]!;
    for (let x = 0; x < frame.width; x++) {
      const ch = row[x]!;
      if (ch === TRANSPARENT) continue;
      const role = palette[ch];
      if (!role) throw new Error(`Character "${ch}" is not in the palette`);
      roles[(y + pad) * width + (x + pad)] = resolveRole(role, variant);
    }
  }

  // Outline: dilate the silhouette with 4-neighbour steps.
  if (outline !== null && outlineWidth > 0) {
    const outlineRole = variant?.outline ?? resolveOutline(outline, variant);
    for (let pass = 0; pass < outlineWidth; pass++) {
      const filled = roles.map((r) => r !== null);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (filled[i]) continue;
          const touches =
            (x > 0 && filled[i - 1]) ||
            (x < width - 1 && filled[i + 1]) ||
            (y > 0 && filled[i - width]) ||
            (y < height - 1 && filled[i + width]);
          if (touches) roles[i] = outlineRole;
        }
      }
    }
  }

  const sprite = makeImage(width, height);
  let emissiveCount = 0;
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    if (!role) continue;
    const [r, g, b] = rgbOf(role);
    sprite.data[i * 4] = r;
    sprite.data[i * 4 + 1] = g;
    sprite.data[i * 4 + 2] = b;
    sprite.data[i * 4 + 3] = 255;
    if (EMISSIVE_ROLES.has(role)) emissiveCount++;
  }

  const glow = glowRadius > 0 && emissiveCount > 0 ? buildGlow(roles, width, height, glowRadius, style.glowGain) : null;

  return { sprite, glow, pad, contentWidth: frame.width, contentHeight: frame.height };
}

function resolveOutline(outline: ColorRole, variant: PaletteVariant | undefined): ColorRole {
  // Flash variants keep a dark outline so the white silhouette still reads.
  if (!variant || variant.all) return outline;
  return variant.swap?.[outline] ?? outline;
}

/** Soft colour spread from emissive pixels (pre-rendered, so it costs nothing per frame). */
function buildGlow(
  roles: readonly (ColorRole | null)[],
  width: number,
  height: number,
  radius: number,
  gain: number,
): RgbaImage {
  const acc = new Float32Array(width * height * 4);
  const kernel: { dx: number; dy: number; w: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > radius + 0.5) continue;
      const falloff = 1 - d / (radius + 1);
      kernel.push({ dx, dy, w: falloff * falloff });
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const role = roles[y * width + x];
      if (!role || !EMISSIVE_ROLES.has(role)) continue;
      const [r, g, b] = rgbOf(role);
      for (const k of kernel) {
        const nx = x + k.dx;
        const ny = y + k.dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = (ny * width + nx) * 4;
        acc[j] = acc[j]! + r * k.w;
        acc[j + 1] = acc[j + 1]! + g * k.w;
        acc[j + 2] = acc[j + 2]! + b * k.w;
        acc[j + 3] = acc[j + 3]! + k.w;
      }
    }
  }
  const img = makeImage(width, height);
  for (let i = 0; i < width * height; i++) {
    const w = acc[i * 4 + 3]!;
    if (w <= 0) continue;
    img.data[i * 4] = acc[i * 4]! / w;
    img.data[i * 4 + 1] = acc[i * 4 + 1]! / w;
    img.data[i * 4 + 2] = acc[i * 4 + 2]! / w;
    img.data[i * 4 + 3] = Math.min(1, w * gain) * 255;
  }
  return img;
}
