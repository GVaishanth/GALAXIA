import { SPRITE_STYLE } from '../../config/visual.ts';
import { SPRITES, VARIANTS, type SpriteId, type VariantId } from '../../assets/sprites/index.ts';
import { expandFrame } from '../../assets/sprites/format/grid.ts';
import { rasterizeFrame } from './rasterize.ts';
import type { FrameSource, RasterFrame, RgbaImage } from '../../assets/sprites/format/types.ts';

export type CanvasLike = HTMLCanvasElement | OffscreenCanvas;
export type CanvasFactory = (width: number, height: number) => CanvasLike;

export const domCanvasFactory: CanvasFactory = (width, height) => {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
};

export interface CachedFrame {
  readonly raster: RasterFrame;
  readonly sprite: CanvasLike;
  readonly glow: CanvasLike | null;
  /** Integer nearest-neighbour upscales, keyed by factor (sharp-bilinear source). */
  readonly prescaled: Map<number, { sprite: CanvasLike; glow: CanvasLike | null }>;
}

function toCanvas(img: RgbaImage, make: CanvasFactory): CanvasLike {
  const canvas = make(img.width, img.height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  const data = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  ctx.putImageData(data, 0, 0);
  return canvas;
}

function upscale(src: CanvasLike, k: number, make: CanvasFactory): CanvasLike {
  const out = make(src.width * k, src.height * k);
  const ctx = out.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/**
 * Lazily rasterises sprite frames into canvases and keeps them. Frames are
 * built on first use; call `warm()` during loading to build everything up front.
 */
export class SpriteCache {
  private readonly frames = new Map<string, CachedFrame>();
  private readonly make: CanvasFactory;

  constructor(make: CanvasFactory = domCanvasFactory) {
    this.make = make;
  }

  get size(): number {
    return this.frames.size;
  }

  frame(id: SpriteId, state: string, index: number, variant?: VariantId): CachedFrame {
    const key = `${id}|${state}|${index}|${variant ?? ''}`;
    let cached = this.frames.get(key);
    if (!cached) {
      const def = SPRITES[id];
      const sources = (def.states as Record<string, readonly FrameSource[]>)[state];
      if (!sources || sources.length === 0) throw new Error(`Sprite ${id} has no state "${state}"`);
      const src = sources[index % sources.length]!;
      const raster = rasterizeFrame(expandFrame(src), def.palette, def.outline, variant ? VARIANTS[variant] : undefined);
      cached = {
        raster,
        sprite: toCanvas(raster.sprite, this.make),
        glow: raster.glow ? toCanvas(raster.glow, this.make) : null,
        prescaled: new Map(),
      };
      this.frames.set(key, cached);
    }
    return cached;
  }

  /** Integer-upscaled copies for sharp-bilinear drawing at fractional scales. */
  prescaled(frame: CachedFrame, k: number): { sprite: CanvasLike; glow: CanvasLike | null } {
    const factor = Math.max(1, Math.min(SPRITE_STYLE.maxPrescale, Math.ceil(k)));
    let entry = frame.prescaled.get(factor);
    if (!entry) {
      entry =
        factor === 1
          ? { sprite: frame.sprite, glow: frame.glow }
          : { sprite: upscale(frame.sprite, factor, this.make), glow: frame.glow ? upscale(frame.glow, factor, this.make) : null };
      frame.prescaled.set(factor, entry);
    }
    return entry;
  }

  /** Rasterise every state, frame and the given variants. Returns the count built. */
  warm(variants: readonly (VariantId | undefined)[] = [undefined]): number {
    let built = 0;
    for (const id of Object.keys(SPRITES) as SpriteId[]) {
      const def = SPRITES[id];
      for (const [state, frames] of Object.entries(def.states as Record<string, readonly unknown[]>)) {
        for (let i = 0; i < frames.length; i++) {
          for (const v of variants) {
            this.frame(id, state, i, v);
            built++;
          }
        }
      }
    }
    return built;
  }
}
