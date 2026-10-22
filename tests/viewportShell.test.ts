/**
 * Screen-sizing unification (TD-72 / FR-TD-73): the shared viewport pieces
 * (AppShell maths, fitViewport areas, the Classic play area) and the rule that
 * both modes size their screen through them, with no second resize system.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RENDER } from '../src/config/devices.ts';
import { PLAYFIELD_ART } from '../src/config/visual.ts';
import { backingSize, cssBoxToDevice, fitViewport } from '../src/render/viewport.ts';
import { cssPx, NO_INSETS, orientationOf, safeBox } from '../src/shared/rendering/appShell.ts';
import { fullscreenSupported, isFullscreen, setFullscreen } from '../src/shared/ui/fullscreen.ts';
import { cameraZoom } from '../src/modes/freeroam/camera.ts';
import { chooseLayout, pageArea, playArea } from '../src/ui/layout.ts';

const OPTS = { maxPixelRatio: RENDER.maxPixelRatio, maxPixels: RENDER.maxBackingPixels };
const ASPECT = PLAYFIELD_ART.width / PLAYFIELD_ART.height;

/** The requested test viewports: [w, h, touch]. */
const VIEWPORTS: [number, number, boolean][] = [
  [320, 568, true], [360, 800, true], [390, 844, true], [430, 932, true], [568, 320, true], [667, 375, true],
  [768, 1024, true], [1024, 768, true], [1280, 720, false], [1366, 768, false], [1440, 900, false], [1920, 1080, false],
];

