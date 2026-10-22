/**
 * Stage 5 responsive layout and canvas scaling: aspect ratio, letterboxing,
 * layout choice per device shape, backing-store caps and reallocation.
 */
import { describe, expect, it } from 'vitest';
import { LAYOUT, RENDER } from '../src/config/devices.ts';
import { PLAYFIELD_ART } from '../src/config/visual.ts';
import { applyCanvasSize, backingSize, cssBoxToDevice, fitViewport } from '../src/render/viewport.ts';
import { chooseLayout, fittedWidth, pageArea, playArea } from '../src/ui/layout.ts';
import { menuBox } from '../src/ui/screens.ts';

const ASPECT = PLAYFIELD_ART.width / PLAYFIELD_ART.height;
const OPTS = { maxPixelRatio: RENDER.maxPixelRatio, maxPixels: RENDER.maxBackingPixels };

/** Representative viewports (CSS px) with their device pixel ratios. */
const DEVICES = [
  { name: 'desktop 1920x1080', w: 1920, h: 1080, dpr: 1, touch: false },
  { name: 'laptop 1366x768', w: 1366, h: 768, dpr: 1, touch: false },
  { name: 'retina 1440x900', w: 1440, h: 900, dpr: 2, touch: false },
  { name: 'hidpi 2560x1440', w: 2560, h: 1440, dpr: 2, touch: false },
  { name: 'narrow window 700x900', w: 700, h: 900, dpr: 1, touch: false },
  { name: 'tablet portrait 768x1024', w: 768, h: 1024, dpr: 2, touch: true },
  { name: 'tablet landscape 1024x768', w: 1024, h: 768, dpr: 2, touch: true },
  { name: 'tablet pro 1024x1366', w: 1024, h: 1366, dpr: 2, touch: true },
  { name: 'phone 320x568', w: 320, h: 568, dpr: 2, touch: true },
  { name: 'phone 390x844', w: 390, h: 844, dpr: 3, touch: true },
  { name: 'phone 412x915', w: 412, h: 915, dpr: 2.625, touch: true },
  { name: 'phone landscape 844x390', w: 844, h: 390, dpr: 3, touch: true },
  { name: 'phone landscape 568x320', w: 568, h: 320, dpr: 2, touch: true },
] as const;

describe('fitViewport', () => {
  it.each(DEVICES)('$name: keeps the authored aspect, fits, never stretches', ({ w, h, dpr }) => {
    for (const align of ['center', 'bottom'] as const) {
      for (const integerScale of [false, true]) {
        const dw = Math.round(w * dpr);
        const dh = Math.round(h * dpr);
        const v = fitViewport(dw, dh, { align, integerScale });
        const pw = v.artWidth * v.scale;
        const ph = v.artHeight * v.scale;
        expect(pw / ph).toBeCloseTo(ASPECT, 9); // one uniform scale: no stretching
        expect(v.offsetX).toBeGreaterThanOrEqual(0);
        expect(v.offsetY).toBeGreaterThanOrEqual(0);
        expect(v.offsetX + pw).toBeLessThanOrEqual(dw + 1e-6);
        expect(v.offsetY + ph).toBeLessThanOrEqual(dh + 1e-6);
        if (!integerScale) expect(Math.max(dw - pw, dh - ph)).toBeGreaterThanOrEqual(-1e-6); // touches one pair of edges
        if (!integerScale) expect(Math.min(dw - pw, dh - ph)).toBeLessThan(1.0001);
        if (integerScale && v.scale >= 1) expect(Number.isInteger(v.scale)).toBe(true);
      }
    }
  });

  it('bottom alignment puts the playfield against the controls; centre splits the letterbox', () => {
    const c = fitViewport(390, 704, {});
    const b = fitViewport(390, 704, { align: 'bottom' });
    const bottom = b.offsetY + 576 * b.scale;
    expect(704 - bottom).toBeGreaterThanOrEqual(0);
    expect(704 - bottom).toBeLessThan(1); // offsets are floored to whole device pixels
    expect(c.offsetY).toBe(Math.floor((704 - 576 * c.scale) / 2));
    expect(b.offsetX).toBe(c.offsetX);
  });
});

