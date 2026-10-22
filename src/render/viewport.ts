import { PLAYFIELD_ART } from '../config/visual.ts';

/**
 * Maps the logical art-pixel playfield onto a device-pixel canvas, preserving
 * aspect ratio (letterboxed/pillarboxed, centred), optionally inside a
 * sub-area of the canvas (the safe play area, TD-72).
 */
export interface Viewport {
  /** Device pixels per art pixel (may be fractional). */
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  /** Logical size being fitted, in art px. */
  readonly artWidth: number;
  readonly artHeight: number;
}

export interface FitOptions {
  /** Snap scale down to a whole number when >= 1 (pixel-perfect mode). */
  readonly integerScale?: boolean;
  readonly artWidth?: number;
  readonly artHeight?: number;
  /** Upper bound on device px per art px (applied before integer snapping). */
  readonly maxScale?: number;
  /** Vertical placement inside the device box (default centred). */
  readonly align?: 'center' | 'bottom' | 'top';
  /**
   * Sub-rectangle of the device box to fit into (device px), e.g. the safe
   * play area of a full-bleed canvas (TD-72). Default: the whole box.
   */
  readonly area?: DeviceArea;
}

/** A rectangle in device px on the canvas. */
export interface DeviceArea {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function fitViewport(deviceWidth: number, deviceHeight: number, options: FitOptions = {}): Viewport {
  const artWidth = options.artWidth ?? PLAYFIELD_ART.width;
  const artHeight = options.artHeight ?? PLAYFIELD_ART.height;
  const area = options.area ?? { left: 0, top: 0, width: deviceWidth, height: deviceHeight };
  let scale = Math.min(Math.max(0, area.width) / artWidth, Math.max(0, area.height) / artHeight);
  if (options.maxScale !== undefined) scale = Math.min(scale, options.maxScale);
  if (options.integerScale && scale >= 1) scale = Math.floor(scale);
  scale = Math.max(scale, 0.0001);
  const offsetX = area.left + Math.floor((area.width - artWidth * scale) / 2);
  const spareY = area.height - artHeight * scale;
  const offsetY = area.top + Math.floor(options.align === 'bottom' ? spareY : options.align === 'top' ? 0 : spareY / 2);
  return { scale, offsetX, offsetY, deviceWidth, deviceHeight, artWidth, artHeight };
}

/**
 * A viewport between two of the same canvas (presentation glide, TD-73):
 * scale and offsets interpolated, offsets kept on whole device pixels so
 * sprites stay crisp. k = 0 -> a, k = 1 -> b. Pure.
 */
export function blendViewport(a: Viewport, b: Viewport, k: number): Viewport {
  const t = Math.max(0, Math.min(1, k));
  if (t >= 1 || a.deviceWidth !== b.deviceWidth || a.deviceHeight !== b.deviceHeight || a.artWidth !== b.artWidth || a.artHeight !== b.artHeight) return b;
  return {
    ...b,
    scale: a.scale + (b.scale - a.scale) * t,
    offsetX: Math.round(a.offsetX + (b.offsetX - a.offsetX) * t),
    offsetY: Math.round(a.offsetY + (b.offsetY - a.offsetY) * t),
  };
}

export interface BackingSize {
  readonly width: number;
  readonly height: number;
  /** Device px per CSS px actually used (<= devicePixelRatio when capped). */
  readonly ratio: number;
  readonly capped: boolean;
}

export interface BackingOptions {
  readonly maxPixelRatio: number;
  readonly maxPixels: number;
  /** Exact device-pixel box from ResizeObserver (devicePixelContentBoxSize), when supported. */
  readonly exact?: { readonly width: number; readonly height: number } | null;
  /** Adaptive render scale (TD-79): multiplier on the DPR/budget ratio, default 1. */
  readonly scale?: number;
  /** Floor for a scaled ratio (device px per CSS px), default 1; never raises the unscaled ratio. */
  readonly minRatio?: number;
}

/**
 * Backing-store size for a canvas of cssWidth x cssHeight: devicePixelRatio,
 * capped by a maximum ratio and a total pixel budget. Uses the exact device
 * box when the browser reports it and no cap applies (crispest result).
 * An adaptive `scale` < 1 lowers the ratio further, but never below
 * `minRatio` (or the unscaled ratio, if that is already lower).
 * Pure: gameplay never depends on it (the engine works in art pixels).
 */
export function backingSize(cssWidth: number, cssHeight: number, dpr: number, o: BackingOptions): BackingSize {
  const out = { width: 1, height: 1, ratio: 1, capped: false };
  backingInto(out, cssWidth, cssHeight, dpr, o);
  return out;
}

/** backingSize() into a caller-owned object (no allocation; per-frame callers compare and copy on change). */
export function backingInto(out: { width: number; height: number; ratio: number; capped: boolean }, cssWidth: number, cssHeight: number, dpr: number, o: BackingOptions): void {
  const w = Math.max(1, cssWidth);
  const h = Math.max(1, cssHeight);
  let ratio = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, o.maxPixelRatio);
  if (w * h * ratio * ratio > o.maxPixels) ratio = Math.sqrt(o.maxPixels / (w * h));
  const k = o.scale ?? 1;
  if (k < 1) ratio = Math.max(ratio * k, Math.min(ratio, o.minRatio ?? 1));
  const capped = ratio < dpr - 1e-6;
  out.capped = capped;
  // trust the exact box only when it agrees with css x dpr (emulators and some
  // zoom states report CSS-sized boxes, which would render at 1x and blur)
  const e = o.exact;
  const agrees = !!e && Math.abs(e.width - w * ratio) <= 2 && Math.abs(e.height - h * ratio) <= 2;
  if (!capped && e && agrees && e.width > 0 && e.height > 0) {
    out.width = Math.round(e.width);
    out.height = Math.round(e.height);
    out.ratio = e.width / w;
    return;
  }
  out.width = Math.max(1, Math.round(w * ratio));
  out.height = Math.max(1, Math.round(h * ratio));
  out.ratio = ratio;
}

/**
 * A CSS-px box on a canvas -> device px of its backing store (pure). Edges
 * are rounded independently and clamped to the backing size, so a box that
 * covers the whole canvas maps exactly onto the whole backing store.
 */
export function cssBoxToDevice(box: DeviceArea, backing: BackingSize): DeviceArea {
  const r = backing.ratio;
  const x0 = Math.max(0, Math.min(backing.width, Math.round(box.left * r)));
  const y0 = Math.max(0, Math.min(backing.height, Math.round(box.top * r)));
  const x1 = Math.max(x0, Math.min(backing.width, Math.round((box.left + box.width) * r)));
  const y1 = Math.max(y0, Math.min(backing.height, Math.round((box.top + box.height) * r)));
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

/** Resize a canvas only when its backing size really changes (no per-frame reallocation). Returns true if it was resized. */
export function applyCanvasSize(canvas: { width: number; height: number }, size: { readonly width: number; readonly height: number }): boolean {
  if (canvas.width === size.width && canvas.height === size.height) return false;
  canvas.width = size.width;
  canvas.height = size.height;
  return true;
}

/**
 * Size a canvas backing store to its CSS box times devicePixelRatio and
 * return the device size. Keeps sprites crisp on high-DPI screens.
 */
export function syncCanvasSize(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number } {
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height };
}
