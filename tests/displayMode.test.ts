import { describe, expect, it } from 'vitest';
import { ARCADE } from '../src/config/devices.ts';
import { PLAYFIELD_ART } from '../src/config/visual.ts';
import { DEFAULT_SAVE, SAVE_KEY, SaveManager, parseSave } from '../src/persistence/saveData.ts';
import { MemoryStore, type KeyValueStore } from '../src/persistence/storage.ts';
import { blendViewport, fitViewport } from '../src/render/viewport.ts';
import { PreferencesStore } from '../src/shared/persistence/preferences.ts';
import { arenaScale, bezelBox, easeOut, presentation } from '../src/ui/displayMode.ts';
import { chooseLayout, playArea, type StageBox } from '../src/ui/layout.ts';

/** The 12 viewports of the sizing matrix (TD-72): CSS size + touch. */
const VIEWPORTS: readonly [number, number, boolean][] = [
  [320, 568, true],
  [360, 800, true],
  [390, 844, true],
  [430, 932, true],
  [568, 320, true],
  [667, 375, true],
  [768, 1024, true],
  [1024, 768, true],
  [1280, 720, false],
  [1366, 768, false],
  [1440, 900, false],
  [1920, 1080, false],
];

function scene(w: number, h: number, touch: boolean): { layout: ReturnType<typeof chooseLayout>; area: StageBox } {
  const layout = chooseLayout({ width: w, height: h, touch });
  return { layout, area: playArea(layout, { left: 0, top: 0, width: w, height: h }) };
}

/** Arena rect (CSS px) a presentation produces, via the real fitViewport (DPR 1). */
function arenaRect(w: number, h: number, fit: StageBox, align: 'center' | 'bottom' | 'top'): StageBox {
  const v = fitViewport(w, h, { align, area: fit });
  return { left: v.offsetX, top: v.offsetY, width: v.artWidth * v.scale, height: v.artHeight * v.scale };
}