describe('chooseLayout', () => {
  it('desktop: side panels collapse from both sides to compact to none as the window narrows', () => {
    const h = 800;
    const fw = fittedWidth(10_000, h);
    const at = (free: number): string => chooseLayout({ width: fw + free * 2, height: h, touch: false }).sidePanels;
    expect(at(LAYOUT.sidePanels.wide + 1)).toBe('sides');
    expect(at(LAYOUT.sidePanels.wide - 1)).toBe('compact');
    expect(at(LAYOUT.sidePanels.compact - 1)).toBe('none');
    expect(chooseLayout({ width: 1920, height: 1080, touch: false })).toMatchObject({ mode: 'desktop', align: 'center', padHeight: 0, sideColumn: 0 });
  });

  it('touch portrait: control strip below, playfield aligned to it, strip within limits', () => {
    for (const d of DEVICES.filter((x) => x.touch && x.w < x.h)) {
      const l = chooseLayout({ width: d.w, height: d.h, touch: true });
      expect(l.mode, d.name).toBe('touch-portrait');
      expect(l.align).toBe('bottom');
      expect(l.padHeight).toBeGreaterThanOrEqual(LAYOUT.pad.min);
      expect(l.padHeight).toBeLessThanOrEqual(LAYOUT.pad.max);
      // the playfield above the strip keeps a usable size (>= 70 % of the full width fit)
      expect(fittedWidth(d.w, d.h - l.padHeight)).toBeGreaterThanOrEqual(0.7 * Math.min(d.w, fittedWidth(d.w, d.h)));
    }
  });

  it('touch landscape: controls in the side columns; the playfield keeps the full height when they fit', () => {
    for (const d of DEVICES.filter((x) => x.touch && x.w >= x.h)) {
      const l = chooseLayout({ width: d.w, height: d.h, touch: true });
      expect(l.mode, d.name).toBe('touch-landscape');
      expect(l.sideColumn).toBeGreaterThanOrEqual(LAYOUT.sideColumn.min);
      expect(l.sideColumn).toBeLessThanOrEqual(LAYOUT.sideColumn.max);
      const middle = d.w - 2 * l.sideColumn;
      expect(middle).toBeGreaterThan(0);
      if ((d.w - d.h * ASPECT) / 2 >= LAYOUT.sideColumn.min) expect(fittedWidth(middle, d.h)).toBeCloseTo(d.h * ASPECT, 6);
    }
  });

  it('rotating a phone switches layouts and back', () => {
    expect(chooseLayout({ width: 390, height: 844, touch: true }).mode).toBe('touch-portrait');
    expect(chooseLayout({ width: 844, height: 390, touch: true }).mode).toBe('touch-landscape');
    expect(chooseLayout({ width: 390, height: 844, touch: true }).mode).toBe('touch-portrait');
  });

  it('never yields negative or NaN sizes for degenerate boxes', () => {
    for (const [w, h] of [[0, 0], [1, 1], [10, 2000], [2000, 10]] as const) {
      for (const touch of [false, true]) {
        const l = chooseLayout({ width: w, height: h, touch });
        for (const v of [l.padHeight, l.sideColumn]) expect(Number.isFinite(v) && v >= 0).toBe(true);
      }
    }
  });
});

describe('canvas backing store', () => {
  it.each(DEVICES)('$name: device-pixel sharp unless the budget caps it', ({ w, h, dpr }) => {
    const b = backingSize(w, h, dpr, OPTS);
    expect(b.width * b.height).toBeLessThanOrEqual(RENDER.maxBackingPixels + w + h + 1);
    expect(b.ratio).toBeLessThanOrEqual(RENDER.maxPixelRatio);
    if (!b.capped) {
      expect(b.width).toBe(Math.round(w * dpr));
      expect(b.height).toBe(Math.round(h * dpr));
    }
    expect(b.width / b.height).toBeCloseTo(w / h, 2);
  });

  it('caps very dense or very large canvases uniformly', () => {
    const hidpi = backingSize(2560, 1440, 2, OPTS);
    expect(hidpi.capped).toBe(true);
    expect(hidpi.ratio).toBeGreaterThan(1);
    expect(hidpi.ratio).toBeLessThan(2);
    const dense = backingSize(400, 800, 4, OPTS);
    expect(dense.ratio).toBe(RENDER.maxPixelRatio);
    expect(dense.capped).toBe(true);
  });

  it('uses the exact device box only when it agrees with css x dpr', () => {
    expect(backingSize(390, 704, 3, { ...OPTS, exact: { width: 1171, height: 2112 } }).width).toBe(1171);
    // emulators can report CSS-sized boxes: ignore them instead of rendering at 1x
    const wrong = backingSize(390, 704, 3, { ...OPTS, exact: { width: 390, height: 704 } });
    expect(wrong.width).toBe(1170);
    expect(wrong.ratio).toBe(3);
  });

  it('handles bad ratios and zero sizes', () => {
    for (const dpr of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const b = backingSize(100, 100, dpr, OPTS);
      expect(b.width).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(b.ratio)).toBe(true);
    }
    expect(backingSize(0, 0, 2, OPTS).width).toBeGreaterThanOrEqual(1);
  });

  it('reallocates the canvas only when the size really changes', () => {
    const canvas = { width: 0, height: 0 };
    let resizes = 0;
    const sizes = [
      { width: 800, height: 600 },
      { width: 800, height: 600 },
      { width: 800, height: 600 },
      { width: 801, height: 600 },
      { width: 801, height: 600 },
    ];
    for (const s of sizes) if (applyCanvasSize(canvas, s)) resizes += 1;
    expect(resizes).toBe(2);
    expect(canvas).toEqual({ width: 801, height: 600 });
  });
});