describe('AppShell maths (pure)', () => {
  it('safeBox subtracts the insets and never inverts', () => {
    expect(safeBox(390, 844, NO_INSETS)).toEqual({ left: 0, top: 0, width: 390, height: 844 });
    expect(safeBox(390, 844, { top: 47, right: 0, bottom: 34, left: 0 })).toEqual({ left: 0, top: 47, width: 390, height: 763 });
    expect(safeBox(844, 390, { top: 0, right: 47, bottom: 21, left: 47 })).toEqual({ left: 47, top: 0, width: 750, height: 369 });
    const silly = safeBox(100, 50, { top: 40, right: 80, bottom: 40, left: 80 });
    expect(silly.width).toBeGreaterThanOrEqual(0);
    expect(silly.height).toBeGreaterThanOrEqual(0);
    expect(safeBox(-5, -5, NO_INSETS)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });

  it('orientationOf: landscape when w >= h, null while not laid out', () => {
    expect(orientationOf(844, 390)).toBe('landscape');
    expect(orientationOf(390, 844)).toBe('portrait');
    expect(orientationOf(500, 500)).toBe('landscape');
    expect(orientationOf(0, 0)).toBeNull();
    expect(orientationOf(8, 600)).toBeNull();
    expect(orientationOf(Number.NaN, 600)).toBeNull();
  });

  it('cssPx parses computed padding values defensively', () => {
    expect(cssPx('47px')).toBe(47);
    expect(cssPx('12.5px')).toBe(12.5);
    expect(cssPx('0px')).toBe(0);
    expect(cssPx('')).toBe(0);
    expect(cssPx(null)).toBe(0);
    expect(cssPx('-3px')).toBe(0);
    expect(cssPx('auto')).toBe(0);
  });
});

describe('fitViewport inside an area of a full-bleed canvas', () => {
  it('without an area it is unchanged (whole box)', () => {
    expect(fitViewport(1280, 720)).toEqual(fitViewport(1280, 720, { area: { left: 0, top: 0, width: 1280, height: 720 } }));
  });

  it('fits, offsets and aligns inside the area', () => {
    const area = { left: 100, top: 40, width: 448, height: 700 };
    const v = fitViewport(1000, 800, { area, align: 'bottom' });
    expect(v.scale).toBeCloseTo(1, 9);
    expect(v.offsetX).toBe(100);
    expect(v.offsetY).toBe(40 + (700 - 576));
    expect(v.deviceWidth).toBe(1000); // the canvas stays full-bleed
    const top = fitViewport(1000, 800, { area, align: 'top' });
    expect(top.offsetY).toBe(40);
  });

  it('cssBoxToDevice maps the whole canvas exactly onto the backing store', () => {
    for (const [w, h] of [[390, 844], [1366, 768], [333.5, 611.25]] as const) {
      for (const dpr of [1, 1.5, 2, 3]) {
        const b = backingSize(w, h, dpr, OPTS);
        expect(cssBoxToDevice({ left: 0, top: 0, width: w, height: h }, b)).toEqual({ left: 0, top: 0, width: b.width, height: b.height });
      }
    }
  });
});

describe('Classic on the shared shell: same arena size as the old grid layout, never under controls or insets', () => {
  /** The pre-TD-72 Classic: the canvas was the grid cell left by the controls inside the safe padding. */
  const oldStage = (w: number, h: number, touch: boolean) => {
    const l = chooseLayout({ width: w, height: h, touch });
    return l.mode === 'touch-landscape' ? { width: w - 2 * l.sideColumn, height: h } : l.mode === 'touch-portrait' ? { width: w, height: h - l.padHeight } : { width: w, height: h };
  };
  const INSETS = [NO_INSETS, { top: 47, right: 0, bottom: 34, left: 0 }, { top: 0, right: 47, bottom: 21, left: 47 }];

  for (const [w, h, touch] of VIEWPORTS) {
    it(`${w}x${h} ${touch ? 'touch' : 'desktop'}`, () => {
      for (const insets of INSETS) {
        const safe = safeBox(w, h, insets);
        const l = chooseLayout({ width: safe.width, height: safe.height, touch });
        const area = playArea(l, safe);
        // the play area is inside the safe box
        expect(area.left).toBeGreaterThanOrEqual(safe.left);
        expect(area.top).toBeGreaterThanOrEqual(safe.top);
        expect(area.left + area.width).toBeLessThanOrEqual(safe.left + safe.width + 1e-6);
        expect(area.top + area.height).toBeLessThanOrEqual(safe.top + safe.height + 1e-6);
        // the controls' reservation is outside it
        if (l.mode === 'touch-portrait') expect(safe.top + safe.height - (area.top + area.height)).toBeCloseTo(l.padHeight, 6);
        if (l.mode === 'touch-landscape') expect(area.left - safe.left).toBeCloseTo(l.sideColumn, 6);
        // page screens may use the whole safe box on touch, never more
        const page = pageArea(l, safe);
        if (l.mode === 'desktop') expect(page).toBeNull();
        else expect(page).toEqual(safe);
        for (const dpr of [1, 2, 3]) {
          const b = backingSize(w, h, dpr, OPTS);
          const v = fitViewport(b.width, b.height, { align: l.align, area: cssBoxToDevice(area, b) });
          const fw = (v.artWidth * v.scale) / b.ratio;
          const fh = (v.artHeight * v.scale) / b.ratio;
          expect(fw / fh).toBeCloseTo(ASPECT, 9); // never stretched
          expect(v.offsetX / b.ratio).toBeGreaterThanOrEqual(area.left - 1e-6); // never cropped
          expect(v.offsetY / b.ratio + fh).toBeLessThanOrEqual(area.top + area.height + 1 / b.ratio + 1e-6);
          if (insets === NO_INSETS) {
            // regression: the arena is exactly as large as with the old grid-cell canvas (no shrink)
            const o = oldStage(w, h, touch);
            const old = fitViewport(Math.round(o.width * dpr), Math.round(o.height * dpr), { align: l.align });
            expect(fw).toBeGreaterThanOrEqual((old.artWidth * old.scale) / dpr - 1);
          }
        }
      }
    });
  }

  it('the playfield never changes the logical arena: 448x576 art px at every size', () => {
    for (const [w, h] of VIEWPORTS) {
      const v = fitViewport(w, h);
      expect(v.artWidth).toBe(PLAYFIELD_ART.width);
      expect(v.artHeight).toBe(PLAYFIELD_ART.height);
    }
  });
});

describe('Free Roam on the shared shell (reference): full-bleed canvas, camera framing only', () => {
  it('the camera zoom depends only on the canvas size; the world is never letterboxed', () => {
    for (const [w, h] of VIEWPORTS) {
      const b = backingSize(w, h, 2, OPTS);
      const z = cameraZoom(b.width, b.height);
      // at least 360 art px on the short side, at most 640 on the long side
      expect(Math.min(b.width, b.height) / z).toBeLessThanOrEqual(360 + 1e-6);
      expect(Math.max(b.width, b.height) / z).toBeLessThanOrEqual(640 + 1e-6);
    }
  });
});

describe('fullscreen helper (pure document fakes)', () => {
  type FakeDoc = {
    fullscreenEnabled?: boolean;
    webkitFullscreenEnabled?: boolean;
    fullscreenElement?: Element | null;
    webkitFullscreenElement?: Element | null;
    exitFullscreen?: () => Promise<void>;
    webkitExitFullscreen?: () => void;
  };
  const target = { tag: 'html' } as unknown as Element;

  it('reports unsupported (iPhone Safari) and never throws', async () => {
    const d: FakeDoc = {};
    expect(fullscreenSupported(d)).toBe(false);
    expect(await setFullscreen(true, target, d)).toBe(false);
    expect(fullscreenSupported(null)).toBe(false);
    expect(isFullscreen(null)).toBe(false);
  });

  it('enters and leaves through the standard API', async () => {
    const d: FakeDoc = { fullscreenEnabled: true, fullscreenElement: null };
    const el = {
      requestFullscreen: async () => {
        d.fullscreenElement = el as unknown as Element;
      },
    };
    d.exitFullscreen = async () => {
      d.fullscreenElement = null;
    };
    expect(await setFullscreen(true, el as unknown as Element, d)).toBe(true);
    expect(isFullscreen(d)).toBe(true);
    expect(await setFullscreen(false, el as unknown as Element, d)).toBe(false);
  });

  it('falls back to the WebKit prefix (iPad Safari) and survives a refusal', async () => {
    const d: FakeDoc = { webkitFullscreenEnabled: true, webkitFullscreenElement: null };
    const el = {
      webkitRequestFullscreen: () => {
        d.webkitFullscreenElement = el as unknown as Element;
      },
    };
    d.webkitExitFullscreen = () => {
      d.webkitFullscreenElement = null;
    };
    expect(await setFullscreen(true, el as unknown as Element, d)).toBe(true);
    expect(await setFullscreen(false, el as unknown as Element, d)).toBe(false);
    const refusing = { requestFullscreen: () => Promise.reject(new Error('no user gesture')) };
    expect(await setFullscreen(true, refusing as unknown as Element, { fullscreenEnabled: true, fullscreenElement: null })).toBe(false);
  });
});

describe('one viewport system for both modes (source rules)', () => {
  const src = (p: string): string => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  const MODES = ['game/app.ts', 'modes/freeroam/freeRoamMode.ts'];

  for (const file of MODES) {
    it(`${file} uses AppShell + CanvasSurface and has no resize system of its own`, () => {
      const s = src(file);
      expect(s).toMatch(/new AppShell\(/);
      expect(s).toMatch(/new CanvasSurface\(/);
      expect(s).not.toMatch(/new ResizeObserver\(/);
      expect(s).not.toMatch(/\bbackingSize\(/);
      expect(s).not.toMatch(/\bapplyCanvasSize\(/);
      expect(s).not.toMatch(/'orientationchange'/);
      expect(s).not.toMatch(/classList\.(add|remove)\('game-mode'\)/);
      expect(s).not.toMatch(/className = 'app /); // the shell keeps the host's .mode-root marker
    });
  }

  it('styles: safe-area insets come from one set of custom properties', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const envUses = css.match(/env\(safe-area-inset-[a-z]+/g) ?? [];
    expect(envUses.sort()).toEqual(['env(safe-area-inset-bottom', 'env(safe-area-inset-left', 'env(safe-area-inset-right', 'env(safe-area-inset-top']);
    expect(css).toMatch(/\.mode-shell \{[^}]*position: absolute;[^}]*inset: 0;/);
    expect(css).toMatch(/\.mode-canvas \{[^}]*width: 100%;[^}]*height: 100%;/);
    // the Classic container no longer pads itself by the insets (that shrank its canvas)
    expect(css).not.toMatch(/\.game-app \{[^}]*padding:/);
  });
});