describe('Classic display presentation (TD-73)', () => {
  it('Responsive Display is exactly the shared viewport sizing (play area, layout alignment, no bezel)', () => {
    for (const [w, h, touch] of VIEWPORTS) {
      const { layout, area } = scene(w, h, touch);
      const p = presentation(layout, area, false);
      expect(p).toEqual({ mode: 'responsive', fit: area, align: layout.align, bezel: 0, margin: 0 });
    }
  });

  it.each(VIEWPORTS)('Arcade Display at %ix%i (touch %s): centred, framed, inside the play area, >= 90%% of the responsive size', (w, h, touch) => {
    const { layout, area } = scene(w, h, touch);
    const p = presentation(layout, area, true);
    expect(p.mode).toBe('arcade');
    expect(p.bezel).toBeGreaterThanOrEqual(1);
    expect(p.bezel).toBeLessThanOrEqual(ARCADE.bezel.max);
    expect(p.margin).toBeLessThanOrEqual(ARCADE.margin.max);
    // the layout really changes: the arena box is inset from the play area
    expect(p.fit.width).toBeLessThan(area.width);
    expect(p.fit.height).toBeLessThan(area.height);

    const responsive = arenaRect(w, h, area, layout.align);
    const arcade = arenaRect(w, h, p.fit, p.align);
    // never too small: the frame gives way before the arena drops under 90 %
    expect(arcade.width / responsive.width).toBeGreaterThanOrEqual(ARCADE.minScale - 1e-9);
    // aspect preserved (no stretch)
    expect(arcade.width / arcade.height).toBeCloseTo(PLAYFIELD_ART.width / PLAYFIELD_ART.height, 6);
    // the bezel ring stays inside the play area (never under the touch pad / safe insets)
    const outer = bezelBox(arcade, p.bezel);
    expect(outer.left).toBeGreaterThanOrEqual(area.left - 1e-6);
    expect(outer.top).toBeGreaterThanOrEqual(area.top - 1e-6);
    expect(outer.left + outer.width).toBeLessThanOrEqual(area.left + area.width + 1e-6);
    expect(outer.top + outer.height).toBeLessThanOrEqual(area.top + area.height + 1e-6);
    // centred horizontally; vertically too unless desktop panels sit below
    expect(Math.abs(arcade.left + arcade.width / 2 - (area.left + area.width / 2))).toBeLessThanOrEqual(1);
    if (p.align === 'center') expect(Math.abs(arcade.top + arcade.height / 2 - (area.top + area.height / 2))).toBeLessThanOrEqual(1);
  });

  it('portrait phones: Responsive keeps the arena near the thumbs (bottom), Arcade centres it', () => {
    const { layout, area } = scene(390, 844, true);
    expect(presentation(layout, area, false).align).toBe('bottom');
    expect(presentation(layout, area, true).align).toBe('center');
  });

  it('keeps the top alignment when the desktop panels sit under the playfield', () => {
    const below = { mode: 'desktop', sideColumn: 0, padHeight: 0, sidePanels: 'below', align: 'top' } as const;
    expect(presentation(below, { left: 0, top: 0, width: 800, height: 1200 }, true).align).toBe('top');
    expect(presentation({ ...below, sidePanels: 'below-compact' }, { left: 0, top: 0, width: 800, height: 1200 }, true).align).toBe('top');
  });

  it('a tight box shrinks the frame first (margin, then bezel) and never goes negative', () => {
    const layout = chooseLayout({ width: 448, height: 576, touch: false });
    const exact = { left: 0, top: 0, width: 448, height: 576 }; // the arena fills it exactly in Responsive
    const p = presentation(layout, exact, true);
    expect(arenaScale(p.fit)).toBeGreaterThanOrEqual(arenaScale(exact) * ARCADE.minScale - 1e-9);
    expect(p.margin).toBeGreaterThanOrEqual(0);
    expect(p.bezel).toBeGreaterThanOrEqual(0);
    const empty = presentation(layout, { left: 0, top: 0, width: 0, height: 0 }, true);
    expect(empty.fit.width).toBe(0);
    expect(empty.fit.height).toBe(0);
    expect(empty.bezel).toBe(0);
  });

  it('large desktop frames are clamped (restrained) and show the GALAXIA mark only on a generous bezel', () => {
    const { layout, area } = scene(3840, 2160, false);
    const p = presentation(layout, area, true);
    expect(p.bezel).toBe(ARCADE.bezel.max);
    expect(p.margin).toBe(ARCADE.margin.max);
    expect(p.bezel).toBeGreaterThanOrEqual(ARCADE.markMinBezel);
    const phone = scene(360, 800, true);
    expect(presentation(phone.layout, phone.area, true).bezel).toBeLessThan(ARCADE.markMinBezel);
  });

  it('bezelBox wraps the arena rect by the bezel thickness', () => {
    expect(bezelBox({ left: 100, top: 50, width: 448, height: 576 }, 10)).toEqual({ left: 90, top: 40, width: 468, height: 596 });
  });

  it('easeOut runs 0 -> 1 monotonically and clamps', () => {
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(2)).toBe(1);
    let prev = 0;
    for (let k = 0.05; k <= 1; k += 0.05) {
      const e = easeOut(k);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });
});

describe('presentation glide (blendViewport)', () => {
  const a = fitViewport(1366, 768, { area: { left: 0, top: 0, width: 1366, height: 768 } });
  const b = fitViewport(1366, 768, { area: { left: 28, top: 28, width: 1310, height: 712 } });

  it('interpolates scale and offsets between two viewports of the same canvas', () => {
    expect(blendViewport(a, b, 0)).toMatchObject({ scale: a.scale, offsetX: a.offsetX, offsetY: a.offsetY });
    expect(blendViewport(a, b, 1)).toBe(b);
    const mid = blendViewport(a, b, 0.5);
    expect(mid.scale).toBeCloseTo((a.scale + b.scale) / 2, 9);
    expect(Number.isInteger(mid.offsetX) && Number.isInteger(mid.offsetY)).toBe(true); // crisp: whole device pixels
    expect(mid.artWidth).toBe(PLAYFIELD_ART.width);
  });

  it('snaps to the target when the canvas size changed (a resize mid-glide)', () => {
    const other = fitViewport(1280, 720, { area: { left: 0, top: 0, width: 1280, height: 720 } });
    expect(blendViewport(other, b, 0.3)).toBe(b);
  });
});