describe('desktop panels under the playfield (Stage 8: portrait monitors, tall windows)', () => {
  const desk = (w: number, h: number) => chooseLayout({ width: w, height: h, touch: false });
  const band = (w: number, h: number): number => h - fittedWidth(w, h) / ASPECT;

  it('portrait monitors put the playfield at the top with both panels underneath', () => {
    for (const [w, h] of [[1080, 1920], [1200, 1920], [1440, 2560]] as const) {
      expect(band(w, h)).toBeGreaterThanOrEqual(LAYOUT.stackedPanels.full);
      expect(desk(w, h)).toMatchObject({ mode: 'desktop', sidePanels: 'below', align: 'top' });
    }
  });

  it('thresholds: full, then controls only, then none (centred again)', () => {
    const w = 800;
    const h0 = w / ASPECT; // width-fitted playfield height
    expect(desk(w, h0 + LAYOUT.stackedPanels.full)).toMatchObject({ sidePanels: 'below', align: 'top' });
    expect(desk(w, h0 + LAYOUT.stackedPanels.full - 1)).toMatchObject({ sidePanels: 'below-compact', align: 'top' });
    expect(desk(w, h0 + LAYOUT.stackedPanels.compact)).toMatchObject({ sidePanels: 'below-compact', align: 'top' });
    expect(desk(w, h0 + LAYOUT.stackedPanels.compact - 1)).toMatchObject({ sidePanels: 'none', align: 'center' });
  });

  it('room beside the playfield still wins; landscape desktops are unchanged', () => {
    expect(desk(1920, 1080)).toMatchObject({ sidePanels: 'sides', align: 'center' });
    expect(desk(1366, 768)).toMatchObject({ sidePanels: 'sides', align: 'center' });
    expect(desk(700, 900).sidePanels).toBe('none');
  });

  it('phone-width mouse windows get no stacked panels (II / i corner buttons instead, TD-75)', () => {
    for (const [w, h] of [[390, 844], [320, 568], [479, 1000]] as const) {
      expect(desk(w, h)).toMatchObject({ mode: 'desktop', sidePanels: 'none', align: 'center' });
    }
    // from minWidth up, a tall window still stacks them
    expect(desk(LAYOUT.stackedPanels.minWidth, 1400).sidePanels).not.toBe('none');
  });

  it('touch layouts never get desktop panels, in either orientation', () => {
    for (const [w, h] of [[1080, 1920], [390, 844], [844, 390], [820, 1180], [1180, 820]] as const) {
      expect(chooseLayout({ width: w, height: h, touch: true }).sidePanels).toBe('none');
    }
  });

  it('top alignment puts the playfield at the top edge', () => {
    const v = fitViewport(1080, 1920, { align: 'top' });
    expect(v.offsetY).toBe(0);
    expect(fitViewport(1080, 1920).offsetY).toBeGreaterThan(0);
  });
});

