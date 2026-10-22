import type { ColorRole } from '../../../config/palette.ts';

/**
 * A pixel grid: one string per row, one character per art pixel.
 * '.' is transparent. Every other character must be mapped in the sprite's
 * palette. All rows must be the same length.
 */
export type PixelRows = readonly string[];

/**
 * How authored rows expand into the full grid.
 *  - 'none'      rows are the full sprite.
 *  - 'mirror-x'  rows are the LEFT half including the centre column; the right
 *                half is mirrored (full width = 2 * rowLength - 1, always odd).
 *  - 'mirror-xy' rows are the TOP-LEFT quadrant including the centre row and
 *                column; mirrored both ways (used for radial effects).
 */
export type Symmetry = 'none' | 'mirror-x' | 'mirror-xy';

export interface FrameSource {
  readonly rows: PixelRows;
  readonly symmetry: Symmetry;
}

export type CharPalette = Readonly<Record<string, ColorRole>>;

export interface SpriteDef<S extends string = string> {
  /** Stable registry id, e.g. 'enemy.commander'. */
  readonly id: string;
  /** Human-readable GALAXIA name. */
  readonly name: string;
  /** Short role description shown in the hangar and docs. */
  readonly role: string;
  /** Character to colour-role mapping shared by every frame. */
  readonly palette: CharPalette;
  /** Role used for the auto-generated outline, or null for none. */
  readonly outline: ColorRole | null;
  /** Named animation states; each is one or more frames. */
  readonly states: Readonly<Record<S, readonly FrameSource[]>>;
  /** Frame duration in ms per state (looping). Missing = static. */
  readonly frameMs?: Readonly<Partial<Record<S, number>>>;
}

/** Concrete, expanded frame grid ready to rasterise. */
export interface ExpandedFrame {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly string[];
}

/** Straight (non-premultiplied) RGBA image. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface RasterFrame {
  /** Sprite pixels including outline, padded by `pad` on every side. */
  readonly sprite: RgbaImage;
  /** Glow layer of identical size, or null when the frame has no emissive pixels. */
  readonly glow: RgbaImage | null;
  /** Transparent padding (outline + glow room) on each side, in art px. */
  readonly pad: number;
  /** Size of the authored content (before outline/pad), in art px. */
  readonly contentWidth: number;
  readonly contentHeight: number;
}

/** Palette variant: a remap applied on top of a sprite's palette. */
export interface PaletteVariant {
  readonly id: string;
  /** Replace specific roles. */
  readonly swap?: Readonly<Partial<Record<ColorRole, ColorRole>>>;
  /** Replace every body role with one role (hit flash). Applied before swap. */
  readonly all?: ColorRole;
  /** Outline role override. */
  readonly outline?: ColorRole;
  /** Suppress the glow layer. */
  readonly noGlow?: boolean;
}