/** A store that records writes and can refuse them (storage full / blocked). */
class TestStore implements KeyValueStore {
  readonly persistent = true;
  readonly data = new Map<string, string>();
  writes = 0;
  failWrites = false;
  read(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  write(key: string, value: string): boolean {
    if (this.failWrites) return false;
    this.writes += 1;
    this.data.set(key, value);
    return true;
  }
  remove(key: string): boolean {
    this.data.delete(key);
    return true;
  }
}

describe('Arcade Display preference (galaxia:prefs display.arcadeDisplay)', () => {
  it('defaults to Responsive Display (false) for new players', () => {
    expect(DEFAULT_SAVE.display.arcadeDisplay).toBe(false);
    expect(new PreferencesStore(new MemoryStore()).get().display.arcadeDisplay).toBe(false);
  });

  it('persists across a reload without touching audio, the other display prefs or the Classic save', () => {
    const store = new TestStore();
    const classic = new SaveManager(store);
    classic.recordGameResult({ score: 41230, stage: 6 });
    const classicBytes = store.data.get(SAVE_KEY);
    const prefs = new PreferencesStore(store);
    prefs.setAudio({ master: 0.35, muted: true });
    prefs.setDisplay({ glow: false, reducedMotion: 'on' });
    prefs.setDisplay({ arcadeDisplay: true });
    const reloaded = new PreferencesStore(store);
    expect(reloaded.get().display).toEqual({ glow: false, pixelPerfect: false, reducedMotion: 'on', arcadeDisplay: true });
    expect(reloaded.get().audio).toMatchObject({ master: 0.35, muted: true });
    expect(store.data.get(SAVE_KEY)).toBe(classicBytes); // Classic progress untouched
    reloaded.setDisplay({ arcadeDisplay: false });
    expect(new PreferencesStore(store).get().display.arcadeDisplay).toBe(false);
  });

  it('a record written before the setting existed loads as Responsive, silently (no repair rewrite)', () => {
    const store = new TestStore();
    new PreferencesStore(store).setDisplay({ glow: false });
    const doc = JSON.parse(store.data.get('galaxia:prefs')!) as { display: Record<string, unknown> };
    delete doc.display['arcadeDisplay'];
    store.data.set('galaxia:prefs', JSON.stringify(doc));
    store.writes = 0;
    const prefs = new PreferencesStore(store);
    expect(prefs.get().display).toEqual({ glow: false, pixelPerfect: false, reducedMotion: 'system', arcadeDisplay: false });
    expect(store.writes).toBe(0);
  });

  it('a wrong-typed value is repaired to Responsive; the other prefs survive', () => {
    const store = new TestStore();
    new PreferencesStore(store).setDisplay({ glow: false, pixelPerfect: true });
    const doc = JSON.parse(store.data.get('galaxia:prefs')!) as { display: Record<string, unknown> };
    doc.display['arcadeDisplay'] = 'yes please';
    store.data.set('galaxia:prefs', JSON.stringify(doc));
    const prefs = new PreferencesStore(store);
    expect(prefs.get().display).toEqual({ glow: false, pixelPerfect: true, reducedMotion: 'system', arcadeDisplay: false });
  });

  it('a corrupt prefs record falls back to defaults (Responsive) and Classic still parses it in its own save', () => {
    const store = new TestStore();
    store.data.set('galaxia:prefs', '{not json');
    expect(new PreferencesStore(store).get().display.arcadeDisplay).toBe(false);
    const legacy = parseSave(JSON.stringify({ version: 1, highScore: 10, bestStage: 2, audio: {}, display: { glow: true } }));
    expect(legacy.status).toBe('ok');
    expect(legacy.data.display.arcadeDisplay).toBe(false);
  });

  it('unavailable storage: the choice still applies for the session (writes fail quietly)', () => {
    const store = new TestStore();
    store.failWrites = true;
    const prefs = new PreferencesStore(store);
    expect(prefs.setDisplay({ arcadeDisplay: true })).toBe(false);
    expect(prefs.get().display.arcadeDisplay).toBe(true);
  });

  it('the standalone Classic record (no mode host) stores the setting in its display block', () => {
    const store = new TestStore();
    const save = new SaveManager(store);
    save.setDisplay({ arcadeDisplay: true });
    expect(new SaveManager(store).get().display.arcadeDisplay).toBe(true);
  });
});