describe('Stage 9: responsive sizing on the requested test viewports', () => {
  // [width, height, touch]: test viewports, not target sizes
  const VIEWPORTS: [number, number, boolean][] = [
    [320, 568, true], [360, 800, true], [390, 844, true], [430, 932, true], [568, 320, true], [667, 375, true],
    [768, 1024, true], [1024, 768, true], [1280, 720, false], [1366, 768, false], [1440, 900, false], [1920, 1080, false],
  ];
  const ASPECT = PLAYFIELD_ART.width / PLAYFIELD_ART.height;
  /** TD-72: the canvas is full-bleed; the playfield is fitted inside the layout's play area (no insets here). */
  const safeOf = (w: number, h: number) => ({ left: 0, top: 0, width: w, height: h });

  for (const [w, h, touch] of VIEWPORTS) {
    it(`${w}x${h} ${touch ? 'touch' : 'desktop'}: playfield fits, keeps its aspect, controls have room, page area covers the stage`, () => {
      const l = chooseLayout({ width: w, height: h, touch });
      expect(l.mode).toBe(touch ? (w > h ? 'touch-landscape' : 'touch-portrait') : 'desktop');
      const stage = playArea(l, safeOf(w, h));
      for (const dpr of [1, 2, 3]) {
        const backing = backingSize(w, h, dpr, OPTS);
        const box = cssBoxToDevice(stage, backing);
        const v = fitViewport(backing.width, backing.height, { align: l.align, area: box });
        const ratio = backing.ratio;
        const fw = (v.artWidth * v.scale) / ratio;
        const fh = (v.artHeight * v.scale) / ratio;
        // one scale for both axes: never stretched
        expect(fw / fh).toBeCloseTo(ASPECT, 9);
        // never cropped: inside the play area (and so inside the window, clear of the controls)
        expect(v.offsetX / ratio).toBeGreaterThanOrEqual(stage.left - 1e-6);
        expect(v.offsetY / ratio).toBeGreaterThanOrEqual(stage.top - 1e-6);
        expect(v.offsetX / ratio + fw).toBeLessThanOrEqual(stage.left + stage.width + 1 / ratio + 1e-6);
        expect(v.offsetY / ratio + fh).toBeLessThanOrEqual(stage.top + stage.height + 1 / ratio + 1e-6);
        // largest fit: touches the play area on at least one axis
        expect(Math.min(stage.width - fw, stage.height - fh)).toBeLessThan(1 / ratio + 1e-6);
      }
      if (touch) {
        // controls get real space beside or under the playfield
        if (l.mode === 'touch-landscape') expect(l.sideColumn).toBeGreaterThanOrEqual(48);
        else expect(l.padHeight).toBeGreaterThanOrEqual(48);
        const area = pageArea(l, safeOf(w, h))!;
        // the page area contains the play area and stays inside the safe box
        expect(area.left).toBeLessThanOrEqual(stage.left);
        expect(area.top).toBeLessThanOrEqual(stage.top);
        expect(area.left + area.width).toBeGreaterThanOrEqual(stage.left + stage.width - 1e-6);
        expect(area.top + area.height).toBeGreaterThanOrEqual(stage.top + stage.height - 1e-6);
        expect(area.left).toBeGreaterThanOrEqual(0);
        expect(area.left + area.width).toBeLessThanOrEqual(w + 1e-6);
        expect(area.top + area.height).toBeLessThanOrEqual(h + 1e-6);
      } else {
        expect(pageArea(l, safeOf(w, h))).toBeNull();
      }
    });
  }

  it('menuBox: page screens use the page area, overlays follow the playfield band', () => {
    const r = { left: 160, top: 0, width: 249, height: 320 };
    const area = { left: 0, top: 0, width: 568, height: 320 };
    const band = { left: 159, width: 250 }; // the column between the touch controls (full-bleed stage, TD-72)
    for (const s of ['howTo', 'settings'] as const) expect(menuBox(s, r, band, area)).toBe(area);
    for (const s of ['title', 'pause', 'gameOver', 'none'] as const) expect(menuBox(s, r, band, area)).toEqual({ left: 159, top: 0, width: 250, height: 320 });
    // desktop: no page area, every screen keeps the playfield band
    expect(menuBox('settings', r, band, null)).toEqual({ left: 159, top: 0, width: 250, height: 320 });
  });

  it('layout and fit are pure: resizing back gives the identical result (no drift)', () => {
    const a = chooseLayout({ width: 390, height: 844, touch: true });
    chooseLayout({ width: 844, height: 390, touch: true });
    expect(chooseLayout({ width: 390, height: 844, touch: true })).toEqual(a);
    expect(fitViewport(1170, 2112)).toEqual(fitViewport(1170, 2112));
  });
});
