/**
 * The one canvas-resolution implementation for both modes (Stage 5/9; Classic
 * moved onto it in TD-72, Free Roam since Prompt 2). Inside an AppShell the
 * canvas is full-bleed (`.mode-canvas`):
 * the CSS box is measured by a ResizeObserver (exact device pixels when the
 * browser reports them), the backing store is sized with the shared DPR and
 * pixel caps (RENDER), and it is reallocated only when the size really
 * changes. Logical coordinates never depend on the backing size.
 *
 * `release()` frees the backing store (0x0) and removes the element, so a
 * disposed mode does not keep megabytes of canvas memory alive.
 *
 * Adaptive render resolution (TD-79, `adaptive: true`, the two game canvases
 * only): a RenderScaleController lowers the backing ratio under sustained slow
 * frames and restores it when frames are healthy. Every consumer already reads
 * `backing.ratio` (drawing, DOM overlays, pointer mapping), so the effective
 * ratio is the single source of truth. When the browser upscale is an exact
 * integer (DPR 2 at ratio 1, DPR 3 at 1.5) the canvas gets
 * `data-upscale="integer"` and CSS switches it to pixelated, so pixel art
 * stays as sharp as at full resolution.
 */
import { RENDER } from '../../config/devices.ts';
import { applyCanvasSize, backingInto, type BackingSize } from '../../render/viewport.ts';
import type { DisposableScope } from '../lifecycle/scope.ts';
import { RenderScaleController } from './renderScale.ts';

export interface CanvasSurfaceOptions {
  /** Adaptive render resolution (game canvases only). */
  readonly adaptive?: boolean;
}

export class CanvasSurface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** CSS size of the canvas box. */
  css = { width: 1, height: 1 };
  backing: BackingSize = { width: 1, height: 1, ratio: 1, capped: false };
  /** Backing-store reallocations so far. */
  resizes = 0;
  private exact: { width: number; height: number } | null = null;
  /** Adaptive resolution controller (null on UI canvases such as the maps). */
  readonly adaptive: RenderScaleController | null;
  private lastSampleTs: number | null = null;
  private upscaleInteger = false;
  private readonly scratch = { width: 1, height: 1, ratio: 1, capped: false };
  private readonly opts: { maxPixelRatio: number; maxPixels: number; exact: { width: number; height: number } | null; scale: number; minRatio: number } = {
    maxPixelRatio: RENDER.maxPixelRatio,
    maxPixels: RENDER.maxBackingPixels,
    exact: null,
    scale: 1,
    minRatio: RENDER.adaptive.minRatio,
  };

  constructor(parent: HTMLElement, scope: DisposableScope, label: string, className = 'mode-canvas', options: CanvasSurfaceOptions = {}) {
    this.adaptive = options.adaptive ? new RenderScaleController() : null;
    const canvas = document.createElement('canvas');
    canvas.className = className;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label);
    parent.append(canvas);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available in this browser');
    this.canvas = canvas;
    this.ctx = ctx;
    this.css = { width: canvas.clientWidth || 1, height: canvas.clientHeight || 1 };
    const ro = scope.observer(
      new ResizeObserver(([entry]) => {
        if (!entry) return;
        this.css = { width: entry.contentRect.width, height: entry.contentRect.height };
        const dp = entry.devicePixelContentBoxSize?.[0];
        this.exact = dp ? { width: dp.inlineSize, height: dp.blockSize } : null;
      }),
    );
    try {
      ro.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(canvas);
    }
    scope.add(() => this.release());
  }

  /** Size the backing store for this frame (no-op unless the size changed). */
  fit(): BackingSize {
    const dpr = window.devicePixelRatio || 1;
    const b = this.sizeFor(dpr, this.adaptive?.multiplier ?? 1);
    if (applyCanvasSize(this.canvas, b)) {
      this.resizes += 1;
      this.adaptive?.hold(); // the reallocation hitch is not a performance sample
    }
    if (b !== this.backing) {
      const k = dpr / b.ratio;
      const integer = this.adaptive !== null && b.ratio < dpr - 1e-6 && Math.abs(k - Math.round(k)) < 0.01 && Math.round(k) >= 2;
      if (integer !== this.upscaleInteger) {
        this.upscaleInteger = integer;
        if (integer) this.canvas.dataset['upscale'] = 'integer';
        else delete this.canvas.dataset['upscale'];
      }
    }
    this.backing = b;
    return b;
  }

  /**
   * Feed one frame to the adaptive controller (no-op on non-adaptive canvases).
   * `workMs` is the frame's main-thread time; `active` is false while paused,
   * behind a panel or with the tab hidden. Call after drawing.
   */
  sample(ts: number, workMs: number, active: boolean): void {
    const a = this.adaptive;
    if (!a) return;
    const interval = this.lastSampleTs === null ? 0 : ts - this.lastSampleTs;
    this.lastSampleTs = ts;
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const lvl = a.level;
    const canLower = lvl + 1 < a.cfg.levels.length && this.sizeFor(window.devicePixelRatio || 1, a.cfg.levels[lvl + 1] ?? 1).ratio < this.backing.ratio - 1e-6;
    a.sample(ts, interval, workMs, active && visible, canLower);
  }

  /** Backing size for a multiplier; returns the current object when nothing changed (no per-frame allocation). */
  private sizeFor(dpr: number, scale: number): BackingSize {
    const t = this.scratch;
    const o = this.opts;
    o.exact = this.exact;
    o.scale = scale;
    backingInto(t, this.css.width, this.css.height, dpr, o);
    const c = this.backing;
    return t.width === c.width && t.height === c.height && t.ratio === c.ratio && t.capped === c.capped ? c : { width: t.width, height: t.height, ratio: t.ratio, capped: t.capped };
  }

  release(): void {
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas.remove();
  }
}
